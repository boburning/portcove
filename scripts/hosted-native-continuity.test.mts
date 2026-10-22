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
    assert.equal(JSON.parse(result.stdout).workflow, workflow);
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
