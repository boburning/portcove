/** Bounded data transfer for the one disposable Actions rehearsal. Incoming
 * archives never supply code, tools, paths or extraction policy. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { isRecord } from "./runtime-values.mts";
import { rehearsalExecution, rehearsalOrigin } from "./upstream-release-identity.mts";

export type RehearsalTransfer =
  | "unsigned"
  | "signed"
  | "candidate-executable"
  | "acceptance"
  | "public-predecessor"
  | "public-acceptance";
export function rehearsalTransferFiles(
  kind: RehearsalTransfer,
  origin: { run_id: string; run_attempt: number },
) {
  const version = `0.0.0-rehearsal.${origin.run_id}.${origin.run_attempt}`;
  const payload = `Portcove_${version}_x64-setup.exe`;
  const unsigned = [
    payload,
    "fixture.patch",
    "windows-compatibility.json",
    `portcove-cli-${version}-windows-x86_64.zip`,
  ];
  if (kind === "candidate-executable") return ["portcove-desktop.exe"];
  if (kind === "acceptance")
    return ["acceptance.json", "installed.json", "renderer-update-evidence.json", "summary.json"];
  if (kind === "public-acceptance")
    return ["installed.json", "renderer-update-evidence.json", "summary.json"];
  if (kind === "public-predecessor")
    return ["public-predecessor.json", `Portcove_0.0.0-rehearsal.${origin.run_id}.0_x64-setup.exe`];
  if (kind === "unsigned") return [...unsigned, "rehearsal.json"];
  if (kind === "signed")
    return [
      ...unsigned,
      `${payload}.sig`,
      "disposable.pub",
      "updater-inventory.json",
      "trusted-root.json",
      "feed.json",
      "baseline-feed.json",
      "rehearsal.json",
    ];
  throw new Error("unknown rehearsal transfer kind");
}

export function inspectRehearsalArtifact(
  raw: unknown,
  expected: {
    id: number;
    kind: RehearsalTransfer;
    source: string;
    run_id: string;
    producer_attempt: number;
  },
) {
  if (
    !Number.isSafeInteger(expected.id) ||
    expected.id < 1 ||
    !Number.isSafeInteger(expected.producer_attempt) ||
    expected.producer_attempt < 1 ||
    !isRecord(raw) ||
    raw.id !== expected.id ||
    raw.name !== `upstream-${expected.kind}-${expected.run_id}-${expected.producer_attempt}` ||
    raw.expired !== false ||
    !Number.isSafeInteger(raw.size_in_bytes) ||
    Number(raw.size_in_bytes) < 22 ||
    Number(raw.size_in_bytes) > 512 * 1024 ** 2 ||
    typeof raw.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(raw.digest) ||
    !isRecord(raw.workflow_run) ||
    raw.workflow_run.id !== Number(expected.run_id) ||
    raw.workflow_run.head_sha !== expected.source ||
    raw.workflow_run.repository_id !== 1354613114
  )
    throw new Error("exact bounded rehearsal artifact provider identity differs");
  return {
    id: expected.id,
    archive_bytes: Number(raw.size_in_bytes),
    archive_sha256: raw.digest.slice(7),
  };
}

export async function receiveRehearsalArtifact(
  kind: RehearsalTransfer,
  id: number,
  directory: string,
  producerAttempt: number,
) {
  const origin = rehearsalOrigin();
  const executor = rehearsalExecution();
  if (producerAttempt > executor.run_attempt) throw new Error("artifact producer is in the future");
  const response: unknown = JSON.parse(
    execFileSync(
      "gh",
      ["api", "--hostname", "github.com", `repos/boburning/portcove/actions/artifacts/${id}`],
      {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 65536,
      },
    ),
  );
  const observed = inspectRehearsalArtifact(response, {
    id,
    kind,
    source: origin.source,
    run_id: origin.run_id,
    producer_attempt: producerAttempt,
  });
  const archive = readGitHubArtifactArchive(
    `repos/boburning/portcove/actions/artifacts/${id}/zip`,
    {
      cwd: process.cwd(),
      maxBytes: 512 * 1024 ** 2,
      timeoutMs: 120000,
    },
  );
  if (
    archive.length !== observed.archive_bytes ||
    createHash("sha256").update(archive).digest("hex") !== observed.archive_sha256
  )
    throw new Error("provider archive length/digest changed during transfer");
  const names = rehearsalTransferFiles(kind, origin);
  const parsed = inspectBoundedZip(
    archive,
    {
      compressedBytes: 512 * 1024 ** 2,
      expandedBytes: 2 * 1024 ** 3,
      files: names.length,
      nameBytes: 160,
      allowedPaths: new Set(names),
    },
    { deadline: Date.now() + 30000 },
  );
  if (parsed.entries.length !== names.length)
    throw new Error("rehearsal transfer omitted a required file");
  // Validate all declarations before inflation or any filesystem mutation.
  for (const entry of parsed.entries) {
    const bound =
      entry.name.endsWith(".exe") || entry.name.endsWith(".zip") ? 256 * 1024 ** 2 : 2 * 1024 ** 2;
    if (entry.bytes < 1 || entry.bytes > bound)
      throw new Error("rehearsal transfer file exceeds its bound");
  }
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory);
  for (const entry of parsed.entries) {
    const compressed = archive.subarray(entry.data, entry.dataEnd);
    const bytes =
      entry.method === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
    if (bytes.length !== entry.bytes || crc32(bytes) !== entry.crc)
      throw new Error("rehearsal archive expanded bytes differ");
    await writeFile(path.join(directory, entry.name), bytes, { flag: "wx" });
  }
  await mkdir("work/upstream-transfer-receipts", { recursive: true });
  await writeFile(
    `work/upstream-transfer-receipts/${kind}.json`,
    `${JSON.stringify({
      ...observed,
      kind,
      producer_attempt: producerAttempt,
      origin,
      executor,
      expanded_bytes: parsed.entries.reduce((total, entry) => total + entry.bytes, 0),
      files: parsed.entries.map((entry) => entry.name),
      authority: "none",
    })}\n`,
    { flag: "wx" },
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [kind, id, directory, attempt] = process.argv.slice(2);
  if (
    !kind ||
    ![
      "unsigned",
      "signed",
      "candidate-executable",
      "acceptance",
      "public-predecessor",
      "public-acceptance",
    ].includes(kind) ||
    !id ||
    !/^[1-9][0-9]{0,15}$/u.test(id) ||
    !directory ||
    !attempt ||
    !/^[1-9][0-9]{0,5}$/u.test(attempt)
  )
    throw new Error(
      "expected fixed transfer kind, opaque artifact ID, new directory and producer attempt",
    );
  await receiveRehearsalArtifact(kind as RehearsalTransfer, Number(id), directory, Number(attempt));
}
