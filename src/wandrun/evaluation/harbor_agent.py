"""Harbor 自定义 Installed Agent 适配器。

该模块只在 Harbor 宿主进程导入；Wandrun 的普通 CLI 不依赖 Harbor。
"""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path

from harbor.agents.installed.base import (
    AgentAuthenticationError,
    BaseInstalledAgent,
    ErrorPattern,
    NetworkConnectionError,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from wandrun.config import load_config


class WandrunAgent(BaseInstalledAgent):
    """在 Harbor 任务容器中安装并以 headless 模式运行 Wandrun。"""

    ERROR_PATTERNS = [
        ErrorPattern(r'"status"\s*:\s*"auth_failed"', AgentAuthenticationError),
        ErrorPattern(r'"status"\s*:\s*"network_failed"', NetworkConnectionError),
        *BaseInstalledAgent.ERROR_PATTERNS,
    ]

    def __init__(
        self,
        *args,
        package_spec: str | None = None,
        reasoning_effort: str | None = None,
        agents_config: Path = Path("workspace/.wandrun/agents.toml"),
        mcps_config: Path | None = None,
        environments_config: Path | None = None,
        task_timeout_seconds: float = 1200,
        model_timeout_seconds: float = 90,
        model_max_retries: int = 2,
        cleanup_grace_seconds: float = 10,
        max_model_requests: int = 120,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        if not package_spec:
            raise ValueError(
                "WandrunAgent 需要 package_spec，例如 "
                "git+https://github.com/ccpowe/wandrun.git@<commit>"
            )
        if reasoning_effort is not None and reasoning_effort not in {
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
        }:
            raise ValueError("不支持的 reasoning_effort")
        self.package_spec = package_spec
        self.reasoning_effort = reasoning_effort
        self.agents_config = Path(agents_config)
        self.mcps_config = Path(mcps_config) if mcps_config is not None else None
        self.environments_config = (
            Path(environments_config) if environments_config is not None else None
        )
        self.task_timeout_seconds = task_timeout_seconds
        self.model_timeout_seconds = model_timeout_seconds
        if model_max_retries < 0:
            raise ValueError("model_max_retries 不能小于 0")
        self.model_max_retries = model_max_retries
        self.cleanup_grace_seconds = cleanup_grace_seconds
        self.max_model_requests = max_model_requests

    @staticmethod
    def name() -> str:
        return "wandrun"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(
            environment, ("curl", "ca_certificates", "git")
        )
        install_spec = self.package_spec
        local_package = Path(self.package_spec).expanduser()
        if local_package.is_file():
            remote_package = f"/installed-agent/{local_package.name}"
            await environment.upload_file(local_package.resolve(), remote_package)
            install_spec = remote_package
        await self.exec_as_root(
            environment,
            command=(
                "curl -LsSf --connect-timeout 10 --max-time 60 "
                "--retry 2 --retry-delay 2 --retry-all-errors "
                "https://astral.sh/uv/install.sh | "
                "env UV_UNMANAGED_INSTALL=/installed-agent/bin sh && "
                "printf 'sqlite-vec\\n' > /installed-agent/uv-excludes.txt && "
                "env UV_TOOL_BIN_DIR=/installed-agent/bin "
                "UV_TOOL_DIR=/installed-agent/tools "
                "/installed-agent/bin/uv tool install --python 3.13 "
                "--excludes /installed-agent/uv-excludes.txt "
                + shlex.quote(install_spec)
            ),
        )

    def get_version_command(self) -> str | None:
        return "/installed-agent/bin/wandrun --version"

    async def _upload_auth(self, environment: BaseEnvironment) -> str:
        source_value = self._get_env("CODEX_AUTH_JSON_PATH") or os.environ.get(
            "CODEX_AUTH_JSON_PATH"
        )
        if not source_value:
            raise AgentAuthenticationError(
                "需要通过 --ae CODEX_AUTH_JSON_PATH=/path/to/auth.json 提供凭据"
            )
        source = Path(source_value)
        if not source.is_file():
            raise AgentAuthenticationError(f"Codex auth.json 不存在: {source}")
        target = "/installed-agent/wandrun-codex/auth.json"
        await self.exec_as_root(
            environment,
            command=(
                "mkdir -p /installed-agent/wandrun-codex /installed-agent/wandrun-state"
            ),
        )
        if environment.default_user is not None:
            user = shlex.quote(str(environment.default_user))
            await self.exec_as_root(
                environment,
                command=(
                    f"chown {user} /installed-agent/wandrun-codex "
                    "/installed-agent/wandrun-state"
                ),
            )
        await self._upload_agent_owned_file(environment, source, target)
        await self.exec_as_root(environment, command=f"chmod 600 {target}")
        return "/installed-agent/wandrun-codex"

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        agents_source = self.agents_config.expanduser().resolve()
        mcps_source = (
            self.mcps_config.expanduser().resolve()
            if self.mcps_config is not None
            else agents_source.parent / "mcps.toml"
        )
        environments_source = (
            self.environments_config.expanduser().resolve()
            if self.environments_config is not None
            else agents_source.parent / "environments.toml"
        )
        load_config(agents_source, mcps_source, environments_source)
        codex_home = await self._upload_auth(environment)
        agents_target = "/installed-agent/wandrun-state/agents.toml"
        mcps_target = "/installed-agent/wandrun-state/mcps.toml"
        environments_target = "/installed-agent/wandrun-state/environments.toml"
        await self._upload_agent_owned_file(environment, agents_source, agents_target)
        await self._upload_agent_owned_file(environment, mcps_source, mcps_target)
        await self._upload_agent_owned_file(
            environment, environments_source, environments_target
        )
        await self.exec_as_root(
            environment,
            command=f"chmod 600 {agents_target} {mcps_target} {environments_target}",
        )
        output_dir = (self.environment_logs_dir / "wandrun").as_posix()
        parts = [
            f"mkdir -p {shlex.quote(output_dir)} && /installed-agent/bin/wandrun run",
            "--instruction",
            shlex.quote(instruction),
            '--workspace "$PWD"',
            "--state-dir /installed-agent/wandrun-state",
            f"--output-dir {output_dir}",
            f"--result-json {output_dir}/result.json",
            f"--agents-config {agents_target}",
            f"--mcps-config {mcps_target}",
            f"--environments-config {environments_target}",
            f"--task-timeout-seconds {self.task_timeout_seconds:g}",
            f"--model-timeout-seconds {self.model_timeout_seconds:g}",
            f"--model-max-retries {self.model_max_retries}",
            f"--cleanup-grace-seconds {self.cleanup_grace_seconds:g}",
            f"--max-model-requests {self.max_model_requests}",
        ]
        if self.model_name:
            parts.extend(("--model", shlex.quote(self.model_name.split("/")[-1])))
        if self.reasoning_effort is not None:
            parts.extend(("--reasoning-effort", shlex.quote(self.reasoning_effort)))
        command = " ".join(parts)
        await self.exec_as_agent(
            environment,
            command=command,
            env={
                "CODEX_HOME": codex_home,
                "WANDRUN_PACKAGE_SPEC": self.package_spec,
            },
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        result_path = self.logs_dir / "wandrun" / "result.json"
        if not result_path.is_file():
            return
        try:
            result = json.loads(result_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.logger.exception("无法读取 Wandrun result.json")
            return
        usage = result.get("usage") or {}
        context.n_input_tokens = usage.get("input_tokens")
        context.n_cache_tokens = usage.get("cached_input_tokens")
        context.n_output_tokens = usage.get("output_tokens")
        context.metadata = {
            "wandrun_status": result.get("status"),
            "wandrun_run_id": result.get("run_id"),
            "wandrun_version": result.get("wandrun_version"),
            "wandrun_package_spec": result.get("wandrun_package_spec"),
            "model": result.get("model"),
            "reasoning_effort": result.get("reasoning_effort"),
            "agent_models": result.get("agent_models"),
            "main_agent": result.get("main_agent"),
            "agents_config": result.get("agents_config"),
            "mcps_config": result.get("mcps_config"),
            "model_request_count": usage.get("model_request_count"),
            "model_max_retries": result.get("model_max_retries"),
            "usage_complete": usage.get("usage_complete"),
            "reasoning_tokens": usage.get("reasoning_tokens"),
            "usage_missing_requests": usage.get("usage_missing_requests"),
        }
