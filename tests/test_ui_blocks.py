"""Catalog, fence, tree and submitted-state behavior of inline UI blocks."""

from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

from wandrun.gateway.ui_blocks import delivery_blocks, image_attachments, markdown_image_urls, parse_blocks, submission_text, validate_values


CATALOG = json.loads(
    (Path(__file__).parents[1] / "src/wandrun/gateway/ui_catalog.json").read_text(encoding="utf-8")
)
PROPS = {
    "Stack": {}, "Card": {}, "Divider": {},
    "Heading": {"text": "标题"}, "Text": {"text": "说明"},
    "Badge": {"text": "运行中", "tone": "active"},
    "Status": {"title": "计划", "badge": {"text": "进行中", "tone": "active"}, "progress": 20, "caption": "详情"},
    "Metrics": {"items": [{"label": "费用", "value": "100", "hint": "月"}]},
    "KeyValue": {"items": [{"label": "状态", "value": "正常"}]},
    "Steps": {"items": [{"label": "准备", "state": "done", "note": "已完成"}]},
    "Progress": {"value": 100, "caption": "已完成"},
    "Table": {"columns": ["方案", "状态"], "rows": [["A", {"badge": {"text": "完成", "tone": "active"}}]]},
    "ChoiceGroup": {"stateKey": "choice", "label": "方案", "options": [{"value": "a", "label": "方案A", "disabled": True}, {"value": "b", "label": "方案B"}]},
    "Segmented": {"stateKey": "choice", "options": [{"value": "a", "label": "A"}, {"value": "b", "label": "B"}]},
    "MultiSelect": {"stateKey": "choice", "variant": "checklist", "options": [{"value": "a", "label": "A"}, {"value": "b", "label": "B"}]},
    "Select": {"stateKey": "choice", "label": "方案", "options": [{"value": "a", "label": "方案A", "disabled": True}, {"value": "b", "label": "方案B"}]},
    "Switch": {"stateKey": "choice", "label": "提醒"},
    "Slider": {"stateKey": "choice", "label": "进度", "min": 0.1, "max": 1.0, "step": 0.1},
    "TextInput": {"stateKey": "choice", "label": "备注", "multiline": True},
    "DateInput": {"stateKey": "choice", "label": "日期"},
    "LineChart": {"xLabels": ["一", "二"], "series": [{"name": "完成", "values": [1, 2]}]},
    "BarChart": {"labels": ["一"], "values": [0]},
    "PieChart": {"items": [{"label": "一", "value": 1}, {"label": "二", "value": 2}]},
    "Tabs": {"tabs": [{"label": "一"}, {"label": "二"}]},
    "Accordion": {"title": "细节"},
    "Grid": {"columns": 2},
    "Source": {"items": [{"url": "https://example.com/a"}, {"url": "https://www.iana.org/domains/reserved"}]},
    "LinkCard": {"url": "https://example.com/a", "title": "原文", "tags": ["网页"]},
    "FileTree": {"nodes": [{"path": "src/components/App.tsx", "note": "入口"}, {"path": "src/utils/"}]},
    "Icon": {"name": "circle-check"},
    "List": {"items": [{"text": "检查", "icon": "circle-check"}]},
    "Callout": {"tone": "warning", "text": "注意"},
    "Quote": {"text": "原话"},
    "Math": {"tex": "x^2", "display": True},
    "Image": {"attachment": "snapshot.png", "alt": "截图"},
    "MediaCard": {"url": "https://example.org/photo.png", "alt": "图片", "title": "照片"},
    "Gallery": {"items": [{"url": "https://example.org/photo.png", "alt": "照片"}]},
    "Mermaid": {"source": "flowchart LR\n A --> B"},
    "Submit": {"label": "提交"},
}
INITIAL = {
    "ChoiceGroup": "", "Select": "", "Segmented": "", "MultiSelect": [],
    "Switch": False, "Slider": 0.3, "TextInput": "", "DateInput": "",
}


def spec_for(kind: str):
    elements = {"root": {"type": "Stack", "props": {}, "children": ["item"]},
                "item": {"type": kind, "props": deepcopy(PROPS[kind]), "children": []}}
    state = {}
    if kind in ("Tabs", "Grid"):
        elements["item"]["children"] = ["tab1", "tab2"]
        for child in ("tab1", "tab2"):
            elements[child] = {"type": "Text", "props": {"text": child}, "children": []}
    if kind in INITIAL:
        elements["root"]["children"].append("submit")
        elements["submit"] = {"type": "Submit", "props": {"label": "发送"}, "children": []}
        state["choice"] = INITIAL[kind]
    return {"root": "root", "elements": elements, "state": state}


def fence(spec, marker="```"):
    return f"{marker}wandrun-ui\n{json.dumps(spec, ensure_ascii=False, allow_nan=False)}\n{marker}\n"


def parse(spec):
    return parse_blocks(fence(spec))[0]


class CatalogTests(unittest.TestCase):
    def test_shared_raw_numbers_are_finite_javascript_numbers(self):
        cases = json.loads(
            (Path(__file__).parent / "fixtures/ui_numbers.json").read_text(encoding="utf-8")
        )
        for case in cases:
            with self.subTest(name=case["name"]):
                # Keep literal spelling: Python preserves huge ints; JS parses them as doubles.
                blocks = parse_blocks(f'```wandrun-ui\n{case["source"]}\n```\n')
                self.assertEqual(len(blocks), 1)
                self.assertEqual(blocks[0].spec is not None, case["valid"], blocks[0].error)

    def test_all_contract_components_are_valid_and_authoritative(self):
        self.assertEqual(set(CATALOG["components"]), set(PROPS))
        for kind in PROPS:
            with self.subTest(kind=kind):
                block = parse(spec_for(kind)) if kind != "Submit" else None
                if block is not None:
                    self.assertEqual(block.metadata(), {"block": 0, "valid": True}, block.error)
                else:
                    self.assertIn("Submit", CATALOG["components"])

    def test_stack_justify_uses_catalog_enum_and_defaults_to_start(self):
        self.assertEqual(CATALOG["components"]["Stack"]["props"]["properties"]["justify"]["enum"],
                         ["start", "between"])
        for props in ({}, {"justify": "start"}, {"justify": "between",
                                                "direction": "horizontal", "gap": "sm"}):
            with self.subTest(props=props):
                spec = spec_for("Text")
                spec["elements"]["root"]["props"] = props
                block = parse(spec)
                self.assertIsNone(block.error)
                self.assertEqual(block.spec["elements"]["root"]["props"], props)
        for justify in ("end", "space-between", 1, None):
            with self.subTest(justify=justify):
                spec = spec_for("Text")
                spec["elements"]["root"]["props"]["justify"] = justify
                self.assertIn("$.elements.root.props.justify", parse(spec).error)

    def test_every_component_rejects_extra_prop_and_bad_shape(self):
        for kind in PROPS:
            with self.subTest(kind=kind):
                spec = spec_for(kind) if kind != "Submit" else spec_for("Text")
                if kind == "Submit":
                    spec["elements"]["item"] = {"type": "Submit", "props": deepcopy(PROPS["Submit"]), "children": []}
                spec["elements"]["item"]["props"]["unknown"] = True
                self.assertIn("$.elements.item.props.unknown", parse(spec).error)
                spec["elements"]["item"]["props"] = []
                self.assertIn("$.elements.item.props", parse(spec).error)

    def test_required_nested_fields_ranges_enums_and_string_bounds(self):
        changes = [
            ("Card", "title", "x" * 81, "props.title"),
            ("Heading", "text", "x" * 501, "props.text"),
            ("Text", "tone", "loud", "props.tone"),
            ("Badge", "tone", "okay", "props.tone"),
            ("Status", "badge", {"text": "ok", "tone": "unknown"}, "props.badge.tone"),
            ("Status", "progress", 101, "props.progress"),
            ("Metrics", "items", [], "props.items"),
            ("KeyValue", "items", [{"label": "a"}], "props.items[0].value"),
            ("Steps", "items", [{"label": "a", "state": "pending"}], "props.items[0].state"),
            ("Progress", "value", -1, "props.value"),
            ("Table", "columns", ["a"] * 6, "props.columns"),
            ("ChoiceGroup", "options", [{"value": "a", "label": "A"}], "props.options"),
            ("Segmented", "options", [{"value": "a", "label": "A"}] * 6, "props.options"),
            ("MultiSelect", "variant", "dropdown", "props.variant"),
            ("Switch", "label", 1, "props.label"),
            ("Slider", "step", 0, "props.step"),
            ("TextInput", "placeholder", "x" * 501, "props.placeholder"),
            ("DateInput", "label", "x" * 81, "props.label"),
            ("LineChart", "xLabels", ["a"], "props.xLabels"),
            ("LineChart", "series", [], "props.series"),
            ("BarChart", "values", [-1], "props.values[0]"),
            ("PieChart", "items", [{"label": "a", "value": 0}, {"label": "b", "value": 1}], "props.items[0].value"),
            ("Tabs", "tabs", [{"label": "一"}], "props.tabs"),
            ("Accordion", "defaultOpen", 1, "props.defaultOpen"),
            ("Image", "alt", "x" * 201, "props.alt"),
            ("MediaCard", "title", "x" * 81, "props.title"),
            ("Gallery", "items", [], "props.items"),
            ("FileTree", "nodes", [], "props.nodes"),
            ("Mermaid", "source", "", "props.source"),
        ]
        for kind, field, value, path in changes:
            with self.subTest(kind=kind, field=field):
                spec = spec_for(kind)
                spec["elements"]["item"]["props"][field] = value
                self.assertIn(path, parse(spec).error)
        missing = spec_for("ChoiceGroup")
        del missing["elements"]["item"]["props"]["options"]
        self.assertIn("$.elements.item.props.options", parse(missing).error)
        table = spec_for("Table")
        table["elements"]["item"]["props"]["rows"] = [["one"]]
        self.assertIn("$.elements.item.props.rows[0]", parse(table).error)
        slider = spec_for("Slider")
        slider["elements"]["item"]["props"]["max"] = 0
        self.assertIn("$.elements.item.props.max", parse(slider).error)

    def test_catalog_string_bounds_and_unicode_codepoints(self):
        for kind, path, maximum in (
            ("Metrics", ("items", 0, "hint"), 500),
            ("Status", ("badge", "text"), 500),
            ("Steps", ("items", 0, "note"), 500),
            ("Table", ("rows", 0, 0), 80),
            ("ChoiceGroup", ("options", 0, "description"), 500),
            ("MultiSelect", ("options", 0, "note"), 500),
            ("LineChart", ("xLabels", 0), 20),
            ("LineChart", ("series", 0, "name"), 40),
            ("BarChart", ("unit",), 10),
            ("PieChart", ("items", 0, "label"), 40),
            ("Tabs", ("tabs", 0, "label"), 20),
            ("Accordion", ("title",), 80),
            ("Image", ("caption",), 200),
            ("Image", ("alt",), 200),
            ("MediaCard", ("description",), 500),
            ("Gallery", ("items", 0, "caption"), 200),
            ("FileTree", ("nodes", 0, "note"), 60),
            ("LinkCard", ("tags", 0), 12),
            ("Mermaid", ("source",), 10000),
        ):
            spec = spec_for(kind)
            item = spec["elements"]["item"]["props"]
            for part in path[:-1]:
                item = item[part]
            item[path[-1]] = "🚀" * maximum
            with self.subTest(kind=kind):
                self.assertIsNone(parse(spec).error)
                item[path[-1]] += "🚀"
                self.assertIsNone(parse(spec).spec)
        spec = spec_for("TextInput")
        spec["state"]["choice"] = "🚀" * 2000
        self.assertIsNone(parse(spec).error)
        self.assertEqual(validate_values(spec, {"choice": "🚀" * 2000}), {})
        self.assertIn("choice", validate_values(spec, {"choice": "🚀" * 2001}))

    def test_chart_alignment_ranges_finite_values_and_tab_children(self):
        line = spec_for("LineChart")
        props = line["elements"]["item"]["props"]
        props["xLabels"] = [str(n) for n in range(24)]
        props["series"] = [{"name": name, "values": [0] * 24} for name in ("a", "b", "c")]
        self.assertIsNone(parse(line).error)
        props["series"][2]["values"].pop()
        self.assertIn("$.elements.item.props.series[2].values", parse(line).error)
        props["series"][2]["values"].append(0)
        props["xLabels"].append("24")
        self.assertIn("$.elements.item.props.xLabels", parse(line).error)
        props["xLabels"].pop()
        props["series"].append({"name": "d", "values": [0] * 24})
        self.assertIn("$.elements.item.props.series", parse(line).error)
        self.assertIn("$.elements.item.props.series[0].values[0]",
                      parse_blocks(fence(line).replace('"values": [0,', '"values": [1e999,', 1))[0].error)

        bar = spec_for("BarChart")
        bar_props = bar["elements"]["item"]["props"]
        bar_props.update(labels=[str(n) for n in range(12)], values=[0] * 12)
        self.assertIsNone(parse(bar).error)
        bar_props["values"].pop()
        self.assertIn("$.elements.item.props.values", parse(bar).error)
        bar_props["values"].append(-1)
        self.assertIn("$.elements.item.props.values[11]", parse(bar).error)
        bar_props["labels"].append("extra")
        self.assertIn("$.elements.item.props.labels", parse(bar).error)

        pie = spec_for("PieChart")
        pie["elements"]["item"]["props"]["items"] = [{"label": str(n), "value": n + 1} for n in range(6)]
        self.assertIsNone(parse(pie).error)
        pie["elements"]["item"]["props"]["items"].append({"label": "7", "value": 7})
        self.assertIn("$.elements.item.props.items", parse(pie).error)
        pie["elements"]["item"]["props"]["items"][0]["value"] = -1
        self.assertIn("$.elements.item.props.items[0].value", parse(pie).error)

        tabs = spec_for("Tabs")
        tabs["elements"]["item"]["children"].pop()
        del tabs["elements"]["tab2"]
        self.assertIn("$.elements.item.children", parse(tabs).error)
        tabs["elements"]["item"]["props"]["tabs"].pop()
        self.assertIn("$.elements.item.props.tabs", parse(tabs).error)
        self.assertEqual(tabs["state"], {})

    def test_identifier_and_option_contract(self):
        base = spec_for("ChoiceGroup")
        for identifier in ("", "constructor", "prototype", "__proto__", "中文", "a-b", "a\n", "a" * 65, "1abc"):
            for location in ("root", "id", "child", "stateKey", "state"):
                spec = deepcopy(base)
                if location == "root":
                    spec["root"] = identifier
                    spec["elements"][identifier] = spec["elements"].pop("root")
                elif location == "id":
                    spec["elements"][identifier] = spec["elements"].pop("item")
                    spec["elements"]["root"]["children"][0] = identifier
                elif location == "child":
                    spec["elements"]["root"]["children"][0] = identifier
                elif location == "stateKey":
                    spec["elements"]["item"]["props"]["stateKey"] = identifier
                    spec["state"] = {identifier: ""}
                else:
                    spec["state"] = {identifier: ""}
                with self.subTest(identifier=identifier, location=location):
                    self.assertIsNotNone(parse(spec).error)
        valid = deepcopy(base)
        valid["root"] = "_" + "r" * 63
        valid["elements"][valid["root"]] = valid["elements"].pop("root")
        self.assertIsNone(parse(valid).error)
        for kind in ("ChoiceGroup", "Select", "Segmented", "MultiSelect"):
            for option_value in ("", "same"):
                spec = spec_for(kind)
                options = spec["elements"]["item"]["props"]["options"]
                options[0]["value"] = option_value
                if option_value:
                    options[1]["value"] = option_value
                with self.subTest(kind=kind, option_value=option_value):
                    self.assertIn("props.options", parse(spec).error)
        spec = spec_for("MultiSelect")
        spec["state"]["choice"] = ["a", "a"]
        self.assertIn("$.state.choice", parse(spec).error)


    def test_invalid_topology_and_bound_state(self):
        base = spec_for("Text")
        cases = [
            (lambda s: s.update(extra=1), "$.extra"),
            (lambda s: s.update(root="missing"), "$.root"),
            (lambda s: s.update(root=[]), "$.root"),
            (lambda s: s["elements"]["item"].update(children=["root"]), "$.elements.item.children"),
            (lambda s: s["elements"]["root"]["children"].append("item"), "$.elements.root.children"),
            (lambda s: s["elements"]["root"]["children"].append("missing"), "$.elements.root.children[1]"),
            (lambda s: s["elements"].update(orphan={"type": "Text", "props": {"text": "x"}, "children": []}), "$.elements.orphan"),
            (lambda s: s["elements"]["root"].update(children=[]), "$.elements.item"),
            (lambda s: s["elements"].update(item={"type": "Text", "props": {"text": "x"}, "children": ["item"]}), "$.elements.item.children"),
            (lambda s: s["elements"]["item"].update(props={"text": "x", "other": 1}), "$.elements.item.props.other"),
        ]
        for modify, path in cases:
            spec = deepcopy(base)
            modify(spec)
            with self.subTest(path=path):
                self.assertIn(path, parse(spec).error)
        too_many = deepcopy(base)
        for index in range(58):
            ident = f"n{index}"
            too_many["elements"]["root"]["children"].append(ident)
            too_many["elements"][ident] = {"type": "Text", "props": {"text": "x"}, "children": []}
        self.assertIsNone(parse(too_many).error)  # Exactly 60 nodes.
        too_many["elements"]["root"]["children"].append("n58")
        too_many["elements"]["n58"] = {"type": "Text", "props": {"text": "x"}, "children": []}
        self.assertIn("$.elements: 节点不得超过 60", parse(too_many).error)
        too_deep = {"root": "n0", "elements": {}, "state": {}}
        for index in range(8):
            too_deep["elements"][f"n{index}"] = {"type": "Stack", "props": {}, "children": [f"n{index + 1}"] if index < 7 else []}
        self.assertIsNone(parse(too_deep).error)
        too_deep["elements"]["n7"]["children"] = ["n8"]
        too_deep["elements"]["n8"] = {"type": "Stack", "props": {}, "children": []}
        self.assertIn("树深不得超过 8", parse(too_deep).error)
        form = spec_for("TextInput")
        del form["elements"]["submit"]
        form["elements"]["root"]["children"].remove("submit")
        self.assertIn("恰好一个 Submit", parse(form).error)
        form = spec_for("TextInput")
        form["state"] = {"unbound": ""}
        self.assertIn("$.state.unbound", parse(form).error)
        self.assertIn("$.state.choice", parse(form).error)
        form = spec_for("TextInput")
        form["elements"]["root"]["children"].append("another")
        form["elements"]["another"] = deepcopy(form["elements"]["item"])
        self.assertIn("$.elements.another.props.stateKey", parse(form).error)
        display = spec_for("Text")
        display["elements"]["root"]["children"].append("submit")
        display["elements"]["submit"] = {"type": "Submit", "props": {"label": "提交"}, "children": []}
        self.assertIn("纯展示块不得有 Submit", parse(display).error)

    def test_initial_values_and_submitted_values(self):
        submitted = {"ChoiceGroup": "b", "Select": "b", "Segmented": "a", "MultiSelect": ["a", "b"],
                     "Switch": True, "Slider": 0.3, "TextInput": "汉字" * 1000, "DateInput": "2024-02-29"}
        invalid = {"ChoiceGroup": "other", "Select": "other", "Segmented": 5, "MultiSelect": ["a", "other"],
                   "Switch": 1, "Slider": 0.35, "TextInput": "x" * 2001, "DateInput": "2025-02-29"}
        for kind in INITIAL:
            with self.subTest(kind=kind):
                spec = spec_for(kind)
                self.assertEqual(validate_values(spec, {"choice": submitted[kind]}), {})
                self.assertIn("choice", validate_values(spec, {"choice": invalid[kind]}))
                self.assertIn("choice", validate_values(spec, {}))
                self.assertIn("unexpected", validate_values(spec, {"choice": submitted[kind], "unexpected": 1}))
                spec["state"]["choice"] = invalid[kind]
                self.assertIn("$.state.choice", parse(spec).error)
        spec = spec_for("ChoiceGroup")
        spec["state"]["choice"] = "a"  # Disabled initial values remain valid under the block contract.
        self.assertIsNone(parse(spec).error)
        self.assertEqual(validate_values(spec, {"choice": "a"}), {})
        self.assertEqual(validate_values(spec, {"choice": ""}), {})
        fresh = spec_for("ChoiceGroup")
        self.assertIn("choice", validate_values(fresh, {"choice": "a"}))
        self.assertEqual(validate_values(spec_for("DateInput"), {"choice": ""}), {})
        self.assertIn("choice", validate_values(spec_for("MultiSelect"), {"choice": ["a", "a"]}))
        self.assertEqual(validate_values(spec_for("Slider"), {"choice": 0.3}), {})
        self.assertIn("choice", validate_values(spec_for("Slider"), {"choice": float("inf")}))
        nested: object = 1
        for _ in range(500):
            nested = {"nested": nested}
        self.assertIn("choice", validate_values(spec_for("Slider"), {"choice": nested}))
        self.assertEqual(validate_values(spec_for("Text"), {}), {})

    def test_select_stable_value_empty_disabled_transition_and_submission_label(self):
        spec = spec_for("Select")
        self.assertIsNone(parse(spec).error)
        self.assertEqual(validate_values(spec, {"choice": ""}), {})
        self.assertEqual(validate_values(spec, {"choice": "b"}), {})
        self.assertIn("choice", validate_values(spec, {"choice": "a"}))
        self.assertIn("choice", validate_values(spec, {"choice": "方案B"}))
        summary, prompt = submission_text(spec, {"choice": "b"}, 31, 0)
        self.assertIn("方案B", summary)
        self.assertIn('值="b"', prompt)
        spec["state"]["choice"] = "a"
        self.assertIsNone(parse(spec).error)
        self.assertEqual(validate_values(spec, {"choice": "a"}), {})
        self.assertEqual(validate_values(spec, {"choice": ""}), {})
        self.assertIn("choice", validate_values(spec, {"choice": "方案A"}))
        spec["elements"]["item"]["props"]["options"][1]["value"] = "a"
        self.assertIn("props.options", parse(spec).error)

    def test_file_tree_path_structure_and_implicit_folders(self):
        spec = spec_for("FileTree")
        props = spec["elements"]["item"]["props"]
        props["nodes"] = [
            {"path": "🪴" * 64 + "/a", "note": "🪴" * 60},
            {"path": "src/child", "collapsed": False},
            {"path": "src/", "kind": "folder", "collapsed": True},
            {"path": "/".join(["d"] * 8), "kind": "file"},
        ]
        self.assertIsNone(parse(spec).error)
        for invalid in (
            "/absolute", "dir//file", "dir/./file", "dir/../file",
            "dir\\file", "dir/\nfile", "dir/\x7ffile",
            "🪴" * 65, "/".join(["d"] * 9), "",
        ):
            with self.subTest(path=invalid):
                changed = deepcopy(spec)
                changed["elements"]["item"]["props"]["nodes"][0]["path"] = invalid
                self.assertIn("props.nodes[0].path", parse(changed).error)
        for nodes, location in (
            ([{"path": "a"}, {"path": "a/"}], "nodes[1].path"),
            ([{"path": "a/"}, {"path": "a"}], "nodes[1].path"),
            ([{"path": "a/", "kind": "file"}], "nodes[0].path"),
            ([{"path": "a", "kind": "file"}, {"path": "a/b"}], "nodes[1].path"),
            ([{"path": "a/b"}, {"path": "a", "kind": "file"}], "nodes[0].path"),
            ([{"path": "a", "kind": "file"}, {"path": "a/b/c"}], "nodes[1].path"),
        ):
            with self.subTest(nodes=nodes):
                changed = spec_for("FileTree")
                changed["elements"]["item"]["props"]["nodes"] = nodes
                self.assertIn(location, parse(changed).error)
        for nodes in ([{"path": "child", "kind": "file"}],
                      [{"path": "parent/child"}, {"path": "parent", "note": "late"}],
                      [{"path": "parent/child"}, {"path": "parent", "kind": "folder"}]):
            with self.subTest(nodes=nodes):
                changed = spec_for("FileTree")
                changed["elements"]["item"]["props"]["nodes"] = nodes
                self.assertIsNone(parse(changed).error)

    def test_file_tree_and_link_card_bounds(self):
        tree = spec_for("FileTree")
        props = tree["elements"]["item"]["props"]
        props.update(title="🪴" * 40, nodes=[
            {"path": "/".join(["🪴" * 64] * 3 + ["🪴" * 5]), "note": "🪴" * 60},
            *({"path": f"file{index}"} for index in range(79)),
        ])
        self.assertIsNone(parse(tree).error)
        for field, value in (("title", "🪴" * 41), ("nodes", [{"path": "a" * 201}]),
                             ("nodes", [{"path": "a" * 64 + "/" + "b" * 64 + "/" + "c" * 64 + "/xxxxxx"}]),
                             ("nodes", [{"path": "a"}] * 81),
                             ("nodes", [{"path": "a", "kind": "directory"}]),
                             ("nodes", [{"path": "a", "collapsed": 0}]),
                             ("nodes", [{"path": "a", "note": "🪴" * 61}]),
                             ("nodes", [{"path": "a", "extra": True}])):
            with self.subTest(field=field, value=str(value)[:30]):
                changed = deepcopy(tree)
                changed["elements"]["item"]["props"][field] = value
                self.assertIsNotNone(parse(changed).error)
        missing = deepcopy(tree)
        del missing["elements"]["item"]["props"]["nodes"]
        self.assertIn("props.nodes", parse(missing).error)
        link = spec_for("LinkCard")
        link_props = link["elements"]["item"]["props"]
        link_props.update(tags=["🪴" * 12] * 3, image="https://example.org/" + "x" * (2048 - len("https://example.org/")))
        self.assertIsNone(parse(link).error)
        for field, value in (("tags", ["🪴" * 13]), ("tags", ["tag"] * 4),
                             ("image", link_props["image"] + "x"), ("image", "http://user@host.example/img"),
                             ("image", "file:///tmp/image")):
            with self.subTest(field=field, value=str(value)[:30]):
                changed = deepcopy(link)
                changed["elements"]["item"]["props"][field] = value
                self.assertIn(f"props.{field}", parse(changed).error)

    def test_source_links_and_icons_are_safe_and_catalog_bound(self):
        vectors = json.loads((Path(__file__).parent / "fixtures/ui_urls.json").read_text(encoding="utf-8"))
        for kind, field in (
            ("Source", ("items", 0, "url")), ("LinkCard", ("url",)), ("LinkCard", ("image",)),
            ("Image", ("url",)), ("MediaCard", ("url",)), ("Gallery", ("items", 0, "url")),
        ):
            spec = spec_for(kind)
            if kind == "Image":
                spec["elements"]["item"]["props"] = {"url": "https://example.org/photo.png", "alt": "截图"}
            self.assertIsNone(parse(spec).error)
            for case in vectors:
                changed = deepcopy(spec)
                props = changed["elements"]["item"]["props"]
                if len(field) == 3:
                    props[field[0]][field[1]][field[2]] = case["url"]
                else:
                    props[field[0]] = case["url"]
                with self.subTest(kind=kind, name=case["name"]):
                    result = parse(changed)
                    self.assertEqual(result.spec is not None, case["valid"], result.error)
                    if not case["valid"]:
                        self.assertIn("props", result.error)
        for kind, field in (("Icon", "name"), ("List", "icon")):
            spec = spec_for(kind)
            self.assertIsNone(parse(spec).error)
            props = spec["elements"]["item"]["props"]
            if kind == "Icon":
                props[field] = "not-a-lucide-export"
            else:
                props["items"][0][field] = "not-a-lucide-export"
            self.assertIsNone(parse(spec).spec)

    def test_slider_decimal_grid_preserves_submitted_step(self):
        spec = spec_for("Slider")
        spec["elements"]["item"]["props"].update(min=0, max=1, step=0.3333333333333333)
        spec["state"]["choice"] = 0.3333333333333333
        self.assertIsNone(parse(spec).error)
        self.assertEqual(validate_values(spec, {"choice": 0.6666666666666666}), {})
        self.assertIn("choice", validate_values(spec, {"choice": 0.666666666666667}))
        self.assertIn("choice", validate_values(spec_for("Slider"), {"choice": 0.30000000000000004}))

        rounded = spec_for("Slider")
        rounded["elements"]["item"]["props"].update(
            min=0.12345678901234566, max=1, step=0.3333333333333333,
        )
        rounded["state"]["choice"] = 0.12345678901234566
        self.assertIsNone(parse(rounded).error)
        self.assertEqual(validate_values(rounded, {"choice": 0.45679012234567895}), {})
        self.assertIn("choice", validate_values(rounded, {"choice": 0.456790122345679}))
        projected_integer = spec_for("Slider")
        projected_integer["elements"]["item"]["props"].update(
            min=0.9999999999999999, max=1, step=0.00000000000000009,
        )
        projected_integer["state"]["choice"] = 0.9999999999999999
        self.assertIsNone(parse(projected_integer).error)
        self.assertEqual(validate_values(projected_integer, {"choice": 1}), {})


    def test_submission_includes_message_block_labels_and_values(self):
        spec = spec_for("ChoiceGroup")
        summary, prompt = submission_text(spec, {"choice": "b"}, 87, 0)
        self.assertIn("方案B", summary)
        self.assertIn("seq=87", prompt)
        self.assertIn("block=0", prompt)
        self.assertIn("方案B", prompt)
        self.assertIn('"b"', prompt)
        multi = spec_for("MultiSelect")
        prompt = submission_text(multi, {"choice": ["a", "b"]}, 87, 1)[1]
        self.assertIn("A", prompt)
        self.assertIn("B", prompt)
        self.assertIn('["a", "b"]', prompt)


    def test_media_sources_and_delivery_ownership(self):
        for kind, props in (
            ("Image", {"url": "https://example.org/photo.png", "alt": "照片"}),
            ("MediaCard", {"url": "https://example.org/photo.png", "alt": "照片", "title": "比较"}),
            ("Gallery", {"items": [{"url": "https://example.org/photo.png", "alt": "照片"}]}),
        ):
            with self.subTest(kind=kind):
                item = spec_for(kind)
                item["elements"]["item"]["props"] = props
                self.assertIsNone(parse(item).error)
                self.assertIsNone(delivery_blocks(fence(item), [])[0].error)
                for invalid in ("file:///private.png", "https://user:secret@example.org/x", "https://@example.org/x", "https://example.org:0/x", "https://", "https:\\example.org\\x"):
                    changed = deepcopy(item)
                    target = changed["elements"]["item"]["props"]
                    if kind == "Gallery":
                        target = target["items"][0]
                    target["url"] = invalid
                    self.assertIsNotNone(parse(changed).error, invalid)
                changed = deepcopy(item)
                target = changed["elements"]["item"]["props"]
                if kind == "Gallery":
                    target = target["items"][0]
                target["attachment"] = "photo.png"
                self.assertIsNotNone(parse(changed).error)

        gallery = spec_for("Gallery")
        gallery["elements"]["item"]["props"]["items"] = [
            {"attachment": "one.png", "alt": "一"},
            {"url": "https://example.org/two.png", "alt": "二"},
            {"attachment": "three.png", "alt": "三"},
        ]
        accepted = [SimpleNamespace(requested_path="one.png", path="one.png", media_type="image/png"),
                    SimpleNamespace(requested_path="three.png", path="three.png", media_type="image/webp")]
        block = delivery_blocks(fence(gallery), accepted)[0]
        self.assertIsNone(block.error)
        self.assertEqual(image_attachments(block), {"one.png", "three.png"})
        self.assertIn("items[2].attachment", delivery_blocks(fence(gallery), accepted[:1])[0].error)


class MarkdownImageTests(unittest.TestCase):
    def test_shared_nested_image_order_excludes_ui_and_code(self):
        vectors = json.loads((Path(__file__).parent / "fixtures/ui_markdown_images.json").read_text(encoding="utf-8"))
        for case in vectors:
            with self.subTest(text=case["text"][:32]):
                self.assertEqual(markdown_image_urls(case["text"]), case["urls"])

    def test_shared_math_media_indices(self):
        vectors = json.loads((Path(__file__).parent / "fixtures/ui_markdown_media.json").read_text(encoding="utf-8"))
        for case in vectors:
            with self.subTest(name=case["name"]):
                self.assertEqual(markdown_image_urls(case["text"]), case["urls"])


class FenceTests(unittest.TestCase):
    def test_shared_fence_vectors(self):
        vectors = json.loads((Path(__file__).parent / "fixtures/ui_fences.json").read_text(encoding="utf-8"))
        for index, vector in enumerate(vectors):
            with self.subTest(index=index):
                self.assertEqual(
                    [{"block": block.block, "closed": block.closed, "source": block.source}
                     for block in parse_blocks(vector["text"])],
                    vector["blocks"],
                )

    def test_multiple_blocks_and_ordinary_fence_shielding(self):
        first, second = spec_for("Text"), spec_for("ChoiceGroup")
        text = ("before\n````json\n" + fence(first) + "````\n" + fence(first, "~~~")
                + "between\n" + fence(second) + "after")
        blocks = parse_blocks(text)
        self.assertEqual(len(blocks), 2)
        self.assertEqual([block.block for block in blocks], [0, 1])
        self.assertEqual(blocks[0].spec, first)
        self.assertEqual(blocks[1].spec, second)
        self.assertEqual(blocks[1].metadata(), {"block": 1, "valid": True})

    def test_unclosed_and_invalid_fences_keep_order_and_diagnostic(self):
        spec = spec_for("Text")
        blocks = parse_blocks(fence(spec) + "~~~wandrun-ui\n{}")
        self.assertEqual(len(blocks), 2)
        self.assertIn("未闭合", blocks[1].error)
        self.assertIsNone(blocks[1].spec)
        self.assertEqual(blocks[1].metadata()["block"], 1)
        blocks = parse_blocks("```wandrun-ui\nnot-json\n```\n" + fence(spec))
        self.assertIn("JSON 无效", blocks[0].error)
        self.assertEqual(blocks[1].spec, spec)

    def test_exact_info_closing_and_line_based_indentation(self):
        spec = spec_for("Text")
        body = json.dumps(spec)
        self.assertEqual(parse_blocks("    ```wandrun-ui\n" + body + "\n    ```"), [])
        self.assertEqual(parse_blocks("- ```wandrun-ui\n" + body + "\n```"), [])
        self.assertEqual(len(parse_blocks("   ```wandrun-ui\n" + body + "\n   ```")), 1)
        self.assertEqual(len(parse_blocks("- list\n  ```wandrun-ui\n" + body + "\n  ```")), 1)
        self.assertEqual(parse_blocks("```wandrun-ui extra\n" + body + "\n```"), [])
        self.assertEqual(parse_blocks("> ```wandrun-ui\n" + body + "\n```"), [])
        self.assertEqual(len(parse_blocks("````wandrun-ui\n" + body + "\n```\n")), 1)
        self.assertIn("未闭合", parse_blocks("````wandrun-ui\n" + body + "\n```\n")[0].error)
        self.assertEqual(len(parse_blocks("````wandrun-ui\n" + body + "\n````  \n")), 1)
        self.assertIsNone(parse_blocks("````wandrun-ui\n" + body + "\n````  \n")[0].error)
        self.assertIn("未闭合", parse_blocks("~~~wandrun-ui\n" + body + "\n```\n")[0].error)
        self.assertEqual(parse_blocks("~~~~text\n```wandrun-ui\n" + body + "\n~~~~\n"), [])

    def test_json_strict_and_special_key_diagnostics(self):
        spec = spec_for("Text")
        spec["elements"]["项-1"] = spec["elements"].pop("item")
        spec["elements"]["root"]["children"] = ["项-1"]
        spec["elements"]["项-1"]["props"]["text"] = 42
        self.assertIn('$.elements["项-1"].props.text', parse(spec).error)
        self.assertIn("重复 JSON 字段", parse_blocks('```wandrun-ui\n{"root":"a","root":"b"}\n```')[0].error)
        self.assertIn("非法非有限数值", parse_blocks('```wandrun-ui\n{"root":NaN}\n```')[0].error)
        self.assertIn("有限", parse_blocks(fence(spec_for("Progress")).replace('"value": 100', '"value": 1e999'))[0].error)


if __name__ == "__main__":
    unittest.main()
