"""Parse message-local UI fences and validate specs against the packaged component catalog.

The fence scanner intentionally follows a line rule, not a full Markdown AST: only
lines with at most three leading spaces can open/close fences. List/quote prefixes
are not parsed; their subsequent indented lines are scanned like any other lines.
Ordinary fences shield UI markers, and an unclosed UI fence is an invalid block.

Gateway delivery uses each block's diagnostic before any message is persisted;
submission revalidates the stored spec and complete state, then emits a normal
user message. The catalog drives validation and model guidance; App schemas are
checked against it. ui_icons.json is the single generated allowlist imported by
both gateway and App. Link validation is structural and never fetches a source.
"""

from __future__ import annotations

from dataclasses import dataclass
from dataclasses import replace
from datetime import date
from fractions import Fraction
from functools import lru_cache
from ipaddress import AddressValueError, IPv4Address, IPv6Address
import json
import math
from pathlib import Path
import re
from typing import Any
import unicodedata
from urllib.parse import urlsplit

from markdown_it import MarkdownIt
from mdit_py_plugins.footnote import footnote_plugin

import idna
from jsonschema import Draft202012Validator


_CATALOG = json.loads(Path(__file__).with_name("ui_catalog.json").read_text(encoding="utf-8"))
_ICON_NAMES = frozenset(json.loads(Path(__file__).with_name("ui_icons.json").read_text(encoding="utf-8")))
_COMPONENTS = _CATALOG["components"]
_PROP_VALIDATORS = {
    name: Draft202012Validator({
        **component["props"],
        "$defs": {**_CATALOG["$defs"], **component["props"].get("$defs", {})},
    })
    for name, component in _COMPONENTS.items()
}
_VALUE_VALIDATORS = {
    name: Draft202012Validator(component["input"]["value"])
    for name, component in _COMPONENTS.items() if "input" in component
}
_IDENTIFIER_VALIDATOR = Draft202012Validator(_CATALOG["$defs"]["identifier"])
_IDENTIFIER_RE = re.compile(_CATALOG["$defs"]["identifier"]["pattern"])
_IDENTIFIER_REASON = "ID 须为 1～64 位 ASCII 字母/数字/下划线，以字母或下划线开头，且不能使用保留名称"
_FENCE = re.compile(r"^ {0,3}(?P<marker>`{3,}|~{3,})(?P<tail>[^\r\n]*)$")
_LINE_END = re.compile(r"(?:\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029])$")
_SIMPLE_KEY = re.compile(r"^[A-Za-z_][A-Za-z_0-9]*$")
_MAX_ERRORS = 32
_WEB_URL = re.compile(r"^https?://", re.ASCII)


def safe_web_url(value: str) -> bool:
    """HTTP(S) browser URL with a DNS name or canonical IP, no userinfo or ambiguous authority."""
    if (not _WEB_URL.match(value) or len(value) > 2048
            or any(ord(char) <= 32 or ord(char) == 127 or char == "\\" for char in value)):
        return False
    try:
        parsed = urlsplit(value)
        if not parsed.hostname or "@" in parsed.netloc or "%" in parsed.netloc:
            return False
        port = parsed.port
        if port is not None and not 1 <= port <= 65535:
            return False
        host = parsed.hostname
        if parsed.netloc.startswith("["):
            IPv6Address(host)
            return True
        try:
            return str(IPv4Address(host)) == host
        except AddressValueError:
            pass
        labels = host.removesuffix(".").split(".")
        if labels[-1].isdecimal() or labels[-1].lower().startswith("0x"):
            return False
        # Match App's non-transitional UTS #46 processing, not Python's IDNA
        # 2003 codec (which maps ß to ss and has different acceptance/length).
        if any(not label or any(char != "-" and unicodedata.category(char)[0] not in "LM"
                                and unicodedata.category(char) != "Nd" for char in label)
               for label in labels):
            return False
        return len(idna.encode(host, uts46=True, transitional=False, std3_rules=True)) <= 253
    except (ValueError, UnicodeError):
        return False


def _special_prop_errors(component: str, props: Any, path: str, errors: list[str]) -> None:
    if not isinstance(props, dict):
        return
    urls: list[tuple[str, Any]] = []
    if component in {"Source", "Gallery"} and isinstance(props.get("items"), list):
        urls = [(f"items[{index}].url", item["url"])
                for index, item in enumerate(props["items"])
                if isinstance(item, dict) and "url" in item]
    elif component in {"LinkCard", "Image", "MediaCard"} and "url" in props:
        urls = [("url", props["url"])]
    for name, value in urls:
        if isinstance(value, str) and not safe_web_url(value):
            _error(errors, f"{path}.props.{name}", "须为无凭据的绝对 HTTP(S) URL")
    icons = ([("name", props.get("name"))] if component == "Icon" else
             [(f"items[{index}].icon", item["icon"]) for index, item in enumerate(props.get("items", []))
              if isinstance(item, dict) and "icon" in item]
             if component == "List" and isinstance(props.get("items"), list) else [])
    for name, value in icons:
        if isinstance(value, str) and value not in _ICON_NAMES:
            _error(errors, f"{path}.props.{name}", "未知图标名")


@dataclass(frozen=True)
class UIBlock:
    """One UI fence in message order; only a valid block exposes its parsed spec."""

    block: int
    spec: dict[str, Any] | None
    error: str | None
    source: str = ""
    closed: bool = True

    def metadata(self) -> dict[str, Any]:
        """Return the metadata embedded in a persisted message.agent event."""
        result: dict[str, Any] = {"block": self.block, "valid": self.error is None}
        if self.error is not None:
            result["error"] = self.error
        return result


def _path(base: str, part: str | int) -> str:
    if isinstance(part, int):
        return f"{base}[{part}]"
    if _SIMPLE_KEY.fullmatch(part):
        return f"{base}.{part}"
    return f"{base}[{json.dumps(part, ensure_ascii=False)}]"


def _error(errors: list[str], path: str, reason: str) -> None:
    if len(errors) < _MAX_ERRORS:
        errors.append(f"{path}: {reason}")


def _schema_reason(error: Any) -> tuple[list[str | int], str]:
    """Translate a JSON Schema failure, pointing missing/unknown keys at the field."""
    path = list(error.absolute_path)
    kind = error.validator
    if kind == "required":
        missing = next(key for key in error.validator_value if key not in error.instance)
        return [*path, missing], "缺少必填字段"
    if kind == "additionalProperties":
        unknown = next(key for key in error.instance if key not in error.schema["properties"])
        return [*path, unknown], "不允许的字段"
    if kind == "type":
        return path, f"应为 {error.validator_value}"
    if kind == "enum":
        return path, f"仅允许 {', '.join(map(str, error.validator_value))}"
    if kind in {"minItems", "maxItems"}:
        return path, f"数量应{'不少于' if kind == 'minItems' else '不超过'} {error.validator_value}"
    if kind == "maxLength":
        return path, f"长度不得超过 {error.validator_value}"
    if kind == "minLength":
        return path, f"长度不得少于 {error.validator_value}"
    if kind == "uniqueItems":
        return path, "数组值不能重复"
    if kind in {"pattern", "not"} and error.schema == _CATALOG["$defs"]["identifier"]:
        return path, _IDENTIFIER_REASON
    if kind in {"minimum", "maximum", "exclusiveMinimum"}:
        return path, f"数值{'大于' if kind == 'exclusiveMinimum' else '不小于' if kind == 'minimum' else '不大于'} {error.validator_value}"
    if kind == "pattern":
        return path, "日期格式应为 YYYY-MM-DD 或空字符串"
    if kind == "oneOf":
        return path, "应为字符串或 {\"badge\":{\"text\":...,\"tone\":...}}"
    return path, "不符合组件属性约束"


def _schema_errors(validator: Draft202012Validator, value: Any, base: str, errors: list[str]) -> None:
    for failure in validator.iter_errors(value):
        parts, reason = _schema_reason(failure)
        path = base
        for part in parts:
            path = _path(path, part)
        if failure.validator == "oneOf" and isinstance(failure.instance, dict):
            branches = failure.validator_value
            if all(isinstance(branch, dict) and "properties" in branch for branch in branches):
                image = failure.instance
                if "attachment" in image and "url" in image:
                    _error(errors, _path(path, "url"), "图片来源 attachment 与 url 只能选一个")
                    continue
                branch = next((item for item in branches if
                               ("url" in image) == ("url" in item["properties"])), None)
                if branch is not None:
                    nested = list(Draft202012Validator(branch).iter_errors(image))
                    if nested:
                        for error in nested:
                            subparts, subreason = _schema_reason(error)
                            nested_path = path
                            for part in subparts:
                                nested_path = _path(nested_path, part)
                            _error(errors, nested_path, subreason)
                        continue
        _error(errors, path, reason)

def _identifier_errors(value: str, path: str, errors: list[str]) -> None:
    """Apply the catalog identifier schema as a whole string (not regex-search's final-newline $)."""
    before = len(errors)
    _schema_errors(_IDENTIFIER_VALIDATOR, value, path, errors)
    if len(errors) == before and not _IDENTIFIER_RE.fullmatch(value):
        _error(errors, path, _IDENTIFIER_REASON)


def _finite_errors(value: Any, path: str, errors: list[str]) -> None:
    if isinstance(value, (int, float)):
        try:
            finite = math.isfinite(value)
        except OverflowError:
            finite = False  # Python integers can exceed the largest JS Number.
        if not finite:
            _error(errors, path, "数值必须是有限的 JSON 数")
    elif isinstance(value, dict):
        for key, item in value.items():
            _finite_errors(item, _path(path, key), errors)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _finite_errors(item, _path(path, index), errors)


def _relation_errors(
    definition: dict[str, Any], props: Any, children: Any, path: str, errors: list[str],
) -> None:
    """Enforce catalog-declared array alignments only when both sides have valid shapes."""
    if not isinstance(props, dict):
        return
    for relation in definition.get("relations", []):
        reference_name = relation.get("lengthEquals") or relation.get("childrenLengthEquals")
        reference = props.get(reference_name)
        if not isinstance(reference, list):
            continue
        if "childrenLengthEquals" in relation:
            if isinstance(children, list) and len(children) != len(reference):
                _error(errors, _path(path, "children"), f"数量应等于 {reference_name} 数量")
            continue
        if "prop" in relation:
            field = relation["prop"]
            values = props.get(field)
            if isinstance(values, list) and len(values) != len(reference):
                _error(errors, _path(_path(path, "props"), field), f"数量应等于 {reference_name} 数量")
            continue
        items_name = relation["items"]
        items = props.get(items_name)
        if not isinstance(items, list):
            continue
        for index, item in enumerate(items):
            member = relation.get("member")
            values = item.get(member) if member and isinstance(item, dict) else item
            if isinstance(values, list) and len(values) != len(reference):
                item_path = _path(_path(_path(path, "props"), items_name), index)
                _error(errors, _path(item_path, member) if member else item_path,
                       f"数量应等于 {reference_name} 数量")


def _slider_reason(props: dict[str, Any], value: int | float) -> str | None:
    low, high, step = (props[key] for key in ("min", "max", "step"))
    if value < low or value > high:
        return f"应在 {low}～{high} 之间"
    # JSON decimal spellings define the grid. A grid point may not be exactly
    # representable as a JSON number; accept only its correctly rounded float.
    try:
        low_decimal, high_decimal = Fraction(str(low)), Fraction(str(high))
        step_decimal, submitted = Fraction(str(step)), Fraction(str(value))
        offset = submitted - low_decimal
        if offset % step_decimal == 0:
            return None
        nearest = round(offset / step_decimal)
        if nearest >= 0:
            point = low_decimal + nearest * step_decimal
            if point <= high_decimal:
                try:
                    if float(point) == value:
                        return None
                except OverflowError:
                    pass
    except ZeroDivisionError:
        return "滑块步长无效"
    return f"应从 {low} 起按步长 {step} 对齐"


def _value_reason(component: str, props: dict[str, Any], value: Any, *, initial: bool) -> str | None:
    schema_errors: list[str] = []
    _schema_errors(_VALUE_VALIDATORS[component], value, "$", schema_errors)
    if schema_errors:
        return schema_errors[0].split(": ", 1)[1]
    _finite_errors(value, "$", schema_errors)
    if schema_errors:
        return "数值必须是有限的 JSON 数"
    kind = _COMPONENTS[component]["input"]["kind"]
    if kind == "choice":
        if value == "" and _COMPONENTS[component]["input"].get("allowEmpty"):
            return None
        for option in props["options"]:
            if option["value"] == value:
                if not initial and option.get("disabled", False):
                    return "不能提交已禁用的选项"
                return None
        return "应为空字符串或给定选项的 value"
    if kind == "multiple":
        valid = {option["value"] for option in props["options"]}
        if any(item not in valid for item in value):
            return "只能选择给定选项的 value"
    if kind == "slider":
        return _slider_reason(props, value)
    if kind == "date" and value != "":
        try:
            date.fromisoformat(value)
        except ValueError:
            return "应为真实日历日期 YYYY-MM-DD 或空字符串"
    return None


def _validate_spec(spec: Any) -> list[str]:
    errors: list[str] = []
    _finite_errors(spec, "$", errors)
    if not isinstance(spec, dict):
        _error(errors, "$", "界面块必须是 JSON 对象")
        return errors
    for key in spec:
        if key not in {"root", "elements", "state"}:
            _error(errors, _path("$", key), "不允许的字段")
    for key in ("root", "elements", "state"):
        if key not in spec:
            _error(errors, _path("$", key), "缺少必填字段")
    root, elements, state = spec.get("root"), spec.get("elements"), spec.get("state")
    if isinstance(root, str):
        _identifier_errors(root, "$.root", errors)
    else:
        _error(errors, "$.root", "应为节点 ID 字符串")
    if not isinstance(elements, dict):
        _error(errors, "$.elements", "应为按 ID 索引的节点对象")
    if not isinstance(state, dict):
        _error(errors, "$.state", "应为按 stateKey 索引的对象")
    if not isinstance(elements, dict) or not isinstance(state, dict):
        return errors
    if len(elements) > 60:
        _error(errors, "$.elements", "节点不得超过 60 个")
    if isinstance(root, str) and root not in elements:
        _error(errors, "$.root", "必须引用存在的节点")

    inputs: dict[str, tuple[str, dict[str, Any]]] = {}
    edges: dict[str, list[str]] = {}
    parents: dict[str, int] = {}
    submit_count = 0
    input_count = 0
    for node_id, node in elements.items():
        path = _path("$.elements", node_id)
        _identifier_errors(node_id, path, errors)
        if not isinstance(node, dict):
            _error(errors, path, "节点应为对象")
            continue
        for key in node:
            if key not in {"type", "props", "children"}:
                _error(errors, _path(path, key), "不允许的字段")
        for key in ("type", "props", "children"):
            if key not in node:
                _error(errors, _path(path, key), "缺少必填字段")
        component, props, children = node.get("type"), node.get("props"), node.get("children")
        definition = _COMPONENTS.get(component) if isinstance(component, str) else None
        if definition is None:
            _error(errors, _path(path, "type"), f"未知组件 {component}")
        else:
            _schema_errors(_PROP_VALIDATORS[component], props, _path(path, "props"), errors)
            if isinstance(props, dict) and isinstance(props.get("stateKey"), str):
                key = props["stateKey"]
                if _IDENTIFIER_VALIDATOR.is_valid(key) and not _IDENTIFIER_RE.fullmatch(key):
                    _error(errors, _path(_path(path, "props"), "stateKey"), _IDENTIFIER_REASON)
            if component in {"ChoiceGroup", "Select", "Segmented", "MultiSelect"} and isinstance(props, dict):
                options = props.get("options")
                if isinstance(options, list):
                    seen: set[str] = set()
                    for index, option in enumerate(options):
                        if isinstance(option, dict) and isinstance(option.get("value"), str):
                            option_value = option["value"]
                            if option_value in seen:
                                _error(errors, _path(_path(_path(path, "props"), "options"), index) + ".value",
                                       "选项 value 不能重复")
                            seen.add(option_value)
            if component == "Submit":
                submit_count += 1
            if "input" in definition:
                input_count += 1
                if isinstance(props, dict) and isinstance(props.get("stateKey"), str):
                    key = props["stateKey"]
                    if key in inputs:
                        _error(errors, _path(_path(path, "props"), "stateKey"), "stateKey 在块内必须唯一")
                    else:
                        inputs[key] = (component, props)
            _relation_errors(definition, props, children, path, errors)
            _special_prop_errors(component, props, path, errors)
            if component == "Slider" and isinstance(props, dict):
                low, high, step = (props.get(key) for key in ("min", "max", "step"))
                if all(type(v) in (int, float) and (type(v) is int or math.isfinite(v)) for v in (low, high, step)):
                    if low > high:
                        _error(errors, _path(_path(path, "props"), "max"), "max 不得小于 min")
        if not isinstance(children, list):
            _error(errors, _path(path, "children"), "必须是数组；叶子节点使用 []")
            continue
        if definition is not None and not definition["container"] and children:
            _error(errors, _path(path, "children"), "叶子组件不得包含子节点")
        edges[node_id] = []
        for index, child in enumerate(children):
            child_path = _path(_path(path, "children"), index)
            if not isinstance(child, str):
                _error(errors, child_path, "子节点须引用存在的节点 ID")
                continue
            _identifier_errors(child, child_path, errors)
            if child not in elements:
                _error(errors, child_path, "子节点须引用存在的节点 ID")
                continue
            edges[node_id].append(child)
            parents[child] = parents.get(child, 0) + 1
            if parents[child] > 1:
                _error(errors, child_path, "节点被重复引用或存在共享子节点")
            if child == root:
                _error(errors, child_path, "根节点不能作为子节点")

    if submit_count != (1 if input_count else 0):
        _error(errors, "$.elements", "含表单控件的块必须恰好一个 Submit；纯展示块不得有 Submit")
    if isinstance(root, str) and root in elements:
        reached: set[str] = set()
        pending = [(root, 1)]
        while pending:
            node_id, depth = pending.pop()
            if node_id in reached:
                _error(errors, _path("$.elements", node_id), "存在循环或共享子节点")
                continue
            reached.add(node_id)
            if depth > 8:
                _error(errors, _path("$.elements", node_id), "树深不得超过 8 层")
            pending.extend((child, depth + 1) for child in edges.get(node_id, []))
        for node_id in elements:
            if node_id not in reached:
                _error(errors, _path("$.elements", node_id), "节点无法从 root 到达")
    for key, value in state.items():
        path = _path("$.state", key)
        _identifier_errors(key, path, errors)
        if key not in inputs:
            _error(errors, path, "没有对应的表单 stateKey")
            continue
        component, props = inputs[key]
        # Malformed props are already reported above; only inspect dependent values
        # once the input's own schema is satisfied.
        if _PROP_VALIDATORS[component].is_valid(props):
            reason = _value_reason(component, props, value, initial=True)
            if reason:
                _error(errors, path, reason)
    for key in inputs:
        if key not in state:
            _error(errors, _path("$.state", key), "缺少对应表单控件的初值")
    return errors


def _parse_json(content: str) -> Any:
    def object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"重复 JSON 字段 {key}")
            result[key] = value
        return result

    def invalid_constant(value: str) -> Any:
        raise ValueError(f"非法非有限数值 {value}")

    return json.loads(content, object_pairs_hook=object_pairs, parse_constant=invalid_constant)


def _ui_fences(text: str, *, preview: bool = False):
    """Yield fence spans; preview also masks Mermaid and a possible unfinished opener."""
    opener: str | None = None
    is_ui = False
    lines: list[str] = []
    start = 0
    offset = 0
    for line in text.splitlines(keepends=True):
        content = _LINE_END.sub("", line)
        match = _FENCE.fullmatch(content)
        if preview and opener is None and content == line and offset + len(line) == len(text):
            partial = re.fullmatch(r" {0,3}(`+|~+)(.*)", line)
            if partial:
                marker, info = partial.groups()
                info = info.strip(" \t")
                if len(marker) < 3 or "wandrun-ui".startswith(info) or "mermaid".startswith(info):
                    yield "", False, offset, len(text)
                    return
        if opener is None:
            if match:
                marker, info = match.group("marker", "tail")
                opener = marker
                is_ui = info.strip(" \t") == "wandrun-ui" or (
                    preview and info.strip(" \t") == "mermaid"
                )
                start = offset
                lines = []
        elif match:
            marker, remainder = match.group("marker", "tail")
            if marker[0] == opener[0] and len(marker) >= len(opener) and not remainder.strip(" \t"):
                if is_ui:
                    yield "".join(lines), True, start, offset + len(line)
                opener = None
                is_ui = False
                offset += len(line)
                continue
            if is_ui:
                lines.append(line)
        elif is_ui:
            lines.append(line)
        offset += len(line)
    if opener is not None and is_ui:
        yield "".join(lines), False, start, len(text)


def frozen_preview_text(text: str) -> str:
    """Freeze the visible phase-one text, never the hidden UI/diagram source.

    A durable interrupted record is also consumed by search and home summaries;
    storing raw unfinished JSON there would bypass the read-only bubble renderer.
    """
    parts = []
    cursor = 0
    for _source, _closed, start, end in _ui_fences(text, preview=True):
        info = text[start:end].splitlines()[0].lstrip(" ").lstrip("`~").strip(" \t")
        label = "流程图未完成" if info and "mermaid".startswith(info) else "界面未完成"
        parts.extend((text[cursor:start], f"[{label}]\n"))
        cursor = end
    parts.append(text[cursor:])
    return "".join(parts)


def parse_blocks(text: str) -> list[UIBlock]:
    """Extract every exact `wandrun-ui` fence, including malformed/unclosed blocks.

    The line rule ignores Markdown list/quote containers; ordinary fences shield
    inner markers. An unclosed block consumes its index.
    """
    blocks: list[UIBlock] = []
    for source, closed, _start, _end in _ui_fences(text):
        if not closed:
            blocks.append(UIBlock(len(blocks), None, "$: wandrun-ui 代码围栏未闭合", source, False))
            continue
        try:
            spec = _parse_json(source)
            errors = _validate_spec(spec)
        except (ValueError, RecursionError) as exc:
            blocks.append(UIBlock(len(blocks), None, f"$: JSON 无效或嵌套过深（{exc}）", source))
        else:
            blocks.append(UIBlock(len(blocks), None if errors else spec, "；".join(errors) if errors else None, source))
    return blocks


_MATH_LIMIT = 4096
_JS_SPACE = " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def _math_units(text: str) -> int:
    """JavaScript string length counts astral characters as two UTF-16 units."""
    return len(text) + sum(ord(char) > 0xffff for char in text)


def _match_inline_math(source: str, start: int) -> tuple[int, str] | None:
    if (start >= len(source) or source[start] != "$" or
            (start > 0 and source[start - 1] == "$") or
            start + 1 >= len(source) or source[start + 1] == "$" or source[start + 1] in _JS_SPACE):
        return None
    for cursor in range(start + 1, len(source)):
        char = source[cursor]
        if char == "\n":
            return None
        if char != "$":
            continue
        if cursor + 1 < len(source) and source[cursor + 1] == "$":
            return None
        slashes = 0
        for index in range(cursor - 1, start, -1):
            if source[index] != "\\":
                break
            slashes += 1
        if slashes % 2:
            continue
        if cursor + 1 < len(source) and source[cursor + 1] in "0123456789":
            return None
        tex = source[start + 1:cursor]
        if not tex.strip(_JS_SPACE) or tex[-1] in _JS_SPACE or _math_units(tex) > _MATH_LIMIT:
            return None
        if (tex[0] in "0123456789" and "\\" not in tex and
                any("\u3400" <= char <= "\u9fff" or char in "、，" for char in tex)):
            return None
        return cursor + 1, tex
    return None


def _math_inline(state, silent: bool) -> bool:
    match = _match_inline_math(state.src, state.pos)
    if match is None or match[0] > state.posMax:
        return False
    if not silent:
        token = state.push("math_inline", "", 0)
        token.content = match[1]
    state.pos = match[0]
    return True


def _math_block(state, line: int, end: int, silent: bool) -> bool:
    first = state.src[state.bMarks[line] + state.tShift[line]:state.eMarks[line]]
    if not first.startswith("$$") or first.startswith("$$$"):
        return False
    rest = first[2:]
    same_line = rest.find("$$")
    close_line = line
    if same_line >= 0:
        if rest[same_line + 2:].strip(_JS_SPACE):
            return False
        tex = rest[:same_line]
    else:
        parts = [rest + "\n"] if rest.strip(_JS_SPACE) else []
        units = _math_units(parts[0]) if parts else 0
        closed = False
        for cursor in range(line + 1, end):
            content = state.src[state.bMarks[cursor] + state.tShift[cursor]:state.eMarks[cursor]]
            at = content.find("$$")
            if at >= 0 and not content[at + 2:].strip(_JS_SPACE):
                parts.append(content[:at])
                close_line = cursor
                closed = True
                break
            part = content + "\n"
            parts.append(part)
            units += _math_units(part)
            if units > _MATH_LIMIT:
                return False
        if not closed:
            return False
        tex = "".join(parts)
    if not tex.strip(_JS_SPACE) or _math_units(tex) > _MATH_LIMIT:
        return False
    if not silent:
        token = state.push("math_block", "", 0)
        token.content = tex.strip(_JS_SPACE)
        token.map = [line, close_line + 1]
        state.line = close_line + 1
    return True


def markdown_image_urls(text: str) -> list[str]:
    """List all Markdown image tokens in message order, including unsupported URLs.

    UI fences are excluded without splitting the Markdown document: definitions
    and footnotes may resolve across them. Math tokens shield pseudo-images just
    as in the App; image token children are alt text, not separate references.
    """
    parts: list[str] = []
    cursor = 0
    marker = "WANDRUN_UI_BOUNDARY"
    while marker in text:
        marker += "_"
    for _source, _closed, start, end in _ui_fences(text):
        parts.extend((text[cursor:start], f"\n\n{marker}\n\n"))
        cursor = end
    parts.append(text[cursor:])
    markdown = MarkdownIt("default", {"html": False}).use(footnote_plugin)
    # Use the same math token boundaries as the App before numbering image tokens.
    markdown.block.ruler.before("fence", "math_block", _math_block)
    markdown.inline.ruler.before("escape", "math_inline", _math_inline)
    markdown.block.ruler.before("paragraph", "wandrun_ui_boundary",
                               lambda state, start_line, _end_line, silent:
                               _markdown_boundary(state, start_line, marker, silent))
    urls: list[str] = []

    def collect(tokens) -> None:
        for token in tokens:
            if token.type == "image":
                urls.append(token.attrGet("src") or "")
            elif token.children:
                collect(token.children)

    collect(markdown.parse("".join(parts)))
    return urls


def _markdown_boundary(state, line: int, marker: str, silent: bool) -> bool:
    start = state.bMarks[line] + state.tShift[line]
    if state.src[start:state.eMarks[line]] != marker:
        return False
    if not silent:
        state.push("wandrun_ui_boundary", "", 0)
        state.line = line + 1
    return True


def _node_images(node: dict[str, Any]):
    """Yield (index, image props) for the three media components."""
    if node["type"] == "Gallery":
        yield from enumerate(node["props"]["items"])
    elif node["type"] in {"Image", "MediaCard"}:
        yield 0, node["props"]


def image_attachments(block: UIBlock) -> set[str]:
    """Return paths used by all attachment-backed media nodes in a valid block."""
    if block.spec is None:
        return set()
    return {
        image["attachment"]
        for node in block.spec["elements"].values()
        for _index, image in _node_images(node)
        if "attachment" in image
    }


def delivery_blocks(text: str, attachments: list[Any]) -> list[UIBlock]:
    """Validate image ownership against this delivery's accepted image attachments."""
    images = {item.requested_path or item.path for item in attachments if item.media_type.startswith("image/")}
    checked = []
    for block in parse_blocks(text):
        if block.spec is not None:
            for node_id, node in block.spec["elements"].items():
                for index, image in _node_images(node):
                    if "attachment" in image and image["attachment"] not in images:
                        path = _path(_path("$.elements", node_id), "props")
                        if node["type"] == "Gallery":
                            path = _path(_path(path, "items"), index)
                        block = replace(block, spec=None, error=f"{_path(path, 'attachment')}: 须引用本条消息已接受的图片附件路径")
                        break
                if block.spec is None:
                    break
        checked.append(block)
    return checked


def validate_values(spec: dict[str, Any], values: Any) -> dict[str, str]:
    """Validate a complete submitted state against a *validated* UI spec.

    Returns stateKey -> Chinese reason; the empty mapping means valid. Every
    bound input is required, and extra fields are rejected. ChoiceGroup/Select
    disabled options may be submitted only when retaining the initial value.
    """
    if not isinstance(values, dict):
        return {"$": "values 应为按 stateKey 索引的对象"}
    inputs = {
        node["props"]["stateKey"]: (node["type"], node["props"])
        for node in spec["elements"].values()
        if "input" in _COMPONENTS[node["type"]]
    }
    errors: dict[str, str] = {}
    for key in values:
        if key not in inputs:
            errors[key] = "包含未知的表单项"
    for key, (component, props) in inputs.items():
        if key not in values:
            errors[key] = "缺少该项的提交值"
        elif reason := _value_reason(
            component, props, values[key],
            initial=(values[key] == spec["state"][key]),
        ):
            errors[key] = reason
    return errors


def submission_text(spec: dict[str, Any], values: dict[str, Any], message_seq: int, block: int) -> tuple[str, str]:
    """Format submitted form values for timeline display and model continuation.

    Caller validates values first. Option labels accompany their original values
    so the model can interpret both human copy and unambiguous machine identity.
    """
    fields: list[str] = []
    summary_fields: list[str] = []
    for node in spec["elements"].values():
        component, props = node["type"], node["props"]
        if "input" not in _COMPONENTS[component]:
            continue
        key = props["stateKey"]
        value = values[key]
        label = props.get("label") or key
        if _COMPONENTS[component]["input"]["kind"] in {"choice", "multiple"}:
            options = {option["value"]: option["label"] for option in reversed(props["options"])}
            selected = value if isinstance(value, list) else [value]
            readable = "、".join(options.get(item, "未选择") for item in selected) if selected else "未选择"
        elif component == "Switch":
            readable = "开启" if value else "关闭"
        else:
            readable = str(value) if value != "" else "未填写"
        fields.append(f"{label}（{key}）：{readable}；值={json.dumps(value, ensure_ascii=False, allow_nan=False)}")
        summary_fields.append(f"{label}：{readable}")
    summary = "已提交界面：" + "；".join(summary_fields)
    prompt = f"[界面提交] 针对 Agent 消息 seq={message_seq} 的第 {block + 1} 个界面块（block={block}，从 0 开始）：\n" + "\n".join(fields)
    return summary, prompt


def _shape(schema: dict[str, Any], definitions: dict[str, Any] | None = None) -> str:
    definitions = {**(definitions or {}), **schema.get("$defs", {})}
    if "$ref" in schema:
        return _shape(definitions[schema["$ref"].removeprefix("#/$defs/")], definitions)
    if "enum" in schema:
        return "|".join(str(item) for item in schema["enum"])
    if "oneOf" in schema:
        return " 或 ".join(_shape(part, definitions) for part in schema["oneOf"])
    if schema.get("type") == "array":
        bounds = (
            f"({schema.get('minItems', 0)}..{schema.get('maxItems', '∞')})"
            if "minItems" in schema or "maxItems" in schema else ""
        )
        return f"[{_shape(schema['items'], definitions)}]{bounds}"
    if schema.get("type") == "object":
        required = schema.get("required", [])
        return "{" + ",".join(f"{key}{'' if key in required else '?'}:{_shape(value, definitions)}" for key, value in schema["properties"].items()) + "}"
    if "minimum" in schema and "maximum" in schema:
        return f"{schema['minimum']}..{schema['maximum']}"
    if "minimum" in schema:
        return f"数值≥{schema['minimum']}"
    if "maximum" in schema:
        return f"数值≤{schema['maximum']}"
    if "exclusiveMinimum" in schema:
        return f"数值>{schema['exclusiveMinimum']}"
    if schema.get("type") == "number":
        return "数值"
    if schema.get("type") == "boolean":
        return "布尔"
    if schema.get("type") == "string":
        return f"文本≤{schema['maxLength']}" if "maxLength" in schema else "文本"
    return "值"



# Explicit membership makes a new catalog component a deliberate design decision.
_CHAPTER_COMPONENTS = {
    "display.md": (
        "Stack", "Card", "Divider", "Heading", "Text", "Badge", "Status", "Metrics",
        "KeyValue", "Steps", "Progress", "Table", "Tabs", "Accordion", "Grid",
        "Source", "LinkCard", "Icon", "List", "Callout", "Quote", "Math",
    ),
    "charts.md": ("LineChart", "BarChart", "PieChart"),
    "forms.md": (
        "ChoiceGroup", "Select", "Segmented", "MultiSelect", "Switch", "Slider",
        "TextInput", "DateInput", "Submit",
    ),
    "media.md": ("Image", "MediaCard", "Gallery", "Mermaid"),
}


def _component_reference(names: tuple[str, ...]) -> str:
    return "\n".join(
        f"- **{name}** — {_COMPONENTS[name]['description']}"
        f"{'（容器）' if _COMPONENTS[name]['container'] else ''} "
        f"`{_shape(_COMPONENTS[name]['props'], _CATALOG['$defs'])}`"
        for name in names
    )


def _examples(chapter: str) -> str:
    return "\n\n".join(
        f"{item['title']}（仅示意；事实和状态须来自实际任务）：\n```wandrun-ui\n"
        f"{json.dumps(item['spec'], ensure_ascii=False, separators=(',', ':'))}\n```"
        for item in _CATALOG["examples"] if item["chapter"] == chapter
    )


def skill_files() -> dict[str, str]:
    """Generate a navigable UI skill; fail if catalog membership changes without a chapter."""
    names = [name for chapter in _CHAPTER_COMPONENTS.values() for name in chapter]
    if len(names) != len(set(names)) or set(names) != set(_COMPONENTS):
        raise ValueError(
            f"UI skill chapter/catalog mismatch: missing={set(_COMPONENTS) - set(names)}, "
            f"extra={set(names) - set(_COMPONENTS)}, duplicated={len(names) != len(set(names))}"
        )
    example_chapters = {item["chapter"] for item in _CATALOG["examples"]}
    if example_chapters != set(_CHAPTER_COMPONENTS):
        raise ValueError(f"UI skill examples/chapter mismatch: {example_chapters ^ set(_CHAPTER_COMPONENTS)}")
    return {
        "SKILL.md": "\n".join([
            "---",
            "name: wandrun-ui",
            "description: 给 human 主动制作手机优先的受控界面：多项数据汇报、多个对象比较、需要确认/选择/填写，或附多张图片；闲聊、单句事实、纯代码和简单确认用文字。",
            "---",
            "",
            "# wandrun-ui",
            "",
            "给 human 发 UI 前先读 [design.md](design.md)；再按组件读取所需章节。读取完成后投递完整界面；常见形式以技能中的示例为准。",
            "- [display.md](display.md)：排版、状态、表格、链接、列表、数学。",
            "- [charts.md](charts.md)：趋势、分类与占比图。",
            "- [forms.md](forms.md)：控件、初值与提交值。",
            "- [media.md](media.md)：图片、附件与 Mermaid。",
            "",
            "只读所需章节；读不到技能时改用 Markdown，不猜测组件属性。给其他 Agent 只发文字。",
        ]),
        "design.md": "\n".join([
            "# 手机优先：设计与协议",
            "",
            "多项数据汇报、多个对象比较、需要确认/选择/填写，或附多张图片时主动用 UI；闲聊、单句事实、纯代码和简单确认用文字。先写一条核心结论，再给必要证据；不要在卡片外重复表格、图表或控件中已经说过的话。默认单列、依阅读顺序竖排；不强制套根 Card。Card 只用于有意义的分组，避免外卡再套内卡；强调色只给真正需要注意的状态。宽屏也不能以并排为默认，只有并排比较确实增益且手机仍可读时才用 Grid。长标签、长说明与多图优先分行/分段。",
            "需要跨项目、跨周期比较多个指标及风险时，可用 Metrics/Table，正文不再重复全部数据；短周报和单一事实不强制使用 UI。",
            "",
            "教学步骤用 List，不伪装成执行中的 Steps 或 Status；只有来自真实执行的状态/进度才用状态组件。带简介的多个可点击网页用 LinkCard，短来源标签可用 Source；不要把长 URL 当标题，引用链接不等于已核实内容。不要编造进度、统计、来源或图片地址。",
            "",
            "## 消息和 Spec",
            "",
            "在 Markdown 中穿插独占行的 wandrun-ui 代码围栏（例如后续示例），内部是完整 JSON，不是补丁/JSX。顶层恰含 `root`、`elements`、`state`；每个元素恰含 `type`、`props`、`children`。root 指向已有节点；单棵树不得循环、共享或孤立，最多 60 节点、8 层。仅目录中标记为容器的组件可有子节点，其他组件 `children:[]`；Tabs 子节点数须等于 tabs 数。Tabs 切换及 Accordion 展开只在本地，不进入 state。",
            "元素 id 与 stateKey 符合 `^[A-Za-z_][A-Za-z0-9_]{0,63}$`，不得是 constructor/prototype/__proto__；stateKey 块内唯一。只用目录组件和属性；可选属性标 `?`，数组括号是数量范围，长度按 Unicode 码点，数字须有限。受控图标名见 display.md。",
            "围栏行首只许 0～3 个 ASCII 空格，至少三个同字符反引号或波浪号；info 去掉 ASCII 空格/制表符后恰为 wandrun-ui；关闭同字符且不少于开启长度，后面只许 ASCII 空格/制表符。普通代码围栏内不可嵌套 UI。",
            "表单规则见 forms.md；图片和链接规则见 media.md、display.md。提交只回传本块 state 的值，不执行任意操作。校验拒绝时按错误路径修正整条被拒绝的消息，不重发已成功消息；不确定先读对应章节，无法读取则用 Markdown。",
        ]),
        "display.md": "\n".join([
            "# 展示与排版",
            "",
            "结论先行，单列优先。Metrics 在窄屏可能拥挤，少量指标或 KeyValue 往往更清楚；Table 每行单元格数须与 columns 相同，别把整行在表外重写。Source 用于短引用，带标题和说明的链接清单用 LinkCard，不以长 URL 代替标题。URL 须为无凭据绝对 http(s)，主机是合法 DNS 名或规范 IP、端口有效；不得带控制字符、空格、反斜线、userinfo 或模糊 authority。显示真实域名，在系统浏览器打开；不自动抓网页或 favicon，来源未核实要明说。",
            "数学正文可用 `$…$` 或 `$$…$$`；Math.tex 直接传 TeX，不含美元分隔符，JSON 反斜线双写。Icon 与 List.icon 仅能选受控 lucide 图标名：",
            ", ".join(sorted(_ICON_NAMES)) + "。",
            "",
            "## 组件（签名由目录生成）",
            _component_reference(_CHAPTER_COMPONENTS["display.md"]),
            "",
            "## 完整示例",
            _examples("display.md"),
        ]),
        "charts.md": "\n".join([
            "# 图表",
            "",
            "趋势用 LineChart，分类量用 BarChart，正值占比用 PieChart；有多项分类或趋势数据时主动用图表，单一事实用文字。 手机优先显示少量有意义的刻度（通常 4～8 个）、短标签，多个图竖排，结论不要在图前后重复。保留真实符号和尺度，不为美观改数值；不得暗示未经证实的因果。",
            "LineChart 每条 series.values 与 xLabels 等长；BarChart values 与 labels 等长，值非负；PieChart 每项为正数。签名中的最大点数是合法上限，不是推荐填满。",
            "",
            "## 组件（签名由目录生成）",
            _component_reference(_CHAPTER_COMPONENTS["charts.md"]),
            "",
            "## 完整示例",
            _examples("charts.md"),
        ]),
        "forms.md": "\n".join([
            "# 表单",
            "",
            "只在需要收集用户输入时使用控件；不能为了 Submit 凭空要求用户选择。state 恰含所有控件 stateKey 的初值；有控件恰好一个 Submit，提交全部 state；纯展示不得放 Submit。提交只产生值，不代表执行、授权或完成操作。",
            "ChoiceGroup/Select/Segmented 的值为稳定 option.value 或空串（未选）；option.value 非空且在该控件内唯一。disabled 选项可保留初值提交，但不能新选。MultiSelect 为无重复的选项 value 数组，Switch 为布尔；Slider 在 min..max 内按 min + 整数 × step 的十进制网格取值；TextInput ≤2000 码点；DateInput 为真实 YYYY-MM-DD 或空串。",
            "",
            "## 组件（签名由目录生成）",
            _component_reference(_CHAPTER_COMPONENTS["forms.md"]),
            "",
            "## 完整示例",
            _examples("forms.md"),
        ]),
        "media.md": "\n".join([
            "# 图片与流程",
            "",
            "Image/MediaCard/Gallery 的每张图片 attachment 与 url 严格二选一。attachment 必须与同一条 human 消息已交付的 image/* 附件路径完全一致：先附文件再引用，附件卡片仍会显示。url 只用无凭据绝对 http(s) 真实图片地址；投递只验语法、不联网。网关按已存消息鉴权并代理，缓存可丢且非永久；图片不能当成事实证明。",
            "用户问外观/图片，优先官方或可靠来源的真实图；没有可确认的地址就说明限制，不伪造。可用 MediaCard 或 Gallery，也可用普通 Markdown 图片。流程/关系用语法正确的 Mermaid 源码；网络图片和流程图首次获取/渲染需要网关在线。",
            "",
            "## 组件（签名由目录生成）",
            _component_reference(_CHAPTER_COMPONENTS["media.md"]),
            "",
            "## 完整示例",
            _examples("media.md"),
        ]),
    }


@lru_cache(maxsize=1)
def model_instructions() -> str:
    """Resident policy with common UI examples; detailed protocol stays in the skill files."""
    return (
        "给 human 按以下清单选择呈现：多项数据汇报、多个对象比较、需要确认/选择/填写、或附多张图片时主动使用 wandrun-ui；"
        "闲聊、单句事实、纯代码和简单“收到”用普通文字。先写结论，再给必要证据；只用受控组件。"
        "表单提交只回传值、不执行操作。校验拒绝时按错误修正被拒绝消息，不重发已成功消息；技能无法读取则用 Markdown。"
        "给其他 Agent 只发纯文字。常见确认表单、Table/List、已交付附件 Gallery 可直接套用以下完整示例；"
        "复杂或不确定组件仍先读 wandrun-ui 技能及相关章节。\n"
        "确认/选择：\n"
        "```wandrun-ui\n"
        "{\"root\":\"r\",\"elements\":{\"r\":{\"type\":\"Stack\",\"props\":{},\"children\":[\"q\",\"s\"]},\"q\":{\"type\":\"ChoiceGroup\",\"props\":{\"stateKey\":\"choice\",\"label\":\"决定\",\"options\":[{\"value\":\"yes\",\"label\":\"确认\"},{\"value\":\"edit\",\"label\":\"需要修改\"}]},\"children\":[]}, \"s\":{\"type\":\"Submit\",\"props\":{\"label\":\"提交\"},\"children\":[]}},\"state\":{\"choice\":\"\"}}\n"
        "```\n\n"
        "表格/列表：\n"
        "```wandrun-ui\n"
        "{\"root\":\"r\",\"elements\":{\"r\":{\"type\":\"Stack\",\"props\":{},\"children\":[\"t\"]},\"t\":{\"type\":\"Table\",\"props\":{\"columns\":[\"项目\",\"结果\"],\"rows\":[[\"A\",\"通过\"],[\"B\",\"待定\"]]},\"children\":[]}}, \"state\":{}}\n"
        "```\n\n"
        "附件图库：\n"
        "```wandrun-ui\n"
        "{\"root\":\"r\",\"elements\":{\"r\":{\"type\":\"Stack\",\"props\":{},\"children\":[\"g\"]},\"g\":{\"type\":\"Gallery\",\"props\":{\"items\":[{\"attachment\":\"a.png\",\"alt\":\"预览\"},{\"attachment\":\"b.png\",\"alt\":\"预览\"}]},\"children\":[]}}, \"state\":{}}\n"
        "```"
    )


