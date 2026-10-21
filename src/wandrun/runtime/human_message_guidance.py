"""Entry-provided human message instructions, independent of delivery validation."""

from deepagents.middleware._utils import append_to_system_message
from langchain.agents.middleware.types import AgentMiddleware


class HumanMessageGuidanceMiddleware(AgentMiddleware):
    """Append configured guidance to each request, never to history or checkpoint state.

    Delivery validation and its task-local counters remain owned by the entry.
    """

    def __init__(self, guidance: str):
        self.guidance = guidance

    async def awrap_model_call(self, request, handler):
        return await handler(request.override(
            system_message=append_to_system_message(request.system_message, self.guidance),
        ))
