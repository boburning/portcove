import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { releaseLabels } from "./reconcile-release-assets.mjs";

const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const buildSection = workflow.match(/^  build:\r?\n([\s\S]*?)(?=^  publish:)/m)?.[1] ?? "";
const publishSection = workflow.match(/^  publish:\r?\n([\s\S]*)/m)?.[1] ?? "";

test("only the final publisher receives release write permission", () => {
  assert.match(workflow, /^permissions:\r?\n  contents: read$/m);
  assert.match(buildSection, /^    permissions:\r?\n      contents: read$/m);
  assert.equal((workflow.match(/contents: write/g) ?? []).length, 1);
  assert.match(publishSection, /^    permissions:\r?\n      contents: write$/m);
  assert.doesNotMatch(buildSection, /GH_TOKEN|gh release|tauri-action/);
});

test("every builder retains an identically named matrix artifact", () => {
  for (const label of releaseLabels) assert.match(buildSection, new RegExp(`label: ${label}`));
  assert.match(buildSection, /name: release-build-\$\{\{ matrix\.label \}\}/);
  assert.match(buildSection, /target\/release\/bundle\/\*\*/);
  assert.doesNotMatch(buildSection, /github\.event_name/);
});

test("publisher waits for every builder and reconciles before draft mutation", () => {
  assert.match(publishSection, /^    if: github\.event_name == 'push'$/m);
  assert.match(publishSection, /^    needs: build$/m);
  assert.match(publishSection, /pattern: release-build-\*/);
  const reconcile = publishSection.indexOf("reconcile-release-assets.mjs");
  const mutate = publishSection.indexOf("gh release");
  assert(reconcile >= 0 && mutate > reconcile);
  assert.match(publishSection, /Refusing to modify non-draft release/);
  assert.match(publishSection, /gh release delete-asset/);
  assert.match(publishSection, /gh release upload/);
});
