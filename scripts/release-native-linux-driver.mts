/** Fixed credential-free guest driver. Only the installed Windows parent can
 * retain invocation provenance; this process emits observations, never a grant. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, lstat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectIsolatedNativeLinuxBinding } from "../apps/desktop/scripts/native-linux-isolated-plan.mts";
import { isRecord, errorMessage, errorCode } from "./runtime-values.mts";
import { runResourceCommand } from "./resource-command.mts";
export const nativeLinuxPreSignHarnessScenarios = Object.freeze([
  "empty-library",
  "appearance-restart",
] as const);
export async function requireFreshNativeLinuxOutput(filename: string) {
  try {
    await lstat(filename);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return filename;
    throw error;
  }
  throw new Error("native desktop output already exists; retain it without reuse");
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
async function boundedJson(filename: string, expected: string) {
  assert.match(expected, /^[a-f0-9]{64}$/u);
  const before = await lstat(filename);
  assert.ok(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1 &&
      before.size > 0 &&
      before.size <= 128 * 1024,
  );
  assert.equal(before.uid, process.getuid?.());
  assert.equal(before.mode & 0o077, 0);
  const bytes = await readFile(filename);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected);
  const after = await lstat(filename);
  for (const name of ["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const)
    assert.equal(after[name], before[name]);
  return JSON.parse(bytes.toString("utf8")) as unknown;
}
export async function runNativeLinuxDriver(
  planPath: string,
  planSha256: string,
  unitBindingPath: string,
) {
  assert.equal(process.platform, "linux");
  const raw = await boundedJson(planPath, planSha256);
  assert.ok(
    isRecord(raw) &&
      Object.keys(raw).sort().join(",") ===
        "binding,invocation_id,schema_version,stage,stage_request_sha256" &&
      raw.schema_version === 1 &&
      raw.stage === "payload-signing",
  );
  assert.ok(
    typeof raw.stage_request_sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(raw.stage_request_sha256),
  );
  assert.ok(isRecord(raw.binding));
  const root = path.posix.dirname(path.posix.dirname(planPath));
  assert.equal(path.posix.basename(planPath), "plan.json");
  assert.equal(path.posix.basename(root), "invocations");
  const directory = path.posix.dirname(planPath);
  assert.equal(unitBindingPath, `${directory}/capture/unit-binding.json`);
  const unitInfo = await lstat(unitBindingPath);
  assert.ok(
    unitInfo.isFile() &&
      !unitInfo.isSymbolicLink() &&
      unitInfo.nlink === 2 &&
      unitInfo.size <= 32768 &&
      unitInfo.uid === process.getuid?.() &&
      (unitInfo.mode & 0o077) === 0,
  );
  const unit: unknown = JSON.parse(await readFile(unitBindingPath, "utf8"));
  assert.ok(
    isRecord(unit) &&
      Object.keys(unit).sort().join(",") ===
        "deadline_utc,invocation_id,kind,nonce,schema_version,unit" &&
      unit.schema_version === 1 &&
      unit.kind === "native-driver-admitted" &&
      typeof unit.nonce === "string" &&
      /^[a-f0-9]{64}$/u.test(unit.nonce) &&
      unit.invocation_id === raw.invocation_id &&
      isRecord(unit.unit),
  );
  const binding = inspectIsolatedNativeLinuxBinding({ ...raw.binding, unit: unit.unit });
  assert.equal(raw.invocation_id, binding.invocation_id);
  assert.equal(unit.deadline_utc, binding.deadline_utc);
  assert.equal(directory, `${binding.linux_root}/invocations/${binding.invocation_id}`);
  assert.equal(
    fileURLToPath(import.meta.url),
    `${binding.controller.root}/scripts/release-native-linux-driver.mts`,
  );
  assert.equal(process.execPath, binding.tools.node?.path);
  assert.equal(process.getuid?.(), binding.account.uid);
  assert.equal(process.getgid?.(), binding.account.gid);
  assert.equal(
    (await readFile("/proc/self/cgroup", "utf8")).trim(),
    `0::${binding.unit.control_group}`,
  );
  const filesystem = await statfs(binding.home);
  const mount = inspectNativeLinuxHomeMount(
    await readFile("/proc/self/mountinfo", "utf8"),
    binding.home,
    filesystem,
  );
  const bindingPath = `${binding.capture_root}/linux-binding.json`,
    bytes = Buffer.from(JSON.stringify(binding));
  await writeFile(bindingPath, bytes, { flag: "wx", mode: 0o600 });
  await writeFile(`${binding.capture_root}/home-mount.json`, JSON.stringify(mount), {
    flag: "wx",
    mode: 0o600,
  });
  const output = `${binding.capture_root}/desktop`;
  await requireFreshNativeLinuxOutput(output); // The harness owns CreateNew output.
  const environment: NodeJS.ProcessEnv = {
    PATH: `${binding.linux_root}/tools:/usr/bin:/bin`,
    HOME: `/home/${binding.linux_root.split("/")[2]}`,
    LANG: "C.UTF-8",
    PORTCOVE_NATIVE_LINUX_BINDING: bindingPath,
    PORTCOVE_NATIVE_LINUX_BINDING_SHA256: createHash("sha256").update(bytes).digest("hex"),
  };
  const started_at = new Date().toISOString();
  let status: number | null = null,
    failure: string | null = null;
  try {
    assert.ok(Date.parse(binding.deadline_utc) > Date.now());
    status = await runResourceCommand(
      "analysis",
      process.execPath,
      [
        `${binding.controller.root}/apps/desktop/scripts/desktop-test.mts`,
        "--app",
        binding.application.path,
        "--output",
        output,
        "--driver",
        binding.tools.driver!.path,
        "--native-driver",
        binding.tools.webkit_driver!.path,
        ...nativeLinuxPreSignHarnessScenarios.flatMap((name) => ["--scenario", name]),
      ],
      {
        cwd: binding.controller.root,
        environment,
        exclusive: [`native-linux:${binding.account.uid}`],
      },
    );
    assert.equal(status, 0, "actual isolated desktop harness failed");
  } catch (error) {
    failure = errorMessage(error);
    throw error;
  } finally {
    await writeFile(
      `${binding.capture_root}/linux-driver-result.json`,
      JSON.stringify({
        schema_version: 1,
        invocation_id: binding.invocation_id,
        stage_request_sha256: raw.stage_request_sha256,
        started_at,
        completed_at: new Date().toISOString(),
        status,
        failure,
        home_mount: mount,
        authority: "none",
        native_acceptance: "not-established",
      }),
      { flag: "wx", mode: 0o600 },
    );
  }
}
async function cli() {
  const [flag, plan, shaFlag, sha, unitFlag, unit, ...rest] = process.argv.slice(2);
  assert.ok(
    flag === "--plan" &&
      plan &&
      shaFlag === "--plan-sha256" &&
      sha &&
      unitFlag === "--unit-binding" &&
      unit &&
      !rest.length,
  );
  await runNativeLinuxDriver(plan, sha, unit);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await cli();
