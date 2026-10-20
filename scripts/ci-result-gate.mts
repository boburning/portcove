import type { ValidationGroup } from "./validation-plan.mts";
import { fastGroups } from "./validation-plan.mts";
import { isRecord, errorMessage } from "./runtime-values.mts";
import { validatePostmergeReuse } from "./postmerge-ci.mts";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateValidationPlan, readValidationPlanInput } from "./validation-plan.mts";
import { windowsHelperChecksRequired } from "./windows-helper-checks.mts";

const scriptPath = fileURLToPath(import.meta.url);

type CiResults = Readonly<Record<string, string | undefined>>;
interface FailedProducer {
  name: string;
  result: string;
}
type ResultGateError = Error & { failedProducer?: FailedProducer };
export interface CiResultInputs {
  classifier?: string | undefined;
  plan: unknown;
  group?: string | undefined;
  prose?: string | undefined;
  fast: unknown;
  targeted?: unknown;
  qualification: unknown;
  always?: unknown;
  reuse?: unknown;
}
function isGroup(value: unknown): value is ValidationGroup {
  return fastGroups.some((group) => group === value);
}
function isResults(value: unknown): value is CiResults {
  return (
    isRecord(value) &&
    Object.values(value).every((result) => typeof result === "string" || result === undefined)
  );
}
function optionalResults(value: unknown, label: string): CiResults | null | undefined {
  if (value === null || value === undefined) return value;
  if (!isResults(value)) throw new Error(`${label} lane results must be a job-result map`);
  return value;
}
function checkedResults(value: unknown): CiResults {
  if (!isResults(value)) throw new Error("lane results must be a job-result map");
  return value;
}

function resultFailure(
  message: string,
  producer: string,
  result: string | undefined,
  expected = "success",
) {
  const error: ResultGateError = new Error(message);
  if (
    expected === "success" &&
    ["failure", "timed_out", "cancelled", "startup_failure"].some((failed) => failed === result)
  )
    error.failedProducer = { name: producer, result: String(result) };
  return error;
}

export function formatResultGateFailure(error: unknown) {
  const producer = isRecord(error) ? error.failedProducer : undefined;
  return isRecord(producer) &&
    typeof producer.name === "string" &&
    typeof producer.result === "string"
    ? `Dependent aggregate failure: producer ${producer.name} was ${producer.result}; cause unknown/unclassified.\n${errorMessage(error)}`
    : `Aggregate contract failure (unknown/unclassified): ${errorMessage(error)}`;
}

function requireResults(results: CiResults | null | undefined, expected: string, label: string) {
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
  plan: input,
  group,
  prose,
  fast: fastInput,
  targeted: targetedInput,
  qualification: qualificationInput,
  always: alwaysInput = {},
  reuse: reuseInput = null,
}: CiResultInputs) {
  if (classifier !== "success")
    throw resultFailure(`classifier result is ${classifier || "missing"}`, "classify", classifier);
  const plan = validateValidationPlan(input);
  if (!isGroup(group)) throw new Error(`protected group is ${group || "missing"}`);
  const fast = optionalResults(fastInput, "fast");
  const targeted = optionalResults(targetedInput, "targeted");
  const qualification = optionalResults(qualificationInput, "qualification");
  const always = checkedResults(alwaysInput);
  const reuse = reuseInput == null ? null : validatePostmergeReuse(reuseInput, plan);
  for (const [name, result] of Object.entries(always))
    if (result !== "success")
      throw resultFailure(
        `${name} was ${result || "missing"}, expected success in every plan`,
        name,
        result,
      );
  const selected = plan.groups.includes(group);
  const reused = reuse !== null && reuse.groups.includes(group);
  const targetsAffectedPlatform = group === "catalog" && windowsHelperChecksRequired(plan);
  if (targetsAffectedPlatform && targeted?.windows_helpers !== "success")
    throw resultFailure(
      `windows_helpers was ${targeted?.windows_helpers ?? "missing"}, expected success for affected Windows helpers`,
      "windows_helpers",
      targeted?.windows_helpers,
    );
  if (plan.mode === "qualification") {
    if (!selected) throw new Error(`qualification plan omitted protected group ${group}`);
    if (prose !== "skipped")
      throw new Error(`prose lane was ${prose || "missing"}, expected skipped`);
    requireResults(fast, "skipped", "qualification");
    if (Object.keys(targeted ?? {}).length)
      requireResults(targeted, "skipped", "qualification targeted-platform");
    if (plan.release_profile === "initial-beta-win-linux" && group === "rust") {
      const required = [
        "intel_build",
        "intel_tests",
        "native_rust",
        "rust_clippy",
        "rust_docs",
        "rust_tests",
        "rust_workspace_tests",
        "windows_storage",
      ].sort();
      if (
        !qualification ||
        JSON.stringify(Object.keys(qualification).sort()) !== JSON.stringify(required)
      )
        throw new Error("release qualification requires every applicable Rust producer result");
      for (const [name, result] of Object.entries(qualification)) {
        const expected = name === "intel_build" || name === "intel_tests" ? "skipped" : "success";
        if (result !== expected)
          throw resultFailure(
            `${name} was ${result || "missing"}, expected ${expected} for release qualification`,
            name,
            result,
            expected,
          );
      }
    } else requireResults(qualification, "success", "qualification");
  } else if (plan.mode === "fast") {
    if (prose !== "skipped")
      throw new Error(`prose lane was ${prose || "missing"}, expected skipped`);
    requireResults(qualification, "skipped", "fast");
    requireResults(fast, selected && !reused ? "success" : "skipped", "fast");
    if (Object.keys(targeted ?? {}).length)
      requireResults(
        targeted,
        targetsAffectedPlatform ? "success" : "skipped",
        "fast targeted-platform",
      );
  } else if (plan.mode === "prose") {
    if (prose !== "success")
      throw resultFailure(`prose lane was ${prose || "missing"}, expected success`, "prose", prose);
    requireResults(fast, "skipped", "prose");
    if (Object.keys(targeted ?? {}).length)
      requireResults(targeted, "skipped", "prose targeted-platform");
    requireResults(qualification, "skipped", "prose");
  } else {
    throw new Error(`classifier mode is ${plan.mode || "missing"}`);
  }
  return `Accepted ${plan.mode} plan ${plan.digest} for ${group}${reused ? `; reused CI ${reuse.run}/a${reuse.attempt} tree ${reuse.tree}` : "; executed current obligations"}`;
}

function main() {
  let plan: unknown, fast: unknown, targeted: unknown, qualification: unknown, always: unknown;
  try {
    plan = readValidationPlanInput();
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
      reuse: JSON.parse(process.env.PORTCOVE_REUSE_JSON ?? "null"),
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
