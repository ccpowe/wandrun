"""定时的字段与时间语义：当地日历规则进来，UTC 触发时间出去。

此模块不持有时钟、数据库或执行任务。调用方提供同一次操作的 now；所有比较用 UTC，
不让 cron 库的 DST 顺延把“错过不补跑”变成隐含补跑。
"""

import math
import logging
import re
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from cronsim import CronSim, CronSimError
from tzlocal import get_localzone_name

logger = logging.getLogger(__name__)

class InvalidSchedule(ValueError):
    """输入不能表示可保存的定时；拒绝操作，不修改原记录。"""


class UnknownSchedule(LookupError):
    """定时不存在或其所属 Agent 已进入删除流程。"""


_EDITABLE = frozenset({"name", "content", "rule", "timezone", "enabled"})
_CLOCK = re.compile(r"(?:[01]\d|2[0-3]):[0-5]\d", re.ASCII)
_LOCAL_DATE = re.compile(r"\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d", re.ASCII)


def _zone(name: str) -> ZoneInfo:
    if not isinstance(name, str) or not name.strip():
        raise InvalidSchedule("时区必须是有效的 IANA 时区名称")
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise InvalidSchedule(f"未知时区：{name}") from error


def local_timezone() -> str | None:
    """取得可持久保存的电脑时区名；识别失败时交给用户指定，不猜偏移或 UTC。"""
    try:
        name = get_localzone_name()
        return _zone(name).key
    except (OSError, ValueError, RuntimeError, ZoneInfoNotFoundError):
        return None


def _wall_instant(wall: datetime, zone: ZoneInfo) -> datetime | None:
    # fold=0 只取重复当地时间的第一次；往返不相同表示当地时间根本不存在。
    try:
        instant = wall.replace(tzinfo=zone, fold=0).astimezone(UTC)
        return instant if instant.astimezone(zone).replace(tzinfo=None) == wall else None
    except OverflowError as error:
        raise InvalidSchedule("日期超出此时区可表示的范围") from error


def _rule(value: object) -> dict:
    if not isinstance(value, dict):
        raise InvalidSchedule("时间规则必须是规则对象")
    kind = value.get("kind")
    keys = {
        "once": {"kind", "local_at"},
        "daily": {"kind", "time"},
        "weekly": {"kind", "time", "weekdays"},
        "cron": {"kind", "expression"},
    }
    if not isinstance(kind, str) or kind not in keys or value.keys() != keys[kind]:
        raise InvalidSchedule("时间规则必须完整指定单次、每天、每周或 cron 对应的字段")
    if kind == "once":
        raw = value["local_at"]
        if not isinstance(raw, str) or not _LOCAL_DATE.fullmatch(raw):
            raise InvalidSchedule("单次时间格式必须为 YYYY-MM-DDTHH:mm")
        try:
            datetime.fromisoformat(raw)
        except ValueError as error:
            raise InvalidSchedule("单次日期不存在") from error
        return {"kind": kind, "local_at": raw}
    if kind in {"daily", "weekly"}:
        clock = value["time"]
        if not isinstance(clock, str) or not _CLOCK.fullmatch(clock):
            raise InvalidSchedule("时间格式必须为 HH:mm，使用 24 小时制")
        result = {"kind": kind, "time": clock}
        if kind == "weekly":
            days = value["weekdays"]
            if not isinstance(days, list) or not days or any(type(day) is not int or not 1 <= day <= 7 for day in days):
                raise InvalidSchedule("星期必须是非空列表（周一 1，周日 7）")
            result["weekdays"] = sorted(set(days))
        return result
    expression = value["expression"]
    if not isinstance(expression, str) or len(expression) > 256 or len(expression.split()) != 5:
        raise InvalidSchedule("cron 必须为五段表达式（分、时、日、月、星期），最多 256 字符")
    expression = " ".join(expression.upper().split())
    try:
        CronSim(expression, datetime(2000, 1, 1))
    except CronSimError as error:
        logger.info("cron 表达式校验失败", exc_info=True)
        label = {
            "minute": "分钟", "hour": "小时", "day-of-month": "日期",
            "day of month": "日期", "day": "日期", "month": "月份",
            "day-of-week": "星期", "day of week": "星期", "weekday": "星期",
        }.get(str(error).removeprefix("Bad ").lower())
        raise InvalidSchedule(
            f"cron 的{label}字段无效，请检查取值范围和格式。" if label
            else "cron 表达式无效，请检查五段字段的取值和格式。"
        ) from error
    return {"kind": kind, "expression": expression}


def _expression(rule: dict) -> str:
    if rule["kind"] == "cron":
        return rule["expression"]
    hour, minute = (int(part) for part in rule["time"].split(":"))
    weekdays = ",".join(str(day % 7) for day in rule["weekdays"]) if rule["kind"] == "weekly" else "*"
    return f"{minute} {hour} * * {weekdays}"


def next_run_at(rule: dict, timezone: str, after: float, *, inclusive: bool = False) -> float | None:
    """已校验规则的下个 UTC epoch 秒；无下一次返回 None。

    通常严格晚于 after；恢复/错过区间的右开边界使用 inclusive=True，避免漏掉边界点。
    日期只在当地日历中枚举，候选一律转 UTC 后再比较，时钟回拨不改变比较方式。
    """
    if not math.isfinite(after):
        raise InvalidSchedule("时间基准必须是有限的 UTC 时间")
    zone = _zone(timezone)
    if rule["kind"] == "once":
        instant = _wall_instant(datetime.fromisoformat(rule["local_at"]), zone)
        if instant is None:
            raise InvalidSchedule("该当地时间因时区跳时而不存在，请选择其他时间")
        stamp = instant.timestamp()
        return stamp if stamp > after or (inclusive and stamp == after) else None
    try:
        local = datetime.fromtimestamp(after, UTC).astimezone(zone).replace(tzinfo=None)
        # CronSim 的 next 严格晚于输入；只有分钟边界可能需要包含输入本身。
        if inclusive and local.second == 0 and local.microsecond == 0:
            local -= timedelta(seconds=1)
        for wall in CronSim(_expression(rule), local):
            instant = _wall_instant(wall, zone)
            if instant is not None:
                stamp = instant.timestamp()
                if stamp > after or (inclusive and stamp == after):
                    return stamp
    except (CronSimError, OverflowError, ValueError) as error:
        logger.warning("计算定时的下次运行时间失败", exc_info=True)
        raise InvalidSchedule("无法计算下次运行时间，请检查规则和时区后重试。") from error
    return None


def schedule_fields(
    fields: dict,
    previous: dict | None = None,
    *,
    now: float,
    default_timezone: str | None = None,
) -> dict:
    """创建或局部编辑得到完整可存字段，隐藏规则归一化和下次时间重算条件。

    无关字段的编辑保留原下次时间；重新启用/修改时间只从未来安排，并遵守已处理边界。
    previous 可含内部 processed_through，返回值只含可编辑字段及派生 next_run_at。
    """
    if not isinstance(fields, dict) or fields.keys() - _EDITABLE:
        raise InvalidSchedule("定时只能编辑名称、执行内容、时间规则、时区和启用状态")
    values = {key: previous[key] for key in _EDITABLE} if previous is not None else {"enabled": True}
    values.update(fields)
    if "timezone" not in values:
        values["timezone"] = default_timezone if default_timezone is not None else local_timezone()
    name, content = values.get("name"), values.get("content")
    if not isinstance(name, str) or not name.strip() or len(name) > 64 or any(ch in name for ch in "\r\n\u2028\u2029"):
        raise InvalidSchedule("名称必须是非空单行文字，最多 64 字符")
    if not isinstance(content, str) or not content.strip() or len(content) > 20_000:
        raise InvalidSchedule("执行内容必须是非空文字，最多 20000 字符")
    if type(values["enabled"]) is not bool:
        raise InvalidSchedule("启用状态必须为布尔值")
    zone = _zone(values["timezone"])
    rule = _rule(values.get("rule"))
    if rule["kind"] == "once" and _wall_instant(datetime.fromisoformat(rule["local_at"]), zone) is None:
        raise InvalidSchedule("该当地时间因时区跳时而不存在，请选择其他时间")
    result = {"name": name.strip(), "content": content, "rule": rule, "timezone": zone.key, "enabled": values["enabled"]}
    time_changed = previous is None or any(result[key] != previous[key] for key in ("rule", "timezone"))
    reenabled = previous is not None and result["enabled"] and not previous["enabled"]
    if time_changed or reenabled:
        processed = previous.get("processed_through") if previous is not None else None
        baseline = max(now, processed) if processed is not None else now
        upcoming = next_run_at(rule, zone.key, baseline)
        if upcoming is None:
            raise InvalidSchedule("此规则没有未来运行时间，请设置新的时间")
        result["next_run_at"] = upcoming if result["enabled"] else None
    elif not result["enabled"]:
        result["next_run_at"] = None
    else:
        result["next_run_at"] = previous["next_run_at"]
    return result
