"""浏览器接管工具的图级装配；租约及其生命周期仍归运行时所有。"""

from langchain.agents.middleware import AgentMiddleware
from langchain.tools import tool
from langchain_core.runnables import RunnableConfig

from wandrun.runtime.browser import BrowserRejected


class BrowserTakeoverMiddleware(AgentMiddleware):
    """持有 request_takeover；调用方用已解析的能力结果决定是否装配。"""

    def __init__(self, manager, browser):
        super().__init__()

        @tool
        async def request_takeover(reason: str, config: RunnableConfig) -> dict:
            """请用户接管当前任务的浏览器，说明需要用户处理的原因。"""
            task_id = config.get("configurable", {}).get("thread_id")
            if not isinstance(task_id, str) or not task_id:
                raise ValueError("接管请求缺少任务身份")
            manager.ensure_active(task_id)
            try:
                return await browser.request_takeover(task_id, reason)
            except BrowserRejected as exc:
                return {"error": f"浏览器接管请求被拒绝：{exc}"}

        self.tools = [request_takeover]
