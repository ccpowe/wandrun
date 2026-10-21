"""Local image generation tool: bind task identity, save one completed PNG, return its path."""


import asyncio
import os

from langchain.tools import BaseTool, tool
from langchain_core.runnables import RunnableConfig

from wandrun.integrations.image_generation import (
    DEFAULT_IMAGE_MODEL, ImageGenerationError, generate_image as request_image,
)
from wandrun.runtime.files import TaskFiles
from wandrun.runtime.workers import WorkerManager
from wandrun.integrations.codex_credentials import CodexCredentials


def image_tools(
    manager: WorkerManager, files: TaskFiles, *, model_name: str = DEFAULT_IMAGE_MODEL,
    credentials: CodexCredentials | None = None,
) -> list[BaseTool]:
    """Expose generate_image(prompt) only for an active local task with conversation workdirs."""

    @tool
    async def generate_image(prompt: str, config: RunnableConfig) -> dict:
        """根据文字描述生成 PNG，保存到当前对话工作目录；要展示给用户，请在发给用户的消息中附上返回的文件路径。"""
        task_id = config.get("configurable", {}).get("thread_id")
        if not isinstance(task_id, str) or not task_id.strip():
            return {"error": {"code": "image_generation_failed", "detail": "生图需要调用方的 thread_id"}}
        manager.ensure_active(task_id)
        try:
            if manager.get(task_id)["status"] != "running":
                raise asyncio.CancelledError()
            # Check local path and symlinks before incurring a billable network request.
            _, directory_fd = files.open_local_conversation_directory(task_id)
            os.close(directory_fd)
            image = await request_image(prompt, model_name=model_name, credentials=credentials)
            manager.ensure_active(task_id)
            if manager.get(task_id)["status"] != "running":
                raise asyncio.CancelledError()
            saved = files.save_local_file(task_id, "generated.png", image)
        except ImageGenerationError as error:
            detail = {"code": error.code, "detail": error.detail}
            if error.resets_at is not None:
                detail["resets_at"] = error.resets_at
            return {"error": detail}
        except (OSError, ValueError, KeyError) as error:
            return {"error": {"code": "image_generation_failed", "detail": str(error)}}
        return {"path": str(saved), "message": f"图片已保存到 {saved}。要给用户查看，请在发给用户的消息中把该文件作为附件发送。"}

    return [generate_image]
