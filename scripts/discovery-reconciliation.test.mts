import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscoverySession } from "./daily-discovery-session.mts";
import { observationHash } from "./upstream-observer.mts";
import { assertDiscoveryIntakeIdentity } from "./discovery-intake-identity.mts";
import { reconcilePortIssueMarkers } from "./roadmap.mts";
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
void test("reviewed family aliases retain closed ownership through normalized bodies and transfers", () => {
  const body = reconcilePortIssueMarkers(
    "Underlying game: **Game A**.\nGitHub repository ID: 42.\nReviewed source-family alias: https://github.com/contributor/game-linux (GitHub repository ID: 201)\nRelationship: Reviewed host adaptation; primary credits retained.",
    { upstream: "https://github.com/original/game", portKey: "game-a" },
  );
  assert.equal(
    reconcilePortIssueMarkers(body, {
      upstream: "https://github.com/original/game",
      portKey: "game-a",
    }),
    body,
  );
  assert.equal([...body.matchAll(/<!-- portcove-upstream:/gu)].length, 1);
  const issue = { number: 17, title: "[Port] Game A", state: "CLOSED", body };
  for (const identity of [
    { repository: "original/game", repository_id: 42 },
    { repository: "contributor/game-linux", repository_id: 201 },
    { repository: "new-owner/renamed", repository_id: 201 },
  ])
    assert.throws(
      () =>
        assertDiscoveryIntakeIdentity(
          { ...identity, game_key: "gamea", kind: "implementation" },
          [issue],
          [],
          [],
        ),
      /Existing canonical owner/u,
    );
  assert.throws(
    () =>
      assertDiscoveryIntakeIdentity(
        {
          repository: "contributor/game-linux",
          repository_id: 202,
          game_key: "gamea",
          kind: "implementation",
        },
        [issue],
        [],
        [],
      ),
    /Identity conflict/u,
  );
  assert.equal(
    assertDiscoveryIntakeIdentity(
      {
        repository: "independent/game",
        repository_id: 203,
        game_key: "gamea",
        kind: "implementation",
      },
      [issue],
      [],
      [],
    ).disposition,
    "New canonical intake",
  );
  assert.equal(
    assertDiscoveryIntakeIdentity(
      {
        repository: "contributor/game-linux",
        repository_id: 201,
        game_key: "gameb",
        kind: "implementation",
      },
      [issue],
      [],
      [],
    ).disposition,
    "New canonical intake",
  );
  const creditOnly = {
    ...issue,
    body: "Underlying game: **Game A**.\nCredits: https://github.com/contributor/game-linux\n<!-- portcove-upstream: https://github.com/original/game -->",
  };
  assert.equal(
    assertDiscoveryIntakeIdentity(
      {
        repository: "contributor/game-linux",
        repository_id: 201,
        game_key: "gamea",
        kind: "implementation",
      },
      [creditOnly],
      [],
      [],
    ).disposition,
    "New canonical intake",
  );
  for (const malformed of [
    "Reviewed source-family alias: https://github.com/a/b (GitHub repository ID: 9007199254740992)",
    "Reviewed source-family alias: https://example.com/a/b (GitHub repository ID: 201)",
    Array.from(
      { length: 17 },
      () => "Reviewed source-family alias: https://github.com/a/b (GitHub repository ID: 201)",
    ).join("\n"),
  ])
    assert.throws(
      () => assertDiscoveryIntakeIdentity(candidate, [{ ...issue, body: malformed }], [], []),
      /family alias/u,
    );
});
void test("catalog lineage binds normalized GitHub clone URLs to transferred closed owners", () => {
  const issue = {
    number: 17,
    title: "[Port] Original implementation",
    state: "CLOSED",
    body: "<!-- portcove-upstream: https://github.com/original/game -->",
  };
  for (const project_url of [
    "https://github.com/Original/Game/",
    "https://github.com/original/game.git/",
  ]) {
    assert.throws(
      () =>
        assertDiscoveryIntakeIdentity(
          candidate,
          [issue],
          [
            {
              format_version: 1,
              listing: {
                id: "original-game",
                name: "Game A",
                summary: "Game",
                project_url,
                issue_number: 17,
              },
              upstream_lineage: {
                format_version: 1,
                target_key: "original-game",
                origin: { project_url, repository: { host: "github.com", id: "42" } },
                decisions: [],
              },
            },
          ],
          [],
        ),
      /Existing canonical owner/u,
    );
    assert.throws(
      () =>
        assertDiscoveryIntakeIdentity(
          { ...candidate, repository: "new-owner/new-name" },
          [issue],
          [
            {
              format_version: 1,
              listing: {
                id: "original-game",
                name: "Game A",
                summary: "Game",
                project_url,
                issue_number: 17,
              },
              upstream_lineage: {
                format_version: 1,
                target_key: "original-game",
                origin: { project_url, repository: { host: "github.com", id: "42" } },
                decisions: [],
              },
            },
          ],
          [],
        ),
      /Existing canonical owner/u,
    );
  }
});
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
          ...scoped("Game A"),
          body:
            scoped("Game A").body +
            "\nReviewed source-family alias: https://github.com/old-owner/old-name (GitHub repository ID: 42)",
        },
        [],
      ),
    /Existing canonical owner/u,
  );
  const aliasCandidate = {
    ...scoped("Game A"),
    body:
      scoped("Game A").body +
      "\nReviewed source-family alias: https://github.com/contributor/variant (GitHub repository ID: 201)",
  };
  assert.equal(
    session.assertIntakeIdentity(aliasCandidate, []).disposition,
    "New canonical intake",
  );
  session.inventory.issues.push({
    number: 900002,
    title: "[Port] Existing variant",
    state: "CLOSED",
    body: "Underlying game: **Game A**.\nGitHub repository ID: 201.\n<!-- portcove-upstream: https://github.com/contributor/variant -->",
  });
  assert.throws(
    () => session.assertIntakeIdentity(aliasCandidate, []),
    /Existing canonical owner/u,
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
void test("host-only family variants reuse a closed owner across frozen source replay", () => {
  const closed = { ...existing, state: "CLOSED" as const };
  const linux: ReviewedDiscoveryIdentity = {
    repository: "contributor/game-linux",
    repository_id: 201,
    game_key: "game-a",
    kind: "helper",
    helper_for: candidate,
  };
  const android: ReviewedDiscoveryIdentity = {
    ...linux,
    repository: "contributor/game-android",
    repository_id: 202,
  };
  const sources = [
    { ...linux, key: "linux-family-variant", evidence: "parent-credits" },
    { ...linux, key: "linux-family-variant", evidence: "direct-repository" },
    { ...android, key: "android-family-variant", evidence: "direct-repository" },
  ];
  const first = reconcileDiscoverySnapshot(sources, [closed]);
  assert.equal(first.length, 2);
  for (const row of first) {
    assert.equal(row.disposition, "Alias/helper");
    assert.deepEqual(row.issues, [17]);
  }
  assert.deepEqual(reconcileDiscoverySnapshot([...sources].reverse(), [closed]), first);
  assert.equal(
    reconcileDiscoveryIdentity(
      { ...candidate, repository: "independent/game-runtime", repository_id: 203 },
      [closed],
    ).disposition,
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
