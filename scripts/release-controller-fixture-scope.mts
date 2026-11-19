import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { discoverCiPlan } from "./select-ci-plan.mts";
import type { ValidationPlan } from "./validation-plan.mts";

const listing =
  /^crates\/portcove-core\/catalog\/(?:listings\.json|ports\/[a-z0-9][a-z0-9-]*\.json)$/u;

export function catalogDataOnlyFixtureChanges(
  plan: Pick<ValidationPlan, "changes" | "discovery" | "mode">,
) {
  return (
    plan.discovery === "complete" &&
    plan.mode === "fast" &&
    plan.changes.length > 0 &&
    plan.changes.every(
      (change) =>
        change.status === "M" &&
        change.oldMode === "100644" &&
        change.newMode === "100644" &&
        change.oldPath === change.newPath &&
        listing.test(change.newPath),
    )
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const head = process.env.FIXTURE_SOURCE_SHA;
  const checkout = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const output = process.env.GITHUB_OUTPUT;
  if (!output || checkout !== head)
    throw new Error("Controller fixture scope checkout differs from the PR head");
  const plan = discoverCiPlan({
    eventName: "pull_request",
    baseSha: process.env.FIXTURE_BASE_SHA,
    headSha: head,
    checkoutSha: checkout,
    fastValidationEnabled: true,
  });
  const catalogOnly = catalogDataOnlyFixtureChanges(plan);
  if (catalogOnly) {
    const note =
      "Controller fixture skipped the native rebuild for a complete diff of regular listing and authoring JSON edits. The required catalog check still validates the data.";
    console.log(note);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, note + "\n");
  }
  appendFileSync(output, `catalog_data_only=${catalogOnly}\n`);
}
