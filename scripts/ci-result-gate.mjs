import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateValidationPlan } from "./validation-plan.mjs";

const scriptPath = fileURLToPath(import.meta.url);

function resultFailure(message, producer, result, expected = "success") {
  const error = new Error(message);
  if (
    expected === "success" &&
    ["failure", "timed_out", "cancelled", "startup_failure"].includes(result)
  )
    error.failedProducer = { name: producer, result };
  return error;
}

export function formatResultGateFailure(error) {
  const producer = error.failedProducer;
  return producer
    ? `Dependent aggregate failure: producer ${producer.name} was ${producer.result}; cause unknown/unclassified.\n${error.message}`
    : `Aggregate contract failure (unknown/unclassified): ${error.message}`;
}

function requireResults(results, expected, label) {
  if (!results || Object.keys(results).length === 0) throw new Error(`${label} lane plan is empty`);
  for (const [name, result] of Object.entries(results))
    if (result !== expected)
      throw resultFailure(
        `${name} was ${result || "missing"}, expected ${expected} for ${label}`,
        name,
        result,
        expected,
      );
}

export function evaluateCiResults({
  classifier,
  plan,
  group,
  prose,
  fast,
  targeted,
  qualification,
  always = {},
}) {
  if (classifier !== "success")
    throw resultFailure(`classifier result is ${classifier || "missing"}`, "classify", classifier);
  validateValidationPlan(plan);
  if (
    !group ||
    !["catalog", "dependency-review", "frontend", "rust", "rust-quality"].includes(group)
  )
    throw new Error(`protected group is ${group || "missing"}`);
  for (const [name, result] of Object.entries(always))
    if (result !== "success")
      throw resultFailure(
        `${name} was ${result || "missing"}, expected success in every plan`,
        name,
        result,
      );
  const selected = plan.groups.includes(group);
  const targetsAffectedPlatform = false;
  if (plan.mode === "qualification") {
    if (!selected) throw new Error(`qualification plan omitted protected group ${group}`);
    if (prose !== "skipped")
      throw new Error(`prose lane was ${prose || "missing"}, expected skipped`);
    requireResults(fast, "skipped", "qualification");
    if (Object.keys(targeted ?? {}).length)
      requireResults(targeted, "skipped", "qualification targeted-platform");
    requireResults(qualification, "success", "qualification");
  } else if (plan.mode === "fast") {
    if (prose !== "skipped")
      throw new Error(`prose lane was ${prose || "missing"}, expected skipped`);
    requireResults(qualification, "skipped", "fast");
    requireResults(fast, selected ? "success" : "skipped", "fast");
    if (Object.keys(targeted ?? {}).length)
      requireResults(
        targeted,
        targetsAffectedPlatform ? "success" : "skipped",
        "fast targeted-platform",
      );
  } else if (plan.mode === "prose") {
    if (prose !== "success")
      throw new Error(`prose lane was ${prose || "missing"}, expected success`);
    requireResults(fast, "skipped", "prose");
    if (Object.keys(targeted ?? {}).length)
      requireResults(targeted, "skipped", "prose targeted-platform");
    requireResults(qualification, "skipped", "prose");
  } else {
    throw new Error(`classifier mode is ${plan.mode || "missing"}`);
  }
  return `Accepted ${plan.mode} plan ${plan.digest} for ${group}`;
}

function main() {
  let plan, fast, targeted, qualification, always;
  try {
    plan = JSON.parse(process.env.PORTCOVE_PLAN_JSON ?? "");
    fast = JSON.parse(process.env.PORTCOVE_FAST_RESULTS ?? "");
    targeted = JSON.parse(process.env.PORTCOVE_TARGETED_RESULTS ?? "");
    qualification = JSON.parse(process.env.PORTCOVE_QUALIFICATION_RESULTS ?? "");
    always = JSON.parse(process.env.PORTCOVE_ALWAYS_RESULTS ?? "{}");
  } catch {
    throw new Error("CI result-gate inputs must be valid JSON");
  }
  console.log(
    evaluateCiResults({
      classifier: process.env.PORTCOVE_CLASSIFIER_RESULT,
      plan,
      group: process.env.PORTCOVE_GROUP,
      prose: process.env.PORTCOVE_PROSE_RESULT,
      fast,
      targeted,
      qualification,
      always,
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(formatResultGateFailure(error));
    process.exitCode = 1;
  }
}
