"""Deterministic native-rich scenes delivered by the isolated fixture gateway.

The gateway persists real message.agent events and validates UI metadata. Resource
fetches, native geometry and explicit visual reviews remain separate evidence:
valid fixture data never implies that the production renderer painted correctly.
"""

import json
import re
from urllib.request import Request, urlopen
from uuid import uuid4

from PIL import Image, ImageChops


IMAGE_URL = "https://raw.githubusercontent.com/github/explore/main/topics/python/python.png"

MANUAL_SOURCE_EXTERNAL_LINK = (
    "请在当前已横滑的 Sources 中点击脚本选定的可见非首张来源卡；"
    "确认系统浏览器实际打开该卡原始 URL（不能只看链接文字），"
    "再用 Android 系统返回回到同一个 Expo Go 对话。"
    "请回复实际打开的 URL、是否返回原对话及有无异常；"
    "助手不会在系统浏览器内执行任何操作。"
)


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
    "scroll-row": spec(node("Stack", {"gap": "lg"},
        node("Heading", {"text": "横滑区域外"}),
        node("ScrollRow", {},
            node("StatCard", {"icon": "activity", "label": "方案一", "value": "128", "description": "横滑查看其余方案"}),
            node("StatCard", {"icon": "clock-3", "label": "方案二", "value": "256", "description": "横滑查看其余方案"}),
            node("StatCard", {"icon": "star", "label": "方案三", "value": "512", "description": "横滑终点"})),
        *[node("Text", {"text": f"纵向阅读条目 {index}：保留真实输入，按阅读顺序查看所有内容，横滑容器外仍由聊天列表滚动。"})
          for index in range(1, 13)],
        node("Heading", {"text": "L3 纵向终点"}))),
    "line": spec(card("近一周趋势", node("LineChart", {"title": "任务完成数", "xLabels": ["周一", "周二", "周三", "周四", "周五"],
        "series": [{"name": "已完成", "values": [12, 18, 15, 24, 29]}, {"name": "新增", "values": [8, 13, 12, 19, 21]}], "unit": "项"}))),
    "bar": spec(card("渠道效果", node("BarChart", {"title": "咨询量", "labels": ["官网", "社群", "搜索", "活动"],
        "series": [{"name": "咨询", "values": [45, 72, 38, 56]}], "unit": "次"}))),
    "bar-horizontal": spec(card("渠道净增长", node("BarChart", {"title": "渠道净增长", "labels": ["官网", "社群", "搜索", "活动"],
        "series": [{"name": "本周", "values": [45, -22, 38, 56]}, {"name": "上周", "values": [32, -15, 25, 40]}],
        "horizontal": True, "unit": "人"}))),
    "pie": spec(card("预算构成", node("PieChart", {"title": "支出占比", "items": [
        {"label": "住宿", "value": 3200}, {"label": "交通", "value": 1800},
        {"label": "餐饮", "value": 1200}, {"label": "其他", "value": 800}], "unit": "元"}))),
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
    "math": spec(card("物理公式",
        node("Text", {"text": "速度 $v=at$，动能 $E_k=\\frac12mv^2$。"}),
        node("Math", {"tex": "\\int_0^t a\\tau\\,d\\tau=\\frac12at^2", "display": True}))),
    "gallery-scroll": spec(card("横滑三张图片",
        node("Gallery", {"items": [
            {"url": IMAGE_URL, "alt": "横滑第一张标志", "caption": "横滑第一张"},
            {"url": IMAGE_URL, "alt": "横滑第二张标志", "caption": "横滑第二张"},
            {"url": IMAGE_URL, "alt": "横滑第三张标志", "caption": "横滑第三张"},
        ]}))),
    "mermaid": spec(card("流程图", node("Mermaid", {"source": "flowchart LR\n  A[收到消息] --> B{校验}\n  B -->|通过| C[显示]", "title": "消息处理流程"}))),
}


def manual_instructions(name, env):
    """Name the actual visible Source chosen by the geometry check for the user."""
    if name != "rich-source-external-link":
        raise RuntimeError("Unknown rich manual check: " + name)
    index = env["RICH_SOURCE_OPEN_INDEX"]
    items = next(item["props"]["items"] for item in SCENARIOS["sources"]["elements"].values()
                 if item["type"] == "Source")
    chosen = items[index]
    return f"本轮点击第 {index + 1} 张「{chosen['title']}」，应打开 {chosen['url']}。 " + MANUAL_SOURCE_EXTERNAL_LINK


def prepare(runner, env):
    """Register one owned Agent and conversation; fixed samples never invoke a model."""
    identity = runner.create_owned_agent("E2E rich " + runner.run_id)
    conversation = runner.api("/conversations", "POST", {"client_id": uuid4().hex, "agent_id": identity})
    runner.fixtures.append(conversation["id"])
    env.update({"RICH_AGENT_ID": identity, "RICH_CONVERSATION_ID": conversation["id"]})


def _request(runner, env, name):
    """Persist a scene via Gateway.on_human, then inspect its actual event and assets."""
    path = runner.conversation_path(env["RICH_CONVERSATION_ID"])
    prior = runner.api(path + "/events?limit=200")["events"]
    before = max((event["seq"] for event in prior), default=0)
    receipt = runner.api("/e2e/scene", "POST", {
        "conversation_id": env["RICH_CONVERSATION_ID"], "scene": name,
    })
    assert receipt["conversation_id"] == env["RICH_CONVERSATION_ID"] and receipt["scene"] == name, receipt
    events = [event for event in runner.api(path + "/events?limit=200")["events"] if event["seq"] > before]
    (runner.OUT / f"rich-{name}-events.json").write_text(json.dumps(events, ensure_ascii=False, indent=2))
    matching = []
    for reply in events:
        if reply["type"] != "message.agent":
            continue
        text = reply["data"].get("text", "")
        for block, body in enumerate(re.findall(r"(?m)^```wandrun-ui[ \t]*\n(.*?)^```[ \t]*$", text, re.S)):
            delivered = json.loads(body)
            metadata = reply["data"].get("ui", [])
            if delivered == SCENARIOS[name] and any(
                item.get("block") == block and item.get("valid") for item in metadata
            ):
                matching.append((reply, block, delivered))
    assert len(matching) == 1, f"{name}: scene did not persist one exact valid UI block; see events evidence"
    reply, block, delivered = matching[0]
    env["RICH_LAST_SEQ"] = reply["seq"]
    media = {}
    for element, item in delivered["elements"].items():
        if item["type"] not in ("Image", "MediaCard", "Gallery"):
            continue
        count = len(item["props"]["items"]) if item["type"] == "Gallery" else 1
        for index in range(count):
            resource = path + f"/messages/{reply['seq']}/media/{block}/{element}/{index}"
            details = runner.api(resource)
            assert details["width"] > 0 and details["height"] > 0 and details["mime"] == "image/png", details
            request = Request(runner.GATEWAY + resource + "/content",
                              headers={"Authorization": "Bearer " + runner.TOKEN})
            with urlopen(request, timeout=30) as response:
                content = response.read()
                assert response.headers.get_content_type() == details["mime"], "Media MIME mismatch"
            assert content.startswith(b"\x89PNG\r\n\x1a\n"), "Scene media is not a PNG resource"
            filename = f"rich-{name}-{element}-{index}.png"
            (runner.OUT / filename).write_bytes(content)
            media[f"{element}/{index}"] = {**details, "artifact": filename, "bytes": len(content)}
    if media:
        (runner.OUT / f"rich-{name}-media.json").write_text(json.dumps(media, indent=2))
    # Use the existing target route because virtualized chat extents are not
    # exposed reliably by Android accessibility. This is navigation, not proof of paint.
    runner.ad("open", runner.EXPO.rstrip("/") + "/--/chat?id="
              + env["RICH_CONVERSATION_ID"] + "&message_seq=" + str(reply["seq"]), "--foreground")
    runner.ad("wait", 'id="chat-agent-name"', "30000")
    runner.ad("wait", "stable", "500", "30000")
    runner.dismiss_known_dev_overlay()


def _snapshot(runner, name):
    nodes = runner.ad("snapshot", "-i")["nodes"]
    (runner.OUT / f"rich-{name}-snapshot.json").write_text(json.dumps(nodes, ensure_ascii=False, indent=2))
    assert not any(node.get("id", node.get("identifier")) == "rich-invalid" or
        "无法显示的界面" in str(node.get("label") or node.get("text") or "") for node in nodes), (
        name + ": invalid UI block visible")


def _chart_geometry(nodes, name):
    kind = "line" if name == "line" else "bar"
    props = next(item["props"] for item in SCENARIOS[name]["elements"].values()
                 if item["type"] == ("LineChart" if kind == "line" else "BarChart"))
    labels = props["xLabels" if kind == "line" else "labels"]
    plot_node = next((item for item in reversed(nodes)
                      if item.get("id", item.get("identifier")) == f"rich-{kind}-plot" and item.get("rect")), None)
    assert plot_node, f"{name}: native plot geometry missing"
    plot = plot_node["rect"]
    # Captions in the readout repeat the category name; only the axis inside this plot is a touch target.
    captions = [item for item in nodes if (rect := item.get("rect"))
                and plot["y"] <= rect["y"] < plot["y"] + plot["height"]]
    first = _identified(captions, "rich-line-label-0") if kind == "line" else _labelled(captions, labels[0])
    target = _identified(captions, "rich-line-label-1") if kind == "line" else _labelled(captions, labels[1])
    assert all(item and item.get("rect") for item in (first, target)), f"{name}: category captions missing"
    expected = labels[1] + " · " + "；".join(
        f"{series['name']}：{series['values'][1]} {props['unit']}" for series in props["series"])
    if props.get("horizontal"):
        start = {"x": plot["x"] + plot["width"] * 0.65,
                 "y": first["rect"]["y"] + first["rect"]["height"] / 2}
        end = {**start, "y": target["rect"]["y"] + target["rect"]["height"] / 2}
    else:
        start = {"x": first["rect"]["x"] + first["rect"]["width"] / 2,
                 "y": plot["y"] + plot["height"] / 2}
        end = {**start, "x": target["rect"]["x"] + target["rect"]["width"] / 2}
    return {"plot": plot, "start": start, "end": end, "expected": expected,
            "legend": "；".join(series["name"] for series in props["series"])}


def _chart_frame(nodes, kind):
    """Native bounds prove both stable item height and stable in-list position."""
    identities = [f"rich-{kind}-chart", "rich-block",
                  "rich-pie-readout-slot" if kind == "pie" else "rich-chart-readout", f"rich-{kind}-plot"]
    frame = {}
    for identity in identities:
        item = _identified(reversed(nodes), identity)
        assert item and item.get("rect"), f"{identity}: native frame missing"
        frame[identity] = item["rect"]
        assert item["rect"]["height"] > 0, f"{identity}: no native height"
    return frame


def _assert_chart_frame(before, nodes, kind):
    after = _chart_frame(nodes, kind)
    for identity, rect in before.items():
        for dimension in ("x", "y", "width", "height"):
            assert abs(rect[dimension] - after[identity][dimension]) <= 1, (
                f"{kind}: selection changed {identity}.{dimension}: {rect} -> {after[identity]}")
    return after


def _chart_readout(nodes, kind):
    chart = _identified(reversed(nodes), f"rich-{kind}-chart")["rect"]
    return next((item for item in reversed(nodes)
                 if item.get("id", item.get("identifier")) == "rich-chart-readout"
                 and (rect := item.get("rect")) and chart["y"] <= rect["y"] < chart["y"] + chart["height"]), None)


def _chart_touch(runner, name):
    """Tap/toggle, drag/hold/toggle, stable native item bounds, then outside-drawer control."""
    runner.ad("wait", "stable", "500", "10000")
    nodes = runner.ad("snapshot")["nodes"]
    geometry = _chart_geometry(nodes, name)
    kind = "line" if name == "line" else "bar"
    before = _chart_frame(nodes, kind)
    initial = _chart_readout(nodes, kind)
    assert initial and (initial.get("label") or initial.get("text")) == geometry["legend"], (
        f"{name}: chart must start without a selected category")
    states = []
    runner.ad("screenshot", str(runner.OUT / f"rich-{name}-before-native-drag.png"))
    start, end = geometry["start"], geometry["end"]
    for event in ("tap", "clear-tap", "drag", "clear-drag"):
        if event == "drag":
            runner.ad("gesture", "pan", str(round(start["x"])), str(round(start["y"])),
                      str(round(end["x"] - start["x"])), str(round(end["y"] - start["y"])), "900")
        else:
            runner.ad("press", str(round(end["x"])), str(round(end["y"])))
        runner.ad("wait", "stable", "500", "10000")
        nodes = runner.ad("snapshot")["nodes"]
        selected = _chart_readout(nodes, kind)
        expected = geometry["legend"] if event.startswith("clear-") else geometry["expected"]
        assert selected and (selected.get("label") or selected.get("text")) == expected, (
            f"{name}/{event}: category selection did not match the expected all-series readout")
        assert not _identified(nodes, "drawer-agents"), f"{name}/{event}: chart opened the drawer"
        states.append({"event": event, "readout": expected, "frame": _assert_chart_frame(before, nodes, kind)})
        if event == "tap":
            runner.ad("screenshot", str(runner.OUT / f"rich-{name}-selected-native.png"))
    (runner.OUT / f"rich-{name}-touch.json").write_text(json.dumps(
        {**geometry, "before": before, "states": states}, ensure_ascii=False, indent=2))
    # A same-direction right swipe above the plot must still open the actual drawer.
    plot = geometry["plot"]
    runner.ad("gesture", "pan", str(round(plot["x"] + plot["width"] * 0.2)),
              str(round(plot["y"] - 60)), str(round(plot["width"] * 0.6)), "0", "600")
    runner.ad("wait", 'id="drawer-agents"', "10000")
    runner.ad("screenshot", str(runner.OUT / f"rich-{name}-drawer-control.png"))
    runner.ad("back", "--settle")


def _pie_touch(runner):
    runner.ad("wait", "stable", "500", "10000")
    nodes = runner.ad("snapshot")["nodes"]
    before = _chart_frame(nodes, "pie")
    legend = _identified(reversed(nodes), "rich-pie-point-1")
    assert legend and legend.get("rect"), "Pie: second legend row missing"
    rect, plot = legend["rect"], before["rich-pie-plot"]
    baseline = runner.OUT / "rich-pie-before-native.png"
    runner.ad("screenshot", str(baseline))
    states = []
    # This fixed scene's first sector covers the right-hand mid-radius.
    contacts = [("legend", 1, rect["x"] + rect["width"] / 2, rect["y"] + rect["height"] / 2),
                ("sector", 0, plot["x"] + plot["width"] / 2 + plot["height"] * 0.2,
                 plot["y"] + plot["height"] / 2)]
    for origin, index, x, y in contacts:
        target = _identified(reversed(nodes), f"rich-pie-point-{index}")
        assert target and not target.get("selected"), "Pie: no sector may start selected"
        for selected in (True, False):
            runner.ad("press", str(round(x)), str(round(y)))
            runner.ad("wait", "stable", "500", "10000")
            nodes = runner.ad("snapshot")["nodes"]
            point = _identified(reversed(nodes), f"rich-pie-point-{index}")
            assert point and bool(point.get("selected")) == selected, f"Pie: {origin} did not toggle"
            readout = _chart_readout(nodes, "pie")
            if selected:
                assert readout and (readout.get("label") or readout.get("text")) == target["label"], "Pie: raw selected value missing"
                filename = "rich-pie-selected-native.png" if origin == "legend" else "rich-pie-sector-selected-native.png"
                runner.ad("screenshot", str(runner.OUT / filename))
            else:
                assert readout is None, "Pie: selected readout remained after toggle"
            states.append({"origin": origin, "selected": selected, "frame": _assert_chart_frame(before, nodes, "pie")})
    cleared = runner.OUT / "rich-pie-cleared-native.png"
    runner.ad("screenshot", str(cleared))
    box = tuple(round(value) for value in (plot["x"], plot["y"], plot["x"] + plot["width"], plot["y"] + plot["height"]))
    with Image.open(baseline) as original, Image.open(cleared) as restored:
        same_plot = ImageChops.difference(original.crop(box).convert("RGB"), restored.crop(box).convert("RGB")).getbbox() is None
    assert same_plot, "Pie: cancelling the actual sector left focused drawing behind"
    (runner.OUT / "rich-pie-touch.json").write_text(json.dumps(
        {"before": before, "states": states, "plot_restored": same_plot}, indent=2))


def _identified(nodes, identity):
    return next((node for node in nodes if node.get("id", node.get("identifier")) == identity), None)


def _labelled(nodes, label):
    return next((node for node in nodes if (node.get("label") or node.get("text")) == label), None)


def _source_before_swipe(runner, env):
    runner.ad("wait", "stable", "500", "30000")
    nodes = runner.ad("snapshot", "-i")["nodes"]
    runner.require_expo()
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




def _source_returned(runner):
    """Continue only after the user's explicit external-browser handoff has returned."""
    runner.require_expo()
    nodes = runner.ad("snapshot", "-i")["nodes"]
    assert _identified(nodes, "rich-source-toggle"), "Source conversation was not restored from browser"
    assert _identified(nodes, "rich-source-rail"), "Source expanded state was lost on browser return"




def _gallery_before_swipe(runner, env):
    runner.ad("wait", "stable", "500", "30000")
    # Page indicator/caption are static text, not interactive AX nodes.
    nodes = runner.ad("snapshot")["nodes"]
    first = _labelled(nodes, "查看图片 横滑第一张标志")
    assert first and first.get("rect") and _identified(nodes, "rich-gallery"), "Gallery image missing"
    assert _labelled(nodes, "1 / 3") and _labelled(nodes, "横滑第一张"), "Gallery initial page is not first"
    env["RICH_GALLERY_START_X"] = first["rect"]["x"]
    env["RICH_GALLERY_START_WIDTH"] = first["rect"]["width"]


def _gallery_after_swipe(runner, env):
    runner.ad("wait", "stable", "500", "30000")
    nodes = runner.ad("snapshot")["nodes"]
    pages = [(page, _labelled(nodes, f"{page} / 3")) for page in range(2, 4)]
    page = next((page for page, indicator in pages if indicator), None)
    assert page is not None, "Real gallery swipe did not advance the page indicator"
    names = ("横滑第一张", "横滑第二张", "横滑第三张")
    runner.ad("wait", "label=" + json.dumps(f"查看图片 {names[page - 1]}标志", ensure_ascii=False), "10000")
    nodes = runner.ad("snapshot")["nodes"]
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




def _scroll_row_outside(runner):
    """Use the existing audio-native edge contact, with freshly measured exclusion bounds."""
    runner.require_expo()
    nodes = runner.ad("snapshot")["nodes"]
    heading = _labelled(nodes, "横滑区域外")
    rail = _identified(nodes, "rich-scroll-row")
    assert heading and rail and heading.get("rect") and rail.get("rect"), "ScrollRow control geometry missing"
    root = max((item["rect"] for item in nodes if item.get("rect") and
                item.get("bundleId") == "host.exp.exponent"), key=lambda item: item["width"] * item["height"])
    x = round(root["x"] + root["width"] * 0.08)
    y = round(heading["rect"]["y"] + heading["rect"]["height"] / 2)
    rect = rail["rect"]
    assert not (rect["x"] <= x <= rect["x"] + rect["width"] and rect["y"] <= y <= rect["y"] + rect["height"])
    contact = [x, y, round(root["width"] * 0.7), 0, 700]
    evidence = {"heading": heading["rect"], "rail": rect, "root": root, "pan": contact}
    path = runner.OUT / "rich-layout-outside.json"
    path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
    runner.ad("gesture", "pan", *map(str, contact))
    runner.ad("wait", 'label="关闭对话列表"', "10000")
    drawer = _labelled(runner.ad("snapshot")["nodes"], "关闭对话列表")
    evidence["drawer_open"] = bool(drawer and drawer.get("hittable"))
    path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
    assert evidence["drawer_open"], "Outside ScrollRow drag did not open the drawer"


def action(runner, env, name):
    """Deliver one fixed scene or assert persisted/native geometry at a YAML hook."""
    if name in SCENARIOS:
        _request(runner, env, name)
    elif name == "scroll-row-gestures":
        runner.replay_steps("rich", env, source=(runner.ROOT / "rich-layout.yaml").read_text())
    elif name == "scroll-row-outside":
        _scroll_row_outside(runner)
    elif name in ("touch-line", "touch-bar", "touch-bar-horizontal"):
        _chart_touch(runner, name.removeprefix("touch-"))
    elif name == "touch-pie":
        _pie_touch(runner)
    elif name == "source-before-swipe":
        _source_before_swipe(runner, env)
    elif name == "source-after-swipe":
        _source_after_swipe(runner, env)
    elif name == "source-returned":
        _source_returned(runner)
    elif name == "gallery-before-swipe":
        _gallery_before_swipe(runner, env)
    elif name == "gallery-after-swipe":
        _gallery_after_swipe(runner, env)
    elif name == "gallery-viewer":
        _gallery_viewer(runner, env)
    elif name in ("gallery-pinch", "mermaid-pinch"):
        identity = "media-zoom-viewport" if name == "gallery-pinch" else "mermaid-ready"
        rect = runner.ad("get", "attrs", f'id="{identity}"')["node"]["rect"]
        runner.ad("gesture", "pinch", "2", str(rect["x"] + rect["width"] / 2),
                  str(rect["y"] + rect["height"] / 2))
        runner.ad("wait", "stable", "500", "10000")
        if name == "gallery-pinch":
            zoom = _identified(runner.ad("snapshot")["nodes"], "media-zoom-value")
            text = (zoom.get("label") or zoom.get("text") or "") if zoom else ""
            assert text.endswith("×") and float(text[:-1].replace(",", ".")) > 1, (
                "Real gallery pinch did not increase zoom")
        else:
            runner.ad("wait", 'id="mermaid-full-reset"', "10000")
    elif name.startswith("check-"):
        _snapshot(runner, name.removeprefix("check-"))
    else:
        raise RuntimeError("Unknown rich regression hook: " + name)
