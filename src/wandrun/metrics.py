"""逐请求记录模型用量；只汇总新请求，不遍历或重算对话历史。"""

import asyncio
import json
from collections import Counter
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Callable
from uuid import uuid4


_scope = ContextVar("wandrun_metrics_scope", default=None)
TOKEN_FIELDS = (
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_tokens",
)


def _now():
    return datetime.now(timezone.utc).isoformat()


def _count(value):
    return value if type(value) is int and value >= 0 else None


def _totals(records):
    result = {field: sum(r[field] or 0 for r in records) for field in TOKEN_FIELDS}
    # cached 是 input 的子集，reasoning 是 output 的子集。
    result["total_tokens"] = result["input_tokens"] + result["output_tokens"]
    result["model_request_count"] = len(records)
    result["usage_missing_requests"] = sum(
        r["input_tokens"] is None or r["output_tokens"] is None for r in records
    )
    result["usage_complete"] = result["usage_missing_requests"] == 0
    for field in ("cached_input_tokens", "reasoning_tokens"):
        result[f"{field}_missing_requests"] = sum(r[field] is None for r in records)
    result["request_statuses"] = dict(Counter(r["status"] for r in records))
    return result


def _summary(run_id, records):
    result = {"run_id": run_id, **_totals(records)}
    for key in ("task_id", "agent", "model"):
        result[f"by_{key}"] = {
            value: _totals([r for r in records if r[key] == value])
            for value in sorted({r[key] for r in records})
        }
    return result


class RunMetrics:
    """一次启动一个 run；JSONL 保存请求快照，最后一条同 ID 快照覆盖前一条。"""

    def __init__(self, runs_dir: Path, on_record: Callable[[dict], None] | None = None):
        self.run_id = uuid4().hex
        self.directory = Path(runs_dir) / self.run_id
        self.directory.mkdir(parents=True, exist_ok=False)
        self.log_path = self.directory / "requests.jsonl"
        self.log_path.touch()
        self._records = {}
        self._lock = RLock()
        self._on_record = on_record

    @contextmanager
    def agent_scope(self, task_id: str, agent: str):
        # 每个 Worker 自行进入 scope；不依赖父 asyncio Task 的 Context 继承。
        token = _scope.set((self, task_id, agent))
        try:
            yield
        finally:
            _scope.reset(token)

    def _save(self, record):
        with self._lock:
            snapshot = dict(record)
            with self.log_path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(snapshot, ensure_ascii=False) + "\n")
            self._records[record["request_id"]] = snapshot

    def summary(self):
        with self._lock:
            return _summary(self.run_id, list(self._records.values()))

    @property
    def summary_path(self) -> Path:
        return self.directory / "summary.json"

    def write_summary(self):
        path = self.summary_path
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(self.summary(), ensure_ascii=False, indent=2), encoding="utf-8"
        )
        temporary.replace(path)
        return path


class _Request:
    def __init__(self, metrics, task_id, agent, model):
        self.metrics = metrics
        self.record = {
            "run_id": metrics.run_id,
            "request_id": uuid4().hex,
            "task_id": task_id,
            "agent": agent,
            "model": model,
            "started_at": _now(),
            "finished_at": None,
            "status": "running",
            "response_id": None,
            "response_status": None,
            "error_type": None,
            **{field: None for field in TOKEN_FIELDS},
            "total_tokens": None,
        }
        metrics._save(self.record)

    def observe(self, event):
        if event.get("type") not in {
            "response.completed",
            "response.failed",
            "response.incomplete",
        }:
            return
        response = event.get("response") or {}
        self.record["response_id"] = response.get("id")
        self.record["response_status"] = response.get("status")
        usage = response.get("usage")
        if isinstance(usage, dict):
            self.record.update(
                input_tokens=_count(usage.get("input_tokens")),
                output_tokens=_count(usage.get("output_tokens")),
                cached_input_tokens=_count(
                    (usage.get("input_tokens_details") or {}).get("cached_tokens")
                ),
                reasoning_tokens=_count(
                    (usage.get("output_tokens_details") or {}).get("reasoning_tokens")
                ),
            )
            if (
                self.record["input_tokens"] is not None
                and self.record["output_tokens"] is not None
            ):
                self.record["total_tokens"] = (
                    self.record["input_tokens"] + self.record["output_tokens"]
                )
        # 先保存服务端用量，再解析输出；即使随后 JSON/工具参数校验失败也不能丢失消耗。
        self.metrics._save(self.record)

    def finish(self, status, error=None):
        self.record.update(
            status=status,
            finished_at=_now(),
            error_type=type(error).__name__ if error else None,
        )
        self.metrics._save(self.record)
        # 同步观察者在请求所在线程执行（同步模型可能在 worker 线程）；
        # 网关需自行调度到所属事件循环，异常不吞掉也不改变 JSONL 格式。
        if self.metrics._on_record is not None:
            self.metrics._on_record(dict(self.record))


@contextmanager
def record_request(model: str):
    scope = _scope.get()
    if scope is None:
        yield None
        return
    metrics, task_id, agent = scope
    request = _Request(metrics, task_id, agent, model)
    try:
        yield request
    except BaseException as error:
        status = (
            "cancelled"
            if isinstance(error, (asyncio.CancelledError, GeneratorExit))
            else "failed"
        )
        request.finish(status, error)
        raise
    else:
        request.finish("completed")


def summarize_log(path: Path):
    """进程被强制结束后也能从日志恢复已知消耗；未收尾的请求标为 interrupted。"""
    records = {}
    run_id = None
    lines = Path(path).read_bytes().splitlines(keepends=True)
    for index, line in enumerate(lines):
        try:
            record = json.loads(line)
        except (json.JSONDecodeError, UnicodeDecodeError):
            if index == len(lines) - 1 and not line.endswith(b"\n"):
                break  # 强制退出可能留下末尾半行；不能忽略中间的损坏记录。
            raise
        if run_id is None:
            run_id = record["run_id"]
        elif record["run_id"] != run_id:
            raise ValueError("日志中包含不同 run 的记录")
        records[record["request_id"]] = record
    for record in records.values():
        if record["status"] == "running":
            record["status"] = "interrupted"
    return _summary(run_id or Path(path).parent.name, list(records.values()))


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", type=Path)
    print(
        json.dumps(summarize_log(parser.parse_args().log), ensure_ascii=False, indent=2)
    )
