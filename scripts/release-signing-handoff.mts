import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { crc32, inflateRawSync } from "node:zlib";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { inspectCapacityExecutorIdentity } from "./release-capacity.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { isRecord } from "./runtime-values.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const base = "repos/boburning/portcove";
export type SigningOutputFile = { filename: string; bytes: number; sha256: string };

/** Fixed reviewed upload action owns uploaded.json; its output is only a
 * locator. Direct provider/full-byte readback below supplies the custody proof.
 * There is no POST, retry, key or candidate execution in this protocol. */
export async function handoffSigningOutput(
  directory: string,
  raw: {
    producer: unknown;
    pending: { checkpoint: string; operation_id: string };
    input_binding_sha256: string;
    files: readonly (SigningOutputFile & { path: string })[];
  },
  deadline: number,
) {
  const expected = structuredClone(raw),
    producer = inspectCapacityExecutorIdentity(expected.producer);
  const active = () => {
    if (
      !Number.isFinite(deadline) ||
      deadline <= performance.now() ||
      deadline > performance.now() + 600000
    )
      throw new Error("fixed signing output deadline exhausted");
  };
  active();
  if (
    Object.keys(expected).sort().join(",") !== "files,input_binding_sha256,pending,producer" ||
    !/^[a-f0-9]{64}$/u.test(expected.input_binding_sha256) ||
    !path.isAbsolute(directory) ||
    !/^[a-f0-9]{40}$/u.test(expected.pending.checkpoint) ||
    !/^[a-f0-9]{64}$/u.test(expected.pending.operation_id) ||
    expected.files.length < 1 ||
    expected.files.length > 7
  )
    throw new Error("fixed signing output requires the exact pending operation");
  await mkdir(directory, { mode: 0o700 });
  let phase = "prepare-public-output";
  try {
    await mkdir(path.join(directory, "output"), { mode: 0o700 });
    const files: SigningOutputFile[] = [];
    for (const file of expected.files) {
      active();
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,191}$/u.test(file.filename) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 1 ||
        file.bytes > 512 * 1024 ||
        !/^[a-f0-9]{64}$/u.test(file.sha256)
      )
        throw new Error("fixed signing output file identity differs");
      const bytes = await readControllerToolFile(file.path, file.bytes);
      if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
        throw new Error("actual signature bytes changed before upload");
      await writeFile(path.join(directory, "output", file.filename), bytes, {
        flag: "wx",
        mode: 0o600,
      });
      files.push({ filename: file.filename, bytes: file.bytes, sha256: file.sha256 });
    }
    const manifest = Buffer.from(
      JSON.stringify({
        schema_version: 1,
        producer,
        pending: expected.pending,
        input_binding_sha256: expected.input_binding_sha256,
        files,
        authority: "none",
      }),
    );
    if (manifest.length > 64 * 1024) throw new Error("signing manifest exceeds bound");
    const filename = "signing-output-manifest.json";
    await writeFile(path.join(directory, "output", filename), manifest, {
      flag: "wx",
      mode: 0o600,
    });
    files.push({ filename, bytes: manifest.length, sha256: hash(manifest) });
    const name = `trusted-${String(producer.role)}-output-${String(producer.run_id)}-${String(producer.run_attempt)}`;
    await writeFile(
      path.join(directory, "ready.json"),
      JSON.stringify({ name, manifest_sha256: hash(manifest), files }),
      { flag: "wx", mode: 0o600 },
    );
    phase = "await-fixed-upload-action";
    let uploaded: unknown;
    while (uploaded === undefined) {
      active();
      try {
        uploaded = JSON.parse(
          (await readControllerToolFile(path.join(directory, "uploaded.json"), 4096)).toString(
            "utf8",
          ),
        );
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT")
          throw new Error("signing output locator unavailable or malformed");
        await delay(100);
      }
    }
    active();
    if (
      !isRecord(uploaded) ||
      Object.keys(uploaded).sort().join(",") !== "artifact_id,sha256" ||
      typeof uploaded.artifact_id !== "number" ||
      !Number.isSafeInteger(uploaded.artifact_id) ||
      uploaded.artifact_id < 1 ||
      typeof uploaded.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(uploaded.sha256)
    )
      throw new Error("signing upload action returned an invalid locator");
    phase = "independent-provider-byte-readback";
    const result = await readSigningOutputArtifact(
      directory,
      {
        producer,
        artifact_id: uploaded.artifact_id,
        archive_sha256: uploaded.sha256,
        name,
        files,
      },
      { deadline },
    );
    active();
    if (result.evidence_scope !== "github.com")
      throw new Error("actual signing output readback required");
    return result;
  } catch {
    await writeFile(
      path.join(directory, "handoff-failure.json"),
      JSON.stringify({ phase, authority: "none" }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error(`signing handoff refused; retain owned directory ${directory}`);
  }
}
/** This is provider/byte custody, not an attestation verifier or authority
 * constructor. The caller must own an actual executor session and later bind
 * these public bytes using the existing custom-predicate attestation path. */
export async function readSigningOutputArtifact(
  directory: string,
  raw: {
    producer: unknown;
    artifact_id: number;
    archive_sha256: string;
    name: string;
    files: readonly SigningOutputFile[];
  },
  options: {
    api?: GitHubRestReader;
    download?: typeof readGitHubArtifactArchive;
    deadline?: number;
    spawn?: NonNullable<Parameters<typeof createGitHubRunner>[0]>["spawn"];
    archiveSpawn?: NonNullable<Parameters<typeof readGitHubArtifactArchive>[1]>["spawn"];
  } = {},
) {
  const expected = structuredClone(raw),
    producer = inspectCapacityExecutorIdentity(expected.producer);
  const files: readonly SigningOutputFile[] = expected.files;
  const injected =
    options.api !== undefined ||
    options.download !== undefined ||
    options.spawn !== undefined ||
    options.archiveSpawn !== undefined;
  const deadline = options.deadline,
    apiSpawn = options.spawn ?? spawnSync,
    archiveSpawn = options.archiveSpawn ?? spawnSync;
  const remaining = (maximum: number) => {
    if (deadline === undefined) return maximum;
    const value = Math.ceil(deadline - performance.now());
    if (!Number.isFinite(deadline) || value < 1 || value > 600000)
      throw new Error("signing readback total phase deadline exhausted");
    return Math.min(maximum, value);
  };
  remaining(15000);
  const apiOption = options.api ? { request: options.api.request.bind(options.api) } : undefined,
    download = options.download ?? readGitHubArtifactArchive;
  if (
    Object.keys(expected).sort().join(",") !== "archive_sha256,artifact_id,files,name,producer" ||
    !path.isAbsolute(directory) ||
    !Number.isSafeInteger(Number(producer.run_id)) ||
    ![
      "payload-signing",
      "tuf-releases",
      "tuf-preview",
      "tuf-stable",
      "tuf-snapshot",
      "tuf-timestamp",
    ].includes(String(producer.role)) ||
    !Number.isSafeInteger(expected.artifact_id) ||
    expected.artifact_id < 1 ||
    typeof expected.archive_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(expected.archive_sha256) ||
    expected.name !==
      `trusted-${String(producer.role)}-output-${String(producer.run_id)}-${String(producer.run_attempt)}` ||
    !Array.isArray(expected.files) ||
    files.length < 1 ||
    files.length > 8 ||
    new Set(files.map((file: SigningOutputFile) => file.filename)).size !== files.length ||
    files.some(
      (file: SigningOutputFile) =>
        Object.keys(file).sort().join(",") !== "bytes,filename,sha256" ||
        typeof file.filename !== "string" ||
        typeof file.sha256 !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,191}$/u.test(file.filename) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 1 ||
        file.bytes > 512 * 1024 ||
        !/^[a-f0-9]{64}$/u.test(file.sha256),
    ) ||
    files.reduce((sum: number, file: SigningOutputFile) => sum + file.bytes, 0) > 1024 * 1024
  )
    throw new Error("exact bounded signing output handoff required");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      ["PATH", "Path", "SystemRoot", "WINDIR", "GH_TOKEN"].includes(key),
    ),
  );
  Object.assign(environment, {
    HOME: directory,
    USERPROFILE: directory,
    XDG_CONFIG_HOME: directory,
    GH_CONFIG_DIR: directory,
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
  });
  const api =
    apiOption ??
    new GitHubApiClient((args, input) =>
      createGitHubRunner({
        cwd: directory,
        maxBuffer: 128 * 1024,
        timeoutMs: remaining(15000),
        spawn: (command, arguments_, settings) =>
          apiSpawn(command, arguments_, { ...settings, env: environment }),
      })([...args, "--hostname", "github.com"], input),
    );
  let phase = "provider-before";
  const get = (route: string) => {
    remaining(15000);
    const response = api.request("GET", `${base}/${route}`);
    remaining(15000);
    if (response.status !== 200) throw new Error("signing output provider read refused");
    return response.body;
  };
  const snapshot = () => {
    const run = get(
      `actions/runs/${String(producer.run_id)}/attempts/${String(producer.run_attempt)}`,
    );
    const job = get(`actions/jobs/${String(producer.job_id)}`);
    const artifact = get(`actions/artifacts/${expected.artifact_id}`);
    if (
      !isRecord(run) ||
      run.id !== Number(producer.run_id) ||
      run.run_attempt !== producer.run_attempt ||
      run.head_sha !== producer.controller_revision ||
      run.path !== productionControllerWorkflow ||
      run.event !== "workflow_dispatch" ||
      run.status !== "in_progress" ||
      run.conclusion !== null ||
      !isRecord(run.repository) ||
      run.repository.id !== 1354613114 ||
      run.repository.full_name !== "boburning/portcove" ||
      !isRecord(run.head_repository) ||
      run.head_repository.id !== 1354613114 ||
      !isRecord(job) ||
      job.id !== producer.job_id ||
      job.run_id !== Number(producer.run_id) ||
      job.run_attempt !== producer.run_attempt ||
      job.head_sha !== producer.controller_revision ||
      job.check_run_url !==
        `https://api.github.com/repos/boburning/portcove/check-runs/${String(producer.check_run_id)}` ||
      job.status !== "in_progress" ||
      job.conclusion !== null ||
      !isRecord(artifact) ||
      artifact.id !== expected.artifact_id ||
      artifact.name !== expected.name ||
      artifact.expired !== false ||
      artifact.digest !== `sha256:${expected.archive_sha256}` ||
      typeof artifact.size_in_bytes !== "number" ||
      !Number.isSafeInteger(artifact.size_in_bytes) ||
      artifact.size_in_bytes < 22 ||
      artifact.size_in_bytes > 2 * 1024 * 1024 ||
      !isRecord(artifact.workflow_run) ||
      artifact.workflow_run.id !== Number(producer.run_id) ||
      artifact.workflow_run.repository_id !== 1354613114 ||
      artifact.workflow_run.head_repository_id !== 1354613114 ||
      artifact.workflow_run.head_sha !== producer.controller_revision
    )
      throw new Error("signing output exact producer/run/attempt/artifact differs");
    return {
      run: { id: run.id, attempt: run.run_attempt, source: run.head_sha },
      job: { id: job.id, check: job.check_run_url, status: job.status },
      artifact: {
        id: artifact.id,
        bytes: artifact.size_in_bytes,
        sha256: expected.archive_sha256,
        name: artifact.name,
      },
    };
  };
  try {
    const before = snapshot();
    await writeFile(
      path.join(directory, "signing-output-provider-before.json"),
      JSON.stringify(before),
      { flag: "wx", mode: 0o600 },
    );
    phase = "opaque-output-download";
    remaining(30000);
    const archive = download(`${base}/actions/artifacts/${expected.artifact_id}/zip`, {
      cwd: directory,
      maxBytes: before.artifact.bytes,
      timeoutMs: remaining(30000),
      spawn: (command, args, settings) =>
        archiveSpawn(command, args, { ...settings, env: environment }),
    });
    remaining(15000);
    if (archive.length !== before.artifact.bytes || hash(archive) !== expected.archive_sha256)
      throw new Error("opaque signing output differs");
    await writeFile(path.join(directory, "signing-output.zip"), archive, {
      flag: "wx",
      mode: 0o600,
    });
    remaining(15000);
    phase = "complete-output-inventory";
    const entries = inspectBoundedZip(archive, {
      compressedBytes: 2 * 1024 * 1024,
      expandedBytes: 1024 * 1024,
      files: files.length,
      nameBytes: 192,
      allowedPaths: new Set(files.map((file: SigningOutputFile) => file.filename)),
    }).entries;
    if (entries.length !== files.length) throw new Error("signing output inventory incomplete");
    for (const entry of entries) {
      remaining(15000);
      const file = files.find((item: SigningOutputFile) => item.filename === entry.name);
      if (!file || entry.bytes !== file.bytes) throw new Error("signing output member differs");
      const compressed = archive.subarray(entry.data, entry.dataEnd);
      const bytes =
        entry.method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
      if (bytes.length !== file.bytes || crc32(bytes) !== entry.crc || hash(bytes) !== file.sha256)
        throw new Error("signing output member bytes differ");
      const local = await readControllerToolFile(
        path.join(directory, "output", file.filename),
        file.bytes,
      );
      remaining(15000);
      if (!bytes.equals(local)) throw new Error("local signing output changed during handoff");
    }
    phase = "provider-after";
    const after = snapshot();
    if (!isDeepStrictEqual(before, after)) throw new Error("signing output provider drifted");
    await writeFile(
      path.join(directory, "signing-output-provider-after.json"),
      JSON.stringify(after),
      { flag: "wx", mode: 0o600 },
    );
    remaining(15000);
    const result = {
      schema_version: 1,
      artifact: before.artifact,
      producer,
      files: files,
      evidence_scope: injected ? "injected-provider" : "github.com",
      authority: "none",
    };
    await writeFile(path.join(directory, "signing-output-readback.json"), JSON.stringify(result), {
      flag: "wx",
      mode: 0o600,
    });
    remaining(15000);
    return result;
  } catch {
    await writeFile(
      path.join(directory, "signing-output-failure.json"),
      JSON.stringify({ phase, authority: "none" }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error(`signing output refused; retain owned directory ${directory}`);
  }
}
