"""Configuration validation at the file boundary, before MCP connections."""

import json
import tempfile
import unittest
from pathlib import Path

from wandrun.config import (
    AgentCatalog, AgentDefinition, EnvironmentDefinition, load_config, load_config_for_catalog,
    validate_catalog, validate_mcp_servers,
)


MACHINE_ID = "m_" + "a" * 26


AGENTS = '''
main_agent = "lead"

[agents.lead]
description = "Coordinates"
system_prompt = "Coordinate work"
model = "model-one"
reasoning_effort = "high"
workers = ["coder", "critic"]
mcp_servers = ["docs"]
skills = ["review"]

[agents.coder]
description = "Writes code"
system_prompt = "Write code"
model = "model-two"

[agents.critic]
description = "Reviews"
system_prompt = "Review code"
model = "model-three"
mcp_servers = ["docs"]
'''
MCPS = '''
[mcp_servers.docs]
url = "https://example.com/mcp"

[mcp_servers.local]
command = "python"
args = ["-m", "sample_server"]
env = { API_TOKEN = "value" }
'''

ENVIRONMENTS = '''
default = "local"

[environments.local]
type = "local"
command_timeout = 300
'''


class ConfigTests(unittest.TestCase):
    def load(self, agents=AGENTS, mcps=MCPS, environments=ENVIRONMENTS):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "agents.toml").write_text(agents, encoding="utf-8")
            (root / "mcps.toml").write_text(mcps, encoding="utf-8")
            (root / "environments.toml").write_text(environments, encoding="utf-8")
            return load_config(root / "agents.toml")

    def test_code_mode_defaults_true_and_explicit_false_is_preserved(self):
        default = self.load()
        self.assertTrue(default.agents["lead"].code_mode)
        self.assertTrue(default.agents["coder"].code_mode)
        disabled = AGENTS.replace('model = "model-two"', 'model = "model-two"\ncode_mode = false')
        self.assertFalse(self.load(agents=disabled).agents["coder"].code_mode)
        invalid = AGENTS.replace('model = "model-two"', 'model = "model-two"\ncode_mode = "false"')
        with self.assertRaisesRegex(ValueError, "code_mode 必须是布尔值"):
            self.load(agents=invalid)

    def test_fast_mode_defaults_false_and_requires_a_boolean(self):
        self.assertFalse(self.load().agents["lead"].fast_mode)
        for value, expected in (("true", True), ("false", False)):
            configured = AGENTS.replace('model = "model-two"', f'model = "model-two"\nfast_mode = {value}')
            self.assertIs(self.load(agents=configured).agents["coder"].fast_mode, expected)
        for value in ('"false"', "0", "1", "[]", "{}"):
            configured = AGENTS.replace('model = "model-two"', f'model = "model-two"\nfast_mode = {value}')
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "fast_mode 必须是布尔值"):
                self.load(agents=configured)

    def test_browser_settings_are_per_environment_and_bounded(self):
        browser = '\n[environments.local.browser]\ncdp_url = "http://127.0.0.1:9222"\n'
        config = self.load(environments=ENVIRONMENTS + browser)
        self.assertEqual(config.environments["local"].browser.max_pages, 8)
        self.assertEqual(config.environments["local"].browser.idle_timeout, 7200)
        custom = self.load(environments=ENVIRONMENTS + browser + "max_pages = 4\nidle_timeout = 0\n")
        self.assertEqual((custom.environments["local"].browser.max_pages,
                          custom.environments["local"].browser.idle_timeout), (4, 0))
        for extra in (
            'cdp_url = "ws://127.0.0.1:9222"',
            'cdp_url = "http://user:pass@127.0.0.1:9222"',
            'cdp_url = ""', 'max_pages = 4',
            'cdp_url = "http://127.0.0.1:9222"\nslots = 2',
            'cdp_url = "http://127.0.0.1:9222"\nmax_pages = true',
            'cdp_url = "http://127.0.0.1:9222"\nidle_timeout = -1',
            'cdp_url = "http://127.0.0.1:9222"\nqueue_timeout = 30',
        ):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.load(environments=ENVIRONMENTS + '\n[environments.local.browser]\n' + extra + '\n')
        alias = '\n[environments.second]\ntype = "local"\n' + browser.replace("environments.local", "environments.second")
        config = self.load(environments=ENVIRONMENTS + browser + alias)
        self.assertEqual(config.environments["local"].browser, config.environments["second"].browser)
        for conflicting in (alias.replace("9222", "9333"), alias + "max_pages = 4\n"):
            with self.subTest(conflicting=conflicting), self.assertRaisesRegex(ValueError, "浏览器配置冲突"):
                self.load(environments=ENVIRONMENTS + browser + conflicting)

    def test_instabox_browser_defines_phase_two_transport_without_host_url(self):
        cloud = (
            '\n[environments.cloud]\ntype = "instabox"\n'
            f'machine_id = "{MACHINE_ID}"\nworkdir = "/data/home/wandrun"\n'
            '[environments.cloud.browser]\n'
        )
        browser = self.load(environments=ENVIRONMENTS + cloud).environments["cloud"].browser
        self.assertEqual((browser.cdp_url, browser.cdp_port, browser.profile_dir),
                         (None, 9222, "/data/home/wandrun-browser/profile"))
        for invalid in ('cdp_url = "http://localhost:9222"', 'cdp_port = true',
                        'cdp_port = 0', 'cdp_port = 65536', 'profile_dir = "relative"',
                        'slots = 1', 'queue_timeout = 30'):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.load(environments=ENVIRONMENTS + cloud + invalid + "\n")

    def test_instabox_requires_existing_instance_binding_and_host_key_reference(self):
        sandbox = (
            '\n[environments.cloud]\ntype = "instabox"\n'
            f'machine_id = "{MACHINE_ID}"\nworkdir = "/data/home/wandrun"\n'
        )
        for invalid in (
            sandbox.replace(f'machine_id = "{MACHINE_ID}"\n', ""),
            sandbox.replace('workdir = "/data/home/wandrun"\n', ""),
            sandbox.replace(f'"{MACHINE_ID}"', '"../other"'),
            sandbox.replace(f'"{MACHINE_ID}"', '"m_existing"'),
            sandbox.replace('"/data/home/wandrun"', '"relative"'),
            sandbox + 'api_key_env = "KEY WITH SPACE"\n',
            sandbox + 'api_key = "not-allowed"\n',
            sandbox + 'host = "example.com"\n',
            sandbox + '[environments.cloud.browser]\ncdp_url = "http://localhost:9222"\n',
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.load(environments=ENVIRONMENTS + invalid)

    def test_one_instabox_instance_cannot_have_conflicting_execution_settings(self):
        sandbox = (
            '\n[environments.cloud]\ntype = "instabox"\n'
            f'machine_id = "{MACHINE_ID}"\nworkdir = "/data/home/wandrun"\n'
        )
        alias = sandbox.replace("environments.cloud", "environments.alias")
        self.load(environments=ENVIRONMENTS + sandbox + alias)
        for conflicting in (
            alias.replace('"/data/home/wandrun"', '"/data/home/other"'),
            alias + 'api_key_env = "OTHER_ACCOUNT_KEY"\n',
            alias + "command_timeout = 60\n",
            alias + "termination_grace = 3\n",
        ):
            with self.subTest(conflicting=conflicting), self.assertRaisesRegex(ValueError, "实例配置冲突"):
                self.load(environments=ENVIRONMENTS + sandbox + conflicting)

    def test_display_name_is_single_line_and_at_most_64_characters_in_toml(self):
        def named(value):
            return AGENTS.replace(
                'description = "Writes code"',
                f'name = {json.dumps(value)}\ndescription = "Writes code"',
            )

        self.assertEqual(self.load(agents=named("名" * 64)).agents["coder"].name, "名" * 64)
        for bad in ("x" * 65, "first\nsecond", "first\rsecond", "first\u2028second"):
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, r"agents\.coder\.name"):
                self.load(agents=named(bad))

    def test_compaction_settings_validate_both_file_and_catalog_sources(self):
        configured = AGENTS.replace(
            'model = "model-two"',
            'model = "model-two"\ncontext_window = 123456\n'
            'compaction_keep_tokens = 12000\ncompaction_model = "summary-model"',
        )
        coder = self.load(agents=configured).agents["coder"]
        self.assertEqual((coder.context_window, coder.compaction_keep_tokens, coder.compaction_model),
                         (123456, 12000, "summary-model"))
        self.assertEqual(self.load().agents["lead"].compaction_keep_tokens, 20000)
        for field, invalid in (
            ("context_window", ("0", "-1", "true", '"100"')),
            ("compaction_keep_tokens", ("0", "-2", "true", '"20000"')),
            ("compaction_model", ('""', '"  "')),
        ):
            for value in invalid:
                with self.subTest(field=field, value=value), self.assertRaisesRegex(ValueError, field):
                    self.load(agents=AGENTS.replace(
                        'model = "model-two"', f'model = "model-two"\n{field} = {value}',
                    ))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "environments.toml").write_text(ENVIRONMENTS, encoding="utf-8")
            for changes, field in (
                ({"context_window": True}, "context_window"),
                ({"compaction_keep_tokens": None}, "compaction_keep_tokens"),
                ({"compaction_model": ""}, "compaction_model"),
            ):
                from dataclasses import replace
                with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, field):
                    load_config_for_catalog(
                        AgentCatalog("coder", {"coder": replace(coder, **changes)}),
                        None, root / "environments.toml", mcp_servers={},
                    )

    def test_role_skill_selection(self):
        config = self.load()
        self.assertEqual(config.agents["lead"].skills, ("review",))
        self.assertEqual(config.agents["coder"].skills, ())

    def test_invalid_role_data_and_references(self):
        cases = (
            AGENTS.replace('main_agent = "lead"', 'main_agent = "missing"'),
            AGENTS.replace('workers = ["coder", "critic"]', 'workers = ["ghost"]'),
            AGENTS.replace('mcp_servers = ["docs"]', 'mcp_servers = ["ghost"]'),
            AGENTS.replace('workers = ["coder", "critic"]', 'workers = "coder"'),
            AGENTS.replace('workers = ["coder", "critic"]', 'workers = ["coder", " coder"]'),
            AGENTS.replace('workers = ["coder", "critic"]', 'workers = ["coder", "coder"]'),
            AGENTS.replace('skills = ["review"]', 'skills = ["review", "review"]'),
            AGENTS.replace('skills = ["review"]', 'skills = "review"'),
            AGENTS.replace('skills = ["review"]', 'skills = ["../outside"]'),
            AGENTS.replace('skills = ["review"]', 'skills = ["/etc"]'),
            AGENTS.replace('skills = ["review"]', 'skills = ["a/b"]'),
            AGENTS.replace('skills = ["review"]', 'skills = [".."]'),
            AGENTS.replace('reasoning_effort = "high"', 'reasoning_effort = ""'),
            AGENTS.replace('description = "Coordinates"', 'description = "  "'),
            AGENTS.replace('model = "model-one"', 'model = ""'),
            AGENTS.replace('system_prompt = "Coordinate work"', 'system_prompt = ""'),
            AGENTS.replace('model = "model-one"', 'provider = "other"\nmodel = "model-one"'),
            AGENTS.replace('main_agent = "lead"', 'main_agent = "lead"\nprovider = "other"'),
            AGENTS.replace('[agents.coder]', '[agents.human]'),
        )
        for agents in cases:
            with self.subTest(agents=agents):
                with self.assertRaises(ValueError):
                    self.load(agents=agents)
        self.assertEqual(
            self.load(agents=AGENTS.replace('reasoning_effort = "high"', 'reasoning_effort = "future-level"'))
            .agents["lead"].reasoning_effort,
            "future-level",
        )

    def test_searchable_servers_need_description_and_stay_disjoint(self):
        agents = AGENTS.replace('skills = ["review"]', 'skills = ["review"]\nsearchable_mcp_servers = ["local"]')
        mcps = MCPS.replace('[mcp_servers.local]', '[mcp_servers.local]\ndescription = "Local samples"')
        config = self.load(agents=agents, mcps=mcps)
        self.assertEqual(config.agents["lead"].searchable_mcp_servers, ("local",))
        self.assertEqual(config.agents["coder"].searchable_mcp_servers, ())
        self.assertEqual(config.mcp_descriptions, {"local": "Local samples"})
        self.assertNotIn("description", config.mcp_servers["local"])
        cases = (
            (agents, MCPS),  # 可搜索服务缺少说明
            (agents.replace('["local"]', '["ghost"]'), mcps),
            (agents.replace('["local"]', '["docs"]'), mcps.replace('[mcp_servers.docs]', '[mcp_servers.docs]\ndescription = "Docs"')),
            (agents.replace('["local"]', '"local"'), mcps),
            (agents, mcps.replace('description = "Local samples"', 'description = " "')),
            (
                agents.replace('["local"]', '["a.b"]'),
                mcps + '\n[mcp_servers."a.b"]\nurl = "https://example.com/x"\ndescription = "x"\n',
            ),
        )
        for agents_text, mcps_text in cases:
            with self.subTest(agents=agents_text[-120:], mcps=mcps_text[-120:]):
                with self.assertRaises(ValueError):
                    self.load(agents=agents_text, mcps=mcps_text)

    def test_invalid_mcp_connection_shape_does_not_expose_secrets(self):
        cases = (
            '[mcp_servers.docs]\nurl = "ftp://example.com/mcp"',
            '[mcp_servers.docs]\nurl = "https://user:password@example.com/mcp"',
            '[mcp_servers.docs]\nurl = "https://example.com/mcp"\ncommand = "python"',
            '[mcp_servers.docs]\nurl = "https://example.com/mcp"\nheaders = "secret"',
            '[mcp_servers.docs]\ncommand = "python"\nargs = "--stdio"',
            '[mcp_servers.docs]\ncommand = "python"\nenv = { TOKEN = 42 }',
            '[mcp_servers.docs]\ncommand = "python"\ntransport = "http"',
            '[mcp_servers.docs]\nurl = "https://example.com/mcp"\ntransport = "stdio"',
            '[mcp_servers.docs]\nurl = "https://example.com/mcp"\ntransport = []',
            '[mcp_servers.docs]\nurl = "https://example.com/mcp"\nheaders = { TOKEN = "secret" }\nplugin = "secret"',
            '[mcp_servers.docs]\nurl = "https://example.com/mcp"\n[mcp_servers.unknown]\n',
        )
        for mcps in cases:
            with self.subTest(mcps=mcps):
                with self.assertRaises(ValueError) as error:
                    self.load(mcps=mcps)
                self.assertNotIn("secret", str(error.exception))
                self.assertNotIn("password", str(error.exception))

    def test_all_three_files_are_required(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "agents.toml"
            with self.assertRaises(FileNotFoundError):
                load_config(path)
            path.write_text(AGENTS, encoding="utf-8")
            with self.assertRaises(FileNotFoundError):
                load_config(path)
            (Path(directory) / "mcps.toml").write_text(MCPS, encoding="utf-8")
            with self.assertRaisesRegex(FileNotFoundError, "environments.toml"):
                load_config(path)

    def test_roles_resolve_to_default_or_named_environment(self):
        environments = ENVIRONMENTS + '\n[environments.quick]\ntype = "local"\ntermination_grace = 0.5\n'
        agents = AGENTS.replace('model = "model-two"', 'model = "model-two"\nenvironment = "quick"')
        config = self.load(agents=agents, environments=environments)
        self.assertEqual(
            {name: role.environment for name, role in config.agents.items()},
            {"lead": "local", "coder": "quick", "critic": "local"},
        )
        self.assertEqual(config.environments["local"].command_timeout, 300)
        self.assertEqual(config.environments["local"].termination_grace, 2.0)
        self.assertEqual(config.environments["quick"].command_timeout, 120)
        self.assertEqual(config.environments["quick"].termination_grace, 0.5)

    def test_ordinary_ssh_is_rejected_even_when_unreferenced(self):
        ssh = '\n[environments.retired]\ntype = "ssh"\n'
        for environments in (
            ENVIRONMENTS.replace('type = "local"', 'type = "ssh"'),
            ENVIRONMENTS + ssh,
            ENVIRONMENTS + ssh + 'host = "example.com"\nport = 2222\nuser = "ubuntu"\nworkdir = "/srv/work"\n',
        ):
            with self.subTest(environments=environments), self.assertRaises(ValueError):
                self.load(environments=environments)

    def test_local_rejects_remote_execution_fields(self):
        for field in (
            'host = "example.com"', 'port = 2222', 'user = "ubuntu"',
            'workdir = "/srv/work"', f'machine_id = "{MACHINE_ID}"',
            'api_key_env = "REMOTE_API_KEY"',
        ):
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.load(environments=ENVIRONMENTS + field + "\n")

    def test_invalid_environments(self):
        cases = (
            (AGENTS, ENVIRONMENTS.replace('default = "local"', 'default = "ghost"')),
            (AGENTS, ENVIRONMENTS.replace('type = "local"', 'type = "e2b"')),
            (AGENTS, ENVIRONMENTS.replace('type = "local"', 'type = "local"\nroot = "/tmp"')),
            (AGENTS, ENVIRONMENTS.replace("command_timeout = 300", "command_timeout = 0")),
            (AGENTS, ENVIRONMENTS.replace("command_timeout = 300", "command_timeout = 1.5")),
            (AGENTS, ENVIRONMENTS.replace("command_timeout = 300", "command_timeout = true")),
            (AGENTS, ENVIRONMENTS + "termination_grace = -1\n"),
            (AGENTS, ENVIRONMENTS + "termination_grace = inf\n"),
            (AGENTS, ENVIRONMENTS + "termination_grace = nan\n"),
            (AGENTS, 'default = "local"\n[environments]\n'),
            (AGENTS, ENVIRONMENTS.replace('default = "local"\n', "")),
            (AGENTS.replace('model = "model-two"', 'model = "model-two"\nenvironment = "ghost"'), ENVIRONMENTS),
            (AGENTS.replace('model = "model-two"', 'model = "model-two"\nenvironment = ""'), ENVIRONMENTS),
        )
        for agents, environments in cases:
            with self.subTest(agents=agents[-60:], environments=environments):
                with self.assertRaises(ValueError):
                    self.load(agents=agents, environments=environments)


class CatalogSourceTests(unittest.TestCase):
    """调用方（网关的数据库）给出的定义与 TOML 来源经过同一套身份、字段和引用校验。"""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        self.mcps = root / "mcps.toml"
        self.mcps.write_text("[mcp_servers]\n", encoding="utf-8")
        self.environments = root / "environments.toml"
        self.environments.write_text(
            'default = "local"\n[environments.local]\ntype = "local"\n', encoding="utf-8"
        )

    def load(self, agents: dict, main_agent: str = "main"):
        return load_config_for_catalog(
            AgentCatalog(main_agent, agents), self.mcps, self.environments
        )

    @staticmethod
    def agent(**kwargs) -> AgentDefinition:
        fields = dict(description="d", system_prompt="p", model="m", environment="local")
        return AgentDefinition(**{**fields, **kwargs})

    def test_valid_catalog_is_accepted(self):
        config = self.load({"main": self.agent(workers=("a-1",)), "a-1": self.agent()})
        self.assertEqual(config.catalog.agents["main"].workers, ("a-1",))

    def test_restart_restores_selected_machine_and_keeps_existing_owner_parameters_for_new_alias(self):
        machine = "m_" + "a" * 26
        selected = EnvironmentDefinition(
            type="instabox", machine_id=machine, workdir="/data/original",
            api_key_env="HOST_CHOICE_KEY", command_timeout=77,
        )
        self.environments.write_text(
            'default = "local"\n[environments.local]\ntype = "local"\n'
            '[environments.new_alias]\ntype = "instabox"\n'
            f'machine_id = "{machine}"\nworkdir = "/data/changed"\n',
            encoding="utf-8",
        )
        original = self.environments.read_bytes()
        config = load_config_for_catalog(
            AgentCatalog("main", {"main": self.agent(environment="selected")}),
            self.mcps, self.environments, environment_definitions={"selected": selected},
        )
        self.assertEqual(config.environments["selected"], selected)
        self.assertEqual(config.environments["new_alias"], selected)
        self.assertEqual(config.agents["main"].environment, "selected")
        self.assertEqual(self.environments.read_bytes(), original)

    def test_reserved_local_binding_is_checked_for_persisted_overrides_too(self):
        bad_local = EnvironmentDefinition(
            type="instabox", machine_id="m_" + "a" * 26, workdir="/data/home/wandrun",
        )
        with self.assertRaises(ValueError):
            load_config_for_catalog(
                AgentCatalog("main", {"main": self.agent()}), self.mcps, self.environments,
                environment_definitions={"local": bad_local},
            )

    def test_invalid_persisted_machine_identity_is_rejected_before_backend_assembly(self):
        with self.assertRaises(ValueError):
            load_config_for_catalog(
                AgentCatalog("main", {"main": self.agent(environment="cloud")}),
                self.mcps, self.environments, environment_definitions={
                    "cloud": EnvironmentDefinition(
                        type="instabox", machine_id="m_existing", workdir="/data/home/wandrun",
                    ),
                },
            )

    def test_field_rules_match_the_toml_source(self):
        for field, value in (
            ("skills", ("../outside",)),
            ("skills", ("a", "a")),
            ("reasoning_effort", "  "),
            ("system_prompt", "  "),
            ("description", ""),
            ("model", None),
            ("code_mode", "yes"),
            ("fast_mode", "yes"),
            ("fast_mode", 0),
            ("fast_mode", 1),
            ("fast_mode", None),
            ("mcp_servers", ["x"]),  # 必须是 tuple，列表说明解码没做完
            ("environment", " local"),
        ):
            with self.subTest(field=field, value=value):
                with self.assertRaises(ValueError):
                    self.load({"main": self.agent(**{field: value})})

    def test_agent_id_rule_applies_to_every_place_an_id_appears(self):
        bad_ids = ["a/b", "助手", "x" * 65, "", " a", "a b", "human", "a.b"]
        for bad in bad_ids:
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    self.load({bad: self.agent(), "main": self.agent()})
                with self.assertRaises(ValueError):
                    self.load({"main": self.agent(workers=(bad,))})
                with self.assertRaises(ValueError):
                    self.load({"main": self.agent()}, main_agent=bad)
        longest = "x" * 64
        self.assertIn(longest, self.load({"main": self.agent(), longest: self.agent()}).agents)

    def test_toml_source_uses_the_same_id_rule(self):
        root = self.mcps.parent
        (root / "agents.toml").write_text(
            'main_agent = "main"\n[agents.main]\ndescription = "d"\nsystem_prompt = "p"\nmodel = "m"\n'
            '[agents."a/b"]\ndescription = "d"\nsystem_prompt = "p"\nmodel = "m"\n',
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValueError, "a/b"):
            load_config(root / "agents.toml")

    def test_catalog_allows_empty_without_default_and_validates_display_name(self):
        initial = self.load({"main": self.agent()})
        empty = validate_catalog(AgentCatalog(None, {}), initial)
        self.assertEqual(empty.agents, {})
        self.assertIsNone(empty.main_agent)
        self.assertEqual(empty.default_environment, "local")
        named = validate_catalog(
            AgentCatalog(None, {"new": self.agent(name="中文 名称", environment=None)}),
            initial,
        )
        self.assertEqual(named.agents["new"].name, "中文 名称")
        self.assertEqual(named.agents["new"].environment, "local")
        for bad in ("", " bad", "bad "):
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, "name"):
                validate_catalog(AgentCatalog(None, {"new": self.agent(name=bad)}), initial)
        self.assertEqual(
            validate_catalog(AgentCatalog(None, {"new": self.agent(name="名" * 64)}), initial)
            .agents["new"].name,
            "名" * 64,
        )
        for bad in ("x" * 65, "first\nsecond", "first\rsecond", "first\u2028second"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.load({"main": self.agent(name=bad)})
            with self.subTest(bad=bad, source="catalog"), self.assertRaises(ValueError):
                validate_catalog(AgentCatalog(None, {"new": self.agent(name=bad)}), initial)
        for bad in (
            self.agent(workers=("missing",)),
            self.agent(skills=("a/b",)),
            self.agent(mcp_servers=("missing",)),
        ):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_catalog(AgentCatalog(None, {"new": bad}), initial)

    def test_database_mcp_definitions_follow_file_rules_and_do_not_mutate_inputs(self):
        original = {"wiki": {
            "command": "python", "args": ["server.py"], "env": {"TOKEN": "private"}
        }}
        descriptions = {"wiki": "Search the wiki"}
        self.mcps.write_text("not valid TOML [[[", encoding="utf-8")
        catalog = AgentCatalog("main", {"main": self.agent(searchable_mcp_servers=("wiki",))})
        config = load_config_for_catalog(
            catalog, None, self.environments,
            mcp_servers=original, mcp_descriptions=descriptions,
        )
        original["wiki"]["args"].append("--changed")
        original["wiki"]["env"]["TOKEN"] = "changed"
        self.assertEqual(config.mcp_servers["wiki"]["args"], ["server.py"])
        self.assertEqual(config.mcp_servers["wiki"]["env"], {"TOKEN": "private"})
        for servers, descriptions in (
            ({"wiki": {"url": "https://user:secret@example.com"}}, {"wiki": "Wiki"}),
            ({"wiki": {"url": "https://example.com", "headers": {"Authorization": 3}}}, {"wiki": "Wiki"}),
            ({"wiki": {"command": "python", "env": {"TOKEN": 3}}}, {"wiki": "Wiki"}),
            ({"wiki": {"url": "https://example.com"}}, {"wiki": ""}),
            ({"wiki": {"url": "https://example.com"}}, {"unknown": "Other"}),
        ):
            with self.subTest(servers=servers), self.assertRaises(ValueError) as raised:
                validate_mcp_servers(servers, descriptions)
            self.assertNotIn("secret", str(raised.exception))
        with self.assertRaisesRegex(ValueError, "description"):
            load_config_for_catalog(
                catalog, None, self.environments,
                mcp_servers={"wiki": {"url": "https://example.com"}},
            )
