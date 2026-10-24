"""Actual fixed inventory readers under controlled filesystem/process observations.

No sudo, native account, candidate, issuer or production invocation occurs.
"""
import ast
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SOURCE = Path(__file__).with_name("release-hosted-native-linux-capture.mts").read_text(encoding="utf-8")
INVENTORY = re.search(r"hostedLinuxInventorySource = String.raw`(.*?)`;", SOURCE, re.S).group(1)
TREE = ast.parse(INVENTORY)


class Inventory(unittest.TestCase):
    def methods(self):
        scope = {"Path": Path, "os": os, "stat": stat, "subprocess": subprocess, "root": Path("/fixed"),
                 "selectors": selectors, "signal": signal, "time": time, "deadline": time.monotonic() + 20}
        definitions = ast.Module(body=[node for node in TREE.body if isinstance(node, ast.FunctionDef)], type_ignores=[])
        exec(compile(definitions, "fixed-inventory", "exec"), scope)
        return scope

    def test_compiles_and_contains_only_fixed_native_closure(self):
        compile(INVENTORY, "fixed-inventory", "exec")
        self.assertNotIn("shell=True", INVENTORY)
        self.assertNotIn("os.environ", INVENTORY)
        self.assertIn("harness=='apps/desktop/scripts/desktop-test.mts'", INVENTORY)
        self.assertIn("'GIT_NO_LAZY_FETCH':'1'", INVENTORY)

    def test_actual_reader_bounds_bytes_and_checks_identity_custody_and_symlinks(self):
        scope = self.methods()
        portable_os = {name: getattr(os, name) for name in dir(os)}
        portable_os.setdefault("O_NOFOLLOW", 0)
        portable_os.setdefault("O_NONBLOCK", 0)
        scope["os"] = SimpleNamespace(**portable_os)
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "fixed.bin"
            filename.write_bytes(b"fixed inventory bytes")
            info = filename.stat()
            clean = SimpleNamespace(**{name: getattr(info, name) for name in dir(info) if name.startswith("st_")})
            clean.st_mode &= ~0o022
            original_lstat = Path.lstat

            def protected(path):
                actual = original_lstat(path)
                value = SimpleNamespace(**{name: getattr(actual, name) for name in dir(actual) if name.startswith("st_")})
                value.st_mode &= ~0o022
                return value

            with patch.object(Path, "lstat", protected), patch.object(scope["os"], "fstat", return_value=clean):
                self.assertEqual(scope["read"](filename, 1024, (0, info.st_uid)), b"fixed inventory bytes")
                with self.assertRaises(RuntimeError):
                    scope["read"](filename, 1, (0, info.st_uid))
                with self.assertRaises(RuntimeError):
                    scope["read"](filename, 1024, (999999,))
                changed = SimpleNamespace(**vars(clean))
                changed.st_ino += 1
                with patch.object(scope["os"], "fstat", side_effect=[clean, changed]), self.assertRaises(RuntimeError):
                    scope["read"](filename, 1024, (0, info.st_uid))

    @unittest.skipIf(os.name == "nt", "Actual Linux pipe/group contract; Windows reader contracts run separately")
    def test_git_is_fixed_scrubbed_bounded_read_only_and_preserves_refusal(self):
        scope = self.methods()
        scope["env"] = {"PATH": "/usr/bin:/bin", "GIT_NO_LAZY_FETCH": "1"}
        original = subprocess.Popen
        programs = ["print('fixed')", "raise SystemExit(1)",
                    "import sys;sys.stdout.buffer.write(b'x'*65537)",
                    "import sys;sys.stderr.buffer.write(b'x'*4097)",
                    "import time;time.sleep(10)",
                    "import subprocess,sys;subprocess.Popen([sys.executable,'-c','import time;time.sleep(10)'])"]
        for index, program in enumerate(programs):
            children = []

            def launch(args, _program=program, _children=children, **kwargs):
                self.assertEqual(args[:5], ["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"])
                self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)
                self.assertTrue(kwargs["start_new_session"])
                self.assertEqual(kwargs["env"], scope["env"])
                child = original([sys.executable, "-I", "-S", "-c", _program], **kwargs)
                _children.append(child)
                return child

            scope["deadline"] = time.monotonic() + (0.15 if index >= 4 else 5)
            with patch.object(subprocess, "Popen", side_effect=launch):
                if index == 0:
                    self.assertEqual(scope["git"](["rev-parse", "HEAD"]), b"fixed\n")
                else:
                    with self.assertRaises(RuntimeError):
                        scope["git"](["rev-parse", "HEAD"])
            self.assertIsNotNone(children[0].returncode)
            self.assertTrue(children[0].stdout.closed and children[0].stderr.closed)


if __name__ == "__main__":
    unittest.main()
