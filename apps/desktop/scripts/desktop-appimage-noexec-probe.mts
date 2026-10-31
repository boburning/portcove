import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileIdentity } from "../../../scripts/development-evidence.mts";
import { assertOwnedUnlinkedPath } from "../../../scripts/release-path-safety.mts";
import { errorCode, isRecord } from "../../../scripts/runtime-values.mts";

// The maintained parent prepares a disposable noexec tmpfs with sudo. This
// consumer runs as the ordinary caller and must observe kernel launch refusal;
// it does not elevate, mount, run another package or infer a successful app exit.
assert.equal(process.platform, "linux");
const { values } = parseArgs({
  options: Object.fromEntries(
    ["root", "image", "sha256", "output"].map((name) => [name, { type: "string" }] as const),
  ),
});
function required(name: string) {
  const value = values[name];
  assert.ok(typeof value === "string" && value.length > 0, `--${name} is required`);
  return value;
}
const root = required("root"),
  image = required("image"),
  output = required("output");
assert.ok(path.isAbsolute(root) && path.isAbsolute(image) && path.isAbsolute(output));
assert.match(required("sha256"), /^[a-f0-9]{64}$/u);
const uid = process.getuid?.(),
  gid = process.getgid?.();
assert.ok(typeof uid === "number" && uid > 0 && typeof gid === "number");
await assertOwnedUnlinkedPath(root, image, "noexec AppImage");
await assertOwnedUnlinkedPath(root, output, "noexec observation");
const stat = await lstat(image);
assert.ok(stat.isFile() && stat.nlink === 1 && stat.uid === uid);
assert.equal(stat.mode & 0o7777, 0o755);
const binary = await fileIdentity(image, { maxBytes: 128 * 1024 * 1024 });
assert.equal(binary.sha256, required("sha256"));
const capabilities = (await readFile("/proc/self/status", "utf8")).match(
  /^CapEff:\s*([a-f0-9]+)$/imu,
)?.[1];
assert.ok(
  capabilities && /^0+$/u.test(capabilities),
  "The ordinary probe must have no effective capabilities",
);
const report: Record<string, unknown> = {
  schema_version: 1,
  phase: "preflight",
  caller: { uid, gid, effective_capabilities: capabilities },
  image: binary,
  file_owner_uid: stat.uid,
  file_owner_gid: stat.gid,
  mode: "755",
  scope: "Kernel noexec refusal on an exact copied AppImage; privileged fixture setup is separate",
};
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
const save = () => writeFile(output, JSON.stringify(report, null, 2) + "\n");
try {
  const mount = spawnSync(
    "/usr/bin/findmnt",
    ["--json", "--target", image, "--output", "TARGET,FSTYPE,OPTIONS"],
    {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 65_536,
    },
  );
  report.mount_query = {
    exit_code: mount.status,
    signal: mount.signal,
    error: mount.error ? String(mount.error) : null,
    stdout: mount.stdout,
    stderr: mount.stderr,
  };
  await save();
  if (mount.error) throw mount.error;
  assert.equal(mount.status, 0);
  const parsed: unknown = JSON.parse(mount.stdout);
  assert.ok(
    isRecord(parsed) && Array.isArray(parsed.filesystems) && parsed.filesystems.length === 1,
  );
  const mounted: unknown = parsed.filesystems[0];
  assert.ok(
    isRecord(mounted) && typeof mounted.target === "string" && typeof mounted.options === "string",
  );
  assert.equal(path.resolve(mounted.target), path.dirname(image));
  assert.equal(mounted.fstype, "tmpfs");
  assert.ok(mounted.options.split(",").includes("noexec"));
  report.mount = mounted;
  const launch = spawnSync(image, ["--application-update-recovery", "status"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 65_536,
  });
  report.execution = {
    pid: launch.pid,
    exit_code: launch.status,
    signal: launch.signal,
    error: launch.error ? String(launch.error) : null,
    error_code: errorCode(launch.error),
    errno: launch.error && "errno" in launch.error ? launch.error.errno : null,
    stdout: launch.stdout,
    stderr: launch.stderr,
  };
  await save(); // Actual kernel result is durable before acceptance assertions.
  assert.equal(errorCode(launch.error), "EACCES");
  assert.equal(launch.pid, 0);
  assert.equal(launch.status, null);
  assert.equal(launch.signal, null);
  assert.equal((await fileIdentity(image, { maxBytes: 128 * 1024 * 1024 })).sha256, binary.sha256);
  report.phase = "noexec-refused";
  await save();
  console.log(JSON.stringify(report));
} catch (error) {
  report.phase = "failed";
  report.failure = String(error);
  await save();
  throw error;
}
