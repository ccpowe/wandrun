"""Controlled browser page and native handoff evidence for run.py.

start_fixture(env, run_id) returns the owned HTTP server used by the existing
shutdown/cleanup path. action(runner, env, name, server) observes only real page
POSTs and gateway state; visual/manual hooks separately verify Skia paint.
"""

from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import time
from urllib.parse import quote

from PIL import Image, ImageChops


def start_fixture(env, run_id):
    """Serve one isolated page; never focus/type/click/drag on the user's behalf."""
    marker = "E2E browser " + run_id
    page = ("<!doctype html><html><head><meta charset='utf-8'><title>" + escape(marker)
        + "</title><style>body{font:24px sans-serif;margin:32px;min-height:2400px;background:#f8fafc;color:#172554}"
        "button,input{font:24px sans-serif;padding:16px;margin:16px 0;display:block}"
        "#click{background:#ee00ee}"
        "#track{height:150px;position:relative;border:3px dashed #64748b;margin:24px 0}"
        "#drag{position:absolute;left:16px;top:24px;width:140px;height:90px;background:#2563eb;"
        "color:white;display:grid;place-items:center;touch-action:none;user-select:none}"
        "</style></head><body><h1>" + escape(marker) + "</h1>"
        "<button id='click'>Phone click: 0</button>"
        "<div id='track'><div id='drag'>Drag me →</div></div>"
        "<label for='e2e-field'>Phone input</label>"
        "<input id='e2e-field' aria-label='Phone input' type='text'>"
        "<script>const post=(path,data)=>fetch(path,{method:'POST',body:JSON.stringify(data)});"
        "const button=document.getElementById('click');let clicks=0;"
        "button.addEventListener('click',event=>{button.textContent='Phone click: '+(++clicks);"
        "post('/event',{kind:'click',trusted:event.isTrusted,count:clicks,x:event.clientX,y:event.clientY});});"
        "const tile=document.getElementById('drag');let origin=null;"
        "tile.addEventListener('pointerdown',event=>{origin={x:event.clientX,y:event.clientY,left:tile.offsetLeft};"
        "tile.setPointerCapture(event.pointerId);});"
        "tile.addEventListener('pointermove',event=>{if(origin)tile.style.left=(origin.left+event.clientX-origin.x)+'px';});"
        "tile.addEventListener('pointerup',event=>{if(!origin)return;"
        "post('/event',{kind:'drag',trusted:event.isTrusted,dx:event.clientX-origin.x,dy:event.clientY-origin.y,"
        "start:origin.left,end:tile.offsetLeft});origin=null;});"
        "tile.addEventListener('pointercancel',()=>{origin=null;});"
        "const field=document.getElementById('e2e-field');"
        "field.addEventListener('focus',event=>post('/event',{kind:'focus',trusted:event.isTrusted}));"
        "field.addEventListener('input',()=>fetch('/input',{method:'POST',body:field.value}));"
        "addEventListener('scroll',event=>post('/event',{kind:'scroll',trusted:event.isTrusted,y:scrollY}));"
        "document.addEventListener('pointermove',event=>post('/event',{kind:'move',trusted:event.isTrusted,"
        "x:event.clientX,y:event.clientY,buttons:event.buttons,pointerType:event.pointerType}));"
        "document.addEventListener('pointerup',event=>post('/event',{kind:'release',trusted:event.isTrusted,"
        "x:event.clientX,y:event.clientY,pointerType:event.pointerType}));"
        "const geometry=()=>{const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();"
        "return {x:r.x,y:r.y,width:r.width,height:r.height};};"
        "const vv=visualViewport;"
        "post('/geometry',{width:innerWidth,height:innerHeight,clientWidth:document.documentElement.clientWidth,"
        "clientHeight:document.documentElement.clientHeight,devicePixelRatio,"
        "visualViewport:vv?{width:vv.width,height:vv.height,scale:vv.scale,x:vv.offsetLeft,y:vv.offsetTop}:null,"
        "click:rect('click'),drag:rect('drag'),input:rect('e2e-field')});};"
        "addEventListener('resize',geometry);geometry();"
        "</script></body></html>").encode()

    class Page(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/":
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.end_headers()
            self.wfile.write(page)

        def do_POST(self):
            if self.path not in ("/input", "/event", "/geometry"):
                self.send_error(404)
                return
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 <= size <= 4096:
                self.send_error(413)
                return
            value = self.rfile.read(size).decode("utf-8")
            with server.input_changed:
                if self.path == "/input":
                    server.inputs.append(value)
                elif self.path == "/geometry":
                    server.geometry = json.loads(value)
                else:
                    server.events.append(json.loads(value))
                server.input_changed.notify_all()
            self.send_response(204)
            self.end_headers()

        def log_message(self, format, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Page)
    server.daemon_threads = True
    server.input_changed = threading.Condition()
    server.inputs = []
    server.events = []
    server.geometry = None
    server.thread = threading.Thread(target=server.serve_forever, daemon=True)
    server.thread.start()
    env.update({"BROWSER_URL": f"http://127.0.0.1:{server.server_port}/",
                "BROWSER_TITLE": marker, "BROWSER_INPUT": "phone-" + run_id})
    return server


def _wait(load, matches):
    deadline = time.monotonic() + 20
    while True:
        value = load()
        if matches(value):
            return value
        assert time.monotonic() < deadline, f"Browser endpoint did not settle: {value}"
        time.sleep(0.25)


def _layout(runner, name):
    nodes = runner.ad("snapshot", "-i")["nodes"]
    identities = ("takeover-handback", "takeover-more", "takeover-mode", "takeover-url")
    controls = {node.get("id", node.get("identifier")): node for node in nodes
                if node.get("id", node.get("identifier")) in identities and node.get("hittable")}
    assert all(controls.get(identity, {}).get("rect") for identity in identities[:3]), controls
    if name == "landscape":
        # browser.B6 landscape B: no address bar; handback above the dock in one right column,
        # sharing its midline; the wheel alone at the far left.
        assert "takeover-url" not in controls, controls
        handback, more, mode = (controls[identity]["rect"] for identity in identities[:3])
        def middle(rect):
            return rect["x"] + rect["width"] / 2
        assert abs(middle(handback) - middle(more)) <= 4 and abs(middle(mode) - middle(more)) <= 4, controls
        assert handback["y"] < mode["y"] < more["y"], controls
        wheel = next((node["rect"] for node in nodes if node.get("label") == "滚动条" and node.get("rect")), None)
        assert wheel and wheel["x"] + wheel["width"] < handback["x"] and wheel["x"] < handback["x"] / 4, (wheel, controls)
        controls["滚动条"] = {"rect": wheel}
    else:
        assert controls.get("takeover-url", {}).get("rect"), controls
    (runner.OUT / f"browser-{name}-geometry.json").write_text(json.dumps(controls, ensure_ascii=False, indent=2))


def _canvas(nodes, geometry):
    """Read the centered picture viewport independently of its touchpad and controls."""
    by_id = {node.get("id", node.get("identifier")): node for node in nodes}
    picture_node = by_id["browser-picture"]
    canvas = picture_node["rect"]
    stage = by_id["browser-stage"]["rect"]
    root = max((node["rect"] for node in nodes if node.get("rect")
                and node.get("bundleId") == picture_node.get("bundleId")),
               key=lambda rect: rect["width"] * rect["height"])
    overlays = {label: next(node["rect"] for node in nodes if node.get("label") == label)
                for label in ("左键", "右键", "滚动条")}
    left, right, wheel = (overlays[label] for label in ("左键", "右键", "滚动条"))
    # takeover-lab/layout.ts: 52dp square buttons, 16dp gap, 12dp bottom margin (browser.B8).
    # Portrait centers the picture on the whole screen, raises it only to clear the
    # bottom control band and shrinks it only when it cannot fit; the trackpad extends beyond it.
    unit = left["width"] / 52
    assert unit > 0
    assert all(abs(value - 52 * unit) <= 2 for value in
               (left["height"], right["width"], right["height"])), overlays
    assert abs(right["x"] - left["x"] - 68 * unit) <= 2, overlays
    assert abs(right["y"] - left["y"]) <= 2, overlays
    assert abs((left["x"] + right["x"] + right["width"]) / 2 - stage["x"] - stage["width"] / 2) <= 2, overlays
    assert abs(wheel["width"] - 52 * unit) <= 2, overlays
    assert abs(canvas["x"] - stage["x"]) <= 1 and "takeover-url" in by_id, by_id
    bottom = left["y"] + left["height"] + 12 * unit
    reserved = max(wheel["height"], 52 * unit) + 12 * unit
    room = max(0, stage["height"] - reserved)
    expected_height = min(room, stage["width"] * geometry["height"] / geometry["width"])
    assert abs(canvas["height"] - expected_height) <= 2, (canvas, stage, geometry)
    centered = root["y"] + (root["height"] - expected_height) / 2
    expected_top = max(stage["y"], min(centered, stage["y"] + room - expected_height))
    assert abs(canvas["y"] - expected_top) <= 2, (canvas, stage, root)
    assert canvas["width"] > 0 and canvas["height"] > 0, canvas
    picture_bottom = canvas["y"] + canvas["height"]
    assert picture_bottom <= bottom - reserved + 2, (canvas, overlays)
    assert abs(wheel["y"] + wheel["height"] - left["y"] - left["height"]) <= 2, overlays
    assert abs(stage["x"] + stage["width"] - wheel["x"] - wheel["width"] - 24 * unit) <= 2, overlays
    dock = by_id["takeover-keyboard"]["rect"]
    assert 0 <= dock["y"] - bottom <= 64 * unit, (canvas, dock)
    return canvas, root, overlays, unit


def _zoom_projection(runner, server, geometry, canvas, scale, offset, evidence):
    """Tap pixels actually painted after zoom/pan, not a point computed from the input mapper."""
    button = geometry["click"]
    focal = (round(canvas["x"] + canvas["width"] / 2),
             round(offset[1] + (button["y"] + button["height"] / 2) * scale))
    pan = [round(canvas["x"] + canvas["width"] * 0.2), focal[1],
           round(canvas["width"] * 0.6), round(-canvas["height"] * 0.04), 700]
    try:
        runner.ad("gesture", "pinch", "2", *map(str, focal))
        runner.ad("gesture", "pan", *map(str, pan))
        screenshot = runner.OUT / "browser-pointer-zoom.png"
        bounds = tuple(round(value) for value in (
            canvas["x"], canvas["y"], canvas["x"] + canvas["width"], canvas["y"] + canvas["height"]))
        def painted_button():
            runner.ad("screenshot", str(screenshot))
            with Image.open(screenshot) as image:
                red, green, blue = image.crop(bounds).convert("RGB").split()
                mask = ImageChops.multiply(
                    ImageChops.multiply(red.point(lambda value: 255 if value > 180 else 0),
                                        blue.point(lambda value: 255 if value > 180 else 0)),
                    green.point(lambda value: 255 if value < 80 else 0))
                return mask.getbbox()

        # Native gesture completion does not acknowledge the next React/GPU
        # commit. Wait for this pan's visible end state, never a fixed sleep.
        box = _wait(painted_button, lambda value: value is not None
                    and 0 < value[0] < value[2] < bounds[2] - bounds[0]
                    and value[2] - value[0] > button["width"] * scale * 1.5)
        point = (round(bounds[0] + box[0] + (box[2] - box[0]) / 4),
                 round(bounds[1] + (box[1] + box[3]) / 2))
        expected = {"x": button["x"] + button["width"] / 4,
                    "y": button["y"] + button["height"] / 2}
        proof = {"remote": geometry, "canvas": canvas, "pinch": 2, "focal": focal, "pan": pan,
                 "visible_button_in_canvas": box, "physical_point": point, "expected_css": expected}
        artifact = runner.OUT / "browser-pointer-zoom-geometry.json"
        artifact.write_text(json.dumps(proof, indent=2))
        with server.input_changed:
            start = len(server.events)
        runner.ad("press", *map(str, point), "--settle")
        actual = evidence(lambda item: item.get("kind") == "click" and item.get("trusted") is True,
                          "Native zoomed visible button did not receive the touch", start)
        proof["actual_css"] = actual
        artifact.write_text(json.dumps(proof, indent=2))
        assert all(abs(actual[axis] - expected[axis]) <= 3 for axis in ("x", "y")), proof
    finally:
        runner.ad("gesture", "pinch", "0.25", *map(str, focal))


def _pointer(runner, server):
    """Map DOM geometry to the native canvas; Skia has no AX children for page controls."""
    with server.input_changed:
        assert server.input_changed.wait_for(lambda: server.geometry is not None, timeout=20), "Page geometry missing"
        geometry = dict(server.geometry)
        pointer_start = len(server.events)
    nodes = runner.ad("snapshot")["nodes"]
    (runner.OUT / "browser-pointer-snapshot.json").write_text(json.dumps(nodes, ensure_ascii=False, indent=2))
    canvas, root, overlays, native_unit = _canvas(nodes, geometry)
    left = overlays["左键"]
    viewport = geometry["visualViewport"]
    assert geometry["width"] > 0 and geometry["height"] > 0, geometry
    assert viewport and abs(viewport["scale"] - 1) < 0.001, geometry
    assert abs(viewport["width"] - geometry["clientWidth"]) <= 1 and abs(viewport["height"] - geometry["clientHeight"]) <= 1, geometry
    assert abs(viewport["x"]) <= 1 and abs(viewport["y"]) <= 1, geometry
    scale = min(canvas["width"] / geometry["width"], canvas["height"] / geometry["height"])
    offset = (canvas["x"] + (canvas["width"] - geometry["width"] * scale) / 2,
              canvas["y"] + (canvas["height"] - geometry["height"] * scale) / 2)

    def center(rect):
        return rect["x"] + rect["width"] / 2, rect["y"] + rect["height"] / 2

    def mode(wanted):
        current = next(node for node in runner.ad("snapshot", "-i")["nodes"]
                       if node.get("id", node.get("identifier")) == "takeover-mode")
        if wanted not in current.get("label", ""):
            runner.ad("press", 'id="takeover-mode"', "--settle")
        runner.ad("wait", 'id="takeover-mode" label=' + json.dumps(
            "当前" + wanted + "模式，点按切换", ensure_ascii=False), "10000")

    def evidence(predicate, description, start=None):
        if start is None:
            start = pointer_start
        with server.input_changed:
            received = server.input_changed.wait_for(
                lambda: any(predicate(item) for item in server.events[start:]), timeout=20)
            events = list(server.events)
        (runner.OUT / "browser-pointer-events.json").write_text(json.dumps(events, indent=2))
        assert received, description + "; see browser-pointer-events.json"
        return next(item for item in reversed(events[start:]) if predicate(item))

    def move(dx, dy):
        # One canvas contact, away from the overlay regions. The production gain
        # is 1; native pixels / fitted CSS scale also cancels Android's dp density.
        sx = canvas["x"] + canvas["width"] / 2 - dx / 2
        sy = canvas["y"] + canvas["height"] / 2 - dy / 2
        assert all(canvas["x"] < x < canvas["x"] + canvas["width"] for x in (sx, sx + dx))
        assert all(canvas["y"] < y < canvas["y"] + canvas["height"] for y in (sy, sy + dy))
        runner.ad("gesture", "pan", str(round(sx)), str(round(sy)), str(round(dx)), str(round(dy)), "600")

    projected = {"x": offset[0], "y": offset[1], "width": geometry["width"] * scale,
                 "height": geometry["height"] * scale}
    details = {"remote": geometry, "canvas": canvas, "frame": projected, "app": root,
               "scale": scale, "offset": offset, "native_pixels_per_dp": native_unit,
               "overlays": overlays}
    (runner.OUT / "browser-pointer-geometry.json").write_text(json.dumps(details, indent=2))
    for target in ("click", "drag", "input"):
        x, y = center(geometry[target])
        assert 0 < x < geometry["width"] and 0 < y < geometry["height"], (target, geometry)

    # Coordinates are intentional fallback: the captured native tree contains
    # only a Skia JPEG, never semantic children for the remote DOM controls.
    mode("触控")
    x, y = center(geometry["click"])
    runner.ad("screenshot", str(runner.OUT / "browser-pointer-before.png"))
    runner.ad("press", str(round(offset[0] + x * scale)), str(round(offset[1] + y * scale)), "--settle")
    evidence(lambda item: item.get("kind") == "click" and item.get("trusted") is True,
             "Native touch did not reach the remote button")
    _zoom_projection(runner, server, geometry, canvas, scale, offset, evidence)
    mode("鼠标")
    # Touch click sends absolute CDP coordinates but does not update pointerRef;
    # switching modes preserves that local pointer (screen.tsx apply/setMode).
    # A native mouse probe and tap report pointerRef through a trusted pointerup,
    # after every move has flushed. Do not assume a center or last-touch cursor.
    with server.input_changed:
        move_start = len(server.events)
    move(40 * scale, 0)
    runner.ad("press", str(round(canvas["x"] + canvas["width"] / 2)),
              str(round(canvas["y"] + canvas["height"] / 2)), "--settle")
    pointer = evidence(lambda item: item.get("kind") == "release" and item.get("trusted") is True,
                       "Native mouse probe missing", move_start)
    # browser.B9: blank band space left of the buttons is trackpad too — a slide moves
    # the pointer by the same relative amount, a tap there never clicks.
    lx, ly = center(left)
    band_x = stage["x"] + 24 * native_unit
    assert band_x + 40 * scale < left["x"] - 8 * native_unit, "Band blank space too narrow"
    with server.input_changed:
        band_start = len(server.events)
    runner.ad("gesture", "pan", str(round(band_x)), str(round(ly)), str(round(40 * scale)), "0", "600")
    band_moved = evidence(lambda item: item.get("kind") == "move" and item.get("trusted") is True
                          and abs(item.get("x", -1000) - pointer["x"] - 40) <= 3
                          and abs(item.get("y", -1000) - pointer["y"]) <= 3,
                          "Band blank slide did not move the remote pointer", band_start)
    with server.input_changed:
        tap_start = len(server.events)
    runner.ad("press", str(round(band_x)), str(round(ly)), "--settle")
    with server.input_changed:
        clicked = server.input_changed.wait_for(
            lambda: any(item.get("kind") in ("down", "release", "click") for item in server.events[tap_start:]), timeout=3)
    assert not clicked, "Tap on blank band space clicked the remote page"
    with server.input_changed:
        probe_start = len(server.events)
    runner.ad("press", str(round(canvas["x"] + canvas["width"] / 2)),
              str(round(canvas["y"] + canvas["height"] / 2)), "--settle")
    pointer = evidence(lambda item: item.get("kind") == "release" and item.get("trusted") is True,
                       "Native mouse probe after band slide missing", probe_start)
    x, y = center(geometry["drag"])
    with server.input_changed:
        aim_start = len(server.events)
    move((x - pointer["x"]) * scale, (y - pointer["y"]) * scale)
    aimed = evidence(lambda item: item.get("kind") == "move" and item.get("trusted") is True
                     and abs(item.get("x", -1000) - x) <= 3 and abs(item.get("y", -1000) - y) <= 3,
                     "Native mouse did not reach the remote drag tile", aim_start)
    # agent-device 0.21.16's two-pointer pan uses a vertical span of 25% of the
    # viewport short side. Lower contact owns left-button; upper owns canvas.
    span = min(root["width"], root["height"]) * 0.25
    assert canvas["y"] < ly - span < left["y"], "Left-button and canvas cannot fit two native contacts"
    assert lx + round(120 * scale) < canvas["x"] + canvas["width"], "Native drag exceeds canvas"
    details.update({"band_slide": band_moved, "mouse_probe": pointer, "mouse_aim": aimed, "two_pointer_span": span,
                    "two_pointer_contacts": [[lx, ly - span], [lx, ly]]})
    (runner.OUT / "browser-pointer-geometry.json").write_text(json.dumps(details, indent=2))
    runner.ad("gesture", "pan", str(round(lx)), str(round(ly - span / 2)),
              str(round(120 * scale)), "0", "700", "--pointer-count", "2")
    evidence(lambda item: item.get("kind") == "drag" and item.get("trusted") is True
             and abs(item.get("dx", 0)) >= 80 and abs(item.get("end", 0) - item.get("start", 0)) >= 80,
             "Native left-button plus canvas drag did not move the remote tile")
    mode("触控")
    x, y = center(geometry["input"])
    runner.ad("press", str(round(offset[0] + x * scale)), str(round(offset[1] + y * scale)), "--settle")
    evidence(lambda item: item.get("kind") == "focus" and item.get("trusted") is True,
             "Native touch did not focus the real remote input")


def _scroll(runner, server):
    """Native wheel overlay must scroll the real page in both directions."""
    # keyboard-hide starts a native transition; wait for the dock's semantic
    # boundary instead of sampling an intermediate AX tree with no mode button.
    runner.ad("wait", 'id="takeover-mode"', "10000")
    mode = next(node for node in runner.ad("snapshot", "-i")["nodes"]
                if node.get("id", node.get("identifier")) == "takeover-mode")
    if "鼠标" not in mode.get("label", ""):
        runner.ad("press", 'id="takeover-mode"', "--settle")
    runner.ad("wait", 'id="takeover-mode" label="当前鼠标模式，点按切换"', "10000")
    with server.input_changed:
        assert server.input_changed.wait_for(lambda: server.geometry is not None, timeout=20), "Page geometry missing"
        geometry = dict(server.geometry)
    nodes = runner.ad("snapshot")["nodes"]
    _, _, overlays, unit = _canvas(nodes, geometry)
    wheel = overlays["滚动条"]
    x, y = wheel["x"] + wheel["width"] / 2, wheel["y"] + wheel["height"] / 2
    for direction in (1, -1):
        with server.input_changed:
            start = len(server.events)
            before = next((event["y"] for event in reversed(server.events) if event.get("kind") == "scroll"), 0)
        runner.ad("gesture", "pan", str(round(x)), str(round(y)), "0",
                  str(round(direction * 80 * unit)), "1200" if direction == 1 else "2400")
        with server.input_changed:
            received = server.input_changed.wait_for(
                lambda: any(event.get("kind") == "scroll" and event.get("trusted") is True
                            and direction * (event["y"] - before) > 20
                            for event in server.events[start:]), timeout=20)
            events = [event for event in server.events if event.get("kind") == "scroll"]
        (runner.OUT / "browser-scroll-events.json").write_text(json.dumps(events, indent=2))
        assert received, "Native wheel did not scroll the real page in the intended direction; see browser-scroll-events.json"
        if direction == 1:
            runner.ad("screenshot", str(runner.OUT / "browser-scroll-down.png"))


def action(runner, env, name, server):
    """Assert human input and one handoff endpoint; server must be this run's fixture."""
    assert server is not None, "Native browser hooks require the owned HTTP fixture"
    task_path = "/browser-tasks/" + quote(env["BROWSER_TASK_ID"], safe="")
    if name == "taken-over":
        task = _wait(lambda: runner.api(task_path), lambda item: item["state"] == "human")
        assert task["current"] == env["BROWSER_PAGE_ID"], task
        with server.input_changed:
            env["BROWSER_EVENT_START"] = len(server.events)
        _layout(runner, "portrait")
    elif name in ("portrait", "landscape"):
        _layout(runner, name)
    elif name == "pointer":
        _pointer(runner, server)
        def observed():
            events = server.events[env["BROWSER_EVENT_START"]:]
            return (any(item.get("kind") == "click" and item.get("trusted") is True for item in events)
                and any(item.get("kind") == "focus" and item.get("trusted") is True for item in events)
                and any(item.get("kind") == "drag" and item.get("trusted") is True
                    and abs(item.get("dx", 0)) >= 80 and abs(item.get("end", 0) - item.get("start", 0)) >= 80
                    for item in events))
        with server.input_changed:
            received = server.input_changed.wait_for(observed, timeout=20)
            events = list(server.events[env["BROWSER_EVENT_START"]:])
        (runner.OUT / "browser-pointer-events.json").write_text(json.dumps(events, indent=2))
        assert received, "Remote trusted click/focus/80px drag evidence missing; see browser-pointer-events.json"
        assert runner.api(task_path)["state"] == "human", "Pointer evidence must be collected during takeover"
    elif name == "scroll":
        _scroll(runner, server)
        assert runner.api(task_path)["state"] == "human", "Scroll must be observed during takeover"
    elif name == "input":
        with server.input_changed:
            received = server.input_changed.wait_for(lambda: env["BROWSER_INPUT"] in server.inputs, timeout=20)
            inputs = list(server.inputs)
        (runner.OUT / "browser-input-events.json").write_text(json.dumps(inputs, indent=2))
        assert received, f"Phone text did not reach the real remote input: {inputs}"
        assert runner.api(task_path)["state"] == "human", "Input must arrive during takeover"
    elif name == "handed-back":
        def matching():
            events = runner.api(runner.conversation_path(env["BROWSER_CONVERSATION_ID"]) + "/events?limit=200")["events"]
            return [item for item in events if item["type"] == "takeover.ended"
                    and item["data"]["id"] == env["BROWSER_TASK_ID"] and item["data"]["text"].endswith("已交还")]
        events = _wait(matching, bool)
        assert len(events) == 1, "Handback did not create one persisted system event"
        env["TAKEOVER_SEQ"] = events[0]["seq"]
        task = _wait(lambda: runner.api(task_path), lambda item: item["state"] == "agent")
        assert task["pages"], task
        (runner.OUT / "browser-handback.json").write_text(json.dumps({"events": events, "task": task}, ensure_ascii=False, indent=2))
    elif name == "closed":
        task = _wait(lambda: runner.api(task_path), lambda item: item["state"] == "released")
        assert not task["pages"], task
        assert not any(item["id"] == task["id"] and item["state"] != "released"
                       for item in runner.api("/browser-tasks")["browser_tasks"])
        (runner.OUT / "browser-closed.json").write_text(json.dumps(task, ensure_ascii=False, indent=2))
    else:
        raise RuntimeError("Unknown native browser hook: " + name)
