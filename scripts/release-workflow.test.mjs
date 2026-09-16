import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
const cliSmoke = await readFile(new URL("./smoke-test-cli-archive.ps1", import.meta.url), "utf8");
const macosVerifier = await readFile(
  new URL("./verify-macos-release.ps1", import.meta.url),
  "utf8",
);

function job(name, next) {
  const suffix = next ? `(?=^ {2}${next}:)` : "(?![\\s\\S])";
  return workflow.match(new RegExp(`^ {2}${name}:\\r?\\n([\\s\\S]*?)${suffix}`, "m"))?.[1] ?? "";
}

const identitySection = job("identity", "qualification");
const qualificationSection = job("qualification", "validate");
const validateSection = job("validate", "build");
const buildSection = job("build", "build_intel");
const intelBuildSection = job("build_intel", "verify_intel");
const intelSection = job("verify_intel", "release_gate");
const gateSection = job("release_gate", "assemble");
const assembleSection = job("assemble", "rehearse");
const rehearseSection = job("rehearse", "attest");
const attestSection = job("attest", "publish");
const publishSection = job("publish", "cleanup");
const cleanupSection = job("cleanup");

function inlineRunScript(section, stepName) {
  const escaped = stepName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const block = section.match(
    new RegExp(`^ {6}- name: ${escaped}\\r?\\n[\\s\\S]*?^ {8}run: \\|\\r?\\n([\\s\\S]*)`, "m"),
  )?.[1];
  assert.ok(block, `missing inline run script for ${stepName}`);
  return block
    .split(/\r?\n/u)
    .map((line) => line.replace(/^ {10}/u, ""))
    .join("\n")
    .trimEnd();
}

const publicationScript = inlineRunScript(publishSection, "Create or reconcile draft release");
// The publisher runs only on Ubuntu. Windows Git Bash process startup is both
// materially slower and a different host contract; exact hosted Linux CI runs
// this fixture against the same Bash boundary as the privileged job.
const bashExecutable = process.platform === "win32" ? undefined : "bash";

test("write authority is split across isolated attestation publication and cleanup jobs", () => {
  assert.match(workflow, /^permissions:\r?\n {2}contents: read$/m);
  assert.match(buildSection, /^ {4}permissions:\r?\n {6}contents: read$/m);
  assert.match(intelBuildSection, /^ {4}permissions:\r?\n {6}contents: read$/m);
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

test("cheap identity unlocks qualification and builds before the explicit result gate", () => {
  assert.match(identitySection, /actions\/setup-node/);
  assert.doesNotMatch(identitySection, /pnpm install|rust-toolchain|just audit/);
  assert.doesNotMatch(
    identitySection,
    /select-release-channel\.test|reconstruct-application-update-records\.test/,
  );
  assert.match(qualificationSection, /^ {4}needs: identity$/m);
  assert.match(qualificationSection, /\.\/\.github\/workflows\/qualification\.yml/);
  assert.match(qualificationSection, /qualification_caller: release/);
  assert.match(qualificationSection, /provenance_scope: release-qualification/);
  assert.match(validateSection, /^ {4}needs: \[identity, qualification\]$/m);
  assert.match(validateSection, /just audit --fresh --profile release/);
  assert.match(validateSection, /needs\.qualification\.outputs\.plan_digest/);
  assert.match(validateSection, /needs\.qualification\.outputs\.plan_json/);
  assert.match(validateSection, /PORTCOVE_EXPECTED_CHECKOUT: \$\{\{ github\.sha \}\}/);
  assert.match(validateSection, /node scripts\/validation-plan\.mjs/);
  assert.match(validateSection, /node scripts\/workflow-provenance\.mjs/);
  assert.match(
    validateSection,
    /workflow-provenance-release-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(validateSection, /retention-days: 7/);
  assert.match(buildSection, /^ {4}needs: identity$/m);
  assert.match(intelBuildSection, /^ {4}needs: identity$/m);
  assert.doesNotMatch(buildSection, /needs: validate/);
  assert.doesNotMatch(intelBuildSection, /needs: validate/);
  assert.match(gateSection, /^ {4}if: always\(\)$/m);
  assert.match(
    gateSection,
    /^ {4}needs: \[identity, qualification, validate, build, build_intel, verify_intel\]$/m,
  );
  assert.match(gateSection, /scripts\/release-result-gate\.mjs/);
  assert.match(assembleSection, /^ {4}needs: release_gate$/m);
});

test("every builder uploads only the staged checksummed payload with short fallback retention", () => {
  for (const label of releaseLabels.filter((label) => label !== "macos-x86_64"))
    assert.match(buildSection, new RegExp(`label: ${label}`));
  assert.match(intelBuildSection, /--label macos-x86_64/);
  assert.match(buildSection, /name: release-build-\$\{\{ matrix\.label \}\}/);
  assert.match(intelBuildSection, /name: release-build-macos-x86_64/);
  assert.match(buildSection, /--stage-dir release-upload/);
  assert.match(buildSection, /path: release-upload\/\*\*/);
  assert.match(buildSection, /retention-days: 1/);
  assert.match(buildSection, /overwrite: true/);
  assert.match(intelBuildSection, /retention-days: 1/);
  assert.match(intelBuildSection, /overwrite: true/);
  assert.match(buildSection, /--run-id "\$\{\{ github\.run_id \}\}"/);
  assert.match(buildSection, /--revision "\$\{\{ github\.sha \}\}"/);
  assert.doesNotMatch(buildSection, /target\/release\/bundle\/\*\*/);
  assert.doesNotMatch(buildSection, /github\.event_name/);
});

test("builders package the versioned CLI smoke test it and request explicit Tauri bundles", () => {
  assert.match(buildSection, /scripts\/package-cli\.ps1/);
  assert.match(buildSection, /scripts\/smoke-test-cli-archive\.ps1/);
  assert.match(buildSection, /bundles: nsis/);
  assert.match(buildSection, /bundles: appimage,deb,rpm/);
  assert.equal((buildSection.match(/bundles: dmg/g) ?? []).length, 1);
  assert.match(
    buildSection,
    /\$arguments = @\("tauri", "build", "--bundles", "\$\{\{ matrix\.bundles \}\}"\)/,
  );
  assert.match(buildSection, /target: aarch64-apple-darwin/);
  assert.match(intelBuildSection, /^ {4}runs-on: macos-15$/m);
  assert.match(intelBuildSection, /--target x86_64-apple-darwin/);
  assert.match(intelBuildSection, /--bundles dmg/);
  assert.doesNotMatch(buildSection, /os: macos-15-intel/);
  assert.match(buildSection, /shared-key: release-\$\{\{ matrix\.label \}\}/);
});

test("cross-built Intel artifacts receive native Intel package and launch verification", () => {
  assert.match(intelSection, /^ {4}needs: \[identity, build_intel\]$/m);
  assert.match(intelSection, /^ {4}runs-on: macos-15-intel$/m);
  assert.match(intelSection, /name: release-build-macos-x86_64/);
  assert.match(intelSection, /scripts\/smoke-test-cli-archive\.ps1/);
  assert.match(intelSection, /scripts\/verify-macos-release\.ps1/);
  assert.match(intelSection, /Architecture x86_64/);
  assert.match(macosVerifier, /StandardInput\.WriteLine\(\$Response\)/);
  assert.match(macosVerifier, /Environment\["PAGER"\] = "\/bin\/cat"/);
  assert.match(macosVerifier, /IndexOf\("<\?xml"\)/);
  assert.match(macosVerifier, /Substring\(\$plistStart\)/);
  assert.match(macosVerifier, /WriteAllText\(\$attachPath, \$attachPlist\)/);
  assert.doesNotMatch(macosVerifier, /-acceptlicense/);
});

test("CLI packaging uses the BSD-compatible chmod form required by macOS", () => {
  assert.match(cliPackager, /& chmod \+x \$temporaryExecutable/);
  assert.doesNotMatch(cliPackager, /& chmod \+x --/);
});

test("packaged CLI smoke covers the plugin-free launcher path and library contract", () => {
  assert.match(cliSmoke, /\$unicodeMarker = \[char\]0x03A9/);
  assert.match(cliSmoke, /steam launch \$unicodeMarker/);
  assert.match(cliSmoke, /standalone CLI/);
  assert.match(cliSmoke, /Library \$unicodeMarker space/);
  assert.match(cliSmoke, /--library \$library --json library show/);
  assert.match(cliSmoke, /data\.source -cne "invocation"/);
  assert.match(cliSmoke, /Resolve-Path -LiteralPath \(\[string\]\$selectionOutput\.data\.root\)/);
  assert.match(cliSmoke, /data\.raw_stream_commands\) -cnotcontains "exec"/);
  assert.match(cliSmoke, /data\.commands\) -cnotcontains "launch\.show"/);
  assert.doesNotMatch(cliSmoke, /Start-Process|cmd(?:\.exe)?|\/bin\/sh/iu);
});

test("assembler reconciles the full matrix then generates and checksums the release SBOM", () => {
  assert.match(assembleSection, /^ {4}needs: release_gate$/m);
  assert.match(assembleSection, /pattern: release-build-\*/);
  const reconcile = assembleSection.indexOf("reconcile-release-assets.mjs");
  const sbom = assembleSection.indexOf("anchore/sbom-action@");
  const finalize = assembleSection.indexOf("finalize-release-assets.mjs");
  const upload = assembleSection.indexOf("name: release-final");
  assert(reconcile >= 0 && sbom > reconcile && finalize > sbom && upload > finalize);
  assert.match(assembleSection, /syft-version: v1\.51\.1/);
  assert.match(assembleSection, /upload-release-assets: false/);
  assert.match(
    assembleSection,
    /--sbom-subject-checksums release-attestation\/sbom-subject-checksums\.txt/,
  );
  assert.match(assembleSection, /name: release-attestation-metadata/);
  assert.match(assembleSection, /path: release-attestation\/sbom-subject-checksums\.txt/);
  assert.match(assembleSection, /--run-id "\$\{\{ github\.run_id \}\}"/);
  assert.match(assembleSection, /--max-attempt "\$\{\{ github\.run_attempt \}\}"/);
  assert.match(assembleSection, /Refusing to modify non-draft release/);
  assert.match(assembleSection, /Refusing to rewrite existing release notes/);
  assert.doesNotMatch(assembleSection, /releases\/generate-notes/);
});

test("manual rehearsal verifies every finalized checksum without release write access", () => {
  assert.match(rehearseSection, /^ {4}if: github\.event_name == 'workflow_dispatch'$/m);
  assert.match(rehearseSection, /^ {4}needs: assemble$/m);
  assert.match(rehearseSection, /name: release-final/);
  assert.match(rehearseSection, /sha256sum --check --strict SHA256SUMS\.txt/);
  assert.match(rehearseSection, /name: release-attestation-metadata/);
  assert.match(
    rehearseSection,
    /sha256sum --check --strict \.\.\/release-attestation\/sbom-subject-checksums\.txt/,
  );
  assert.doesNotMatch(rehearseSection, /gh release/);
});

test("tag releases attest exact final bytes and the SBOM before draft mutation", () => {
  assert.match(attestSection, /^ {4}if: github\.event_name == 'push'$/m);
  assert.match(attestSection, /^ {4}needs: assemble$/m);
  assert.equal((attestSection.match(/actions\/attest@/g) ?? []).length, 2);
  assert.match(attestSection, /subject-path: release-assets-aggregate\/\*/);
  assert.match(attestSection, /name: release-attestation-metadata/);
  assert.match(
    attestSection,
    /subject-checksums: release-attestation\/sbom-subject-checksums\.txt/,
  );
  assert.doesNotMatch(
    attestSection,
    /subject-checksums: release-assets-aggregate\/SHA256SUMS\.txt/,
  );
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
    /gh release create "\$RELEASE_TAG"[\s\S]*--generate-notes[\s\S]*--notes-file release-metadata\/generated-release-body\.md/,
  );
  assert.match(publishSection, /gh release create "\$RELEASE_TAG"[\s\S]*--verify-tag/);
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

test(
  "publisher retries and recovers an interrupted draft without touching a published release",
  { skip: !bashExecutable },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "portcove-draft-publication-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const assets = path.join(root, "release-assets-aggregate");
    const metadata = path.join(root, "release-metadata");
    const bin = path.join(root, "bin");
    const stateRoot = path.join(root, "release-state");
    await mkdir(assets);
    await mkdir(metadata);
    await mkdir(bin);
    await mkdir(stateRoot);
    await writeFile(path.join(assets, "alpha.bin"), "alpha");
    await writeFile(path.join(assets, "beta.bin"), "beta");
    await writeFile(path.join(metadata, "generated-release-body.md"), "fixture release\n");
    await writeFile(path.join(stateRoot, "draft"), "false\n");
    await writeFile(path.join(stateRoot, "assets"), "");
    await writeFile(path.join(stateRoot, "create-calls"), "0\n");
    const ghShim = path.join(bin, "gh");
    await writeFile(
      ghShim,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'state="$FAKE_GH_STATE"',
        '[[ "${1:-}" == "release" ]] || exit 2',
        'operation="${2:-}"',
        "shift 3",
        'if [[ "$operation" == "view" ]]; then',
        '  [[ -f "$state/exists" ]] || exit 1',
        '  if [[ "${2:-}" == "isDraft" ]]; then cat "$state/draft"',
        '  elif [[ "${2:-}" == "assets" ]]; then cat "$state/assets"',
        "  else exit 2",
        "  fi",
        'elif [[ "$operation" == "create" ]]; then',
        '  [[ ! -f "$state/exists" ]] || { echo "duplicate release create" >&2; exit 1; }',
        '  touch "$state/exists"',
        '  printf "true\\n" > "$state/draft"',
        '  : > "$state/assets"',
        '  calls="$(cat "$state/create-calls")"',
        '  printf "%s\\n" "$((calls + 1))" > "$state/create-calls"',
        'elif [[ "$operation" == "delete-asset" ]]; then',
        '  [[ -f "$state/exists" && "$(cat "$state/draft")" == "true" ]] || exit 1',
        '  asset="${1:-}"',
        '  grep -Fvx -- "$asset" "$state/assets" > "$state/assets.next" || true',
        '  mv "$state/assets.next" "$state/assets"',
        'elif [[ "$operation" == "upload" ]]; then',
        '  [[ -f "$state/exists" && "$(cat "$state/draft")" == "true" ]] || exit 1',
        '  asset="$(basename "${1:-}")"',
        '  [[ "$asset" != "${FAKE_GH_FAIL_UPLOAD:-}" ]] || { echo "injected upload interruption" >&2; exit 1; }',
        '  grep -Fxq -- "$asset" "$state/assets" || printf "%s\\n" "$asset" >> "$state/assets"',
        '  sort -u -o "$state/assets" "$state/assets"',
        "else exit 2",
        "fi",
        "",
      ].join("\n"),
    );
    await chmod(ghShim, 0o755);

    const runPublisher = (overrides = {}) =>
      spawnSync(bashExecutable, ["-euo", "pipefail", "-c", publicationScript], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GH_TOKEN: "controlled-fixture-only",
          RELEASE_TAG: "v0.3.0-fixture",
          FAKE_GH_STATE: stateRoot,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          ...overrides,
        },
      });
    const readState = async () => {
      const assetLines = (await readFile(path.join(stateRoot, "assets"), "utf8")).trim();
      return {
        exists: existsSync(path.join(stateRoot, "exists")),
        draft: (await readFile(path.join(stateRoot, "draft"), "utf8")).trim() === "true",
        assets: assetLines ? assetLines.split("\n") : [],
        create_calls: Number((await readFile(path.join(stateRoot, "create-calls"), "utf8")).trim()),
      };
    };

    assert.equal(runPublisher().status, 0);
    assert.deepEqual(await readState(), {
      exists: true,
      draft: true,
      assets: ["alpha.bin", "beta.bin"],
      create_calls: 1,
    });
    assert.equal(runPublisher().status, 0);
    assert.equal((await readState()).create_calls, 1);

    const interrupted = runPublisher({ FAKE_GH_FAIL_UPLOAD: "beta.bin" });
    assert.notEqual(interrupted.status, 0);
    assert.match(interrupted.stderr, /injected upload interruption/u);
    assert.deepEqual((await readState()).assets, ["alpha.bin"]);
    assert.equal(runPublisher().status, 0);
    assert.deepEqual((await readState()).assets, ["alpha.bin", "beta.bin"]);

    const published = { ...(await readState()), draft: false };
    await writeFile(path.join(stateRoot, "draft"), "false\n");
    const refused = runPublisher();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Refusing to modify non-draft release/u);
    assert.deepEqual(await readState(), published);
  },
);

test("cleanup deletes transient artifacts only after successful rehearsal or publication", () => {
  assert.match(cleanupSection, /always\(\).*needs\.assemble\.result == 'success'/);
  assert.match(cleanupSection, /needs\.rehearse\.result == 'success'/);
  assert.match(cleanupSection, /needs\.publish\.result == 'success'/);
  assert.match(cleanupSection, /release-build-/);
  assert.match(cleanupSection, /release-final/);
  assert.match(cleanupSection, /release-attestation-metadata/);
  assert.match(cleanupSection, /release-publication-metadata/);
});
