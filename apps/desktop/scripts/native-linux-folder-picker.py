"""One owned GTK folder chooser; no arbitrary desktop input or source mutation."""

import argparse
import hashlib
import json
import os
import re
import select
import time
from pathlib import Path, PurePosixPath


def proc(pid):
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    return {"parent": int(fields[1]), "started": fields[19]}


def mounted_runtime_identity(live_path, runtime_device, mountinfo, package_basename):
    live = PurePosixPath(live_path)
    if not live.is_absolute() or live.name != "portcove-desktop" or len(live.parents) < 3:
        return None
    mount = live.parents[2]
    if str(live) != live_path or mount.parent != PurePosixPath("/tmp") or not re.fullmatch(r"\.mount_[A-Za-z0-9]+", mount.name):
        return None
    if live != mount / "usr/bin/portcove-desktop":
        return None
    matches = []
    for row in mountinfo.splitlines():
        before, after = row.split(" - ", 1)
        fields = before.split()
        filesystem, source, _ = after.split(" ", 2)
        if (fields[4] == str(mount) and fields[3] == "/" and fields[2] == runtime_device
            and filesystem == f"fuse.{package_basename}" and source == package_basename):
            matches.append((fields[0], fields[2], str(mount), filesystem, source))
    return matches[0] if len(matches) == 1 else None


class OwnedLaunch:
    def __init__(self, pid, started, nonce, executable, digest, appimage_runtime_digest=None):
        self.pid = pid
        self.started = started
        self.executable = str(Path(executable).resolve(strict=True))
        self.digest = digest
        self.appimage_runtime_digest = appimage_runtime_digest
        self.fd = os.pidfd_open(pid)
        self.application = None
        try:
            self.command = Path(f"/proc/{pid}/cmdline").read_bytes()
            arguments = self.command.decode("utf-8").split("\0")
            init = str(Path(__file__).with_name("native-linux-init.mts").resolve(strict=True))
            if str(Path(f"/proc/{pid}/exe").resolve(strict=True)) != str(Path("/usr/bin/unshare").resolve(strict=True)) or init not in arguments or arguments[arguments.index(init) + 1] != nonce:
                raise RuntimeError("Captured private namespace launch is required")
            self.check()
        except BaseException:
            os.close(self.fd)
            raise

    def check(self):
        if select.select([self.fd], [], [], 0)[0] or proc(self.pid)["started"] != self.started or Path(f"/proc/{self.pid}/cmdline").read_bytes() != self.command:
            raise RuntimeError("Owned native launch changed or exited")

    def executable_identity(self, pid):
        proc_executable = f"/proc/{pid}/exe"
        metadata = os.stat(proc_executable)
        immutable = (metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns)
        if self.appimage_runtime_digest is None:
            return (*immutable, None) if str(Path(proc_executable).resolve(strict=True)) == self.executable else None
        device = f"{os.major(metadata.st_dev)}:{os.minor(metadata.st_dev)}"
        associated = mounted_runtime_identity(
            os.readlink(proc_executable), device, Path(f"/proc/{pid}/mountinfo").read_text(),
            Path(self.executable).name,
        )
        if associated is None:
            return None
        # Read only this owned process and retain neither its environment nor values.
        with open(f"/proc/{pid}/environ", "rb") as environment:
            values = environment.read(256 * 1024 + 1)
        if len(values) > 256 * 1024:
            return None
        variables = values.split(b"\0")
        if variables.count(b"APPIMAGE=" + os.fsencode(self.executable)) != 1:
            return None
        if variables.count(b"APPDIR=" + os.fsencode(associated[2])) != 1:
            return None
        return (*immutable, associated)

    def bind(self, pid):
        self.check()
        fd = os.pidfd_open(pid)
        try:
            started = proc(pid)["started"]
            cursor = pid
            for _ in range(64):
                if cursor == self.pid:
                    break
                cursor = proc(cursor)["parent"]
                if cursor <= 1:
                    return False
            else:
                return False
            executable = self.executable_identity(pid)
            if executable is None:
                return False
            with open(f"/proc/{pid}/exe", "rb") as binary:
                hasher = hashlib.sha256()
                for block in iter(lambda: binary.read(1024 * 1024), b""):
                    hasher.update(block)
                digest = hasher.hexdigest()
            expected_digest = self.appimage_runtime_digest or self.digest
            if (digest != expected_digest or select.select([fd], [], [], 0)[0] or proc(pid)["started"] != started
                or self.executable_identity(pid) != executable):
                return False
            if self.application:
                os.close(self.application[2])
            self.application = (pid, started, fd, executable)
            fd = None
            return True
        finally:
            if fd is not None:
                os.close(fd)

    def recheck(self, connection, bus_name, GLib, Gio):
        self.check()
        pid, started, fd, original = self.application
        if select.select([fd], [], [], 0)[0] or proc(pid)["started"] != started:
            raise RuntimeError("Owned GTK application exited or changed")
        if self.executable_identity(pid) != original:
            raise RuntimeError("Owned GTK executable changed")
        current = connection.call_sync(
            "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
            "GetConnectionUnixProcessID", GLib.Variant("(s)", (bus_name,)),
            GLib.VariantType.new("(u)"), Gio.DBusCallFlags.NONE, 500, None,
        ).unpack()[0]
        if current != pid:
            raise RuntimeError("Accessibility connection identity changed")

    def close(self):
        if self.application:
            os.close(self.application[2])
        os.close(self.fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--launch-pid", type=int, required=True)
    parser.add_argument("--launch-started", required=True)
    parser.add_argument("--launch-nonce", required=True)
    parser.add_argument("--application", required=True)
    parser.add_argument("--application-sha256", required=True)
    parser.add_argument("--appimage-runtime-sha256")
    parser.add_argument("--output", required=True)
    parser.add_argument("--purpose", choices=("game-files", "restored-library"), default="game-files")
    parser.add_argument("--directory")
    args = parser.parse_args()
    if args.launch_pid <= 1 or not args.launch_started.isdecimal():
        raise RuntimeError("Captured native launch is required")
    directory = None
    if args.directory:
        selected = Path(args.directory)
        output = Path(args.output).resolve(strict=True)
        if not selected.is_absolute() or selected.is_symlink() or not selected.is_dir():
            raise RuntimeError("Picker input must be an owned regular directory")
        directory = selected.resolve(strict=True)
        if directory == output or output not in directory.parents:
            raise RuntimeError("Picker directory escaped owned output")
    title = "Choose game files folder"
    if args.purpose == "restored-library":
        if directory is None or directory != output / "restored-library":
            raise RuntimeError("Library picker requires the owned restored library")
        title = "Choose Portcove library"
    if args.appimage_runtime_sha256 is not None:
        if (args.purpose != "restored-library" or Path(args.application).name != "Portcove.AppImage"
            or not re.fullmatch(r"[0-9a-f]{64}", args.appimage_runtime_sha256)):
            raise RuntimeError("Mounted executable identity is restricted to owned AppImage recovery")
    launch = OwnedLaunch(args.launch_pid, args.launch_started, args.launch_nonce, args.application,
                         args.application_sha256, args.appimage_runtime_sha256)
    try:
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi, Gio, GLib
        Atspi.set_timeout(250, 500)
        session = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        address = session.call_sync(
            "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus", "GetAddress", None,
            GLib.VariantType.new("(s)"), Gio.DBusCallFlags.NONE, 1000, None,
        ).unpack()[0]
        connection = Gio.DBusConnection.new_for_address_sync(
            address, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
            None, None,
        )
        deadline = time.monotonic() + 10
        application = None
        bus_name = None
        while time.monotonic() < deadline and application is None:
            launch.check()
            desktop = Atspi.get_desktop(0)
            count = desktop.get_child_count()
            if count > 32:
                raise RuntimeError("Accessibility application inventory exceeded its bound")
            matches = []
            for index in range(count):
                candidate = desktop.get_child_at_index(index)
                name = candidate.app.bus_name
                pid = connection.call_sync(
                    "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetConnectionUnixProcessID",
                    GLib.Variant("(s)", (name,)), GLib.VariantType.new("(u)"), Gio.DBusCallFlags.NONE, 500, None,
                ).unpack()[0]
                if launch.bind(pid):
                    matches.append((candidate, name))
            if len(matches) > 1:
                raise RuntimeError("Ambiguous owned GTK applications")
            if matches:
                application, bus_name = matches[0]
                break
            time.sleep(0.05)
        if application is None:
            raise RuntimeError("Owned GTK application was not exposed through accessibility")

        window_path = None

        def chooser():
            nonlocal window_path
            if time.monotonic() >= deadline:
                raise RuntimeError("GTK chooser observation deadline reached")
            launch.recheck(connection, bus_name, GLib, Gio)
            application.clear_cache()
            count = application.get_child_count()
            if count > 16:
                raise RuntimeError("Owned GTK window inventory exceeded its bound")
            found = [application.get_child_at_index(i) for i in range(count)]
            found = [window for window in found if window is not None and window.get_name() == title and window.get_role() in (Atspi.Role.DIALOG, Atspi.Role.FILE_CHOOSER)]
            if len(found) != 1:
                raise RuntimeError("Expected one exact owned GTK folder chooser")
            window = found[0]
            if window_path is not None and window.path != window_path:
                raise RuntimeError("Owned GTK chooser identity changed")
            window_path = window.path
            states = window.get_state_set()
            if not states.contains(Atspi.StateType.SHOWING) or not states.contains(Atspi.StateType.SENSITIVE):
                raise RuntimeError("Owned GTK folder chooser is unavailable")
            return window

        def controls(until=None):
            until = deadline if until is None else until
            pending = [(chooser(), 0)]
            found = []
            visited = 0
            while pending:
                if time.monotonic() >= until:
                    raise RuntimeError("GTK chooser control observation deadline reached")
                node, depth = pending.pop()
                node.clear_cache()
                visited += 1
                if visited > 512 or depth > 12:
                    raise RuntimeError("GTK chooser control inventory exceeded its bound")
                role = node.get_role()
                if role in (Atspi.Role.TABLE, Atspi.Role.TREE, Atspi.Role.TREE_TABLE, Atspi.Role.LIST):
                    continue
                if role in (Atspi.Role.PUSH_BUTTON, Atspi.Role.TOGGLE_BUTTON, Atspi.Role.TEXT, Atspi.Role.ENTRY, Atspi.Role.FILE_CHOOSER):
                    found.append(node)
                count = node.get_child_count()
                if count < 0 or count > 512 - visited - len(pending) or (depth == 12 and count):
                    raise RuntimeError("GTK chooser child inventory exceeded its bound")
                for index in range(count):
                    if time.monotonic() >= until:
                        raise RuntimeError("GTK chooser control observation deadline reached")
                    child = node.get_child_at_index(index)
                    if child is None:
                        raise RuntimeError("Owned GTK chooser control inventory changed")
                    pending.append((child, depth + 1))
            return found

        def button(names):
            inventory = controls()
            nodes = [node for node in inventory if node.get_role() in (Atspi.Role.PUSH_BUTTON, Atspi.Role.TOGGLE_BUTTON)
                     and node.get_name().replace("_", "") in names and node.get_state_set().contains(Atspi.StateType.SENSITIVE)
                     and node.get_state_set().contains(Atspi.StateType.SHOWING)]
            if len(nodes) != 1:
                labels = names | {"Cancel", "Select", "Open", "Select Folder", "Search", "Type a file name", "Enter Location", "Location"}
                projection = []
                for node in inventory:
                    if len(projection) >= 32:
                        break
                    if node.get_role() not in (Atspi.Role.PUSH_BUTTON, Atspi.Role.TOGGLE_BUTTON):
                        continue
                    states = node.get_state_set()
                    bound_control(node, input_required=False)
                    name = node.get_name().replace("_", "")
                    description = node.get_description()
                    projection.append({"role": node.get_role_name(), "name": name if name in labels else "<other>", "description": description if description in labels else "<other>", "showing": states.contains(Atspi.StateType.SHOWING), "sensitive": states.contains(Atspi.StateType.SENSITIVE)})
                bounds = chooser().get_component_iface().get_extents(Atspi.CoordType.SCREEN)
                raise RuntimeError("Expected one exact enabled GTK chooser action: " + json.dumps({"bounds": [bounds.x, bounds.y, bounds.width, bounds.height], "controls": projection}))
            return nodes[0]

        def bound_control(node, input_required=True):
            chooser()
            ancestor = node
            for _ in range(16):
                if ancestor.app.bus_name != bus_name:
                    raise RuntimeError("GTK control accessibility peer changed")
                if ancestor.path == window_path:
                    break
                ancestor = ancestor.get_parent()
                if ancestor is None:
                    raise RuntimeError("GTK action left the captured chooser")
            else:
                raise RuntimeError("GTK action ancestry exceeded its bound")
            node.clear_cache()
            states = node.get_state_set()
            if input_required and (not states.contains(Atspi.StateType.SENSITIVE) or not states.contains(Atspi.StateType.SHOWING)):
                raise RuntimeError("Owned GTK control became unavailable")

        def invoke(node):
            bound_control(node)
            action = node.get_action_iface()
            if action.get_n_actions() != 1 or not action.do_action(0):
                raise RuntimeError("Owned GTK chooser action was refused")

        def show_location():
            matches = []
            for node in controls():
                if node.get_role() != Atspi.Role.FILE_CHOOSER:
                    continue
                bound_control(node)
                action = node.get_action_iface()
                if action is None:
                    continue
                count = action.get_n_actions()
                if count < 0 or count > 8:
                    raise RuntimeError("GTK chooser action inventory exceeded its bound")
                for index in range(count):
                    if action.get_action_name(index) == "show_location":
                        matches.append((node, index, count))
            if len(matches) != 1:
                raise RuntimeError("Expected one exact owned GTK show_location action")
            node, index, captured_count = matches[0]
            bound_control(node)
            action = node.get_action_iface()
            count = action.get_n_actions() if action is not None else 0
            if count != captured_count or not 0 <= index < count <= 8 or action.get_action_name(index) != "show_location" or time.monotonic() >= deadline or not action.do_action(index):
                raise RuntimeError("Owned GTK location action changed or was refused")

        def editable(node):
            if node.get_role() not in (Atspi.Role.TEXT, Atspi.Role.ENTRY):
                return False
            states = node.get_state_set()
            return all(states.contains(state) for state in (Atspi.StateType.EDITABLE, Atspi.StateType.SHOWING, Atspi.StateType.SENSITIVE))

        def location_entry():
            phase = "initial"
            entries = [node for node in controls() if editable(node)]
            if not entries:
                show_location()
                phase = "after-show-location"
                # GTK can expose the location entry on a later accessibility frame.
                # The completed action need not remain available after it reveals the field.
                ready_by = min(deadline, time.monotonic() + 1)
                while not entries and time.monotonic() < ready_by:
                    entries = [node for node in controls(ready_by) if editable(node)]
                    if not entries:
                        time.sleep(max(0, min(0.05, ready_by - time.monotonic())))
                if time.monotonic() >= ready_by:
                    raise RuntimeError(f"GTK location entry deadline reached: phase={phase} count={len(entries)}")
            if len(entries) != 1:
                raise RuntimeError(f"Expected one editable owned GTK location field: phase={phase} count={len(entries)}")
            entry = entries[0]
            bound_control(entry)
            current = [node for node in controls() if editable(node)]
            if len(current) != 1 or current[0].path != entry.path:
                raise RuntimeError(f"Owned GTK location field changed: phase=before-input count={len(current)}")
            return current[0]

        if directory:
            entry = location_entry()
            bound_control(entry)
            input_field = entry.get_editable_text_iface()
            entry.clear_cache()
            if input_field is None or not editable(entry) or time.monotonic() >= deadline:
                raise RuntimeError("Owned GTK location field unavailable")
            if not input_field.set_text_contents(str(directory)):
                raise RuntimeError("Owned GTK location input was refused")
            invoke(button({"Open", "Select", "Select Folder"}))
        else:
            invoke(button({"Cancel"}))
        import sys
        receipt = {"method": "owned GTK accessibility folder chooser", "python_version": sys.version, "launch_pid": args.launch_pid,
                   "application_pid": launch.application[0], "application_sha256": args.application_sha256,
                   "title": title, "selected": directory is not None, "cancelled": directory is None,
                   "selected_directory": str(directory) if directory else None}
        if args.appimage_runtime_sha256 is not None:
            receipt["appimage_runtime_sha256"] = args.appimage_runtime_sha256
            receipt["appimage_mount"] = launch.application[3][-1]
        print(json.dumps(receipt))
    finally:
        launch.close()


if __name__ == "__main__":
    main()
