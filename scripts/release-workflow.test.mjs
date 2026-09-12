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
const cliPackager = await readFile(new URL("./package-cli.ps1", import.meta.url), "utf8");

function job(name, next) {
  const suffix = next ? `(?=^ {2}${next}:)` : "(?![\\s\\S])";
  return workflow.match(new RegExp(`^ {2}${name}:\\r?\\n([\\s\\S]*?)${suffix}`, "m"))?.[1] ?? "";
}

const buildSection = job("build", "assemble");
const assembleSection = job("assemble", "rehearse");
const rehearseSection = job("rehearse", "attest");
const attestSection = job("attest", "publish");
const publishSection = job("publish", "cleanup");
const cleanupSection = job("cleanup");

test("write authority is split across isolated attestation publication and cleanup jobs", () => {
  assert.match(workflow, /^permissions:\r?\n {2}contents: read$/m);
  assert.match(buildSection, /^ {4}permissions:\r?\n {6}contents: read$/m);
  assert.match(assembleSection, /^ {4}permissions:\r?\n {6}contents: read$/m);
  assert.match(rehearseSection, /^ {4}permissions:\r?\n {6}contents: read$/m);
  assert.match(
    attestSection,
    /^ {4}permissions:\r?\n {6}artifact-metadata: write\r?\n {6}attestations: write\r?\n {6}contents: read\r?\n {6}id-token: write$/m,
  );
  assert.match(publishSection, /^ {4}permissions:\r?\n {6}contents: write$/m);
  assert.match(cleanupSection, /^ {4}permissions:\r?\n {6}actions: write$/m);
  assert.equal((workflow.match(/contents: write/g) ?? []).length, 1);
  assert.doesNotMatch(attestSection, /actions\/checkout|run:/);
  assert.doesNotMatch(publishSection, /actions\/checkout|setup-node|node scripts/);
});

test("every builder uploads only the staged checksummed payload with short fallback retention", () => {
  for (const label of releaseLabels) assert.match(buildSection, new RegExp(`label: ${label}`));
  assert.match(buildSection, /name: release-build-\$\{\{ matrix\.label \}\}/);
  assert.match(buildSection, /--stage-dir release-upload/);
  assert.match(buildSection, /path: release-upload\/\*\*/);
  assert.match(buildSection, /retention-days: 1/);
  assert.doesNotMatch(buildSection, /target\/release\/bundle\/\*\*/);
  assert.doesNotMatch(buildSection, /github\.event_name/);
});

test("builders package the versioned CLI smoke test it and request explicit Tauri bundles", () => {
  assert.match(buildSection, /scripts\/package-cli\.ps1/);
  assert.match(buildSection, /scripts\/smoke-test-cli-archive\.ps1/);
  assert.match(buildSection, /bundles: nsis/);
  assert.match(buildSection, /bundles: appimage,deb,rpm/);
  assert.equal((buildSection.match(/bundles: dmg/g) ?? []).length, 2);
  assert.match(buildSection, /pnpm tauri build --bundles "\$\{\{ matrix\.bundles \}\}"/);
});

test("CLI packaging uses the BSD-compatible chmod form required by macOS", () => {
  assert.match(cliPackager, /& chmod \+x \$temporaryExecutable/);
  assert.doesNotMatch(cliPackager, /& chmod \+x --/);
});

test("assembler reconciles the full matrix then generates and checksums the release SBOM", () => {
  assert.match(assembleSection, /^ {4}needs: build$/m);
  assert.match(assembleSection, /pattern: release-build-\*/);
  const reconcile = assembleSection.indexOf("reconcile-release-assets.mjs");
  const sbom = assembleSection.indexOf("anchore/sbom-action@");
  const finalize = assembleSection.indexOf("finalize-release-assets.mjs");
  const upload = assembleSection.indexOf("name: release-final");
  assert(reconcile >= 0 && sbom > reconcile && finalize > sbom && upload > finalize);
  assert.match(assembleSection, /syft-version: v1\.51\.1/);
  assert.match(assembleSection, /upload-release-assets: false/);
  assert.match(assembleSection, /Refusing to modify non-draft release/);
  assert.match(assembleSection, /Refusing to rewrite existing release notes/);
});

test("manual rehearsal verifies every finalized checksum without release write access", () => {
  assert.match(rehearseSection, /^ {4}if: github\.event_name == 'workflow_dispatch'$/m);
  assert.match(rehearseSection, /^ {4}needs: assemble$/m);
  assert.match(rehearseSection, /name: release-final/);
  assert.match(rehearseSection, /sha256sum --check --strict SHA256SUMS\.txt/);
  assert.doesNotMatch(rehearseSection, /gh release/);
});

test("tag releases attest exact final bytes and the SBOM before draft mutation", () => {
  assert.match(attestSection, /^ {4}if: github\.event_name == 'push'$/m);
  assert.match(attestSection, /^ {4}needs: assemble$/m);
  assert.equal((attestSection.match(/actions\/attest@/g) ?? []).length, 2);
  assert.match(attestSection, /subject-path: release-assets-aggregate\/\*/);
  assert.match(attestSection, /subject-checksums: release-assets-aggregate\/SHA256SUMS\.txt/);
  assert.match(attestSection, /sbom-path: release-assets-aggregate\/Portcove-SBOM\.spdx\.json/);
  assert.match(publishSection, /^ {4}needs: \[assemble, attest\]$/m);
});

test("publisher mutates drafts only from precomputed metadata and attested assets", () => {
  assert.match(publishSection, /^ {4}if: github\.event_name == 'push'$/m);
  assert.match(publishSection, /name: release-final/);
  assert.match(publishSection, /name: release-publication-metadata/);
  assert.match(publishSection, /Refusing to modify non-draft release/);
  assert.match(
    publishSection,
    /gh release create "\$RELEASE_TAG"[\s\S]*--notes-file release-metadata\/generated-release-body\.md/,
  );
  assert.doesNotMatch(publishSection, /gh release edit/);
  assert.match(publishSection, /gh release delete-asset/);
  assert.match(publishSection, /gh release upload/);
  const create = publishSection.indexOf("gh release create");
  const deletion = publishSection.indexOf("gh release delete-asset");
  const upload = publishSection.indexOf("gh release upload");
  assert(publishSection.lastIndexOf("assert_draft_release", deletion) > create);
  assert(publishSection.lastIndexOf("assert_draft_release", upload) > deletion);
  assert.doesNotMatch(publishSection, /releases\/latest|latest\/download/);
});

test("cleanup deletes transient artifacts only after successful rehearsal or publication", () => {
  assert.match(cleanupSection, /always\(\).*needs\.assemble\.result == 'success'/);
  assert.match(cleanupSection, /needs\.rehearse\.result == 'success'/);
  assert.match(cleanupSection, /needs\.publish\.result == 'success'/);
  assert.match(cleanupSection, /release-build-/);
  assert.match(cleanupSection, /release-final/);
  assert.match(cleanupSection, /release-publication-metadata/);
});
