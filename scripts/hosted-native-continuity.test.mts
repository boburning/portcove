import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

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
