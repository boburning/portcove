import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildValidationPlan } from "./validation-plan.mts";
import {
  windowsHelperChecksRequired,
  windowsNativeToolsRequired,
} from "./windows-helper-checks.mts";
import { evaluateCiResults } from "./ci-result-gate.mts";

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
test("native tool inputs retain affected Windows proof without frontend installation", () => {
  for (const file of [
    "apps/desktop/src/cli-command.ts",
    "crates/portcove-core/src/testdata/host_tool_probe.rs.txt",
    "apps/desktop/scripts/desktop-install-fixture.native.test.mts",
    "apps/desktop/scripts/cli-command-shell.native.test.mts",
    "scripts/dev-storage.mts",
    "scripts/tool-cache.mts",
  ]) {
    for (const selected of [
      plan(file),
      plan(file, "docs/moved.md", "R100"),
      plan(file, file, "D"),
    ]) {
      assert.equal(windowsNativeToolsRequired(selected), true, file);
      assert.equal(windowsHelperChecksRequired(selected), true, file);
    }
  }
  assert.equal(windowsNativeToolsRequired(plan("apps/desktop/src/App.tsx")), false);
  assert.equal(
    windowsNativeToolsRequired({ ...plan("apps/desktop/src/App.tsx"), mode: "qualification" }),
    true,
  );
});

test("Windows helper selection includes rename/delete sides and policy inputs without changing Rust selection", () => {
  for (const file of [
    "apps/desktop/scripts/native-window-discovery.ps1",
    "apps/desktop/scripts/desktop-native-confirmation.mts",
    "apps/desktop/scripts/desktop-test.mts",
    "scripts/frontend-command-preflight.mts",
    "scripts/viteplus-cli.mts",
    "scripts/desktop-verify.mts",
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
    plan: plan("scripts/desktop-verify.mts"),
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
  assert.match(job, /native-confirmation.test.mts/);
  assert.match(job, /native-helper-dependencies.mts/);
  assert.match(job, /Import-PowerShellDataFile -LiteralPath .config\/powershell-resources.psd1/);
  assert.match(job, /Import-Module -Name PSScriptAnalyzer -RequiredVersion/);
  assert.match(job, /lint-tools.integration.mts psscriptanalyzer/);
  assert.doesNotMatch(
    job,
    /cargo (?:build|test)|desktop-verify.mts|desktop:build|bootstrap.*Desktop|native-driver|setup-vp|pnpm install/,
  );
  assert.match(
    job,
    /uses: \.\/\.github\/actions\/setup-rust\n\s+if: needs.classify.outputs.native_tools == 'true'/,
  );
  assert.match(
    job,
    /node --test --test-timeout=30000 apps\/desktop\/scripts\/\*\.native\.test\.mjs/,
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
