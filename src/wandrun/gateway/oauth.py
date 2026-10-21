"""Gateway persistence boundary for the integration-owned MCP OAuth provider."""

from wandrun.gateway.store import GatewayStore


class GatewayOAuthRecords:
    def __init__(self, store: GatewayStore, persist):
        self.store = store
        self.persist = persist

    def connector_definitions(self):
        return self.store.connector_definitions()

    def oauth_record(self, identity: str):
        return self.store.oauth_record(identity)

    def save_oauth(self, identity: str, generation: int, record: dict | None):
        return self.persist(self.store.save_oauth, identity, generation, record)

    def invalidate_oauth(self, identity: str, **kwargs):
        return self.persist(self.store.invalidate_oauth, identity, **kwargs)

    def connector_status_changed(self, identity: str):
        return self.persist(self.store.connector_status_changed, identity)
