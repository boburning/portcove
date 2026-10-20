import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  inspectImmutableReleaseSettlement,
  proposeImmutableReleaseTransition,
  readImmutableReleaseState,
  performImmutableReleaseEffect,
  advanceImmutableReleasePublication,
} from "./release-immutable-publication.mts";

import { capacityDigest } from "./release-capacity.mts";

const base = "repos/boburning/portcove";
function fixture() {
  const data = new Map([
    ["Portcove.exe", Buffer.from("inert opaque package")],
    ["Portcove.exe.sig", Buffer.from("inert signature; no signature claim")],
    ["SHA256SUMS.txt", Buffer.from("inert manifest")],
  ]);
  const identity = {
    version: "0.1.0-beta.1",
    source_commit: "a".repeat(40),
    assets: [...data].map(([filename, bytes]) => ({
      filename,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };
  const release = {
    id: 700,
    tag_name: `v${identity.version}`,
    target_commitish: identity.source_commit,
    prerelease: true,
    draft: true,
    immutable: false,
    url: `https://api.github.com/${base}/releases/700`,
    html_url: `https://github.com/boburning/portcove/releases/tag/untagged-fixture`,
    upload_url: `https://uploads.github.com/${base}/releases/700/assets{?name,label}`,
  };
  const assets = identity.assets.map((a, i) => ({
    id: 800 + i,
    name: a.filename,
    size: a.bytes,
    digest: `sha256:${a.sha256}`,
    state: "uploaded",
    url: `https://api.github.com/${base}/releases/assets/${800 + i}`,
    browser_download_url: `https://github.com/boburning/portcove/releases/download/untagged-fixture/${a.filename}`,
  }));
  const publish = () => {
    release.draft = false;
    release.immutable = true;
    release.html_url = `https://github.com/boburning/portcove/releases/tag/v${identity.version}`;
    for (const a of assets)
      a.browser_download_url = `https://github.com/boburning/portcove/releases/download/v${identity.version}/${a.name}`;
  };
  return { data, identity, release, assets, publish };
}

void test("draft-first transitions propose exactly one missing asset and publish only a complete exact inventory", () => {
  const f = fixture();
  const create = proposeImmutableReleaseTransition(f.identity, null, []);
  assert.equal(create.decision, "effect");
  if (create.decision !== "effect") throw Error("expected effect");
  assert.equal(create.effect.kind, "create-draft");
  assert.ok("body" in create.effect && create.effect.body.draft === true);
  for (let count = 0; count < f.assets.length; count++) {
    const step = proposeImmutableReleaseTransition(f.identity, f.release, f.assets.slice(0, count));
    assert.equal(step.decision, "effect");
    assert.ok(step.decision === "effect" && step.effect.kind === "upload-asset");
  }
  const ready = proposeImmutableReleaseTransition(f.identity, f.release, f.assets);
  assert.ok(ready.decision === "effect" && ready.effect.kind === "publish-draft");
  f.publish();
  const complete = proposeImmutableReleaseTransition(f.identity, f.release, f.assets);
  assert.equal(complete.decision, "complete");
  if (complete.decision === "complete") assert.equal(complete.immutable, true);
});

void test("published mutable/incomplete, starter, corrupt, unexpected and duplicate assets refuse without cleanup", () => {
  for (const kind of [
    "mutable",
    "incomplete",
    "starter",
    "digest",
    "duplicate",
    "unexpected",
  ] as const) {
    const f = fixture();
    f.publish();
    if (kind === "mutable") f.release.immutable = false;
    if (kind === "incomplete") f.assets.pop();
    if (kind === "starter") f.assets[0]!.state = "starter";
    if (kind === "digest") f.assets[0]!.digest = `sha256:${"f".repeat(64)}`;
    if (kind === "duplicate") f.assets[1]!.id = f.assets[0]!.id;
    if (kind === "unexpected") f.assets[0]!.name = "unrelated-evidence";
    assert.throws(() => proposeImmutableReleaseTransition(f.identity, f.release, f.assets));
  }
});

void test("complete inventory finds a retained draft and verifies actual version tag without relying on tag lookup", () => {
  const f = fixture();
  const calls: string[] = [];
  const api = {
    request(method: string, endpoint: string) {
      calls.push(endpoint);
      assert.equal(method, "GET");
      const body: unknown = endpoint.includes("/releases?")
        ? [f.release]
        : endpoint.includes("/assets?")
          ? f.assets
          : f.release;
      if (endpoint.includes("/git/ref/"))
        return { status: 404, headers: new Map<string, string>(), body: null };
      return { status: 200, headers: new Map<string, string>(), body };
    },
  };
  assert.equal(readImmutableReleaseState(api, f.identity).assets.length, f.assets.length);
  assert.ok(calls.every((call) => !call.includes("releases/tags/")));
  f.publish();
  assert.throws(() => readImmutableReleaseState(api, f.identity), /actual version tag/u);
});

void test("fixed write transport sends one bounded binary effect and never follows a redirect or retries refusal", async () => {
  const f = fixture();
  const step = proposeImmutableReleaseTransition(f.identity, f.release, []);
  assert.ok(step.decision === "effect" && step.effect.kind === "upload-asset");
  let calls = 0;
  const fetcher = (async (input: string | URL | Request, options?: RequestInit) => {
    calls++;
    assert.equal(typeof input, "string");
    assert.match(input as string, /^https:\/\/uploads.github.com\/repos\/boburning\/portcove\//u);
    assert.equal(options?.method, "POST");
    assert.equal(options?.redirect, "error");
    assert.equal(options?.credentials, "omit");
    return new Response(null, { status: 502 });
  }) as typeof fetch;
  await assert.rejects(
    performImmutableReleaseEffect(
      step.effect,
      f.data.get(step.effect.asset.filename)!,
      "inert-fixture-token",
      fetcher,
    ),
    /readback\/recovery/u,
  );
  assert.equal(calls, 1);
});

void test("imported accepted receipts cannot execute a Release operation", async () => {
  await assert.rejects(
    advanceImmutableReleasePublication(
      {} as Parameters<typeof advanceImmutableReleasePublication>[0],
      {
        recover: async () => {
          throw Error("must not read");
        },
        effect: async () => {
          throw Error("must not execute");
        },
        token: "inert",
      },
    ),
    /actual release preparation/u,
  );
});

void test("settlement binds the actual recovered capacity intent, checkpoint and callback evidence", () => {
  const candidate = {
    prepared_commit: "a".repeat(40),
    source_commit: "b".repeat(40),
    version: "0.1.0-beta.1",
    transient_retries: 0,
    substantive_repairs: 0,
  };
  const identity = {
    before_checkpoint: "c".repeat(40),
    candidate,
    destination:
      "github-release:boburning/portcove:v0.1.0-beta.1:create-draft:" + candidate.prepared_commit,
    executor_nonce: "d".repeat(64),
    kind: "upload",
    policy_sha256: "e".repeat(64),
    ratification_sha256: "f".repeat(64),
    sequence: 1,
  };
  const evidence = {
    remote_identity: "github-release:boburning/portcove:release:1:draft",
    evidence_sha256: "1".repeat(64),
  };
  const operation = {
    ...identity,
    id: capacityDigest(identity),
    outcome: "recovered",
    completed_effects: [evidence],
    failure_evidence: null,
    recovery: {
      checkpoint: "2".repeat(40),
      evidence_sha256: evidence.evidence_sha256,
      resolution: "effect-completed",
    },
  };
  const state = {
    checkpoint: "3".repeat(40),
    input: { controller: { capacity_attempt: { operation } } },
  };
  const expected = {
    checkpoint: state.checkpoint,
    operation_id: operation.id,
    before_checkpoint: identity.before_checkpoint,
    candidate,
    destination: identity.destination,
    ...evidence,
  };
  assert.equal(inspectImmutableReleaseSettlement(state, expected).id, operation.id);
  for (const changed of [
    { ...expected, checkpoint: "4".repeat(40) },
    { ...expected, operation_id: "4".repeat(64) },
    { ...expected, evidence_sha256: "4".repeat(64) },
    { ...expected, remote_identity: "other" },
    { ...expected, before_checkpoint: "4".repeat(40) },
    { ...expected, destination: "other" },
    { ...expected, candidate: { ...candidate, transient_retries: 1 } },
  ])
    assert.throws(() => inspectImmutableReleaseSettlement(state, changed));
  assert.throws(() =>
    inspectImmutableReleaseSettlement(
      {
        ...state,
        input: {
          controller: {
            capacity_attempt: { operation: { ...operation, outcome: "pending", recovery: null } },
          },
        },
      },
      expected,
    ),
  );
  assert.throws(() =>
    inspectImmutableReleaseSettlement(
      {
        ...state,
        input: {
          controller: {
            capacity_attempt: {
              operation: {
                ...operation,
                recovery: { ...operation.recovery, resolution: "partial-effects-retained" },
              },
            },
          },
        },
      },
      expected,
    ),
  );
});
