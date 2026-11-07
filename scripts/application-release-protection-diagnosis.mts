import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  inspectApplicationReleaseExecution,
  inspectApplicationSpendingAppointment,
} from "./application-release-policy.mts";
import { readPublicationPauseWithSdk } from "./release-control-inputs.mts";
import { assertTrustedDirectNode } from "./release-direct-node-transport.mts";
import {
  bootstrapProtectionFingerprints,
  createApplicationProtectionObservationReader,
  observeReleaseInputProtections,
  requireApplicationReleaseProtectionDigest,
} from "./release-input-protections.mts";
import { fixedReleaseReaderToken } from "./release-readonly-child-environment.mts";
import { isRecord } from "./runtime-values.mts";

let phase: "appointment" | "pause" | "inventory" | "pause-readback" | "comparison" = "appointment";

async function run() {
  const env = process.env;
  const execution = inspectApplicationReleaseExecution(env);
  assert.equal(execution.run_attempt, 1);
  assert.equal(env.GITHUB_ACTOR_ID, "43177418");
  assert.equal(env.GITHUB_JOB, "protection_diagnosis");
  assert.equal(env.PORTCOVE_APPLICATION_RELEASE_ACTIVE, "");
  assert.equal(env.PORTCOVE_CONTROLLER_WAKE, "");
  assert.equal(env.PORTCOVE_CATALOG_CONTROLLER_WAKE, "");
  assert.equal(env.PORTCOVE_CONTROLLER_ADMISSION, "");
  assert.equal(env.PORTCOVE_CATALOG_CONTROLLER_ADMISSION, "");

  const workflow = await readFile(".github/workflows/application-release.yml");
  assert.equal(
    createHash("sha256").update(workflow).digest("hex"),
    env.PORTCOVE_APPLICATION_RELEASE_WORKFLOW_SHA256,
  );
  inspectApplicationSpendingAppointment(env);
  const pauseCommit = env.PORTCOVE_DIAGNOSTIC_PAUSE ?? "";
  const expectedDigest = env.PORTCOVE_DIAGNOSTIC_OWNER_DIGEST ?? "";
  assert.match(pauseCommit, /^[a-f0-9]{40}$/u);
  assert.match(expectedDigest, /^[a-f0-9]{64}$/u);
  const reader = {
    token: fixedReleaseReaderToken(),
    guard: () => assertTrustedDirectNode("paused application protection diagnostic"),
    deadline: performance.now() + 120_000,
    maxBytes: 4 * 1024 ** 2,
    requestTimeoutMs: 30_000,
  };
  async function requireExactPause() {
    const pause = await readPublicationPauseWithSdk(reader);
    assert.equal(pause.publication_paused, true);
    assert.equal(pause.commit, pauseCommit);
  }
  phase = "pause";
  await requireExactPause();
  if (process.argv[2] === "preflight") return;
  assert.equal(process.argv[2], "observe");
  assert.equal(env.PORTCOVE_OBSERVER_INSTALLATION_ID, "177226788");
  const token = env.PORTCOVE_OBSERVER_TOKEN;
  assert.ok(token && !/[\r\n\0]/u.test(token) && token.length <= 16384);
  phase = "inventory";
  const observer = await createApplicationProtectionObservationReader({
    ...reader,
    refToken: reader.token,
    token,
  });
  const result = await observeReleaseInputProtections(observer, { releasePublication: true });
  const observedPause = result.inventory.branches.find(
    ({ branch }) => branch === "portcove-release-pause",
  );
  assert.ok(observedPause);
  assert.ok(isRecord(observedPause.ref.object));
  assert.equal(observedPause.ref.object.sha, pauseCommit);
  phase = "pause-readback";
  await requireExactPause();
  phase = "comparison";
  const fingerprints = bootstrapProtectionFingerprints(result);
  let stage: "policy-refused" | "digest-mismatch" | "match" = "policy-refused";
  try {
    const digest = requireApplicationReleaseProtectionDigest(result, true);
    stage = digest === expectedDigest ? "match" : "digest-mismatch";
  } finally {
    console.log(JSON.stringify({ kind: "paused-protection-diagnosis", stage, ...fingerprints }));
  }
  assert.equal(stage, "match");
}

await run().catch(() => {
  console.error(`Paused protection diagnostic refused at ${phase}.`);
  process.exitCode = 1;
});
