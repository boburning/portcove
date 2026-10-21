import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "./runtime-values.mts";
import { inspectAggregateUploadExpectation } from "./release-aggregate-contract.mts";
import { inspectCapacityExecutorIdentity, capacityDigest } from "./release-capacity.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { verifyAggregateUploadBytes } from "./trusted-aggregate-attestation.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { retainControllerUpload } from "./release-controller-transport.mts";
import { releaseControlPhaseProfile } from "./release-control-phases.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const base = "repos/boburning/portcove";
function active(deadline: number) {
  const left = deadline - performance.now();
  if (!Number.isFinite(left) || left <= 0)
    throw new Error("original aggregate upload budget exhausted");
  return Math.max(1, Math.floor(Math.min(120000, left)));
}
export function readTerminalAggregateProducer(
  api: GitHubRestReader,
  rawProducer: unknown,
  deadline: number,
) {
  const producer = inspectCapacityExecutorIdentity(rawProducer);
  active(deadline);
  const response = api.request("GET", `${base}/actions/jobs/${String(producer.job_id)}`);
  active(deadline);
  const job = response.body;
  if (
    producer.role !== "aggregate-assembly" ||
    response.status !== 200 ||
    !isRecord(job) ||
    job.id !== producer.job_id ||
    String(job.run_id) !== producer.run_id ||
    job.run_attempt !== producer.run_attempt ||
    job.head_sha !== producer.controller_revision ||
    job.name !== releaseControlPhaseProfile("admission").reader_name ||
    job.status !== "completed" ||
    typeof job.conclusion !== "string" ||
    !job.conclusion ||
    job.check_run_url !==
      `https://api.github.com/repos/boburning/portcove/check-runs/${String(producer.check_run_id)}`
  )
    throw new Error("original exact admitted aggregate producer is not terminal");
  return { producer, conclusion: job.conclusion };
}
/** GET-only provider/full-byte observation. Callers still need independent
 * current controls, exact journal ownership, and terminal original-job proof. */
export async function readAdmittedAggregateUpload(
  api: GitHubRestReader,
  rawProducer: unknown,
  rawExpectation: unknown,
  assembly: unknown,
  directory: string,
  deadline: number,
  locator?: { artifact_id: number; sha256: string },
  download: typeof readGitHubArtifactArchive = readGitHubArtifactArchive,
) {
  const producer = inspectCapacityExecutorIdentity(rawProducer);
  const expectation = inspectAggregateUploadExpectation(rawExpectation);
  if (
    producer.role !== "aggregate-assembly" ||
    expectation.assembly_sha256 !== capacityDigest(assembly)
  )
    throw new Error("admitted aggregate source differs from durable upload preimage");
  const name = `trusted-release-final-${String(producer.run_id)}-${String(producer.run_attempt)}`;
  const inventory = () => {
    const found: Record<string, unknown>[] = [];
    const seen = new Set<number>();
    let count: number | undefined;
    for (let page = 1; page <= 10; page++) {
      active(deadline);
      const response = api.request(
        "GET",
        `${base}/actions/runs/${String(producer.run_id)}/artifacts?per_page=100&page=${page}`,
      );
      active(deadline);
      const body = response.body;
      if (
        response.status !== 200 ||
        !isRecord(body) ||
        !Array.isArray(body.artifacts) ||
        typeof body.total_count !== "number" ||
        !Number.isSafeInteger(body.total_count) ||
        body.total_count < 0 ||
        body.total_count >= 1000 ||
        body.artifacts.length > 100 ||
        (count !== undefined && count !== body.total_count)
      )
        throw new Error("complete aggregate artifact inventory unavailable");
      count = body.total_count;
      for (const item of body.artifacts) {
        if (
          !isRecord(item) ||
          typeof item.id !== "number" ||
          !Number.isSafeInteger(item.id) ||
          item.id < 1 ||
          seen.has(item.id)
        )
          throw new Error("duplicate aggregate artifact identity");
        seen.add(item.id);
        if (item.name === name) found.push(item);
      }
      if (body.artifacts.length < 100) {
        if (seen.size !== count || found.length !== 1)
          throw new Error("exact unique aggregate artifact unavailable; absence is ambiguous");
        return inspect(found[0]!);
      }
    }
    throw new Error("aggregate artifact coverage exhausted");
  };
  const inspect = (raw: Record<string, unknown>) => {
    if (
      raw.name !== name ||
      raw.expired !== false ||
      typeof raw.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(raw.digest) ||
      typeof raw.size_in_bytes !== "number" ||
      !Number.isSafeInteger(raw.size_in_bytes) ||
      raw.size_in_bytes < 22 ||
      raw.size_in_bytes > 512 * 1024 ** 2 ||
      !isRecord(raw.workflow_run) ||
      String(raw.workflow_run.id) !== producer.run_id ||
      raw.workflow_run.head_sha !== producer.controller_revision ||
      raw.workflow_run.repository_id !== 1354613114 ||
      raw.workflow_run.head_repository_id !== 1354613114 ||
      (locator && (raw.id !== locator.artifact_id || raw.digest !== `sha256:${locator.sha256}`))
    )
      throw new Error("aggregate artifact provider source/bytes differ");
    return { id: Number(raw.id), sha256: raw.digest.slice(7), bytes: raw.size_in_bytes, name };
  };
  const before = inventory();
  const archive = download(`${base}/actions/artifacts/${before.id}/zip`, {
    cwd: directory,
    maxBytes: before.bytes,
    timeoutMs: active(deadline),
  });
  active(deadline);
  if (archive.length !== before.bytes || hash(archive) !== before.sha256)
    throw new Error("aggregate opaque upload bytes changed");
  const files = await verifyAggregateUploadBytes(archive, assembly);
  if (
    capacityDigest(files.slice().sort((a, b) => (a.filename < b.filename ? -1 : 1))) !==
    capacityDigest(expectation.files)
  )
    throw new Error("aggregate upload differs from journal member preimage");
  const after = inventory();
  active(deadline);
  if (capacityDigest(before) !== capacityDigest(after))
    throw new Error("aggregate inventory changed during readback");
  const evidence = { producer, expectation, before, after, archive_sha256: hash(archive) };
  return {
    artifact: { id: before.id, sha256: before.sha256 },
    evidence_sha256: capacityDigest(evidence),
    evidence,
  };
}

/** Fixed Action rendezvous only after the owned capacity pending was read back.
 * The acknowledgement alone is not a completed-effect receipt. */
export async function handoffAdmittedAggregateUpload(
  root: string,
  directory: string,
  producer: unknown,
  pending: { checkpoint: string; operation_id: string },
  rawExpectation: unknown,
  deadline: number,
) {
  active(deadline);
  const expected = inspectAggregateUploadExpectation(rawExpectation);
  const identity = inspectCapacityExecutorIdentity(producer);
  if (
    identity.role !== "aggregate-assembly" ||
    !/^[a-f0-9]{40}$/u.test(pending.checkpoint) ||
    !/^[a-f0-9]{64}$/u.test(pending.operation_id)
  )
    throw new Error("owned admitted aggregate pending required");
  await writeFile(
    path.join(directory, "aggregate-ready.json"),
    JSON.stringify({
      schema_version: 1,
      name: `trusted-release-final-${String(identity.run_id)}-${String(identity.run_attempt)}`,
      pending,
      expectation: expected,
      files: expected.files.map((file) => file.filename),
    }),
    { flag: "wx", mode: 0o600 },
  );
  await retainControllerUpload(root, "admission", "aggregate", directory);
  for (;;) {
    active(deadline);
    try {
      const raw: unknown = JSON.parse(
        (
          await readControllerToolFile(path.join(directory, "aggregate-uploaded.json"), 4096)
        ).toString("utf8"),
      );
      if (
        !isRecord(raw) ||
        Object.keys(raw).sort().join(",") !== "artifact_id,sha256" ||
        typeof raw.artifact_id !== "number" ||
        !Number.isSafeInteger(raw.artifact_id) ||
        raw.artifact_id < 1 ||
        typeof raw.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(raw.sha256)
      )
        throw new Error("aggregate Action acknowledgement differs");
      active(deadline);
      return { artifact_id: raw.artifact_id, sha256: raw.sha256 };
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
    await delay(Math.min(100, active(deadline)));
  }
}
