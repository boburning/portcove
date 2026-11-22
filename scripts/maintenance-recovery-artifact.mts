import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { downloadGitHubArtifactArchiveFile } from "./github-artifact-download.mts";
import { localDeveloperCredential } from "./github-cli.mts";
import { createGitHubClient, iterateGitHubPages } from "./github-client.mts";
import { MaintenanceStoreError } from "./maintenance-store.mts";
import { isRecord } from "./runtime-values.mts";

const repository = "boburning/portcove";
const prefix = `/repos/${repository}/actions`;
const archiveLimit = 128 * 1024 * 1024;
const proofLimit = 32 * 1024;
const backupEntries = ["manifest.json", "maintenance.dump"] as const;

interface RetainedArtifact {
  id: number;
  name: string;
  digest: string;
  size_in_bytes: number;
  expired: boolean;
}

function artifact(
  value: Record<string, unknown>,
): value is Record<string, unknown> & RetainedArtifact {
  return (
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    typeof value.name === "string" &&
    typeof value.digest === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(value.digest) &&
    typeof value.size_in_bytes === "number" &&
    Number.isSafeInteger(value.size_in_bytes) &&
    typeof value.expired === "boolean"
  );
}

function readEntries(archive: Buffer, names: readonly string[], limit: number) {
  const { entries } = inspectBoundedZip(archive, {
    compressedBytes: limit,
    expandedBytes: limit,
    files: names.length,
    nameBytes: 128,
    allowedPaths: new Set(names),
  });
  if (entries.length !== names.length)
    throw new MaintenanceStoreError("Recovery artifact inventory does not match its contract");
  return new Map(
    entries.map((entry) => {
      const compressed = archive.subarray(entry.data, entry.dataEnd);
      const bytes =
        entry.method === 0
          ? compressed
          : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.bytes) });
      if (entry.bytes !== bytes.length || entry.crc !== crc32(bytes))
        throw new MaintenanceStoreError("Recovery artifact entry failed integrity verification");
      return [entry.name, bytes];
    }),
  );
}

async function selectBackup(destination: string) {
  const deadline = performance.now() + 180_000;
  const credential = localDeveloperCredential({ deadline });
  const runPath = `${prefix}/workflows/maintenance-inventory.yml/runs`;
  let requests = 0;
  const client = await createGitHubClient({
    credential,
    deadline,
    maxBytes: 4 * 1024 * 1024,
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    allowRequest: (method, url) =>
      method === "GET" &&
      (url.pathname === runPath ||
        /^\/repos\/boburning\/portcove\/actions\/runs\/[1-9][0-9]*\/artifacts$/u.test(
          url.pathname,
        )),
    reserve() {
      if (++requests > 100)
        throw new MaintenanceStoreError("Recovery candidate search exceeded its request budget");
      return { consumeBytes() {}, settle() {} };
    },
  });
  async function list(url: string, key: "workflow_runs" | "artifacts") {
    let expected: number | undefined;
    const rows = new Map<number, Record<string, unknown>>();
    for await (const page of iterateGitHubPages(client, { url: `https://api.github.com${url}` })) {
      const body: unknown = page.data;
      if (
        !isRecord(body) ||
        typeof body.total_count !== "number" ||
        !Number.isSafeInteger(body.total_count) ||
        body.total_count < 0 ||
        body.total_count >= 1000 ||
        (expected !== undefined && expected !== body.total_count)
      )
        throw new MaintenanceStoreError("Retained recovery inventory count is incomplete");
      expected = body.total_count;
      const entries: unknown = body[key];
      if (!Array.isArray(entries))
        throw new MaintenanceStoreError("Recovery artifact inventory payload is missing");
      for (const entry of entries as unknown[]) {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "number" ||
          !Number.isSafeInteger(entry.id) ||
          entry.id < 1 ||
          rows.has(entry.id)
        )
          throw new MaintenanceStoreError(
            "Recovery inventory contains duplicate or invalid identities",
          );
        rows.set(entry.id, entry);
      }
    }
    if (rows.size !== expected)
      throw new MaintenanceStoreError("Retained recovery inventory is incomplete");
    return [...rows];
  }
  const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const runs = await list(
    `${runPath}?branch=main&status=completed&created=%3E%3D${from}&per_page=100`,
    "workflow_runs",
  );
  const suitable = runs.flatMap(([id, run]) =>
    run.head_branch === "main" &&
    run.status === "completed" &&
    typeof run.created_at === "string" &&
    Number.isFinite(Date.parse(run.created_at)) &&
    typeof run.display_title === "string" &&
    /^Maintenance inventory(?: \/ (?:schedule|recover|recovery-full))?$/u.test(run.display_title)
      ? [{ id, created: Date.parse(run.created_at) }]
      : [],
  );
  suitable.sort((left, right) => right.created - left.created);
  mkdirSync(destination, { recursive: true });
  for (const { id: run } of suitable) {
    const all = await list(`${prefix}/runs/${run}/artifacts?per_page=100`, "artifacts");
    const available = new Map<string, RetainedArtifact>();
    for (const [, entry] of all) {
      if (typeof entry.name !== "string")
        throw new MaintenanceStoreError("Recovery artifact inventory has an unnamed entry");
      if (!/^maintenance-(?:backup|restore-proof)-/u.test(entry.name) || entry.expired === true)
        continue;
      if (!artifact(entry) || available.has(entry.name))
        throw new MaintenanceStoreError(
          "Retained recovery artifact metadata is incomplete or ambiguous",
        );
      available.set(entry.name, entry);
    }
    const matching = [...available.values()]
      .flatMap((entry) => {
        const match = new RegExp(`^maintenance-restore-proof-${run}-([1-9][0-9]*)$`, "u").exec(
          entry.name,
        );
        const attempt = Number(match?.[1]);
        return Number.isSafeInteger(attempt) && attempt > 0 ? [{ entry, attempt }] : [];
      })
      .sort((left, right) => right.attempt - left.attempt);
    for (const { entry: proof, attempt } of matching) {
      const backup = available.get(`maintenance-backup-${run}-${attempt}`);
      if (!backup) continue;
      const staging = mkdtempSync(path.join(destination, ".download-"));
      try {
        const download = async (entry: RetainedArtifact, limit: number) => {
          if (entry.size_in_bytes < 22 || entry.size_in_bytes > limit)
            throw new MaintenanceStoreError("Recovery artifact is outside its byte allowance");
          const file = path.join(staging, `${entry.id}.zip`);
          await downloadGitHubArtifactArchiveFile(
            `repos/${repository}/actions/artifacts/${entry.id}/zip`,
            file,
            {
              credential,
              deadline: Math.min(deadline, performance.now() + 115_000),
              maxBytes: entry.size_in_bytes,
            },
          );
          const archive = readFileSync(file);
          const digest = createHash("sha256").update(archive).digest("hex");
          if (`sha256:${digest}` !== entry.digest)
            throw new MaintenanceStoreError("Recovery artifact differs from its GitHub digest");
          return archive;
        };
        const proofEntries = readEntries(
          await download(proof, proofLimit),
          ["evidence.json", "restore.json", "server.json"],
          proofLimit,
        );
        const verification: unknown = JSON.parse(
          proofEntries.get("evidence.json")!.toString("utf8"),
        );
        if (
          !isRecord(verification) ||
          verification.verified !== true ||
          verification.tables_match_manifest !== true ||
          !isRecord(verification.run) ||
          verification.run.id !== run ||
          verification.run.attempt !== attempt ||
          typeof verification.dump_sha256 !== "string" ||
          verification.manifest_dump_sha256 !== verification.dump_sha256
        )
          continue;
        const files = readEntries(
          await download(backup, archiveLimit),
          backupEntries,
          archiveLimit,
        );
        const manifest: unknown = JSON.parse(files.get("manifest.json")!.toString("utf8"));
        const actual = createHash("sha256").update(files.get("maintenance.dump")!).digest("hex");
        if (
          !isRecord(manifest) ||
          !isRecord(manifest.dump) ||
          manifest.dump.sha256 !== actual ||
          verification.dump_sha256 !== actual ||
          typeof manifest.created_at !== "string" ||
          !Number.isFinite(Date.parse(manifest.created_at)) ||
          Date.parse(manifest.created_at) > Date.now() ||
          typeof manifest.schema_version !== "number" ||
          (manifest.schema_version >= 6 && verification.sequences_verified !== true)
        )
          continue;
        const verified = path.join(staging, "verified");
        mkdirSync(verified);
        for (const [name, bytes] of files)
          writeFileSync(path.join(verified, name), bytes, { flag: "wx" });
        renameSync(verified, path.join(destination, "backup"));
        writeFileSync(
          path.join(destination, "selected.json"),
          JSON.stringify({
            created_at: manifest.created_at,
            schema_version: manifest.schema_version,
            dump_sha256: actual,
            artifact: backup.name,
            proof: proof.name,
          }) + "\n",
          { flag: "wx" },
        );
        return true;
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
  }
  return false;
}

try {
  if (!process.argv[2])
    throw new MaintenanceStoreError("Recovery artifact output directory is required");
  if (!(await selectBackup(path.resolve(process.argv[2])))) {
    console.warn("No independently verified retained recovery artifact is available");
    process.exitCode = 75;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Recovery artifact selection failed");
  process.exitCode = 76;
}
