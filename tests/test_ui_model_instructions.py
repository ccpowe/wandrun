"""The progressive UI skill must cover its catalog and show deliverable examples."""

import json
from pathlib import Path
import re
import unittest
from unittest.mock import patch

from wandrun.gateway import ui_blocks
from wandrun.gateway.ui_blocks import model_instructions, parse_blocks, skill_files, validate_values


CATALOG = json.loads(
    (Path(__file__).parents[1] / "src/wandrun/gateway/ui_catalog.json").read_text(encoding="utf-8")
)
CHAPTERS = {"design.md", "display.md", "charts.md", "forms.md", "media.md"}


class ModelExampleTests(unittest.TestCase):
    def test_resident_examples_are_valid_specs(self):
        blocks = parse_blocks(model_instructions())
        self.assertEqual(len(blocks), 3)
        for block in blocks:
            with self.subTest(block=block.block):
                self.assertIsNone(block.error)
                self.assertIsNotNone(block.spec)

    def test_manifest_and_catalog_reference_cover_every_component(self):
        files = skill_files()
        self.assertEqual(set(files), {"SKILL.md"} | CHAPTERS)
        self.assertEqual(
            set(re.findall(r"\]\(([^)]+\.md)\)", files["SKILL.md"])), CHAPTERS
        )
        reference = "\n".join(files[name] for name in CHAPTERS if name != "design.md")
        entries = re.findall(r"^- \*\*(\w+)\*\* — (.+)$", reference, flags=re.MULTILINE)
        self.assertEqual({name for name, _ in entries}, set(CATALOG["components"]))
        self.assertEqual(len(entries), len(CATALOG["components"]))

    def test_component_addition_or_removal_requires_chapter_update(self):
        changed_catalogs = (
            {**ui_blocks._COMPONENTS, "FutureWidget": {"description": "new"}},
            {name: component for name, component in ui_blocks._COMPONENTS.items() if name != "Table"},
        )
        for components in changed_catalogs:
            with self.subTest(components=tuple(components)):
                with patch.dict(ui_blocks._COMPONENTS, components, clear=True):
                    with self.assertRaises(ValueError):
                        skill_files()

    def test_generated_examples_deliver_and_initial_form_values_submit(self):
        files = skill_files()
        chapters_with_examples = {item["chapter"] for item in CATALOG["examples"]}
        self.assertEqual(chapters_with_examples, CHAPTERS - {"design.md"})
        for chapter in chapters_with_examples:
            blocks = parse_blocks(files[chapter])
            self.assertTrue(blocks, chapter)
            for block in blocks:
                with self.subTest(chapter=chapter, block=block.block):
                    self.assertIsNone(block.error)
                    self.assertIsNotNone(block.spec)
                    if block.spec["state"]:
                        self.assertEqual(validate_values(block.spec, block.spec["state"]), {})
        self.assertTrue(any(block.spec["state"] for block in parse_blocks(files["forms.md"])))


if __name__ == "__main__":
    unittest.main()
