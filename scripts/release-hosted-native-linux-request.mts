/** Source-bound, read-only Linux request preparation. No account creation,
 * privilege change, candidate invocation or native receipt is performed. */
import process from "node:process";
import os from "node:os";
import path from "node:path";
import { lstat, realpath, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { requireActualHostedNativeParentSource } from "./release-hosted-native-parent.mts";
import { requireActualHostedNativePostSignPayload } from "./release-hosted-native-postsign-inputs.mts";
import { requireActualHostedNativeCandidate } from "./release-hosted-native-candidate.mts";
import { prepareHostedNativeStageRequest } from "./release-native-stage-capture.mts";
import { inspectHostedNativeLinuxHost } from "./release-native-wsl-host.mts";
import { nativeInvocationIdentity } from "./release-native-candidate.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";

const user = "portcove-native";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const attempts = new WeakSet<object>();
type Candidate =
  | Awaited<ReturnType<typeof requireActualHostedNativeCandidate>>
  | Awaited<ReturnType<typeof requireActualHostedNativePostSignPayload>>;
type Parent = Awaited<ReturnType<typeof requireActualHostedNativeParentSource>>;
const requests = new WeakMap<
  object,
  {
    snapshot: string;
    candidate: object;
    readCandidate: () => Promise<Candidate>;
    nonce: string;
    host: Awaited<ReturnType<typeof observeHost>>;
    prepared: ReturnType<typeof prepareHostedNativeStageRequest>;
    record: Buffer;
    filename: string;
    stopped: boolean;
  }
>();

async function rootFile(
  filename: "/etc/passwd" | "/etc/machine-id" | "/etc/os-release",
  maximum: number,
) {
  const resolved = await realpath(filename);
  if (
    resolved !== filename &&
    !(filename === "/etc/os-release" && resolved === "/usr/lib/os-release")
  )
    throw new Error("fixed Linux observation file resolves outside system paths");
  for (let directory = path.posix.dirname(resolved); ; directory = path.posix.dirname(directory)) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0)
      throw new Error("Linux observation system ancestry is not root-owned and protected");
    if (directory === "/") break;
  }
  const before = await lstat(resolved);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== 0 ||
    before.nlink !== 1 ||
    (before.mode & 0o022) !== 0
  )
    throw new Error("Linux observation file custody differs");
  const bytes = await readControllerToolFile(resolved, maximum);
  const after = await lstat(resolved);
  for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs", "uid", "mode", "nlink"] as const)
    if (before[key] !== after[key]) throw new Error("Linux observation file changed");
  if ((await realpath(filename)) !== resolved) throw new Error("Linux observation path changed");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function observeHost(parent: Parent, nonce: string) {
  parent.recheck();
  if (parent.configuration.purpose !== "application")
    throw new Error("original hosted application scope required");
  if (process.platform !== "linux" || process.arch !== "x64" || !process.getuid || !process.getgid)
    throw new Error("actual Linux x86_64 parent required");
  const broker = process.getuid(),
    brokerGid = process.getgid();
  const passwd = await rootFile("/etc/passwd", 65536);
  parent.recheck();
  const entries = passwd.split("\n").filter((line) => line.startsWith(`${user}:`));
  if (entries.length !== 1)
    throw new Error("fixed noninteractive Linux qualification account unavailable");
  const fields = entries[0]!.split(":");
  if (
    fields.length !== 7 ||
    !["x", "*", "!", "!!"].includes(fields[1]!) ||
    !/^[1-9][0-9]{0,9}$/u.test(fields[2]!) ||
    !/^[1-9][0-9]{0,9}$/u.test(fields[3]!) ||
    fields[5] !== `/home/${user}` ||
    fields[6] !== "/usr/sbin/nologin"
  )
    throw new Error("fixed Linux qualification account contract differs");
  const uid = Number(fields[2]),
    gid = Number(fields[3]);
  if (uid > 4294967294 || gid > 4294967294 || uid === broker)
    throw new Error("Linux qualification account is not separate and nonroot");
  const machine = (await rootFile("/etc/machine-id", 256)).trim();
  if (!/^[a-f0-9]{32}$/u.test(machine))
    throw new Error("actual Linux machine identity unavailable");
  parent.recheck();
  const osRelease = await rootFile("/etc/os-release", 16384);
  parent.recheck();
  const observed = {
    schema_version: 1,
    invocation_id: nonce,
    qualification_uid: uid,
    qualification_gid: gid,
    machine_id_sha256: sha(Buffer.from(machine)),
    os_release: osRelease,
    kernel_release: os.release(),
    architecture: os.machine(),
    authority: "none",
  };
  inspectHostedNativeLinuxHost(
    observed,
    { account: { qualification: String(uid) }, qualification_gid: String(gid) },
    nonce,
    {
      machine_id_sha256: observed.machine_id_sha256,
      minimum_os_version:
        parent.configuration.hosted_native["linux-x86_64"].compatibility.minimum_os_version,
    },
  );
  if (broker !== process.getuid() || brokerGid !== process.getgid())
    throw new Error("actual Linux broker identity changed");
  parent.recheck();
  return {
    observed,
    broker_gid: brokerGid,
    qualification_user: user,
    projection: {
      machine_id_sha256: observed.machine_id_sha256,
      qualification_profile: "fixed-hosted-native-v1",
      account: { kind: "linux-uid", broker: String(broker), qualification: String(uid) },
    },
  };
}

export function prepareActualHostedNativeLinuxRequest(candidateReceipt: object) {
  return prepareRequest(candidateReceipt, "payload-signing");
}
export function prepareActualHostedNativeLinuxPostSignRequest(candidateReceipt: object) {
  return prepareRequest(candidateReceipt, "release-publication");
}
async function prepareRequest(
  candidateReceipt: object,
  stage: "payload-signing" | "release-publication",
) {
  const readCandidate =
    stage === "payload-signing"
      ? () => requireActualHostedNativeCandidate(candidateReceipt)
      : () => requireActualHostedNativePostSignPayload(candidateReceipt);
  const candidate = await readCandidate();
  const parent = await requireActualHostedNativeParentSource(candidate.parent_source);
  if (
    candidate.platform_label !== "linux-x86_64" ||
    candidate.stage !== stage ||
    parent.platform_label !== candidate.platform_label ||
    parent.stage !== candidate.stage ||
    attempts.has(candidateReceipt)
  )
    throw new Error("one original hosted Linux request preparation required");
  attempts.add(candidateReceipt);
  let phase = "host-observation";
  try {
    const nonce = randomBytes(32).toString("hex");
    const host = await observeHost(parent, nonce);
    const input = {
      schema_version: 1,
      stage: candidate.stage,
      platform_label: candidate.platform_label,
      candidate: candidate.candidate,
      journey: "journey" in candidate ? candidate.journey : null,
      invocation_id: "0".repeat(64),
      setup_descriptor_sha256: parent.configuration.journal.setup_plan_sha256,
    };
    const provisional = prepareHostedNativeStageRequest(
      input,
      parent.configuration,
      host.projection,
    );
    phase = "coordinator-recovery-counters";
    const invocation = nativeInvocationIdentity(provisional, candidate.recovery);
    const prepared = prepareHostedNativeStageRequest(
      { ...input, invocation_id: invocation.invocation_id },
      parent.configuration,
      host.projection,
    );
    await readCandidate();
    const record = Buffer.from(
      JSON.stringify({
        host_observation_nonce: nonce,
        host,
        prepared,
        recovery: invocation.counters,
        configuration_sha256: parent.producer.configuration_sha256,
        source: parent.producer,
        authority: "none",
        scope: "request preparation only; no isolation or capture",
      }),
    );
    if (record.length > 65536) throw new Error("hosted Linux request record exceeds bound");
    const filename = path.join(candidate.directory, "hosted-linux-request.json");
    phase = "request-retention";
    await writeFile(filename, record, { flag: "wx", mode: 0o600 });
    await requireActualHostedNativeParentSource(candidate.parent_source);
    const receipt = Object.freeze({
      kind: "hosted-native-linux-request",
      filename,
      invocation_id: invocation.invocation_id,
      authority: "none",
      native_acceptance: "not-established",
    });
    requests.set(receipt, {
      snapshot: JSON.stringify(receipt),
      candidate: candidateReceipt,
      readCandidate,
      nonce,
      host,
      prepared,
      record,
      filename,
      stopped: false,
    });
    return receipt;
  } catch {
    await writeFile(
      path.join(candidate.directory, "hosted-linux-request-refusal.json"),
      JSON.stringify({
        phase,
        automatic_retry: false,
        authority: "none",
        native_acceptance: "not-established",
      }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error(`hosted Linux request preparation refused; retain ${candidate.directory}`);
  }
}

export async function requireActualHostedNativeLinuxRequest(receipt: object) {
  const retained = requests.get(receipt);
  if (!retained || retained.stopped || retained.snapshot !== JSON.stringify(receipt))
    throw new Error("original active hosted Linux request required");
  try {
    const candidate = await retained.readCandidate();
    const parent = await requireActualHostedNativeParentSource(candidate.parent_source);
    const record = await readControllerToolFile(retained.filename, retained.record.length);
    if (!record.equals(retained.record)) throw new Error("retained hosted Linux request changed");
    const host = await observeHost(parent, retained.nonce);
    if (releaseCanonicalDigest(host) !== releaseCanonicalDigest(retained.host))
      throw new Error("actual Linux host or account changed");
    await retained.readCandidate();
    if (retained.stopped) throw new Error("original active hosted Linux request required");
    return Object.freeze({
      directory: candidate.directory,
      package_path: candidate.package_path,
      predecessor: "predecessor" in candidate ? candidate.predecessor : null,
      payload_crypto: "payload_crypto" in candidate ? candidate.payload_crypto : null,
      prepared: structuredClone(retained.prepared),
      host: structuredClone(host),
      candidate_receipt: retained.candidate,
      parent_source: candidate.parent_source,
      authority: "none" as const,
      scope: "source-bound request only; no isolation, invocation or acceptance" as const,
    });
  } catch (error) {
    retained.stopped = true;
    throw error;
  }
}
