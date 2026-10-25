import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscoverySession } from "./daily-discovery-session.mts";
import { observationHash } from "./upstream-observer.mts";
import {
  reconcileDiscoveryIdentity,
  reconcileDiscoverySnapshot,
} from "./discovery-reconciliation.mts";
import type {
  CanonicalDiscoveryIdentity,
  ReviewedDiscoveryIdentity,
} from "./discovery-reconciliation.mts";
const existing: CanonicalDiscoveryIdentity = {
  repository: "original/game",
  repository_id: 42,
  game_key: "game-a",
  issue: 17,
  state: "OPEN",
  aliases: ["old-owner/old-name"],
};
const candidate: ReviewedDiscoveryIdentity = {
  repository: "original/game",
  repository_id: 42,
  game_key: "game-a",
  kind: "implementation",
};
void test("maintained session guard blocks a relocated closed owner and helpers before posting, but preserves separate games and implementations", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "discovery-identity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "primary.json");
  const writePrimary = (id: number) =>
    writeFileSync(file, JSON.stringify({ metadata: { id, full_name: "new-owner/new-name" } }));
  writePrimary(42);
  const session = Object.create(DiscoverySession.prototype) as DiscoverySession;
  Object.assign(session, {
    inventory: {
      issues: [
        {
          id: "I_42",
          number: 900001,
          type: "Issue",
          title: "[Port] Old name",
          state: "CLOSED",
          body: "Underlying game: **Game A**.\nGitHub repository ID: 42.\n<!-- portcove-port -->\n<!-- portcove-upstream: https://github.com/old-owner/old-name -->",
        },
      ],
    },
    leads: { records: {} },
    journal: {
      evidence: {
        primary: {
          repository: "new-owner/new-name",
          file,
          material: "pinned",
          requests: 1,
          bytes: 100,
        },
      },
    },
  });
  const input = {
    id: "reviewed",
    kind: "intake" as const,
    title: "Renamed implementation",
    upstream: "https://github.com/new-owner/new-name",
    portKey: "renamed-key",
    body: "reviewed body",
    body_sha256: "a".repeat(64),
    evidence_ids: ["primary"],
    evidence_sha256: "b".repeat(64),
    status: "reviewed",
  };
  const scoped = (game: string) => ({
    ...input,
    game,
    body: `<!-- portcove-discovery-identity:${observationHash({ game, kind: "implementation" })} -->\nreviewed body`,
  });
  assert.throws(() => session.assertIntakeIdentity(input, []), /Existing canonical owner/u);
  assert.throws(
    () => session.assertIntakeIdentity(scoped("Game A"), []),
    /Existing canonical owner/u,
  );
  assert.equal(
    session.assertIntakeIdentity(scoped("Game B"), []).disposition,
    "New canonical intake",
  );
  writePrimary(99);
  assert.equal(
    session.assertIntakeIdentity(scoped("Game A"), []).disposition,
    "New canonical intake",
  );
  assert.throws(
    () =>
      session.assertIntakeIdentity(
        {
          ...input,
          identity_kind: "helper",
          body: `<!-- portcove-discovery-identity:${observationHash({ game: null, kind: "helper" })} -->`,
        },
        [],
      ),
    /Alias\/helper/u,
  );
  assert.throws(
    () => session.assertIntakeIdentity({ ...scoped("Game A"), game: "Game B" }, []),
    /Reviewed body/u,
  );
});
void test("frozen replay merges source observations, preserves separate games and refuses key conflicts", () => {
  const rows = [
    { ...candidate, key: "game-a-port", evidence: "framework-page" },
    { ...candidate, key: "game-a-port", evidence: "direct-repository" },
    { ...candidate, game_key: "game-b", key: "game-b-port", evidence: "index" },
  ];
  const first = reconcileDiscoverySnapshot(rows, [existing]);
  assert.equal(first.length, 2);
  assert.deepEqual(first[0]!.evidence, ["direct-repository", "framework-page"]);
  assert.equal(first[0]!.disposition, "Existing canonical owner");
  assert.equal(first[1]!.disposition, "New canonical intake");
  assert.deepEqual(reconcileDiscoverySnapshot([...rows].reverse(), [existing]), first);
  assert.throws(
    () => reconcileDiscoverySnapshot([...rows, { ...rows[0]!, repository_id: 99 }], [existing]),
    /conflicting/u,
  );
});
void test("exact repository, transferred/renamed ID and explicit alias all reuse canonical ownership", () => {
  for (const input of [
    candidate,
    { ...candidate, repository: "new-owner/new-name" },
    { repository: "old-owner/old-name", kind: "implementation" as const, game_key: "game-a" },
  ])
    assert.deepEqual(reconcileDiscoveryIdentity(input, [existing]).issues, [17]);
  assert.equal(
    reconcileDiscoveryIdentity({ ...candidate, repository_id: 43 }, [existing]).disposition,
    "Identity conflict",
  );
});
void test("same game independent implementation stays separate; launcher/helper never duplicates its target", () => {
  assert.equal(
    reconcileDiscoveryIdentity(
      { ...candidate, repository: "independent/game", repository_id: 99 },
      [existing],
    ).disposition,
    "New canonical intake",
  );
  assert.equal(
    reconcileDiscoveryIdentity(
      { repository: "helper/launcher", kind: "helper", helper_for: candidate },
      [existing],
    ).disposition,
    "Alias/helper",
  );
  assert.equal(
    reconcileDiscoveryIdentity({ repository: "helper/installer", kind: "helper" }, [existing])
      .issues.length,
    0,
  );
});
void test("a multi-game implementation resolves by game identity, not repository alone", () => {
  const second = { ...existing, issue: 18, game_key: "game-b" };
  assert.deepEqual(reconcileDiscoveryIdentity(candidate, [existing, second]).issues, [17]);
  assert.deepEqual(
    reconcileDiscoveryIdentity({ ...candidate, game_key: "game-b" }, [existing, second]).issues,
    [18],
  );
  assert.equal(
    reconcileDiscoveryIdentity(
      { repository: candidate.repository, repository_id: 42, kind: "implementation" },
      [existing, second],
    ).disposition,
    "Identity ambiguous",
  );
  assert.equal(
    reconcileDiscoveryIdentity({ ...candidate, game_key: "game-c" }, [existing, second])
      .disposition,
    "New canonical intake",
  );
});
void test("closed/deferred owners and repeated cross-source/framework discoveries remain quiet", () => {
  const closed = { ...existing, state: "CLOSED" as const };
  for (const _source of ["framework-downstream", "direct-repository", "community", "index"])
    assert.equal(
      reconcileDiscoveryIdentity(candidate, [closed]).disposition,
      "Existing canonical owner",
    );
  assert.equal(
    reconcileDiscoveryIdentity({ ...candidate, kind: "framework" }, [closed]).disposition,
    "Shared infrastructure",
  );
  const plan = reconcileDiscoveryIdentity(
    { ...candidate, repository: "other/port", repository_id: 77 },
    [closed],
  );
  assert.equal(plan.disposition, "New canonical intake");
  const readback = {
    ...candidate,
    repository: "other/port",
    repository_id: 77,
    issue: 19,
    state: "OPEN" as const,
  };
  assert.equal(
    reconcileDiscoveryIdentity(readback, [closed, readback]).disposition,
    "Existing canonical owner",
  );
  assert.deepEqual(
    reconcileDiscoveryIdentity(readback, [closed, readback]),
    reconcileDiscoveryIdentity(readback, [closed, readback]),
  );
});
