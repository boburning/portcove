import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import test from "node:test";
import { runPythonSuite } from "./python-test-results.mts";

void test("hosted Linux readiness preserves original-generation recovery and refusal outcomes", (context) => {
  runPythonSuite(new URL("./qualify-hosted-native-linux.test.py", import.meta.url), context, 30000);
});

const script = fileURLToPath(new URL("./rehearse-updater-artifacts.ps1", import.meta.url));
function describe(workflow: string, caller: string) {
  return spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      script,
      "-PlatformLabel",
      "windows-x86_64",
      "-EvidenceWorkflow",
      workflow,
      "-DescribeWorkflow",
    ],
    { encoding: "utf8", timeout: 30000, env: { ...process.env, GITHUB_WORKFLOW_REF: caller } },
  );
}
void test("rehearsal receipts bind only the actual allowlisted workflow before native effects", () => {
  for (const name of ["updater-artifact-rehearsal", "hosted-native-continuity"]) {
    const workflow = `.github/workflows/${name}.yml`;
    const result = describe(workflow, `boburning/portcove/${workflow}@refs/heads/reviewed`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      workflow,
      scope: "disposable-key installed updater rehearsal only",
    });
  }
  const wrong = describe(
    ".github/workflows/hosted-native-continuity.yml",
    "boburning/portcove/.github/workflows/untrusted.yml@refs/heads/reviewed",
  );
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /differs from the actual invocation/);
  const foreign = describe(
    ".github/workflows/hosted-native-continuity.yml",
    "foreign/portcove/.github/workflows/hosted-native-continuity.yml@refs/heads/reviewed",
  );
  assert.notEqual(foreign.status, 0);
  const unlisted = describe(".github/workflows/untrusted.yml", "");
  assert.notEqual(unlisted.status, 0);
  assert.match(unlisted.stderr, /EvidenceWorkflow/);
});
const helper = fileURLToPath(new URL("./prepare-hosted-windows-runtime.ps1", import.meta.url));
void test("hosted runtime gate retains the shipping floor and rejects absent, malformed, preview and older engines", () => {
  for (const [version, eligible] of [
    ["155.0.4283.62", true],
    ["155.0.4283.63", true],
    ["156.0.0.0", true],
    ["155.0.4283.61", false],
    ["154.0.9999.99", false],
    ["155.0.4283.62 dev", false],
    ["unknown", false],
  ] as const) {
    const result = spawnSync(
      "pwsh",
      ["-NoProfile", "-NonInteractive", "-File", helper, "-InspectVersion", version],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      scope: "declared-version-only; no host observation or installation",
      minimum: "155.0.4283.62",
      eligible,
    });
  }
});
void test("owner-host invocation refuses before any runtime installation", () => {
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", helper], {
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, GITHUB_ACTIONS: "false" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Only the reviewed standard hosted diagnostic/);
});
void test(
  "existing eligible hosted runtime returns success despite a stale native exit code",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "portcove-hosted-runtime-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "scripts"));
    await mkdir(path.join(root, "apps/desktop/src-tauri/src"), { recursive: true });
    const copiedHelper = path.join(root, "scripts/prepare-hosted-windows-runtime.ps1");
    await copyFile(helper, copiedHelper);
    await copyFile(
      new URL("../apps/desktop/src-tauri/src/runtime_support.rs", import.meta.url),
      path.join(root, "apps/desktop/src-tauri/src/runtime_support.rs"),
    );
    const wrapper = path.join(root, "run.ps1");
    await writeFile(
      wrapper,
      `param([string]$FixtureHelper)
$ErrorActionPreference = 'Stop'
function Get-ItemProperty { [pscustomobject]@{name='Microsoft Edge WebView2 Runtime';pv='155.0.4283.62'} }
$LASTEXITCODE = 73
& $FixtureHelper
if ($LASTEXITCODE -ne 0) { throw 'Actual successful helper left a stale native exit code' }
`,
    );
    const result = spawnSync(
      "pwsh",
      ["-NoProfile", "-NonInteractive", "-File", wrapper, copiedHelper],
      {
        encoding: "utf8",
        timeout: 30000,
        env: {
          ...process.env,
          GITHUB_ACTIONS: "true",
          GITHUB_REPOSITORY: "boburning/portcove",
          RUNNER_ENVIRONMENT: "github-hosted",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_SHA: "1".repeat(40),
          GITHUB_WORKFLOW_REF:
            "boburning/portcove/.github/workflows/hosted-runtime-readiness.yml@refs/heads/feature/534-runtime-fixture",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const receipt: unknown = JSON.parse(
      await readFile(
        path.join(root, "work/hosted-continuity-evidence/windows-runtime.json"),
        "utf8",
      ),
    );
    assert.ok(isRecord(receipt));
    assert.equal(receipt.stage, "ready-existing");
    assert.equal(receipt.installed, false);
    assert.deepEqual(receipt.after, ["155.0.4283.62"]);
  },
);
