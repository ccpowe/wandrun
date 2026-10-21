"""Gateway entry capabilities: graph middleware borrows environment-scoped host tools.

The UI definition is stable so startup materialization and workspace name reservation
read the same builtin declaration. Its validator is bound to one Gateway instance only
when the entry registers its capabilities.
"""

from dataclasses import replace

from langchain.agents.middleware import AgentMiddleware
from langchain.tools import BaseTool

from wandrun.gateway.ui_blocks import model_instructions, skill_files
from wandrun.integrations.image_generation import DEFAULT_IMAGE_MODEL
from wandrun.runtime.capabilities import EntryCapabilityDefinition
from wandrun.runtime.human_message_guidance import HumanMessageGuidanceMiddleware


class ScheduleMiddleware(AgentMiddleware):
    """Expose the environment's already-bound schedule tool on this Agent graph."""

    def __init__(self, tools: list[BaseTool]):
        self.tools = tools


class ImageGenerationMiddleware(AgentMiddleware):
    """Expose the environment's already-bound image tool on this Agent graph."""

    def __init__(self, tools: list[BaseTool]):
        self.tools = tools


def _always(_agent, _environment):
    return "enabled", "所有 Agent 都有"


def _local_image(_agent, environment):
    if environment.type == "local":
        return "enabled", "本机环境可用"
    return "not_applicable", "需要本机环境"


def _ui_middleware(_manager, _files, _environment_type):
    guidance = model_instructions()
    return lambda: HumanMessageGuidanceMiddleware(guidance)


UI_CAPABILITY = EntryCapabilityDefinition(
    id="ui_blocks",
    display_name="交互界面",
    condition=_always,
    prepare_middleware=_ui_middleware,
    builtin_skills={"wandrun-ui": skill_files()},
    summary="在消息里显示表单和图表",
    description="在消息中显示表单、图表等交互界面。",
)


def gateway_capabilities(gateway, *, image_generation_model=DEFAULT_IMAGE_MODEL):
    """Register schedule, local image generation and UI for one Gateway instance.

    Tool closures are prepared once per configured environment type by the runtime;
    rebuilding graphs creates fresh middleware referencing those same tools. The UI
    validation callback remains bound to Gateway, which owns the rejection counters.
    """
    def schedule_middleware(manager, _files, _environment_type):
        # skills -> capabilities is also used while service imports; bind only after Gateway exists.
        from wandrun.gateway.schedule_tools import schedule_tools

        tools = schedule_tools(gateway, manager)
        return lambda: ScheduleMiddleware(tools)

    def image_middleware(manager, files, _environment_type):
        from wandrun.gateway.image_tools import image_tools

        tools = image_tools(
            manager, files, model_name=image_generation_model,
            credentials=gateway.subscription.credentials,
        )
        return lambda: ImageGenerationMiddleware(tools)

    return (
        EntryCapabilityDefinition(
            id="schedule",
            display_name="定时",
            condition=_always,
            prepare_middleware=schedule_middleware,
            summary="自己创建定时任务",
            description="由 Agent 创建定时任务，在 Agent 资料 › 定时中管理。",
        ),
        EntryCapabilityDefinition(
            id="image_generation",
            display_name="生图",
            condition=_local_image,
            prepare_middleware=image_middleware,
            summary="生成图片",
            description="生成图片并保存到当前对话的目录。",
        ),
        replace(UI_CAPABILITY, validate_human=gateway.validate_human),
    )
