"""Inert protocol/entry tests only. No namespace, GUI, UID or native acceptance."""

import copy
import importlib.util
import json
import struct
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

source = Path(__file__).parents[1] / "apps/desktop/scripts/native-linux-isolated-init.py"
spec = importlib.util.spec_from_file_location("native_init", source)
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def binding():
    return {
        "schema_version": 1,
        "nonce": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "qualification_uid": 1002,
        "qualification_gid": 1002,
        "port": 45874,
        "application_original": "/home/native/portcove-native/install/Portcove.AppImage",
        "application_sha256": "a" * 64,
        "home": "/home/native/portcove-native/work/home",
        "environment": {"XDG_CONFIG_HOME": "/home/native/portcove-native/work/home/config"},
        "timeout_seconds": 1700,
        "tools": {
            key: {"path": value, "sha256": "b" * 64}
            for key, value in {
                "python": "/usr/bin/python3",
                "driver": "/native/runtime/tauri-driver",
                "webkit_driver": "/usr/bin/WebKitWebDriver",
                "xvfb": "/usr/bin/Xvfb",
            }.items()
        },
    }


class InertNativeInit(unittest.TestCase):
    def test_update_helper_cannot_impersonate_same_image_application_relaunch(self):
        self.assertEqual(
            native.inspect_public_process_arguments("/tmp/.mount_App/usr/bin/portcove-desktop\0")["role"], "application"
        )
        helper = native.inspect_public_process_arguments(
            "/tmp/.mount_App/usr/bin/portcove-desktop\0--portcove-apply-update\0" + "123\0"
        )
        self.assertEqual(helper["role"], "update-helper")
        for raw in (
            "/app\0--portcove-apply-update\0" + "0\0",
            "/app\0unexpected\0--portcove-apply-update\0" + "123\0",
            "/app\0--portcove-apply-update\0",
            "/app",
            "x" * 16385 + "\0",
        ):
            with self.assertRaises(RuntimeError):
                native.inspect_public_process_arguments(raw)

    def test_public_runtime_absence_is_read_only_not_ready_without_clearing_legacy_failure(self):
        with patch.object(native.Path, "iterdir", return_value=[]):
            with self.assertRaises(native.RuntimeNotReady):
                native.runtime_snapshot(3, 1002, {})
            with self.assertRaisesRegex(RuntimeError, "one actual live candidate") as raised:
                native.runtime_snapshot(3, 1002)
            self.assertNotIsInstance(raised.exception, native.RuntimeNotReady)
        self.assertEqual(
            native.inspect_request({"method": "GET", "path": "/native-public-runtime", "body_base64": ""}),
            ("GET", "/native-public-runtime", b""),
        )
        for method, payload in (("POST", ""), ("DELETE", ""), ("GET", "YQ==")):
            with self.assertRaises(RuntimeError):
                native.inspect_request({"method": method, "path": "/native-public-runtime", "body_base64": payload})

    def test_public_runtime_requires_exact_retained_readonly_fuse_mount_not_driver_ancestry(self):
        target = "/tmp/.mount_PortcoveABC"
        retained = {
            target: {
                "kind": "native-private-fuse",
                "stage": "mounted",
                "runtime": {"pid": 4, "creation_ticks": "100", "package": {"bytes": 123, "sha256": "a" * 64}},
                "mount": {
                    "id": "55",
                    "path": target,
                    "options": ["ro", "nosuid", "nodev"],
                    "filesystem": "fuse.AppImage",
                    "source": "/native/installation/Portcove.AppImage",
                },
            }
        }
        mountinfo = f"55 1 0:55 / {target} ro,nosuid,nodev - fuse.AppImage /native/installation/Portcove.AppImage ro\n"
        image = target + "/usr/bin/portcove-desktop"
        result = native.inspect_public_runtime_mount(image, mountinfo, retained)
        with self.assertRaises(native.RuntimeNotReady):
            native.inspect_public_runtime_mount(image, mountinfo, {})
        retained[target]["runtime"]["package"]["sha256"] = "b" * 64
        self.assertEqual(result["runtime"]["package"]["sha256"], "a" * 64)
        for changed in (
            mountinfo.replace("55 1", "56 1"),
            mountinfo.replace("ro,nosuid,nodev", "rw,nosuid,nodev"),
            mountinfo.replace("fuse.AppImage", "fuse.other"),
            mountinfo.replace("/native/installation/Portcove.AppImage", "/tmp/other.AppImage"),
            "",
        ):
            with self.assertRaises(RuntimeError) as refused:
                native.inspect_public_runtime_mount(image, changed, retained)
            self.assertNotIsInstance(refused.exception, native.RuntimeNotReady)
        for changed in (
            image + " (deleted)",
            image.replace(".mount_PortcoveABC/", ".mount_PortcoveABC-other/"),
            "/native/installation/portcove-desktop",
        ):
            with self.assertRaises(RuntimeError):
                native.inspect_public_runtime_mount(changed, mountinfo, retained)

    def test_ordinary_public_binding_keeps_fixed_paths_source_pins_and_normal_launch_alias(self):
        value = binding()
        invocation = "a" * 64
        value.update(
            {
                "schema_version": 2,
                "home": "/native/profile/client-a",
                "application_original": "/native/installation/Portcove.AppImage",
                "environment": {"XDG_CONFIG_HOME": "/native/profile/client-a/config"},
                "public": {
                    "invocation_id": invocation,
                    "profile_id": "client-a",
                    "deadline_utc": "2026-11-01T00:00:00.000Z",
                    **{
                        key: "b" * 64
                        for key in (
                            "services_sha256",
                            "fuse_sha256",
                            "network_sha256",
                            "fuse_policy_sha256",
                            "network_policy_sha256",
                        )
                    },
                },
            }
        )
        actual = native.inspect_binding(copy.deepcopy(value))
        request = {
            "capabilities": {
                "alwaysMatch": {"browserName": "wry", "tauri:options": {"application": actual["application_original"]}}
            }
        }
        rewritten = json.loads(native.rewrite_session(json.dumps(request).encode(), actual))
        self.assertEqual(
            rewritten["capabilities"]["alwaysMatch"]["tauri:options"],
            {"application": "/native/installation/Portcove.AppImage"},
        )
        for alter in (
            lambda item: item.update({"schema_version": 1}),
            lambda item: item["public"].pop("services_sha256"),
            lambda item: item["public"].update({"profile_id": "caller-selected"}),
            lambda item: item.update({"home": "/native/profile/client-b"}),
            lambda item: item.update({"application_original": "/tmp/unbounded.AppImage"}),
            lambda item: item["public"].update({"deadline_utc": "2026-11-01T00:00:00Z"}),
            lambda item: item["environment"].update({"APPIMAGE_EXTRACT_AND_RUN": "1"}),
            lambda item: item["environment"].update({"FUSERMOUNT_PROG": "/tmp/other-helper"}),
        ):
            changed = copy.deepcopy(value)
            alter(changed)
            with self.assertRaises((RuntimeError, ValueError)):
                native.inspect_binding(changed)

    def test_actual_launch_root_includes_appimage_ancestor_and_refuses_missing_or_cyclic_ancestry(self):
        processes = {4: {"pid": 4, "parent_pid": 3}, 3: {"pid": 3, "parent_pid": 2}}
        self.assertEqual(native.candidate_launch_root(processes, 4, 2), processes[3])
        self.assertEqual(native.candidate_launch_root(processes, 4, 3), processes[4])
        for changed in [{4: processes[4]}, {4: processes[4], 3: {"pid": 3, "parent_pid": 4}}]:
            with self.assertRaisesRegex(RuntimeError, "ancestry unavailable"):
                native.candidate_launch_root(changed, 4, 2)

    def test_namespace_group_leader_retains_actual_image_and_kernel_creation_clock(self):
        value = binding()
        data = "1 (python3) " + " ".join(["S", "0"] + ["0"] * 17 + ["1001"])
        with (
            patch.object(
                native,
                "bounded_text",
                side_effect=lambda filename, maximum: data if filename == "/proc/1/stat" else "btime 1700000000\n",
            ),
            patch.object(native.os, "readlink", return_value="/usr/bin/python3.12"),
            patch.object(native.os, "sysconf", return_value=100, create=True),
            patch.object(native.time, "CLOCK_BOOTTIME", 7, create=True),
            patch.object(native.time, "clock_gettime_ns", return_value=100000000000, create=True),
            patch.object(native.time, "time_ns", return_value=1700000100000000000),
            patch.object(native, "read_regular", return_value="b" * 64),
        ):
            actual = native.namespace_process_identity(value)
            self.assertEqual(actual["pid"], 1)
            self.assertEqual(actual["creation_ticks"], "1001")
            self.assertEqual(actual["started_at"], "2023-11-14T22:13:30.010Z")
            value["tools"]["python"]["sha256"] = "c" * 64
            with self.assertRaisesRegex(RuntimeError, "init image differs"):
                native.namespace_process_identity(value)

    def test_kernel_process_and_loaded_library_inspection_refuses_ambiguous_or_deleted_mappings(self):
        fields = ["S", "3"] + ["0"] * 17 + ["1234"]
        actual = native.inspect_process_stat("4 (portcove-deskto) " + " ".join(fields), 4)
        self.assertEqual(actual["creation_ticks"], "1234")
        with self.assertRaises(RuntimeError):
            native.inspect_process_stat("5 (portcove-deskto) " + " ".join(fields), 4)
        mapping = "1000-2000 r-xp 00000000 08:01 42 /usr/lib/libwebkit2gtk-4.1.so.0\n"
        self.assertEqual(native.inspect_loaded_webkit_maps(mapping), [("/usr/lib/libwebkit2gtk-4.1.so.0", (8, 1, 42))])
        for changed in [
            mapping.replace("42", "0"),
            mapping.replace(".so.0", ".so.0 (deleted)"),
            mapping + mapping.replace(" 42 ", " 43 "),
            "",
            "x" * (native.MIB + 1),
        ]:
            with self.assertRaises(RuntimeError):
                native.inspect_loaded_webkit_maps(changed)

    def test_fixed_runtime_snapshot_binds_live_driver_descendant_account_generation_and_loaded_bytes(self):
        def process(pid, parent, comm):
            return str(pid) + " (" + comm + ") " + " ".join(["S", str(parent)] + ["0"] * 17 + [str(1000 + pid)])

        texts = {
            "/proc/1/stat": process(1, 0, "python3"),
            "/proc/3/stat": process(3, 1, "tauri-driver"),
            "/proc/4/stat": process(4, 3, "portcove-deskto"),
            "/proc/4/status": "Uid:\t1002\t1002\t1002\t1002\n",
            "/proc/4/maps": "1000-2000 r-xp 00000000 08:01 42 /usr/lib/libwebkit2gtk-4.1.so.0\n",
            "/etc/os-release": 'ID=ubuntu\nVERSION_ID="24.04"\n',
            "/proc/stat": "btime 1700000000\n",
        }
        original_path = native.Path
        proc = SimpleNamespace(iterdir=lambda: [SimpleNamespace(name=str(pid)) for pid in (1, 3, 4)])
        with (
            patch.object(native, "Path", lambda value: proc if value == "/proc" else original_path(value)),
            patch.object(native, "bounded_text", lambda filename, maximum: texts[filename]),
            patch.object(native.os, "readlink", return_value="/tmp/appimage/usr/bin/portcove-desktop"),
            patch.object(
                native.os, "uname", return_value=SimpleNamespace(release="6.8.0", machine="x86_64"), create=True
            ),
            patch.object(native.os, "sysconf", return_value=100, create=True),
            patch.object(native.time, "CLOCK_BOOTTIME", 7, create=True),
            patch.object(native.time, "clock_gettime_ns", return_value=100000000000, create=True),
            patch.object(native.time, "time_ns", return_value=1700000100000000000),
            patch.object(native, "read_regular", return_value="a" * 64) as hashed,
        ):
            actual = native.runtime_snapshot(3, 1002)
            self.assertEqual(actual["authority"], "none")
            self.assertEqual(actual["process"]["pid"], 4)
            self.assertEqual(actual["process"]["creation_ticks"], "1004")
            self.assertEqual(actual["process"]["loaded_libraries"][0]["sha256"], "a" * 64)
            self.assertEqual(
                hashed.call_args_list[0].args,
                ("/proc/4/root/usr/lib/libwebkit2gtk-4.1.so.0", 256 * native.MIB, (8, 1, 42)),
            )
            with self.assertRaisesRegex(RuntimeError, "account differs"):
                native.runtime_snapshot(3, 1003)
            with self.assertRaisesRegex(RuntimeError, "one actual live"):
                native.runtime_snapshot(42, 1002)
            texts["/proc/4/status"] = "Uid:\t1002\t1002\t1002\t1002\n"
            with (
                patch.object(native.os, "readlink", side_effect=PermissionError("inert sandbox refusal")),
                self.assertRaises(PermissionError),
            ):
                native.runtime_snapshot(3, 1002)

    def test_fixed_binding_refuses_identity_tools_paths_or_environment_widening(self):
        original = binding()
        self.assertEqual(native.inspect_binding(original), original)
        changes = [
            {"qualification_uid": 0},
            {"qualification_gid": 0},
            {"qualification_uid": True},
            {"nonce": "imported"},
            {"port": 65534},
            {"timeout_seconds": 1751},
            {"application_original": "/mnt/e/owner/private"},
            {"home": "/home/native/../owner"},
            {"home": "/home/native/line\nbreak"},
            {"command": "sh"},
            {"environment": {"GH_TOKEN": "inert-must-not-transfer"}},
            {"environment": {"XDG_CONFIG_HOME": "/home/owner/.config"}},
            {"environment": {"WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS": "1"}},
        ]
        for change in changes:
            with self.assertRaises((RuntimeError, ValueError)):
                native.inspect_binding({**copy.deepcopy(original), **change})
        changed = copy.deepcopy(original)
        changed["tools"]["driver"]["path"] = "/usr/bin/sh"
        with self.assertRaises((RuntimeError, ValueError)):
            native.inspect_binding(changed)

    def test_webdriver_shape_matches_observed_installed_selenium_builder_and_only_aliases_selected_bytes(self):
        expected = binding()
        raw = {
            "capabilities": {
                "firstMatch": [{}],
                "alwaysMatch": {
                    "browserName": "wry",
                    "tauri:options": {"application": expected["application_original"]},
                    "se:remoteUrl": "http://127.0.0.1:45874",
                },
            }
        }
        copied = copy.deepcopy(raw)
        actual = json.loads(native.rewrite_session(json.dumps(raw).encode(), expected))
        self.assertEqual(raw, copied)
        copied["capabilities"]["alwaysMatch"]["tauri:options"]["application"] = "/native/application.AppImage"
        self.assertEqual(actual, copied)
        for change in [
            {"application": "/usr/bin/sh"},
            {"application": expected["application_original"], "args": ["--unsafe"]},
        ]:
            bad = copy.deepcopy(raw)
            bad["capabilities"]["alwaysMatch"]["tauri:options"] = change
            with self.assertRaises((RuntimeError, ValueError)):
                native.rewrite_session(json.dumps(bad).encode(), expected)
        for key, value in [("browserName", "chrome"), ("se:remoteUrl", "http://host:80"), ("unexpected", True)]:
            bad = copy.deepcopy(raw)
            bad["capabilities"]["alwaysMatch"][key] = value
            with self.assertRaises((RuntimeError, ValueError)):
                native.rewrite_session(json.dumps(bad).encode(), expected)

    def test_private_driver_protocol_is_bounded_and_rejects_duplicate_nonfinite_or_ambiguous_json(self):
        self.assertEqual(
            native.inspect_request({"method": "GET", "path": "/status", "body_base64": ""}), ("GET", "/status", b"")
        )
        self.assertEqual(
            native.inspect_request({"method": "GET", "path": "/native-runtime", "body_base64": ""}),
            ("GET", "/native-runtime", b""),
        )
        for changed in [
            {"method": "CONNECT", "path": "/status", "body_base64": ""},
            {"method": "GET", "path": "/session/../owner", "body_base64": ""},
            {"method": "GET", "path": "/status", "body_base64": "YQ=="},
            {"method": "POST", "path": "/session", "body_base64": "YQ="},
            {"method": "POST", "path": "/session", "body_base64": "YQ==\n"},
            {"method": "POST", "path": "/native-runtime", "body_base64": ""},
            {"method": "DELETE", "path": "/native-runtime", "body_base64": ""},
        ]:
            with self.assertRaises((RuntimeError, ValueError)):
                native.inspect_request(changed)
        for value in [b'{"a":1,"a":2}', b'{"a":NaN}', b'"\xff"']:
            with self.assertRaises((RuntimeError, ValueError)):
                native.decode(value)
        self.assertEqual(len(native.body("YWFh" * (2 * native.MIB // 3), 2 * native.MIB)), 3 * (2 * native.MIB // 3))

    def test_init_refuses_outside_pid1_before_any_gui_or_process_creation(self):
        with patch.object(native.os, "getpid", return_value=42), patch.object(native.subprocess, "Popen") as launch:
            with self.assertRaisesRegex(RuntimeError, "PID1"):
                native.run(binding())
            launch.assert_not_called()
        with (
            patch.object(native.sys, "argv", ["inert", "--binding", "/arbitrary"]),
            self.assertRaisesRegex(RuntimeError, "fixed private native entry"),
        ):
            native.main()

    def test_private_x11_authority_record_preserves_the_cookie_without_text_logging(self):
        cookie = bytes(range(16))
        data = native.authority_record(cookie)
        self.assertEqual(struct.unpack(">H", data[:2]), (256,))
        fields = []
        cursor = 2
        while cursor < len(data):
            size = struct.unpack(">H", data[cursor : cursor + 2])[0]
            cursor += 2
            fields.append(data[cursor : cursor + size])
            cursor += size
        self.assertEqual(fields[1:], [b"99", b"MIT-MAGIC-COOKIE-1", cookie])


if __name__ == "__main__":
    result = unittest.TextTestRunner(stream=sys.stderr).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(InertNativeInit)
    )
    sys.exit(0 if result.wasSuccessful() else 1)
