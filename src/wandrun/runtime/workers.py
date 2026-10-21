"""管理独立 Worker 的执行、调度、消息投递和状态查询。"""

import asyncio
import functools
import json
from collections.abc import Awaitable, Callable
from contextlib import contextmanager
from contextvars import Context
from uuid import uuid4

from langchain.tools import tool
from langchain.agents.middleware import AgentMiddleware, hook_config
from langchain.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from dataclasses import asdict, dataclass

from wandrun.runtime.files import ResolvedAttachment
from wandrun.runtime.messages import AgentOutput, runtime_message
from wandrun.runtime.scheduler_store import SchedulerStore, TaskSnapshot
from wandrun.runtime.preview import PreviewExecution, PreviewPersistenceError, current_preview


class SchedulerFailure(RuntimeError):
    """调度存储提交失败，运行已停止；入口据此报告，而不是当作普通拒绝。"""


class CollaborationStopped(ValueError):
    """创建链被显式停止或退役，不能通过对子任务的插话隐式恢复上级。"""


@dataclass(frozen=True)
class _PreparedDelivery:
    """Bind preflight to its message; None defers resolution to dispatch."""

    to: str
    task_id: str | None
    paths: tuple[str, ...]
    resolution: tuple[list[ResolvedAttachment], list[dict]] | None



def _transitional(method):
    """把整个同步方法作为一次逻辑转换；嵌套调用并入最外层的事务。"""

    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        with self._transition():
            return method(self, *args, **kwargs)

    return wrapper


async def _settled(tasks: list[asyncio.Task]) -> None:
    """等待执行结束，并让它们的 done 回调（结算、打断续轮）先于调用方继续执行。

    gather 对已结束的 Task 同步完成，不让出控制权；这些 Task 的 done 回调在结束时已进入
    就绪队列（先进先出），再让出一次即可保证回调已执行。等待方被取消不影响 Worker。
    """
    await asyncio.shield(asyncio.gather(*tasks, return_exceptions=True))
    await asyncio.sleep(0)


class WorkerManager:
    """管理独立任务及消息投递；调用方负责关闭。

    on_human 是可选的观察者，接收 (发送方 task_id, 正文, 已校验附件, 草稿 ID) 并负责展示和登记。
    未设置时发给 human 的消息投递失败；根任务状态仍可通过 get 查询。

    on_task_created 报告 (task_id, 创建者 task_id, 接收 Agent, 第一条正文)；
    on_task_message 报告 (发送 task_id, 接收 task_id, 正文, 已校验附件)。
    两者同步报告已接受事实，异常与 on_task 一样隔离，不改变投递结果。

    传入 store 时，调度状态在每次逻辑转换结束时提交为一个事务；启动时载入旧状态，
    并按“每个根任务都被取消”停止旧执行，由用户和创建者逐级恢复（ADR-0008）。
    提交失败后停止调度并取消全部 Worker，close 等待清理后报告该失败。
    不传 store 时只在内存中运行。
    """

    def __init__(
        self,
        run: Callable[[list[HumanMessage], str], Awaitable[AgentOutput | str]],
        *,
        on_human: Callable[[str, str, list[ResolvedAttachment], str | None], None] | None = None,
        on_preview: Callable[[str, dict], list[dict] | None] | None = None,
        validate_human: Callable[[str, str, list[ResolvedAttachment]], str | None] | None = None,
        agent_workers: dict[str, tuple[str, ...]] | None = None,
        default_agent: str | None = "worker",
        store: SchedulerStore | None = None,
        on_task: Callable[[str, str, str | None], None] | None = None,
        on_task_created: Callable[[str, str, str, str], None] | None = None,
        on_task_message: Callable[[str, str, str, list[ResolvedAttachment]], None] | None = None,
        notify_human_of_roots: bool = True,
        attachment_resolver: Callable[
            [str, str, list[str]], tuple[list[ResolvedAttachment], list[dict]]
        ] | None = None,
        attachment_preflight: Callable[
            [str, str, list[str]], Awaitable[tuple[list[ResolvedAttachment], list[dict]] | None]
        ] | None = None,
    ):
        # 字符串回调仅供原有的最小循环实验；正式 Agent 入口强制返回 AgentOutput。
        self._run = run
        # 不传定义时保留早期单 Worker 实验；正式入口显式传入角色及可委派范围。
        self._agent_workers = (
            {name: tuple(targets) for name, targets in agent_workers.items()}
            if agent_workers is not None
            else None
        )
        self._default_agent = default_agent
        if self._agent_workers is not None:
            self._check_agent_workers(self._agent_workers, default_agent)
        self._task_agents: dict[str, str] = {}
        # 可选的 human 观察者负责实际展示；缺失时显式拒绝 human 消息。
        self._on_human = on_human
        self._on_preview = on_preview
        self._previews: dict[asyncio.Task, PreviewExecution] = {}
        # 入口策略在任何交付副作用之前返回拒绝原因；不在可能已显示的观察者里拒绝。
        self._validate_human = validate_human
        self._attachment_resolver = attachment_resolver
        self._attachment_preflight = attachment_preflight
        # 可选的生命周期观察者：(task_id, 状态, 错误)；启动、结算及 waiting 被停止时报告。
        # 打断后立即续轮的那次执行不报终态：对外它一直在运行（ADR-0013）。
        self._on_task = None
        self._on_task_created = on_task_created
        self._on_task_message = on_task_message
        # 根任务结束时是否经 on_human 发运行时通知；有生命周期观察者的入口（网关）关闭它，
        # on_human 因此只收到 Agent 发给用户的话，不必按正文猜来源。
        self._notify_human_of_roots = notify_human_of_roots
        self._callers: dict[str, str | None] = {}
        self._feedback: dict[str, list[HumanMessage]] = {}
        # 模型循环已停止，但图的检查点提交和返回尚未完成。
        self._finishing: set[str] = set()
        # 显式恢复只开放目标；成员续聊另可开放祖先的重启屏障，不改写历史结果。
        self._stopped: set[str] = set()
        # _stopped 的子集；持久化原因，避免连续重启把显式停止转成可自动解除的屏障。
        self._restart_stopped: set[str] = set()
        self._cancelled_by: dict[asyncio.Task, str | None] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._closed = False
        self._inbox: dict[str, list[HumanMessage]] = {}
        # 已交给图、但本次图调用尚未正常返回的消息，包含 before_model 取出的补充。
        self._inflight: dict[str, list[HumanMessage]] = {}
        # 被打断、尚未结算的具体执行（ADR-0013）。期间只接收消息不启动，由该执行的 done 回调续轮。
        self._interrupting: dict[str, asyncio.Task] = {}
        # 从存储恢复、且之后还没有重新执行的任务，查询时使用重启前的 (status, error)。
        # 任务一旦创建新 Task 就移出，因此与 _tasks 互斥，状态总以当前执行为准。
        self._restored: dict[str, tuple[str, str | None]] = {}
        # 终态及发给创建者的反馈尚未结算的 Task。通常由 done 回调结算，
        # 但回调晚于 Task 结束；被停止的 waiting 任务则由 _seal_branch 提前结算。
        # 未结算时持久化为 running，终态才能与反馈一起提交，且只结算一次。
        self._unsettled: set[asyncio.Task] = set()
        self._store = store
        self._failure: BaseException | None = None
        self._failed = asyncio.Event()
        self._transition_depth = 0
        # Shell processes stop after Worker settlement; leases revoke as soon as cancellation begins.
        self._stop_hooks: list[Callable[[set[str]], Awaitable[list[str]]]] = []
        self._cancel_hooks: list[Callable[[set[str]], Awaitable[None]]] = []
        # 删除意图由入口持久化并在启动时重放；只封锁该角色，不取消其他根分支。
        self._retired_agents: set[str] = set()
        # 进行中的分支停止操作 → 范围。操作由 Manager 持有，调用方离开不撤销；完成前范围内不能恢复。
        self._branch_stops: dict[asyncio.Task, set[str]] = {}
        if store is not None:
            self._restore(store.load())
        # 构造期还未接入入口；恢复状态由入口读取快照校正，不发送新执行的生命周期事件。
        self._on_task = on_task

    @staticmethod
    def _check_agent_workers(
        workers: dict[str, tuple[str, ...]], default_agent: str | None
    ) -> None:
        if "human" in workers or (default_agent is not None and default_agent not in workers):
            raise ValueError("默认 Agent 必须存在，human 为保留名称")
        if any(target not in workers for targets in workers.values() for target in targets):
            raise ValueError("可委派的 Agent 必须已定义")

    def replace_agent_workers(
        self, workers: dict[str, tuple[str, ...]], default_agent: str | None
    ) -> None:
        """原子替换可委派范围；现有任务仍绑定创建时的 Agent。调用方先构建新图。"""
        self._check_agent_workers(workers, default_agent)
        self._agent_workers = {name: tuple(targets) for name, targets in workers.items()}
        self._default_agent = default_agent

    def running_tasks(self, agent: str) -> list[str]:
        """返回绑定角色的在途任务，包括等待协作和执行已返回但尚未结算的任务。"""
        return [
            task_id for task_id, name in self._task_agents.items()
            if name == agent and (
                self._status(task_id)[0] in {"running", "waiting"}
                or self._tasks.get(task_id) in self._unsettled
            )
        ]

    def retire_agent(self, agent: str) -> None:
        """删除意图发布后永久封锁角色的新建、显式恢复和通知唤醒；不取消任何任务。"""
        self._retired_agents.add(agent)

    @contextmanager
    def _transition(self):
        """一次逻辑转换；最外层结束时把调度状态提交为一个事务（ADR-0008 提交边界）。"""
        self._transition_depth += 1
        try:
            yield
        finally:
            self._transition_depth -= 1
            if self._transition_depth == 0:
                self._commit()

    def _commit(self) -> None:
        if self._store is None or self._closed:
            return  # 关闭或存储失败后冻结存储，交给下次启动恢复。
        try:
            self._store.save(self._durable_snapshots())
        except Exception as error:
            self._fail(error)
            raise self._closed_error() from error

    def _fail(self, error: BaseException) -> None:
        """存储与内存已不一致：按关闭处理，等待清理和报告失败由 close 负责。"""
        self._failure = error
        self._failed.set()
        self._stop_accepting()

    def _stop_accepting(self) -> None:
        """关闭与存储失败共用：不再接受调度或投递，封住全部任务，同步取消 Worker。

        刚创建、尚未运行的 Task 被取消后不会执行；存储随 _closed 冻结。
        """
        self._closed = True
        self._seal_branch(set(self._callers), cancelled_by=None)
        for task in self._tasks.values():
            if not task.done() and not task.cancelling():
                task.cancel()

    async def wait_failure(self) -> "SchedulerFailure":
        """等到调度存储失败并返回该错误；供入口及时报告后台发生的失败。"""
        await self._failed.wait()
        return self._closed_error()

    def _closed_error(self) -> RuntimeError:
        if self._failure is not None:
            error = SchedulerFailure("调度存储提交失败，运行已停止")
            error.__cause__ = self._failure
            return error
        return RuntimeError("Worker manager is closed")

    def _durable_snapshots(self) -> list[TaskSnapshot]:
        snapshots = []
        for task_id, agent in self._task_agents.items():
            task = self._tasks.get(task_id)
            if task is not None and task in self._unsettled:
                status, error = "running", None
            else:
                # 状态总取自该 task_id 的当前执行，旧 Task 的回调不会覆盖新一轮。
                status, error = self._status(task_id)
            snapshots.append(TaskSnapshot(
                task_id=task_id,
                agent=agent,
                caller=self._callers.get(task_id),
                stopped=task_id in self._stopped,
                restart_stopped=task_id in self._restart_stopped,
                status=status,
                error=error,
                queues={
                    "feedback": tuple(self._feedback.get(task_id, ())),
                    "inbox": tuple(self._inbox.get(task_id, ())),
                    "inflight": tuple(self._inflight.get(task_id, ())),
                },
            ))
        return snapshots

    def _restore(self, snapshots: list[TaskSnapshot]) -> None:
        """载入重启前的状态；重启前没有结束的执行都已消失，按取消每个根任务处理。

        整个恢复是一次事务：再次启动时已没有 running/waiting，不会重复补发反馈。
        不自动运行任何任务。
        """
        for snapshot in snapshots:
            self._task_agents[snapshot.task_id] = snapshot.agent
            self._callers[snapshot.task_id] = snapshot.caller
            if snapshot.stopped:
                self._stopped.add(snapshot.task_id)
                if snapshot.restart_stopped:
                    self._restart_stopped.add(snapshot.task_id)
            self._restored[snapshot.task_id] = (snapshot.status, snapshot.error)
            for kind, queue in (
                ("feedback", self._feedback),
                ("inbox", self._inbox),
                ("inflight", self._inflight),
            ):
                if snapshot.queues[kind]:
                    queue[snapshot.task_id] = list(snapshot.queues[kind])
        with self._transition():
            for task_id, caller in list(self._callers.items()):
                if caller is None:
                    self._seal_branch(self._descendants(task_id), cancelled_by=None, restart=True)

    @_transitional
    def start(
        self,
        prompt: str,
        task_id: str | None = None,
        *,
        sender_id: str | None = None,
        agent_name: str | None = None,
        attachments: list[ResolvedAttachment] | None = None,
    ) -> dict:
        """接收用户或 Agent 来信；创建者才能恢复已停止的委派。"""
        return self._start(prompt, task_id, sender_id=sender_id, agent_name=agent_name, attachments=attachments)

    def _start(
        self, prompt: str, task_id: str | None = None, *, sender_id: str | None = None,
        agent_name: str | None = None, attachments: list[ResolvedAttachment] | None = None,
        user_resume: bool = False,
    ) -> dict:
        """共享接收机制；普通发送只允许创建者恢复，用户 interrupt 也可恢复指定成员。

        只解除目标屏障，不恢复后代；分支正在清理时拒绝，避免新执行与资源收尾重叠。
        """
        if self._closed:
            raise self._closed_error()
        if not prompt.strip():
            raise ValueError("任务正文不能为空")
        if task_id is None:
            task_id = uuid4().hex
        if not task_id.strip():
            raise ValueError("任务 task_id 不能为空")
        if sender_id is not None and (
            not isinstance(sender_id, str) or not sender_id.strip()
        ):
            raise ValueError("协作消息的发送方 task_id 不能为空")
        target_agent = agent_name or self._task_agents.get(task_id, self._default_agent)
        if self._agent_workers is not None:
            if target_agent not in self._agent_workers:
                raise ValueError(f"未知 Agent: {target_agent}")
            if sender_id is not None:
                if sender_id not in self._task_agents:
                    raise ValueError("未知发送方 task_id")
                sender_agent = self.agent_name(sender_id)
                if sender_agent not in self._agent_workers:
                    raise ValueError(f"发送方 Agent 已删除: {sender_agent}")
                if (
                    task_id not in self._task_agents
                    and target_agent not in self._agent_workers[sender_agent]
                ):
                    raise ValueError(f"{sender_agent} 不能创建 {target_agent}")
        elif target_agent != self._default_agent:
            raise ValueError(f"未知 Agent: {target_agent}")
        if task_id in self._task_agents and self.agent_name(task_id) != target_agent:
            raise ValueError("to 与目标任务绑定的 Agent 不匹配")
        if target_agent in self._retired_agents:
            raise ValueError(f"Agent 正在删除或已删除: {target_agent}")
        if task_id in self._stopped:
            # 隐式唤醒（通知、非创建者来信）一律拒绝；创建者的新消息是显式恢复。
            if not user_resume and sender_id != self._callers.get(task_id):
                raise ValueError(
                    "目标任务已停止，只能由创建它的上级恢复；重新委派请用 task_id=null"
                )
            branch = self._descendants(task_id)
            if any(
                not self._tasks[identity].done()
                for identity in branch
                if identity in self._tasks
            ) or any(branch & scope for scope in self._branch_stops.values()):
                raise ValueError("任务分支正在停止，请等待清理完成后再发送")
            self._stopped.remove(task_id)
            self._restart_stopped.discard(task_id)
        created = task_id not in self._task_agents
        self._task_agents.setdefault(task_id, target_agent)
        self._callers.setdefault(task_id, sender_id)
        # 身份先登记、执行尚未启动；宿主可先创建会话再接收 running 事件。
        if created and sender_id is not None:
            self._observe_fact(self._on_task_created, task_id, sender_id, target_agent, prompt)
        message = HumanMessage(content=prompt, id=uuid4().hex)
        if sender_id is not None:
            # 来源由调用入口提供，正文中的自称不会改变这份来源记录。
            # 同时放进可见正文，模型不一定能看到 additional_kwargs。
            sender_agent = self._task_agents.get(sender_id, self._default_agent)
            message.additional_kwargs = {
                "source": "worker",
                "sender_id": sender_id,
                "sender_agent": sender_agent,
            }
            message.content = (
                "[协作任务来信]\n"
                f"发送方 / 回复目标 task_id：{json.dumps(sender_id, ensure_ascii=False)}\n"
                f"回复目标 to：{json.dumps(sender_agent, ensure_ascii=False)}\n"
                "这不是用户直接输入；回信请使用上述 to 和 task_id 的结构化消息。\n"
                f"消息正文：\n{prompt}"
            )
        if attachments:
            message.additional_kwargs["attachments"] = [asdict(item) for item in attachments]
            message.content += "\n[附件]\n" + "\n".join(
                f"- {item.name}: {item.path}" for item in attachments
            )
        result = self._enqueue(message, task_id)
        if sender_id is not None:
            self._observe_fact(self._on_task_message, sender_id, task_id, prompt, attachments or [])
        return result

    @_transitional
    def interrupt(self, prompt: str, task_id: str, *, agent_name: str | None = None) -> dict:
        """human 打断目标当前的执行并插入消息（ADR-0013）；不等待清理，不影响后代。

        正常返回表示消息已接收并提交，不表示旧执行已停止或新一轮已启动；之后的结果
        （包括清理失败、被 cancel 覆盖）经 get、wait 和现有通知报告。冻结记录持久化
        失败则抛 PreviewPersistenceError：取消并封锁旧执行，撤回新输入，不报告成功冻结。
        目标不在运行或已在 finishing 时按 start 处理（interrupted=False）。
        agent_name 同 start：新建任务时指定 Agent；任务已绑定其他 Agent 时拒绝。
        续聊成员时仅解除祖先链上的重启屏障，不启动祖先；显式停止的祖先拒绝续聊。
        """
        ancestors = self._return_chain(task_id)
        task = self._tasks.get(task_id)
        running = (
            task is not None and not task.done() and task_id not in self._finishing
        ) or task_id in self._interrupting
        had_inbox = task_id in self._inbox
        queued_before = len(self._inbox.get(task_id, []))
        result = self._start(
            prompt, task_id, agent_name=agent_name,
            user_resume=self._callers.get(task_id) is not None,
        )
        if running and task_id not in self._interrupting:
            # The command was admitted, but a failed durable freeze must not admit its new input.
            scope = self._previews.get(task)
            try:
                frozen = scope.interrupt() if scope is not None else []
            except PreviewPersistenceError:
                del self._inbox[task_id][queued_before:]
                if not had_inbox:
                    self._inbox.pop(task_id, None)
                self._stopped.add(task_id)
                task.cancel()
                raise
            self._feedback.setdefault(task_id, []).append(runtime_message({
                "interrupted": True,
                "note": "上一轮执行被用户打断；未完成的模型响应没有作为正式 AI 输出接受。"
                + ("以下 human 预览曾发布给用户并冻结为已中断记录，不代表用户已阅读；"
                   if frozen else "没有需要冻结的已发布 human 预览；")
                + "进行中的工具调用已取消，已发生的外部操作不会撤销。以之后的新消息为准。",
                "frozen_previews": frozen,
            }))
            self._interrupting[task_id] = task
            task.cancel()
        # 消息和冻结都已接收才开放回报通道；这一步不消费祖先队列，也不启动执行。
        self._stopped.difference_update(ancestors)
        self._restart_stopped.difference_update(ancestors)
        return {**result, "interrupted": running}

    def _return_chain(self, task_id: str) -> list[str]:
        """插话的回报链必须能接收结果；仅重启屏障可随该明确用户意图解除。"""
        ancestors = []
        seen = {task_id}
        parent = self._callers.get(task_id)
        while parent is not None:
            if parent in seen or parent not in self._task_agents:
                raise CollaborationStopped("协作创建链不完整，无法继续")
            seen.add(parent)
            agent = self._task_agents[parent]
            if agent in self._retired_agents or (
                self._agent_workers is not None and agent not in self._agent_workers
            ):
                raise CollaborationStopped("创建者 Agent 已不可用，无法接收协作结果")
            if parent in self._stopped and parent not in self._restart_stopped:
                raise CollaborationStopped("上级分支已被明确停止，请先从该上级会话恢复")
            if parent in self._restart_stopped:
                ancestors.append(parent)
            parent = self._callers[parent]
        return ancestors

    def has_task(self, task_id: str) -> bool:
        """任务身份是否已登记，包括已结束和重启恢复的任务。"""
        return task_id in self._task_agents

    def task_identity(self, task_id: str) -> tuple[str, str | None] | None:
        """返回不可变的 (Agent, 创建者任务) 绑定；未知身份不回落到默认 Agent。"""
        if task_id not in self._task_agents:
            return None
        return self._task_agents[task_id], self._callers[task_id]

    def agent_name(self, task_id: str) -> str:
        """返回创建时绑定的 Agent，后续来信不改变绑定。"""
        return self._task_agents[task_id]

    def root_of(self, task_id: str) -> str:
        """沿创建关系找到根任务（由用户启动的那个）；未登记的 ID 视为根。"""
        while (caller := self._callers.get(task_id)) is not None:
            task_id = caller
        return task_id

    def _enqueue(self, message: HumanMessage, task_id: str) -> dict:
        agent = self._task_agents[task_id]
        if agent in self._retired_agents or (
            self._agent_workers is not None and agent not in self._agent_workers
        ):
            # 完成通知和后台执行反馈绕过 start；保留事实，但不能恢复已删除角色。
            self._feedback.setdefault(task_id, []).append(message)
            return {**self.get(task_id), "queued": True}
        task = self._tasks.get(task_id)
        self._inbox.setdefault(task_id, []).append(message)
        if (task is not None and not task.done()) or task_id in self._interrupting:
            # 保留原 Task，仅追加消息；不对同一线程并发调用 ainvoke。
            # 被打断的执行即使已结束，也由它的 done 回调续轮，其他来信不能抢先启动。
            return {"task_id": task_id, "status": "running", "queued": True}
        return self._launch(task_id)

    def _launch(self, task_id: str) -> dict:
        """领取全部待处理输入并启动新一轮；普通启动与打断续轮共用。"""
        previous = self._tasks.get(task_id)
        if previous is not None and previous.done():
            # done 回调排在事件循环队列里；先结算旧执行，不能让新轮次遮蔽其终态。
            self._on_task_done(task_id, previous)
        # 取消/失败可能发生在取队列之后；在途消息排在队列之前，保持到达顺序。
        # 其中已落盘的消息由 run 回调根据固定 ID 排除，不能重新追加。
        self._inbox[task_id] = [
            *self._inflight.pop(task_id, []),
            *self._inbox.get(task_id, []),
        ]
        # 同步确定首批输入；此后收到的消息进入队列。
        # 队列由 before_model 轮内注入，或在正常结束后自动续轮处理。
        prompts = self.take_messages(task_id)
        # create_task 调度后台执行；这里没有 await 子 Agent 的结果。
        # 重启后 _tasks 为空也允许传旧 ID；run 回调负责读取持久化历史。
        # name 便于调试；空 Context 避免继承父图的隐式运行配置。
        preview = PreviewExecution(task_id, self._on_preview) if self._on_preview is not None else None
        task = asyncio.create_task(
            self._run_until_idle(prompts, task_id, preview),
            name=f"worker:{task_id}",
            context=Context(),
        )
        self._tasks[task_id] = task
        if preview is not None:
            self._previews[task] = preview
        self._restored.pop(task_id, None)
        self._unsettled.add(task)
        task.add_done_callback(
            lambda finished: self._on_task_done(task_id, finished)
        )
        self._observe(task_id, "running", None)
        return {"task_id": task_id, "status": "running"}

    @staticmethod
    def _observe_fact(callback: Callable | None, *args) -> None:
        """事实观察失败不改写已接受的调度；宿主负责将持久化失败升级为停服。"""
        if callback is None:
            return
        try:
            callback(*args)
        except Exception as exception:
            asyncio.get_running_loop().call_exception_handler({
                "message": "协作事实观察者出错", "exception": exception,
            })

    def _observe(self, task_id: str, status: str, error: str | None) -> None:
        """通知生命周期观察者；观察者出错只报告给事件循环，不能打断调度或提交。"""
        if self._on_task is None:
            return
        try:
            self._on_task(task_id, status, error)
        except Exception as exception:
            asyncio.get_running_loop().call_exception_handler({
                "message": f"任务生命周期观察者出错：{task_id} {status}",
                "exception": exception,
            })

    async def _run_until_idle(
        self, prompts: list[HumanMessage], task_id: str, preview: PreviewExecution | None = None,
    ) -> AgentOutput | str:
        """同一个 Task 连续执行，直到正常结束且没有待处理消息。"""
        token = current_preview.set(preview)
        try:
            while True:
                # 错误或取消直接向外传播，不消费剩余队列，也不自动重试。
                try:
                    result = await self._run(prompts, task_id)
                finally:
                    self._finishing.discard(task_id)
                # 即使底层吞掉了 CancelledError，也不能因 pending 再开一轮。
                if self._closed or asyncio.current_task().cancelling():
                    raise asyncio.CancelledError()
                with self._transition():
                    # run 正常返回意味着本轮输入和中间件消息已保存，可以确认出队。
                    self._inflight.pop(task_id, None)
                    # 成功回执留待下次模型调用，不单独触发续轮。
                    if not self._inbox.get(task_id):
                        return result
                    prompts = self.take_messages(task_id)
                    # 本轮已没有 before_model：将剩余消息作为下一轮的完整输入。
                    # 取队列到返回之间没有 await，避免漏掉完成边界上的新消息。
        finally:
            if preview is not None:
                preview.close()
            current_preview.reset(token)

    def finish_model_loop(self, task_id: str) -> None:
        """标记图内不再调用模型/工具；仍须等 run 返回才能确认本轮完成。"""
        self._finishing.add(task_id)

    @_transitional
    def take_messages(self, task_id: str) -> list[HumanMessage]:
        """领取一批消息，保留未确认副本；取消/失败后的下一次 start 可以找回。

        目标被打断期间，旧执行（可能吞掉了取消）不能取走留给新一轮的消息，按取消处理。
        """
        if task_id in self._interrupting:
            raise asyncio.CancelledError()
        feedback = self._feedback.pop(task_id, [])
        messages = [*feedback, *self._inbox.pop(task_id, [])]
        if messages:
            self._inflight.setdefault(task_id, []).extend(messages)
        return messages

    async def prepare_attachments(self, output: AgentOutput, sender_id: str) -> list[_PreparedDelivery]:
        """Preflight remote paths; deferred paths use the same dispatch resolver as direct calls."""
        prepared = []
        for message in output.messages:
            resolution = (
                await self._attachment_preflight(sender_id, message.to, message.attachments)
                if message.attachments and self._attachment_preflight is not None
                else None
            )
            prepared.append(_PreparedDelivery(
                message.to, message.task_id, tuple(message.attachments), resolution,
            ))
        return prepared

    @_transitional
    def dispatch(
        self, output: AgentOutput, sender_id: str, response_id: str | None = None,
        *, prepared: list[_PreparedDelivery] | None = None,
        draft_ids: list[str | None] | None = None,
    ) -> list[dict]:
        """顺序投递并保存回执；human 无观察者时拒绝，不等待收件方完成。

        回执覆盖整批消息，与投递在同一事务中提交。参数校验失败是明确拒绝（accepted=False）；
        human 接收方调用出错时结果未知（accepted=None，可能已经显示），同批其他消息照常投递。
        其他意外异常中断投递时，中断处那条结果未知，之后的消息未处理，再向上抛出异常。
        只要有消息被接收，就一定有回执。回执记下来源响应 ID，续聊时据此判断该响应是否被接收（ADR-0009）。
        """
        if self._closed or sender_id in self._stopped or sender_id in self._interrupting:
            # 下层吞掉取消后仍可能走到这里；按取消结束本次执行，不投递（包括 human）
            # 也不留下回执，否则失败回执会让模型继续调用，并在恢复时注入过期内容。
            raise asyncio.CancelledError()
        receipts = [
            {"to": m.to, "task_id": m.task_id, "attachments": []}
            for m in output.messages
        ]
        try:
            for index, (message, receipt) in enumerate(zip(output.messages, receipts)):
                try:
                    if message.to == "human":
                        if message.task_id is not None:
                            raise ValueError(
                                "当前只有一个用户入口，发给 human 时 task_id 必须为 null"
                            )
                        if self._on_human is None:
                            raise ValueError("没有 human 消息接收方")
                    elif message.task_id is not None and message.task_id not in self._callers:
                        raise ValueError("未知 task_id；创建新任务请使用 null")
                    attachments: list[ResolvedAttachment] = []
                    resolution = None
                    if message.attachments and prepared is not None:
                        preflight = prepared[index]
                        if (preflight.to, preflight.task_id, preflight.paths) != (
                            message.to, message.task_id, tuple(message.attachments),
                        ):
                            raise ValueError("附件预检与投递消息不匹配")
                        resolution = preflight.resolution
                    if message.attachments:
                        if resolution is not None:
                            attachments, path_receipts = resolution
                            receipt["attachments"] = [item.copy() for item in path_receipts]
                        elif self._attachment_resolver is None:
                            receipt["attachments"] = [
                                {"path": path, "accepted": False, "error": "未配置附件解析器"}
                                for path in message.attachments
                            ]
                        else:
                            attachments, receipt["attachments"] = self._attachment_resolver(
                                sender_id, message.to, message.attachments
                            )
                    # Image references must use attachments accepted by the resolver.
                    if message.to == "human" and self._validate_human is not None:
                        rejection = self._validate_human(sender_id, message.message, attachments)
                        if rejection is not None:
                            raise ValueError(rejection)
                    if message.to == "human":
                        try:
                            self._on_human(sender_id, message.message, attachments, draft_ids[index] if draft_ids else None)
                        except Exception as error:
                            # 外部接收方可能已提交消息及附件；不能把结果报成明确拒绝并重发。
                            receipt.update(
                                accepted=None,
                                error="human 接收方调用异常，可能已经显示给用户："
                                f"{type(error).__name__}: {error}",
                            )
                            for item in receipt["attachments"]:
                                if item["accepted"]:
                                    item["accepted"] = None
                                    item["error"] = "接收方调用异常，登记结果未知"
                            continue
                    else:
                        receipt.update(
                            self.start(
                                message.message,
                                message.task_id,
                                sender_id=sender_id,
                                agent_name=message.to,
                                attachments=attachments,
                            )
                        )
                    receipt["accepted"] = True
                except ValueError as error:
                    receipt.update(accepted=False, error=str(error))
                    for item in receipt["attachments"]:
                        if item["accepted"]:
                            item.update(accepted=False, error="消息未投递")
                finally:
                    if message.to == "human" and draft_ids and draft_ids[index]:
                        scope = current_preview.get()
                        if scope is not None:
                            scope.end([draft_ids[index]])
        except BaseException as error:
            pending = [r for r in receipts if "accepted" not in r]
            if pending:
                # 异常发生在这条消息的投递调用中，调用可能已部分生效，不能断言它未被接收。
                pending[0].update(
                    accepted=None,
                    error=f"投递调用异常，结果未知：{type(error).__name__}: {error}",
                )
                for receipt in pending[1:]:
                    receipt.update(accepted=False, error="前面的投递异常中断，未处理")
            raise
        finally:
            if receipts:
                self._feedback.setdefault(sender_id, []).append(
                    runtime_message({"deliveries": receipts}, receipt_for=response_id)
                )
        return receipts

    def _notify_completion(
        self,
        task_id: str,
        status: str,
        *,
        error: str | None = None,
        cancelled_by: str | None = None,
    ) -> None:
        if self._closed:
            return  # 关闭或存储失败时不通过通知重新启动其他任务。
        caller = self._callers[task_id]
        data = {
            "task_id": task_id,
            "agent": self._task_agents[task_id],
            "status": status,
        }
        if error is not None:
            data["error"] = error
        if caller in self._stopped:
            # 创建者随上级一起停止：只保存反馈，不唤醒；由上级恢复它时随新消息注入。
            # 反馈只写事实，不写停止者；如何处理由新消息决定（见角色提示词）。
            if status == "cancelled":
                data["cause"] = "stopped_with_parent"
            self._feedback.setdefault(caller, []).append(runtime_message(data))
            return
        if status == "cancelled" and caller == cancelled_by:
            return  # 取消者已经获得结果。
        if caller is None and (self._on_human is None or not self._notify_human_of_roots):
            return
        message = runtime_message(data)
        if caller is None:
            self._on_human(task_id, message.content, [], None)
        else:
            self._callers.setdefault(caller, None)
            self._task_agents.setdefault(caller, self._default_agent)
            self._enqueue(message, caller)

    def _on_task_done(self, task_id: str, task: asyncio.Task) -> None:
        """结算一次执行：终态与发给创建者的通知或反馈在同一事务中提交。

        旧 Task 的回调可能晚于同一 task_id 的新 Task 创建；通知照常结算，
        持久化状态取自当前执行，不会被旧结果覆盖。
        只有被打断的这一次执行以取消结束、且之后没有被关闭或 cancel 覆盖时，才不通知并续轮；
        其余情况（含清理异常）按原规则结算（ADR-0013）。
        """
        if task not in self._unsettled:
            return
        self._unsettled.discard(task)
        scope = self._previews.pop(task, None)
        if scope is not None:
            scope.close()
        cancelled_by = self._cancelled_by.pop(task, None)
        interrupted = self._interrupting.get(task_id) is task
        if interrupted:
            del self._interrupting[task_id]
        earlier_failure = self._failure
        try:
            with self._transition():
                if (
                    interrupted
                    and task.cancelled()
                    and not self._closed
                    and task_id not in self._stopped
                ):
                    self._launch(task_id)
                elif task.cancelled():
                    self._notify_completion(
                        task_id, "cancelled", cancelled_by=cancelled_by
                    )
                elif (error := task.exception()) is not None:
                    self._notify_completion(
                        task_id, "failed", error=f"{type(error).__name__}: {error}"
                    )
        except Exception:
            if self._failure is None or earlier_failure is not None:
                raise  # 不是本次提交造成的存储失败
            # 存储失败已停止调度并取消 Worker，由 close 报告；
            # 在回调里抛出只会进入事件循环的异常处理器。
        finally:
            # 只报告仍是当前执行的结算；已被续轮或新执行取代时，新执行已报告 running。
            if self._tasks.get(task_id) is task:
                self._observe(task_id, *self._status(task_id))

    def _status(self, task_id: str) -> tuple[str, str | None]:
        """对外状态和失败原因；没有 Task 的已恢复任务使用重启前保存的状态。"""
        task = self._tasks.get(task_id)
        if task is None:
            if task_id not in self._restored:
                return "not_found", None
            status, error = self._restored[task_id]
        elif not task.done() or self._interrupting.get(task_id) is task:
            # 被打断的执行结束后、done 回调结算前，按仍在运行报告。
            return "running", None
        elif task.cancelled():
            return "cancelled", None
        elif (exception := task.exception()) is not None:
            return "failed", f"{type(exception).__name__}: {exception}"
        else:
            result = task.result()
            status = (
                "waiting"
                if isinstance(result, AgentOutput) and result.next == "wait"
                else "completed"
            )
            error = None
        if status == "waiting" and task_id in self._stopped:
            return "cancelled", None
        return status, error

    def get(self, task_id: str) -> dict:
        """查询状态；重启后恢复的任务只有 status/error，结果需从检查点读取。"""
        status, error = self._status(task_id)
        state = {"task_id": task_id, "status": status}
        if error is not None:
            state["error"] = error
        task = self._tasks.get(task_id)
        if task is not None and status in {"waiting", "completed"}:
            result = task.result()
            state["result"] = (
                result.model_dump() if isinstance(result, AgentOutput) else result
            )
        return state

    def snapshot(self) -> dict:
        """返回任务与消息队列的状态快照，不暴露 asyncio Task 句柄。"""
        known = [*self._tasks, *(item for item in self._restored if item not in self._tasks)]
        tasks = {task_id: self.get(task_id) for task_id in known}
        return {
            "closed": self._closed,
            "failure": None
            if self._failure is None
            else f"{type(self._failure).__name__}: {self._failure}",
            "tasks": tasks,
            "running": sorted(
                task_id
                for task_id, state in tasks.items()
                if state["status"] == "running"
            ),
            "finishing": sorted(
                task_id
                for task_id in self._finishing
                if tasks[task_id]["status"] == "running" and not self._inbox.get(task_id)
            ),
            "waiting": sorted(
                task_id
                for task_id, state in tasks.items()
                if state["status"] == "waiting"
            ),
            # 只列出能推进的积压：已停止任务保留的输入要等创建者恢复，不算当前工作。
            "queued": sorted(
                task_id
                for task_id, items in self._inbox.items()
                if items and task_id not in self._stopped
            ),
            "inflight": sorted(
                task_id
                for task_id, items in self._inflight.items()
                if items and task_id not in self._stopped
            ),
        }

    async def wait(self, task_id: str) -> dict:
        """等待本次连续执行结束（含自动续轮与打断后的续轮）；等待者取消不等于取消 Worker。

        _settled 保证 done 回调已执行，续轮的新 Task 此时已经登记，等待随之继续。
        """
        awaited = None
        while (task := self._tasks.get(task_id)) is not None and task is not awaited:
            awaited = task
            await _settled([task])
        return self.get(task_id)

    def _descendants(self, task_id: str) -> set[str]:
        """包含目标及已结束的中间节点；创建关系是唯一归属来源。"""
        if task_id not in self._callers:
            return set()
        children: dict[str, list[str]] = {}
        for child, parent in self._callers.items():
            if parent is not None:
                children.setdefault(parent, []).append(child)
        scope = set()
        pending = [task_id]
        while pending:
            identity = pending.pop()
            if identity not in scope:
                scope.add(identity)
                pending.extend(children.get(identity, ()))
        return scope

    def branch_threads(self, root: str) -> set[str]:
        """目标任务及所有后代 thread_id；空对话仍返回目标 ID，供停止统计和删除清理。"""
        return self._descendants(root) | {root}

    def forget_stopped_root(self, root: str) -> None:
        """只遗忘已停止且清理完成的根分支；调度快照在同一次转换提交。

        调用方必须先停止并确认 shell 清理，再删除该分支检查点。重复调用在重启续删时安全。
        """
        if self._closed:
            raise self._closed_error()
        if root not in self._callers:
            return
        if self._callers[root] is not None:
            raise ValueError("只能遗忘根任务")
        scope = self._descendants(root)
        if not scope <= self._stopped or self._running(scope) or any(
            scope & pending for operation, pending in self._branch_stops.items() if not operation.done()
        ):
            raise ValueError("任务分支尚未完成停止与清理")
        with self._transition():
            for identity in scope:
                self._task_agents.pop(identity, None)
                self._callers.pop(identity, None)
                self._feedback.pop(identity, None)
                self._finishing.discard(identity)
                self._stopped.discard(identity)
                self._restart_stopped.discard(identity)
                self._tasks.pop(identity, None)
                self._inbox.pop(identity, None)
                self._inflight.pop(identity, None)
                self._interrupting.pop(identity, None)
                self._restored.pop(identity, None)

    async def cancel(self, task_id: str, *, cancelled_by: str | None = None) -> dict:
        """停止目标及全部后代，保留历史和未处理输入；重复调用安全。

        正常返回才保证范围内执行清理完毕；单 Worker 通知不作此保证。
        stopped 是本次设置屏障的范围，不代表已完成/失败的历史被改写。
        取消等待者不会再次打断 Worker 清理，屏障保留至创建者显式恢复。
        范围内被中断的子任务给创建者留下状态反馈；创建者也已停止时只保存不唤醒。
        """
        if self._agent_workers is not None and cancelled_by is not None:
            if (
                cancelled_by not in self._task_agents
                or self._callers.get(task_id) != cancelled_by
            ):
                return {
                    "task_id": task_id,
                    "accepted": False,
                    "reason": "只能取消自己创建的直接子任务",
                }
        scope = self._descendants(task_id)
        running = self._running(scope)
        if asyncio.current_task() in running:
            return {
                "task_id": task_id,
                "accepted": False,
                "reason": "不能取消包含当前执行自身的任务分支",
            }
        stopping = self._stop_scope(scope, running, cancelled_by, name=f"stop-branch:{task_id}")
        # 等待者被取消只结束等待；停止操作由 Manager 持有，继续完成。
        unconfirmed = await asyncio.shield(stopping)
        result = {**self.get(task_id), "stopped": sorted(scope)}
        if unconfirmed:
            result["cleanup_unconfirmed"] = unconfirmed
        return result

    def _running(self, scope: set[str]) -> list[asyncio.Task]:
        """范围内仍需等待结算的执行。

        被打断的执行结束后、done 回调结算前仍算在内：要登记取消者并等它结算完再返回。
        """
        return [
            self._tasks[identity]
            for identity in scope
            if identity in self._tasks
            and (
                not self._tasks[identity].done()
                or self._interrupting.get(identity) is self._tasks[identity]
            )
        ]

    def _stop_scope(
        self,
        scope: set[str],
        running: list[asyncio.Task],
        cancelled_by: str | None,
        *,
        name: str,
    ) -> asyncio.Task:
        """Seal the branch, cancel Workers and immediately revoke task-scoped resources."""
        with self._transition():
            self._seal_branch(scope, cancelled_by)
        immediate = [asyncio.create_task(hook(scope)) for hook in self._cancel_hooks]
        for task in running:
            # 重复取消不再注入 CancelledError，允许任务完成清理。
            # 正在被打断的执行也已在取消中，仍要记下取消者，cancel 覆盖打断后照常结算通知。
            self._cancelled_by.setdefault(task, cancelled_by)
            if not task.cancelling():
                task.cancel()
        stopping = asyncio.create_task(self._stop_branch(running, scope, immediate), name=name)
        self._branch_stops[stopping] = scope
        stopping.add_done_callback(self._branch_stopped)
        return stopping

    async def _stop_branch(
        self, running: list[asyncio.Task], scope: set[str], immediate: list[asyncio.Task],
    ) -> list[str]:
        """Wait for revoked leases and Worker/process cleanup before confirming stop."""
        revoked = await asyncio.gather(*immediate, return_exceptions=True)
        await _settled(running)
        reports = await asyncio.gather(*(hook(scope) for hook in self._stop_hooks))
        for result in revoked:
            if isinstance(result, BaseException):
                raise result
        return [item for report in reports for item in report]

    def _branch_stopped(self, stopping: asyncio.Task) -> None:
        del self._branch_stops[stopping]
        if not stopping.cancelled():
            stopping.exception()  # 等待者可能已离开；失败由仍在等待的 cancel 调用方报告

    def add_stop_hook(self, hook: Callable[[set[str]], Awaitable[list[str]]]) -> None:
        """Stop commands after Workers settle and report unconfirmed cleanup."""
        self._stop_hooks.append(hook)

    def add_cancel_hook(self, hook: Callable[[set[str]], Awaitable[None]]) -> None:
        """Revoke task-scoped access as soon as a branch is sealed."""
        self._cancel_hooks.append(hook)

    def ensure_active(self, task_id: str) -> None:
        """后台执行只能由仍在运行的任务启动；关闭、已停止或正被打断的旧执行按取消处理（同 dispatch）。"""
        if self._closed or task_id in self._stopped or task_id in self._interrupting:
            raise asyncio.CancelledError()

    @_transitional
    def notify(self, task_id: str, data: dict, *, interrupt: bool = False) -> None:
        """Deliver runtime feedback to its owner; optionally interrupt only its current execution.

        The interrupted execution resumes on the same task identity after cleanup;
        descendants and unrelated tasks are not stopped. Idle owners are woken.
        """
        if self._closed or task_id not in self._task_agents:
            return
        message = runtime_message(data)
        if task_id in self._stopped:
            self._feedback.setdefault(task_id, []).append(message)
            return
        task = self._tasks.get(task_id)
        running = task is not None and not task.done() and task_id not in self._finishing
        self._enqueue(message, task_id)
        if interrupt and running and task_id not in self._interrupting:
            scope = self._previews.get(task)
            if scope is not None:
                # Runtime notifications interrupt model work, not the user's chat turn.
                scope.close()
            self._interrupting[task_id] = task
            task.cancel()

    @_transitional
    def add_feedback(self, task_id: str, data: dict) -> None:
        """追加运行时反馈，随下一批输入交给模型；不唤醒任务。"""
        if not self._closed:
            self._feedback.setdefault(task_id, []).append(runtime_message(data))

    def is_stopped(self, task_id: str) -> bool:
        return self._closed or task_id in self._stopped

    def _seal_branch(self, scope: set[str], cancelled_by: str | None, *, restart: bool = False) -> None:
        """为范围设置停止屏障，并结算已没有执行可回调的中断任务。

        waiting 任务的 Task 早已结束；重启后恢复的 running 任务已没有 Task。
        二者都在这里补发取消反馈；运行中的任务由 done 回调结算。
        """
        interrupted = []
        for identity in sorted(scope):
            status, _ = self._status(identity)
            if status == "waiting" or (status == "running" and identity not in self._tasks):
                interrupted.append(identity)
        for identity in scope:
            task = self._tasks.get(identity)
            preview = self._previews.get(task)
            if preview is not None:
                preview.close()
        if restart:
            self._restart_stopped.update(scope - self._stopped)
        else:
            self._restart_stopped.difference_update(scope)
        self._stopped.update(scope)
        for identity in interrupted:
            if identity in self._tasks:
                # 已返回 wait 但回调尚未执行的 Task 在此结算：终态（cancelled）与反馈
                # 同一事务提交；之后的回调不会再通知，也不会被记为 running 而在重启时重复补发。
                self._unsettled.discard(self._tasks[identity])
            else:
                self._restored[identity] = ("cancelled", None)
            self._notify_completion(identity, "cancelled", cancelled_by=cancelled_by)
            self._observe(identity, "cancelled", None)

    async def close(self) -> None:
        """停止调度、取消 Worker 并等待清理；调度存储从此冻结，交给下次启动恢复。"""
        self._stop_accepting()
        await asyncio.gather(
            *self._tasks.values(), *self._branch_stops, return_exceptions=True
        )
        if self._failure is not None:
            raise self._closed_error()


class CommunicationMiddleware(AgentMiddleware):
    """持有子任务取消工具；完整响应后投递通信，模型调用前注入回执和来信。"""

    def __init__(self, manager: WorkerManager):
        super().__init__()
        self._manager = manager
        self.tools = worker_tools(manager)

    async def abefore_model(self, state, runtime):
        task_id = runtime.context["task_id"]
        pending = self._manager.take_messages(task_id)
        if not pending:
            return None
        # 返回增量，让框架合并消息；不修改整份历史。
        return {"messages": pending}

    @hook_config(can_jump_to=["model"])
    async def aafter_model(self, state, runtime):
        response = state["messages"][-1]
        if not isinstance(response, AIMessage):
            return None
        raw_output = response.additional_kwargs.get("wandrun_agent_output")
        if raw_output is None:
            return None  # 纯工具响应或不使用结构化通信的最小循环实验。
        output = AgentOutput.model_validate(raw_output)
        prepared = (
            await self._manager.prepare_attachments(output, runtime.context["task_id"])
            if any(message.attachments for message in output.messages) else None
        )
        draft_ids = response.additional_kwargs.get("wandrun_draft_ids")
        receipts = self._manager.dispatch(
            output, runtime.context["task_id"], response.id, prepared=prepared,
            draft_ids=draft_ids,
        )
        if response.tool_calls:
            return None
        if output.next == "continue" or any(
            receipt["accepted"] is not True
            or any(item["accepted"] is False for item in receipt["attachments"])
            for receipt in receipts
        ):
            return {"jump_to": "model"}
        self._manager.finish_model_loop(runtime.context["task_id"])
        return None


def worker_tools(manager: WorkerManager) -> list:
    @tool
    async def cancel_worker(task_id: str, config: RunnableConfig) -> dict:
        """取消自己创建的直接子任务及其全部后代，等待清理；之后可向原 task_id 发消息恢复它。"""
        current_id = config.get("configurable", {}).get("thread_id")
        if not isinstance(current_id, str) or not current_id.strip():
            raise ValueError("取消工具需要调用方的 thread_id")
        if current_id == task_id:
            return {
                "task_id": task_id,
                "accepted": False,
                "reason": "不能通过工具等待取消当前对话自身。",
            }
        return await manager.cancel(task_id, cancelled_by=current_id)

    return [cancel_worker]
