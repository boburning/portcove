import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

export function evaluateFastHostPolicy(policy) {
  if (policy?.format_version !== 1) throw new Error("unsupported fast-host policy");
  if (!Number.isInteger(policy.minimum_comparable_heads) || policy.minimum_comparable_heads < 3)
    throw new Error("fast-host policy requires at least three comparable heads");
  if (
    typeof policy.minimum_median_improvement !== "number" ||
    policy.minimum_median_improvement < 0.2 ||
    policy.minimum_median_improvement >= 1
  )
    throw new Error("fast-host median threshold must be at least 20 percent");
  if (!Array.isArray(policy.measurements))
    throw new Error("fast-host measurements must be an array");

  const complete = policy.measurements.filter(
    (sample) =>
      /^[a-f0-9]{40}$/u.test(sample?.head ?? "") &&
      Number.isFinite(sample?.primary_seconds) &&
      sample.primary_seconds > 0 &&
      Number.isFinite(sample?.challenger_seconds) &&
      sample.challenger_seconds > 0 &&
      sample.coverage_equal === true,
  );
  const distinctHeads = new Set(complete.map((sample) => sample.head));
  if (distinctHeads.size < policy.minimum_comparable_heads)
    return {
      selected: policy.primary_host,
      decision: "retain-primary-insufficient-comparable-heads",
      comparable_heads: distinctHeads.size,
    };
  const primaryMedian = median(complete.map((sample) => sample.primary_seconds));
  const challengerMedian = median(complete.map((sample) => sample.challenger_seconds));
  const improvement = (primaryMedian - challengerMedian) / primaryMedian;
  return {
    selected:
      improvement >= policy.minimum_median_improvement
        ? policy.challenger_host
        : policy.primary_host,
    decision:
      improvement >= policy.minimum_median_improvement
        ? "switch-to-qualified-challenger"
        : "retain-primary-threshold-not-met",
    comparable_heads: distinctHeads.size,
    primary_median_seconds: primaryMedian,
    challenger_median_seconds: challengerMedian,
    improvement,
  };
}

async function main() {
  const policy = JSON.parse(
    await readFile(path.join(root, ".github", "fast-host-policy.json"), "utf8"),
  );
  const result = evaluateFastHostPolicy(policy);
  if (result.selected !== policy.primary_host && policy.decision !== result.decision)
    throw new Error("fast-host policy has not recorded the qualified switch decision");
  console.log(JSON.stringify(result));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
