/** Bounded inert transport only. Provider equality is not native acceptance. */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { crc32, inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { readCompleteRunArtifactInventory } from "./release-run-artifact-inventory.mts";
import { hostedNativeProofLimits } from "./release-hosted-native-proof-contract.mts";
import type { HostedNativeProofFiles } from "./release-hosted-native-proof-contract.mts";
import { isRecord } from "./runtime-values.mts";

const keys = ["subject", "report", "capture", "bundle"] as const;
const expandedBytes = keys.reduce((sum, key) => sum + hostedNativeProofLimits[key], 0);
export const hostedNativeArchiveLimit = expandedBytes + 65536;
type Slot = {
  controller_revision: string;
  run_id: string;
  run_attempt: number;
  platform_label: "windows-x86_64" | "linux-x86_64";
  stage: "payload-signing" | "release-publication";
};
function slot(raw: Slot): Slot {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !==
      "controller_revision,platform_label,run_attempt,run_id,stage" ||
    !/^[a-f0-9]{40}$/u.test(raw.controller_revision) ||
    !/^[1-9][0-9]{0,15}$/u.test(raw.run_id) ||
    raw.run_attempt !== 1 ||
    !["windows-x86_64", "linux-x86_64"].includes(raw.platform_label) ||
    !["payload-signing", "release-publication"].includes(raw.stage)
  )
    throw new Error("fixed original native artifact slot required");
  return { ...raw };
}
export function hostedNativeArtifactName(raw: Slot) {
  const value = slot(raw);
  return `hosted-native-${value.stage}-${value.platform_label}-${value.run_id}-${value.run_attempt}`;
}

/** Preflight every raw entry and per-member bound before any inflation. No
 * extraction, candidate execution, JSON acceptance or private receipt occurs. */
export function readHostedNativeProofArchive(raw: Buffer, deadline: number) {
  if (!Number.isFinite(deadline) || deadline - performance.now() > 120000)
    throw new Error("bounded original native artifact deadline required");
  const { archive, entries } = inspectBoundedZip(
    raw,
    {
      compressedBytes: hostedNativeArchiveLimit,
      expandedBytes,
      files: 4,
      nameBytes: 32,
      allowedPaths: new Set(keys.map((key) => `${key}.json`)),
    },
    { clock: performance.now.bind(performance), deadline },
  );
  if (entries.length !== 4) throw new Error("complete original native proof files required");
  for (const entry of entries) {
    const key = keys.find((candidate) => entry.name === `${candidate}.json`)!;
    if (entry.bytes < 1 || entry.bytes > hostedNativeProofLimits[key])
      throw new Error("native proof member exceeds fixed bound");
  }
  const files = {} as HostedNativeProofFiles;
  for (const entry of entries) {
    if (performance.now() >= deadline) throw new Error("native artifact deadline exhausted");
    const key = keys.find((candidate) => entry.name === `${candidate}.json`)!;
    const compressed = archive.subarray(entry.data, entry.dataEnd);
    const bytes =
      entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
    if (bytes.length !== entry.bytes || crc32(bytes) !== entry.crc)
      throw new Error("native proof member length/CRC differs");
    files[key] = bytes;
  }
  if (performance.now() >= deadline) throw new Error("native artifact deadline exhausted");
  return files;
}

/** Caller supplies independently admitted run/source/slot. Untrusted subject
 * IDs locate the original job only; the actual receiver verifies its issuer,
 * source, full configuration, grant, package, signature and runtime capture. */
export function readHostedNativeProofArtifact(
  api: GitHubRestReader,
  rawSlot: Slot,
  directory: string,
  deadline: number,
  download: typeof readGitHubArtifactArchive = readGitHubArtifactArchive,
) {
  const expected = slot(rawSlot),
    request = api.request.bind(api);
  const remaining = () => {
    const left = deadline - performance.now();
    if (!Number.isFinite(left) || left <= 0 || left > 120000)
      throw new Error("bounded original native artifact deadline exhausted");
    return Math.max(1, Math.floor(left));
  };
  const name = hostedNativeArtifactName(expected);
  const inventory = () => {
    const complete = readCompleteRunArtifactInventory((page) => {
      remaining();
      const response = request(
        "GET",
        `repos/boburning/portcove/actions/runs/${expected.run_id}/artifacts?per_page=100&page=${page}`,
      );
      remaining();
      if (response.status !== 200) throw new Error("native artifact inventory unavailable");
      return response.body;
    });
    const matches = complete.artifacts.filter((row) => row.name === name);
    if (matches.length !== 1) throw new Error("unique original native artifact unavailable");
    const row = matches[0]!;
    if (
      row.expired !== false ||
      typeof row.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(row.digest) ||
      typeof row.size_in_bytes !== "number" ||
      !Number.isSafeInteger(row.size_in_bytes) ||
      row.size_in_bytes < 22 ||
      row.size_in_bytes > hostedNativeArchiveLimit ||
      !isRecord(row.workflow_run) ||
      String(row.workflow_run.id) !== expected.run_id ||
      row.workflow_run.head_sha !== expected.controller_revision ||
      row.workflow_run.repository_id !== 1354613114 ||
      row.workflow_run.head_repository_id !== 1354613114
    )
      throw new Error("native artifact original provider identity differs");
    return { id: Number(row.id), sha256: row.digest.slice(7), bytes: row.size_in_bytes, name };
  };
  const before = inventory();
  const archive = download(`repos/boburning/portcove/actions/artifacts/${before.id}/zip`, {
    cwd: directory,
    maxBytes: before.bytes,
    timeoutMs: remaining(),
  });
  remaining();
  if (
    archive.length !== before.bytes ||
    createHash("sha256").update(archive).digest("hex") !== before.sha256
  )
    throw new Error("native artifact opaque bytes changed");
  const files = readHostedNativeProofArchive(archive, deadline);
  const subject: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(files.subject),
  );
  if (
    !isRecord(subject) ||
    subject.schema_version !== 1 ||
    (subject.purpose !== "hosted-native-qualification" &&
      subject.purpose !== "hosted-native-continuity") ||
    subject.platform_label !== expected.platform_label ||
    subject.stage !== expected.stage ||
    !isRecord(subject.producer) ||
    subject.producer.controller_revision !== expected.controller_revision ||
    subject.producer.run_id !== expected.run_id ||
    subject.producer.run_attempt !== expected.run_attempt ||
    !Number.isSafeInteger(subject.producer.job_id) ||
    Number(subject.producer.job_id) < 1 ||
    typeof subject.producer.check_run_id !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(subject.producer.check_run_id)
  )
    throw new Error("native artifact subject locator differs from original slot");
  const after = inventory();
  remaining();
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error("native artifact inventory changed during readback");
  return {
    locator: {
      run_id: expected.run_id,
      run_attempt: expected.run_attempt,
      platform_label: expected.platform_label,
      job_id: Number(subject.producer.job_id),
      check_run_id: subject.producer.check_run_id,
    },
    files,
    artifact: before,
    authority: "none" as const,
  };
}
