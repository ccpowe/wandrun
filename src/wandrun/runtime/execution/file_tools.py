"""Explicit, conversation-authorized import of gateway uploads into the calling backend."""

import asyncssh

from langchain.tools import tool
from langchain_core.runnables import RunnableConfig


def attachment_tools(files) -> list:
    @tool
    async def fetch_upload(upload_id: str, config: RunnableConfig) -> dict:
        """获取本对话用户上传到当前 Agent 的执行环境，返回可供文件/命令工具使用的路径。

        upload_id 只取用户消息给出的已完成上传引用。不能指定其他环境、下载 URL 或宿主路径。
        获取是显式环境 I/O，可能恢复 Sandbox；同一完整上传重试复用副本，同名文件不覆盖。
        """
        task_id = config.get("configurable", {}).get("thread_id")
        if not isinstance(task_id, str) or not task_id:
            return {"error": "获取上传需要调用任务身份"}
        files.manager.ensure_active(task_id)
        try:
            return await files.fetch_upload(task_id, upload_id)
        except (ValueError, OSError, RuntimeError) as error:
            return {"error": str(error)}
        except asyncssh.Error:
            return {"error": "文件传输连接中断，获取结果未确认；重试同一上传引用不会覆盖已有文件。"}

    return [fetch_upload]
