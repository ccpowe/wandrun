"""Development Chrome launcher handshakes over a real displayfd pipe."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from wandrun.integrations.browser_dev import ChromeDev


class DisplayHandshakeTests(unittest.TestCase):
    def test_displayfd_stays_open_until_newline_after_separate_digit_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            consumed = root / "digits-consumed"
            xvfb = root / "Xvfb"
            xvfb.write_text(
                "import os, pathlib, sys, time\n"
                "fd = int(sys.argv[sys.argv.index('-displayfd') + 1])\n"
                "os.write(fd, b'17')\n"
                f"gate = pathlib.Path({str(consumed)!r})\n"
                "deadline = time.monotonic() + 5\n"
                "while not gate.exists():\n"
                "    if time.monotonic() >= deadline: raise SystemExit(2)\n"
                "    time.sleep(0.01)\n"
                "os.write(fd, b'\\n')\n"
                "os.close(fd)\n",
                encoding="utf-8",
            )
            original_read, original_popen = os.read, subprocess.Popen

            def read(fd, size):
                chunk = original_read(fd, size)
                if chunk == b"17":
                    consumed.touch()
                return chunk

            class ChromeReached(Exception):
                pass

            def launch(command, **kwargs):
                if command[0] == "Xvfb":
                    return original_popen([sys.executable, str(xvfb), *command[1:]], **kwargs)
                # The writer must finish its newline successfully before Chrome
                # starts. An early reader close gives the child BrokenPipeError.
                self.assertEqual(chrome._xvfb.wait(timeout=5), 0)
                self.assertEqual(chrome.display, ":17")
                raise ChromeReached

            chrome = ChromeDev(chrome_path=sys.executable)
            with (
                patch("wandrun.integrations.browser_dev.shutil.which", return_value=str(xvfb)),
                patch("wandrun.integrations.browser_dev.os.read", side_effect=read),
                patch("wandrun.integrations.browser_dev.subprocess.Popen", side_effect=launch),
                self.assertRaises(ChromeReached),
                chrome,
            ):
                self.fail("fake Chrome must stop after the display handshake")
