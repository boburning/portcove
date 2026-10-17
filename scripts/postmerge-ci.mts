import type { ValidationGroup, ValidationPlan } from "./validation-plan.mts";
import type { discoverCiPlan } from "./select-ci-plan.mts";
import { isRecord } from "./runtime-values.mts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseProvenanceArchive, validateWorkflowProvenance } from "./workflow-provenance.mts";

const repository = "boburning/portcove";
const prefix = `repos/${repository}`;
const sha = /^[a-f0-9]{40}$/u;
const groups: readonly ValidationGroup[] = ["frontend", "rust-quality"];
export interface PostmergeReuseBinding {
  format: 1;
  plan: string;
  checkout: string;
  tree: string;
  tested_checkout: string;
  source: string;
  run: number;
  attempt: number;
  groups: readonly ValidationGroup[];
}
interface PostmergeOptions {
  event?: string | undefined;
  invoke?: (command: string, args: string[], binary?: boolean) => string | Buffer;
  discoverPlan?: typeof discoverCiPlan;
}

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function postmergeEligible(plan: ValidationPlan) {
  return (
    plan.mode === "fast" &&
    !plan.fallback &&
    plan.changes.length > 0 &&
    plan.changes.every((c) =>
      [c.oldPath, c.newPath].every(
        (file) =>
          /^apps\/desktop\/(?:src|public|assets)\//u.test(file) &&
          !/(?:generated|transport-|native)/u.test(file) &&
          (/^apps\/desktop\/src\/.*\.css$/u.test(file) ||
            /\.(?:png|jpe?g|webp|gif|avif|woff2?|ttf|otf)$/u.test(file)),
      ),
    ) &&
    plan.groups.every((g) => groups.includes(g))
  );
}

function isReuseBinding(binding: unknown): binding is PostmergeReuseBinding {
  return (
    isRecord(binding) &&
    binding.format === 1 &&
    typeof binding.plan === "string" &&
    typeof binding.checkout === "string" &&
    typeof binding.tree === "string" &&
    sha.test(binding.tree) &&
    typeof binding.tested_checkout === "string" &&
    sha.test(binding.tested_checkout) &&
    typeof binding.source === "string" &&
    sha.test(binding.source) &&
    typeof binding.run === "number" &&
    Number.isSafeInteger(binding.run) &&
    binding.run > 0 &&
    typeof binding.attempt === "number" &&
    Number.isSafeInteger(binding.attempt) &&
    binding.attempt > 0 &&
    Array.isArray(binding.groups) &&
    binding.groups.length === 2 &&
    binding.groups[0] === "frontend" &&
    binding.groups[1] === "rust-quality"
  );
}

export function validatePostmergeReuse(
  binding: unknown,
  plan: ValidationPlan,
): PostmergeReuseBinding {
  if (
    !postmergeEligible(plan) ||
    !isReuseBinding(binding) ||
    binding.plan !== plan.digest ||
    binding.checkout !== plan.identities.checkout
  )
    throw new Error("Invalid postmerge reuse binding");
  return binding;
}

// One bounded lookup using existing workflow provenance, never a cross-run cache.
// Any missing proof returns normal fresh execution.
export function discoverPostmergeReuse(
  plan: ValidationPlan,
  options: PostmergeOptions = {},
): PostmergeReuseBinding | null {
  if (options.event !== "push" || !postmergeEligible(plan)) return null;
  const deadline = Date.now() + 60000;
  const invoke =
    options.invoke ??
    ((command, args, binary = false) =>
      execFileSync(command, args, {
        encoding: binary ? "buffer" : "utf8",
        timeout: Math.max(1, Math.min(15000, deadline - Date.now())),
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      }));
  const api = (route: string, binary = false): unknown => {
    if (Date.now() >= deadline) throw new Error("Reuse observation deadline");
    const result = invoke("gh", ["api", `${prefix}/${route}`], binary);
    return binary ? result : JSON.parse(String(result));
  };
  const git = (...args: string[]) => String(invoke("git", args)).trim();
  try {
    const head = plan.identities.checkout;
    const pulls = api(`commits/${head}/pulls?per_page=100`);
    if (!Array.isArray(pulls) || pulls.length >= 100) return null;
    const pullRecords: unknown[] = pulls;
    const merged = pullRecords.filter(
      (p): p is { number: number; head: { sha: string } } =>
        isRecord(p) &&
        Boolean(p.merged_at) &&
        p.merge_commit_sha === head &&
        isRecord(p.base) &&
        p.base.ref === "main" &&
        isRecord(p.base.repo) &&
        p.base.repo.full_name === repository &&
        isRecord(p.head) &&
        isRecord(p.head.repo) &&
        p.head.repo.full_name === repository &&
        typeof p.head.sha === "string" &&
        typeof p.number === "number" &&
        Number.isSafeInteger(p.number) &&
        p.number > 0,
    );
    const pull = merged[0];
    if (merged.length !== 1 || !pull) return null;
    const listed = api(
      `actions/workflows/ci.yml/runs?head_sha=${pull.head.sha}&event=pull_request&per_page=20`,
    );
    if (!isRecord(listed) || !Array.isArray(listed.workflow_runs) || !listed.workflow_runs.length)
      return null;
    const runs: unknown[] = listed.workflow_runs;
    const run = runs[0];
    if (!isRecord(run)) return null;
    if (
      typeof run.id !== "number" ||
      !Number.isSafeInteger(run.id) ||
      run.id < 1 ||
      typeof run.run_attempt !== "number" ||
      !Number.isSafeInteger(run.run_attempt) ||
      run.run_attempt < 1 ||
      typeof run.head_sha !== "string" ||
      run.head_sha !== pull.head.sha ||
      run.path !== ".github/workflows/ci.yml" ||
      run.event !== "pull_request" ||
      !isRecord(run.repository) ||
      run.repository.full_name !== repository ||
      !isRecord(run.head_repository) ||
      run.head_repository.full_name !== repository ||
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      !Array.isArray(run.pull_requests) ||
      !run.pull_requests.some((p: unknown) => isRecord(p) && p.number === pull.number)
    )
      return null;
    const runId = run.id,
      runAttempt = run.run_attempt,
      runHead = run.head_sha;
    const jobs = api(`actions/runs/${runId}/jobs?filter=latest&per_page=100`);
    if (
      !isRecord(jobs) ||
      !Array.isArray(jobs.jobs) ||
      jobs.total_count !== jobs.jobs.length ||
      jobs.jobs.length >= 100
    )
      return null;
    const jobRecords: unknown[] = jobs.jobs;
    for (const name of [
      "catalog",
      "dependency-review",
      "frontend",
      "rust",
      "rust-quality",
      "record-workflow-provenance",
      "fast-frontend (linux-x86_64)",
      "fast-rust-quality (linux-x86_64)",
    ]) {
      const matches = jobRecords.filter((j) => isRecord(j) && j.name === name);
      const job = matches[0];
      if (
        matches.length !== 1 ||
        !isRecord(job) ||
        job.head_sha !== runHead ||
        job.run_id !== runId ||
        job.run_attempt !== runAttempt ||
        job.status !== "completed" ||
        job.conclusion !== "success"
      )
        return null;
    }
    const artifacts = api(`actions/runs/${runId}/artifacts?per_page=100`);
    if (
      !isRecord(artifacts) ||
      !Array.isArray(artifacts.artifacts) ||
      artifacts.total_count !== artifacts.artifacts.length
    )
      return null;
    const artifactRecords: unknown[] = artifacts.artifacts;
    const matches = artifactRecords.filter(
      (a) => isRecord(a) && a.name === `workflow-provenance-ci-${runId}-${runAttempt}`,
    );
    if (matches.length !== 1) return null;
    const artifact = matches[0];
    if (
      !isRecord(artifact) ||
      artifact.expired ||
      typeof artifact.id !== "number" ||
      !Number.isSafeInteger(artifact.id) ||
      artifact.id < 1 ||
      typeof artifact.size_in_bytes !== "number" ||
      artifact.size_in_bytes > 1024 * 1024 ||
      typeof artifact.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest)
    )
      return null;
    const bytes = api(`actions/artifacts/${artifact.id}/zip`, true);
    if (!Buffer.isBuffer(bytes) || hash(bytes) !== artifact.digest.slice(7)) return null;
    const provenance: unknown = parseProvenanceArchive(bytes);
    validateWorkflowProvenance(provenance, {
      runId: runId,
      attempt: runAttempt,
      headSha: runHead,
      repository,
      workflow: "ci.yml",
      event: "pull_request",
    });
    if (!isReusableProvenanceObservation(provenance) || provenance.validation.mode !== "fast")
      return null;
    const checkout = provenance.checkout.sha;
    if (!sha.test(checkout)) return null;
    try {
      git("cat-file", "-e", `${checkout}^{commit}`);
    } catch {
      git("fetch", "--no-tags", "origin", checkout);
    }
    if (!options.discoverPlan) return null;
    const producerBase = git("rev-parse", `${checkout}^1`);
    const producerPlan = options.discoverPlan(
      {
        eventName: "pull_request",
        baseSha: producerBase,
        headSha: runHead,
        checkoutSha: checkout,
        proseOnlyEnabled: true,
        fastValidationEnabled: true,
      },
      (args, settings) => invoke("git", args, settings?.encoding === "buffer"),
    );
    if (
      producerPlan.digest !== provenance.validation.plan_digest ||
      JSON.stringify(producerPlan.changes) !== JSON.stringify(plan.changes) ||
      JSON.stringify(producerPlan.groups) !== JSON.stringify(plan.groups)
    )
      return null;
    const tree = git("rev-parse", `${head}^{tree}`);
    if (git("rev-parse", `${checkout}^{tree}`) !== tree) return null;
    const workflow = invoke("git", ["show", `${head}:.github/workflows/ci.yml`]);
    if (
      hash(workflow) !== provenance.workflow.content_sha256 ||
      provenance.observed.node !== process.versions.node
    )
      return null;
    const final = api(`actions/runs/${runId}`);
    if (
      !isRecord(final) ||
      final.head_sha !== runHead ||
      final.run_attempt !== runAttempt ||
      final.status !== "completed" ||
      final.conclusion !== "success"
    )
      return null;
    return validatePostmergeReuse(
      {
        format: 1,
        plan: plan.digest,
        checkout: head,
        tree,
        tested_checkout: checkout,
        source: runHead,
        run: runId,
        attempt: runAttempt,
        groups,
      },
      plan,
    );
  } catch {
    return null;
  }
}

interface ReusableProvenanceObservation {
  validation: { mode: string; plan_digest: string };
  checkout: { sha: string };
  workflow: { content_sha256: string };
  observed: { node: string };
}
// The full validator above remains the authority. Narrow the external fields
// read by this observer without projecting or asserting the archived payload.
function isReusableProvenanceObservation(value: unknown): value is ReusableProvenanceObservation {
  return (
    isRecord(value) &&
    isRecord(value.validation) &&
    typeof value.validation.mode === "string" &&
    typeof value.validation.plan_digest === "string" &&
    isRecord(value.checkout) &&
    typeof value.checkout.sha === "string" &&
    isRecord(value.workflow) &&
    typeof value.workflow.content_sha256 === "string" &&
    isRecord(value.observed) &&
    typeof value.observed.node === "string"
  );
}
