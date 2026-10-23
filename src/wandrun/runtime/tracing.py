"""Opt-in development traces: isolated Worker ancestry and one private upload boundary.

Only open_runtime constructs this client. Run dictionaries are normalized using the
locked SDK's serializer before redaction, so message objects cannot bypass masking.
This is not an interceptor for arbitrary LangSmith Client APIs or unknown secrets.
"""

import asyncio
import base64
import json
import os
import re
from contextlib import contextmanager
from contextvars import ContextVar
from threading import RLock
from urllib.parse import quote, quote_plus

_current = ContextVar("wandrun_tracing", default=None)
_SENSITIVE = re.compile(
    r"^(?:authorization|proxy.authorization|cookie|set.cookie|headers|env|credentials|"
    r"api.keys?|.*[_-]api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|"
    r"client[_-]?secret|password|secret|token)$", re.I,
)
_BEARER = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]+", re.I)
_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")
_API_KEY = re.compile(r"\b(?:sk-[A-Za-z0-9_-]{16,}|lsv2_[A-Za-z0-9_-]{16,})\b")
_ASSIGNMENT = re.compile(
    r"((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|"
    r"client[_-]?secret|password|authorization)[\"']?\s*[:=]\s*[\"']?)([^\s\"'&,;}]+)", re.I,
)


class TraceRedactor:
    """Retain known credential generations until the private client has drained.

    Sources must be thread-safe and must never touch the gateway SQLite connection.
    A failed source or serializer drops a batch; raw run data is never a fallback.
    """

    def __init__(self, source=lambda: ()):
        self._source = source
        self._values = set()
        self._pattern = None
        self._lock = RLock()
        self.remember(value for key, value in os.environ.items() if _SENSITIVE.search(key) or any(
            part in key.upper() for part in ("API_KEY", "TOKEN", "SECRET", "PASSWORD")
        ))

    def remember(self, values):
        with self._lock:
            previous = len(self._values)
            for value in values:
                if not isinstance(value, str) or not value:
                    continue
                base = {
                    base64.b64encode(value.encode("utf-8")).decode("ascii"),
                    value, quote(value, safe=""), quote_plus(value),
                    json.dumps(value)[1:-1], json.dumps(value, ensure_ascii=False)[1:-1],
                    repr(value)[1:-1], repr(value.encode("utf-8"))[2:-1],
                }
                self._values.update(base)
                for escaped in base:
                    self._values.update((json.dumps(escaped)[1:-1], repr(escaped)[1:-1],
                                         escaped.replace("\\", "\\\\")))
            if len(self._values) != previous:
                self._pattern = re.compile("|".join(
                    re.escape(value) for value in sorted(self._values, key=len, reverse=True) if value
                ))

    def __call__(self, runs):
        # Native callbacks supply message objects; scrub their serialized fields too.
        from langsmith._internal._serde import dumps_json

        try:
            self.remember(self._source())
            with self._lock:
                pattern = self._pattern

            def text(value):
                if pattern is not None:
                    value = pattern.sub("[redacted]", value)
                value = _BEARER.sub("Bearer [redacted]", value)
                value = _JWT.sub("[redacted]", value)
                value = _API_KEY.sub("[redacted]", value)
                return _ASSIGNMENT.sub(r"\1[redacted]", value)

            def scrub(value):
                if isinstance(value, str):
                    return text(value)
                if isinstance(value, list):
                    return [scrub(item) for item in value]
                if isinstance(value, dict):
                    return {
                        text(key): "[redacted]" if _SENSITIVE.fullmatch(key) else scrub(item)
                        for key, item in value.items()
                    }
                return value

            result = []
            for run in runs:
                normalized = json.loads(dumps_json(run))
                # Trace attachments are a separate binary upload path, not run text.
                normalized.pop("attachments", None)
                clean = {key: scrub(value) for key, value in normalized.items()}
                # These are SDK-generated routing fields, not application content.
                # The buffered hook requires UUID *objects* to remain equal as well.
                for key in ("id", "trace_id", "parent_run_id", "dotted_order",
                            "run_type", "start_time", "end_time"):
                    if key in run:
                        clean[key] = run[key]
                result.append(clean)
            return result
        except Exception:
            raise RuntimeError("Trace redaction failed; batch not uploaded") from None


def _create_client(redact, **kwargs):
    """Mask before SDK queue admission; buffered preprocessing can outlive SDK close."""
    from langsmith import Client

    class RedactingClient(Client):
        def create_run(self, name, inputs, run_type, **options):
            safe = redact([{**options, "name": name, "inputs": inputs, "run_type": run_type}])[0]
            return super().create_run(**safe)

        def update_run(self, run_id, **options):
            safe = redact([{**options, "id": run_id}])[0]
            identity = safe.pop("id")
            return super().update_run(identity, **safe)

    return RedactingClient(omit_traced_runtime_info=True, **kwargs)


class RuntimeTracing:
    """Own one sanitized client; task anchors survive asynchronous waits and turns.

    Anchors contain only dotted-order strings, not live RunTrees or model history.
    Process restarts start new traces unless a trusted Harbor launcher supplies a parent.
    """

    def __init__(self, secret_source=lambda: (), *, client=None):
        # No extra asynchronous preprocessing stage: normal SDK flush owns all writes.
        self.redactor = TraceRedactor(secret_source)
        self.redactor.remember(secret_source())
        self._anchors = {}
        # Workers intentionally start in empty Contexts. Restore only the launcher's
        # explicit trace headers, never an ambient RunTree or arbitrary execution state.
        self._external_parent = None
        if parent := os.environ.get("HARBOR_LANGSMITH_PARENT"):
            self._external_parent = {"langsmith-trace": parent}
            if baggage := os.environ.get("HARBOR_LANGSMITH_BAGGAGE"):
                self._external_parent["baggage"] = baggage
        self.client = client if client is not None else _create_client(self.redactor)

    def wrap_worker(self, operation, manager_for):
        """Restore only tracing inside the Worker's intentionally empty Context."""
        from langsmith import trace, tracing_context

        async def run(prompts, task_id):
            manager = manager_for()
            agent_id, parent_id = manager.task_identity(task_id)
            root = manager.root_of(task_id)
            metadata = {
                "conversation_id": root, "root_task_id": root, "task_id": task_id,
                "agent_id": agent_id, "parent_task_id": parent_id,
            }
            # Deleted branches must not retain trace ancestry until process exit.
            for identity in tuple(self._anchors):
                if not manager.has_task(identity):
                    del self._anchors[identity]
            parent = self._anchors.get(task_id) or self._anchors.get(parent_id)
            token = _current.set(self)
            try:
                with tracing_context(
                    enabled=True, client=self.client, parent=False,
                    metadata=metadata,
                ):
                    with trace(
                        f"{'conversation' if parent_id is None else 'task'}:{agent_id}",
                        inputs={"messages": prompts},
                        parent=parent or self._external_parent or "ignore",
                        client=self.client,
                    ) as span:
                        self._anchors.setdefault(task_id, span.dotted_order)
                        try:
                            result = await operation(prompts, task_id)
                        except asyncio.CancelledError:
                            span.add_metadata({"status": "cancelled"})
                            raise
                        except BaseException:
                            span.add_metadata({"status": "failed"})
                            raise
                        status = "waiting" if getattr(result, "next", None) == "wait" else "completed"
                        span.add_metadata({"status": status})
                        span.end(outputs={"status": status, "result": result})
                        return result
            finally:
                _current.reset(token)

        return run

    def remember_credentials(self, snapshot):
        """Register both bare tokens and headers before a provider request can echo them."""
        self.redactor.remember((
            *snapshot.tokens.values(),
            *(value for key, value in snapshot.headers.items()
              if key.lower() in {"authorization", "chatgpt-account-id"}),
        ))

    def remember_connectors(self, servers):
        """Retain superseded connector secrets while old graphs may still be executing."""
        from wandrun.integrations.mcp import _connection_secrets

        values = []
        for connection in servers.values():
            secrets = _connection_secrets(connection)
            values.extend(secrets)
            if connection.get("url"):
                values.append(connection["url"])
            for value in (*connection.get("args", ()), *secrets):
                if isinstance(value, str):
                    if value.lower().startswith(("bearer ", "basic ")):
                        values.append(value.split(" ", 1)[1])
                    for match in _ASSIGNMENT.finditer(value):
                        values.append(match.group(2))
        self.redactor.remember(values)


    async def aclose(self):
        """Own best-effort SDK shutdown through cancellation, outside execution deadlines."""
        closing = asyncio.create_task(asyncio.to_thread(self.client.close, timeout=10))
        cancelled = False
        while not closing.done():
            try:
                await asyncio.shield(closing)
            except asyncio.CancelledError:
                cancelled = True
        closing.result()
        self._anchors.clear()
        if cancelled:
            raise asyncio.CancelledError()


def capture_tool_context():
    """Return only an active Wandrun client's context, never a default SDK client."""
    if _current.get() is None:
        return None
    from langsmith.run_helpers import get_tracing_context

    return get_tracing_context()


@contextmanager
def tool_span(context, name, inputs, *, run_type="tool"):
    """Trace a non-LangChain operation; None is a no-op outside an opted-in runtime."""
    if context is None:
        yield None
        return
    from langsmith import trace, tracing_context

    with tracing_context(**context):
        with trace(name, run_type=run_type, inputs=inputs) as span:
            yield span


def remember_credentials(snapshot):
    """Register a newly acquired subscription snapshot only in an opted-in Worker."""
    tracing = _current.get()
    if tracing is not None:
        tracing.remember_credentials(snapshot)
