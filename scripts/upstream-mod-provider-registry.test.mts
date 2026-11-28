import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { observeReciprocalThunderstoreDocument } from "./port-upstream-facts.mts";
import {
  observeModProviderRegistry,
  validateModProviderRegistryProgress,
} from "./upstream-mod-provider-registry.mts";
import { observationHash } from "./upstream-observer.mts";

const now = Date.parse("2026-11-28T00:00:00Z");

void test("retains only bounded GitHub document pointers from the provider registry", async () => {
  const urls = {
    root: "https://github.com/SomeOwner/Port?tab=readme-ov-file#creating-mods",
    document: "https://github.com/SomeOwner/OtherPort/blob/main/docs/Mods.md",
    wiki: "https://github.com/SomeOwner/OtherPort/wiki/Getting-Started",
    credentials: "https://example.org@github.com/SomeOwner/Port",
    lookalike: "https://github.com.example.org/SomeOwner/Port",
    encoded: "https://github.com/SomeOwner/Port/blob/main/docs/mods%2Fguide.md",
    gamebanana: "https://gamebanana.com/games/16121/",
  };
  const communities = Object.fromEntries(
    Object.entries(urls).map(([label, wikiUrl]) => [label, { wikiUrl, listed: true }]),
  );
  const games = Object.fromEntries(
    Object.entries(communities).map(([label, thunderstore], index) => [
      label,
      {
        label,
        uuid: `da521cd3-560c-45df-8f43-${String(index).padStart(12, "0")}`,
        thunderstore,
      },
    ]),
  );
  const result = await observeModProviderRegistry(undefined, {
    now: () => now,
    timeout: 1_000,
    cadenceMs: 60_000,
    staleAfterMs: 120_000,
    responseBytes: 4_096,
    fetch: async () => Response.json({ schemaVersion: "0.3.0", games, communities }),
  });
  validateModProviderRegistryProgress(result.progress, now);
  const checkpoint = result.progress.last_complete;
  assert.ok(checkpoint);
  assert.deepEqual(
    checkpoint.communities.flatMap(({ community, github_document }) =>
      github_document ? [[community, github_document]] : [],
    ),
    [
      ["document", { repository: "SomeOwner/OtherPort", ref: "main", path: "docs/Mods.md" }],
      ["root", { repository: "SomeOwner/Port", ref: null, path: null }],
    ],
  );
  assert.equal(
    checkpoint.communities.find(({ community }) => community === "gamebanana")?.gamebanana_game,
    16121,
  );

  const legacy = structuredClone(result.progress);
  assert.ok(legacy.last_complete);
  for (const community of legacy.last_complete.communities) delete community.github_document;
  legacy.last_complete.communities_sha256 = observationHash(legacy.last_complete.communities);
  validateModProviderRegistryProgress(legacy, now);

  const injected = structuredClone(result.progress);
  assert.ok(injected.last_complete);
  const root = injected.last_complete.communities.find(({ community }) => community === "root");
  assert.ok(root);
  root.github_document = { repository: "SomeOwner/Port", ref: "main", path: "docs/../Mods.md" };
  injected.last_complete.communities_sha256 = observationHash(injected.last_complete.communities);
  assert.throws(() => validateModProviderRegistryProgress(injected, now), /community/u);
});

void test("binds a reciprocal link to the exact public repository, commit and document", async () => {
  const repository = { slug: "SomeOwner/SomePort", id: 18 };
  const document = { repository: repository.slug, path: null, ref: null };
  const commit = "a".repeat(40);
  const root = "repositories/18";
  const project = { id: repository.id, private: false, full_name: repository.slug };
  const link = "[Official mods](https://thunderstore.io/c/some-port/)";
  const readDocument = (
    text: string,
    options: { name?: string; badDigest?: boolean; failure?: boolean } = {},
  ) => {
    const requests: string[] = [];
    const read = async (endpoint: string) => {
      requests.push(endpoint);
      if (endpoint === root)
        return {
          status: "observed",
          body: { ...project, full_name: options.name ?? project.full_name },
        } as const;
      if (endpoint === `${root}/commits?per_page=1`)
        return { status: "observed", body: [{ sha: commit }] } as const;
      assert.equal(endpoint, `${root}/readme?ref=${commit}`);
      if (options.failure) return { status: "unavailable", reason: "provider-quota" } as const;
      const bytes = Buffer.from(text);
      const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      return {
        status: "observed",
        body: {
          type: "file",
          path: "README.md",
          encoding: "base64",
          size: bytes.length,
          content: bytes.toString("base64"),
          sha: options.badDigest ? "b".repeat(40) : sha,
        },
      } as const;
    };
    return { read, requests };
  };

  const positive = readDocument(link);
  const found = await observeReciprocalThunderstoreDocument(
    repository,
    document,
    "some-port",
    positive.read,
  );
  assert.equal(found.state, "observed");
  if (found.state === "observed") {
    assert.equal(found.commit, commit);
    assert.equal(found.repository_id, repository.id);
    assert.equal(found.sha256, createHash("sha256").update(link).digest("hex"));
  }
  assert.deepEqual(positive.requests, [
    root,
    `${root}/commits?per_page=1`,
    `${root}/readme?ref=${commit}`,
  ]);

  for (const rejected of [
    readDocument(`${link}\n[Other game](https://thunderstore.io/c/different/)`),
    readDocument("https://example.org/?link=https://thunderstore.io/c/some-port/"),
    readDocument(link, { name: "SomeoneElse/Replacement" }),
    readDocument(link, { badDigest: true }),
  ]) {
    const result = await observeReciprocalThunderstoreDocument(
      repository,
      document,
      "some-port",
      rejected.read,
    );
    assert.equal(result.state, "held");
  }
  const failure = readDocument(link, { failure: true });
  const result = await observeReciprocalThunderstoreDocument(
    repository,
    document,
    "some-port",
    failure.read,
  );
  assert.equal(result.state, "unavailable");
});
