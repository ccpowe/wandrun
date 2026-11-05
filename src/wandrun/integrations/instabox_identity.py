"""Instabox machine identity shared by configuration, picker and backend construction."""

import re

_MACHINE_ID = re.compile(r"m_[a-z0-9]{26}")


def validate_machine_id(value: object) -> str:
    """Reject identities the backend cannot bind before any persistent catalog import."""
    if not isinstance(value, str) or _MACHINE_ID.fullmatch(value) is None:
        raise ValueError("Instabox machine_id 必须是已有机器的真实 ID")
    return value
