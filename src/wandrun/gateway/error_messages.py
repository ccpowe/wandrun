"""将运行时和配置校验诊断投影为安全的网关展示文案，不改变原始异常。"""

import re


_TASK_FAILURE = "任务执行失败，请重试；若持续失败，请查看网关日志。"


def task_failure(error: str | None) -> str:
    """只按明确的异常类别或服务错误码分类，不回显不可信的异常正文。"""
    if not error:
        return _TASK_FAILURE
    kind, _, detail = error.partition(": ")
    lower = detail.lower()
    if kind in {"ContextBudgetExhausted", "ContextWindowExceededError", "ContextWindowExceeded"} or (
        kind in {"BadRequestError", "InvalidRequestError"}
        and any(marker in lower for marker in ("context_length_exceeded", "context window", "maximum context length"))
    ):
        return "上下文长度超过模型限制，请缩短输入或拆分任务后重试。"
    status = None
    if kind == "CodexSubscriptionHTTPError":
        match = re.match(r"订阅请求 HTTP (\d{3})：", detail)
        if match:
            status = int(match[1])
    elif kind in {"APIStatusError", "HTTPStatusError"}:
        match = re.search(r"(?:error code:|status(?: code)?[: =]|client error ['\"])\s*(\d{3})\b", lower)
        if match:
            status = int(match[1])
    if kind in {"TimeoutError", "APITimeoutError", "ConnectTimeout", "ReadTimeout", "WriteTimeout", "PoolTimeout", "TimeoutException", "ModelTimeoutError"} or status in {408, 504}:
        return "请求超时，请稍后重试。"
    if kind in {"ConnectionError", "APIConnectionError", "ConnectError", "NetworkError", "RemoteProtocolError", "ClientConnectorError", "URLError", "ReadError", "WriteError", "ProxyError"}:
        return "网络连接失败，请检查网络后重试。"
    if kind in {"AuthenticationError", "AuthenticationFailed", "UnauthorizedError", "PermissionDeniedError"} or status in {401, 403}:
        return "模型服务认证或访问权限不足，请检查登录状态和凭据后重试。"
    if kind in {"RateLimitError", "QuotaExceededError"} or status == 429:
        return "模型服务额度或速率已达限制，请检查额度或稍后重试。"
    if status is not None and status >= 500:
        return "模型服务暂不可用，请稍后重试。"
    if kind == "CodexSubscriptionStreamError":
        return "模型响应中断，请检查网络后重试。"
    return _TASK_FAILURE


def compaction_failure(kind: str | None, detail: str | None) -> str:
    reasons = {
        "PermissionError": "无法保存上下文留档，请检查文件权限后重试。",
        "FileNotFoundError": "上下文留档目录不可用，请检查执行环境后重试。",
        "OSError": "无法保存上下文留档，请检查存储空间和文件权限后重试。",
        "SummaryGenerationError": "摘要生成失败，请重试；若持续失败，请检查摘要模型配置。",
        "ContextBudgetExhausted": "无法在当前窗口内保留必要上下文，请增大窗口或缩短输入后重试。",
        "CancelledError": "压缩已中断，下次继续时会重新尝试。",
        "GraphInterrupt": "压缩已中断，下次继续时会重新尝试。",
    }
    if kind in reasons:
        return reasons[kind]
    message = task_failure(f"{kind}: {detail}")
    return message if message != _TASK_FAILURE else "上下文压缩失败，请重试；若持续失败，请查看网关日志。"


_AGENT_LABELS = {
    "name": "名称", "description": "说明", "system_prompt": "提示词", "model": "模型",
    "reasoning_effort": "推理强度", "context_window": "上下文窗口", "compaction_keep_tokens": "压缩保留 token 数",
    "compaction_model": "压缩模型", "code_mode": "代码模式", "workers": "成员",
    "mcp_servers": "连接器", "searchable_mcp_servers": "按需搜索连接器", "skills": "技能",
    "environment": "执行环境", "avatar": "头像",
}


def agent_validation(error: ValueError) -> str:
    """配置文件沿用原文；仅网关 Agent 编辑错误进行字段投影。"""
    message = str(error)
    match = re.fullmatch(r"agents\.([A-Za-z0-9_-]+)\.([a-z_]+)(?:\[\d+\])? (.*)", message)
    if match:
        _, field, reason = match.groups()
        label = _AGENT_LABELS.get(field)
        if label is not None:
            if reason.startswith("只能是 skills 目录下的名称"):
                return "技能只能选择技能目录中的名称，不能填写路径。"
            if reason.startswith("不能包含自己"):
                return "成员不能选择当前 Agent。"
            safe_reasons = {
                "必须是非空字符串": "必须填写",
                "不能包含首尾空白": "不能包含首尾空白",
                "只能占一行，最多 64 字": "只能占一行，最多 64 字",
                "必须是正整数": "必须是正整数",
                "必须是布尔值": "必须是布尔值",
                "必须是字符串数组": "必须是名称列表",
                "不能重复": "不能重复",
                "无效": "无效",
            }
            if reason in safe_reasons:
                return f"{label}{safe_reasons[reason]}"
            if field == "environment" and reason.startswith("引用了未知环境"):
                return "所选执行环境不存在，请重新选择。"
            if field == "searchable_mcp_servers":
                if reason.startswith("与 mcp_servers 重复"):
                    return "按需搜索连接器不能同时作为普通连接器使用。"
                if reason.startswith("的服务名不能包含点号"):
                    return "按需搜索连接器名称不能包含点号。"
    if message.startswith("可搜索服务 mcp_servers.") and message.endswith(" 需要 description"):
        return "所选按需搜索连接器缺少说明，请先补充连接器说明。"
    if message.startswith("Agent ") and " 的成员不存在：" in message:
        return "所选成员不存在，请重新选择。"
    if message.startswith("Agent ") and (" 所选的连接器不存在：" in message or " 按需搜索的连接器不存在：" in message):
        return "所选连接器不存在，请重新选择。"
    return "Agent 配置无效，请检查字段和引用后重试；若持续失败，请查看网关日志。"


def connector_validation(error: ValueError) -> str:
    """连接器配置中的内部 id 与可能含凭据的值不进入响应。"""
    message = str(error)
    if message.startswith("连接器 name "):
        reason = message.removeprefix("连接器 name ")
        if reason.startswith(("必须是", "不能包含首尾空白", "只能占一行")):
            return f"连接器名称{reason}"
    if message == "连接器 description 必须是字符串":
        return "连接器说明必须是文字。"
    if message == "Invalid IPv6 URL":
        return "连接器地址无效，请输入不包含凭据的 HTTP(S) 地址。"
    match = re.fullmatch(r"mcp_servers\.[^. ]+(?:\.([a-z_]+))? (.*)", message)
    if match:
        field, reason = match.groups()
        label = {"url": "地址", "transport": "连接方式", "command": "启动命令",
                 "args": "启动参数", "env": "环境变量", "headers": "请求头"}.get(field)
        if label:
            if field == "url" and "端口无效" in reason:
                return "连接器地址的端口无效，请检查后重试。"
            if field == "url":
                return "连接器地址无效，请输入不包含凭据的 HTTP(S) 地址。"
            safe_reasons = {
                "必须是非空字符串": "必须填写", "必须是字符串数组": "必须是文字列表",
                "必须是字符串表": "必须是名称和文字的对应表", "无效": "无效",
                "必须是 stdio": "必须选择本地命令方式",
            }
            if reason in safe_reasons:
                return f"连接器{label}{safe_reasons[reason]}"
        return "连接器配置不完整或包含不支持的字段，请检查后重试。"
    return "连接器配置无效，请检查地址及连接方式后重试。"
