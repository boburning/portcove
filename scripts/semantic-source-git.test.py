"""Inert policy fixtures: no Git, network, limits, credentials or processes."""

import hashlib
import importlib.util
import io
import json
import posixpath
import stat
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

fake_resource = SimpleNamespace(RLIMIT_AS=1, RLIMIT_FSIZE=2, RLIMIT_CPU=3, RLIMIT_CORE=4)
with patch.dict(sys.modules, {"resource": fake_resource}):
    spec = importlib.util.spec_from_file_location("source_git", Path(__file__).with_name("semantic-source-git.py"))
    source = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(source)


class GitPolicy(unittest.TestCase):
    def run_request(self, changes=None, phase="commits"):
        binary = b"fixture-fixed-git-not-executed"
        value = dict(
            schema_version=1,
            repository="/private/source.git",
            home="/private/home",
            oids=["a" * 40],
            phase=phase,
            git_sha256=hashlib.sha256(binary).hexdigest(),
            timeout_ms=30000,
            expires_at=1001000,
        )
        value.update(changes or {})
        raw = json.dumps(value).encode()
        calls = []
        mock_os = SimpleNamespace(
            getuid=lambda: 1000,
            O_RDONLY=0,
            O_NOFOLLOW=1,
            O_NONBLOCK=2,
            open=lambda *args: 1,
            close=lambda fd: None,
            read=lambda *args: raw,
            path=posixpath,
            fstat=lambda fd: SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=1000, st_nlink=1, st_size=len(raw)),
            execve=lambda *args: calls.append(("exec", args)),
        )
        with (
            patch.object(source, "os", mock_os),
            patch.object(source.sys, "argv", ["fixed", "/private/request.json"]),
            patch.object(source.time, "time", lambda: 1000),
            patch.object(
                source,
                "resource",
                SimpleNamespace(**vars(fake_resource), setrlimit=lambda *args: calls.append(("limit", args))),
            ),
            patch.object(source, "signal", SimpleNamespace(alarm=lambda value: calls.append(("alarm", value)))),
            patch("builtins.open", lambda *args: io.BytesIO(binary)),
        ):
            source.main()
        return calls

    def test_fixed_route_scrubs_credentials_and_applies_all_limits_before_git(self):
        calls = self.run_request()
        self.assertEqual([name for name, _ in calls], ["limit"] * 4 + ["alarm", "exec"])
        executable, args, environment = calls[-1][1]
        self.assertEqual(executable, "/usr/bin/git")
        self.assertIn("--filter=tree:0", args)
        self.assertIn("--depth=1601", args)
        self.assertEqual(args[-2:], ["https://github.com/boburning/portcove.git", "a" * 40])
        self.assertIn("--no-write-fetch-head", args)
        self.assertIn("protocol.allow=never", args)
        self.assertIn("http.followRedirects=false", args)
        self.assertEqual(
            set(environment),
            {
                "PATH",
                "LANG",
                "HOME",
                "GIT_CONFIG_NOSYSTEM",
                "GIT_CONFIG_GLOBAL",
                "GIT_TERMINAL_PROMPT",
                "GIT_NO_LAZY_FETCH",
                "GIT_NO_REPLACE_OBJECTS",
            },
        )
        self.assertEqual(calls[1][1][1], (64 * 1024**2,) * 2)

    def test_blob_mode_has_fixed_filter_and_larger_still_finite_file_ceiling(self):
        calls = self.run_request(phase="blobs")
        self.assertIn("--filter=blob:none", calls[-1][1][1])
        self.assertNotIn("--depth=1601", calls[-1][1][1])
        self.assertEqual(calls[1][1][1], (256 * 1024**2,) * 2)

    def test_local_decoding_has_same_preexec_limits_and_no_network_route(self):
        for phase, objects, command in (
            ("init", [], "init"),
            ("refs", [], "for-each-ref"),
            ("commit", ["a" * 40], "cat-file"),
            ("tree", [], "hash-object"),
            ("sizes", [], "cat-file"),
            ("peel", ["a" * 40], "rev-parse"),
            ("history", ["a" * 40, "a" * 40], "rev-list"),
        ):
            with self.subTest(phase=phase):
                calls = self.run_request({"oids": objects}, phase=phase)
                self.assertEqual([name for name, _ in calls], ["limit"] * 4 + ["alarm", "exec"])
                args = calls[-1][1][1]
                self.assertIn(command, args)
                self.assertIn("protocol.https.allow=never", args)
                self.assertFalse(any(arg.startswith("https:") for arg in args))

    def test_expired_injected_options_or_changed_tool_never_execute(self):
        for change in (
            {"expires_at": 999999},
            {"timeout_ms": True},
            {"git_sha256": "0" * 64},
            {"remote": "https://attacker.invalid"},
            {"oids": ["--upload-pack=evil"]},
            {"oids": ["a" * 40] * 2},
            {"repository": "/private/../other"},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.run_request(change)


if __name__ == "__main__":
    unittest.main()
