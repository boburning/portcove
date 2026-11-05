/** Bounded native provider I/O shared by the fixed release jobs. No scheduling,
 * state authority, credential selection or execution grant lives here. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";
import { releasePathContains } from "./release-path-safety.mts";
import { readOnlyReleaseChildEnvironment } from "./release-readonly-child-environment.mts";
export const applicationRepository = "repos/boburning/portcove";
export const applicationApi = new GitHubApiClient(
  createGitHubRunner({ timeoutMs: 30000, maxBuffer: 8 * 1024 ** 2 }),
);
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const applicationGet = (suffix: string) => {
  const response = applicationApi.request("GET", `${applicationRepository}/${suffix}`);
  assert.equal(response.status, 200);
  return response.body;
};
export async function writeApplicationJson(filename: string, value: unknown) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
}
export async function readApplicationJson(
  filename: string,
  maximum = 1024 * 1024,
): Promise<unknown> {
  const { readBoundedPublicBuildInputFile } = await import("./release-public-build-inputs.mts");
  const bytes = await readBoundedPublicBuildInputFile(
    path.dirname(filename),
    path.basename(filename),
    maximum,
  );
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export async function applicationOutput(name: string, value: string | number | boolean) {
  assert.match(name, /^[a-z_]+$/u);
  assert.ok(!/[\r\n\0]/u.test(String(value)) && String(value).length <= 65536);
  assert.ok(process.env.GITHUB_OUTPUT);
  await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
export function applicationGh(args: string[]) {
  return execFileSync("gh", args, {
    env: readOnlyReleaseChildEnvironment(),
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 2 * 1024 ** 2,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
export async function receiveApplicationData(
  directory: string,
  expected: {
    id: number;
    name: string;
    run_id: string;
    source: string;
    files: readonly string[];
    maximum_file_bytes?: number;
    maximum_archive_bytes?: number;
    retain_archive?: string;
  },
) {
  assert.ok(Number.isSafeInteger(expected.id) && expected.id > 0);
  assert.match(expected.source, /^[a-f0-9]{40}$/u);
  assert.match(expected.run_id, /^[1-9][0-9]{0,15}$/u);
  assert.ok(Number.isSafeInteger(Number(expected.run_id)));
  assert.ok(
    expected.files.length > 0 &&
      expected.files.length <= 64 &&
      expected.files.every((name) => name.length <= 256) &&
      new Set(expected.files).size === expected.files.length,
  );
  const maximum = expected.maximum_archive_bytes ?? 512 * 1024 ** 2;
  assert.ok(maximum > 0 && maximum <= 512 * 1024 ** 2);
  const metadata = applicationGet(`actions/artifacts/${expected.id}`);
  assert.ok(
    isRecord(metadata) &&
      metadata.expired === false &&
      metadata.id === expected.id &&
      metadata.name === expected.name,
  );
  assert.ok(
    Number.isSafeInteger(metadata.size_in_bytes) &&
      Number(metadata.size_in_bytes) >= 22 &&
      Number(metadata.size_in_bytes) <= maximum,
  );
  assert.ok(typeof metadata.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(metadata.digest));
  assert.ok(
    isRecord(metadata.workflow_run) &&
      metadata.workflow_run.id === Number(expected.run_id) &&
      metadata.workflow_run.head_sha === expected.source &&
      metadata.workflow_run.repository_id === 1354613114,
  );
  const archive = readGitHubArtifactArchive(
    `${applicationRepository}/actions/artifacts/${expected.id}/zip`,
    { cwd: process.cwd(), maxBytes: maximum, timeoutMs: 120000 },
  );
  assert.equal(archive.length, metadata.size_in_bytes);
  assert.equal(sha256(archive), metadata.digest.slice(7));
  const parsed = inspectBoundedZip(
    archive,
    {
      compressedBytes: maximum,
      expandedBytes: 2 * 1024 ** 3,
      files: expected.files.length,
      nameBytes: 256,
      allowedPaths: new Set(expected.files),
    },
    { deadline: Date.now() + 30000 },
  );
  assert.equal(parsed.entries.length, expected.files.length);
  for (const entry of parsed.entries)
    assert.ok(entry.bytes >= 0 && entry.bytes <= (expected.maximum_file_bytes ?? 512 * 1024 ** 2));
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory, { recursive: false });
  for (const entry of parsed.entries) {
    const compressed = archive.subarray(entry.data, entry.dataEnd);
    const bytes =
      entry.method === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.bytes) });
    assert.equal(bytes.length, entry.bytes);
    assert.equal(crc32(bytes), entry.crc);
    const destination = path.join(directory, entry.name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  }
  if (expected.retain_archive) {
    assert.ok(path.isAbsolute(expected.retain_archive));
    assert.ok(
      !releasePathContains(directory, expected.retain_archive),
      "archive must remain outside the extracted input tree",
    );
    await mkdir(path.dirname(expected.retain_archive), { recursive: true });
    await writeFile(expected.retain_archive, archive, { flag: "wx", mode: 0o600 });
  }
  return { id: expected.id, bytes: archive.length, sha256: metadata.digest.slice(7) };
}
export async function applicationFileIdentity(filename: string) {
  const bytes = await readFile(filename);
  return { filename: path.basename(filename), bytes: bytes.length, sha256: sha256(bytes) };
}
