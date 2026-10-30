/** Whole public controller with inert dependency observations. No authenticated
 * receipts, provider, owned effect, worker or signing key are available here. */
import assert from "node:assert/strict";
import children from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const forbidden = () => {
  throw new Error("Uncontrolled TUF controller fixture capability");
};
globalThis.fetch = forbidden;
process.kill = forbidden;
for (const [name, value] of Object.entries(children))
  if (typeof value === "function") Reflect.set(children, name, forbidden);
syncBuiltinESMExports();
mock.module("node:child_process", {
  namedExports: Object.fromEntries(Object.entries(children)),
  defaultExport: children,
});

// Preserve the production role, identity, digest and deadline decisions. Only
// external observations/authentication boundaries below receive inert replies.
const signing = await import("../release-tuf-signing.mts");
const contexts = await import("../release-signing-context-artifact.mts");
const identities = await import("../assembler-job-identity.mts");
const { releaseCanonicalDigest: digest } = await import("../release-canonical.mts");
let clock = 59000;
Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
type Mode = "current" | "stale-controls" | "expired-after-controls";
let mode: Mode = "current";
let events: string[] = [];
let effects = 0;
let keys = 0;
let workers = 0;
const identity = {
  audience: "portcove-capacity-executor",
  subject: identities.controllerOidcSubject(
    "refs/tags/portcove-production-controller-test",
    "production-tuf-releases",
  ),
  controller_revision: "a".repeat(40),
  controller_ref: "refs/tags/portcove-production-controller-test",
  actor_id: "1234",
  run_id: "12345",
  run_attempt: 1,
};
const toolsReceipt = Object.freeze({ fixture: "tools" });
const contextReceipt = Object.freeze({ fixture: "context" });
const executor = Object.freeze({ fixture: "executor" });
const opportunity = { fixture: "same opportunity" };
const pause = { publication_paused: false };
const capacity = { fixture: "same capacity" };
const manifest = {
  kind: "release-signing-context",
  controller: { ...identity, source_tree: "b".repeat(40) },
  binding: { version: "0.1.0" },
  facts: {
    configuration: { namespace: "fixture" },
    opportunity,
    assembly: {},
    archives: [],
  },
  facts_sha256: digest({ fixture: "facts" }),
  control_facts: { pause, capacity, classification: { fixture: "same classification" } },
};
const snapshot = {
  checkpoint: "c".repeat(40),
  repository: "fixture repository",
  input: { active_candidate: { frozen_opportunity: opportunity } },
};
function dependency(name: string, exports: Record<string, unknown>) {
  mock.module(new URL(`../${name}.mts`, import.meta.url).href, { namedExports: exports });
}
dependency("release-tuf-signing", {
  inspectTufSigningRole: signing.inspectTufSigningRole,
  tufRoleDependencies: signing.tufRoleDependencies,
  decodeTufRoleKey: forbidden,
  signIsolatedTufRole: () => {
    workers++;
    return forbidden();
  },
});
dependency("release-signing-context-artifact", {
  signingContextRemaining: contexts.signingContextRemaining,
  requireReceivedSigningContext: (receipt: object) => {
    assert.equal(receipt, contextReceipt);
    return { manifest, directory: "fixture context", context: "fixture/context.json" };
  },
  requireRetainedSigningContext: (receipt: object) => {
    assert.equal(receipt, contextReceipt);
    events.push("retained context");
  },
  receiveSigningContextArtifact: forbidden,
  receiveMetadataSigningContextArtifact: forbidden,
});
dependency("release-tuf-role-artifact", {
  requireReceivedTufRoleArtifact: forbidden,
  requireRetainedTufRoleArtifact: forbidden,
  receiveTufRoleArtifact: forbidden,
  tufRolePredicateType: "fixture predicate",
});
dependency("release-controller-tool-admission", {
  verifiedControllerToolPaths: (receipt: object) => {
    assert.equal(receipt, toolsReceipt);
    events.push("tools");
    return { identity: manifest.controller, rust: "fixture tool" };
  },
  receiveControllerTools: forbidden,
});
dependency("release-controller-tools", {
  readControllerToolFile: (file: string) => {
    assert.equal(file, path.join("fixture context", "signing-context-manifest.json"));
    return Buffer.from(JSON.stringify(manifest));
  },
});
dependency("release-authority-configuration", {
  requireControllerApplicationJobPublicationAuthorities: (phase: string) => {
    assert.equal(phase, "tuf-releases");
    return { namespace: "fixture", dispatch_actor_id: identity.actor_id };
  },
});
dependency("release-capacity-executor", {
  authenticateCapacityExecutor: () => executor,
  capacityExecutorIdentity: (receipt: object) => {
    assert.equal(receipt, executor);
    return { fixture: "inert producer" };
  },
  refreshCapacityExecutor: forbidden,
  executeOwnedCapacityEffect: (receipt: object) => {
    assert.equal(receipt, executor);
    effects++;
    events.push("inert effect boundary");
    throw new Error("Inert effect boundary: no execution authority");
  },
});
dependency("release-live-control-admission", {
  authenticateReleaseControlRound: () => ({
    evidence_scope: "github.com",
    read: () => {
      events.push(`controls:${clock}`);
      const current = {
        pause: { publication_paused: mode === "stale-controls" && clock >= 60000 },
        resource_policy_matches_controller: true,
        capacity,
        classification: manifest.control_facts.classification,
      };
      if (mode === "expired-after-controls") clock = 116000;
      return current;
    },
  }),
});
dependency("github-api", {
  createGitHubRunner: forbidden,
  GitHubApiClient: class {
    request = forbidden;
    graphql = forbidden;
  },
});
dependency("release-coordinator-recovery", {
  recoverRemoteCoordinator: () => {
    events.push("initial recovery");
    return snapshot;
  },
  readRemoteCoordinatorSnapshot: () => {
    if (mode === "stale-controls") clock = 61000;
    events.push(`guarded snapshot:${clock}`);
    return snapshot;
  },
});
dependency("production-aggregate-steps", {
  requireReservedAggregate: (raw: string, state: object) => {
    assert.equal(state, snapshot);
    const descriptor: unknown = JSON.parse(raw);
    assert.ok(descriptor && typeof descriptor === "object");
    assert.equal(Reflect.get(descriptor, "checkpoint"), snapshot.checkpoint);
    events.push(`reservation:${clock}`);
  },
});
dependency("release-role-key-channel", {
  receiveIsolatedRoleKey: () => {
    keys++;
    return forbidden();
  },
});
dependency("release-signing-handoff", { handoffSigningOutput: forbidden });
const entry = new URL("../release-tuf-controller.mts", import.meta.url);
entry.searchParams.set("portcove-controller-guard", "actual");
const { runTufRoleController } = (await import(
  entry.href
)) as typeof import("../release-tuf-controller.mts");
const results = [];
for (const selected of ["current", "stale-controls", "expired-after-controls"] as const) {
  mode = selected;
  clock = 59000;
  events = [];
  effects = 0;
  keys = 0;
  workers = 0;
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-tuf-controller-guard-"));
  try {
    await assert.rejects(
      runTufRoleController("releases", identity, toolsReceipt, contextReceipt, [], root, 115000),
      /fixed TUF role controller refused; retain public evidence/u,
    );
    // Generic production refusal cannot turn a setup error, wrong guard or
    // later defensive refusal into success for the boundary under test.
    assert.equal(keys, 0, `TUF_CONTROLLER_NO_KEY:${mode}`);
    assert.equal(workers, 0, `TUF_CONTROLLER_NO_WORKER:${mode}`);
    assert.equal(effects, mode === "current" ? 1 : 0, `TUF_CONTROLLER_EFFECT_BOUNDARY:${mode}`);
    assert.deepEqual(
      events.filter((event) => event.startsWith("controls:")),
      [mode === "stale-controls" ? "controls:61000" : "controls:59000"],
      `TUF_CONTROLLER_CONTROL_OBSERVATION:${mode}`,
    );
    const guarded = events.findIndex((event) => event.startsWith("guarded snapshot:"));
    const reservation = events.findIndex(
      (event, index) => index > guarded && event.startsWith("reservation:"),
    );
    const control = events.findIndex((event) => event.startsWith("controls:"));
    assert.ok(
      guarded >= 0 && reservation > guarded && control > reservation,
      `TUF_CONTROLLER_GUARD_ORDER:${mode}`,
    );
    assert.equal(clock, mode === "current" ? 59000 : mode === "stale-controls" ? 61000 : 116000);
    const files = await readdir(root);
    assert.equal(files.length, 2, "One controller session and one private evidence directory");
    const session: unknown = JSON.parse(
      await readFile(path.join(root, "tuf-releases-session.json"), "utf8"),
    );
    assert.ok(session && typeof session === "object");
    const directory: unknown = Reflect.get(session, "directory");
    assert.equal(typeof directory, "string");
    assert.ok(typeof directory === "string" && path.dirname(directory) === root);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(String(directory), "refusal.json"), "utf8")),
      {
        phase: "current-reservation",
        role: "releases",
        authority: "none",
      },
    );
    assert.deepEqual(await readdir(String(directory)), ["refusal.json"]);
    results.push({ mode, clock, effects, keys, workers, events: [...events] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify({
    scope: "whole controller; inert authentication observations; no signing authority",
    scenarios: results,
  }),
);
