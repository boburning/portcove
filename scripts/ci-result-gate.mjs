import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateValidationPlan } from "./validation-plan.mjs";

const scriptPath = fileURLToPath(import.meta.url);

function requireResults(results, expected, label) {
  if (!results || Object.keys(results).length === 0) throw new Error(`${label} lane plan is empty`);
  for (const [name, result] of Object.entries(results))
    if (result !== expected)
      throw new Error(`${name} was ${result || "missing"}, expected ${expected} for ${label}`);
}

export function evaluateCiResults({
  classifier,
  plan,
  group,
  prose,
  fast,
  qualification,
  always = {},
}) {
  if (classifier !== "success") throw new Error(`classifier result is ${classifier || "missing"}`);
  validateValidationPlan(plan);
  if (
    !group ||
    !["catalog", "dependency-review", "frontend", "rust", "rust-quality"].includes(group)
  )
    throw new Error(`protected group is ${group || "missing"}`);
  for (const [name, result] of Object.entries(always))
    if (result !== "success")
      throw new Error(`${name} was ${result || "missing"}, expected success in every plan`);
  const selected = plan.groups.includes(group);
  if (plan.mode === "qualification") {
    if (!selected) throw new Error(`qualification plan omitted protected group ${group}`);
    if (prose !== "skipped")
      throw new Error(`prose lane was ${prose || "missing"}, expected skipped`);
    requireResults(fast, "skipped", "qualification");
    requireResults(qualification, "success", "qualification");
  } else if (plan.mode === "fast") {
    if (prose !== "skipped")
      throw new Error(`prose lane was ${prose || "missing"}, expected skipped`);
    requireResults(qualification, "skipped", "fast");
    requireResults(fast, selected ? "success" : "skipped", "fast");
  } else if (plan.mode === "prose") {
    if (prose !== "success")
      throw new Error(`prose lane was ${prose || "missing"}, expected success`);
    requireResults(fast, "skipped", "prose");
    requireResults(qualification, "skipped", "prose");
  } else {
    throw new Error(`classifier mode is ${plan.mode || "missing"}`);
  }
  return `Accepted ${plan.mode} plan ${plan.digest} for ${group}`;
}

function main() {
  let plan, fast, qualification, always;
  try {
    plan = JSON.parse(process.env.PORTCOVE_PLAN_JSON ?? "");
    fast = JSON.parse(process.env.PORTCOVE_FAST_RESULTS ?? "");
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
      qualification,
      always,
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
