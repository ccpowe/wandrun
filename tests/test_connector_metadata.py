"""Automatic display values: precedence, launcher/host fallbacks and explicit user ownership."""

import unittest

from wandrun.gateway.connector_metadata import derive_metadata
from wandrun.gateway.connectors import connector_fields


class ConnectorMetadataTests(unittest.TestCase):
    def derive(self, *, info=None, fields=None, instructions=None, tools=None, existing=None):
        definition = connector_fields("new", fields or {"url": "https://mcp.notion.com/mcp"})
        return derive_metadata(definition, {"serverInfo": info or {}, "instructions": instructions,
                                            "tools": tools or []}, existing or {})

    def test_name_precedence_and_normalization(self):
        cases = [
            ({"title": "Official\nTitle", "name": "ignored"}, "Official Title"),
            ({"name": "@modelcontextprotocol/server-github"}, "Github"),
            ({"name": "notion-mcp-server"}, "Notion"),
            ({"name": "alpha_beta.api-server"}, "Alpha Beta Api"),
            ({"name": "mcp-server"}, "mcp-server"),
            ({"title": " "}, "Notion"),
            ({"title": "x" * 100}, "x" * 64),
        ]
        for info, expected in cases:
            with self.subTest(info=info):
                self.assertEqual(self.derive(info=info)["name"], expected)

    def test_remote_and_local_fallbacks(self):
        cases = [
            ({"url": "https://www.api.mcp.notion.com/mcp"}, "Notion"),
            ({"url": "http://127.0.0.1:9999/notes"}, "Notes"),
            ({"url": "http://[::1]:9999/"}, "远程连接器"),
            ({"url": "http://localhost"}, "远程连接器"),
            ({"command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"]}, "Github"),
            ({"command": "uvx", "args": ["notion-mcp-server"]}, "Notion"),
            ({"command": "bunx", "args": ["-y", "notes-server"]}, "Notes"),
            ({"command": "pipx", "args": ["run", "notes-server"]}, "Notes"),
            ({"command": "docker", "args": ["run", "--rm", "-e", "TOKEN=x", "notes-server"]}, "Notes"),
            ({"command": "/usr/local/bin/notes"}, "notes"),
        ]
        for fields, expected in cases:
            with self.subTest(fields=fields):
                self.assertEqual(self.derive(fields=fields)["name"], expected)

    def test_unique_names_fit_limit_and_user_values_survive(self):
        existing = {"a": {"name": "Notes"}, "b": {"name": "Notes 2"}}
        self.assertEqual(self.derive(info={"title": "Notes"}, existing=existing)["name"], "Notes 3")
        value = self.derive(info={"title": "x" * 64}, existing={"a": {"name": "x" * 64}})
        self.assertEqual(value["name"], "x" * 62 + " 2")
        value = self.derive(fields={"url": "https://example.com", "name": "Mine", "description": ""},
                            info={"title": "Server", "description": "Replace me"})
        self.assertEqual((value["name"], value["description"]), ("Mine", ""))

    def test_description_precedence_sentences_tools_and_empty(self):
        tools = [{"name": "a", "title": "Search"}, {"name": "b"}, {"name": "c"}, {"name": "d"}]
        cases = [
            ({"description": "Official\nsummary"}, "Ignore.", tools, "Official summary"),
            ({}, "First sentence. Second sentence!\n\nIgnore paragraph.", tools, "First sentence. Second sentence!"),
            ({}, "开头。" + "长" * 198 + "。", tools, "开头。"),
            ({}, "x" * 210, [], "x" * 200),
            ({}, None, tools, "提供 4 个工具：Search、b、c 等"),
            ({}, None, [], ""),
        ]
        for info, instructions, catalog, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(self.derive(info=info, instructions=instructions, tools=catalog)["description"], expected)

    def test_remote_transport_inference_and_explicit_override(self):
        for fields, expected in (
            ({"url": "https://example.com/sse"}, "sse"),
            ({"url": "https://example.com/sse?workspace=notes"}, "sse"),
            ({"url": "https://example.com/mcp"}, "streamable-http"),
            ({"url": "https://example.com/sse", "transport": "streamable-http"}, "streamable-http"),
            ({"url": "https://example.com/mcp", "transport": "sse"}, "sse"),
        ):
            with self.subTest(fields=fields):
                self.assertEqual(connector_fields("remote", fields)["transport"], expected)

    def test_generic_local_url_path_uses_remote_placeholder(self):
        for url in ("http://localhost/mcp", "http://127.0.0.1/server", "http://[::1]/mcp-server"):
            with self.subTest(url=url):
                self.assertEqual(self.derive(fields={"url": url})["name"], "远程连接器")

    def test_tool_summary_only_marks_omitted_tools(self):
        for count, expected in ((1, "提供 1 个工具：A"), (3, "提供 3 个工具：A、B、C"),
                                (4, "提供 4 个工具：A、B、C 等")):
            tools = [{"name": name} for name in "ABCD"[:count]]
            self.assertEqual(self.derive(tools=tools)["description"], expected)

    def test_unchanged_patch_does_not_take_ownership_of_auto_values(self):
        original = self.derive(info={"title": "Original", "description": "Original."})
        patched = connector_fields("new", {"name": original["name"], "description": original["description"]}, original)
        refreshed = derive_metadata(patched, {"serverInfo": {"title": "Updated", "description": "Updated."}}, {})
        self.assertEqual((refreshed["name"], refreshed["description"]), ("Updated", "Updated."))

    def test_url_edit_preserves_explicit_transport_but_reinfers_automatic_transport(self):
        explicit = connector_fields("new", {"url": "https://example.com/custom", "transport": "sse"})
        changed = connector_fields("new", {"url": "https://example.com/next"}, explicit)
        self.assertEqual(changed["transport"], "sse")
        automatic = connector_fields("new", {"url": "https://example.com/mcp"})
        changed = connector_fields("new", {"url": "https://example.com/sse"}, automatic)
        self.assertEqual(changed["transport"], "sse")
        imported = {"id": "new", "name": "Configured", "description": "", "auth_type": "none",
                    "url": "https://example.com/mcp", "name_source": "user", "description_source": "user"}
        self.assertEqual(connector_fields("new", {"name": "Configured"}, imported), imported)
