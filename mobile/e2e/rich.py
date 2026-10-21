"""Real-model rich-message fixtures and assertions for run.py's # @rich-* hooks.

Each request asks the Agent to deliver a supplied, valid spec verbatim; the gateway
still records the actual model reply. Never insert an Agent message through the API.
"""

import json
import re
import time
from uuid import uuid4


IMAGE_URL = "https://raw.githubusercontent.com/github/explore/main/topics/python/python.png"


def node(kind, props=None, *children):
    return kind, props or {}, children


def spec(root, state=None):
    elements = {}

    def visit(item):
        identity = f"n{len(elements)}"
        kind, props, children = item
        elements[identity] = {"type": kind, "props": props, "children": []}
        elements[identity]["children"] = [visit(child) for child in children]
        return identity

    return {"root": visit(root), "elements": elements, "state": state or {}}


def card(title, *children):
    return node("Card", {"title": title}, *children)


SCENARIOS = {
    "status": spec(card("发布进展与语义状态",
        node("Status", {"title": "发布 v1.4", "badge": {"text": "进行中", "tone": "active"}, "progress": 60}),
        node("Metrics", {"items": [{"label": "已完成", "value": "12"}, {"label": "失败", "value": "1"}]}),
        node("Steps", {"items": [{"label": "构建", "state": "done"}, {"label": "部署", "state": "current"}]}),
        node("Table", {"columns": ["任务", "状态"], "rows": [
            ["连接", {"badge": {"text": "成功", "tone": "success"}}],
            ["容量", {"badge": {"text": "接近上限", "tone": "warning"}}],
            ["归档", {"badge": {"text": "失败", "tone": "error"}}],
        ]}),
        node("Badge", {"text": "提示", "tone": "info"}))),
    "form": spec(card("周报设置",
        node("ChoiceGroup", {"stateKey": "plan", "label": "方案", "options": [
            {"value": "lake", "label": "杭州西湖两日"}, {"value": "mountain", "label": "莫干山民宿"}]}),
        node("DateInput", {"stateKey": "date", "label": "日期"}),
        node("Select", {"stateKey": "release", "label": "发布范围", "options": [
            {"value": "canary", "label": "灰度"}, {"value": "production", "label": "正式"}]}),
        node("Segmented", {"stateKey": "length", "label": "篇幅", "options": [
            {"value": "short", "label": "简短"}, {"value": "standard", "label": "标准"}]}),
        node("MultiSelect", {"stateKey": "sources", "label": "资料来源", "variant": "chips", "options": [
            {"value": "official", "label": "官方博客"}, {"value": "papers", "label": "论文"}]}),
        node("Switch", {"stateKey": "screenshots", "label": "配图使用原帖截图"}),
        node("Slider", {"stateKey": "tone", "label": "语气", "min": 0, "max": 1, "step": 0.1}),
        node("TextInput", {"stateKey": "extra", "label": "另外想写的", "placeholder": "可选"}),
        node("Submit", {"label": "开始写"})),
        {"plan": "mountain", "date": "2026-10-20", "release": "canary",
         "length": "standard", "sources": ["official"], "screenshots": True, "tone": 0.7, "extra": ""}),
    "line": spec(card("近一周趋势", node("LineChart", {"title": "任务完成数", "xLabels": ["周一", "周二", "周三", "周四", "周五"],
        "series": [{"name": "已完成", "values": [12, 18, 15, 24, 29]}, {"name": "新增", "values": [8, 13, 12, 19, 21]}], "unit": "项"}))),
    "bar": spec(card("渠道效果", node("BarChart", {"title": "咨询量", "labels": ["官网", "社群", "搜索", "活动"],
        "values": [45, 72, 38, 56], "unit": "次"}))),
    "pie": spec(card("预算构成", node("PieChart", {"title": "支出占比", "items": [
        {"label": "住宿", "value": 3200}, {"label": "交通", "value": 1800},
        {"label": "餐饮", "value": 1200}, {"label": "其他", "value": 800}], "unit": "元"}))),
    "disclosure": spec(card("发布信息", node("Tabs", {"tabs": [{"label": "概览"}, {"label": "详情"}, {"label": "检查"}]},
        node("Accordion", {"title": "查看当前问题"}, node("Text", {"text": "暂无阻塞项"})),
        node("Text", {"text": "版本 v1.4，生产环境"}),
        node("Text", {"text": "健康检查已完成"})))),
    "sources": spec(card("搜索后带来源的回答",
        node("Source", {"items": [
            {"title": "Expo", "url": "https://docs.expo.dev/"},
            {"title": "KaTeX", "url": "https://katex.org/docs/options"},
            {"title": "React Native", "url": "https://reactnative.dev/docs/getting-started"},
            {"title": "TypeScript", "url": "https://www.typescriptlang.org/docs/"},
            {"title": "MDN", "url": "https://developer.mozilla.org/en-US/docs/Web/JavaScript"},
            {"title": "Python", "url": "https://docs.python.org/3/"},
            {"title": "Node.js", "url": "https://nodejs.org/en/docs"},
            {"title": "GitHub", "url": "https://docs.github.com/en"},
        ]}),
        node("LinkCard", {"title": "Expo 文档", "url": "https://docs.expo.dev/", "description": "官方文档入口"}))),
    "components": spec(card("发布检查",
        node("Icon", {"name": "shield-check", "label": "安全检查", "size": "lg"}),
        node("List", {"ordered": True, "items": [{"text": "构建并验证产物", "icon": "code-xml"},
            {"text": "先灰度部署", "icon": "activity"}]}),
        node("Callout", {"tone": "info", "title": "说明", "text": "先验证再扩大范围"}),
        node("Callout", {"tone": "warning", "title": "注意", "text": "操作前备份"}),
        node("Quote", {"text": "可回滚比盲目继续重要", "attribution": "发布原则"}))),
    "math": spec(card("物理公式",
        node("Text", {"text": "速度 $v=at$，动能 $E_k=\\frac12mv^2$。"}),
        node("Math", {"tex": "\\int_0^t a\\tau\\,d\\tau=\\frac12at^2", "display": True}))),
    "media": spec(card("网络图片与图集",
        node("Image", {"url": IMAGE_URL, "alt": "Python 标志", "caption": "Python 项目标志"}),
        node("MediaCard", {"url": IMAGE_URL, "alt": "横排标志图片", "title": "图文横排", "direction": "horizontal"}),
        node("MediaCard", {"url": IMAGE_URL, "alt": "竖排标志图片", "title": "图文竖排", "direction": "vertical"}),
        node("Gallery", {"items": [{"url": IMAGE_URL, "alt": "第一张标志", "caption": "第一张"},
            {"url": IMAGE_URL, "alt": "第二张标志", "caption": "第二张"}]}))),
    "gallery-scroll": spec(card("横滑三张图片",
        node("Gallery", {"items": [
            {"url": IMAGE_URL, "alt": "横滑第一张标志", "caption": "横滑第一张"},
            {"url": IMAGE_URL, "alt": "横滑第二张标志", "caption": "横滑第二张"},
            {"url": IMAGE_URL, "alt": "横滑第三张标志", "caption": "横滑第三张"},
        ]}))),
    "mermaid": spec(card("流程图", node("Mermaid", {"source": "flowchart LR\n  A[收到消息] --> B{校验}\n  B -->|通过| C[显示]", "title": "消息处理流程"}))),
}


def prepare(runner, env):
    """Register one owned Agent and conversation in the runner's existing cleanup lists."""
    identity = runner.create_owned_agent("E2E rich " + runner.run_id,
        system_prompt="Follow the user's request. Send the supplied wandrun-ui spec exactly as requested using SendMessage to human; do not substitute a summary or generate a new spec.")
    conversation = runner.api("/conversations", "POST", {"agent_id": identity})
    runner.fixtures.append(conversation["id"])
    env.update({"RICH_AGENT_ID": identity, "RICH_CONVERSATION_ID": conversation["id"]})


def _await_idle(runner, env):
    deadline = time.monotonic() + 180
    while True:
        conversation = next(item for item in runner.api("/conversations")["conversations"]
            if item["id"] == env["RICH_CONVERSATION_ID"])
        if conversation["status"] != "working":
            return
        if time.monotonic() >= deadline:
            raise AssertionError("Rich Agent did not settle before the next request")
        time.sleep(0.5)


def _request(runner, env, name):
    _await_idle(runner, env)
    expected = json.dumps(SCENARIOS[name], ensure_ascii=False, separators=(",", ":"))
    suffix = "\n\n行内公式 $v=at$ 与块公式：\n\n$$\nE=mc^2\n$$" if name == "math" else (
        f"\n\nMarkdown 图片：![Markdown 标志图片]({IMAGE_URL})" if name == "media" else "")
    fence = "```wandrun-ui\n" + expected + "\n```"
    prompt = "请用 SendMessage 发给 human，原样复制下面的界面块（包括围栏，不要压缩、更改 JSON 或放进另一个代码块），并在界面块之后原样追加其余文字。不要调用其他工具：\n\n" + fence + suffix
    path = runner.conversation_path(env["RICH_CONVERSATION_ID"])
    prior = runner.api(path + "/events?limit=200")["events"]
    before = max((event["seq"] for event in prior), default=0)
    runner.api(path + "/messages", "POST", {"client_id": "e2e-rich-" + uuid4().hex, "text": prompt})
    deadline = time.monotonic() + 180
    while True:
        events = runner.api(path + "/events?limit=200")["events"]
        replies = [event for event in events if event["seq"] > before and event["type"] == "message.agent"]
        failed = [event for event in events if event["seq"] > before and event["type"] == "turn.failed"]
        if failed or replies or time.monotonic() >= deadline:
            (runner.OUT / f"rich-{name}-events.json").write_text(json.dumps(
                [event for event in events if event["seq"] > before], ensure_ascii=False, indent=2))
            expected_types = {element["type"] for element in SCENARIOS[name]["elements"].values()}
            matching = []
            for reply in replies:
                text = reply["data"].get("text", "")
                for block, body in enumerate(re.findall(r"(?m)^```wandrun-ui[ \t]*\n(.*?)^```[ \t]*$", text, re.S)):
                    try:
                        delivered = json.loads(body)
                    except json.JSONDecodeError:
                        continue
                    types = {element.get("type") for element in delivered.get("elements", {}).values()}
                    metadata = reply["data"].get("ui", [])
                    if (expected_types <= types
                        and (name not in ("sources", "gallery-scroll") or delivered == SCENARIOS[name])
                        and any(item.get("block") == block and item.get("valid") for item in metadata)):
                        matching.append((reply, block, delivered))
            assert not failed and matching, f"{name}: expected valid component set missing; see events evidence"
            reply, block, delivered = matching[-1]
            env["RICH_LAST_SEQ"] = reply["seq"]
            _await_idle(runner, env)
            if name in ("media", "gallery-scroll"):
                media = {}
                for element, item in delivered["elements"].items():
                    if item["type"] not in ("Image", "MediaCard", "Gallery"):
                        continue
                    count = len(item["props"]["items"]) if item["type"] == "Gallery" else 1
                    for index in range(count):
                        media[f"{element}/{index}"] = runner.api(
                            path + f"/messages/{reply['seq']}/media/{block}/{element}/{index}")
                (runner.OUT / f"rich-{name}-media.json").write_text(json.dumps(media, indent=2))
            # Use the app's existing message-target route; the virtualized list's
            # scroll extents are not exposed reliably by Android accessibility.
            runner.ad("open", runner.EXPO.rstrip("/") + "/--/c/"
                      + env["RICH_CONVERSATION_ID"] + "?message_seq=" + str(env["RICH_LAST_SEQ"]), "--foreground")
            # A late-rendered chart can leave the whole target row partly below
            # the composer (the recorded placement limitation). Inspect its
            # actual controls after the explicit reader action, not whole-row
            # accessibility visibility.
            # Android's snapshot helper may spend its first capture restarting;
            # allow a subsequent readable capture rather than a ten-second race.
            runner.ad("wait", 'id="chat-agent-name"', "30000")
            runner.ad("wait", "stable", "500", "30000")
            runner.dismiss_known_dev_overlay()
            bottom = next((node for node in runner.ad("snapshot", "-i")["nodes"]
                if node.get("id", node.get("identifier")) == "chat-return-to-bottom"
                and node.get("hittable")), None)
            if bottom:
                runner.ad("click", "id=chat-return-to-bottom", "--settle")
            return
        time.sleep(0.5)


def _submission(runner, env):
    path = runner.conversation_path(env["RICH_CONVERSATION_ID"])
    deadline = time.monotonic() + 15
    while True:
        events = runner.api(path + "/events?limit=200")["events"]
        submitted = [event for event in events if event["type"] == "message.user" and
            event["data"].get("ui_submission", {}).get("message_seq") == env["RICH_LAST_SEQ"]]
        if submitted or time.monotonic() >= deadline:
            assert len(submitted) == 1, "Form submission did not persist as one user event"
            assert submitted[0]["data"]["ui_submission"]["values"] == {**SCENARIOS["form"]["state"], "release": "production"}
            (runner.OUT / "rich-form-submission.json").write_text(json.dumps(submitted[0], ensure_ascii=False, indent=2))
            return
        time.sleep(0.25)


def _snapshot(runner, name):
    nodes = runner.ad("snapshot", "-i")["nodes"]
    (runner.OUT / f"rich-{name}-snapshot.json").write_text(json.dumps(nodes, ensure_ascii=False, indent=2))
    assert not any(node.get("id", node.get("identifier")) == "rich-invalid" or
        "无法显示的界面" in str(node.get("label") or node.get("text") or "") for node in nodes), (
        name + ": invalid UI block visible")
    if name == "sources":
        links = [node["label"] for node in nodes
                 if node.get("roleDescription") == "链接" and node.get("hittable")]
        assert any("https://katex.org/docs/options" in label for label in links), "Expanded Source link missing"
        assert any("docs.expo.dev" in label and "https://" not in label for label in links), "LinkCard missing"


def _identified(nodes, identity):
    return next((node for node in nodes if node.get("id", node.get("identifier")) == identity), None)


def _labelled(nodes, label):
    return next((node for node in nodes if (node.get("label") or node.get("text")) == label), None)


def _source_before_swipe(runner, env):
    runner.ad("wait", "stable", "500", "30000")
    nodes = runner.ad("snapshot", "-i")["nodes"]
    windows = runner.command([*runner.ADB, "shell", "dumpsys", "window"], timeout=15)
    focus = next((line for line in windows.splitlines() if "mCurrentFocus=" in line), "")
    activity = re.search(r"(host\.exp\.exponent/[^ }\s]+)", focus)
    assert activity, "Source handoff must begin in Expo Go"
    env["RICH_EXPO_ACTIVITY"] = activity[1]
    rail = _identified(nodes, "rich-source-rail")
    toggle = _identified(nodes, "rich-source-toggle")
    first = _identified(nodes, "rich-source-0")
    second = _identified(nodes, "rich-source-1")
    third = _identified(nodes, "rich-source-2")
    link = _labelled(nodes, "Expo 文档，docs.expo.dev")
    assert all(item and item.get("rect") for item in (rail, toggle, first, second, third, link)), "Expanded Source geometry unavailable"
    assert first["rect"]["x"] >= rail["rect"]["x"] - 3, "Source rail did not start at the first card"
    interval = second["rect"]["x"] - first["rect"]["x"]
    assert interval > 0 and interval * 8 > rail["rect"]["width"], "Source fixture does not overflow tablet rail"
    env["RICH_SOURCE_BEFORE"] = {
        "rail": rail["rect"], "toggle_y": toggle["rect"]["y"],
        "link_y": link["rect"]["y"], "first_x": first["rect"]["x"],
        "third_x": third["rect"]["x"], "card_width": first["rect"]["width"],
    }


def _source_after_swipe(runner, env):
    runner.ad("wait", "stable", "500", "30000")
    nodes = runner.ad("snapshot", "-i")["nodes"]
    before = env["RICH_SOURCE_BEFORE"]
    rail = _identified(nodes, "rich-source-rail")
    toggle = _identified(nodes, "rich-source-toggle")
    third = _identified(nodes, "rich-source-2")
    link = _labelled(nodes, "Expo 文档，docs.expo.dev")
    assert all(item and item.get("rect") for item in (rail, toggle, third, link)), "Source disappeared after horizontal swipe"
    assert before["third_x"] - third["rect"]["x"] >= 30, "Source rail did not scroll horizontally"
    assert abs(before["toggle_y"] - toggle["rect"]["y"]) <= 3, "Horizontal Source swipe scrolled outer chat"
    assert abs(before["link_y"] - link["rect"]["y"]) <= 3, "Horizontal Source swipe moved LinkCard vertically"
    left = rail["rect"]["x"]
    right = left + rail["rect"]["width"]
    candidates = [
        (index, node) for index in range(2, 8)
        if (node := _identified(nodes, f"rich-source-{index}")) and node.get("hittable")
        and node.get("rect") and node["rect"]["x"] >= left
        and node["rect"]["x"] + node["rect"]["width"] <= right
        and abs(node["rect"]["width"] - before["card_width"]) <= 3
    ]
    assert candidates, "No non-first source card is fully visible after swipe"
    index, chosen = candidates[0]
    items = next(item["props"]["items"] for item in SCENARIOS["sources"]["elements"].values() if item["type"] == "Source")
    expected_url = items[index]["url"]
    assert expected_url in chosen.get("label", ""), "Source accessibility label lost original URL"
    env["RICH_SOURCE_OPEN_INDEX"] = index
    (runner.OUT / "rich-source-swipe.json").write_text(json.dumps({
        "before": before, "after": {"rail": rail["rect"], "toggle_y": toggle["rect"]["y"],
                                    "link_y": link["rect"]["y"], "third_x": third["rect"]["x"]},
        "opened": {"index": index, "label": chosen["label"]},
    }, ensure_ascii=False, indent=2))


def _source_collapsed(runner):
    nodes = runner.ad("snapshot", "-i")["nodes"]
    assert _identified(nodes, "rich-source-toggle"), "Source collapse toggle missing"
    assert not _identified(nodes, "rich-source-rail"), "Source rail still exposed while collapsed"
    assert not any(_identified(nodes, f"rich-source-{index}") for index in range(8)), "Collapsed Source link is exposed"
    assert _labelled(nodes, "Expo 文档，docs.expo.dev"), "LinkCard disappeared with Source rail"


def _source_ready_to_collapse(runner):
    nodes = runner.ad("snapshot", "-i")["nodes"]
    assert _identified(nodes, "rich-source-toggle"), "Source conversation was not restored from browser"
    assert _identified(nodes, "rich-source-rail"), "Source expanded state was lost on browser return"


def _return_from_source_browser(runner, env):
    """Only this intentional Source URL handoff may briefly focus a browser."""
    deadline = time.monotonic() + 10
    while True:
        windows = runner.command([*runner.ADB, "shell", "dumpsys", "window"], timeout=15)
        focus = next((line for line in windows.splitlines() if "mCurrentFocus=" in line), "")
        if any(package in focus for package in (
            "com.android.browser/", "com.android.chrome/", "com.google.android.apps.chrome/",
        )):
            break
        if time.monotonic() >= deadline:
            if "host.exp.exponent/" in focus:
                raise AssertionError("Source URL did not leave Expo Go for a browser")
            runner.phone_stopped = True
            raise RuntimeError("Source URL did not open the expected browser: " + focus)
        if "host.exp.exponent/" not in focus and "mCurrentFocus=null" not in focus:
            runner.phone_stopped = True
            raise RuntimeError("Unexpected foreground during Source browser handoff: " + focus)
        time.sleep(0.1)
    # Resume the existing activity without a new route/message jump, which can
    # reposition the virtualized chat and unmount its local disclosure state.
    try:
        runner.command([*runner.ADB, "shell", "am", "start", "-W",
                        "--activity-reorder-to-front", "-n", env["RICH_EXPO_ACTIVITY"]], timeout=30)
    except Exception:
        runner.phone_stopped = True
        raise
    deadline = time.monotonic() + 10
    while True:
        windows = runner.command([*runner.ADB, "shell", "dumpsys", "window"], timeout=15)
        focus = next((line for line in windows.splitlines() if "mCurrentFocus=" in line), "")
        if "host.exp.exponent/" in focus:
            runner.require_expo()
            return
        if time.monotonic() >= deadline:
            runner.phone_stopped = True
            raise RuntimeError("Expo Go did not regain foreground after Source browser: " + focus)
        time.sleep(0.1)


def _gallery_before_swipe(runner, env):
    runner.ad("wait", "stable", "500", "30000")
    nodes = runner.ad("snapshot", "-i")["nodes"]
    first = _labelled(nodes, "查看图片 横滑第一张标志")
    assert first and first.get("rect") and _identified(nodes, "rich-gallery"), "Gallery image missing"
    assert _labelled(nodes, "1 / 3") and _labelled(nodes, "横滑第一张"), "Gallery initial page is not first"
    env["RICH_GALLERY_START_X"] = first["rect"]["x"]
    env["RICH_GALLERY_START_WIDTH"] = first["rect"]["width"]


def _gallery_after_swipe(runner, env):
    runner.ad("wait", "stable", "500", "30000")
    nodes = runner.ad("snapshot", "-i")["nodes"]
    pages = [(page, _labelled(nodes, f"{page} / 3")) for page in range(2, 4)]
    page = next((page for page, indicator in pages if indicator), None)
    assert page is not None, "Real gallery swipe did not advance the page indicator"
    names = ("横滑第一张", "横滑第二张", "横滑第三张")
    runner.ad("wait", "label=" + json.dumps(f"查看图片 {names[page - 1]}标志", ensure_ascii=False), "10000")
    nodes = runner.ad("snapshot", "-i")["nodes"]
    picture = _labelled(nodes, f"查看图片 {names[page - 1]}标志")
    assert picture and picture.get("rect") and picture.get("hittable"), "Selected gallery image is not visible"
    assert abs(picture["rect"]["x"] - env["RICH_GALLERY_START_X"]) <= 4, "Gallery tile did not snap to start alignment"
    # Android clips AX bounds at the rail edge; matching x alone can hide a half-clipped tile.
    assert abs(picture["rect"]["width"] - env["RICH_GALLERY_START_WIDTH"]) <= 4, "Snapped gallery tile is clipped"
    assert _labelled(nodes, names[page - 1]), "Gallery caption and page indicator disagree"
    env["RICH_GALLERY_OPEN_ALT"] = names[page - 1] + "标志"
    (runner.OUT / "rich-gallery-swipe.json").write_text(json.dumps({
        "page": page, "start_x": env["RICH_GALLERY_START_X"], "start_width": env["RICH_GALLERY_START_WIDTH"],
        "selected_rect": picture["rect"], "label": picture["label"],
    }, ensure_ascii=False, indent=2))


def _gallery_viewer(runner, env):
    # Include static text: interactive-only snapshots omit the displayed zoom value.
    nodes = runner.ad("snapshot")["nodes"]
    assert all(_identified(nodes, identity) for identity in (
        "media-zoom-in", "media-zoom-reset",
    )), "Selected gallery image did not open the normal viewer"
    assert _identified(nodes, "media-image-open"), "Gallery viewer did not load its image"
    assert _labelled(nodes, env["RICH_GALLERY_OPEN_ALT"]), "Viewer opened the wrong gallery image"
    assert _labelled(nodes, "1×"), "Gallery viewer did not begin at normal zoom"
    assert not _identified(nodes, "media-image-error"), "Gallery viewer image failed to load"


def _reveal_chat_control(runner, label):
    # Android can report a clipped child as hittable underneath the composer.
    # Settle scrolling before locating small controls, then reveal the tap area.
    runner.ad("wait", "stable", "500", "30000")
    for _ in range(8):
        nodes = runner.ad("snapshot", "-i")["nodes"]
        control = next((node for node in nodes
                        if node.get("label") == label), None)
        composer = next(node for node in nodes
                        if node.get("identifier") == "composer-input")["rect"]
        if control and control.get("hittable"):
            rect = control["rect"]
            if rect["y"] + rect["height"] < composer["y"] - composer["height"]:
                return
        runner.ad("scroll", "down", "0.3", "--settle")
    raise AssertionError(label + ": control remains obscured by the composer")


def _preview_review(runner):
    """Capture every dev scenario in both themes; its deliberately invalid case is evidence too."""
    labels = list(dict.fromkeys(node.get("label", "") for node in runner.ad("snapshot", "-i")["nodes"]
        if node.get("label", "").startswith("预览")
        and not node.get("label", "").startswith("预览提交")))
    assert labels, "No development preview scenarios are accessible"
    for theme in ("light", "dark"):
        for index, label in enumerate(labels):
            # Selecting a different scenario remounts its ScrollView at the top.
            runner.ad("click", "label=" + json.dumps(label, ensure_ascii=False))
            # The 500-paragraph accessibility tree takes several seconds per capture
            # on the tablet; retain the quiet-window check, with time for multiple captures.
            runner.ad("wait", "stable", "1000", "30000")
            previous = None
            for page in range(6):
                nodes = runner.ad("snapshot", "-i")["nodes"]
                signature = [(node.get("label"), node.get("identifier"), node.get("rect")) for node in nodes]
                if signature == previous:
                    break
                runner.ad("screenshot", str(runner.OUT / f"preview-{index:02}-{theme}-{page}.png"))
                previous = signature
                runner.ad("scroll", "down")
        runner.ad("click", 'label="切换预览主题"')
        runner.ad("wait", "stable", "1000", "30000")


def action(runner, env, name):
    """Drive an isolated model turn or assert persisted/UI evidence at a YAML hook."""
    if name in SCENARIOS:
        _request(runner, env, name)
    elif name == "form-submitted":
        _submission(runner, env)
    elif name == "reveal-markdown-image":
        _reveal_chat_control(runner, "查看图片 Markdown 标志图片")
    elif name == "reveal-gallery-second":
        _reveal_chat_control(runner, "查看图片 第二张标志")
    elif name == "source-collapsed":
        _source_collapsed(runner)
    elif name == "source-before-swipe":
        _source_before_swipe(runner, env)
    elif name == "source-after-swipe":
        _source_after_swipe(runner, env)
    elif name == "source-browser-return":
        _return_from_source_browser(runner, env)
    elif name == "source-ready-to-collapse":
        _source_ready_to_collapse(runner)
    elif name == "gallery-before-swipe":
        _gallery_before_swipe(runner, env)
    elif name == "gallery-after-swipe":
        _gallery_after_swipe(runner, env)
    elif name == "gallery-viewer":
        _gallery_viewer(runner, env)
    elif name.startswith("check-"):
        _snapshot(runner, name.removeprefix("check-"))
    elif name == "preview-open":
        runner.ad("open", runner.EXPO.rstrip("/") + "/--/dev/rich-preview", "--foreground")
        runner.ad("wait", 'label="富交互消息 · P0/P1/P2"', "10000")
    elif name == "preview-close":
        runner.ad("open", runner.EXPO, "--foreground")
        runner.home()
    elif name == "preview-review":
        _preview_review(runner)
    else:
        raise RuntimeError("Unknown rich regression hook: " + name)
