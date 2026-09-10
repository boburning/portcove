import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  loadPackagePolicy,
  releaseLabels as policyReleaseLabels,
} from "./release-package-policy.mjs";

const releaseLabels = policyReleaseLabels(await loadPackagePolicy());

const workflow = await readFile(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const cliPackager = await readFile(
  new URL("./package-cli.ps1", import.meta.url),
  "utf8",
);
const buildSection =
  workflow.match(/^  build:\r?\n([\s\S]*?)(?=^  rehearse:)/m)?.[1] ?? "";
const rehearseSection =
  workflow.match(/^  rehearse:\r?\n([\s\S]*?)(?=^  publish:)/m)?.[1] ?? "";
const publishSection = workflow.match(/^  publish:\r?\n([\s\S]*)/m)?.[1] ?? "";

test("only the final publisher receives release write permission", () => {
  assert.match(workflow, /^permissions:\r?\n  contents: read$/m);
  assert.match(buildSection, /^    permissions:\r?\n      contents: read$/m);
  assert.equal((workflow.match(/contents: write/g) ?? []).length, 1);
  assert.match(
    rehearseSection,
    /^    permissions:\r?\n      actions: write\r?\n      contents: read$/m,
  );
  assert.match(
    publishSection,
    /^    permissions:\r?\n      actions: write\r?\n      contents: write$/m,
  );
  assert.doesNotMatch(buildSection, /GH_TOKEN|gh release|tauri-action/);
  assert.doesNotMatch(rehearseSection, /gh release/);
});

test("every builder uploads only the staged checksummed payload with short fallback retention", () => {
  for (const label of releaseLabels)
    assert.match(buildSection, new RegExp(`label: ${label}`));
  assert.match(buildSection, /name: release-build-\$\{\{ matrix\.label \}\}/);
  assert.match(buildSection, /--stage-dir release-upload/);
  assert.match(buildSection, /path: release-upload\/\*\*/);
  assert.match(buildSection, /retention-days: 1/);
  assert.doesNotMatch(buildSection, /target\/release\/bundle\/\*\*/);
  assert.doesNotMatch(buildSection, /github\.event_name/);
});

test("builders package the versioned CLI, smoke-test the archive, and request explicit Tauri bundles", () => {
  assert.match(buildSection, /scripts\/package-cli\.ps1/);
  assert.match(buildSection, /scripts\/smoke-test-cli-archive\.ps1/);
  assert.match(buildSection, /bundles: nsis/);
  assert.match(buildSection, /bundles: appimage,deb,rpm/);
  assert.equal((buildSection.match(/bundles: dmg/g) ?? []).length, 2);
  assert.match(
    buildSection,
    /pnpm tauri build --bundles "\$\{\{ matrix\.bundles \}\}"/,
  );
  assert.doesNotMatch(buildSection, /portcove-\$\{\{ matrix\.label \}\}/);
});

test("CLI packaging uses the BSD-compatible chmod form required by macOS", () => {
  assert.match(cliPackager, /& chmod \+x \$temporaryExecutable/);
  assert.doesNotMatch(cliPackager, /& chmod \+x --/);
});

test("manual rehearsal reconciles the complete matrix before deleting transient artifacts", () => {
  assert.match(
    rehearseSection,
    /^    if: github\.event_name == 'workflow_dispatch'$/m,
  );
  assert.match(rehearseSection, /^    needs: build$/m);
  assert.match(rehearseSection, /pattern: release-build-\*/);
  const reconcile = rehearseSection.indexOf("reconcile-release-assets.mjs");
  const cleanup = rehearseSection.indexOf("actions/artifacts/$artifact_id");
  assert(reconcile >= 0 && cleanup > reconcile);
});

test("publisher waits for every builder and reconciles before draft mutation", () => {
  assert.match(publishSection, /^    if: github\.event_name == 'push'$/m);
  assert.match(publishSection, /^    needs: build$/m);
  assert.match(publishSection, /pattern: release-build-\*/);
  const reconcile = publishSection.indexOf("reconcile-release-assets.mjs");
  const mutate = publishSection.indexOf("gh release");
  assert(reconcile >= 0 && mutate > reconcile);
  assert.match(publishSection, /Refusing to modify non-draft release/);
  assert.match(publishSection, /generate-release-downloads\.mjs/);
  assert.match(publishSection, /releases\/generate-notes/);
  assert.match(
    publishSection,
    /gh release create "\$RELEASE_TAG"[\s\S]*--notes-file release-metadata\/generated-release-body\.md/,
  );
  assert.match(publishSection, /Refusing to rewrite existing release notes/);
  assert.doesNotMatch(publishSection, /gh release edit/);
  assert.match(publishSection, /gh release delete-asset/);
  assert.match(publishSection, /gh release upload/);
  assert.match(publishSection, /assert_draft_release\(\)/);
  const create = publishSection.indexOf("gh release create");
  const deletion = publishSection.indexOf("gh release delete-asset");
  const upload = publishSection.indexOf("gh release upload");
  assert(create > publishSection.indexOf("generate-release-downloads.mjs"));
  assert(publishSection.lastIndexOf("assert_draft_release", deletion) > create);
  assert(publishSection.lastIndexOf("assert_draft_release", upload) > deletion);
  const cleanup = publishSection.indexOf("actions/artifacts/$artifact_id");
  assert(cleanup > publishSection.indexOf("gh release upload"));
  assert.doesNotMatch(publishSection, /releases\/latest|latest\/download/);
});
