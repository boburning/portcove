"""Inert failure/recovery contracts; no account, sudo, unit or namespace runs."""

import ast
import collections
import fnmatch
import hashlib
import importlib.util
import io
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path, PurePosixPath
from types import SimpleNamespace
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("readiness", Path(__file__).with_name("qualify-hosted-native-linux.py"))
readiness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(readiness)


class HostedReadiness(unittest.TestCase):
    def test_controller_primitive_pins_bind_admitted_tool_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "scripts").mkdir()
            names = ("qualify-hosted-native-linux.py", "native-qualification-linux-supervisor.py")
            for name in names:
                (root / "scripts" / name).write_bytes(b"inert controller source")
            admitted = dict.fromkeys(names, hashlib.sha256(b"inert controller source").hexdigest())
            self.assertEqual(readiness.controller_pins(root, admitted), admitted)
            for altered in ({**admitted, "extra.py": "a" * 64}, {**admitted, names[0]: "b" * 64}):
                with self.assertRaisesRegex(RuntimeError, "admitted tools"):
                    readiness.controller_pins(root, altered)
            (root / "scripts" / names[1]).write_bytes(b"changed controller source")
            with self.assertRaisesRegex(RuntimeError, "admitted tools"):
                readiness.controller_pins(root, admitted)

    def root_functions(self, names, scope):
        nodes = [node for node in ast.parse(readiness.ROOT_SETUP).body if isinstance(node, ast.FunctionDef) and node.name in names]
        self.assertEqual(len(nodes), len(names))
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "actual-root-profile-functions", "exec"), scope)
        return scope

    def test_actual_source_validation_and_install_preserve_profile_hash_function(self):
        outer = next(node for node in ast.parse(readiness.ROOT_SETUP).body if isinstance(node, ast.Try))
        loops = [node for node in outer.body if isinstance(node, ast.For)]
        self.assertEqual(len(loops), 2)
        for altered in (False, True):
            with self.subTest(altered=altered), tempfile.TemporaryDirectory() as temporary:
                source, target = Path(temporary) / "source", Path(temporary) / "target"
                source.mkdir()
                target.mkdir()
                payload = b"controlled fixed diagnostic source"
                wanted = {"first.py": hashlib.sha256(payload).hexdigest(),
                          "second.py": hashlib.sha256(payload).hexdigest()}
                for name in wanted:
                    (source / name).write_bytes(payload + (b"changed" if altered else b""))
                scope = {"src": source, "target": target, "wanted": wanted,
                         "hashlib": hashlib, "json": json, "stat": stat, "re": re, "original_fence": lambda: None}
                self.root_functions({"digest", "profile_summary"}, scope)
                code = compile(ast.Module(body=loops, type_ignores=[]), "actual-root-source-handoff", "exec")
                if altered:
                    with self.assertRaises(AssertionError):
                        exec(code, scope)
                    self.assertEqual(list(target.iterdir()), [])
                else:
                    exec(code, scope)
                    self.assertTrue(callable(scope["digest"]))
                    self.assertEqual(scope["digest"](payload), wanted["first.py"])
                    self.assertEqual(scope["profile_summary"]({"labels": ["bwrap (enforce)"]})["labels"],
                                     ["bwrap (enforce)"])
                    for name in wanted:
                        self.assertEqual((target / name).read_bytes(), payload)

    def test_attachment_collision_guard_refuses_unknown_and_overlapping_patterns(self):
        scope = self.root_functions({"attachment_clear"}, {"re": re, "fnmatch": fnmatch})
        for value in ("/usr/bin/other", "/{,usr/}sbin/tcpdump", "unprivileged_userns", "/opt/application/**"):
            scope["attachment_clear"](value)
        for value in ("/usr/bin/bwrap", "/{,usr/}bin/bwrap", "/usr/**", "<unknown>", "@{variable}", "/usr/bin/[ab]*"):
            with self.subTest(value=value), self.assertRaises(AssertionError):
                scope["attachment_clear"](value)

    def test_actual_collision_refusal_keeps_bounded_identity_without_clearing_unknown(self):
        entry = PurePosixPath("/sys/kernel/security/apparmor/policy/profiles/controlled.7")
        for attachment, condition in (("<unknown>", "observed"), ("<unknown>", "missing-name"),
                                      ("<unknown>", "missing-hash"), ("", "empty"),
                                      ("/usr/bin/bwrap", "expired"), ("@{variable}", "long-name")):
            reads = []
            def bounded(filename, maximum, condition=condition, attachment=attachment, reads=reads):
                reads.append(str(filename))
                name = PurePosixPath(filename).name
                if name == "profiles":
                    return b"controlled (enforce)\n"
                if name == "attach":
                    return attachment.encode()
                if name == "name" and condition == "missing-name":
                    raise FileNotFoundError("controlled missing metadata")
                if name == "sha256" and condition == "missing-hash":
                    return b""
                return ({"name": "x" * 4096 if condition == "long-name" else "controlled",
                         "mode": "enforce", "sha256": "a" * 64}[name]).encode()
            clock = Mock(side_effect=[10, 21, 21, 21]) if condition == "expired" else Mock(return_value=10)
            scope = {"bounded": bounded, "time": SimpleNamespace(monotonic=clock),
                     "deadline": 20, "result": {}, "os": SimpleNamespace(uname=lambda: SimpleNamespace(release="controlled")),
                     "hashlib": hashlib, "json": json, "re": re, "fnmatch": fnmatch}
            # Only the directory constructor is virtual; diagnostic child paths
            # retain real Linux path semantics and never reach an OS provider.
            class RootDirectory:
                def iterdir(self):
                    return [entry]
                def __truediv__(self, name):
                    return entry.parent / name
            scope["Path"] = lambda value: RootDirectory() if str(value).endswith("/profiles") else PurePosixPath(value)
            self.root_functions({"profile_state", "profile_refusal", "attachment_clear", "digest"}, scope)
            with self.subTest(attachment=attachment, condition=condition):
                if condition == "observed":
                    state = scope["profile_state"](True)
                    self.assertEqual(state["attachments"]["controlled.7"], "<unknown>")
                    self.assertEqual(state["opaque"]["controlled.7"],
                                     {"name": "controlled", "mode": "enforce", "sha256": "a" * 64})
                    self.assertNotIn("profile_refusal", scope["result"])
                    continue
                with self.assertRaises((AssertionError, FileNotFoundError)):
                    scope["profile_state"](True)
            record = scope["result"]["profile_refusal"]
            self.assertEqual(record["entry"]["text"], "controlled.7")
            self.assertEqual(record["attachment"]["text"], attachment)
            self.assertLess(len(json.dumps(record).encode()), 16384)
            if condition == "expired":
                self.assertEqual(record["name"], {"error": "AssertionError"})
                self.assertEqual(len(reads), 2)
            elif condition == "missing-name":
                self.assertEqual(record["name"], {"error": "FileNotFoundError"})
                self.assertEqual(record["mode"]["text"], "enforce")
            elif condition == "long-name":
                self.assertTrue(record["name"]["truncated"])
                self.assertEqual(record["name"]["utf8_bytes"], 4096)
                self.assertEqual(len(record["name"]["text"]), 256)

    def test_actual_profile_setup_is_add_only_and_keeps_ambiguous_load_intent(self):
        pin = "11d39094f044f0cda0febb3ad517b830301da6b2ce929664af09ee9e4dd264f9"
        source = b"x" * 1936  # Controlled provider bytes; no real policy or root operation.
        binary = b"controlled compiled policy"
        before = {"labels": ["other (enforce)"], "attachments": {"other.1": "<unknown>"},
                  "opaque": {"other.1": {"name": "other", "mode": "enforce", "sha256": "a" * 64}}}
        after = {"labels": ["other (enforce)", "bwrap (enforce)", "unpriv_bwrap (enforce)"],
                 "attachments": {"other.1": "<unknown>", "bwrap.2": "/usr/bin/bwrap", "unpriv.3": "unpriv_bwrap"},
                 "opaque": before["opaque"]}
        class RootPath:
            def __init__(self, value): self.value = value
            def __str__(self): return self.value
            def __fspath__(self): return self.value
            def lstat(self): return SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o555)
        for outcome in ("accepted", "opaque-new-profiles", "opaque-body-drift", "opaque-before-drift",
                        "wrong-new-opaque", "collision", "site-alias", "changed-baseline", "load-timeout", "partial-readback"):
            retained = {}
            def exclusive(filename, data, retained=retained):
                self.assertNotIn(str(filename), retained)
                retained[str(filename)] = data
            def bounded(filename, _maximum=131072):
                name = str(filename)
                if name.endswith(".apparmor"):
                    return source
                if name.endswith("/apparmor_parser"):
                    return b"controlled parser"
                if name.endswith("/apparmor_restrict_unprivileged_userns"):
                    return b"1\n"
                if name.endswith("/abi/4.0"):
                    return b"controlled ABI"
                if name.endswith("/profile.binary"):
                    return binary
                raise AssertionError("unexpected root read " + name)
            def run(arguments, _seconds, _maximum=8192, outcome=outcome):
                if "--preprocess" in arguments:
                    return b"alias\t/usr/bin/bwrap -> /other,\n" if outcome == "site-alias" else b"# controlled flattened profile\n"
                if "--names" in arguments:
                    return b"bwrap\nunpriv_bwrap\n"
                if "--stdout" in arguments:
                    return binary
                if "--version" in arguments:
                    return b"controlled parser version"
                self.assertIn("--add", arguments)
                self.assertIn("--binary", arguments)
                self.assertIn("--skip-cache", arguments)
                self.assertIn("--config-file=/dev/null", arguments)
                if outcome == "load-timeout":
                    raise subprocess.TimeoutExpired(arguments, 5)
                return b""
            observed_after = json.loads(json.dumps(after))
            if outcome in ("opaque-new-profiles", "wrong-new-opaque"):
                for key, name in (("bwrap.2", "bwrap"), ("unpriv.3", "unpriv_bwrap")):
                    observed_after["attachments"][key] = "<unknown>"
                    observed_after["opaque"][key] = {"name": name, "mode": "enforce", "sha256": "b" * 64}
                if outcome == "wrong-new-opaque":
                    observed_after["opaque"]["bwrap.2"]["name"] = "unexpected"
            elif outcome == "opaque-body-drift":
                observed_after["opaque"]["other.1"]["sha256"] = "c" * 64
            state = Mock(side_effect=[before, before, observed_after])
            if outcome == "collision":
                state.side_effect = AssertionError("existing label")
            elif outcome == "opaque-before-drift":
                changed = json.loads(json.dumps(before))
                changed["opaque"]["other.1"]["sha256"] = "d" * 64
                state.side_effect = [before, changed]
            elif outcome == "changed-baseline":
                state.side_effect = [before, after]
            elif outcome == "partial-readback":
                state.side_effect = [before, before, before]
            scope = {"Path": RootPath, "src": PurePosixPath("/controlled/scripts"), "target": PurePosixPath("/controlled/installed"),
                     "context": {"run": "controlled"}, "wanted": {"source": "controlled"}, "result": {},
                     "os": SimpleNamespace(path=SimpleNamespace(lexists=Mock(return_value=False)), uname=lambda: SimpleNamespace(release="controlled")),
                     "stat": stat, "json": json, "re": re, "hashlib": hashlib, "run": Mock(side_effect=run),
                     "bounded": bounded, "digest": lambda value: pin if value == source else hashlib.sha256(value).hexdigest(),
                     "exclusive": exclusive, "features": Mock(return_value={"fixed": "yes"}), "profile_state": state}
            self.root_functions({"setup_profile", "profile_summary"}, scope)
            with self.subTest(outcome=outcome):
                if outcome in ("accepted", "opaque-new-profiles"):
                    scope["setup_profile"]()
                    self.assertTrue(scope["result"]["profile"]["completed"])
                    self.assertEqual(scope["result"]["profile"]["opaque_attachments"]["count"], 1)
                    self.assertIn("unresolved", scope["result"]["profile"]["opaque_attachments"]["status"])
                else:
                    with self.assertRaises((AssertionError, subprocess.TimeoutExpired)):
                        scope["setup_profile"]()
                loads = [call for call in scope["run"].call_args_list if "--add" in call.args[0]]
                self.assertEqual(len(loads), int(outcome in ("accepted", "opaque-new-profiles", "opaque-body-drift",
                                                           "wrong-new-opaque", "load-timeout", "partial-readback")))
                self.assertFalse(any("--replace" in call.args[0] for call in scope["run"].call_args_list))
                if loads:
                    self.assertTrue(scope["result"]["profile"]["load_attempted"])
                    self.assertIn("/controlled/installed/profile-add-intent.json", retained)
                    self.assertEqual(retained["/controlled/installed/profile.binary"], binary)
                if outcome == "collision":
                    self.assertEqual(retained, {})

    def test_actual_inert_child_requires_usable_exact_null_device_before_spawning(self):
        node = next(node for node in ast.parse(readiness.CHILD).body
                    if isinstance(node, ast.FunctionDef) and node.name == "null_device")
        for condition in ("accepted", "regular-file", "wrong-device", "open-refused"):
            fake_os = SimpleNamespace(stat=Mock(return_value=SimpleNamespace(
                st_mode=stat.S_IFREG if condition == "regular-file" else stat.S_IFCHR, st_rdev=259)),
                major=Mock(return_value=1), minor=Mock(return_value=5 if condition == "wrong-device" else 3),
                open=Mock(side_effect=PermissionError("controlled") if condition == "open-refused" else None, return_value=9),
                close=Mock(), O_RDWR=2, O_CLOEXEC=4, O_NOFOLLOW=8)
            scope = {"os": fake_os, "stat": stat}
            exec(compile(ast.Module(body=[node], type_ignores=[]), "actual-inert-null-device", "exec"), scope)
            with self.subTest(condition=condition):
                if condition == "accepted":
                    self.assertEqual(scope["null_device"](),
                                     {"kind": "character", "major": 1, "minor": 3, "readwrite_opened": True})
                    fake_os.open.assert_called_once_with("/dev/null", 14)
                    fake_os.close.assert_called_once_with(9)
                else:
                    with self.assertRaises((AssertionError, PermissionError)):
                        scope["null_device"]()
                    fake_os.close.assert_not_called()
                fake_os.stat.assert_called_once_with("/dev/null", follow_symlinks=False)

    def test_postexec_policy_requires_enforcing_stack_unchanged_nnp_and_zero_capabilities(self):
        policy = {"apparmor": "bwrap//&unpriv_bwrap (enforce)", "NoNewPrivs": "1", "userns_restriction": "1",
                  "capabilities": dict.fromkeys(("CapEff", "CapPrm", "CapInh", "CapAmb", "CapBnd"), "0000000000000000")}
        readiness.check_namespace_policy(policy)
        for field, value in (("apparmor", "unconfined"), ("NoNewPrivs", "0"), ("userns_restriction", "0"),
                             ("capabilities", {**policy["capabilities"], "CapEff": "0000000000000001"})):
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                readiness.check_namespace_policy({**policy, field: value})

    def test_actual_profile_evidence_collection_refuses_missing_changed_and_foreign_inputs(self):
        module = ast.parse(Path(readiness.__file__).read_text())
        function = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "prepare_for_original_hosted_parent")
        outer = next(node for node in function.body if isinstance(node, ast.Try))
        for condition in ("accepted", "missing-intent", "foreign-context", "missing-binary", "changed-binary"):
            with tempfile.TemporaryDirectory() as temporary:
                installed, destination = Path(temporary) / "installed", Path(temporary) / "destination"
                installed.mkdir()
                destination.mkdir()
                context, pins = {"run": "new"}, {"source": "reviewed"}
                binary, evidence = b"compiled", b"evidence"
                result = {"failure": None, "setup": {"profile": {"completed": True,
                          "compiled_sha256": hashlib.sha256(binary).hexdigest(),
                          "evidence_sha256": hashlib.sha256(evidence).hexdigest()}}}
                payloads = {"profile-intent.json": json.dumps({"context": context, "source_sha256": pins}).encode(),
                            "profile-add-intent.json": b"add intent", "profile-evidence.json": evidence,
                            "profile.expanded": b"expanded", "profile.abi": b"abi", "profile.binary": binary}
                if condition == "missing-intent":
                    del payloads["profile-intent.json"]
                elif condition == "foreign-context":
                    payloads["profile-intent.json"] = json.dumps({"context": {"run": "old"}, "source_sha256": pins}).encode()
                elif condition == "missing-binary":
                    del payloads["profile.binary"]
                elif condition == "changed-binary":
                    payloads["profile.binary"] = b"different"
                for name, data in payloads.items():
                    (installed / name).write_bytes(data)
                scope = {"INSTALLED": installed, "context": context, "pins": pins, "result": result,
                         "directory": destination, "stat": stat, "json": json, "hashlib": hashlib,
                         "need": readiness.need, "retain": readiness.retain}
                info = SimpleNamespace(st_mode=stat.S_IFREG | 0o444, st_uid=0, st_nlink=1, st_size=1)
                with self.subTest(condition=condition), patch.object(type(installed), "lstat", return_value=info), patch("builtins.print"):
                    exec(compile(ast.Module(body=outer.finalbody, type_ignores=[]), "actual-prepare-final-profile-collection", "exec"), scope)
                if condition == "accepted":
                    self.assertIsNone(result["failure"])
                    self.assertEqual(len(result["profile_files"]), 6)
                else:
                    self.assertIsNotNone(result["failure"])
                    self.assertIn("profile_evidence_failure", result)
                self.assertFalse(result["automatic_retry"])
                self.assertEqual(result["production"], "held")
                if condition == "foreign-context":
                    self.assertNotIn("profile_files", result)

    def test_actual_final_profile_readback_preserves_original_ambiguous_load(self):
        outer = [node for node in ast.parse(readiness.ROOT_SETUP).body if isinstance(node, ast.Try)]
        self.assertEqual(len(outer), 1)
        nodes = [node for node in outer[0].finalbody if isinstance(node, ast.If) and ast.unparse(node.test) == "result.get('profile')"]
        self.assertEqual(len(nodes), 1)
        for available in (True, False):
            result = {"profile": {"load_attempted": True}, "failure": "original parser timeout"}
            state = {"labels": ["bwrap (enforce)"]}  # Only one label observed: never whole-load success.
            reader = Mock(return_value=state) if available else Mock(side_effect=OSError("readback unavailable"))
            scope = {"result": result, "profile_state": reader, "profile_summary": lambda value: value}
            exec(compile(ast.Module(body=nodes, type_ignores=[]), "actual-final-profile-readback", "exec"), scope)
            self.assertEqual(result["failure"], "original parser timeout")
            self.assertTrue(result["profile"]["load_attempted"])
            self.assertNotIn("completed", result["profile"])
            if available:
                self.assertEqual(result["profile"]["final_state"], state)
            else:
                self.assertEqual(result["profile"]["readback_error"], "OSError")
            reader.assert_called_once()

    def test_actual_inert_entry_executes_only_fixed_command_after_exact_release(self):
        invocation = "a" * 64
        creation = {"pid": 42, "creation_ticks": "123"}
        packet = {"invocation_id": invocation, "unit_invocation_id": "b" * 32,
                  "pid": 42, "creation": creation, "deadline_monotonic": 20}
        for condition in ("accepted", "wrong-retained", "wrong-generation", "changed-creation", "expired"):
            expected = dict(packet)
            current_packet = dict(packet)
            generation = "b" * 32
            current_creation = creation
            if condition == "wrong-retained":
                expected["pid"] = 43
            elif condition == "wrong-generation":
                generation = "c" * 32
            elif condition == "changed-creation":
                current_creation = {"pid": 42, "creation_ticks": "456"}
            elif condition == "expired":
                current_packet["deadline_monotonic"] = expected["deadline_monotonic"] = 9
            supervisor = {"observe_root_creation": Mock(side_effect=[creation, current_creation]),
                          "create_file": Mock(), "decode": json.loads,
                          "read_regular": Mock(return_value=json.dumps(expected).encode())}
            with self.subTest(condition=condition), \
                    patch.dict("sys.modules", {"pwd": SimpleNamespace(getpwnam=lambda _name: SimpleNamespace(pw_uid=1002, pw_gid=1002))}), \
                    patch.dict(readiness.os.environ, {"INVOCATION_ID": generation}, clear=True), \
                    patch.object(readiness.os, "getuid", return_value=1002, create=True), patch.object(readiness.os, "getgid", return_value=1002, create=True), \
                    patch.object(readiness.os, "getpid", return_value=42), patch.object(readiness.time, "monotonic", return_value=10), \
                    patch.object(readiness, "load_supervisor", return_value=supervisor), \
                    patch.object(readiness, "public_policy", return_value={"inert": True}), \
                    patch.object(readiness, "wait_release", return_value=json.dumps(current_packet).encode()), \
                    patch.object(readiness.os, "execve", create=True) as execute:
                if condition == "accepted":
                    readiness.inert_entry(invocation)
                    execute.assert_called_once()
                    executable, arguments, environment = execute.call_args.args
                    self.assertEqual(executable, "/usr/bin/bwrap")
                    self.assertEqual(arguments[0], executable)
                    self.assertIn(readiness.CHILD, arguments)
                    self.assertIn("--cap-drop", arguments)
                    index = arguments.index("--dev-bind")
                    self.assertEqual(arguments[index + 1:index + 3], ["/dev/null", "/dev/null"])
                    self.assertGreater(index, arguments.index("--bind"))
                    self.assertNotIn("--dev", arguments)
                    self.assertEqual(environment, readiness.ENV)
                else:
                    with self.assertRaises(RuntimeError):
                        readiness.inert_entry(invocation)
                    execute.assert_not_called()
                supervisor["create_file"].assert_called_once()

    def test_kernel_readback_is_read_only_exact_pid_time_filtered_without_retry(self):
        probe = {"entry_pid": 42, "entry": {"pid": 42, "creation": {"pid": 42, "creation_ticks": "123"}}}
        reply = SimpleNamespace(returncode=1, stdout=b"", stderr=b"journal unavailable")
        with patch.object(readiness.subprocess, "run", return_value=reply) as run:
            observed = readiness.denial_observation(probe, 100, 120)
        self.assertEqual(observed["exit"], 1)
        self.assertEqual(observed["messages"], [])
        self.assertFalse(observed["automatic_retry"])
        self.assertIn("journal unavailable", observed["stderr"])
        arguments = run.call_args.args[0]
        self.assertIn("--since=@100", arguments)
        self.assertIn("--until=@120", arguments)
        pattern = next(value.removeprefix("--grep=") for value in arguments if value.startswith("--grep="))
        self.assertIsNotNone(readiness.re.search(pattern, 'audit: apparmor="DENIED" operation="userns_create" pid=42 comm="bwrap" requested="userns_create"'))
        for decoy in ('ppid=42 comm="bwrap"', 'pid=420 comm="bwrap"', 'pid=42 comm="other"',
                      'pid=42 somecomm="bwrap"'):
            self.assertIsNone(readiness.re.search(pattern, 'audit: apparmor="DENIED" ' + decoy))
        self.assertEqual(run.call_count, 1)
        with patch.object(readiness.subprocess, "run") as run, self.assertRaises(RuntimeError):
            readiness.denial_observation({**probe, "entry_pid": "42; arbitrary"}, 100, 120)
        run.assert_not_called()

    def test_partial_release_is_bounded_by_original_deadline_and_eof_is_refused(self):
        with patch.object(readiness.time, "monotonic", side_effect=[10, 11, 12]), \
                patch.object(readiness.select, "select", return_value=([7], [], [])) as selected, \
                patch.object(readiness.os, "read", side_effect=[b'{"x":', b'1}\n']):
            self.assertEqual(readiness.wait_release(7, 15), b'{"x":1}')
            self.assertEqual([call.args[3] for call in selected.call_args_list], [5, 4])
        for parts, reason in (([b""], "closed"), ([b"x\ny\n"], "framing"), ([b"x" * 2049], "bound")):
            with self.subTest(reason=reason), patch.object(readiness.time, "monotonic", return_value=10), \
                    patch.object(readiness.select, "select", return_value=([7], [], [])), \
                    patch.object(readiness.os, "read", side_effect=parts), self.assertRaisesRegex(RuntimeError, reason):
                readiness.wait_release(7, 15)
        with patch.object(readiness.time, "monotonic", return_value=15), \
                patch.object(readiness.os, "read") as read, self.assertRaisesRegex(RuntimeError, "expired"):
            readiness.wait_release(7, 15)
        read.assert_not_called()

    def test_release_checks_exact_retained_tuple_generation_creation_and_original_clock(self):
        expected = {"invocation_id": "a" * 64, "unit_invocation_id": "b" * 32,
                    "pid": 42, "creation": {"pid": 42, "creation_ticks": "123"}, "deadline_monotonic": 15}
        with patch.object(readiness.time, "monotonic", return_value=10):
            readiness.check_release(expected, expected, "b" * 32, 42, expected["creation"], 20)
            for field, value in (("pid", 43), ("unit_invocation_id", "c" * 32), ("creation", {}),
                                 ("deadline_monotonic", float("nan"))):
                changed = {**expected, field: value}
                with self.subTest(field=field), self.assertRaises(RuntimeError):
                    readiness.check_release(changed, expected, "b" * 32, 42, expected["creation"], 20)
        with patch.object(readiness.time, "monotonic", return_value=15), self.assertRaisesRegex(RuntimeError, "expired"):
            readiness.check_release(expected, expected, "b" * 32, 42, expected["creation"], 20)

    def test_release_rechecks_actual_unit_and_root_generation_before_admission(self):
        properties = {"MainPID": "42"}
        creation = {"pid": 42, "creation_ticks": "123"}
        supervisor = {"unit_properties": Mock(return_value=properties), "inspect_unit_properties": Mock(),
                      "inspect_unit_identity": Mock(), "observe_root_creation": Mock(return_value=creation)}
        group = SimpleNamespace(read=Mock(return_value="42\n"))
        entry = {"invocation_id": "a" * 64, "pid": 42, "creation": creation}
        with patch.object(readiness.time, "monotonic", return_value=10):
            binding = readiness.release_binding(supervisor, "owned.service", "b" * 32, group, entry, "a" * 64, 15)
            self.assertEqual(binding["pid"], 42)
            supervisor["inspect_unit_identity"].assert_called_once_with(properties, "owned.service", "b" * 32)
            supervisor["observe_root_creation"].return_value = {"pid": 42, "creation_ticks": "456"}
            with self.assertRaisesRegex(RuntimeError, "process generation"):
                readiness.release_binding(supervisor, "owned.service", "b" * 32, group, entry, "a" * 64, 15)

    def test_fast_namespace_refusal_preserves_original_held_cleanup_and_failed_result(self):
        invocation = "ab" * 32
        creation = {"pid": 42, "creation_ticks": "123"}
        active = {"ActiveState": "active", "MainPID": "42", "InvocationID": "b" * 32}
        with tempfile.TemporaryDirectory() as temporary:
            guest = Path(temporary)
            def launch(*_arguments, **_keywords):
                readiness.retain(guest / "invocations" / invocation / "capture/entry.json",
                                 {"invocation_id": invocation, "pid": 42, "creation": creation, "policy": {}})
                return process
            process = SimpleNamespace(stdin=io.BytesIO(), poll=Mock(side_effect=[None, 1]), returncode=1,
                                      communicate=Mock(return_value=(None, b"bwrap: setting up uid map: Permission denied")))
            group = SimpleNamespace(identity=(1, 2), path=Path("/sys/fs/cgroup/owned"),
                                    read=Mock(return_value="42\n"), empty=Mock(return_value=True),
                                    last_observation="removed-exact-held-cgroup", close=Mock())
            supervisor = {"unit_properties": Mock(side_effect=[{"LoadState": "not-found"}, active, active, {"settled": True}]),
                          "inspect_unit_properties": Mock(), "inspect_unit_identity": Mock(),
                          "HeldCgroup": Mock(return_value=group), "observe_root_creation": Mock(return_value=creation),
                          "control_environment": Mock(return_value={}), "settled_unit": lambda value: value.get("settled", False),
                          "systemctl": Mock(), "read_marker": lambda filename, _maximum: json.loads(filename.read_bytes())}
            with patch.dict("sys.modules", {"pwd": SimpleNamespace(getpwnam=lambda _name: SimpleNamespace(pw_uid=1002, pw_gid=1002))}), \
                    patch.object(readiness, "GUEST", guest), patch.object(readiness, "load_supervisor", return_value=supervisor), \
                    patch.object(readiness.os, "getuid", return_value=1002, create=True), patch.object(readiness.os, "getgid", return_value=1002, create=True), \
                    patch.object(readiness.os, "urandom", return_value=bytes.fromhex(invocation)), \
                    patch.object(readiness.subprocess, "Popen", side_effect=launch), patch("builtins.print"):
                self.assertEqual(readiness.probe(), 1)
            result = json.loads((guest / "invocations" / invocation / "capture/probe.json").read_bytes())
            self.assertFalse(result["passed"])
            self.assertIn("did not report readiness", result["failure"])
            self.assertIn("Permission denied", result["unit_stderr"])
            self.assertTrue(result["cgroup_empty"] and result["unit_settled"])
            group.close.assert_called_once()
            supervisor["systemctl"].assert_not_called()
            self.assertTrue((guest / "invocations" / invocation / "capture/release.json").exists())

    def root_runner(self, child):
        # Actual embedded streaming runner, with every OS/provider effect inert.
        streams = {7: collections.deque([b"observed", b""]), 8: collections.deque([b""])}
        child.stdout = SimpleNamespace(fileno=lambda: 7, close=Mock())
        child.stderr = SimpleNamespace(fileno=lambda: 8, close=Mock())
        class InertSelector:
            def __init__(self): self.entries = {}
            def register(self, stream, _events, name): self.entries[stream.fileno()] = (stream, name)
            def get_map(self): return self.entries
            def select(self, _seconds):
                return [(SimpleNamespace(fd=fd, fileobj=stream, data=name), 1)
                        for fd, (stream, name) in list(self.entries.items())]
            def unregister(self, stream): del self.entries[stream.fileno()]
            def close(self): pass
        selector = InertSelector()
        scope = {
            "deadline": 20, "result": {}, "time": SimpleNamespace(monotonic=Mock(return_value=10)),
            "original_fence": Mock(), "selectors": SimpleNamespace(DefaultSelector=lambda: selector, EVENT_READ=1),
            "os": SimpleNamespace(killpg=Mock(), set_blocking=Mock(), read=lambda fd, _size: streams[fd].popleft()),
            "signal": SimpleNamespace(SIGKILL=9),
            "subprocess": SimpleNamespace(Popen=Mock(return_value=child), DEVNULL=subprocess.DEVNULL, PIPE=subprocess.PIPE),
            "selector": selector,
        }
        self.root_functions({"run"}, scope)
        return scope

    def test_actual_root_runner_uses_original_budget_and_one_owned_session(self):
        child = SimpleNamespace(pid=42, returncode=0, wait=Mock(return_value=0))
        scope = self.root_runner(child)
        arguments = ["/usr/sbin/useradd", "fixed-inert-arguments"]
        self.assertEqual(scope["run"](arguments, 30), b"observed")
        child.wait.assert_called_once_with(timeout=10)
        scope["subprocess"].Popen.assert_called_once_with(arguments, stdin=subprocess.DEVNULL,
                                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        scope["os"].killpg.assert_not_called()
        child.stdout.close.assert_called_once()
        child.stderr.close.assert_called_once()

    def test_actual_root_timeout_signals_original_group_and_preserves_original_failure(self):
        original = subprocess.TimeoutExpired(["/usr/sbin/useradd"], 10)
        child = SimpleNamespace(pid=42, returncode=None, wait=Mock(return_value=0))
        scope = self.root_runner(child)
        scope["selector"].select = Mock(side_effect=original)
        with self.assertRaises(subprocess.TimeoutExpired) as caught:
            scope["run"](["/usr/sbin/useradd"], 30)
        self.assertIs(caught.exception, original)
        scope["os"].killpg.assert_called_once_with(42, 9)
        self.assertEqual(scope["result"]["command_timeout"], {
            "executable": "/usr/sbin/useradd", "seconds": 10, "group_kill_sent": True, "child_reaped": True,
        })
        self.assertEqual(scope["subprocess"].Popen.call_count, 1)

    def test_actual_root_timeout_retains_unknown_kill_or_reap_without_retry(self):
        for fault in ("kill", "reap"):
            original = subprocess.TimeoutExpired(["/usr/sbin/useradd"], 10)
            child = SimpleNamespace(pid=42, returncode=None, wait=Mock(side_effect=RuntimeError("inert reap unavailable")))
            scope = self.root_runner(child)
            scope["selector"].select = Mock(side_effect=original)
            if fault == "kill":
                scope["os"].killpg.side_effect = PermissionError("inert signal refused")
            with self.subTest(fault=fault), self.assertRaises(subprocess.TimeoutExpired) as caught:
                scope["run"](["/usr/sbin/useradd"], 30)
            self.assertIs(caught.exception, original)
            retained = scope["result"]["command_timeout"]
            self.assertFalse(retained["child_reaped"])
            self.assertEqual(retained["group_kill_sent"], fault != "kill")
            self.assertIn("settlement_error", retained)
            self.assertEqual(scope["subprocess"].Popen.call_count, 1)

    def test_actual_root_runner_refuses_late_success_without_signalling_a_finished_child(self):
        child = SimpleNamespace(pid=42, returncode=0, wait=Mock(return_value=0))
        scope = self.root_runner(child)
        def finished(**_keywords):
            scope["time"].monotonic.return_value = 21
            return 0
        child.wait.side_effect = finished
        with self.assertRaisesRegex(AssertionError, "original setup deadline expired"):
            scope["run"](["/usr/sbin/useradd"], 30)
        scope["os"].killpg.assert_not_called()

    def test_actual_root_runner_refuses_changed_parent_and_excess_output(self):
        for refusal in ("parent", "output"):
            child = SimpleNamespace(pid=42, returncode=None, wait=Mock(return_value=0))
            scope = self.root_runner(child)
            if refusal == "parent":
                scope["original_fence"].side_effect = [None, AssertionError("original parent generation changed")]
            else:
                scope["os"].read = Mock(return_value=b"x" * 8193)
            with self.subTest(refusal=refusal), self.assertRaisesRegex(AssertionError, "generation changed|output exceeds"):
                scope["run"](["fixed-inert-command"], 30)
            scope["os"].killpg.assert_called_once_with(42, 9)

    def test_original_parent_expiry_prevents_any_setup_effect(self):
        lifetime = {"broker_uid": 1001, "broker_pid": 42, "broker_identity": "unused", "deadline_ns": "1"}
        with patch.object(readiness, "LIFETIME", lifetime), patch.object(readiness.subprocess, "Popen") as launch:
            with self.assertRaisesRegex(AssertionError, "deadline expired"):
                readiness.command(["must-not-start"])
            launch.assert_not_called()

    def test_actual_root_final_readback_cannot_promote_late_or_replace_prior_failure(self):
        nodes = [node for node in ast.parse(readiness.ROOT_SETUP).body if isinstance(node, ast.Try)]
        self.assertEqual(len(nodes), 1)
        for previous_failure in (None, "original useradd timeout"):
            result = {"completed": True, "failure": previous_failure, "stage": "useradd"}
            public = b"portcove-native:x:1002:1002::/home/portcove-native:/usr/sbin/nologin\n"
            info = SimpleNamespace(st_uid=1002, st_gid=1002, st_mode=stat.S_IFDIR | 0o700)
            scope = {"result": result, "deadline": 20, "time": SimpleNamespace(monotonic=lambda: 21),
                     "Path": Mock(return_value=SimpleNamespace(read_bytes=Mock(return_value=public), lstat=Mock(return_value=info))),
                     "stat": stat, "json": json, "print": Mock()}
            exec(compile(ast.Module(body=nodes[0].finalbody, type_ignores=[]), "actual-embedded-root-final-readback", "exec"), scope)
            self.assertFalse(result["completed"])
            self.assertEqual(result["failure"], previous_failure or "original setup readback deadline expired")
            self.assertEqual(result["readback"]["account"]["uid"], "1002")

    def test_setup_success_requires_actual_account_and_private_path_readback(self):
        setup = {
            "completed": True, "failure": None, "uid": 1002, "gid": 1002,
            "profile": {"completed": True, "source_sha256": "11d39094f044f0cda0febb3ad517b830301da6b2ce929664af09ee9e4dd264f9",
                        "after": {"labels": ["bwrap (enforce)", "unpriv_bwrap (enforce)"]},
                        "final_state": {"labels": ["bwrap (enforce)", "unpriv_bwrap (enforce)"]}},
            "readback": {
                "account": {"uid": "1002", "gid": "1002", "home": "/home/portcove-native", "shell": "/usr/sbin/nologin"},
                "paths": {
                    "/home/portcove-native": {"directory": True, "uid": 1002, "gid": 1002, "mode": "0o40700"},
                    str(readiness.GUEST): {"directory": True, "uid": 1002, "gid": 1002, "mode": "0o40700"},
                    str(readiness.INSTALLED): {"directory": True, "uid": 0, "gid": 0, "mode": "0o40755"},
                },
            },
        }
        readiness.require_setup_readback(setup, 1001)
        for change in ("failed", "missing-readback", "wrong-account", "writable-path", "same-broker", "missing-profile", "partial-load", "changed-profile"):
            modified = json.loads(json.dumps(setup))
            broker = 1001
            if change == "failed":
                modified.update(completed=False, failure="original useradd timeout; partial effects possible")
            elif change == "missing-readback":
                modified["readback_error"] = "unavailable"
            elif change == "wrong-account":
                modified["readback"]["account"]["uid"] = "1003"
            elif change == "writable-path":
                modified["readback"]["paths"][str(readiness.GUEST)]["mode"] = "0o40777"
            elif change == "missing-profile":
                del modified["profile"]
            elif change == "partial-load":
                modified["profile"]["completed"] = False
            elif change == "changed-profile":
                modified["profile"]["final_state"] = {"labels": ["bwrap (complain)"]}
            else:
                broker = 1002
            original = json.dumps(modified)
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                readiness.require_setup_readback(modified, broker)
            self.assertEqual(json.dumps(modified), original)

    def test_empty_checkout_creates_work_parent_but_retained_attempt_is_never_reused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.assertFalse((root / "work").exists())
            directory = readiness.begin_attempt(root, {"GITHUB_SHA": "a" * 40}, {"fixed": "b" * 64}, "c" * 40)
            original = (directory / "intent.json").read_bytes()
            self.assertEqual(json.loads(original)["GITHUB_SHA"], "a" * 40)
            self.assertFalse(json.loads(original)["automatic_retry"])
            with self.assertRaises(FileExistsError):
                readiness.begin_attempt(root, {"GITHUB_SHA": "d" * 40}, {}, "e" * 40)
            self.assertEqual((directory / "intent.json").read_bytes(), original)

    def test_existing_work_parent_is_preserved_without_reusing_an_attempt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "work").mkdir()
            unrelated = root / "work/unrelated-evidence.json"
            unrelated.write_bytes(b"retain unrelated evidence")
            readiness.begin_attempt(root, {}, {}, "c" * 40)
            self.assertEqual(unrelated.read_bytes(), b"retain unrelated evidence")

    def setUp(self):
        self.group = SimpleNamespace(empty=Mock(return_value=True), last_observation="observed-unpopulated")
        self.supervisor = {
            "unit_properties": Mock(return_value={"generation": "old", "settled": False}),
            "inspect_unit_identity": Mock(),
            "systemctl": Mock(return_value=(1, b"ambiguous response")),
            "settled_unit": lambda value: value["settled"],
        }

    def test_wrong_generation_refuses_kill_even_when_held_cgroup_is_empty(self):
        self.supervisor["inspect_unit_identity"].side_effect = RuntimeError("generation changed")
        with self.assertRaisesRegex(RuntimeError, "generation changed"):
            readiness.settle_observed(self.supervisor, "owned.service", "old", self.group)
        self.supervisor["systemctl"].assert_not_called()

    def test_positive_original_cgroup_and_settled_unit_need_no_signal(self):
        self.supervisor["unit_properties"].return_value = {"settled": True}
        result = readiness.settle_observed(self.supervisor, "owned.service", "old", self.group)
        self.assertTrue(result["cgroup_empty"] and result["unit_settled"])
        self.supervisor["systemctl"].assert_not_called()

    def test_failed_kill_response_requires_actual_readback_to_resolve_effect(self):
        self.supervisor["unit_properties"].side_effect = [{"settled": False}, {"settled": True}]
        result = readiness.settle_observed(self.supervisor, "owned.service", "old", self.group)
        self.assertTrue(result["cgroup_empty"] and result["unit_settled"])
        self.supervisor["inspect_unit_identity"].assert_called_once()
        self.supervisor["systemctl"].assert_called_once_with("kill", "--signal=KILL", "--kill-whom=all", "owned.service")

    def test_deadline_never_turns_populated_cgroup_into_positive_settlement(self):
        self.group.empty.return_value = False
        with patch.object(readiness.time, "monotonic", side_effect=[10, 19, 19]), self.assertRaisesRegex(RuntimeError, "settlement remains unknown"):
            readiness.settle_observed(self.supervisor, "owned.service", "old", self.group)
        self.assertIsNone(self.supervisor["COMMAND_DEADLINE"])

    def test_late_positive_readback_refuses_and_restores_original_command_deadline(self):
        clock = [10]
        self.supervisor["COMMAND_DEADLINE"] = 17
        def read(_unit):
            self.assertEqual(self.supervisor["COMMAND_DEADLINE"], 17)
            clock[0] = 18
            return {"settled": True}
        self.supervisor["unit_properties"].side_effect = read
        with patch.object(readiness.time, "monotonic", side_effect=lambda: clock[0]), self.assertRaisesRegex(RuntimeError, "deadline expired"):
            readiness.settle_observed(self.supervisor, "owned.service", "old", self.group)
        self.assertEqual(self.supervisor["COMMAND_DEADLINE"], 17)
        self.supervisor["systemctl"].assert_not_called()

    def test_empty_cgroup_waits_for_later_unit_settlement_within_same_budget(self):
        self.supervisor["unit_properties"].side_effect = [{"settled": False}, {"settled": False}, {"settled": True}]
        with patch.object(readiness.time, "sleep"):
            result = readiness.settle_observed(self.supervisor, "owned.service", "old", self.group)
        self.assertTrue(result["cgroup_empty"] and result["unit_settled"])

    def test_owner_host_wrong_workflow_and_repeated_attempt_refuse_before_setup(self):
        environment = {
            "GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "boburning/portcove",
            "RUNNER_ENVIRONMENT": "github-hosted", "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_RUN_ATTEMPT": "1", "GITHUB_RUN_ID": "12345", "GITHUB_SHA": "a" * 40,
            "GITHUB_WORKFLOW_REF": "boburning/portcove/.github/workflows/hosted-native-linux-readiness.yml@refs/heads/main",
        }
        with patch.object(readiness.platform, "system", return_value="Linux"), patch.object(readiness.platform, "machine", return_value="x86_64"):
            self.assertEqual(readiness.hosted_context(environment)["GITHUB_SHA"], "a" * 40)
            for change in ({"GITHUB_ACTIONS": "false"}, {"GITHUB_RUN_ATTEMPT": "2"},
                           {"GITHUB_EVENT_NAME": "pull_request"}, {"GITHUB_WORKFLOW_REF": "foreign/workflow"}):
                with self.subTest(change=change), self.assertRaises(RuntimeError):
                    readiness.hosted_context({**environment, **change})


@unittest.skipUnless(sys.platform == "linux", "actual original Linux parent identity and filesystem")
class RuntimeInputFixture(unittest.TestCase):
    def root(self, directory):
        root = Path(directory)
        (root / "scripts").mkdir()
        (root / "scripts/prepare-hosted-native-linux-installation.py").write_text("# inert fixture, never executed\n")
        return root

    def context(self):
        return {"GITHUB_SHA": "a" * 40, "GITHUB_RUN_ID": "12345", "GITHUB_RUN_ATTEMPT": "1",
                "GITHUB_WORKFLOW_REF": "boburning/portcove/.github/workflows/hosted-native-linux-readiness.yml@refs/heads/main"}

    def test_direct_fixed_child_capture_and_no_second_attempt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.root(temporary)
            def child(arguments, timeout):
                self.assertEqual(timeout, 95)
                self.assertEqual(arguments[:4], ["/usr/bin/sudo", "-n", "--", "/usr/bin/python3"])
                self.assertEqual(arguments[-2], "--runtime-packages")
                plan = json.loads(arguments[-1])
                self.assertEqual(plan["broker_pid"], os.getpid())
                self.assertEqual(plan["broker_uid"], os.getuid())
                self.assertEqual(plan["context"], self.context())
                self.assertTrue((root / "work/hosted-linux-runtime-input-fixture-intent.json").is_file())
                return subprocess.CompletedProcess(arguments, 0, b'{"prepared":true}', b'')
            with patch.object(readiness, "verified_diagnostic_source", return_value=lambda *args, **kwargs: b"# inert fixture, never executed\n"), \
                    patch.object(readiness, "bounded_process", side_effect=child) as invoke:
                readiness.prepare_runtime_inputs_for_fixture(root, self.context())
                result = json.loads((root / "work/hosted-linux-runtime-input-fixture.json").read_text())
                self.assertEqual(result["stdout"], '{"prepared":true}')
                self.assertEqual(result["authority"], "none")
                with self.assertRaises(FileExistsError):
                    readiness.prepare_runtime_inputs_for_fixture(root, self.context())
                self.assertEqual(invoke.call_count, 1)

    def test_provider_refusal_is_retained_and_does_not_become_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.root(temporary)
            with patch.object(readiness, "verified_diagnostic_source", return_value=lambda *args, **kwargs: b"# inert fixture, never executed\n"), \
                    patch.object(readiness, "bounded_process", return_value=subprocess.CompletedProcess([], 1, b'{"prepared":false}', b'original refusal')), \
                    self.assertRaisesRegex(RuntimeError, "runtime inputs refused"):
                readiness.prepare_runtime_inputs_for_fixture(root, self.context())
            result = json.loads((root / "work/hosted-linux-runtime-input-fixture.json").read_text())
            self.assertEqual(result["exit_code"], 1)
            self.assertEqual(result["stderr"], "original refusal")

    def test_ambiguous_child_exception_keeps_partial_capture_and_unknown_effects(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.root(temporary)
            error = RuntimeError("original observation expired")
            error.hosted_stdout, error.hosted_stderr = b'partial stdout', b'partial stderr'
            with patch.object(readiness, "verified_diagnostic_source", return_value=lambda *args, **kwargs: b"# inert fixture, never executed\n"), \
                    patch.object(readiness, "bounded_process", side_effect=error), \
                    self.assertRaisesRegex(RuntimeError, "observation expired"):
                readiness.prepare_runtime_inputs_for_fixture(root, self.context())
            result = json.loads((root / "work/hosted-linux-runtime-input-fixture.json").read_text())
            self.assertIsNone(result["prepared"])
            self.assertEqual(result["partial_effects"], "unknown")
            self.assertEqual(result["stdout"], "partial stdout")
            self.assertEqual(result["stderr"], "partial stderr")

    def test_input_refusal_stops_before_account_or_profile_setup(self):
        with patch.object(readiness, "hosted_context", return_value=self.context()), \
                patch.object(readiness, "prepare_runtime_inputs_for_fixture", side_effect=RuntimeError("input refusal")), \
                patch.object(readiness, "prepare_for_original_hosted_parent") as setup:
            with self.assertRaisesRegex(RuntimeError, "input refusal"):
                readiness.prepare()
            setup.assert_not_called()

    def test_wrong_head_dirty_source_or_changed_helper_refuse_before_sudo(self):
        for head, dirty, blob in ((b"b" * 40, b"", b""), (b"a" * 40, b" M helper", b""),
                                  (b"a" * 40, b"", b"different committed helper\n")):
            with self.subTest(head=head, dirty=dirty), tempfile.TemporaryDirectory() as temporary:
                root = self.root(temporary)
                def git(arguments, head=head, dirty=dirty, blob=blob, **kwargs):
                    if "rev-parse" in arguments:
                        return head
                    if "status" in arguments:
                        return dirty
                    return blob
                with patch.object(readiness.os, "getuid", return_value=1001), \
                        patch.object(readiness, "command", side_effect=git), \
                        patch.object(readiness, "bounded_process") as sudo, self.assertRaisesRegex(RuntimeError, "source|helper differs"):
                    readiness.prepare_runtime_inputs_for_fixture(root, self.context())
                sudo.assert_not_called()
                self.assertFalse((root / "work").exists())


if __name__ == "__main__":
    unittest.main()
