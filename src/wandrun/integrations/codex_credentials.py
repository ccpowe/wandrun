"""Isolated Codex file credentials with one gateway refresh owner.

The default constructor is a read-only view of the CLI login. Only ``gateway``
may refresh, and its directory must not alias the user's daily Codex home.
"""

from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import shlex
import secrets
import stat
import threading
import time
import warnings

import httpx

# Codex rust-v0.162.1, 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d:
# codex-rs/login/src/auth/manager.rs (refresh, classification, expiry),
# codex-rs/login/src/oauth/client.rs (JSON grant; no resource/client secret).
# https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/login/src/auth/manager.rs#L1599-L1730
_REFRESH_URL = "https://auth.openai.com/oauth/token"
_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
_WINDOW_SECONDS = 300
_FALLBACK_SECONDS = 8 * 86400
_PERMANENT = {"refresh_token_expired": "expired", "refresh_token_reused": "reused", "refresh_token_invalidated": "revoked"}
_ROTATION_MARKER = ".wandrun-credentials.rotation"


class CredentialError(RuntimeError):
    """Safe, non-secret credential failure suitable for a user-facing error."""


class _ClaimObject(list):
    """Retain object pairs: serde rejects duplicate known fields, not unknown ones."""


def _claim_fields(value, names: tuple[str, ...]) -> dict:
    if isinstance(value, _ClaimObject):
        fields = {}
        for key, item in value:
            if key in names:
                if key in fields:
                    raise ValueError
                fields[key] = item
        return fields
    # serde's derived struct visitor also accepts positional sequences.
    if isinstance(value, list) and len(value) <= len(names):
        return dict(zip(names, value))
    raise ValueError


def _optional_string(value) -> None:
    if value is not None:
        if not isinstance(value, str):
            raise ValueError
        value.encode("utf-8")  # Reject unpaired JSON surrogate escapes.


def _validate_tokens(tokens: dict) -> None:
    """Validate supported Codex 0.162.1 TokenData/IdClaims, not JWT signatures.

    Known fields follow serde's duplicate, Option and positional-struct rules.
    PlanType is an untagged KnownPlan unit enum OR an arbitrary string.
    """
    # Non-server ID payloads may parse differently from Codex; this gateway-only
    # directory uses access_token/account_id, and relogin is the recovery path.
    try:
        if any(not isinstance(tokens.get(key), str) for key in ("id_token", "access_token", "refresh_token")):
            raise ValueError
        tokens["refresh_token"].encode("utf-8")
        _optional_string(tokens.get("account_id"))
        parts = tokens["id_token"].split(".")
        if len(parts) < 3 or not all(parts[:3]):
            raise ValueError
        payload = parts[1]
        decoded = base64.b64decode(payload + "=" * (-len(payload) % 4), altchars=b"-_", validate=True)
        if base64.urlsafe_b64encode(decoded).decode().rstrip("=") != payload:
            raise ValueError
        claims = _claim_fields(
            json.loads(decoded.decode("utf-8"), parse_constant=int, object_pairs_hook=_ClaimObject),
            ("email", "https://api.openai.com/profile", "https://api.openai.com/auth"),
        )
        _optional_string(claims.get("email"))
        profile = claims.get("https://api.openai.com/profile")
        if profile is not None:
            _optional_string(_claim_fields(profile, ("email",)).get("email"))
        account = claims.get("https://api.openai.com/auth")
        if account is not None:
            account = _claim_fields(account, (
                "chatgpt_plan_type", "chatgpt_user_id", "user_id",
                "chatgpt_account_id", "chatgpt_account_is_fedramp",
            ))
            for key in ("chatgpt_user_id", "user_id", "chatgpt_account_id"):
                _optional_string(account.get(key))
            if not isinstance(account.get("chatgpt_account_is_fedramp", False), bool):
                raise ValueError
            plan = account.get("chatgpt_plan_type")
            if isinstance(plan, _ClaimObject):
                known = {
                    "free", "go", "plus", "pro", "prolite", "promax", "team",
                    "self_serve_business_prolite", "self_serve_business_usage_based",
                    "business", "ent26", "enterprise_cbp_automation",
                    "enterprise_cbp_usage_based", "enterprise", "hc", "edu",
                    "education", "edu_plus", "edu_pro",
                }
                if len(plan) != 1 or plan[0][0] not in known or plan[0][1] is not None:
                    raise ValueError
            else:
                _optional_string(plan)
    except (ValueError, TypeError, UnicodeError):
        raise CredentialError("Invalid refreshed Codex token data") from None


@dataclass(frozen=True)
class CredentialSnapshot:
    headers: dict[str, str]
    tokens: dict
    identity: str
    version: str



def _owner_key(snapshot: CredentialSnapshot) -> tuple[str, str] | None:
    """Stable account/user key when JWT claims provide one; token fallback is not stable."""
    account_id = snapshot.headers["ChatGPT-Account-ID"]
    if not account_id:
        return None
    try:
        claims = json.loads(base64.urlsafe_b64decode(snapshot.tokens["access_token"].split(".")[1] + "==="))
        account = claims.get("https://api.openai.com/auth", {})
        user = account.get("chatgpt_user_id") if isinstance(account, dict) else None
        user = user if isinstance(user, str) and user.strip() else claims.get("sub")
        if isinstance(user, str) and user.strip():
            return account_id, user
    except (ValueError, TypeError, IndexError, AttributeError):
        pass
    return None

def _require_same_owner(old: CredentialSnapshot, current: CredentialSnapshot) -> None:
    old_account, current_account = old.headers["ChatGPT-Account-ID"], current.headers["ChatGPT-Account-ID"]
    if old_account and current_account and old_account != current_account:
        raise CredentialError("Codex account changed during request")
    old_user, current_user = _owner_key(old), _owner_key(current)
    if old_user and current_user and old_user != current_user:
        raise CredentialError("Codex account changed during request")


class CodexCredentials:
    """Read a Codex file login; a gateway instance exclusively owns refresh.

    ``get`` checks expiry on demand, ``recover`` retries a rejected snapshot,
    and ``peek`` reads without refreshing. Close the gateway owner at shutdown;
    close waits for any running refresh before releasing its process lock.
    """

    def __init__(self, home: Path | None = None):
        self.home = Path(home if home is not None else os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser().absolute()
        self._owner = False
        self._lock_file = None
        self._directory: int | None = None
        self._transport = None
        self._flight = threading.Lock()
        self._state_lock = threading.Lock()
        self._closed = False
        self._generation = 0
        self._flight_error: CredentialError | None = None
        self._flight_error_version: str | None = None
        self._version: str | None = None
        self._permanent_version: str | None = None
        self._reason: str | None = None
        self._state = "login_required"
        self._checked_at = time.time()
        self._pending: tuple[str, dict] | None = None
        self._marker_corrupt = False

    @classmethod
    def gateway(cls, home: Path | None = None, *, allow_shared: bool = False,
                _transport: httpx.BaseTransport | None = None) -> CodexCredentials:
        """Acquire the exclusive gateway directory or fail without reading daily auth.

        ``_transport`` is only for synthetic in-process protocol tests; the
        production endpoint and client ID cannot be changed by environment.
        """
        target = Path(home if home is not None else os.environ.get("WANDRUN_CODEX_HOME", Path.home() / ".local/share/wandrun/codex-home")).expanduser().absolute()
        daily = (Path.home() / ".codex").resolve()
        resolved = target.resolve()
        shared = resolved == daily or resolved.is_relative_to(daily) or daily.is_relative_to(resolved)
        command = f"CODEX_HOME={shlex.quote(str(target))} codex -c 'cli_auth_credentials_store=\"file\"' login --device-auth"
        if shared and not allow_shared:
            dedicated = Path.home() / ".local/share/wandrun/codex-home"
            login = f"CODEX_HOME={shlex.quote(str(dedicated))} codex -c 'cli_auth_credentials_store=\"file\"' login --device-auth"
            raise CredentialError(
                f"Gateway CODEX_HOME aliases a shared or unsafe credential path: {target}; "
                f"stop the gateway, create an independent directory and use {login}"
            )
        if not target.is_dir():
            raise CredentialError(f"Gateway CODEX_HOME must exist before startup; stop the gateway and use {command}")
        if allow_shared:
            warnings.warn("Shared Codex credentials are read-only; gateway refresh disabled", RuntimeWarning, stacklevel=2)
            return cls(target)
        instance = cls(resolved)
        try:
            instance._directory = os.open(target, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            directory = os.fstat(instance._directory)
            if directory.st_uid != os.getuid():
                raise CredentialError("Gateway credential directory must belong to the current user")
            try:
                daily_stat = daily.stat()
            except FileNotFoundError:
                daily_stat = None
            if daily_stat and (directory.st_dev, directory.st_ino) == (daily_stat.st_dev, daily_stat.st_ino):
                raise CredentialError("Gateway CODEX_HOME aliases the daily credential directory")
            os.fchmod(instance._directory, 0o700)
            # The lock inode is never unlinked: replacing it would permit two owners.
            lock = instance._open_file(".wandrun-credentials.lock", os.O_CREAT | os.O_RDWR, normalize=True)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BaseException:
                os.close(lock)
                raise
            instance._lock_file = lock
            instance._owner = True
            instance._transport = _transport
            try:
                auth_fd = instance._open_file("auth.json", os.O_RDONLY, normalize=True)
            except FileNotFoundError:
                pass
            else:
                os.close(auth_fd)
            instance._read()  # Re-read only after taking the lifetime lock.
        except CredentialError as error:
            if str(error) != "Codex file login required":
                instance.close()
                raise
        except OSError:
            instance.close()
            raise CredentialError("Gateway credential directory unavailable or already owned") from None
        except BaseException:
            instance.close()
            raise
        return instance

    @staticmethod
    def _validate_file(fd: int, *, normalize: bool = False) -> None:
        """Validate the opened inode before changing permissions or contents."""
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise CredentialError("Unsafe gateway credential file")
        if normalize:
            os.fchmod(fd, 0o600)
        elif stat.S_IMODE(info.st_mode) != 0o600:
            raise CredentialError("Unsafe gateway credential file permissions")

    def _open_file(self, name: str, flags: int, *, normalize: bool = False) -> int:
        assert self._directory is not None
        fd = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=self._directory)
        try:
            self._validate_file(fd, normalize=normalize)
        except BaseException:
            os.close(fd)
            raise
        return fd

    def _validate_owner(self) -> None:
        """Refuse writes/refresh after the lifetime lock is removed or replaced."""
        assert self._directory is not None and self._lock_file is not None
        try:
            self._validate_file(self._lock_file)
            held = os.fstat(self._lock_file)
            named = os.stat(".wandrun-credentials.lock", dir_fd=self._directory, follow_symlinks=False)
            if (held.st_dev, held.st_ino) != (named.st_dev, named.st_ino):
                raise CredentialError("Gateway credential ownership lost")
        except (OSError, CredentialError):
            self._set_state("temporarily_unavailable", "credential_ownership_lost")
            raise CredentialError("Gateway credential ownership lost") from None

    def _set_state(self, status: str, reason: str | None = None, *, version: str | None = None) -> None:
        with self._state_lock:
            if version is not None:
                if self._version != version or self._permanent_version == version or self._state == "relogin_required":
                    return
                if status == "ready" and (self._pending or self._state == "refreshing"):
                    return
                if status == "reauth_required":
                    self._permanent_version = version
            self._state, self._reason, self._checked_at = status, reason, time.time()

    def _read(self) -> tuple[CredentialSnapshot, dict]:
        path = self.home / "auth.json"
        try:
            if self._owner:
                with os.fdopen(self._open_file("auth.json", os.O_RDONLY), "rb") as file:
                    raw = file.read()
            else:
                raw = path.read_bytes()
        except FileNotFoundError:
            self._set_state("login_required")
            raise CredentialError("Codex file login required") from None
        except OSError:
            self._set_state("temporarily_unavailable", "credential_file_unavailable")
            raise CredentialError("Codex credential file unavailable") from None
        except CredentialError:
            self._set_state("temporarily_unavailable", "unsafe_credential_file")
            raise
        try:
            auth = json.loads(raw)
            tokens = auth["tokens"]
            token = tokens["access_token"]
            if auth.get("auth_mode") != "chatgpt" or not isinstance(token, str) or not token:
                raise ValueError
            refresh_token = tokens.get("refresh_token")
            if isinstance(refresh_token, str):
                refresh_token.encode("utf-8")
            try:
                claims = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "==="))
                if not isinstance(claims, dict):
                    claims = {}
            except (ValueError, TypeError, IndexError, UnicodeDecodeError):
                claims = {}
            account = claims.get("https://api.openai.com/auth", {})
            if not isinstance(account, dict):
                account = {}
            account_id = tokens.get("account_id") or account.get("chatgpt_account_id", "")
            if not isinstance(account_id, str):
                raise ValueError
            residency = account.get("chatgpt_data_residency") or account.get("chatgpt_compute_residency")
            headers = {"Authorization": "Bearer " + token, "ChatGPT-Account-ID": account_id,
                       "Content-Type": "application/json", "Accept": "text/event-stream",
                       "User-Agent": "Wandrun/0.1.0", "originator": "wandrun"}
            if isinstance(residency, str) and residency:
                headers["x-openai-internal-codex-residency"] = residency
            user_claim = "chatgpt_user_id"
            user_id = account.get(user_claim)
            if not isinstance(user_id, str) or not user_id.strip():
                user_claim, user_id = "sub", claims.get("sub")
            owner = [user_claim, user_id] if account_id and isinstance(user_id, str) and user_id.strip() else ["token", token]
            identity = hashlib.sha256(json.dumps(["subscription-cache-v2", account_id, owner], separators=(",", ":")).encode()).hexdigest()
            version = hashlib.sha256(raw).hexdigest()
        except (ValueError, TypeError, KeyError, IndexError, UnicodeDecodeError):
            self._set_state("temporarily_unavailable", "invalid_credential_file")
            raise CredentialError("Invalid Codex file login") from None
        with self._state_lock:
            if self._version != version:
                self._version = version
                self._permanent_version = None
                self._state, self._reason, self._checked_at = "ready", None, time.time()
        if self._owner and not self._pending and self._state != "refreshing" and self._permanent_version != version:
            if self._uncertain(tokens.get("refresh_token")):
                self._set_state("relogin_required", "refresh_persistence_uncertain")
        return CredentialSnapshot(headers, tokens.copy(), identity, version), auth

    def peek(self) -> CredentialSnapshot:
        """Read the current file (even if refresh has been permanently blocked)."""
        return self._read()[0]

    @staticmethod
    def _due(snapshot: CredentialSnapshot, auth: dict) -> bool:
        try:
            claims = json.loads(base64.urlsafe_b64decode(snapshot.tokens["access_token"].split(".")[1] + "==="))
            exp = claims.get("exp")
            if isinstance(exp, (int, float)) and not isinstance(exp, bool) and math.isfinite(exp):
                return exp <= time.time() + _WINDOW_SECONDS
        except (ValueError, TypeError, KeyError, IndexError, AttributeError):
            pass
        try:
            stamp = datetime.fromisoformat(auth["last_refresh"].replace("Z", "+00:00"))
            return stamp.replace(tzinfo=stamp.tzinfo or timezone.utc).timestamp() < time.time() - _FALLBACK_SECONDS
        except (ValueError, TypeError, KeyError, AttributeError):
            return False

    def _exchange(self, refresh_token: str) -> dict:
        try:
            with httpx.Client(timeout=20, transport=self._transport) as client:
                response = client.post(_REFRESH_URL, json={"grant_type": "refresh_token", "client_id": _CLIENT_ID,
                                                           "refresh_token": refresh_token})
            if not response.is_success:
                try:
                    payload = response.json() if response.content else {}
                except ValueError:
                    payload = {}
                if not isinstance(payload, dict):
                    payload = {}
                error = payload.get("error")
                code = error if isinstance(error, str) else error.get("code") if isinstance(error, dict) else None
                code = code or payload.get("code")
                code = code.lower() if isinstance(code, str) else ""
                reason = _PERMANENT.get(code)
                if reason or response.status_code == 401 or (response.status_code == 400 and code == "invalid_grant"):
                    raise _RefreshFailure(reason or ("invalid_grant" if code == "invalid_grant" else "rejected"), True)
                raise _RefreshFailure("refresh_endpoint_unavailable", False)
            payload = response.json()
            if not isinstance(payload, dict) or any(value is not None and not isinstance(value, str)
                                                     for key, value in payload.items() if key in {"access_token", "refresh_token", "id_token"}):
                raise ValueError
            return payload
        except _RefreshFailure:
            raise
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
            # No request reached the endpoint; retrying cannot reuse a consumed token.
            raise _RefreshFailure("refresh_endpoint_unavailable", False) from None
        except (httpx.HTTPError, ValueError, TypeError):
            raise _RefreshFailure("refresh_persistence_uncertain", False, uncertain=True) from None

    def _atomic_write(self, name: str, data: bytes) -> None:
        """Publish complete bytes relative to the owned directory, then sync it."""
        assert self._directory is not None
        temp = ".auth-" + secrets.token_hex(16)
        created = False
        try:
            fd = self._open_file(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
            created = True
            try:
                remaining = memoryview(data)
                while remaining:
                    written = os.write(fd, remaining)
                    if written == 0:
                        raise OSError("Incomplete credential write")
                    remaining = remaining[written:]
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(temp, name, src_dir_fd=self._directory, dst_dir_fd=self._directory)
            created = False
            os.fsync(self._directory)
        finally:
            if created:
                os.unlink(temp, dir_fd=self._directory)

    def _mark_uncertain(self, refresh_token: str) -> None:
        self._validate_owner()
        # File formatting is not credential identity. Persist a salted fingerprint
        # before dispatch; neither the token nor partial marker bytes are published.
        salt = secrets.token_bytes(16)
        digest = hashlib.sha256(salt + refresh_token.encode()).hexdigest()
        self._atomic_write(_ROTATION_MARKER, f"{salt.hex()}:{digest}".encode())

    def _clear_uncertain(self) -> None:
        assert self._directory is not None
        try:
            os.unlink(_ROTATION_MARKER, dir_fd=self._directory)
        except FileNotFoundError:
            return
        os.fsync(self._directory)

    def _login_command(self) -> str:
        command = f"CODEX_HOME={shlex.quote(str(self.home))} codex -c 'cli_auth_credentials_store=\"file\"' login --device-auth"
        if self._marker_corrupt:
            # Only a successful new login permits removing an unidentifiable
            # barrier. The App already instructs stopping the gateway first.
            command += f" && rm -- {shlex.quote(str(self.home / _ROTATION_MARKER))}"
        return command

    def _uncertain(self, refresh_token: str | None) -> bool:
        try:
            with os.fdopen(self._open_file(_ROTATION_MARKER, os.O_RDONLY), "rb") as file:
                marker = file.read(98)
        except FileNotFoundError:
            self._marker_corrupt = False
            return False
        try:
            salt, digest = marker.decode("ascii").split(":")
            if len(salt) != 32 or len(digest) != 64 or any(c not in "0123456789abcdef" for c in salt + digest):
                raise ValueError
        except (ValueError, UnicodeError):
            if not self._marker_corrupt:
                self._marker_corrupt = True
                logging.getLogger(__name__).error(
                    "Corrupt credential rotation marker: stop the gateway, complete a new login, "
                    "then remove ONLY the rotation marker before restarting: %s", self._login_command(),
                )
            return True
        self._marker_corrupt = False
        return not isinstance(refresh_token, str) or hashlib.sha256(bytes.fromhex(salt) + refresh_token.encode()).hexdigest() == digest

    def _persist(self, version: str, auth: dict, replacement: dict) -> CredentialSnapshot:
        # Hold the owner lock and check for an external login before committing.
        self._validate_owner()
        current, _ = self._read()
        if current.version != version:
            self._pending = None
            # Observing an external login does not prove its durability. Keep
            # consumed-token barrier in case that login is lost on a crash.
            return current
        merged = dict(auth)
        merged["tokens"] = {**auth["tokens"], **{key: value for key, value in replacement.items()
                                                   if key in {"id_token", "access_token", "refresh_token"} and value is not None}}
        try:
            _validate_tokens(merged["tokens"])
        except CredentialError:
            self._pending = None
            self._set_state("relogin_required", "refresh_persistence_uncertain")
            raise
        merged["last_refresh"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        data = (json.dumps(merged, ensure_ascii=False, indent=2) + "\n").encode()
        try:
            self._atomic_write("auth.json", data)
            self._pending = None
            self._clear_uncertain()
            result = self._read()[0]
            self._set_state("ready")
            return result
        except OSError:
            self._set_state("temporarily_unavailable", "credential_write_failed")
            raise CredentialError("Codex credential write failed") from None

    def _operate(self, rejected: CredentialSnapshot | None = None) -> CredentialSnapshot:
        with self._state_lock:
            if self._closed:
                raise CredentialError("Codex credential owner is closed")
            seen = self._generation
        with self._flight:
            with self._state_lock:
                if self._closed:
                    raise CredentialError("Codex credential owner is closed")
            snapshot, auth = self._read()
            if not self._owner:
                if rejected is not None:
                    if rejected.version == snapshot.version:
                        self.rejected(snapshot)
                        raise CredentialError("Codex login must be renewed")
                    _require_same_owner(rejected, snapshot)
                return snapshot
            if self._pending and self._pending[0] == snapshot.version:
                result = self._persist(snapshot.version, auth, self._pending[1])
                self._flight_error = None
                self._generation += 1
                if rejected is not None:
                    _require_same_owner(rejected, result)
                return result
            if seen != self._generation and self._flight_error_version == snapshot.version and self._flight_error:
                raise self._flight_error
            if rejected is not None and rejected.version != snapshot.version:
                _require_same_owner(rejected, snapshot)
                return snapshot
            if self._permanent_version == snapshot.version:
                raise CredentialError("Codex login must be renewed")
            if self._uncertain(snapshot.tokens.get("refresh_token")):
                self._set_state("relogin_required", "refresh_persistence_uncertain")
                raise CredentialError("Codex credential rotation uncertain; stop the gateway and log in again")
            if seen != self._generation and self._flight_error is None:
                # Optional token fields may leave the old exp unchanged. Waiters
                # still share the completed exchange, rather than rotate again.
                if rejected is not None:
                    _require_same_owner(rejected, snapshot)
                return snapshot
            if not (rejected is not None or self._state == "refresh_due" or self._due(snapshot, auth)):
                return snapshot
            try:
                refresh_token = snapshot.tokens.get("refresh_token")
                if not isinstance(refresh_token, str) or not refresh_token:
                    raise _RefreshFailure("missing_refresh_token", True)
                self._set_state("refreshing")
                self._mark_uncertain(refresh_token)
                replacement = self._exchange(refresh_token)
                self._pending = (snapshot.version, replacement)
                result = self._persist(snapshot.version, auth, replacement)
                if rejected is not None:
                    _require_same_owner(rejected, result)
                self._flight_error = None
                return result
            except _RefreshFailure as failure:
                if not failure.uncertain:
                    self._clear_uncertain()
                # A response for an old login cannot poison credentials which
                # status() or another caller already observed after a relogin.
                current, _ = self._read()
                if current.version != snapshot.version:
                    _require_same_owner(snapshot, current)
                    return current
                if failure.uncertain:
                    self._set_state("relogin_required", "refresh_persistence_uncertain")
                elif failure.permanent:
                    self._set_state("reauth_required", failure.reason, version=snapshot.version)
                else:
                    self._set_state("temporarily_unavailable", failure.reason, version=snapshot.version)
                error = CredentialError(
                    "Codex credential rotation uncertain; stop the gateway and log in again" if failure.uncertain
                    else "Codex login must be renewed" if failure.permanent
                    else "Codex credential refresh temporarily unavailable"
                )
                self._flight_error, self._flight_error_version = error, snapshot.version
                raise error from None
            except CredentialError as error:
                self._flight_error, self._flight_error_version = error, snapshot.version
                raise
            except OSError:
                self._set_state("temporarily_unavailable", "credential_write_failed")
                error = CredentialError("Codex credential write failed")
                self._flight_error, self._flight_error_version = error, snapshot.version
                raise error from None
            finally:
                self._generation += 1

    def get(self) -> CredentialSnapshot:
        """Get a fresh snapshot, refreshing on demand for the gateway owner."""
        return self._operate()

    async def aget(self) -> CredentialSnapshot:
        """Async access sharing the synchronous refresh flight and failure result."""
        return await asyncio.to_thread(self.get)

    def recover(self, rejected: CredentialSnapshot) -> CredentialSnapshot:
        """Reload changed credentials or refresh once after an upstream 401."""
        return self._operate(rejected)

    async def arecover(self, rejected: CredentialSnapshot) -> CredentialSnapshot:
        return await asyncio.to_thread(self.recover, rejected)

    def rejected(self, snapshot: CredentialSnapshot, *, retry_exhausted: bool = False) -> None:
        """Report upstream 401; only an exhausted replay proves current auth unusable."""
        try:
            current = self.peek()
        except CredentialError:
            return
        if current.version != snapshot.version:
            return
        if retry_exhausted or not self._owner:
            self._set_state("reauth_required", "rejected", version=snapshot.version)
        else:
            self._set_state("refresh_due", "rejected", version=snapshot.version)

    def accepted(self, snapshot: CredentialSnapshot) -> None:
        """Clear a tentative rejection only when the current version succeeds."""
        try:
            current = self.peek()
        except CredentialError:
            return
        if current.version != snapshot.version or self._permanent_version == snapshot.version or self._pending or self._state == "refreshing":
            return
        if self._owner:
            try:
                if self._uncertain(snapshot.tokens.get("refresh_token")):
                    return
            except OSError:
                return
        self._set_state("ready", version=snapshot.version)

    def temporary_failure(self, snapshot: CredentialSnapshot | None = None) -> None:
        if snapshot is not None:
            try:
                if self.peek().version != snapshot.version:
                    return
            except CredentialError:
                return
        self._set_state(
            "temporarily_unavailable", "upstream_unavailable",
            version=snapshot.version if snapshot is not None else self._version,
        )

    def status(self) -> dict:
        """Return a safe login state; quota timestamps never determine auth state."""
        try:
            snapshot, auth = self._read()
            if self._owner and self._due(snapshot, auth):
                with self._state_lock:
                    if self._state == "ready":
                        self._state, self._reason, self._checked_at = "refresh_due", None, time.time()
        except CredentialError:
            pass
        with self._state_lock:
            state, reason, checked = self._state, self._reason, self._checked_at
        command = self._login_command()
        return {"status": state, "reason": reason, "checked_at": checked,
                "codex_home": str(self.home), "login_command": command}

    def close(self) -> None:
        """Wait for an in-flight refresh before releasing process ownership."""
        with self._flight:
            with self._state_lock:
                self._closed = True
            if self._lock_file is not None:
                fcntl.flock(self._lock_file, fcntl.LOCK_UN)
                os.close(self._lock_file)
                self._lock_file = None
            if self._directory is not None:
                os.close(self._directory)
                self._directory = None

    async def aclose(self) -> None:
        await asyncio.to_thread(self.close)


class _RefreshFailure(Exception):
    def __init__(self, reason: str, permanent: bool, *, uncertain: bool = False):
        self.reason = reason
        self.permanent = permanent
        self.uncertain = uncertain
