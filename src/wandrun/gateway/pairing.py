"""Local management credential and per-device connection revocation.

The store owns persistence and pairing policy. This module owns the in-process
connection registry; registration checks current revocation state synchronously,
so a revoke cannot slip between authentication and opening a long connection.
"""

import hmac
import json
import os
import secrets
from collections.abc import Callable
from pathlib import Path

from wandrun.gateway.store import GatewayStore

CREDENTIAL_FILE = "management.json"


def write_management_credential(state_dir: Path, host: str, port: int) -> str:
    """Rotate the 256-bit management secret at startup; atomically publish a 0600 file.

    CLI consumers get a loopback endpoint even when the server listens on a
    wildcard or specific non-loopback address (the server adds a second socket).
    """
    state_dir.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    path = state_dir / CREDENTIAL_FILE
    temporary = state_dir / f".{CREDENTIAL_FILE}.{secrets.token_hex(8)}"
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump({"token": token, "host": host, "port": port}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return token


class DeviceAuth:
    """Bearer validation plus live callbacks, keyed only by persisted device id.

    A development token is deliberately not a device: it has no pairing metadata
    and no revocable long-connection registration. Tokens never enter events.
    """

    def __init__(self, store: GatewayStore, development_token: str | None = None):
        self.store = store
        self.development_token = development_token
        self._connections: dict[str, set[Callable[[], None]]] = {}

    def identify(self, authorization: str | None) -> dict | None:
        if not authorization or not authorization.startswith("Bearer "):
            return None
        token = authorization[7:]
        if not token or token != token.strip() or " " in token or len(token) > 512:
            return None
        if self.development_token is not None and hmac.compare_digest(
            token.encode("utf-8"), self.development_token.encode("utf-8")
        ):
            return {"device_id": None, "paired_at": None, "pairing_method": "development"}
        device = self.store.device_for_token(token)
        if device is None:
            return None
        return {"device_id": device["id"], "paired_at": device["paired_at"],
                "pairing_method": device["pairing_method"]}

    def register(self, device_id: str | None, on_revoke: Callable[[], None]) -> Callable[[], None] | None:
        """Register before awaiting the socket/stream; None means already revoked.

        Validation and registration occur on the same event-loop turn as revoke,
        with no await in between. Development connections are not registered.
        """
        if device_id is None:
            return lambda: None
        if not self.store.device_active(device_id):
            return None
        connections = self._connections.setdefault(device_id, set())
        connections.add(on_revoke)

        def unsubscribe() -> None:
            connections.discard(on_revoke)
            if not connections:
                self._connections.pop(device_id, None)

        return unsubscribe

    def revoke(self, device_id: str) -> bool:
        if not self.store.revoke_device(device_id):
            return False
        for disconnect in tuple(self._connections.get(device_id, ())):
            disconnect()
        return True
