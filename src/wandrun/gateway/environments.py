"""Read-only Instabox picker catalog; never prepare a backend or expose provider bodies."""

import os

import httpx

from wandrun.config import EnvironmentDefinition, default_instabox_browser
from wandrun.integrations.instabox import API_URL
from wandrun.integrations.instabox_identity import validate_machine_id


class EnvironmentCatalogUnavailable(RuntimeError):
    def __init__(self):
        super().__init__("无法加载 Instabox 机器，请检查宿主凭据或稍后重试；Local 仍可使用。")


async def list_machine_choices(
    definitions: dict[str, EnvironmentDefinition], *, cursor: str | None = None,
) -> tuple[list[dict], str | None, dict[str, EnvironmentDefinition]]:
    """Fetch one bounded provider page using only the host's configured credential reference."""
    template = next((item for item in definitions.values() if item.type == "instabox"), None)
    key_env = template.api_key_env if template is not None else "INSTABOX_API_KEY"
    key = os.environ.get(key_env)
    if not key:
        raise EnvironmentCatalogUnavailable()
    try:
        async with httpx.AsyncClient(
            base_url=API_URL, headers={"X-API-Key": key}, timeout=30,
            follow_redirects=False, trust_env=False,
        ) as client:
            response = await client.get(
                "/v1/machines", params={"limit": 50, **({"cursor": cursor} if cursor else {})},
            )
            response.raise_for_status()
            body = response.json()
        machines, next_cursor = body["machines"], body.get("nextCursor")
        if not isinstance(machines, list) or len(machines) > 50 or (
            next_cursor is not None and (not isinstance(next_cursor, str) or len(next_cursor) > 4096)
        ):
            raise ValueError
        choices, discovered, seen = [], {}, set()
        for machine in machines:
            machine_id = validate_machine_id(machine["id"])
            name, state = machine["name"], machine["state"]
            if (not isinstance(name, str) or not 0 < len(name) <= 256
                    or not isinstance(state, str) or len(state) > 64):
                raise ValueError
            if machine_id in seen:
                continue
            seen.add(machine_id)
            existing = next(((identity, definition) for identity, definition in definitions.items()
                             if definition.type == "instabox" and definition.machine_id == machine_id), None)
            if existing is None:
                identity = "instabox-" + machine_id
                # The verified Instabox writable persistent home is under /data/home.
                definition = EnvironmentDefinition(
                    type="instabox", machine_id=machine_id, api_key_env=key_env, workdir="/data/home/wandrun",
                    browser=default_instabox_browser(),
                )
                if identity in definitions and definitions[identity] != definition:
                    raise ValueError
            else:
                identity, definition = existing
            discovered[identity] = definition
            choices.append({"id": identity, "machine_id": machine_id, "name": name,
                            "type": "instabox", "status": state})
        return choices, next_cursor, discovered
    except (httpx.HTTPError, ValueError, TypeError, KeyError):
        raise EnvironmentCatalogUnavailable() from None
