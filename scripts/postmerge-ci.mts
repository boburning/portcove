import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseProvenanceArchive, validateWorkflowProvenance } from "./workflow-provenance.mts";

const repository = "boburning/portcove";
const prefix = `repos/${repository}`;
const sha = /^[a-f0-9]{40}$/u;
const groups = ["frontend", "rust-quality"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function postmergeEligible(plan) {
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

export function validatePostmergeReuse(binding, plan) {
  if (
    !postmergeEligible(plan) ||
    binding?.format !== 1 ||
    binding.plan !== plan.digest ||
    binding.checkout !== plan.identities.checkout ||
    !sha.test(binding.tree ?? "") ||
    !sha.test(binding.tested_checkout ?? "") ||
    !sha.test(binding.source ?? "") ||
    !Number.isSafeInteger(binding.run) ||
    binding.run < 1 ||
    !Number.isSafeInteger(binding.attempt) ||
    binding.attempt < 1 ||
    JSON.stringify(binding.groups) !== JSON.stringify(groups)
  )
    throw new Error("Invalid postmerge reuse binding");
  return binding;
}

// One bounded lookup using existing workflow provenance, never a cross-run cache.
// Any missing proof returns normal fresh execution.
export function discoverPostmergeReuse(plan, options = {}) {
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
  const api = (route, binary = false) => {
    if (Date.now() >= deadline) throw new Error("Reuse observation deadline");
    const result = invoke("gh", ["api", `${prefix}/${route}`], binary);
    return binary ? result : JSON.parse(result);
  };
  const git = (...args) => String(invoke("git", args)).trim();
  try {
    const head = plan.identities.checkout;
    const pulls = api(`commits/${head}/pulls?per_page=100`);
    if (!Array.isArray(pulls) || pulls.length >= 100) return null;
    const merged = pulls.filter(
      (p) =>
        p.merged_at &&
        p.merge_commit_sha === head &&
        p.base?.ref === "main" &&
        p.base.repo?.full_name === repository &&
        p.head?.repo?.full_name === repository,
    );
    if (merged.length !== 1) return null;
    const pull = merged[0];
    const listed = api(
      `actions/workflows/ci.yml/runs?head_sha=${pull.head.sha}&event=pull_request&per_page=20`,
    );
    if (!Array.isArray(listed.workflow_runs) || !listed.workflow_runs.length) return null;
    const run = listed.workflow_runs[0];
    if (
      run.head_sha !== pull.head.sha ||
      run.path !== ".github/workflows/ci.yml" ||
      run.event !== "pull_request" ||
      run.repository?.full_name !== repository ||
      run.head_repository?.full_name !== repository ||
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      !run.pull_requests?.some((p) => p.number === pull.number)
    )
      return null;
    const jobs = api(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
    if (jobs.total_count !== jobs.jobs?.length || jobs.jobs.length >= 100) return null;
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
      const matches = jobs.jobs.filter((j) => j.name === name);
      if (
        matches.length !== 1 ||
        matches[0].head_sha !== run.head_sha ||
        matches[0].run_id !== run.id ||
        matches[0].run_attempt !== run.run_attempt ||
        matches[0].status !== "completed" ||
        matches[0].conclusion !== "success"
      )
        return null;
    }
    const artifacts = api(`actions/runs/${run.id}/artifacts?per_page=100`);
    if (artifacts.total_count !== artifacts.artifacts?.length) return null;
    const matches = artifacts.artifacts.filter(
      (a) => a.name === `workflow-provenance-ci-${run.id}-${run.run_attempt}`,
    );
    if (matches.length !== 1) return null;
    const artifact = matches[0];
    if (
      artifact.expired ||
      artifact.size_in_bytes > 1024 * 1024 ||
      !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest ?? "")
    )
      return null;
    const bytes = api(`actions/artifacts/${artifact.id}/zip`, true);
    if (hash(bytes) !== artifact.digest.slice(7)) return null;
    const provenance = parseProvenanceArchive(bytes);
    validateWorkflowProvenance(provenance, {
      runId: run.id,
      attempt: run.run_attempt,
      headSha: run.head_sha,
      repository,
      workflow: "ci.yml",
      event: "pull_request",
    });
    if (provenance.validation.mode !== "fast") return null;
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
        headSha: run.head_sha,
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
    const final = api(`actions/runs/${run.id}`);
    if (
      final.head_sha !== run.head_sha ||
      final.run_attempt !== run.run_attempt ||
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
        source: run.head_sha,
        run: run.id,
        attempt: run.run_attempt,
        groups,
      },
      plan,
    );
  } catch {
    return null;
  }
}
