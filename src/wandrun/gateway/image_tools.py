"""Local image generation tool: bind task identity, save one completed PNG, return its path."""


import asyncio
import os

from langchain.tools import BaseTool, tool
from langchain_core.runnables import RunnableConfig

from wandrun.integrations.image_generation import (
    DEFAULT_IMAGE_MODEL, MAX_REFERENCE_BYTES, MAX_REFERENCE_IMAGES, MAX_REFERENCE_PIXELS,
    ImageGenerationError, ImageSize, generate_image as request_image,
)
from wandrun.runtime.execution.files import TaskFiles
from wandrun.runtime.communication.workers import WorkerManager
from wandrun.integrations.codex_credentials import CodexCredentials


def image_tools(
    manager: WorkerManager, files: TaskFiles, *, model_name: str = DEFAULT_IMAGE_MODEL,
    credentials: CodexCredentials | None = None,
) -> list[BaseTool]:
    """Expose image generation with optional conversation-local references to active local tasks."""

    @tool(description=f"""生成 PNG 并保存到当前对话目录；不会自动发送附件。

用户上传的商品图应通过 reference_image_paths 作为原图传入，不要只用文字转述；
列表顺序对应 prompt 中的第一张、第二张等参考图。最多 {MAX_REFERENCE_IMAGES} 张 PNG/JPEG/WebP，
每张最多 {MAX_REFERENCE_BYTES // (1024 * 1024)} MiB、{MAX_REFERENCE_PIXELS} 像素。
相对路径基于当前对话目录；只接受该目录内的普通文件，不接受 URL、符号链接或其他宿主路径。
size 支持 1024x1024、1024x1536（竖图）、1536x1024（横图）或 auto；
小红书可选竖图并在 prompt 说明构图。尺寸和画质均 best-effort，以返回的
width、height、quality 为准；quality 为 null 表示服务端未报告。
要给用户查看，请在消息中将返回的 path 作为附件发送。""")
    async def generate_image(
        prompt: str, config: RunnableConfig, reference_image_paths: list[str] | None = None,
        size: ImageSize = "1024x1024",
    ) -> dict:
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
            paths = reference_image_paths or []
            if len(paths) > MAX_REFERENCE_IMAGES:
                raise ValueError(f"参考图最多 {MAX_REFERENCE_IMAGES} 张")
            references = [
                files.read_local_file(task_id, path, max_bytes=MAX_REFERENCE_BYTES)
                for path in paths
            ]
            image = await request_image(
                prompt, reference_images=references, size=size,
                model_name=model_name, credentials=credentials,
            )
            manager.ensure_active(task_id)
            if manager.get(task_id)["status"] != "running":
                raise asyncio.CancelledError()
            saved = files.save_local_file(task_id, "generated.png", image.data)
        except ImageGenerationError as error:
            detail = {"code": error.code, "detail": error.detail}
            if error.resets_at is not None:
                detail["resets_at"] = error.resets_at
            return {"error": detail}
        except (OSError, ValueError, KeyError) as error:
            return {"error": {"code": "image_generation_failed", "detail": str(error)}}
        return {
            "path": str(saved), "quality": image.quality,
            "width": image.width, "height": image.height,
            "used_reference_images": bool(paths),
            "message": f"图片已保存到 {saved}。要给用户查看，请在发给用户的消息中把该文件作为附件发送。",
        }

    return [generate_image]
