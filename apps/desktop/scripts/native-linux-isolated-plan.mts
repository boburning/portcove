/** Fixed Linux namespace mount/launch data. Inspection is never a scheduler,
 * native invocation, installed-host observation or acceptance authority. */
import path from "node:path";
import assert from "node:assert/strict";
import { isRecord } from "../../../scripts/runtime-values.mts";

function exact(raw: unknown, keys: string): asserts raw is Record<string, unknown> {
  if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== keys)
    throw new Error("fixed Linux native session schema differs");
}
function sha(raw: unknown) {
  if (typeof raw !== "string" || !/^[a-f0-9]{64}$/u.test(raw))
    throw new Error("fixed Linux native hash missing");
  return raw;
}
function uid(raw: unknown) {
  if (!Number.isSafeInteger(raw) || Number(raw) < 1 || Number(raw) > 4294967294)
    throw new Error("fixed Linux native nonroot account missing");
  return Number(raw);
}
function frozen<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

export function inspectIsolatedNativeLinuxBinding(raw: unknown) {
  const value: unknown = structuredClone(raw);
  exact(
    value,
    "account,application,capture_root,controller,deadline_utc,home,invocation_id,linux_root,schema_version,tools,unit",
  );
  if (value.schema_version !== 1) throw new Error("fixed Linux native version differs");
  const invocation = sha(value.invocation_id);
  if (
    typeof value.linux_root !== "string" ||
    !/^\/home\/[a-z][a-z0-9_-]{0,31}\/portcove-native$/u.test(value.linux_root)
  )
    throw new Error("fixed Linux native root differs");
  const root = value.linux_root;
  const attempt = `${root}/invocations/${invocation}`;
  if (value.capture_root !== `${attempt}/capture` || value.home !== `${attempt}/work/home`)
    throw new Error("fixed Linux native capture and writable data overlap or differ");
  exact(value.account, "gid,uid");
  const account = { uid: uid(value.account.uid), gid: uid(value.account.gid) };
  exact(value.application, "bytes,path,sha256");
  if (
    value.application.path !== `${attempt}/install/Portcove.AppImage` ||
    !Number.isSafeInteger(value.application.bytes) ||
    Number(value.application.bytes) < 1 ||
    Number(value.application.bytes) > 512 * 1024 * 1024
  )
    throw new Error("fixed Linux native package differs");
  const application = {
    path: value.application.path,
    bytes: Number(value.application.bytes),
    sha256: sha(value.application.sha256),
  };
  exact(value.controller, "init_sha256,root,source_commit,source_tree");
  if (
    value.controller.root !== `${root}/controller` ||
    typeof value.controller.source_commit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.controller.source_commit) ||
    typeof value.controller.source_tree !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.controller.source_tree)
  )
    throw new Error("fixed Linux native controller source differs");
  const controller = {
    root: value.controller.root,
    source_commit: value.controller.source_commit,
    source_tree: value.controller.source_tree,
    init_sha256: sha(value.controller.init_sha256),
  };
  exact(value.tools, "bwrap,driver,git,node,python,webkit_driver,xvfb");
  const toolInputs = value.tools;
  const paths = {
    bwrap: "/usr/bin/bwrap",
    driver: `${root}/tools/tauri-driver`,
    git: "/usr/bin/git",
    node: `${root}/tools/node`,
    python: "/usr/bin/python3",
    webkit_driver: "/usr/bin/WebKitWebDriver",
    xvfb: "/usr/bin/Xvfb",
  };
  const tools = Object.fromEntries(
    Object.entries(paths).map(([name, filename]) => {
      const tool = toolInputs[name];
      exact(tool, "path,sha256");
      if (tool.path !== filename) throw new Error("fixed Linux native tool path differs");
      return [name, { path: filename, sha256: sha(tool.sha256) }];
    }),
  );
  exact(value.unit, "control_group,invocation_id,name");
  if (
    value.unit.name !== `portcove-native-${invocation}.service` ||
    typeof value.unit.invocation_id !== "string" ||
    !/^[a-f0-9]{32}$/u.test(value.unit.invocation_id) ||
    typeof value.unit.control_group !== "string" ||
    !new RegExp(
      `^/user\\.slice/user-${account.uid}\\.slice/user@${account.uid}\\.service/app\\.slice/portcove-native-${invocation}\\.service$`,
      "u",
    ).test(value.unit.control_group)
  )
    throw new Error("fixed Linux native user unit differs");
  if (
    typeof value.deadline_utc !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.deadline_utc) ||
    !Number.isFinite(Date.parse(value.deadline_utc)) ||
    new Date(value.deadline_utc).toISOString() !== value.deadline_utc
  )
    throw new Error("fixed Linux native original deadline differs");
  return frozen({
    schema_version: 1 as const,
    invocation_id: invocation,
    linux_root: root,
    account,
    application,
    controller,
    tools,
    unit: {
      name: value.unit.name,
      invocation_id: value.unit.invocation_id,
      control_group: value.unit.control_group,
    },
    capture_root: String(value.capture_root),
    home: String(value.home),
    deadline_utc: value.deadline_utc,
  });
}

export function planIsolatedNativeLinuxCommand(raw: unknown, configurationPath: string) {
  const binding = inspectIsolatedNativeLinuxBinding(raw);
  if (
    path.posix.dirname(configurationPath) !== binding.capture_root ||
    !/^namespace-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/u.test(
      path.posix.basename(configurationPath),
    )
  )
    throw new Error("fixed Linux native launch configuration escaped capture");
  const tool = (name: keyof typeof binding.tools) => {
    const value = binding.tools[name];
    if (!value) throw new Error("fixed Linux native tool absent");
    return value.path;
  };
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--as-pid-1",
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    "--hostname",
    "portcove-native",
    "--uid",
    String(binding.account.uid),
    "--gid",
    String(binding.account.gid),
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/bin",
    "/bin",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind",
    "/lib64",
    "/lib64",
    "--dir",
    "/etc",
    "--ro-bind",
    "/etc/os-release",
    "/etc/os-release",
    "--ro-bind",
    "/etc/ld.so.cache",
    "/etc/ld.so.cache",
    "--ro-bind",
    "/etc/fonts",
    "/etc/fonts",
    "--proc",
    "/proc",
    "--remount-ro",
    "/proc",
    "--tmpfs",
    "/dev",
    "--dev-bind",
    "/dev/null",
    "/dev/null",
    "--dev-bind",
    "/dev/zero",
    "/dev/zero",
    "--dev-bind",
    "/dev/urandom",
    "/dev/urandom",
    "--dir",
    "/dev/shm",
    "--remount-ro",
    "/dev",
    "--size",
    String(64 * 1024 * 1024),
    "--tmpfs",
    "/dev/shm",
    "--size",
    String(512 * 1024 * 1024),
    "--tmpfs",
    "/tmp",
    "--dir",
    "/run",
    "--dir",
    "/native/runtime",
    "--ro-bind",
    tool("driver"),
    "/native/runtime/tauri-driver",
    "--ro-bind",
    binding.application.path,
    "/native/application.AppImage",
    "--ro-bind",
    `${binding.controller.root}/apps/desktop/scripts/native-linux-isolated-init.py`,
    "/native/init.py",
    "--ro-bind",
    configurationPath,
    "/native/config.json",
    "--bind",
    binding.home,
    binding.home,
    "--chdir",
    binding.home,
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--remount-ro",
    "/",
    "--",
    tool("python"),
    "-I",
    "-S",
    "-B",
    "/native/init.py",
    "--binding",
    "/native/config.json",
  ];
  // WebKit keeps its own nested sandbox. No host mount, inherited runtime
  // socket, sandbox-disable flag, caller command or issuer secret is exposed.
  return frozen({
    executable: tool("bwrap"),
    arguments: args,
    credential_input: "none" as const,
    authority: "none" as const,
  });
}

export function inspectNativeLinuxHomeMount(
  mountinfo: string,
  home: string,
  filesystem: { type: number; bsize: number; blocks: number },
) {
  assert.ok(Buffer.byteLength(mountinfo) <= 1024 * 1024);
  assert.equal(filesystem.type, 0x01021994, "native state home must be hard-bounded tmpfs");
  assert.ok(
    Number.isSafeInteger(filesystem.bsize) &&
      filesystem.bsize > 0 &&
      Number.isSafeInteger(filesystem.blocks) &&
      filesystem.blocks > 0,
  );
  const bytes = filesystem.bsize * filesystem.blocks;
  assert.ok(Number.isSafeInteger(bytes) && bytes <= 512 * 1024 * 1024);
  const matches = mountinfo.split("\n").filter((line) => line.split(" ")[4] === home);
  assert.equal(matches.length, 1, "exact native home mount must be distinct");
  const fields = matches[0]!.split(" "),
    separator = fields.indexOf("-");
  assert.ok(
    separator >= 6 &&
      fields[separator + 1] === "tmpfs" &&
      fields[3] === "/" &&
      fields[5]!.split(",").includes("rw"),
  );
  assert.ok(/^[1-9][0-9]*$/u.test(fields[0]!) && /^[0-9]+:[0-9]+$/u.test(fields[2]!));
  return Object.freeze({
    mount_id: fields[0]!,
    parent_mount_id: fields[1]!,
    device: fields[2]!,
    root: "/",
    mount_point: home,
    filesystem: "tmpfs",
    maximum_bytes: bytes,
    authority: "none" as const,
  });
}
