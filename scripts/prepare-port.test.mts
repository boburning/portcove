import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  collectPortFacts,
  githubRepository,
  githubReleaseRepository,
} from "./port-upstream-facts.mts";
import {
  preparePort,
  prepareArtworkBatch,
  portablePreparationFeedback,
  downloadPreparationFeedback,
  canonicalPreparationFeedback,
} from "./prepare-port.mts";
import { readCatalogSource } from "./catalog-authoring.mts";
import { createIgdbInspector } from "./inspect-igdb-artwork.mts";
import type { ListingReceipt } from "./catalog-authoring-inspector.mts";
import type { AuthoredPort } from "./catalog-authoring.mts";

void test("canonical preparation exposes the exact specification without deriving acquisition authority", () => {
  const record: AuthoredPort = {
    format_version: 1,
    listing: {
      id: "fixture",
      name: "Fixture",
      summary: "Fixture",
      project_url: "https://github.com/example/fixture",
      issue_number: 156,
      download_block_reason: "Retain the reviewed exact acquisition condition.",
    },
  };
  const before = structuredClone(record);
  const body =
    "## Scope\nExisting acquisition condition remains unresolved.\nDo not infer a grant from a published archive.\n";
  const feedback = canonicalPreparationFeedback(record, {
    observations: [
      {
        endpoint: "https://api.github.com/repos/boburning/portcove/issues/156",
        status: "reused",
        observed_at: "2026-10-25T00:00:00Z",
        body: { body },
      },
    ],
  })!;
  assert.equal(feedback.specification.status, "observed");
  assert.equal(feedback.specification.body_sha256, createHash("sha256").update(body).digest("hex"));
  assert.equal(feedback.specification.observed_at, "2026-10-25T00:00:00Z");
  assert.match(feedback.specification.location, /files.upstream/);
  assert.equal(feedback.authored_acquisition_condition, before.listing.download_block_reason);
  assert.match(feedback.next, /complete retained canonical specification/);
  assert.match(feedback.scope, /No prose is classified/);
  assert.deepEqual(record, before);
  const changed = canonicalPreparationFeedback(record, {
    observations: [
      {
        endpoint: "https://api.github.com/repos/boburning/portcove/issues/156",
        status: "observed",
        body: { body: body + "Changed condition." },
      },
    ],
  })!;
  assert.notEqual(changed.specification.body_sha256, feedback.specification.body_sha256);
  assert.equal(changed.authored_acquisition_condition, feedback.authored_acquisition_condition);
});

void test("canonical preparation keeps absent, unrelated and unavailable context explicit", () => {
  const record: AuthoredPort = {
    format_version: 1,
    listing: {
      id: "fixture",
      name: "Fixture",
      summary: "Fixture",
      project_url: "https://github.com/example/fixture",
      issue_number: 156,
    },
  };
  for (const observations of [
    [],
    [
      {
        endpoint: "https://api.github.com/repos/boburning/portcove/issues/157",
        status: "observed" as const,
        body: { body: "unrelated" },
      },
    ],
    [
      {
        endpoint: "https://api.github.com/repos/boburning/portcove/issues/156",
        status: "unavailable" as const,
        reason: "provider-backoff",
      },
    ],
    [
      {
        endpoint: "https://api.github.com/repos/boburning/portcove/issues/156",
        status: "observed" as const,
        body: { body: "PR", pull_request: {} },
      },
    ],
  ]) {
    const feedback = canonicalPreparationFeedback(record, { observations })!;
    assert.equal(feedback.specification.status, "not-observed");
    assert.equal(feedback.specification.body_sha256, null);
    assert.equal(feedback.authored_acquisition_condition, null);
    assert.match(feedback.next, /Roadmap context or prepare with --issue/);
  }
  const unowned = structuredClone(record);
  delete unowned.listing.issue_number;
  assert.equal(canonicalPreparationFeedback(unowned, { observations: [] }), undefined);
});

void test("portable preparation separates complete hint observations from lifecycle qualification", () => {
  const record: AuthoredPort = {
    format_version: 1,
    listing: {
      id: "fixture",
      name: "Fixture",
      summary: "Fixture",
      project_url: "https://github.com/example/fixture",
    },
    integration: {
      adapter: "native-portable",
      platforms: ["windows-x86-64"],
      release: { asset_hints: { "windows-x86-64": ["windows", "x64", ".zip"] } },
      persistent_paths: [],
    },
  };
  const asset = {
    id: 1,
    name: "game-windows-x64.zip",
    size: 42,
    browser_download_url: "https://github.com/example/fixture/releases/download/v1/game.zip",
    digest: `sha256:${"a".repeat(64)}`,
  };
  const partial = portablePreparationFeedback(record, { assets_complete: false, assets: [asset] })!;
  assert.match(partial.platforms[0]!.next, /incomplete/);
  assert.equal(partial.platforms[0]!.hint_matches[0]!.published_sha256, true);
  assert.equal(partial.launch_identity.original_game_title, null);
  assert.match(partial.launch_identity.next, /Supply listing.original_game_title/);
  const ambiguous = portablePreparationFeedback(record, {
    assets_complete: true,
    assets: [asset, { ...asset, id: 2, name: "other-windows-x64.zip", digest: null }],
  })!;
  assert.match(ambiguous.platforms[0]!.next, /exactly one/);
  assert.equal(ambiguous.platforms[0]!.hint_matches[1]!.published_sha256, false);
  const unique = portablePreparationFeedback(record, {
    assets_complete: true,
    assets: [
      asset,
      { ...asset, name: "game-windows-arm64.zip" },
      { ...asset, name: "game-windows-x64.zip.sha256" },
      { ...asset, name: "game-windows-x64.zip.exe" },
    ],
  })!;
  assert.equal(unique.platforms[0]!.hint_matches.length, 1);
  assert.match(unique.platforms[0]!.next, /does not establish fit/);
  assert.deepEqual(unique.persistence, []);
  assert.equal(unique.manual_setup.completion_record, null);
  assert.match(unique.manual_setup.next, /atomically published JSON/);
  assert.match(unique.manual_setup.next, /first-Play picker/);
  assert.match(unique.data_review, /empty contract needs evidence/);
  assert.match(unique.data_review, /compatible producer identity or supported invalidation/);
  const named = portablePreparationFeedback(
    { ...record, listing: { ...record.listing, original_game_title: "Actual game" } },
    { assets_complete: true, assets: [asset] },
  )!;
  assert.equal(named.launch_identity.original_game_title, "Actual game");
  assert.match(named.launch_identity.next, /separate from its implementation and helper names/);
  const versioned = portablePreparationFeedback(
    {
      ...record,
      integration: {
        ...record.integration,
        release: { asset_hints: { "windows-x86-64": ["Game-v1.2.3-windows-x64.zip"] } },
      },
    },
    {
      assets_complete: true,
      assets: [asset],
      release: {
        endpoint: "https://api.github.com/repos/example/game/releases/tags/v1.2.3",
        status: "observed",
        body: { tag_name: "v1.2.3" },
      },
    },
  )!;
  assert.deepEqual(versioned.maintenance.potential_version_restrictions, [
    { platform: "windows-x86-64", hints: ["Game-v1.2.3-windows-x64.zip"] },
  ]);
  assert.deepEqual(unique.maintenance.potential_version_restrictions, []);
  assert.match(versioned.maintenance.next, /supported exact pin/);
  assert.equal(
    portablePreparationFeedback(
      { format_version: 1, listing: record.listing },
      { assets_complete: true, assets: [] },
    ),
    undefined,
  );
});

void test("preparation preserves raw prerelease flags without inferring channels or mutating choices", () => {
  const record: AuthoredPort = {
    format_version: 1,
    listing: {
      id: "preview-fixture",
      name: "Preview fixture",
      summary: "Preview fixture",
      project_url: "https://github.com/example/fixture",
      recommended_download_channel: "stable",
      download_asset_hints: { "windows-x86-64": ["windows", ".zip"] },
    },
    integration: {
      adapter: "native-portable",
      platforms: ["windows-x86-64"],
      release: { asset_hints: { "windows-x86-64": ["windows", ".zip"] } },
      persistent_paths: [],
    },
  };
  const before = structuredClone(record);
  for (const [flag, expected] of [
    [false, false],
    [true, true],
    ["false", null],
    [undefined, null],
  ]) {
    const facts = {
      assets_complete: true,
      assets: [],
      release: {
        endpoint: "https://api.github.com/repos/example/fixture/releases/tags/v0.3-preview-1",
        status: "observed" as const,
        body: { tag_name: "v0.3-preview-1", prerelease: flag },
      },
    };
    for (const feedback of [
      portablePreparationFeedback(record, facts),
      downloadPreparationFeedback(record, facts),
    ]) {
      assert.equal(feedback?.maintenance.observed_release_tag, "v0.3-preview-1");
      assert.equal(feedback?.maintenance.observed_provider_prerelease, expected);
      assert.match(feedback.maintenance.next, /Core’s channel classification/);
    }
  }
  assert.equal(
    portablePreparationFeedback(record, { assets_complete: true, assets: [] })?.maintenance
      .observed_provider_prerelease,
    null,
  );
  assert.deepEqual(record, before);
});

const catalogRoot = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "crates",
  "portcove-core",
  "catalog",
);

void test("upstream setup hints expose incomplete and competing matches without granting a route", () => {
  const record: AuthoredPort = {
    format_version: 1,
    listing: {
      id: "installer",
      name: "Installer",
      summary: "Upstream setup",
      project_url: "https://github.com/example/game",
      download_asset_hints: { "windows-x86-64": ["-windows-setup.exe"] },
    },
  };
  const asset = { id: 1, name: "game-windows-setup.exe", digest: null };
  const partial = downloadPreparationFeedback(record, { assets_complete: false, assets: [asset] })!;
  assert.match(partial.platforms[0]!.next, /incomplete/);
  const ambiguous = downloadPreparationFeedback(record, {
    assets_complete: true,
    assets: [asset, { ...asset, id: 2, name: "other-windows-setup.exe" }],
  })!;
  assert.match(ambiguous.platforms[0]!.next, /exactly one/);
  assert.equal(ambiguous.platforms[0]!.hint_matches[0]!.published_sha256, false);
  assert.match(ambiguous.scope, /no package authentication/);
  assert.equal(record.integration, undefined);
});
const project = "https://github.com/example/fixture";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "port-prepare-"));
  const requests: string[] = [];
  const fetcher =
    (body: (url: string) => Response): typeof fetch =>
    async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      return body(url);
    };
  return { root, requests, fetcher, clean: () => rmSync(root, { recursive: true, force: true }) };
}
const json = (value: unknown, headers?: Record<string, string>) =>
  new Response(JSON.stringify(value), { status: 200, ...(headers ? { headers } : {}) });
const metadata = {
  id: 123,
  full_name: "example/fixture",
  name: "Fixture",
  description: "Fixture upstream project.",
};

void test("related release providers retain canonical identity, independent public facts and resumed bounded reads", async () => {
  const f = fixture();
  try {
    const provider = "https://github.com/example/launcher";
    const release = {
      id: 44,
      draft: false,
      tag_name: "chosen/tag",
      html_url: `${provider}/releases/tag/chosen%2Ftag`,
    };
    const asset = {
      id: 45,
      name: "setup.exe",
      size: 123,
      browser_download_url: `${provider}/releases/download/chosen%2Ftag/setup.exe`,
    };
    const options = {
      projectUrl: project,
      route: "download" as const,
      releaseUrl: `${provider}/releases/tag/not-a-pin`,
      releaseTag: "chosen/tag",
      cacheDirectory: f.root,
      fetcher: f.fetcher((url) =>
        url.endsWith("/repos/example/fixture")
          ? json(metadata)
          : url.endsWith("/repos/example/launcher")
            ? json({ id: 456, full_name: "example/launcher", private: false })
            : url.endsWith("/tags/chosen%2Ftag")
              ? json(release)
              : url.includes("/assets?")
                ? json([asset])
                : assert.fail(`Unexpected request ${url}`),
      ),
    };
    const first = await collectPortFacts(options);
    assert.equal(first.repository, "example/fixture");
    assert.deepEqual(first.project?.body, metadata);
    assert.equal(first.release_repository, "example/launcher");
    assert.deepEqual(first.release_project?.body, {
      id: 456,
      full_name: "example/launcher",
      private: false,
    });
    assert.equal(first.assets_complete, true);
    assert.equal(first.usage.requests, 4);
    const resumed = await collectPortFacts(options);
    assert.equal(resumed.usage.requests, 0);
    assert.equal(resumed.release_project?.status, "reused");
    assert.equal(f.requests.length, 4);
    assert.ok(f.requests.every((url) => !url.includes("not-a-pin")));
  } finally {
    f.clean();
  }
});

void test("related release providers refuse private, unknown, invalid and conflicting origins", async () => {
  for (const providerMetadata of [
    { ...metadata, private: true },
    { ...metadata, private: false },
    { full_name: "example/launcher" },
  ]) {
    const f = fixture();
    try {
      await assert.rejects(
        collectPortFacts({
          projectUrl: project,
          route: "download",
          releaseUrl: "https://github.com/example/launcher/releases",
          cacheDirectory: f.root,
          fetcher: f.fetcher((url) =>
            json(url.endsWith("/repos/example/fixture") ? metadata : providerMetadata),
          ),
        }),
        /matching observed public/,
      );
      assert.equal(f.requests.length, 2);
    } finally {
      f.clean();
    }
  }
  for (const url of [
    "",
    "http://github.com/example/helper",
    "https://user@github.com/example/helper",
    "https://github.com:8443/example/helper",
    "https://github.com/example/a%2Fb",
    "https://github.com//example/helper",
    "https://github.com/example//helper",
    `https://github.com/example/${"x".repeat(99)}.git`,
    "https://example.com/example/helper",
    `https://github.com/example/${"x".repeat(101)}`,
  ])
    assert.throws(() => githubReleaseRepository(url));
  const f = fixture();
  try {
    await assert.rejects(
      collectPortFacts({
        projectUrl: project,
        route: "download",
        releaseUrl: "https://github.com/example/launcher/releases",
        releaseTag: "v1",
        cacheDirectory: f.root,
        fetcher: f.fetcher((url) =>
          json(
            url.endsWith("/repos/example/fixture")
              ? metadata
              : url.endsWith("/repos/example/launcher")
                ? { id: 456, private: false, full_name: "example/launcher" }
                : { id: 5, tag_name: "v1", draft: false, html_url: `${project}/releases/tag/v1` },
          ),
        ),
      }),
      /provenance conflicts/,
    );
    assert.equal(f.requests.length, 3);
    await assert.rejects(
      collectPortFacts({
        projectUrl: project,
        route: "download",
        releaseUrl: project,
        resolveReleaseUrl: () => project,
        cacheDirectory: f.root,
      }),
      /either an explicit/,
    );
    assert.equal(f.requests.length, 3);
  } finally {
    f.clean();
  }
});

void test("ordinary listing fetches identity only, shares fresh observations and preserves stale facts after outage", async () => {
  const f = fixture();
  try {
    let time = Date.now();
    const options = {
      projectUrl: project,
      cacheDirectory: f.root,
      now: () => time,
      fetcher: f.fetcher(() => json(metadata)),
    };
    const first = await collectPortFacts(options);
    assert.equal(first.project?.status, "observed");
    assert.deepEqual(f.requests, ["https://api.github.com/repos/example/fixture"]);
    const cache = join(f.root, readdirSync(f.root)[0]!);
    const accepted = readFileSync(cache, "utf8");
    const second = await collectPortFacts(options);
    assert.equal(second.project?.status, "reused");
    assert.equal(f.requests.length, 1);
    time += 86400001;
    const failed = await collectPortFacts({
      ...options,
      fetcher: f.fetcher(() => new Response("offline", { status: 503 })),
    });
    assert.equal(failed.project?.status, "unavailable");
    assert.deepEqual(failed.project?.previous_observation?.body, metadata);
    assert.equal(failed.project?.body, undefined);
    assert.equal(readFileSync(cache, "utf8"), accepted);
  } finally {
    f.clean();
  }
});

void test("download collection selects one release and reports incomplete assets without walking history", async () => {
  const f = fixture();
  try {
    const result = await collectPortFacts({
      projectUrl: project,
      route: "download",
      releaseTag: "v1",
      cacheDirectory: f.root,
      fetcher: f.fetcher((url) =>
        url.includes("/assets?")
          ? json(
              [
                {
                  id: f.requests.length,
                  name: "file.zip",
                  size: 42,
                  browser_download_url: `${project}/releases/download/v1/file.zip`,
                },
              ],
              {
                link: '<https://api.github.com/ignored>; rel="next"',
              },
            )
          : url.endsWith("/releases/tags/v1")
            ? json({ id: 12, draft: false, tag_name: "v1" })
            : json(metadata),
      ),
    });
    assert.equal(result.assets_complete, false);
    assert.equal(result.assets.length, 2);
    assert.equal(f.requests.length, 4);
    assert.ok(f.requests.every((url) => !url.includes("readme") && !url.includes("git/ref")));
    assert.ok(f.requests.every((url) => !url.includes("page=3")));
    assert.equal(result.usage.requests, 4);
  } finally {
    f.clean();
  }
});

void test("current release window and a canonical issue keep incomplete searches explicit", async () => {
  const f = fixture();
  try {
    const result = await collectPortFacts({
      issue: "156",
      route: "download",
      cacheDirectory: f.root,
      fetcher: f.fetcher((url) =>
        url.endsWith("/issues/156")
          ? json({
              title: "[Port] Fixture",
              body: `<!-- portcove-port-key: fixture -->\n<!-- portcove-upstream: ${project} -->`,
            })
          : url.includes("/releases?")
            ? json([{ id: 9, tag_name: "v2" }], {
                link: '<https://api.github.com/next>; rel="next"',
              })
            : json(metadata),
      ),
    });
    assert.equal(result.issue?.id, "fixture");
    assert.equal(result.release_candidates?.next_page, true);
    assert.equal(result.assets_complete, false);
    assert.equal(f.requests.length, 3);
  } finally {
    f.clean();
  }
});

void test("complete selected-release observations reuse exact assets and do not certify a platform", async () => {
  const f = fixture();
  try {
    const release = {
      id: 12,
      draft: false,
      tag_name: "v1",
      html_url: `${project}/releases/tag/v1`,
    };
    const asset = {
      id: 9,
      name: "upstream.zip",
      size: 42,
      browser_download_url: `${project}/releases/download/v1/upstream.zip`,
    };
    const options = {
      catalogRoot,
      outputDirectory: join(f.root, "output"),
      projectUrl: project,
      id: "prepare-download-fixture",
      route: "download" as const,
      releaseTag: "v1",
      facts: {
        fetcher: f.fetcher((url) =>
          url.includes("/assets?")
            ? json([asset])
            : url.includes("/releases/tags/")
              ? json(release)
              : json(metadata),
        ),
      },
      artwork: { inspectGame: () => [] },
    };
    const first = await preparePort(options);
    const record = JSON.parse(readFileSync(first.report.files.records[0]!.path, "utf8")) as {
      listing: { release_url: string; availability?: string; platforms?: string[] };
    };
    assert.equal(record.listing.release_url, release.html_url);
    assert.equal(record.listing.availability, undefined);
    assert.equal(record.listing.platforms, undefined);
    assert.equal(f.requests.length, 3);
    await preparePort(options);
    assert.equal(f.requests.length, 3);
  } finally {
    f.clean();
  }
});

void test("provider backoff survives resume and malformed cache bytes are not overwritten", async () => {
  const f = fixture();
  try {
    const now = Date.now();
    const options = {
      projectUrl: project,
      cacheDirectory: f.root,
      now: () => now,
      fetcher: f.fetcher(
        () => new Response("limited", { status: 429, headers: { "retry-after": "60" } }),
      ),
    };
    await collectPortFacts(options);
    const resumed = await collectPortFacts(options);
    assert.equal(resumed.project?.reason, "provider-backoff");
    assert.equal(f.requests.length, 1);
    const retry = join(f.root, readdirSync(f.root)[0]!);
    writeFileSync(retry, "malformed");
    await assert.rejects(collectPortFacts(options), SyntaxError);
    assert.equal(readFileSync(retry, "utf8"), "malformed");
    assert.equal(f.requests.length, 1);
  } finally {
    f.clean();
  }
});

void test("one-port preparation is resumable, keeps accepted sources unchanged and uses cover fallback", async () => {
  const f = fixture();
  try {
    const accepted = readCatalogSource(catalogRoot);
    const sourceBytes = readFileSync(join(catalogRoot, "catalog-current-authoring.json"), "utf8");
    const options = {
      catalogRoot,
      outputDirectory: join(f.root, "output"),
      projectUrl: project,
      id: "prepare-fixture",
      facts: { fetcher: f.fetcher(() => json(metadata)) },
      artwork: {
        inspectGame: () => {
          throw new Error("provider unavailable");
        },
      },
    };
    const first = await preparePort(options);
    const again = await preparePort(options);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(first.report.files.records, again.report.files.records);
    assert.equal(first.report.operational_changed, false);
    assert.ok(first.report.preparation_costs.elapsed_ms >= 0);
    const directory = JSON.parse(readFileSync(first.report.files.listings, "utf8")) as {
      listings: { id: string; artwork?: unknown }[];
    };
    assert.equal(directory.listings.length, accepted.records.length + 1);
    assert.equal(
      directory.listings.find((listing) => listing.id === "prepare-fixture")?.artwork,
      undefined,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(first.report.files.catalog, "utf8")),
      accepted.catalog,
    );
    assert.equal(
      readFileSync(join(catalogRoot, "catalog-current-authoring.json"), "utf8"),
      sourceBytes,
    );
    assert.deepEqual(readCatalogSource(catalogRoot), accepted);
    const evidence = JSON.parse(readFileSync(first.report.files.artwork, "utf8")) as {
      records: { reason: string }[];
      workset: { selected_port_ids: string[] };
    };
    assert.equal(evidence.records[0]?.reason, "generated-fallback");
    assert.deepEqual(evidence.workset.selected_port_ids, ["prepare-fixture"]);
  } finally {
    f.clean();
  }
});

void test("reviewed original title reaches bounded cover lookup after a coverless port", async () => {
  const f = fixture();
  try {
    const identities: unknown[] = [];
    const result = await preparePort({
      catalogRoot,
      outputDirectory: join(f.root, "output"),
      record: {
        format_version: 1,
        listing: {
          id: "original-title-fixture",
          name: "Fixture port",
          original_game_title: "Original fixture game",
          summary: "Reviewed upstream remake of the original fixture game.",
          project_url: project,
        },
      },
      facts: { fetcher: f.fetcher(() => json(metadata)) },
      artwork: {
        inspectGame: (identity) => {
          identities.push(identity);
          return identity.kind === "port"
            ? [{ id: 70, slug: "fixture-port", name: "Fixture port", websites: [{ url: project }] }]
            : [
                {
                  id: 71,
                  slug: "original-fixture-game",
                  name: "Original fixture game",
                  cover: { id: 72, image_id: "originalfixture" },
                },
              ];
        },
        inspectImage: () => ({
          sha256: "b".repeat(64),
          bytes: 100,
          width: 264,
          height: 374,
          format: "jpeg",
          validator: "portcove-core",
        }),
      },
    });
    assert.equal(identities.length, 2);
    assert.deepEqual(identities[1], {
      kind: "underlying-game",
      game_id: null,
      slug: null,
      names: ["Original fixture game"],
      evidence_url: project,
      project_url: project,
      platform_ids: [],
      edition: null,
    });
    const evidence = JSON.parse(readFileSync(result.report.files.artwork, "utf8")) as {
      records: { reason: string; exceptions: { reason: string }[] }[];
    };
    assert.equal(evidence.records[0]?.reason, "exact-original-game-cover");
    assert.equal(evidence.records[0]?.exceptions[0]?.reason, "no-usable-cover");
    const record = JSON.parse(readFileSync(result.report.files.records[0]!.path, "utf8")) as {
      listing: { artwork: { game_id: number; match_kind: string } };
    };
    assert.equal(record.listing.artwork.game_id, 71);
    assert.equal(record.listing.artwork.match_kind, "underlying-game");
  } finally {
    f.clean();
  }
});

void test("explicit original identity wins and an ambiguous original title keeps generated fallback", async () => {
  const f = fixture();
  try {
    for (const explicit of [false, true]) {
      const id = explicit ? "explicit-original-fixture" : "ambiguous-original-fixture";
      let queriedName: string | undefined;
      const result = await preparePort({
        catalogRoot,
        outputDirectory: join(f.root, id),
        record: {
          format_version: 1,
          listing: {
            id,
            name: "Fixture port",
            original_game_title: "Ambiguous original",
            summary: "Reviewed original-title fixture.",
            project_url: project,
          },
        },
        ...(explicit
          ? {
              identities: {
                [id]: {
                  underlying_game: {
                    game_id: 90,
                    slug: "explicit-original",
                    names: ["Reviewed explicit original"],
                    evidence_url: `${project}/blob/main/README.md`,
                  },
                },
              },
            }
          : {}),
        facts: { fetcher: f.fetcher(() => json(metadata)) },
        artwork: {
          inspectGame: (identity) => {
            if (identity.kind === "port") return [];
            queriedName = identity.names[0];
            const game = {
              id: 90,
              slug: "explicit-original",
              name: identity.names[0],
              cover: { id: 91, image_id: "explicitfixture" },
            };
            return explicit ? [game] : [game, { ...game, id: 92, slug: "other-original" }];
          },
          inspectImage: () => ({
            sha256: "c".repeat(64),
            bytes: 100,
            width: 264,
            height: 374,
            format: "jpeg",
            validator: "portcove-core",
          }),
        },
      });
      const evidence = JSON.parse(readFileSync(result.report.files.artwork, "utf8")) as {
        records: { reason: string; exceptions: { reason: string }[] }[];
      };
      assert.equal(queriedName, explicit ? "Reviewed explicit original" : "Ambiguous original");
      assert.equal(
        evidence.records[0]?.reason,
        explicit ? "exact-original-game-cover" : "generated-fallback",
      );
      if (!explicit)
        assert.ok(
          evidence.records[0]?.exceptions.some(
            (exception) => exception.reason === "identity-not-unique",
          ),
        );
    }
  } finally {
    f.clean();
  }
});

void test("listing inspection binds exact generated bytes and validator identity across resume", async (context) => {
  const f = fixture();
  try {
    const cli = join(f.root, "selected-cli");
    writeFileSync(cli, "inert listing validator fixture");
    let calls = 0;
    let changeResponse = false;
    context.mock.method(childProcess, "spawnSync", (artifact: string, args: string[]) => {
      calls++;
      assert.ok(readFileSync(artifact, "utf8").startsWith("inert listing validator"));
      assert.deepEqual(args.slice(-3, -1), ["inspect-listings", "--path"]);
      const data = JSON.parse(readFileSync(args.at(-1)!, "utf8")) as { listings: unknown[] };
      if (changeResponse) data.listings.pop();
      const stdout = JSON.stringify({ data });
      return { pid: 1, output: [null, stdout, ""], status: 0, signal: null, stdout, stderr: "" };
    });
    syncBuiltinESMExports();
    const options = {
      catalogRoot,
      outputDirectory: join(f.root, "output"),
      projectUrl: project,
      id: "listing-validation-fixture",
      validatorCli: cli,
      facts: { fetcher: f.fetcher(() => json(metadata)) },
      artwork: { inspectGame: () => [] },
    };
    const first = await preparePort(options);
    const receipt = first.report.listing_validation as ListingReceipt;
    assert.equal(
      receipt.format_version,
      3,
      "descriptive original-game metadata requires listing v3",
    );
    const bytes = readFileSync(first.report.files.listings);
    assert.equal(receipt.input_sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(receipt.input_bytes, bytes.length);
    assert.deepEqual(
      receipt.listings,
      (JSON.parse(bytes.toString()) as { listings: unknown[] }).listings,
    );
    assert.equal(calls, 1);
    const resumed = await preparePort(options);
    assert.deepEqual(resumed.report.listing_validation, receipt);
    assert.equal(calls, 1, "same input and validator reuse the successful inspection");
    writeFileSync(cli, "inert listing validator fixture changed");
    const changed = await preparePort(options);
    assert.notEqual(
      (changed.report.listing_validation as ListingReceipt).validator_artifact_sha256,
      receipt.validator_artifact_sha256,
    );
    assert.equal(calls, 2, "a new validator artifact invalidates the receipt");
    changeResponse = true;
    await assert.rejects(
      preparePort({ ...options, outputDirectory: join(f.root, "wrong-response") }),
      /listing response differs from the exact generated input/,
    );
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    f.clean();
  }
});

function batchImage() {
  return {
    sha256: "d".repeat(64),
    bytes: 100,
    width: 264,
    height: 374,
    format: "jpeg",
    validator: "portcove-core",
  };
}
function copiedCatalog(directory: string) {
  mkdirSync(directory);
  for (const name of [
    "catalog-shared.json",
    "catalog-schema1-fixture.json",
    "catalog-legacy-additions-fixture.json",
    "ports",
  ])
    cpSync(join(catalogRoot, name), join(directory, name), { recursive: true });
  return directory;
}

function clearFixtureArtwork(directory: string, ids: string[]) {
  for (const id of ids) {
    const file = join(directory, "ports", `${id}.json`);
    const record = readCatalogSource(directory).records.find((record) => record.listing.id === id);
    assert.ok(record);
    delete record.listing.artwork;
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  }
}

void test("preparation resolves related downloads from stable ID and canonical issue while isolating managed releases", async () => {
  for (const route of [
    "id",
    "issue",
    "release-feed",
    "release-feed-trailing-slash",
    "tag-named-releases",
    "managed",
    "managed-no-listing-release",
    "managed-gitlab",
  ] as const) {
    const f = fixture();
    try {
      const source = copiedCatalog(join(f.root, "source"));
      const record = readCatalogSource(source).records.find(
        (entry) =>
          Boolean(entry.integration) === route.startsWith("managed") &&
          entry.listing.project_url.startsWith("https://github.com/"),
      )!;
      delete record.listing.artwork;
      record.listing.release_url = "https://github.com/example/helper/releases/tag/unselected";
      if (route === "release-feed")
        record.listing.release_url = "https://github.com/example/helper/releases";
      if (route === "release-feed-trailing-slash")
        record.listing.release_url = "https://github.com/example/helper/releases/";
      if (route === "tag-named-releases")
        record.listing.release_url = "https://github.com/example/helper/releases/tag/releases";
      if (route === "managed-no-listing-release") delete record.listing.release_url;
      if (record.integration)
        record.integration.release = {
          ...(record.integration.release as Record<string, unknown>),
          provider: route === "managed-gitlab" ? "gitlab" : "github",
          repository: "example/operational",
        };
      writeFileSync(join(source, "ports", `${record.listing.id}.json`), JSON.stringify(record));
      const repository = githubRepository(record.listing.project_url)!;
      const releaseRepository = route.startsWith("managed")
        ? "example/operational"
        : "example/helper";
      const result = await preparePort({
        catalogRoot: source,
        outputDirectory: join(f.root, "output"),
        ...(route === "issue"
          ? { issue: String(record.listing.issue_number) }
          : { id: record.listing.id }),
        route: "download",
        releaseTag: "chosen",
        artwork: { inspectGame: () => [] },
        facts: {
          fetcher: f.fetcher((url) => {
            if (url.endsWith(`/issues/${record.listing.issue_number}`))
              return json({
                title: "[Port] Fixture",
                body: `<!-- portcove-port-key: ${record.listing.id} -->\n<!-- portcove-upstream: ${record.listing.project_url} -->`,
              });
            if (url.endsWith(`/repos/${repository}`))
              return json({ full_name: repository, private: false });
            if (url.endsWith("/repos/example/helper"))
              return json({ id: 777, full_name: "example/helper", private: false });
            if (url.endsWith("/repos/example/operational"))
              return json({ id: 888, full_name: "example/operational", private: false });
            if (url.endsWith(`/repos/${releaseRepository}/releases/tags/chosen`))
              return json({
                id: 44,
                draft: false,
                tag_name: "chosen",
                html_url: `https://github.com/${releaseRepository}/releases/tag/chosen`,
              });
            if (url.endsWith(`/repos/${releaseRepository}/releases/44/assets?per_page=100&page=1`))
              return json([
                {
                  id: 45,
                  name: "game.zip",
                  size: 1,
                  browser_download_url: `https://github.com/${releaseRepository}/releases/download/chosen/game.zip`,
                },
              ]);
            return assert.fail(`Unexpected request ${url}`);
          }),
        },
      });
      assert.equal(result.report.port_id, record.listing.id);
      if (route === "issue") {
        const feedback = result.report.canonical_preparation!;
        assert.equal(feedback.specification.status, "observed");
        assert.equal(
          feedback.specification.facts_endpoint,
          `https://api.github.com/repos/boburning/portcove/issues/${record.listing.issue_number}`,
        );
        const specification = `<!-- portcove-port-key: ${record.listing.id} -->\n<!-- portcove-upstream: ${record.listing.project_url} -->`;
        assert.equal(
          feedback.specification.body_sha256,
          createHash("sha256").update(specification).digest("hex"),
        );
      }

      const facts = JSON.parse(readFileSync(result.report.files.upstream, "utf8")) as {
        repository: string;
        release_repository: string;
        release_project?: unknown;
      };
      assert.equal(facts.repository, repository);
      assert.equal(facts.release_repository, route === "managed-gitlab" ? null : releaseRepository);
      if (route === "managed-gitlab") assert.equal(facts.release_project, undefined);
      assert.equal(
        f.requests.some((url) => url.includes("/repos/example/helper")),
        !route.startsWith("managed"),
      );
      const changedRecord = result.report.files.records[0];
      const proposal = changedRecord
        ? (JSON.parse(readFileSync(changedRecord.path, "utf8")) as AuthoredPort)
        : record;
      assert.equal(
        Boolean(changedRecord),
        !route.startsWith("managed") && !route.startsWith("release-feed"),
      );
      assert.equal(proposal.listing.project_url, record.listing.project_url);
      assert.equal(
        proposal.listing.release_url,
        route.startsWith("managed") || route.startsWith("release-feed")
          ? record.listing.release_url
          : `https://github.com/${releaseRepository}/releases/tag/chosen`,
      );
      assert.equal(result.report.operational_changed, false);
    } finally {
      f.clean();
    }
  }
});

void test("bounded artwork batch enriches listing-only records in the complete large catalog and resumes without lookup", async () => {
  const f = fixture();
  try {
    const source = copiedCatalog(join(f.root, "source"));
    const additions = readCatalogSource(source)
      .records.filter((record) => !record.integration)
      .slice(0, 2);
    clearFixtureArtwork(
      source,
      additions.map((record) => record.listing.id),
    );
    const accepted = readCatalogSource(source);
    assert.ok(accepted.records.length > 400);
    assert.equal(additions.length, 2);
    const acceptedCover = accepted.records.find((record) => record.listing.artwork)!;
    assert.ok(acceptedCover);
    const selectedPortIds = [
      ...additions.map((record) => record.listing.id),
      acceptedCover.listing.id,
    ];
    const queries: string[] = [];
    const options = {
      catalogRoot: source,
      outputDirectory: join(f.root, "output"),
      selectedPortIds,
      artwork: {
        inspectGame: (identity: { names: string[]; project_url: string | null }) => {
          queries.push(identity.names[0]!);
          const index = queries.length;
          return [
            {
              id: 100 + index,
              name: identity.names[0],
              slug: `batch-port-${index}`,
              websites: [{ url: identity.project_url }],
              cover: { id: 200 + index, image_id: `batch${index}` },
            },
          ];
        },
        inspectImage: batchImage,
      },
    };
    const first = await prepareArtworkBatch(options);
    assert.deepEqual(queries.sort(), additions.map((record) => record.listing.name).sort());
    assert.deepEqual(
      first.report.changed_records.sort(),
      additions.map((record) => record.listing.id).sort(),
    );
    assert.equal(first.report.upstream_collection, "not-requested");
    assert.ok(!readdirSync(options.outputDirectory).includes("facts"));
    assert.equal(first.report.operational_changed, false);
    assert.ok(first.report.preparation_costs.elapsed_ms >= 0);
    assert.deepEqual(first.report.pending_port_ids, []);
    const generated = JSON.parse(readFileSync(first.report.files.listings, "utf8")) as {
      listings: unknown[];
    };
    assert.equal(generated.listings.length, accepted.records.length);
    assert.deepEqual(
      JSON.parse(readFileSync(first.report.files.catalog, "utf8")),
      accepted.catalog,
    );
    const again = await prepareArtworkBatch(options);
    assert.equal(again.report.artwork_reused, true);
    assert.equal(queries.length, 2);
    assert.deepEqual(again.report.files.records, first.report.files.records);
    assert.deepEqual(readCatalogSource(source), accepted);
  } finally {
    f.clean();
  }
});

void test("partial cover batch retains useful record proposals and retries only selected pending identities", async () => {
  const f = fixture();
  try {
    const source = copiedCatalog(join(f.root, "source"));
    const entries = readCatalogSource(source)
      .records.filter((record) => !record.integration)
      .slice(0, 2);
    clearFixtureArtwork(
      source,
      entries.map((record) => record.listing.id),
    );
    const good = entries[0]!.listing;
    const pending = entries[1]!.listing;
    let recovering = false;
    const queried: string[] = [];
    const options = {
      catalogRoot: source,
      outputDirectory: join(f.root, "output"),
      selectedPortIds: [good.id, pending.id],
      artwork: {
        inspectGame: (identity: { names: string[]; project_url: string | null }) => {
          const name = identity.names[0]!;
          queried.push(name);
          if (name !== good.name && !recovering) throw new Error("provider outage");
          return [
            {
              id: name === good.name ? 301 : 302,
              name,
              slug: "batch-result",
              websites: [{ url: identity.project_url }],
              cover: { id: 303, image_id: "batchresult" },
            },
          ];
        },
        inspectImage: batchImage,
      },
    };
    const first = await prepareArtworkBatch(options);
    assert.deepEqual(first.report.changed_records, [good.id]);
    assert.deepEqual(first.report.pending_port_ids, [pending.id]);
    const prepared = first.report.files.records[0]!;
    const retained = readFileSync(prepared.path);
    // Accept the useful proposal only in this isolated fixture source, then
    // retry the pending subset. The real checkout is never edited by preparation.
    writeFileSync(join(source, "ports", `${good.id}.json`), retained);
    recovering = true;
    queried.length = 0;
    const retried = await prepareArtworkBatch({ ...options, selectedPortIds: [pending.id] });
    assert.deepEqual(queried, [pending.name]);
    assert.deepEqual(retried.report.changed_records, [pending.id]);
    assert.deepEqual(retried.report.pending_port_ids, []);
    assert.deepEqual(readFileSync(prepared.path), retained);
    const directory = JSON.parse(readFileSync(retried.report.files.listings, "utf8")) as {
      listings: { id: string; artwork?: unknown }[];
    };
    assert.ok(directory.listings.find((listing) => listing.id === good.id)?.artwork);
    assert.ok(directory.listings.find((listing) => listing.id === pending.id)?.artwork);
  } finally {
    f.clean();
  }
});

void test("batch selection and mixed CLI modes fail before provider work or checkpoint creation", async () => {
  const f = fixture();
  try {
    const ids = readCatalogSource(catalogRoot).records.map((record) => record.listing.id);
    for (const selectedPortIds of [
      [],
      [ids[0]!, ids[0]!],
      ["not-a-known-port"],
      ids.slice(0, 401),
    ]) {
      await assert.rejects(
        prepareArtworkBatch({
          catalogRoot,
          outputDirectory: join(f.root, "output"),
          selectedPortIds,
          artwork: { inspectGame: () => assert.fail("invalid selection reached provider") },
        }),
        /1 to 400 unique known/,
      );
      assert.deepEqual(readdirSync(f.root), []);
    }
    for (const refreshPortIds of [[ids[1]!], [ids[0]!, ids[0]!]]) {
      await assert.rejects(
        prepareArtworkBatch({
          catalogRoot,
          outputDirectory: join(f.root, "output"),
          selectedPortIds: [ids[0]!],
          refreshPortIds,
        }),
        /refresh requires unique IDs/,
      );
    }
    const script = join(dirname(fileURLToPath(import.meta.url)), "prepare-port.mts");
    for (const arguments_ of [
      ["--artwork-ids", ids[0]!, "--project", project],
      ["--artwork-ids", ids[0]!, "--record", "unread-file.json"],
      ["--refresh-artwork", ids[0]!],
    ]) {
      const result = childProcess.spawnSync(
        process.execPath,
        [script, ...arguments_, "--output-dir", join(f.root, "output")],
        { encoding: "utf8", timeout: 10000 },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /cannot mix|requires --artwork-ids/);
      assert.deepEqual(readdirSync(f.root), []);
    }
  } finally {
    f.clean();
  }
});

void test("batch exact-image invalidation includes an unselected listing-only reference", async () => {
  const f = fixture();
  try {
    const source = copiedCatalog(join(f.root, "source"));
    const entries = readCatalogSource(source)
      .records.filter((record) => !record.integration)
      .slice(0, 2);
    const mapping = {
      game_id: 501,
      cover_id: 502,
      image_id: "batchgone",
      image_sha256: "a".repeat(64),
      game_slug: "batch-refresh",
      match_kind: "port",
    };
    for (const record of entries) {
      record.listing.artwork = mapping;
      delete record.listing.original_game_title;
      writeFileSync(join(source, "ports", `${record.listing.id}.json`), JSON.stringify(record));
    }
    const selected = entries[0]!.listing;
    const credentials = join(f.root, "fixture-credentials.json");
    writeFileSync(credentials, JSON.stringify({ client_id: "fixture", client_secret: "fixture" }));
    const requests: string[] = [];
    const inspector = createIgdbInspector(
      credentials,
      () => assert.fail("Gone bytes cannot decode"),
      async (url) => {
        requests.push(url);
        if (url === "https://id.twitch.tv/oauth2/token") return json({ access_token: "fixture" });
        if (url === "https://api.igdb.com/v4/games")
          return json([
            {
              id: 501,
              slug: "batch-refresh",
              name: selected.name,
              cover: { id: 502, image_id: "batchgone" },
            },
          ]);
        return new Response("Gone", { status: 410 });
      },
    );
    const result = await prepareArtworkBatch({
      catalogRoot: source,
      outputDirectory: join(f.root, "output"),
      selectedPortIds: [selected.id],
      refreshPortIds: [selected.id],
      identities: {
        [selected.id]: {
          port: {
            game_id: 501,
            slug: "batch-refresh",
            names: [selected.name],
            evidence_url: selected.project_url,
          },
        },
      },
      artwork: inspector,
    });
    assert.deepEqual(
      result.report.changed_records.sort(),
      entries.map((record) => record.listing.id).sort(),
    );
    assert.deepEqual(
      result.report.pending_port_ids.sort(),
      entries.map((record) => record.listing.id).sort(),
    );
    assert.equal(requests.length, 3);
    assert.ok(requests.every((url) => !url.includes("github")));
    for (const record of result.report.files.records) {
      const proposal = JSON.parse(readFileSync(record.path, "utf8")) as {
        listing: { artwork?: unknown };
      };
      assert.equal(proposal.listing.artwork, undefined);
    }
    assert.ok(
      entries.every(
        (record) =>
          readCatalogSource(source).records.find(
            (current) => current.listing.id === record.listing.id,
          )?.listing.artwork,
      ),
    );
  } finally {
    f.clean();
  }
});

void test("malformed candidate and unowned output directories fail without changing accepted work", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      preparePort({
        catalogRoot,
        outputDirectory: join(f.root, "bad"),
        record: { format_version: 1, listing: { id: "bad" } },
      }),
      /Listing name/,
    );
    assert.deepEqual(readdirSync(f.root), []);
    const existing = join(f.root, "existing");
    mkdirSync(existing);
    writeFileSync(join(existing, "user-file.txt"), "retain");
    await assert.rejects(
      preparePort({ catalogRoot, outputDirectory: existing, projectUrl: project, id: "fixture" }),
    );
    assert.equal(readFileSync(join(existing, "user-file.txt"), "utf8"), "retain");
    assert.deepEqual(readdirSync(existing), ["user-file.txt"]);
    assert.throws(() => githubRepository("http://github.com/example/fixture"), /HTTPS/);
    assert.throws(
      () => githubRepository("https://github.com/example/fixture/releases"),
      /repository root/,
    );
  } finally {
    f.clean();
  }
});
