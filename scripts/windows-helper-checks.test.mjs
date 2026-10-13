import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildValidationPlan } from "./validation-plan.mjs";
import { windowsHelperChecksRequired } from "./windows-helper-checks.mjs";
import { evaluateCiResults } from "./ci-result-gate.mjs";

const sha = (character) => character.repeat(40);
const plan = (oldPath, newPath = oldPath, status = "M") =>
  buildValidationPlan({
    changes: [
      {
        oldPath,
        newPath,
        status,
        oldMode: "100644",
        newMode: status === "D" ? "000000" : "100644",
      },
    ],
    eventName: "pull_request",
    base: sha("a"),
    mergeBase: sha("b"),
    head: sha("c"),
    checkout: sha("d"),
  });
test("Windows helper selection includes rename/delete sides and policy inputs without changing Rust selection", () => {
  for (const file of [
    "apps/desktop/scripts/native-window-discovery.ps1",
    "apps/desktop/scripts/desktop-native-confirmation.mjs",
    "apps/desktop/scripts/desktop-test.mjs",
    "scripts/frontend-command-preflight.mjs",
    "scripts/desktop-verify.mjs",
    ".github/workflows/ci.yml",
    ".config/powershell-resources.psd1",
  ]) {
    assert.equal(windowsHelperChecksRequired(plan(file)), true);
    assert.equal(windowsHelperChecksRequired(plan(file, "docs/moved-helper.md", "R100")), true);
    assert.equal(windowsHelperChecksRequired(plan("docs/moved-helper.md", file, "R100")), true);
    assert.equal(windowsHelperChecksRequired(plan(file, file, "D")), true);
  }
  for (const file of [
    "docs/README.md",
    "apps/desktop/src/App.tsx",
    "crates/portcove-core/catalog/catalog.json",
    "crates/portcove-core/src/library.rs",
  ])
    assert.equal(windowsHelperChecksRequired(plan(file)), false);
  const broad = plan("new-unknown-tool.xyz");
  assert.equal(windowsHelperChecksRequired(broad), true);
  assert(broad.groups.includes("rust"));
  assert.equal(windowsHelperChecksRequired({ ...broad, mode: "qualification" }), false);
});
test("catalog aggregate rejects absent or failed selected Windows producer", () => {
  const input = {
    classifier: "success",
    plan: plan("scripts/desktop-verify.mjs"),
    group: "catalog",
    prose: "skipped",
    fast: { fast_catalog: "success" },
    qualification: { catalog_full: "skipped" },
  };
  for (const status of [undefined, "skipped", "failure", "cancelled", "timed_out", ""])
    assert.throws(
      () =>
        evaluateCiResults({
          ...input,
          targeted: status === undefined ? {} : { windows_helpers: status },
        }),
      /windows_helpers.*expected success/,
    );
  assert.match(
    evaluateCiResults({ ...input, targeted: { windows_helpers: "success" } }),
    /Accepted fast/,
  );
  assert.throws(
    () =>
      evaluateCiResults({
        ...input,
        plan: plan("crates/portcove-core/catalog/catalog.json"),
        targeted: { windows_helpers: "success" },
      }),
    /expected skipped/,
  );
});
test("workflow runs bounded Windows controls and pinned lint under the existing catalog aggregate", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const job = workflow.split("\n  windows_helpers:\n")[1].split("\n  fast_catalog:")[0];
  assert.match(job, /runs-on: windows-latest/);
  assert.match(job, /timeout-minutes: 10/);
  assert.match(job, /outputs.windows_helpers == 'true'/);
  assert.match(job, /--test-timeout=30000/);
  assert.match(job, /--test-concurrency=1/);
  assert.match(job, /native-confirmation.test.mjs/);
  assert.match(job, /native-helper-dependencies.mjs/);
  assert.match(job, /Import-PowerShellDataFile -LiteralPath .config\/powershell-resources.psd1/);
  assert.match(job, /Import-Module -Name PSScriptAnalyzer -RequiredVersion/);
  assert.match(job, /lint-tools.integration.mjs psscriptanalyzer/);
  assert.doesNotMatch(
    job,
    /cargo|setup-rust|desktop-verify.mjs|desktop:build|bootstrap.*Desktop|native-driver/,
  );
  const catalog = workflow.split("\n  catalog:\n")[1].split("\n  fast_dependency_review:")[0];
  assert.match(
    catalog,
    /needs: \[classify, prose_checks, fast_catalog, windows_helpers, catalog_full\]/,
  );
  assert.match(
    catalog,
    /PORTCOVE_TARGETED_RESULTS: '\{"windows_helpers":"\$\{\{ needs.windows_helpers.result \}\}"\}'/,
  );
  assert.equal((catalog.match(/PORTCOVE_TARGETED_RESULTS:/gu) ?? []).length, 1);
});
