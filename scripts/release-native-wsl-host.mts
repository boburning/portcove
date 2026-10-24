/** Fixed read-only Windows registration observation. No setup or native grant. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { requireActualNativeInvocation } from "./release-native-attempt.mts";
import { inspectNativeWslBoundary } from "./release-native-wsl-boundary.mts";
import { readNativeSchedulerToolDigest } from "./release-native-scheduler.mts";
import { remainingNativeParentBudget } from "./release-native-parent.mts";
import type { requireActualNativeParent } from "./release-native-parent.mts";
import { requireActualPublicJourneyPair } from "./release-native-public-pair.mts";

export function inspectNativeWslRegistration(
  raw: unknown,
  boundary: ReturnType<typeof inspectNativeWslBoundary>,
  parentPid: number,
) {
  assert.ok(
    isRecord(raw) &&
      Object.keys(raw).sort().join(",") ===
        "after,before,broker_sid,mutations,observed_at,parent_pid,reader_pid,schema_version",
  );
  assert.equal(raw.schema_version, 1);
  assert.equal(raw.broker_sid, boundary.broker_sid);
  assert.equal(raw.parent_pid, parentPid);
  assert.equal(raw.mutations, "none");
  assert.ok(
    Number.isSafeInteger(raw.reader_pid) &&
      Number(raw.reader_pid) > 0 &&
      raw.reader_pid !== parentPid,
  );
  assert.ok(
    typeof raw.observed_at === "string" &&
      Number.isFinite(Date.parse(raw.observed_at)) &&
      new Date(raw.observed_at).toISOString() === raw.observed_at,
  );
  assert.equal(digest(raw.before), digest(raw.after));
  assert.ok(
    isRecord(raw.before) &&
      Object.keys(raw.before).sort().join(",") === "default_uid,name,registration_id,wsl_version",
  );
  const actual = raw.before;
  assert.equal(actual.registration_id, boundary.distribution.registration_id);
  assert.equal(actual.name, boundary.distribution.name);
  assert.equal(actual.wsl_version, 2);
  assert.ok(
    Number.isSafeInteger(actual.default_uid) &&
      Number(actual.default_uid) >= 0 &&
      Number(actual.default_uid) <= 4294967294,
  );
  return Object.freeze({
    broker_sid: raw.broker_sid,
    registration: Object.freeze({ ...actual }),
    observed_at: raw.observed_at,
    authority: "none" as const,
  });
}
function inspectNativeLinuxHost(
  raw: unknown,
  boundary: { account: { qualification: string }; qualification_gid: string },
  invocation: string,
  expected: { machine_id_sha256: string; minimum_os_version: string },
  minimumKind: "kernel" | "distribution",
) {
  assert.ok(
    isRecord(raw) &&
      Object.keys(raw).sort().join(",") ===
        "architecture,authority,invocation_id,kernel_release,machine_id_sha256,os_release,qualification_gid,qualification_uid,schema_version",
  );
  assert.equal(raw.schema_version, 1);
  assert.equal(raw.authority, "none");
  assert.equal(raw.invocation_id, invocation);
  assert.equal(raw.qualification_uid, Number(boundary.account.qualification));
  assert.equal(raw.qualification_gid, Number(boundary.qualification_gid));
  assert.equal(raw.machine_id_sha256, expected.machine_id_sha256);
  assert.equal(raw.architecture, "x86_64");
  assert.ok(
    typeof raw.os_release === "string" &&
      Buffer.byteLength(raw.os_release) <= 16384 &&
      !raw.os_release.includes("\0"),
  );
  const os = new Map<string, string>();
  for (const line of raw.os_release.split("\n")) {
    const match = /^([A-Z_]+)=(?:"([^"\\]*)"|([A-Za-z0-9._-]+))$/u.exec(line);
    if (match) {
      assert.ok(!os.has(match[1]!));
      os.set(match[1]!, match[2] ?? match[3]!);
    }
  }
  assert.equal(os.get("ID"), "ubuntu");
  assert.equal(os.get("VERSION_ID"), "24.04");
  assert.ok(typeof raw.kernel_release === "string" && raw.kernel_release.length <= 128);
  const actual = /^([0-9]+(?:\.[0-9]+){1,3})(?:[-+][A-Za-z0-9._+-]+)?$/u.exec(raw.kernel_release),
    minimum = /^[0-9]+(?:\.[0-9]+){1,3}$/u.exec(expected.minimum_os_version);
  assert.ok(actual && minimum, "actual Linux kernel/minimum field differs");
  const a = (minimumKind === "kernel" ? actual[1]! : os.get("VERSION_ID")!).split(".").map(BigInt),
    b = minimum[0].split(".").map(BigInt);
  let comparison = 0;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index] ?? 0n,
      right = b[index] ?? 0n;
    if (left !== right) {
      comparison = left > right ? 1 : -1;
      break;
    }
  }
  assert.ok(
    comparison >= 0,
    minimumKind === "kernel"
      ? "actual kernel is below configured minimum"
      : "actual Ubuntu distribution is below configured minimum",
  );
  return Object.freeze({ ...raw, authority: "none" as const });
}

/** Existing local/WSL compatibility floor remains a kernel version. */
export function inspectNativeWslGuestHost(
  raw: unknown,
  boundary: { account: { qualification: string }; qualification_gid: string },
  invocation: string,
  expected: { machine_id_sha256: string; minimum_os_version: string },
) {
  return inspectNativeLinuxHost(raw, boundary, invocation, expected, "kernel");
}

/** Selected hosted compatibility uses the observed Ubuntu distribution floor.
 * Kernel syntax, exact Ubuntu24.04, account and machine joins remain required.
 * This is an inert inspection, never source or direct-capture provenance. */
export function inspectHostedNativeLinuxHost(
  raw: unknown,
  boundary: { account: { qualification: string }; qualification_gid: string },
  invocation: string,
  expected: { machine_id_sha256: string; minimum_os_version: string },
) {
  return inspectNativeLinuxHost(raw, boundary, invocation, expected, "distribution");
}

export async function observeActualNativeWslRegistration(claim: object) {
  const actual = await requireActualNativeInvocation(claim);
  const result = await observeRegistration(actual.parent, actual.capture_directory);
  await requireActualNativeInvocation(claim);
  return result;
}

/** The ordinary public pair has its own actual-source provenance. It must never
 * be cast to a native-stage invocation merely to reuse this read-only observer. */
export async function observeActualPublicWslRegistration(pairReceipt: object) {
  const actual = await requireActualPublicJourneyPair(pairReceipt);
  const result = await observeRegistration(actual.parent, actual.directory);
  await requireActualPublicJourneyPair(pairReceipt);
  return result;
}

async function observeRegistration(
  parent: Awaited<ReturnType<typeof requireActualNativeParent>>,
  captureDirectory: string,
) {
  assert.equal(process.platform, "win32");
  await parent.recheck();
  assert.equal(parent.descriptor.platform_label, "linux-x86_64");
  const boundary = inspectNativeWslBoundary(
    parent.boundary_configuration,
    parent.authority_configuration.native["linux-x86_64"].host.account,
    parent.controller_root,
    parent.descriptor.capture_root,
  );
  const scheduler = parent.installation_record.scheduler;
  assert.ok(
    isRecord(scheduler) &&
      isRecord(scheduler.powershell) &&
      typeof scheduler.powershell.path === "string" &&
      typeof scheduler.powershell.sha256 === "string",
  );
  const helper = fileURLToPath(new URL("./read-native-wsl-host.ps1", import.meta.url));
  assert.equal(
    path.resolve(helper),
    path.resolve(parent.controller_root, "scripts/read-native-wsl-host.ps1"),
  );
  assert.equal(
    await readNativeSchedulerToolDigest(scheduler.powershell.path, 64 * 1024 * 1024),
    scheduler.powershell.sha256,
  );
  const helperSha = await readNativeSchedulerToolDigest(helper, 32768);
  const text = execFileSync(
    scheduler.powershell.path,
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      helper,
      "-BrokerSid",
      boundary.broker_sid,
      "-RegistrationId",
      boundary.distribution.registration_id,
      "-DistributionName",
      boundary.distribution.name,
      "-ParentProcessId",
      String(process.pid),
    ],
    {
      cwd: parent.controller_root,
      windowsHide: true,
      encoding: "utf8",
      timeout: Math.min(10000, remainingNativeParentBudget()),
      maxBuffer: 65536,
      env: {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.SystemRoot,
        PATH: path.win32.join(String(process.env.SystemRoot), "System32"),
        TEMP: captureDirectory,
        TMP: captureDirectory,
      },
    },
  );
  const raw: unknown = JSON.parse(text),
    observed = inspectNativeWslRegistration(raw, boundary, process.pid);
  assert.equal(await readNativeSchedulerToolDigest(helper, 32768), helperSha);
  assert.equal(
    await readNativeSchedulerToolDigest(scheduler.powershell.path, 64 * 1024 * 1024),
    scheduler.powershell.sha256,
  );
  await parent.recheck();
  return { observed, raw, helper_sha256: helperSha, authority: "none" as const };
}
