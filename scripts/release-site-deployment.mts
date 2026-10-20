import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assembleAuthenticatedApplicationSite,
  isSafeSitePath,
  readComposedSite,
} from "./release-site-composer.mts";
import { readPublicApplicationSite } from "./release-site-readback.mts";
import { createGitHubRunner, GitHubApiClient, sanitizeOperationError } from "./github-api.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { crc32, inflateRawSync } from "node:zlib";
import { isRecord } from "./runtime-values.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const block = 512;
function octal(header: Buffer, start: number, length: number, value: number) {
  const text = value.toString(8).padStart(length - 1, "0");
  if (!Number.isSafeInteger(value) || value < 0 || text.length >= length)
    throw new Error("site tar numeric field exceeds its fixed bound");
  header.write(text, start, length - 1, "ascii");
}
function header(name: string, size: number, type: "0" | "x") {
  if (Buffer.byteLength(name) > 100) throw new Error("site tar header name exceeds bound");
  const output = Buffer.alloc(block);
  output.write(name, 0, 100, "ascii");
  octal(output, 100, 8, 0o644);
  octal(output, 108, 8, 0);
  octal(output, 116, 8, 0);
  octal(output, 124, 12, size);
  octal(output, 136, 12, 0);
  output.fill(0x20, 148, 156);
  output.write(type, 156, 1, "ascii");
  output.write("ustar\0", 257, 6, "ascii");
  output.write("00", 263, 2, "ascii");
  const sum = output.reduce((total, value) => total + value, 0);
  output.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  output[154] = 0;
  output[155] = 0x20;
  return output;
}
function paxPath(name: string) {
  const body = ` path=${name}\n`;
  let size = body.length + 1;
  while (`${size}${body}`.length !== size) size = `${size}${body}`.length;
  return Buffer.from(`${size}${body}`, "ascii");
}

/** Deterministic format serialization, not admission. Every entry is a regular
 * file; there are no links, owners, executable bits, device nodes or host paths.
 * PAX is used only for a bounded ASCII long path and applies to one next file. */
export function serializeSiteTar(files: ReadonlyMap<string, Buffer>) {
  if (files.size > 6001) throw new Error("site tar entry count exceeds bound");
  const chunks: Buffer[] = [];
  let total = 1024;
  let payloadBytes = 0;
  const append = (name: string, bytes: Buffer, type: "0" | "x") => {
    const padding = (block - (bytes.length % block)) % block;
    total += block + bytes.length + padding;
    if (total > 512 * 1024 ** 2) throw new Error("site tar archive exceeds bound");
    chunks.push(header(name, bytes.length, type), bytes, Buffer.alloc(padding));
  };
  let index = 0;
  for (const [name, raw] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!isSafeSitePath(name) || !Buffer.isBuffer(raw) || raw.length > 64 * 1024 ** 2)
      throw new Error("site tar file path/bytes differ from composition contract");
    payloadBytes += raw.length;
    if (payloadBytes > 256 * 1024 ** 2) throw new Error("site tar content exceeds site bound");
    const bytes = Buffer.from(raw);
    if (name.length > 100) {
      append(`PaxHeaders/${index}`, paxPath(name), "x");
      append(`files/${index}`, bytes, "0");
    } else append(name, bytes, "0");
    index++;
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks, total);
}

interface DeploymentSession {
  readonly kind: "prepared-application-site-deployment";
}
type Composed = Awaited<ReturnType<typeof assembleAuthenticatedApplicationSite>>;
interface PrivateDeployment {
  generation: Composed["generation"];
  archive_sha256: string;
  archive_bytes: number;
  directory: string;
  upload?: {
    artifact_id: number;
    archive_sha256: string;
    evidence_scope: string;
    run_id: number;
    run_attempt: number;
    controller_revision: string;
  };
}
const sessions = new WeakMap<DeploymentSession, PrivateDeployment>();

/** Opaque artifact content verification: no untrusted tar parser or extraction
 * is needed. The only ZIP member must equal the deterministic tar created from
 * actual authenticated composition byte-for-byte. This grants no job authority. */
export function inspectSiteArtifactArchive(
  archive: Buffer,
  expected: { bytes: number; sha256: string },
) {
  if (
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes < 1024 ||
    expected.bytes > 512 * 1024 ** 2 ||
    !/^[a-f0-9]{64}$/u.test(expected.sha256)
  )
    throw new Error("site archive expected identity unavailable");
  const { entries } = inspectBoundedZip(archive, {
    compressedBytes: 512 * 1024 ** 2,
    expandedBytes: expected.bytes,
    files: 1,
    nameBytes: 32,
    allowedPaths: new Set(["artifact.tar"]),
  });
  const entry = entries[0];
  if (entries.length !== 1 || !entry || entry.bytes !== expected.bytes)
    throw new Error("site upload archive inventory differs");
  const compressed = archive.subarray(entry.data, entry.dataEnd);
  const bytes =
    entry.method === 0
      ? compressed
      : inflateRawSync(compressed, { maxOutputLength: expected.bytes });
  if (
    bytes.length !== expected.bytes ||
    crc32(bytes) !== entry.crc ||
    hash(bytes) !== expected.sha256
  )
    throw new Error("uploaded site tar differs from actual prepared composition");
  return { bytes: bytes.length, sha256: hash(bytes), authority: "none" };
}

interface SiteUploadExpected {
  artifact_id: number;
  run_id: number;
  run_attempt: number;
  controller_revision: string;
}

/** Actual opaque upload association. Provider artifact metadata binds source/run
 * and immutable ID/digest, not its producing job/attempt. The admitted fixed
 * workflow's exclusive upload route and current authenticated executor must
 * establish that additional boundary before any deployment effect. */
export async function verifyUploadedSiteArchive(
  session: DeploymentSession,
  rawExpected: SiteUploadExpected,
  options: {
    api?: Pick<GitHubApiClient, "request">;
    download?: typeof readGitHubArtifactArchive;
  } = {},
) {
  const prepared = sessions.get(session);
  if (!prepared) throw new Error("actual prepared site session unavailable");
  const expected = structuredClone(rawExpected);
  if (
    Object.keys(expected).sort().join(",") !==
      "artifact_id,controller_revision,run_attempt,run_id" ||
    ![expected.artifact_id, expected.run_id, expected.run_attempt].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    !/^[a-f0-9]{40}$/u.test(expected.controller_revision)
  )
    throw new Error("site artifact provider identity unavailable");
  const runner = createGitHubRunner({
    cwd: prepared.directory,
    timeoutMs: 15_000,
    maxBuffer: 128 * 1024,
  });
  const api =
    options.api ??
    new GitHubApiClient((args, input) => runner([...args, "--hostname", "github.com"], input));
  const endpoint = `repos/boburning/portcove/actions/artifacts/${expected.artifact_id}`;
  const identity = () => {
    const response = api.request("GET", endpoint);
    if (response.status !== 200) throw new Error("site artifact provider readback unavailable");
    const value = response.body;
    if (
      !isRecord(value) ||
      value.id !== expected.artifact_id ||
      value.name !== `application-update-site-${expected.run_id}-${expected.run_attempt}` ||
      value.expired !== false ||
      typeof value.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(value.digest) ||
      typeof value.size_in_bytes !== "number" ||
      !Number.isSafeInteger(value.size_in_bytes) ||
      value.size_in_bytes < 22 ||
      value.size_in_bytes > 512 * 1024 ** 2 ||
      !isRecord(value.workflow_run) ||
      value.workflow_run.id !== expected.run_id ||
      value.workflow_run.repository_id !== 1354613114 ||
      value.workflow_run.head_repository_id !== 1354613114 ||
      value.workflow_run.head_sha !== expected.controller_revision
    )
      throw new Error("site artifact metadata differs from the fixed upload route");
    return {
      id: expected.artifact_id,
      name: value.name,
      bytes: value.size_in_bytes,
      sha256: value.digest.slice(7),
    };
  };
  const before = identity();
  const attempt = await mkdtemp(path.join(prepared.directory, "upload-readback-"));
  await writeFile(path.join(attempt, "provider-before.json"), JSON.stringify(before), {
    flag: "wx",
    mode: 0o600,
  });
  try {
    const bytes = (options.download ?? readGitHubArtifactArchive)(`${endpoint}/zip`, {
      cwd: prepared.directory,
      maxBytes: before.bytes,
      timeoutMs: 120_000,
    });
    await writeFile(path.join(attempt, "uploaded.zip"), bytes, { flag: "wx", mode: 0o600 });
    if (bytes.length !== before.bytes || hash(bytes) !== before.sha256)
      throw new Error("site artifact provider archive bytes differ");
    inspectSiteArtifactArchive(bytes, {
      bytes: prepared.archive_bytes,
      sha256: prepared.archive_sha256,
    });
    if (JSON.stringify(before) !== JSON.stringify(identity()))
      throw new Error("site artifact changed during independent download");
    const upload = {
      artifact_id: before.id,
      archive_sha256: before.sha256,
      evidence_scope: options.api || options.download ? "injected-provider" : "github.com",
      run_id: expected.run_id,
      run_attempt: expected.run_attempt,
      controller_revision: expected.controller_revision,
    };
    if (prepared.upload && JSON.stringify(prepared.upload) !== JSON.stringify(upload))
      throw new Error("prepared site cannot switch its uploaded artifact identity");
    prepared.upload = upload;
    const receipt = {
      ...upload,
      generation: prepared.generation.generation,
      tar_sha256: prepared.archive_sha256,
      authority: "none",
      provider_scope:
        "immutable artifact/source/run association; job/attempt requires the fixed exclusive route",
    };
    await writeFile(path.join(attempt, "verification.json"), JSON.stringify(receipt), {
      flag: "wx",
      mode: 0o600,
    });
    return receipt;
  } catch (error) {
    await writeFile(
      path.join(attempt, "failure.json"),
      JSON.stringify({
        stage: "site-upload-readback",
        outcome: "refused",
        error: sanitizeOperationError(error),
        authority: "none",
      }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error(`uploaded site readback refused; retain ${attempt}`);
  }
}

/** Runs the actual public-only Rust/Tough assembly before materializing the
 * Pages archive. A self-authored marker or serialized success cannot enter this
 * session. Independent controls/executor/provider upload are separate gates. */
export async function prepareSiteDeployment(
  request: Parameters<typeof assembleAuthenticatedApplicationSite>[0],
) {
  request = structuredClone(request);
  const composed = await assembleAuthenticatedApplicationSite(request);
  if (!composed.changed) return { changed: false as const, generation: composed.generation };
  const { files } = await readComposedSite(
    composed.output,
    composed.generation.generation,
    request.trusted_root_sha256,
  );
  const archive = serializeSiteTar(files);
  const directory = await mkdtemp(path.join(request.output_parent, "site-deployment-"));
  await mkdir(path.join(directory, "upload"), { mode: 0o700 });
  const archivePath = path.join(directory, "upload", "artifact.tar");
  await writeFile(archivePath, archive, { flag: "wx", mode: 0o600 });
  const receipt = {
    generation: composed.generation,
    archive_sha256: hash(archive),
    archive_bytes: archive.length,
    directory,
  };
  await writeFile(
    path.join(directory, "preparation.json"),
    JSON.stringify({
      ...receipt,
      authority: "none",
      stage: "actual-TUF-composition-to-Pages-archive",
    }),
    { flag: "wx", mode: 0o600 },
  );
  const session: DeploymentSession = Object.freeze({
    kind: "prepared-application-site-deployment",
  });
  const retained = structuredClone(receipt);
  for (const generation of [retained.generation, receipt.generation]) {
    for (const file of generation.files) Object.freeze(file);
    Object.freeze(generation.files);
    Object.freeze(generation);
  }
  sessions.set(session, retained);
  return { changed: true as const, session, archive: archivePath, ...receipt, authority: "none" };
}

/** Public readback is necessary after provider completion. This alone cannot
 * settle a remote pending intent or establish who deployed an artifact. */
export async function readBackSiteDeployment(session: DeploymentSession) {
  const prepared = sessions.get(session);
  if (!prepared) throw new Error("imported deployment sessions cannot establish public completion");
  return readPublicApplicationSite(prepared.generation);
}
