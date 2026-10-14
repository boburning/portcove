import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileIdentity } from "./development-evidence.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = (value) => /^[a-f0-9]{40}$/u.test(value ?? "");
const outcomes = new Set(["passed", "failed", "skipped", "unsupported", "not-run"]);
function requireIdentities(inputs) {
  if (
    !Array.isArray(inputs) ||
    !inputs.length ||
    inputs.some(
      (input) =>
        !/^[a-f0-9]{64}$/u.test(input.sha256 ?? "") ||
        !Number.isSafeInteger(input.bytes) ||
        input.bytes < 0 ||
        !path.isAbsolute(input.path ?? ""),
    )
  )
    throw new Error("Packet requires explicit retained/content identities");
}
function validateBindings(bindings) {
  if (
    !bindings ||
    !["source_head", "current_target", "composed_tree"].every((key) => sha(bindings[key]))
  )
    throw new Error("Packet source/target/composed-tree bindings are incomplete");
  requireIdentities(bindings.product_artifacts);
  requireIdentities(bindings.harness_inputs);
  const execution = bindings.execution_qualification;
  if (
    !bindings.build_inputs ||
    !/^[a-f0-9]{64}$/u.test(bindings.build_inputs.build_input_fingerprint ?? "") ||
    !execution?.runtime_conditions ||
    !Array.isArray(execution.fixture_identities) ||
    !execution.initial_state ||
    !Array.isArray(execution.requirements) ||
    !execution.requirements.length ||
    !Array.isArray(execution.scenarios) ||
    !execution.scenarios.length ||
    new Set(execution.scenarios).size !== execution.scenarios.length ||
    !Array.isArray(execution.acceptance_criteria) ||
    !execution.acceptance_criteria.length ||
    execution.requirements.some(
      (item) =>
        !item.id ||
        !Array.isArray(item.required_scenarios) ||
        !item.required_scenarios.length ||
        item.required_scenarios.some((id) => !execution.scenarios.includes(id)),
    )
  )
    throw new Error("Packet qualification dependencies/requirements are incomplete");
  if (execution.fixture_identities.length) requireIdentities(execution.fixture_identities);
}

export function observePacketDeliveryBindings(root, expectedHead) {
  const git = (args) => {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        "Packet source/target observation failed; refresh through the existing delivery route",
      );
    return result.stdout.trim();
  };
  if (git(["rev-parse", "HEAD"]) !== expectedHead) throw new Error("Packet source head changed");
  const remote = git(["ls-remote", "origin", "refs/heads/main"]).split(/\s+/u);
  if (remote.length !== 2 || !sha(remote[0]) || remote[1] !== "refs/heads/main")
    throw new Error("Packet current target unavailable");
  const tree = git(["merge-tree", "--write-tree", remote[0], expectedHead]);
  if (!sha(tree) || git(["rev-parse", "HEAD"]) !== expectedHead)
    throw new Error("Packet composed tree/source changed");
  return { source_head: expectedHead, current_target: remote[0], composed_tree: tree };
}

export async function writeAcceptancePreflight(
  directory,
  { root, bindings, prerequisites, reusable_evidence = [], known_gaps = [], source_review, author },
) {
  validateBindings(bindings);
  const relative = path.relative(path.resolve(root), path.resolve(directory));
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  )
    throw new Error("Runtime packets must live outside the source checkout");
  if (!Array.isArray(prerequisites) || !Array.isArray(known_gaps) || !source_review || !author)
    throw new Error("Packet preflight context is incomplete");
  const packet = {
    format_version: 1,
    stage: "preflight",
    created_at: new Date().toISOString(),
    author,
    bindings: structuredClone(bindings),
    prerequisites,
    reusable_evidence,
    known_gaps,
    source_review,
    interpretation:
      "Evidence record only; no acceptance, merge authority or permission to change its verifier",
  };
  packet.harness_identity = hash(
    bindings.harness_inputs.map(({ sha256, bytes, role }) => ({ sha256, bytes, role })),
  );
  packet.execution_qualification_identity = hash(bindings.execution_qualification);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "preflight.json");
  await writeFile(file, JSON.stringify(packet, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { packet, identity: await fileIdentity(file) };
}

// Compare effective dependencies and declared requirements, never filenames or
// source-head equality. Ambiguous/missing declarations require requalification.
export function reusableAcceptanceScenarios(previous, next) {
  try {
    validateBindings(previous.bindings);
    validateBindings(next.bindings);
  } catch {
    return {
      reusable: [],
      rerun: next.bindings?.execution_qualification?.scenarios ?? [],
      reason: "ambiguous-bindings",
    };
  }
  const previousExecution = previous.bindings.execution_qualification,
    nextExecution = next.bindings.execution_qualification;
  const products = (inputs) => inputs.map(({ role, sha256, bytes }) => ({ role, sha256, bytes }));
  const productChanged =
    hash(products(previous.bindings.product_artifacts)) !==
    hash(products(next.bindings.product_artifacts));
  const harnessChanged = previous.harness_identity !== next.harness_identity;
  const commonChanged =
    ["runtime_conditions", "initial_state"].some(
      (key) => hash(previousExecution[key]) !== hash(nextExecution[key]),
    ) ||
    hash(products(previousExecution.fixture_identities)) !==
      hash(products(nextExecution.fixture_identities));
  const reusable = [],
    rerun = [];
  for (const scenario of nextExecution.scenarios) {
    const relevant = (execution) => ({
      requirements: execution.requirements.filter((item) =>
        item.required_scenarios.includes(scenario),
      ),
      criteria: execution.acceptance_criteria.filter(
        (item) => !item.scenarios || item.scenarios.includes(scenario),
      ),
    });
    if (
      productChanged ||
      harnessChanged ||
      commonChanged ||
      hash(relevant(previousExecution)) !== hash(relevant(nextExecution)) ||
      previous.stage !== "completed" ||
      !previous.outcomes?.some((item) => item.scenario === scenario && item.outcome === "passed") ||
      !previousExecution.scenarios.includes(scenario)
    )
      rerun.push(scenario);
    else reusable.push(scenario);
  }
  return { reusable, rerun, reason: "effective-dependencies-and-requirements" };
}

async function verifyIdentity(identity) {
  const actual = await fileIdentity(identity.path, { maxBytes: identity.bytes });
  if (actual.sha256 !== identity.sha256 || actual.bytes !== identity.bytes)
    throw new Error("Packet retained artifact bytes changed");
}

export async function completeAcceptancePacket(
  preflightIdentity,
  {
    evidence_identity,
    outcomes: actualOutcomes,
    retained_artifacts,
    process_closure,
    image_inspections,
    outcome_review,
    final_delivery,
    composition_decision,
  },
) {
  await verifyIdentity(preflightIdentity);
  const preflight = JSON.parse(await readFile(preflightIdentity.path, "utf8"));
  if (preflight.format_version !== 1 || preflight.stage !== "preflight")
    throw new Error("Completion requires an actual preflight packet");
  validateBindings(preflight.bindings);
  if (
    !preflight.source_review.reviewer ||
    !preflight.source_review.reference ||
    preflight.source_review.source_head !== preflight.bindings.source_head ||
    !["passed", "failed", "unsupported"].includes(preflight.source_review.outcome)
  )
    throw new Error("Completed packet cannot retain a placeholder source review");
  await verifyIdentity(evidence_identity);
  const evidence = JSON.parse(await readFile(evidence_identity.path, "utf8"));
  const selected = preflight.bindings.execution_qualification.scenarios;
  if (evidence.revision !== preflight.bindings.source_head) {
    const reusable = preflight.reusable_evidence.find(
      (item) =>
        item.evidence?.path === evidence_identity.path &&
        item.evidence.sha256 === evidence_identity.sha256,
    );
    if (!reusable?.packet)
      throw new Error("Different source-head observations require bound reusable evidence");
    await verifyIdentity(reusable.packet);
    const prior = JSON.parse(await readFile(reusable.packet.path, "utf8"));
    if (
      prior.evidence?.sha256 !== evidence_identity.sha256 ||
      prior.bindings.source_head !== evidence.revision ||
      !prior.qualification_complete ||
      !selected.every((id) => reusableAcceptanceScenarios(prior, preflight).reusable.includes(id))
    )
      throw new Error("Effective dependencies require requalification");
  }
  if (
    !Array.isArray(actualOutcomes) ||
    actualOutcomes.length !== selected.length ||
    new Set(actualOutcomes.map((item) => item.scenario)).size !== selected.length ||
    actualOutcomes.some(
      (item) =>
        !selected.includes(item.scenario) ||
        !outcomes.has(item.outcome) ||
        !evidence.checks?.some(
          (check) => check.scenario === item.scenario && check.outcome === item.outcome,
        ),
    )
  )
    throw new Error("Actual packet outcomes do not bind selected execution");
  requireIdentities(retained_artifacts);
  for (const identity of retained_artifacts) {
    await verifyIdentity(identity);
    if (
      !evidence.artifacts?.some(
        (item) =>
          item.path === identity.path &&
          item.sha256 === identity.sha256 &&
          item.bytes === identity.bytes,
      )
    )
      throw new Error("Packet artifact was not retained by this run");
  }
  if (
    !process_closure ||
    !outcomes.has(process_closure.outcome) ||
    !Array.isArray(process_closure.artifacts) ||
    !process_closure.artifacts.length
  )
    throw new Error("Actual process closure is required");
  for (const identity of process_closure.artifacts) {
    if (
      !retained_artifacts.some(
        (item) => item.path === identity.path && item.sha256 === identity.sha256,
      )
    )
      throw new Error("Process closure is not bound to retained run evidence");
  }
  const requiredNames = preflight.bindings.execution_qualification.acceptance_criteria.flatMap(
    (item) => item.required_images ?? [],
  );
  if (
    new Set(requiredNames).size !== requiredNames.length ||
    requiredNames.some((name) => !/^[a-z0-9-]+\.png$/u.test(name))
  )
    throw new Error("Required image declarations are ambiguous");
  const images = retained_artifacts.filter(
    (item) =>
      path.extname(item.path).toLowerCase() === ".png" &&
      requiredNames.includes(path.basename(item.path)),
  );
  const missingImages = requiredNames.filter(
    (name) => !images.some((image) => path.basename(image.path) === name),
  );
  for (const image of images) {
    const receiptPath = image.path.replace(/\.png$/u, "-capture.json");
    const receiptIdentity = retained_artifacts.find((item) => item.path === receiptPath);
    if (!receiptIdentity) throw new Error("Required image has no settled capture receipt");
    const capture = JSON.parse(await readFile(receiptPath, "utf8"));
    if (
      capture.outcome !== "captured" ||
      !selected.includes(capture.scenario) ||
      capture.image?.sha256 !== image.sha256 ||
      capture.image?.bytes !== image.bytes ||
      capture.observation?.semantic?.ready !== true ||
      capture.observation.state?.visible !== true ||
      capture.observation.state?.application_state?.loading !== 0
    )
      throw new Error("Required image is diagnostic or bound to another scenario/state");
  }
  if (
    !Array.isArray(image_inspections) ||
    image_inspections.length !== images.length ||
    new Set(image_inspections.map((item) => item.path)).size !== images.length ||
    image_inspections.some(
      (item) =>
        !Number.isFinite(Date.parse(item.inspected_at)) ||
        !item.reviewer ||
        !item.findings ||
        !images.some(
          (image) =>
            image.path === item.path && image.sha256 === item.sha256 && image.bytes === item.bytes,
        ),
    )
  )
    throw new Error("Completion requires actual inspection bound to every exact retained image");
  if (
    !outcome_review?.reviewer ||
    outcome_review.reviewer === preflight.author ||
    !outcome_review.reference ||
    outcome_review.source_head !== preflight.bindings.source_head ||
    !outcomes.has(outcome_review.outcome)
  )
    throw new Error("Independent actual outcome review is required");
  if (
    !["source_head", "current_target", "composed_tree"].every((key) =>
      sha(final_delivery?.[key]),
    ) ||
    final_delivery.source_head !== preflight.bindings.source_head ||
    !final_delivery.review_reference
  )
    throw new Error("Final delivery binding/source review is incomplete");
  if (
    final_delivery.current_target !== preflight.bindings.current_target ||
    final_delivery.composed_tree !== preflight.bindings.composed_tree
  ) {
    if (
      !composition_decision?.reviewer ||
      !composition_decision.evidence ||
      !["unchanged-effective-dependencies", "affected-scenarios-requalified"].includes(
        composition_decision.outcome,
      )
    )
      throw new Error("Changed target/composition requires reviewed qualification decision");
  }
  const complete =
    !missingImages.length &&
    actualOutcomes.every((item) => item.outcome === "passed") &&
    process_closure.outcome === "passed" &&
    process_closure.positive_exit === true &&
    outcome_review.outcome === "passed" &&
    preflight.source_review.outcome === "passed" &&
    preflight.source_review.source_head === preflight.bindings.source_head &&
    !preflight.known_gaps.some((item) => item.required === true);
  const packet = {
    ...preflight,
    stage: "completed",
    completed_at: new Date().toISOString(),
    preflight: preflightIdentity,
    evidence: evidence_identity,
    execution_observation_source_head: evidence.revision,
    outcomes: actualOutcomes,
    retained_artifacts,
    process_closure,
    image_inspections,
    outcome_review,
    final_delivery,
    composition_decision: composition_decision ?? null,
    missing_required_images: missingImages,
    qualification_complete: complete,
  };
  const file = path.join(path.dirname(preflightIdentity.path), "completed.json");
  await writeFile(file, JSON.stringify(packet, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { packet, identity: await fileIdentity(file) };
}
