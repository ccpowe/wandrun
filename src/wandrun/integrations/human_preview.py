"""Request-local, path-aware observer of explicit human strings in AgentOutput JSON.

This is deliberately not a second validator: malformed/unknown paths disable preview,
while the ordinary complete-response parser remains authoritative for delivery.
"""

from dataclasses import dataclass, field


@dataclass
class _Frame:
    kind: str
    path: tuple
    stage: str
    key: str | None = None
    index: int = 0
    seen: set[str] = field(default_factory=set)
    recipient: str | None = None
    human_task: bool = False


class HumanPreviewParser:
    """Decode JSON incrementally; expose only messages[i].message after human/null routing.

    feed returns changed (message index, cumulative decoded text) pairs. Input is one
    assistant output item's concatenated output_text deltas, not reasoning/tool data.
    """

    def __init__(self):
        self.stack: list[_Frame] = []
        self.started = False
        self.disabled = False
        self.quoted = False
        self.escape = False
        self.unicode_digits = ""
        self.unicode_pending = False
        self.high_surrogate: int | None = None
        self.string_kind = ""
        self.string_path: tuple = ()
        self.string_chars: list[str] = []
        self.value_token = ""
        self.texts: dict[int, list[str]] = {}

    def feed(self, delta: str) -> list[tuple[int, str]]:
        touched: set[int] = set()
        for char in delta:
            if self.disabled:
                break
            try:
                self._char(char, touched)
            except ValueError:
                self.disabled = True
                self.texts.clear()
        return [(index, "".join(self.texts[index])) for index in sorted(touched) if not self.disabled]

    def _decoded(self, char: str, touched: set[int]) -> None:
        if self.high_surrogate is not None:
            code = ord(char)
            if not 0xDC00 <= code <= 0xDFFF:
                raise ValueError("unpaired high surrogate")
            char = chr(0x10000 + ((self.high_surrogate - 0xD800) << 10) + code - 0xDC00)
            self.high_surrogate = None
        elif 0xD800 <= ord(char) <= 0xDBFF:
            self.high_surrogate = ord(char)
            return
        elif 0xDC00 <= ord(char) <= 0xDFFF:
            raise ValueError("unpaired low surrogate")
        if self.string_kind == "message":
            index = self.string_path[1]
            self.texts.setdefault(index, []).append(char)
            touched.add(index)
        elif self.string_kind in {"key", "to"}:
            self.string_chars.append(char)

    def _char(self, char: str, touched: set[int]) -> None:
        if self.quoted:
            if self.unicode_pending:
                if char not in "0123456789abcdefABCDEF":
                    raise ValueError("bad unicode escape")
                self.unicode_digits += char
                if len(self.unicode_digits) == 4:
                    self.unicode_pending = False
                    self._decoded(chr(int(self.unicode_digits, 16)), touched)
                    self.unicode_digits = ""
                return
            if self.escape:
                self.escape = False
                if char == "u":
                    self.unicode_pending = True
                elif char in '"\\/bfnrt':
                    self._decoded({'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t'}.get(char, char), touched)
                else:
                    raise ValueError("bad escape")
                return
            if char == "\\":
                self.escape = True
                return
            if char == '"':
                if self.high_surrogate is not None:
                    raise ValueError("unpaired surrogate")
                self.quoted = False
                if self.string_kind == "key":
                    frame = self.stack[-1]
                    key = "".join(self.string_chars)
                    if key in frame.seen:
                        raise ValueError("duplicate key")
                    frame.seen.add(key)
                    frame.key = key
                    frame.stage = "colon"
                else:
                    if self.string_kind == "to":
                        self.stack[-1].recipient = "".join(self.string_chars)
                    self._value_done()
                self.string_chars.clear()
                return
            if ord(char) < 32:
                raise ValueError("unescaped control")
            self._decoded(char, touched)
            return
        if self.value_token:
            if char not in ",]} \t\r\n":
                self.value_token += char
                return
            if self.string_path[-1:] == ("task_id",) and self.value_token == "null":
                self.stack[-1].human_task = True
            self.value_token = ""
            self._value_done()
            self._char(char, touched)
            return
        if char in " \t\r\n":
            return
        if not self.started:
            if char != "{":
                raise ValueError("not an object")
            self.started = True
            self.stack.append(_Frame("object", (), "key_or_end"))
            return
        if not self.stack:
            raise ValueError("extra input")
        frame = self.stack[-1]
        if frame.kind == "object":
            if frame.stage == "key_or_end":
                if char == "}":
                    self._close()
                elif char == '"':
                    self._string("key", frame.path)
                else:
                    raise ValueError("expected key")
                return
            if frame.stage == "colon":
                if char != ":":
                    raise ValueError("expected colon")
                frame.stage = "value"
                return
            if frame.stage == "comma_or_end":
                if char == ",":
                    frame.stage = "key_or_end"
                elif char == "}":
                    self._close()
                else:
                    raise ValueError("expected comma")
                return
            path = (*frame.path, frame.key)
        else:
            if frame.stage == "comma_or_end":
                if char == ",":
                    frame.stage = "value_or_end"
                elif char == "]":
                    self._close()
                else:
                    raise ValueError("expected comma")
                return
            if char == "]" and frame.stage == "value_or_end":
                self._close()
                return
            path = (*frame.path, frame.index)
        if char == '"':
            target = (
                len(path) == 3 and path[0] == "messages"
                and isinstance(path[1], int) and path[2] == "message"
                and frame.recipient == "human" and frame.human_task
            )
            kind = "message" if target else "to" if path[-1] == "to" and len(path) == 3 and path[0] == "messages" else "skip"
            self._string(kind, path)
        elif char in "{[":
            kind = "object" if char == "{" else "array"
            self.stack.append(_Frame(kind, path, "key_or_end" if kind == "object" else "value_or_end"))
        else:
            self.value_token = char
            self.string_path = path

    def _string(self, kind: str, path: tuple) -> None:
        self.quoted = True
        self.string_kind = kind
        self.string_path = path
        self.string_chars.clear()

    def _close(self) -> None:
        self.stack.pop()
        if self.stack:
            self._value_done()

    def _value_done(self) -> None:
        if not self.stack:
            return
        frame = self.stack[-1]
        frame.stage = "comma_or_end"
        if frame.kind == "array":
            frame.index += 1
