import type { SpawnSyncReturns } from "node:child_process";
import { errorCode } from "./runtime-values.mts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { parseDocument, stringify } from "yaml";
import { isRecord } from "./runtime-values.mts";

import {
  loadPackagePolicy,
  releaseLabels as policyReleaseLabels,
  releaseBuildMatrix,
} from "./release-package-policy.mts";

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

function parsedWorkflow(text: string) {
  const document = parseDocument(text, { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const parsed: unknown = document.toJS();
  assert.ok(isRecord(parsed) && isRecord(parsed.jobs));
  return parsed as Record<string, unknown> & { jobs: Record<string, Record<string, unknown>> };
}
const workflowData = parsedWorkflow(workflow);
function job(name: string) {
  const selected = workflowData.jobs[name];
  assert.ok(selected, `missing release job ${name}`);
  // Script-content checks below deliberately inspect commands, not YAML layout.
  return stringify(selected, { lineWidth: 0 });
}
function steps(name: string, data = workflowData) {
  const selected = data.jobs[name]?.steps;
  assert.ok(Array.isArray(selected));
  return selected as Record<string, unknown>[];
}
function needs(name: string, expected: string[], data = workflowData) {
  const actual = data.jobs[name]?.needs;
  const entries: unknown[] = Array.isArray(actual) ? actual : [actual];
  assert.ok(entries.every((entry) => typeof entry === "string"));
  const compare = (left: string, right: string) => left.localeCompare(right);
  assert.deepEqual(entries.map(String).sort(compare), [...expected].sort(compare));
}
function artifact(
  name: string,
  action: string,
  expected: Record<string, unknown>,
  data = workflowData,
) {
  const selected = steps(name, data).find(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith(`actions/${action}@`) &&
      isRecord(step.with) &&
      Object.entries(expected).every(
        ([key, value]) => (step.with as Record<string, unknown>)[key] === value,
      ),
  );
  assert.ok(selected, `missing ${name} ${action} relationship ${JSON.stringify(expected)}`);
}
const identitySection = job("identity");
const qualificationSection = job("qualification");
const validateSection = job("validate");
const buildSection = job("build");
const intelBuildSection = job("build_intel");
const intelSection = job("verify_intel");
const gateSection = job("release_gate");
const assembleSection = job("assemble");
const rehearseSection = job("rehearse");
const attestSection = job("attest");
const publishSection = job("publish");

function inlineRunScript(name: string, stepName: string) {
  const step = steps(name).find((step) => step.name === stepName);
  assert.ok(step && typeof step.run === "string", `missing inline run script for ${stepName}`);
  return step.run;
}

const publicationScript = inlineRunScript("publish", "Create or reconcile draft release");
// The publisher runs only on Ubuntu. Windows Git Bash process startup is both
// materially slower and a different host contract; exact hosted Linux CI runs
// this fixture against the same Bash boundary as the privileged job.
const bashExecutable = process.platform === "win32" ? undefined : "bash";

function mockPublisherArguments(script: string, bin: string, ghShim: string) {
  return [
    "-euo",
    "pipefail",
    "-c",
    [
      // Shell startup may reorder inherited PATH; establish fixture lookup afterwards.
      'export PATH="$1:$PATH"',
      "hash -r",
      'if [[ "$(type -t gh)" != file || "$(command -v gh)" != "$2" ]]; then',
      "  printf '%s\\n' 'Refusing publisher fixture: gh escaped its private shim' >&2",
      "  exit 1",
      "fi",
      script,
    ].join("\n"),
    "portcove-mock-publisher",
    bin,
    ghShim,
  ];
}

// The production publisher runs on Ubuntu. This private fixture adapter maps
// only its epoch/UTC ISO modes onto macOS's real BSD date parser.
const mockBsdDateAdapter = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  'if [[ "$#" == 1 && "$1" == +%s ]]; then exec /bin/date +%s; fi',
  'if [[ "$#" == 3 && "$1" == -d && "$3" == +%s ]]; then',
  '  if [[ "$2" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$ ]]; then',
  // Epoch seconds discard the fractional part on GNU date as well.
  '    timestamp="${2%%.*}"',
  '    timestamp="${timestamp%Z}Z"',
  '    exec /bin/date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$timestamp" +%s',
  "  fi",
  "fi",
  'printf "%s\\n" "Unsupported publisher fixture date mode" >&2',
  "exit 2",
  "",
].join("\n");

function assertWriteAuthority(data: typeof workflowData) {
  assert.deepEqual(data.permissions, { contents: "read" });
  for (const name of ["build", "build_intel", "assemble", "rehearse"])
    assert.deepEqual(data.jobs[name]?.permissions, { contents: "read" });
  assert.deepEqual(data.jobs.attest?.permissions, {
    "artifact-metadata": "write",
    attestations: "write",
    contents: "read",
    "id-token": "write",
  });
  assert.deepEqual(data.jobs.publish?.permissions, { contents: "write" });
  assert.equal(data.jobs.cleanup, undefined);
  assert.equal(
    Object.values(data.jobs).filter(
      (job) => isRecord(job.permissions) && job.permissions.contents === "write",
    ).length,
    1,
  );
}

void test("write authority is split across isolated attestation and publication jobs", () => {
  assertWriteAuthority(workflowData);
  assert.doesNotMatch(attestSection, /actions\/checkout|run:/);
  assert.doesNotMatch(publishSection, /actions\/checkout|setup-node|node scripts/);
});

void test("cheap identity unlocks qualification and builds before the explicit result gate", () => {
  assert.match(identitySection, /actions\/setup-node/);
  assert.doesNotMatch(identitySection, /pnpm install|rust-toolchain|just audit/);
  assert.doesNotMatch(
    identitySection,
    /select-release-channel\.test|reconstruct-application-update-records\.test/,
  );
  needs("qualification", ["identity"]);
  assert.match(qualificationSection, /\.\/\.github\/workflows\/qualification\.yml/);
  assert.match(qualificationSection, /qualification_caller: release/);
  assert.match(qualificationSection, /provenance_scope: release-qualification/);
  needs("validate", ["identity", "qualification"]);
  assert.match(validateSection, /just audit --fresh --profile release/);
  assert.match(validateSection, /needs\.qualification\.outputs\.plan_digest/);
  assert.match(validateSection, /needs\.qualification\.outputs\.plan_gzip_base64/);
  assert.match(validateSection, /PORTCOVE_EXPECTED_CHECKOUT: \$\{\{ github\.sha \}\}/);
  assert.match(validateSection, /node scripts\/validation-plan\.mts/);
  assert.match(validateSection, /node scripts\/workflow-provenance\.mts/);
  assert.match(
    validateSection,
    /workflow-provenance-release-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(validateSection, /retention-days: 7/);
  needs("build", ["identity", "validate"]);
  needs("build_intel", ["identity", "validate"]);

  assert.equal(workflowData.jobs.release_gate?.if, "${{ always() && !inputs.report_only_repair }}");
  needs("release_gate", [
    "identity",
    "qualification",
    "validate",
    "build",
    "build_intel",
    "verify_intel",
  ]);
  assert.match(gateSection, /scripts\/release-result-gate\.mts/);
  needs("assemble", ["identity", "release_gate"]);
});

void test("every builder uploads only the staged checksummed payload with short fallback retention", () => {
  for (const label of releaseLabels.filter((label) => label !== "macos-x86_64"))
    assert.ok(releaseBuildMatrix().include.some((row) => row.label === label));
  assert.match(buildSection, /fromJSON\(needs.identity.outputs.build_matrix\)/);
  assert.match(intelBuildSection, /--label macos-x86_64/);
  artifact("build", "upload-artifact", {
    name: "release-build-${{ matrix.label }}-${{ github.run_id }}-${{ github.run_attempt }}",
    path: "release-upload/**",
    "retention-days": 7,
    overwrite: false,
  });
  artifact("build_intel", "upload-artifact", {
    name: "release-build-macos-x86_64-${{ github.run_id }}-${{ github.run_attempt }}",
    "retention-days": 7,
    overwrite: false,
  });
  assert.match(buildSection, /--stage-dir release-upload/);
  assert.match(buildSection, /path: release-upload\/\*\*/);
  assert.match(buildSection, /retention-days: 7/);
  assert.match(buildSection, /overwrite: false/);
  assert.match(intelBuildSection, /retention-days: 7/);
  assert.match(intelBuildSection, /overwrite: false/);
  assert.match(buildSection, /--run-id "\$\{\{ github\.run_id \}\}"/);
  assert.match(buildSection, /--revision "\$\{\{ github\.sha \}\}"/);
  assert.doesNotMatch(buildSection, /target\/release\/bundle\/\*\*/);
  assert.doesNotMatch(buildSection, /github\.event_name/);
});

void test("builders package the versioned CLI smoke test it and request explicit Tauri bundles", () => {
  assert.match(buildSection, /scripts\/package-cli\.ps1/);
  assert.match(buildSection, /scripts\/smoke-test-cli-archive\.ps1/);
  assert.deepEqual(
    releaseBuildMatrix().include.map((row) => row.bundles),
    ["nsis", "appimage,deb,rpm", "dmg"],
  );
  assert.equal(releaseBuildMatrix().include[2]?.target, "aarch64-apple-darwin");
  assert.equal(workflowData.jobs.build_intel?.["runs-on"], "macos-15");
  assert.match(intelBuildSection, /--target x86_64-apple-darwin/);
  assert.match(intelBuildSection, /--bundles dmg/);
  assert.doesNotMatch(buildSection, /os: macos-15-intel/);
  assert.match(buildSection, /shared-key: release-\$\{\{ matrix\.label \}\}/);
});

void test("cross-built Intel artifacts receive native Intel package and launch verification", () => {
  needs("verify_intel", ["identity", "build_intel"]);
  assert.equal(workflowData.jobs.verify_intel?.["runs-on"], "macos-15-intel");
  assert.match(intelSection, /name: release-build-macos-x86_64/);
  assert.match(intelSection, /scripts\/smoke-test-cli-archive\.ps1/);
  assert.match(intelSection, /scripts\/verify-macos-release\.ps1/);
  assert.match(intelSection, /Architecture x86_64/);

  assert.doesNotMatch(macosVerifier, /-acceptlicense/);
});

void test("supplemental macOS packaging source check retains BSD-compatible chmod syntax", () => {
  assert.match(cliPackager, /& chmod \+x \$temporaryExecutable/);
  assert.doesNotMatch(cliPackager, /& chmod \+x --/);
});

void test("supplemental CLI smoke source guard excludes shell-based launcher detours", () => {
  assert.doesNotMatch(cliSmoke, /Start-Process|cmd(?:\.exe)?|\/bin\/sh/iu);
});

void test("assembler reconciles the full matrix then generates and checksums the release SBOM", () => {
  needs("assemble", ["identity", "release_gate"]);
  artifact("assemble", "download-artifact", {
    pattern: "release-build-*-${{ github.run_id }}-${{ github.run_attempt }}",
  });
  const reconcile = assembleSection.indexOf("reconcile-release-assets.mts");
  const sbom = assembleSection.indexOf("anchore/sbom-action@");
  const finalize = assembleSection.indexOf("finalize-release-assets.mts");
  const upload = assembleSection.indexOf("name: release-final");
  assert(reconcile >= 0 && sbom > reconcile && finalize > sbom && upload > finalize);
  assert.match(assembleSection, /syft-version: v1\.54\.1/);
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

void test("manual rehearsal verifies every finalized checksum without release write access", () => {
  assert.equal(
    workflowData.jobs.rehearse?.if,
    "${{ !inputs.report_only_repair && github.event_name == 'workflow_dispatch' }}",
  );
  needs("rehearse", ["assemble"]);
  assert.match(rehearseSection, /name: release-final/);
  assert.match(rehearseSection, /sha256sum --check --strict SHA256SUMS\.txt/);
  assert.match(rehearseSection, /name: release-attestation-metadata/);
  assert.match(
    rehearseSection,
    /sha256sum --check --strict \.\.\/release-attestation\/sbom-subject-checksums\.txt/,
  );
  assert.doesNotMatch(rehearseSection, /gh release/);
});

void test("tag releases attest exact final bytes and the SBOM before draft mutation", () => {
  assert.equal(
    workflowData.jobs.attest?.if,
    "${{ !inputs.report_only_repair && (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && needs.identity.outputs.release_profile == 'initial-beta-win-linux')) }}",
  );
  needs("attest", ["identity", "assemble"]);
  assert.equal((attestSection.match(/actions\/attest@/g) ?? []).length, 3);
  const compilerAttest = steps("attest").find(
    (step) =>
      step.name ===
      "Attest retained compiler report bytes without claiming compiler or native acceptance",
  );
  assert.equal(
    compilerAttest?.if,
    "needs.identity.outputs.release_profile == 'initial-beta-win-linux'",
  );
  assert.match(
    attestSection,
    /subject-path: release-compiler-observations\/compiler-result-\*\.json/,
  );
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
  needs("publish", ["assemble", "attest", "authorize_publication"]);
});

void test("publisher mutates drafts only from precomputed metadata and attested assets", () => {
  assert.equal(workflowData.jobs.publish?.if, "github.event_name == 'push'");
  artifact("publish", "download-artifact", {
    name: "release-final-${{ github.run_id }}-${{ github.run_attempt }}",
  });
  artifact("publish", "download-artifact", {
    name: "release-publication-metadata-${{ github.run_id }}-${{ github.run_attempt }}",
  });
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

void test(
  "mock publisher restores private lookup after startup reorder and refuses functions",
  { skip: !bashExecutable },
  async (t) => {
    assert.ok(bashExecutable);
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "portcove-mock-path ' $ ; ")));
    const evidence = await mkdtemp(path.join(os.tmpdir(), "portcove-mock-path-evidence-"));
    console.log(`Retained synthetic mock lookup evidence: ${evidence}`);
    t.after(async () => {
      await cp(root, path.join(evidence, "terminal-fixture"), { recursive: true });
      await rm(root, { recursive: true, force: true });
    });
    const bin = path.join(root, "private ' $ ; bin");
    const decoyBin = path.join(root, "decoy ' $ ; bin");
    await mkdir(bin);
    await mkdir(decoyBin);
    const ghShim = path.join(bin, "gh");
    const decoyShim = path.join(decoyBin, "gh");
    const privateMarker = path.join(root, "private-marker");
    const decoyMarker = path.join(root, "decoy-marker");
    const functionMarker = path.join(root, "function-marker");
    const startupMarker = path.join(root, "startup-marker");
    const startup = path.join(root, "startup ' $ ; .bash");
    await writeFile(ghShim, '#!/usr/bin/env bash\nprintf "private\\n" >> "$MOCK_PRIVATE_MARKER"\n');
    await writeFile(decoyShim, '#!/usr/bin/env bash\nprintf "decoy\\n" >> "$MOCK_DECOY_MARKER"\n');
    await chmod(ghShim, 0o755);
    await chmod(decoyShim, 0o755);
    await writeFile(
      startup,
      [
        'export PATH="$MOCK_DECOY_BIN:$PATH"',
        'hash -p "$MOCK_DECOY_SHIM" gh',
        'printf "startup\\n" >> "$MOCK_STARTUP_MARKER"',
      ].join("\n"),
    );
    const environment = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      MOCK_DECOY_BIN: decoyBin,
      MOCK_DECOY_SHIM: decoyShim,
      MOCK_PRIVATE_MARKER: privateMarker,
      MOCK_DECOY_MARKER: decoyMarker,
      MOCK_FUNCTION_MARKER: functionMarker,
      MOCK_STARTUP_MARKER: startupMarker,
    };
    const run = (args: readonly string[], overrides: NodeJS.ProcessEnv = {}) => {
      // Inject the synthetic reorder after uncontrolled host startup, before the shared repair.
      // The owned control file is positional data, never interpolated shell code.
      const controlledArgs = [...args, startup];
      const controlledScript = controlledArgs[3];
      assert.ok(typeof controlledScript === "string");
      controlledArgs[3] = `. "$3"\n${controlledScript}`;
      return spawnSync(bashExecutable, controlledArgs, {
        cwd: root,
        env: { ...environment, ...overrides },
        encoding: "utf8",
        timeout: 5_000,
        killSignal: "SIGKILL",
      });
    };
    // Synthetic ordering/hash controls do not identify Local's historical startup mechanism.
    const before = run([
      "-euo",
      "pipefail",
      "-c",
      'printf "%s\\n" "${PATH%%:*}" "$(command -v gh)" "$(hash -t gh)" "$PWD"',
      "portcove-mock-negative-control",
      bin,
      ghShim,
    ]);
    const restored = run(
      mockPublisherArguments(
        'printf "%s\\n" "${PATH%%:*}" "$(type -t gh)" "$(command -v gh)" "$PWD"; gh',
        bin,
        ghShim,
      ),
    );
    const refused = run(mockPublisherArguments("gh", bin, ghShim), {
      "BASH_FUNC_gh%%": '() { printf "function\\n" >> "$MOCK_FUNCTION_MARKER"; }',
    });
    const safeResult = ({ status, signal, error, stdout, stderr }: SpawnSyncReturns<string>) => ({
      status,
      signal,
      error: error ? { code: errorCode(error), message: error.message } : null,
      stdout,
      stderr,
    });
    await writeFile(
      path.join(evidence, "synthetic-lookup.json"),
      JSON.stringify(
        {
          scope:
            "inert post-startup injected reorder/hash/function controls; not historical cause proof",
          cwd: root,
          expectedShim: ghShim,
          decoyShim,
          before: safeResult(before),
          restored: safeResult(restored),
          refused: safeResult(refused),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    assert.equal(before.status, 0);
    assert.deepEqual(before.stdout.trimEnd().split("\n"), [decoyBin, decoyShim, decoyShim, root]);
    assert.ok(existsSync(startupMarker));
    assert.equal(restored.status, 0);
    assert.deepEqual(restored.stdout.trimEnd().split("\n"), [bin, "file", ghShim, root]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Refusing publisher fixture: gh escaped its private shim/u);
    assert.equal(await readFile(privateMarker, "utf8"), "private\n");
    assert.equal(existsSync(decoyMarker), false);
    assert.equal(existsSync(functionMarker), false);
  },
);

void test(
  "publisher retries and recovers an interrupted draft without touching a published release",
  { skip: !bashExecutable },
  async (t) => {
    assert.ok(bashExecutable);
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "portcove-draft-publication-")),
    );
    const evidence = await mkdtemp(path.join(os.tmpdir(), "portcove-draft-publication-evidence-"));
    console.log(`Retained mock publisher diagnostics: ${evidence}`);
    t.after(async () => {
      // Preserve only this test's isolated mock files, before the original teardown.
      await cp(root, path.join(evidence, "terminal-fixture"), { recursive: true });
      await rm(root, { recursive: true, force: true });
    });
    const assets = path.join(root, "release-assets-aggregate");
    const metadata = path.join(root, "release-metadata");
    const bin = path.join(root, "bin");
    const stateRoot = path.join(root, "release-state");
    await mkdir(assets);
    await mkdir(metadata);
    await mkdir(bin);
    await mkdir(stateRoot);
    if (process.platform === "darwin") {
      const dateShim = path.join(bin, "date");
      await writeFile(dateShim, mockBsdDateAdapter);
      await chmod(dateShim, 0o755);
    }
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

    const fixtureEnvironment = {
      ...process.env,
      GH_TOKEN: "controlled-fixture-only",
      RELEASE_TAG: "v0.3.0-fixture",
      LINUX_AUTHORIZED_AT: new Date().toISOString(),
      LINUX_RISK_EXPIRES_AT: "2099-01-01T00:00:00Z",
      FAKE_GH_STATE: stateRoot,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    };
    const fixtureIdentities = await Promise.all(
      [root, bin, ghShim].map(async (entry) => {
        const metadata = await stat(entry, { bigint: true });
        return {
          path: entry,
          realPath: await realpath(entry),
          device: String(metadata.dev),
          inode: String(metadata.ino),
          mode: (metadata.mode & 0o7777n).toString(8),
          uid: String(metadata.uid),
          gid: String(metadata.gid),
          size: String(metadata.size),
          regularFile: metadata.isFile(),
          directory: metadata.isDirectory(),
        };
      }),
    );
    const parentFixture = {
      pathDelimiter: path.delimiter,
      intendedPathFirstEntry: fixtureEnvironment.PATH.split(path.delimiter)[0],
      identities: fixtureIdentities,
      shimSha256: createHash("sha256")
        .update(await readFile(ghShim))
        .digest("hex"),
      executableAccess: await access(ghShim, constants.X_OK).then(
        () => ({ permitted: true, errorCode: null }),
        (error) => ({ permitted: false, errorCode: errorCode(error) }),
      ),
    };
    await writeFile(
      path.join(evidence, "parent-fixture.json"),
      JSON.stringify(parentFixture, null, 2),
      { mode: 0o600 },
    );
    const childEvidence = (child: SpawnSyncReturns<string>) => ({
      status: child.status,
      signal: child.signal,
      error: child.error
        ? { name: child.error.name, message: child.error.message, code: errorCode(child.error) }
        : null,
      stdout: child.stdout,
      stderr: child.stderr,
    });
    const binding = spawnSync(
      bashExecutable,
      mockPublisherArguments(
        [
          'printf "%s\\n" "$BASH_VERSION" "$(type -t gh)" "$(command -v gh)" "$(command -v bash)"',
          'printf "%s\\n" "$PWD" "$(pwd -P)" "${PATH%%:*}"',
          'case ":$PATH:" in *":${FAKE_GH_STATE%/*}/bin:"*) printf "true\\n";; *) printf "false\\n";; esac',
          'if [[ -f "${FAKE_GH_STATE%/*}/bin/gh" ]]; then printf "true\\n"; else printf "false\\n"; fi',
          'if [[ -x "${FAKE_GH_STATE%/*}/bin/gh" ]]; then printf "true\\n"; else printf "false\\n"; fi',
        ].join("\n"),
        bin,
        ghShim,
      ),
      {
        cwd: root,
        encoding: "utf8",
        env: fixtureEnvironment,
        timeout: 5_000,
        killSignal: "SIGKILL",
      },
    );
    const [
      bashVersion,
      ghKind,
      ghPath,
      bashPath,
      childCwd,
      childPhysicalCwd,
      childPathFirstEntry,
      childFixtureBinInPath,
      childShimRegularFile,
      childShimExecutable,
      ...extraOutput
    ] = binding.stdout?.trimEnd().split("\n") ?? [];
    await writeFile(
      path.join(evidence, "binding.json"),
      JSON.stringify(
        {
          ...childEvidence(binding),
          cwd: root,
          expectedShim: ghShim,
          bashVersion,
          bashPath,
          ghKind,
          ghPath,
          parentFixture,
          childCwd,
          childPhysicalCwd,
          childPathFirstEntry,
          childFixtureBinInPath,
          childShimRegularFile,
          childShimExecutable,
          environmentPresence: {
            BASH_ENV: Object.hasOwn(process.env, "BASH_ENV"),
            ENV: Object.hasOwn(process.env, "ENV"),
            SHELLOPTS: Object.hasOwn(process.env, "SHELLOPTS"),
            BASHOPTS: Object.hasOwn(process.env, "BASHOPTS"),
            exportedGhFunction: Object.keys(process.env).some((key: string) =>
              key.startsWith("BASH_FUNC_gh"),
            ),
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    // Never run the publisher fixture against a real gh command or imported function.
    assert.equal(binding.status, 0, `Bash binding probe failed; diagnostics: ${evidence}`);
    assert.equal(extraOutput.length, 0, `Ambiguous Bash binding output: ${evidence}`);
    assert.ok(bashVersion && bashPath, `Missing Bash identity: ${evidence}`);
    assert.equal(ghKind, "file", `gh is not the fixture executable; diagnostics: ${evidence}`);
    assert.equal(ghPath, ghShim, `gh escaped its fixture; diagnostics: ${evidence}`);
    // Exercise both accepted timestamp spellings with the real host parser,
    // including the macOS adapter, before any mock publication is attempted.
    const timestamps = ["2001-02-03T04:05:06Z", "2001-02-03T04:05:06.789Z"];
    for (const timestamp of timestamps) {
      const parsed: SpawnSyncReturns<string> = spawnSync(
        bashExecutable,
        mockPublisherArguments('date -d "$3" +%s', bin, ghShim).concat(timestamp),
        {
          cwd: root,
          env: fixtureEnvironment,
          encoding: "utf8",
          timeout: 5_000,
          killSignal: "SIGKILL",
        },
      );
      assert.equal(parsed.status, 0, parsed.stderr);
      assert.equal(parsed.stdout.trim(), String(Math.floor(Date.parse(timestamp) / 1_000)));
    }
    const unknownDateMode = spawnSync(
      bashExecutable,
      mockPublisherArguments("date --portcove-fixture-unknown-mode", bin, ghShim),
      {
        cwd: root,
        env: fixtureEnvironment,
        encoding: "utf8",
        timeout: 5_000,
        killSignal: "SIGKILL",
      },
    );
    assert.notEqual(unknownDateMode.status, 0);
    assert.equal(existsSync(path.join(stateRoot, "exists")), false);
    const runPublisher = (overrides: NodeJS.ProcessEnv = {}) =>
      spawnSync(bashExecutable, mockPublisherArguments(publicationScript, bin, ghShim), {
        cwd: root,
        encoding: "utf8",
        // Five mock calls plus the binding probe fit the existing 30-second test budget.
        timeout: 4_000,
        killSignal: "SIGKILL",
        env: { ...fixtureEnvironment, ...overrides },
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

    for (const rejected of [
      { LINUX_AUTHORIZED_AT: "" },
      { LINUX_AUTHORIZED_AT: "2000-01-01T00:00:00Z" },
      { LINUX_AUTHORIZED_AT: "2099-01-01T00:00:00Z" },
      { LINUX_RISK_EXPIRES_AT: "corrupted" },
      { LINUX_RISK_EXPIRES_AT: "2000-01-01T00:00:00Z" },
    ]) {
      const before = await readState();
      assert.notEqual(runPublisher(rejected).status, 0);
      assert.deepEqual(await readState(), before);
    }
    const first = runPublisher();
    await writeFile(
      path.join(evidence, "first-publisher.json"),
      JSON.stringify(childEvidence(first), null, 2),
      { mode: 0o600 },
    );
    await cp(root, path.join(evidence, "first-fixture"), { recursive: true });
    assert.equal(first.status, 0, `First mock publisher failed; diagnostics: ${evidence}`);
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

void test("assembly and draft publication retain custody until downstream handoff or expiry", () => {
  assert.equal(workflowData.jobs.cleanup, undefined);
  assert.doesNotMatch(
    workflow,
    /actions: write|actions\/artifacts\/.*artifact_id|Delete verified transient artifacts/,
  );
});

void test("release job semantics survive YAML key and job reordering", () => {
  const reordered = structuredClone(workflowData);
  reordered.jobs = Object.fromEntries(
    Object.entries(reordered.jobs)
      .reverse()
      .map(([name, job]) => [name, Object.fromEntries(Object.entries(job).reverse())]),
  );
  assert.deepEqual(parsedWorkflow(stringify(reordered, { indent: 4 })), workflowData);
  const wrongPermission = structuredClone(reordered);
  wrongPermission.jobs.publish!.permissions = { contents: "read" };
  assert.throws(() => assertWriteAuthority(parsedWorkflow(stringify(wrongPermission))));
  assertWriteAuthority(parsedWorkflow(stringify(reordered, { indent: 4 })));
  const wrongDependency = structuredClone(reordered);
  wrongDependency.jobs.publish!.needs = ["assemble"];
  assert.throws(() =>
    needs(
      "publish",
      ["assemble", "attest", "authorize_publication"],
      parsedWorkflow(stringify(wrongDependency)),
    ),
  );
  needs(
    "publish",
    ["assemble", "attest", "authorize_publication"],
    parsedWorkflow(stringify(reordered, { indent: 4 })),
  );
  const expectedArtifact = { name: "release-final-${{ github.run_id }}-${{ github.run_attempt }}" };
  artifact("publish", "download-artifact", expectedArtifact, parsedWorkflow(stringify(reordered)));
  const wrongArtifact = structuredClone(reordered);
  const download = steps("publish", wrongArtifact).find(
    (step) =>
      isRecord(step.with) &&
      step.with.name === "release-final-${{ github.run_id }}-${{ github.run_attempt }}",
  )!;
  download.with = { name: "foreign-final" };
  assert.throws(() =>
    artifact(
      "publish",
      "download-artifact",
      expectedArtifact,
      parsedWorkflow(stringify(wrongArtifact)),
    ),
  );
});

void test("PowerShell release consumers execute library identity and prefixed plist fixtures", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-release-consumers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const helper = path.join(root, "respond.mjs");
  await writeFile(
    helper,
    'let text="";process.stdin.setEncoding("utf8");process.stdin.on("data",x=>text+=x);process.stdin.on("end",()=>{if(text.trim()!=="Y"||process.env.PAGER!=="/bin/cat")process.exit(9);process.stdout.write("license text\\n<?xml version=\\"1.0\\"?><plist/>");});',
  );
  const fixture = path.join(root, "fixture.ps1");
  const buildScript = path.join(root, "build.ps1");
  await writeFile(
    buildScript,
    inlineRunScript("build", "Build desktop bundles").replaceAll("${{ matrix.bundles }}", "dmg"),
  );
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  await writeFile(
    fixture,
    `
$ErrorActionPreference = 'Stop'
function Parse-Source($path) {
  $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$errors)
  if ($errors.Count) { throw 'production parse failure' }
  return $ast
}
$buildScript = ${quote(buildScript)}
function pnpm { $global:observedArguments = @($args); $global:LASTEXITCODE = 0 }
foreach ($target in @('', 'aarch64-apple-darwin')) {
  $env:RELEASE_TARGET = $target
  & $buildScript
  $expected = @('tauri','build','--bundles','dmg')
  if ($target) { $expected += @('--target',$target) }
  if (($global:observedArguments | ConvertTo-Json -Compress) -cne ($expected | ConvertTo-Json -Compress)) { throw 'desktop bundle arguments differ' }
}
$ast = Parse-Source ${quote(fileURLToPath(new URL("./smoke-test-cli-archive.ps1", import.meta.url)))}
$temporaryParent = ${quote(root)}
$pathAssignments = $ast.FindAll({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -in @('$unicodeMarker','$temporaryDirectory','$extractDirectory','$library')}, $false)
foreach ($statement in $pathAssignments) { . ([scriptblock]::Create($statement.Extent.Text)) }
if ($pathAssignments.Count -ne 4 -or $library -notmatch '[^\\x00-\\x7f]' -or $library -notmatch '\\s' -or $extractDirectory -notmatch '\\s') { throw 'CLI fixture paths omit spaces or Unicode' }
[IO.Directory]::CreateDirectory($library) | Out-Null

$assignment = $ast.Find({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$selectionOutput'}, $true)
$statements = @($assignment.Parent.Statements)
$first = [Array]::IndexOf($statements, $assignment)
$last = [Array]::FindIndex($statements, [Predicate[object]]{param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$doctorOutput'})
if ($first -lt 0 -or $last -le $first) { throw 'library consumer unavailable' }
$consumer = [scriptblock]::Create(($statements[$first..($last-1)] | ForEach-Object { $_.Extent.Text }) -join "\n")
$PlatformLabel = 'windows-x86_64'
$executable = 'Invoke-FixtureCli'
function Invoke-FixtureCli {
  $global:LASTEXITCODE = 0
  if ($args[-1] -eq 'capabilities') { return $script:capabilities | ConvertTo-Json -Compress }
  return $script:selection | ConvertTo-Json -Compress
}
foreach ($case in @('valid','wrong-library','wrong-provenance','missing-root','missing-exec','missing-show','missing-recover','wrong-capabilities-command')) {
  $script:selection = @{ok=$true; command='library.show'; data=@{source='invocation';root=$library}}
  $script:capabilities = @{ok=$true; command='capabilities'; data=@{raw_stream_commands=@('exec');commands=@('launch.show','launch.recover')}}
  if ($case -eq 'missing-exec') { $script:capabilities.data.raw_stream_commands = @() }
  if ($case -eq 'missing-show') { $script:capabilities.data.commands = @('launch.recover') }
  if ($case -eq 'missing-recover') { $script:capabilities.data.commands = @('launch.show') }
  if ($case -eq 'wrong-capabilities-command') { $script:capabilities.command = 'other' }
  if ($case -eq 'valid') { $script:selection.data.root = "  $library  " }
  if ($case -eq 'wrong-library') { $script:selection.data.root = [IO.Path]::GetTempPath() }
  if ($case -eq 'wrong-provenance') { $script:selection.data.source = 'environment' }
  if ($case -eq 'missing-root') { $script:selection.data.root = Join-Path $library 'absent' }
  $rejected = $false
  try { & $consumer } catch { $rejected = $true }
  if ($rejected -eq ($case -eq 'valid')) { throw "library case $case result differs" }
}
$ast = Parse-Source ${quote(fileURLToPath(new URL("./verify-macos-release.ps1", import.meta.url)))}
$definition = $ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-CheckedWithResponse'}, $true)
. ([scriptblock]::Create($definition.Extent.Text))
$attach = Invoke-CheckedWithResponse ${quote(process.execPath)} @(${quote(helper)}) 'Y'
$try = $ast.Find({param($n) $n -is [Management.Automation.Language.TryStatementAst] -and $n.Body.Statements[0].Extent.Text -like '$attach =*'}, $false)
$statements = @($try.Body.Statements)
$last = [Array]::FindIndex($statements, [Predicate[object]]{param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$attachJson'})
if ($last -lt 2) { throw 'plist consumer unavailable' }
$consumer = [scriptblock]::Create(($statements[1..($last-1)] | ForEach-Object { $_.Extent.Text }) -join "\n")
$temporaryRoot = ${quote(root)}
& $consumer
if ([IO.File]::ReadAllText((Join-Path $temporaryRoot 'attach.plist')) -cne '<?xml version="1.0"?><plist/>') { throw 'prefixed plist extraction differs' }
$attach = 'license text without property list'
$rejected = $false
try { & $consumer } catch { $rejected = $true }
if (-not $rejected) { throw 'missing property list accepted' }
`,
  );
  const result = spawnSync("pwsh", ["-NoProfile", "-File", fixture], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
