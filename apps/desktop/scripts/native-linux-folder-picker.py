"""One owned GTK folder chooser; no arbitrary desktop input or source mutation."""

import argparse
import hashlib
import json
import os
import select
import time
from pathlib import Path


def proc(pid):
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    return {"parent": int(fields[1]), "started": fields[19]}


class OwnedLaunch:
    def __init__(self, pid, started, nonce, executable, digest):
        self.pid = pid
        self.started = started
        self.executable = str(Path(executable).resolve(strict=True))
        self.digest = digest
        self.fd = os.pidfd_open(pid)
        self.application = None
        try:
            self.command = Path(f"/proc/{pid}/cmdline").read_bytes()
            arguments = self.command.decode("utf-8").split("\0")
            init = str(Path(__file__).with_name("native-linux-init.mjs").resolve(strict=True))
            if str(Path(f"/proc/{pid}/exe").resolve(strict=True)) != str(Path("/usr/bin/unshare").resolve(strict=True)) or init not in arguments or arguments[arguments.index(init) + 1] != nonce:
                raise RuntimeError("Captured private namespace launch is required")
            self.check()
        except BaseException:
            os.close(self.fd)
            raise

    def check(self):
        if select.select([self.fd], [], [], 0)[0] or proc(self.pid)["started"] != self.started or Path(f"/proc/{self.pid}/cmdline").read_bytes() != self.command:
            raise RuntimeError("Owned native launch changed or exited")

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
            if str(Path(f"/proc/{pid}/exe").resolve(strict=True)) != self.executable:
                return False
            with open(f"/proc/{pid}/exe", "rb") as binary:
                hasher = hashlib.sha256()
                for block in iter(lambda: binary.read(1024 * 1024), b""):
                    hasher.update(block)
                digest = hasher.hexdigest()
            if digest != self.digest or select.select([fd], [], [], 0)[0] or proc(pid)["started"] != started:
                return False
            if self.application:
                os.close(self.application[2])
            metadata = os.stat(f"/proc/{pid}/exe")
            self.application = (pid, started, fd, (metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns))
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
        metadata = os.stat(f"/proc/{pid}/exe")
        if str(Path(f"/proc/{pid}/exe").resolve(strict=True)) != self.executable or (metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns) != original:
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
    parser.add_argument("--output", required=True)
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
    launch = OwnedLaunch(args.launch_pid, args.launch_started, args.launch_nonce, args.application, args.application_sha256)
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
        title = "Choose game-file folder"
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
            found = [window for window in found if window.get_name() == title and window.get_role() in (Atspi.Role.DIALOG, Atspi.Role.FILE_CHOOSER)]
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

        def controls():
            pending = [(chooser(), 0)]
            found = []
            visited = 0
            while pending:
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
                if count > 512 - visited - len(pending) or (depth == 12 and count):
                    raise RuntimeError("GTK chooser child inventory exceeded its bound")
                pending.extend((node.get_child_at_index(i), depth + 1) for i in range(count))
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
            if count != captured_count or not 0 <= index < count <= 8 or action.get_action_name(index) != "show_location" or not action.do_action(index):
                raise RuntimeError("Owned GTK location action changed or was refused")

        if directory:
            def editable(node):
                states = node.get_state_set()
                return all(states.contains(state) for state in (Atspi.StateType.EDITABLE, Atspi.StateType.SHOWING, Atspi.StateType.SENSITIVE))

            entries = [node for node in controls() if editable(node)]
            if not entries:
                show_location()
                entries = [node for node in controls() if editable(node)]
            if len(entries) != 1:
                raise RuntimeError("Expected one editable owned GTK location field")
            bound_control(entries[0])
            if not editable(entries[0]):
                raise RuntimeError("Owned GTK location field changed")
            if not entries[0].get_editable_text_iface().set_text_contents(str(directory)):
                raise RuntimeError("Owned GTK location input was refused")
            invoke(button({"Open", "Select", "Select Folder"}))
        else:
            invoke(button({"Cancel"}))
        import sys
        print(json.dumps({"method": "owned GTK accessibility folder chooser", "python_version": sys.version, "launch_pid": args.launch_pid,
                          "application_pid": launch.application[0], "application_sha256": args.application_sha256,
                          "title": title, "selected": directory is not None, "cancelled": directory is None,
                          "selected_directory": str(directory) if directory else None}))
    finally:
        launch.close()


if __name__ == "__main__":
    main()
