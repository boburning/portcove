import { createHash } from "node:crypto";
import { GitHubApiError } from "./github-operation.mts";
import { isRecord } from "./runtime-values.mts";
import type { OutputMatch } from "./upstream-github-build-output.mts";

export interface N64BuildJobTarget {
  repository: string;
  repository_id: number;
  source_commit: string;
  runtime_revision: string;
  hash_revision: string;
  outputs: readonly OutputMatch[];
}

interface JobMatch {
  artifact_id: number;
  artifact_sha256: string;
  run_id: number;
  job_id: number;
  checkout_step: number;
  upload_step: number;
  checkout_log_sha256: string;
  upload_log_sha256: string;
  compile?: {
    step: number;
    log_sha256: string;
    executable: string;
  };
}

export interface N64BuildJobObservation {
  format_version: 1;
  repository_id: number;
  source_commit: string;
  runtime_revision: string;
  hash_revision: string;
  matches: JobMatch[];
  last_artifact: number | null;
}

const gitSha = /^[a-f0-9]{40}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const secretSafeRoute = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const checkoutName = /^(?:checkout|check out|run actions\/checkout@)(?:\b|$)/iu;
const uploadName =
  /^(?:(?:archive|upload|publish|package|save|store)\b|run actions\/upload-artifact@)/iu;
const executableName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const runtimeObject =
  /^lib\/N64ModernRuntime\/librecomp\/CMakeFiles\/librecomp\.dir\/src\/recomp\.cpp\.(?:o|obj)$/u;
const runtimeArchive = /^lib\/N64ModernRuntime\/librecomp\/(?:liblibrecomp\.a|librecomp\.lib)$/u;
const macBundleLink =
  /^([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\.app\/Contents\/MacOS\/\1; Performing post-build steps for macOS bundle$/u;
const checkoutGroup = /^##\[group\]Run actions\/checkout@(?:v[4-9]\d*|[a-f0-9]{40})$/u;
const uploadGroup = /^##\[group\]Run actions\/upload-artifact@(?:v[4-9]\d*|[a-f0-9]{40})$/u;
const timestampLine = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z (.*)$/u;
const sharedGitHubStops = new Set([
  "rate_limited",
  "deadline_exceeded",
  "cancelled",
  "budget",
  "credential_unavailable",
  "invalid_configuration",
  "request_refused",
]);

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const digest = (value: unknown): value is string => typeof value === "string" && sha256.test(value);

function recordedLines(bytes: Uint8Array) {
  if (bytes.byteLength < 1 || bytes.byteLength > 512 * 1024) return [];
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return [];
  }
  return text.split(/\r?\n/u).flatMap((line) => timestampLine.exec(line)?.[1] ?? []);
}

export function matchesN64BuildCheckout(bytes: Uint8Array, target: N64BuildJobTarget) {
  const lines = recordedLines(bytes);
  if (!checkoutGroup.test(lines[0] ?? "")) return false;
  const repos = lines.filter((line) => line.startsWith("Syncing repository: "));
  const commits = lines.filter((line) => gitSha.test(line));
  if (
    repos.length !== 1 ||
    repos[0] !== "Syncing repository: " + target.repository ||
    commits.length !== 1 ||
    commits[0] !== target.source_commit
  )
    return false;

  return [
    ["lib/N64ModernRuntime", target.runtime_revision],
    ["lib/N64ModernRuntime/thirdparty/xxHash", target.hash_revision],
  ].every(([path, revision]) => {
    const prefix = "Submodule path '" + path + "': checked out ";
    const checkouts = lines.filter((line) => line.startsWith(prefix));
    return checkouts.length === 1 && checkouts[0] === prefix + "'" + revision + "'";
  });
}

export function matchesN64BuildUpload(bytes: Uint8Array, output: OutputMatch) {
  const lines = recordedLines(bytes);
  if (!uploadGroup.test(lines[0] ?? "")) return false;
  const hashes = lines.filter((line) =>
    line.startsWith("SHA256 digest of uploaded artifact zip is "),
  );
  const finalized = lines.flatMap(
    (line) =>
      /^Artifact .+\.zip successfully finalized\. Artifact ID ([1-9]\d*)$/u.exec(line)?.[1] ?? [],
  );
  const uploaded = lines.filter((line) =>
    /^Artifact .+ has been successfully uploaded! Final size is [1-9]\d* bytes\. Artifact ID is [1-9]\d*$/u.test(
      line,
    ),
  );
  return (
    hashes.length === 1 &&
    hashes[0] === "SHA256 digest of uploaded artifact zip is " + output.sha256 &&
    finalized.length === 1 &&
    finalized[0] === String(output.artifact_id) &&
    uploaded.length === 1 &&
    uploaded[0]?.endsWith(
      " Final size is " + output.size + " bytes. Artifact ID is " + output.artifact_id,
    )
  );
}

/** Recognize a CMake/Ninja runtime object, static library, and final executable link. */
export function reportedN64ExecutableLink(bytes: Uint8Array): string | undefined {
  let runtimeBuilt = false;
  let runtimeArchived = false;
  let executable: string | undefined;
  for (const line of recordedLines(bytes)) {
    const action =
      /^\[[1-9]\d{0,6}\/[1-9]\d{0,6}\] (Building CXX object|Linking CXX static library|Linking CXX executable) (.+)$/u.exec(
        line,
      );
    const target = action?.[2]?.replaceAll("\\", "/");
    if (!target) continue;
    if (action?.[1] === "Building CXX object" && runtimeObject.test(target)) {
      if (runtimeBuilt) return;
      runtimeBuilt = true;
    } else if (action?.[1] === "Linking CXX static library" && runtimeArchive.test(target)) {
      if (!runtimeBuilt || runtimeArchived) return;
      runtimeArchived = true;
    } else if (action?.[1] === "Linking CXX executable" && runtimeArchived) {
      const name = executableName.test(target) ? target : macBundleLink.exec(target)?.[1];
      if (!name) continue;
      if (executable !== undefined) return;
      executable = name;
    }
  }
  return executable;
}

export function readN64BuildJobObservation(
  value: unknown,
  target: N64BuildJobTarget,
): N64BuildJobObservation | undefined {
  if (
    !isRecord(value) ||
    value.format_version !== 1 ||
    value.repository_id !== target.repository_id ||
    value.source_commit !== target.source_commit ||
    value.runtime_revision !== target.runtime_revision ||
    value.hash_revision !== target.hash_revision ||
    !Array.isArray(value.matches) ||
    value.matches.length > target.outputs.length ||
    !(value.last_artifact === null || positive(value.last_artifact))
  )
    return;

  const outputs = new Map(target.outputs.map((match) => [match.artifact_id, match]));
  const matches: JobMatch[] = [];
  for (const match of value.matches as unknown[]) {
    if (!isRecord(match) || !positive(match.artifact_id)) return;
    const output = outputs.get(match.artifact_id);
    if (
      !output ||
      match.artifact_sha256 !== output.sha256 ||
      match.run_id !== output.run_id ||
      !positive(match.job_id) ||
      !positive(match.checkout_step) ||
      !positive(match.upload_step) ||
      match.checkout_step >= match.upload_step ||
      !digest(match.checkout_log_sha256) ||
      !digest(match.upload_log_sha256)
    )
      return;
    const compile = match.compile;
    const checkedCompile =
      isRecord(compile) &&
      positive(compile.step) &&
      compile.step > match.checkout_step &&
      compile.step < match.upload_step &&
      digest(compile.log_sha256) &&
      typeof compile.executable === "string" &&
      executableName.test(compile.executable)
        ? { step: compile.step, log_sha256: compile.log_sha256, executable: compile.executable }
        : undefined;
    matches.push({
      artifact_id: match.artifact_id,
      artifact_sha256: output.sha256,
      run_id: output.run_id,
      job_id: match.job_id,
      checkout_step: match.checkout_step,
      upload_step: match.upload_step,
      checkout_log_sha256: match.checkout_log_sha256,
      upload_log_sha256: match.upload_log_sha256,
      ...(checkedCompile ? { compile: checkedCompile } : {}),
    });
    outputs.delete(match.artifact_id);
  }
  return {
    format_version: 1,
    repository_id: target.repository_id,
    source_commit: target.source_commit,
    runtime_revision: target.runtime_revision,
    hash_revision: target.hash_revision,
    matches,
    last_artifact: value.last_artifact,
  };
}

export function rebindN64BuildJobObservation(
  previous: N64BuildJobObservation | undefined,
  target: N64BuildJobTarget,
) {
  if (!previous) return;
  const artifacts = new Set(target.outputs.map((match) => match.artifact_id));
  return readN64BuildJobObservation(
    {
      ...previous,
      matches: previous.matches.filter((match) => artifacts.has(match.artifact_id)),
    },
    target,
  );
}

function matchingBuildSteps(
  value: unknown,
  target: N64BuildJobTarget,
  runId: number,
  created: number,
  retained?: JobMatch,
) {
  if (
    !isRecord(value) ||
    !Array.isArray(value.jobs) ||
    value.total_count !== value.jobs.length ||
    value.jobs.length > 100
  )
    return [];
  const candidates: { job: number; checkout: number; upload: number; compile: number[] }[] = [];
  const ids = new Set<number>();
  for (const job of value.jobs as unknown[]) {
    if (!isRecord(job) || !positive(job.id) || ids.has(job.id)) return [];
    ids.add(job.id);
    if (
      job.run_id !== runId ||
      (retained && job.id !== retained.job_id) ||
      job.run_attempt !== 1 ||
      job.head_sha !== target.source_commit ||
      job.status !== "completed" ||
      job.conclusion !== "success" ||
      !Array.isArray(job.steps) ||
      job.steps.length > 100
    )
      continue;
    const steps = job.steps.filter(
      (step): step is Record<string, unknown> & { number: number; name: string } =>
        isRecord(step) &&
        positive(step.number) &&
        step.number <= 99999 &&
        typeof step.name === "string" &&
        step.status === "completed" &&
        step.conclusion === "success",
    );
    if (new Set(steps.map((step) => step.number)).size !== steps.length) continue;
    for (const step of steps) {
      if (
        !uploadName.test(step.name) ||
        typeof step.started_at !== "string" ||
        typeof step.completed_at !== "string"
      )
        continue;
      if (
        retained
          ? step.number !== retained.upload_step
          : !(Date.parse(step.started_at) <= created && created <= Date.parse(step.completed_at))
      )
        continue;
      const checkouts = steps.filter(
        (item) => item.number < step.number && checkoutName.test(item.name),
      );
      if (checkouts.length !== 1) continue;
      const checkout = checkouts[0]!.number;
      const compile = steps
        .filter(
          (item) =>
            item.number > checkout &&
            item.number < step.number &&
            /^build(?:\b|$)/iu.test(item.name),
        )
        .map((item) => item.number)
        .sort((a, b) => b - a)
        .slice(0, 3);
      candidates.push({ job: job.id, checkout, upload: step.number, compile });
    }
  }
  // A crowded timestamp or unfamiliar workflow remains unknown within the source budget.
  return candidates.length <= 4 ? candidates : [];
}

export async function advanceN64BuildJobObservation(
  target: N64BuildJobTarget,
  previous: N64BuildJobObservation | undefined,
  read: (endpoint: string) => Promise<unknown>,
  readLog: (job: number, step: number) => Promise<Uint8Array>,
): Promise<N64BuildJobObservation> {
  if (
    !secretSafeRoute.test(target.repository) ||
    !positive(target.repository_id) ||
    [target.source_commit, target.runtime_revision, target.hash_revision].some(
      (sha) => !gitSha.test(sha),
    )
  )
    throw new Error("Exact upstream job lookup lacks repository and checkout identity");
  const state =
    readN64BuildJobObservation(previous, target) ??
    ({
      format_version: 1,
      repository_id: target.repository_id,
      source_commit: target.source_commit,
      runtime_revision: target.runtime_revision,
      hash_revision: target.hash_revision,
      matches: [],
      last_artifact: null,
    } as const);
  const known = new Set(
    state.matches.filter((entry) => entry.compile).map((entry) => entry.artifact_id),
  );
  const pending = target.outputs
    .filter((output) => !known.has(output.artifact_id))
    .sort((a, b) => a.artifact_id - b.artifact_id);
  const output =
    pending.find(
      (match) => state.last_artifact === null || match.artifact_id > state.last_artifact,
    ) ?? pending[0];
  if (!output) return state;

  const lookup = async <T,>(readOne: () => Promise<T>) => {
    try {
      return await readOne();
    } catch (error) {
      // An unreadable response is unknown for this artifact. Revisit it after
      // the other pending artifacts. Shared limits still stop the current turn.
      if (error instanceof GitHubApiError && !sharedGitHubStops.has(error.code)) return null;
      throw error;
    }
  };
  const next = { ...state, last_artifact: output.artifact_id };
  const retained = state.matches.find((match) => match.artifact_id === output.artifact_id);
  const repository = "/repos/" + target.repository;
  let created = Date.parse(output.artifact_created_at ?? "");
  if (!retained && !Number.isFinite(created)) {
    const metadata = await lookup(() =>
      read(repository + "/actions/artifacts/" + output.artifact_id),
    );
    if (metadata === null) return next;
    if (
      !isRecord(metadata) ||
      metadata.id !== output.artifact_id ||
      metadata.digest !== "sha256:" + output.sha256 ||
      metadata.size_in_bytes !== output.size ||
      !isRecord(metadata.workflow_run) ||
      metadata.workflow_run.id !== output.run_id ||
      metadata.workflow_run.repository_id !== target.repository_id ||
      metadata.workflow_run.head_repository_id !== target.repository_id ||
      metadata.workflow_run.head_sha !== target.source_commit ||
      typeof metadata.created_at !== "string"
    )
      return next;
    created = Date.parse(metadata.created_at);
    if (!Number.isFinite(created)) return next;
  }
  const run = repository + "/actions/runs/" + output.run_id;
  const jobs = await lookup(() => read(run + "/attempts/1/jobs?per_page=100"));
  if (jobs === null) return next;
  const matches = [...state.matches];
  for (const candidate of matchingBuildSteps(jobs, target, output.run_id, created, retained)) {
    if (retained) {
      if (
        candidate.job !== retained.job_id ||
        candidate.checkout !== retained.checkout_step ||
        candidate.upload !== retained.upload_step
      )
        continue;
      for (const step of candidate.compile) {
        const compile = await lookup(() => readLog(candidate.job, step));
        const executable = compile && reportedN64ExecutableLink(compile);
        if (!executable || !compile) continue;
        return {
          ...next,
          matches: matches.map((match) =>
            match === retained
              ? {
                  ...match,
                  compile: {
                    step,
                    log_sha256: createHash("sha256").update(compile).digest("hex"),
                    executable,
                  },
                }
              : match,
          ),
        };
      }
      break;
    }
    const upload = await lookup(() => readLog(candidate.job, candidate.upload));
    if (!upload || !matchesN64BuildUpload(upload, output)) continue;
    const checkout = await lookup(() => readLog(candidate.job, candidate.checkout));
    if (!checkout || !matchesN64BuildCheckout(checkout, target)) continue;
    matches.push({
      artifact_id: output.artifact_id,
      artifact_sha256: output.sha256,
      run_id: output.run_id,
      job_id: candidate.job,
      checkout_step: candidate.checkout,
      upload_step: candidate.upload,
      checkout_log_sha256: createHash("sha256").update(checkout).digest("hex"),
      upload_log_sha256: createHash("sha256").update(upload).digest("hex"),
    });
    break;
  }
  return { ...next, matches };
}
