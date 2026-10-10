import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { admitCanary, canaryIdentity, proveCanary } from "./controller-canary.mjs";

const canary = "a5".repeat(32);
const context = () => ({
  GITHUB_REPOSITORY: canaryIdentity.repository,
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: `refs/tags/${canaryIdentity.tag}`,
  GITHUB_WORKFLOW_REF: `${canaryIdentity.repository}/${canaryIdentity.workflow}@refs/tags/${canaryIdentity.tag}`,
  GITHUB_SHA: "1".repeat(40),
  CANARY_EXPECTED_CONTROLLER_SHA: "1".repeat(40),
  GITHUB_ACTOR_ID: "41898282",
  GITHUB_RUN_ID: "1234",
  GITHUB_RUN_ATTEMPT: "1",
  CANARY_REQUEST: JSON.stringify({
    schema_version: 1,
    operation: "probe-only",
    nonce: "b".repeat(32),
  }),
  PORTCOVE_CONTROLLER_CANARY: canary,
  CANARY_EXPECTED_SHA256: createHash("sha256").update(canary).digest("hex"),
});

test("admission stays secret-free; proof binds the disposable material without returning it", () => {
  const environment = context();
  delete environment.PORTCOVE_CONTROLLER_CANARY;
  delete environment.CANARY_EXPECTED_SHA256;
  assert.equal(admitCanary(environment).controller_sha, "1".repeat(40));
  assert.equal(JSON.stringify(admitCanary(environment)).includes(canary), false);
  assert.throws(() => proveCanary(environment), /expected disposable canary/);
  const receipt = proveCanary(context());
  assert.equal(receipt.canary_available, true);
  assert.equal(JSON.stringify(receipt).includes(canary), false);
  assert.match(receipt.qualification, /no signing or publication/);
});

test("wrong execution and invocation identities refuse before reading canary material", () => {
  for (const change of [
    { GITHUB_REPOSITORY: "someone/portcove" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF: "refs/heads/main" },
    { GITHUB_REF: "refs/pull/12/merge" },
    { GITHUB_REF: `refs/heads/${canaryIdentity.tag}` },
    { GITHUB_REF: `refs/tags/${canaryIdentity.tag}-other` },
    { GITHUB_WORKFLOW_REF: "boburning/portcove/.github/workflows/evil.yml@refs/heads/main" },
    { GITHUB_SHA: "2".repeat(40) },
    { CANARY_EXPECTED_CONTROLLER_SHA: "" },
    { GITHUB_ACTOR_ID: "999" },
    { GITHUB_ACTOR_ID: "999", CANARY_ALLOWED_ACTOR_IDS: "999" },
    { GITHUB_RUN_ID: "0" },
    { GITHUB_RUN_ATTEMPT: "2" },
  ]) {
    const environment = { ...context(), ...change };
    Object.defineProperty(environment, "PORTCOVE_CONTROLLER_CANARY", {
      get() {
        throw new Error("canary material must not be reached");
      },
    });
    assert.throws(() => proveCanary(environment), /controller canary refused:/);
  }
});

test("bounded inert requests reject candidate commands, paths and extra authority", () => {
  for (const raw of [
    "x".repeat(2049),
    "{",
    "null",
    "[]",
    JSON.stringify({ schema_version: 1, operation: "publish", nonce: "b".repeat(32) }),
    JSON.stringify({
      schema_version: 1,
      operation: "probe-only",
      nonce: "b".repeat(32),
      script: "candidate.mjs",
    }),
    JSON.stringify({ schema_version: 1, operation: "probe-only", nonce: "$(echo authority)" }),
    JSON.stringify({ schema_version: 1, operation: "probe-only", nonce: ["b".repeat(32)] }),
  ])
    assert.throws(
      () => admitCanary({ ...context(), CANARY_REQUEST: raw }),
      /controller canary refused:/,
    );
});

test("CLI failure does not echo request or canary; successful receipt contains only its digest", () => {
  const bad = spawnSync(process.execPath, ["scripts/controller-canary.mjs", "prove"], {
    env: { ...process.env, ...context(), CANARY_REQUEST: '{"script":"SECRET_REQUEST"}' },
    encoding: "utf8",
  });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
  assert.equal(bad.stderr.includes("SECRET_REQUEST"), false);
  assert.equal(bad.stderr.includes(canary), false);
  const good = spawnSync(process.execPath, ["scripts/controller-canary.mjs", "prove"], {
    env: { ...process.env, ...context() },
    encoding: "utf8",
  });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).canary_sha256, context().CANARY_EXPECTED_SHA256);
  assert.equal(good.stdout.includes(canary), false);
});
