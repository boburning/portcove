// Harmless prerequisite diagnosis for the existing hosted ordinary-package route.
// No application, media, credentials, host mounts or host policy are changed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchLinuxNativeSession } from "../apps/desktop/scripts/desktop-linux-native-session.mts";

const source = fileURLToPath(import.meta.url);
const output = path.resolve("work/linux-namespace-preflight");
const namespaceArgs = ["--mount", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL"];
function read(file: string) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    return String(error);
  }
}
function facts() {
  return {
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    pid: process.pid,
    uid_map: read("/proc/self/uid_map"),
    gid_map: read("/proc/self/gid_map"),
    setgroups: read("/proc/self/setgroups"),
    status: read("/proc/self/status"),
    apparmor: read("/proc/self/attr/current"),
    namespaces: Object.fromEntries(
      ["user", "mnt", "pid"].map((name) => [name, readlinkSync(`/proc/self/ns/${name}`)]),
    ),
    parent_status: read(`/proc/${process.ppid}/status`),
    parent_apparmor: read(`/proc/${process.ppid}/attr/current`),
  };
}
function command(program: string, args: string[]) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    program,
    args,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message,
  };
}
function save(name: string, value: unknown) {
  writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}
function successful(result: ReturnType<typeof command>) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
}

const mode = process.argv[2];
if (mode === "--nested") {
  assert.equal(process.getuid?.(), 1000);
  assert.equal(process.getgid?.(), 1000);
  console.log(JSON.stringify({ phase: "nested-user", facts: facts() }));
} else if (mode === "--root") {
  assert.equal(process.getuid?.(), 0);
  assert.equal(process.pid, 1);
  console.log(JSON.stringify({ phase: "private-root", facts: facts() }));
  const mount = command("/usr/bin/mount", [
    "-t",
    "tmpfs",
    "-o",
    "mode=1777,nosuid,nodev",
    "tmpfs",
    "/tmp",
  ]);
  console.log(JSON.stringify({ phase: "private-tmpfs", ...mount }));
  successful(mount);
  mkdirSync("/tmp/x11-bin-upper");
  mkdirSync("/tmp/x11-bin-work");
  copyFileSync("/usr/bin/true", "/tmp/x11-bin-upper/pcv-preflight-true");
  const overlay = command("/usr/bin/mount", [
    "-t",
    "overlay",
    "overlay",
    "-o",
    "lowerdir=/usr/bin,upperdir=/tmp/x11-bin-upper,workdir=/tmp/x11-bin-work,userxattr",
    "/usr/bin",
  ]);
  console.log(JSON.stringify({ phase: "private-bin-overlay", ...overlay }));
  successful(overlay);
  const nested = command("/usr/bin/unshare", [
    "--user",
    "--map-user=1000",
    "--map-group=1000",
    ...namespaceArgs,
    process.execPath,
    source,
    "--nested",
  ]);
  console.log(JSON.stringify({ phase: "nested-user-result", ...nested }));
  successful(nested);
} else {
  assert.equal(mode, undefined);
  assert.equal(process.platform, "linux");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.ok(process.getuid && process.getuid() > 0, "Ordinary runner account required");
  mkdirSync(output, { recursive: true });
  const started = new Date().toISOString();
  save("parent.json", {
    started,
    source: command("git", ["rev-parse", "HEAD"]),
    facts: facts(),
    image_os: process.env.ImageOS,
    image_version: process.env.ImageVersion,
    os_release: read("/etc/os-release"),
    kernel: command("uname", ["-a"]),
    unshare: command("/usr/bin/unshare", ["--version"]),
    restrictions: Object.fromEntries(
      [
        "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
        "/proc/sys/kernel/unprivileged_userns_clone",
        "/proc/sys/user/max_user_namespaces",
        "/sys/module/apparmor/parameters/enabled",
      ].map((file) => [file, read(file)]),
    ),
  });
  let failed = false;
  // First execute the real maintained launcher, including its PID1 control pipe.
  const launch = await launchLinuxNativeSession("/usr/bin/true", [], process.env);
  let stdout = "",
    stderr = "";
  launch.child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  launch.child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed = new Promise<void>((resolve) => launch.child.once("close", () => resolve()));
  try {
    await launch.ready();
    const joined = await launch.stop();
    save("maintained-launcher.json", { result: "passed", joined, stdout, stderr });
  } catch (error) {
    launch.child.stdin.end();
    await closed;
    save("maintained-launcher.json", {
      result: "failed",
      receipt: launch.receipt,
      stdout,
      stderr,
      error: String(error),
    });
    failed = true;
  }
  const current = ["--user", "--map-current-user", ...namespaceArgs];
  if (!failed) {
    // Same outer user mapping as the launcher, followed by the real X11 helper's
    // root mapping, private /tmp and /usr/bin overlay, then its nested user map.
    const complete = command("/usr/bin/unshare", [
      ...current,
      "/usr/bin/unshare",
      "--user",
      "--map-root-user",
      ...namespaceArgs,
      process.execPath,
      source,
      "--root",
    ]);
    save("complete-mechanism.json", complete);
    failed = complete.status !== 0 || complete.signal !== null || Boolean(complete.error);
  }
  if (failed) {
    save(
      "bare-user.json",
      command("/usr/bin/unshare", [
        "--user",
        process.execPath,
        "-e",
        "console.log(require('fs').readFileSync('/proc/self/uid_map','utf8'))",
      ]),
    );
    save(
      "current-user.json",
      command("/usr/bin/unshare", [
        ...current,
        process.execPath,
        "-e",
        "console.log(require('fs').readFileSync('/proc/self/status','utf8'))",
      ]),
    );
    // Diagnostic only: tracing may itself change restrictions. It never turns
    // the original failure into a pass or substitutes for the untraced launch.
    save(
      "trace-result.json",
      command("/usr/bin/strace", [
        "-f",
        "-s",
        "160",
        "-e",
        "trace=unshare,clone,clone3,openat,write,mount,setgroups,setresuid,setresgid,prctl",
        "-o",
        path.join(output, "namespace.strace"),
        "/usr/bin/unshare",
        ...current,
        "/usr/bin/true",
      ]),
    );
    save(
      "audit.json",
      command("sudo", [
        "-n",
        "journalctl",
        "-k",
        "--since",
        started,
        "--no-pager",
        "-n",
        "100",
        "--grep",
        "apparmor|userns|DENIED",
      ]),
    );
  }
  save("result.json", {
    result: failed ? "failed" : "passed",
    scope: "Harmless namespace prerequisites only; no application or media qualification",
    finished: new Date().toISOString(),
  });
  process.exitCode = failed ? 1 : 0;
}
