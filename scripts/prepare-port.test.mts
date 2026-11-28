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
  existsSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheckedGit } from "./checked-git.mts";
import test from "node:test";
import { projectN64RecompPersistence } from "./catalog-n64-recomp-persistence.mts";
import { projectReviewedFlatPackageLayout } from "./catalog-reviewed-flat-package-layout.mts";
import {
  collectPortFacts,
  githubRepository,
  githubReleaseRepository,
  observeLauncherModPortals,
} from "./port-upstream-facts.mts";
import {
  preparePort,
  prepareDiscoveryListingAdditions,
  prepareArtworkBatch,
  prepareSharedCoverBatch,
  prepareListingObservations,
  portablePreparationFeedback,
  downloadPreparationFeedback,
  canonicalPreparationFeedback,
  declarativePreparationFeedback,
} from "./prepare-port.mts";
import { checkedAuthoredPort, readCatalogSource } from "./catalog-authoring.mts";
import { observationHash } from "./upstream-observer.mts";
import { encodeCompactListing } from "./listing-directory-carrier.mts";
import { isRecord } from "./runtime-values.mts";
import { createIgdbInspector } from "./inspect-igdb-artwork.mts";
import { projectPsxManagedWindows } from "./catalog-psx-managed-windows.mts";
import { coreProposalInspector, type ListingReceipt } from "./catalog-authoring-inspector.mts";
import type { AuthoredPort, CatalogPort } from "./catalog-authoring.mts";
import { managedSetupReleaseAdvice } from "./catalog-setup-release-advice.mts";
import { scheduledDiscoveryReplayReceipt } from "./discovery-admission-receipt.mts";

void test("managed setup release advice reports exact actions without changing evidence", () => {
  const releaseBase = "https://github.com/example/fixture/releases";
  const asset = "fixture-v1.2.3-win64.zip";
  const tagUrl = `${releaseBase}/tag/v1.2.3`;
  const assetUrl = `${releaseBase}/download/v1.2.3/${asset}`;
  const guide = {
    steps: [
      { title: "Start the player", instruction: "Choose the release tagged v1.2.3." },
      { title: "Get the package", instruction: `Download the release asset at ${assetUrl}.` },
      { title: "Find the package", instruction: `Download ${asset}.` },
      { title: "Open the release", instruction: `Open ${tagUrl}.` },
      {
        title: "Keep your original",
        instruction: "Use your own original revision 1.2.3 with BIOS v1.2.3.",
      },
      { title: "Check the ABI", instruction: "Use glibc 2.38 or newer and match build ID 1.2.3." },
      { title: "Check requirements", instruction: `Open ${tagUrl}.` },
      { title: "Keep an existing copy", instruction: `Open ${tagUrl}.` },
      {
        title: "Use a separate installation",
        instruction: `Open ${tagUrl}. Extract it outside your Portcove library.`,
      },
      { title: "Review changes", instruction: "The release tagged v1.2.3 was tested." },
      { title: "Follow the stable path", instruction: "Download fixture-win64.zip." },
      { title: "Keep the original ready", instruction: "Download original-v1.2.3.zip." },
      { title: "Find the right build", instruction: "Choose the release tagged v2.0.0." },
      {
        title: "Check the dependency",
        instruction: "Open https://github.com/dependency/elsewhere/releases/tag/v1.2.3.",
      },
      {
        title: "Use a historic special release",
        instruction: "For older builds only, choose the release tagged v1.2.3.",
      },
    ],
    help_url: tagUrl,
    warnings: [`Open ${tagUrl}.`],
    references: [{ title: "Old process", instruction: `Download ${assetUrl}.` }],
  };
  const release = {
    repository: "example/fixture",
    asset_hints: { "windows-x86-64": [asset, "fixture-win64.zip"] },
  };
  const port: CatalogPort = {
    id: "fixture",
    release,
    presentation: { manual_setup: guide },
  };
  const before = structuredClone(port);
  assert.deepEqual(managedSetupReleaseAdvice(port, tagUrl), [
    { step: 1, kind: "release tag", literal: "v1.2.3" },
    { step: 2, kind: "repository asset", literal: assetUrl },
    { step: 3, kind: "repository asset", literal: asset },
    { step: 4, kind: "release tag", literal: tagUrl },
  ]);
  assert.deepEqual(port, before);
  for (const releaseOverride of [
    { provider: "user-prepared" },
    { provider: "direct-manifest" },
    { rolling_tag: "v1.2.3" },
    { direct: { "windows-x86-64": {} } },
    { curated: { "windows-x86-64": {} } },
    { managed_build: { "windows-x86-64": {} } },
    { user_prepared: { "windows-x86-64": {} } },
  ])
    assert.deepEqual(
      managedSetupReleaseAdvice({ ...port, release: { ...release, ...releaseOverride } }),
      [],
    );
  assert.deepEqual(
    managedSetupReleaseAdvice({
      ...port,
      presentation: { ...port.presentation, installation_method: "user-prepared-runtime" },
    }),
    [],
  );
  assert.deepEqual(managedSetupReleaseAdvice(undefined), []);
});

void test("managed setup release advice recognizes canonical slash tags without widening asset scope", () => {
  const repository = "BodbDearg/PsyDoom";
  const releaseBase = `https://github.com/${repository}/releases`;
  const tag = "releases/1.1.1";
  const encodedTag = "releases%2F1.1.1";
  const asset = "PsyDoom_1.1.1_Windows_x86_64.zip";
  const tagLinks = [tag, encodedTag].map((value) => `${releaseBase}/tag/${value}`);
  const assetLinks = [tag, encodedTag].map((value) => `${releaseBase}/download/${value}/${asset}`);
  const guide = {
    steps: [
      { title: "Choose a release", instruction: `Choose the release tagged ${tag}.` },
      ...tagLinks.map((url) => ({ title: "Open the release", instruction: `Open ${url}.` })),
      ...assetLinks.map((url) => ({ title: "Get the package", instruction: `Download ${url}.` })),
      { title: "Use an existing copy", instruction: `Download ${assetLinks[1]}.` },
      {
        title: "Get an asset",
        instruction: `Download ${releaseBase}/download/${encodedTag}/x%2F${asset}.`,
      },
      {
        title: "Get an asset",
        instruction: `Download ${releaseBase}/download/releases%2F../1.1.1/${asset}.`,
      },
      {
        title: "Get an asset",
        instruction: `Download ${releaseBase.replace(repository, "BodbDearg%2FPsyDoom")}/download/${encodedTag}/${asset}.`,
      },
    ],
    warnings: [],
  };
  const port: CatalogPort = {
    id: "fixture",
    release: { repository },
    presentation: { manual_setup: guide },
  };
  assert.deepEqual(managedSetupReleaseAdvice(port, tagLinks[1]), [
    { step: 1, kind: "release tag", literal: tag },
    ...tagLinks.map((literal, index) => ({ step: index + 2, kind: "release tag", literal })),
    ...assetLinks.map((literal, index) => ({ step: index + 4, kind: "repository asset", literal })),
  ]);
  assert.deepEqual(
    managedSetupReleaseAdvice(
      {
        ...port,
        release: { repository, rolling_tag: tag },
      },
      tagLinks[1],
    ),
    [],
  );
});

void test("preparation finds release advice on a shared managed guide and honors its override", () => {
  const source = readCatalogSource(catalogRoot);
  const record = source.records.find(({ listing }) => listing.id === "star-wars-atari-darkuni")!;
  const before = structuredClone(record);
  const feedback = declarativePreparationFeedback(record);
  assert.deepEqual(feedback.managed_setup_release_literals?.steps, [
    { step: 2, kind: "release tag", literal: "V1.1.0b" },
  ]);
  assert.deepEqual(record, before);
  const override = {
    ...record,
    integration: {
      ...record.integration,
      presentation: {
        manual_setup: {
          steps: [
            {
              title: "Prepare to play",
              instruction: "Put your own arcade ROM in your home directory.",
            },
          ],
          warnings: [],
        },
      },
    },
  };
  assert.equal(declarativePreparationFeedback(override).managed_setup_release_literals, undefined);
  const listingOnly = { ...record };
  delete listingOnly.integration;
  assert.equal(
    declarativePreparationFeedback(listingOnly).managed_setup_release_literals,
    undefined,
  );
});

void test("canonical preparation exposes the exact specification without deriving acquisition authority", () => {
  const record: AuthoredPort = {
    format_version: 1,
    listing: {
      id: "fixture",
      name: "Fixture",
      summary: "Fixture",
      project_url: "https://github.com/example/fixture",
      issue_number: 156,
      restrictions: [
        {
          id: "download",
          effect: "hold",
          operations: ["download"],
          reason: "package-facts-unresolved",
          explanation: "Retain the reviewed exact acquisition condition.",
        },
      ],
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
  assert.equal(
    feedback.authored_acquisition_condition,
    before.listing.restrictions?.[0]?.explanation,
  );
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
  Response.json(value, { status: 200, ...(headers ? { headers } : {}) });
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

void test("facts SDK preserves explicit and anonymous credential intent and caller headers", async () => {
  const f = fixture();
  try {
    for (const token of [undefined, "synthetic-facts-token"]) {
      const result = await collectPortFacts({
        projectUrl: project,
        cacheDirectory: join(f.root, token ? "explicit" : "anonymous"),
        token,
        fetcher: async (_url, init) => {
          const headers = new Headers(init?.headers);
          assert.equal(headers.get("authorization"), token ? `token ${token}` : null);
          assert.equal(headers.get("x-github-api-version"), "2022-11-28");
          assert.equal(headers.get("accept"), "application/vnd.github+json");
          assert.equal(init?.redirect, "manual");
          return json(metadata);
        },
      });
      assert.equal(result.project?.status, "observed");
      assert.equal(result.usage.requests, 1);
    }
    await assert.rejects(
      collectPortFacts({
        projectUrl: project,
        cacheDirectory: join(f.root, "missing-explicit"),
        token: "",
        fetcher: async () => {
          assert.fail("Missing explicit credential must not dispatch");
        },
      }),
      { code: "credential_unavailable" },
    );
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
    assert.equal(failed.usage.requests, 1);
    assert.equal(f.requests.length, 2);
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

void test("discovery listing batch keeps independent additions and never replaces accepted records", async (context) => {
  const f = fixture();
  try {
    const claim = (id: string, repository: string, repository_id: number) => ({
      id,
      project_url: `https://github.com/${repository}`,
      repository_id,
      evidence_sha256: "a".repeat(64),
    });
    const handoff = {
      format: "portcove-discovery-listing-handoff",
      format_version: 1,
      candidates: [
        claim("dcs-moved", "moved/crawl", 23038334),
        claim("dcs-reused", "crawl/crawl", 777),
        claim("warioland4", "moved/crawl", 23038334),
        claim("first-new-port", "example/fixture", metadata.id),
        claim("second-new-port", "example/second", 124),
        claim("third-new-port", "example/third", 125),
        claim("overlap-one", "example/overlap", 126),
        claim("overlap-two", "other/relocated", 126),
        claim("launcher-as-port", "xander-haj/lawn", 127),
        claim("release-mirror-as-port", "sonicdcer/DNZHRecomp", 128),
      ],
    };
    const options = {
      catalogRoot,
      outputDirectory: join(f.root, "discovery-listings"),
      handoff,
      facts: {
        now: () => Date.parse("2026-11-26T00:00:00Z"),
        fetcher: f.fetcher((url) => {
          if (url.endsWith("/example/fixture")) return json({ ...metadata, private: false });
          if (url.endsWith("/example/second"))
            return json({ ...metadata, id: 555, full_name: "example/second", private: false });
          if (url.endsWith("/example/third"))
            return json({ ...metadata, id: 125, full_name: "example/third", private: false });
          return new Response(null, { status: 404 });
        }),
      },
    };
    const { report } = await prepareDiscoveryListingAdditions(options);
    assert.deepEqual(report.changed_records, ["first-new-port", "third-new-port"]);
    assert.equal(report.operational_changed, false);
    assert.deepEqual(
      report.outcomes.map(({ status }) => status),
      [
        "already-cataloged",
        "held",
        "held",
        "prepared",
        "held",
        "prepared",
        "held",
        "held",
        "held",
        "held",
      ],
    );
    assert.equal(f.requests.length, 3);
    assert.deepEqual(JSON.parse(readFileSync(report.files.records[0]!.path, "utf8")), {
      format_version: 1,
      upstream_lineage: {
        format_version: 1,
        target_key: "first-new-port",
        origin: { project_url: project, repository: { host: "github.com", id: "123" } },
        decisions: [],
      },
      original_game_review: {
        disposition: "unresolved",
        reason: "Repository evidence does not establish an exact original game or source edition.",
        evidence_urls: [project],
      },
      listing: {
        id: "first-new-port",
        name: "fixture",
        project_url: project,
        listed_at: "2026-11-26",
        release_url: `${project}/releases`,
        summary: metadata.description,
      },
    });
    const accepted = readCatalogSource(catalogRoot);
    const directory: unknown = JSON.parse(readFileSync(report.files.listings, "utf8"));
    assert.ok(isRecord(directory) && Array.isArray(directory.listings));
    assert.equal(directory.listings.length, accepted.directory.listings.length + 2);
    assert.equal(report.accepted_listings_sha256, observationHash(accepted.directory));
    assert.equal(report.admission, null);
    const approval = {
      format: "portcove-discovery-listing-approval",
      format_version: 1,
      ...report.admission_binding,
      approved_ids: ["third-new-port"],
    };
    await assert.rejects(
      prepareDiscoveryListingAdditions({ ...options, approval: { document: approval } }),
      /requires a trusted Core validator/u,
    );
    const validatorCli = join(f.root, "selected-cli");
    writeFileSync(validatorCli, "inert listing validator fixture");
    await assert.rejects(
      prepareDiscoveryListingAdditions({
        ...options,
        validatorCli,
        approval: { document: { ...approval, source_sha256: "0".repeat(64) } },
      }),
      /does not match the handoff and catalog source/u,
    );
    await assert.rejects(
      prepareDiscoveryListingAdditions({
        ...options,
        validatorCli,
        approval: { document: { ...approval, approved_ids: ["unknown-port"] } },
      }),
      /must name unique IDs from the exact handoff/u,
    );
    let approved;
    context.mock.method(childProcess, "spawnSync", (artifact: string, args: string[]) => {
      assert.equal(readFileSync(artifact, "utf8"), "inert listing validator fixture");
      assert.deepEqual(args.slice(-3, -1), ["inspect-listings", "--path"]);
      const data: unknown = JSON.parse(readFileSync(args.at(-1)!, "utf8"));
      return { status: 0, signal: null, stdout: JSON.stringify({ data }), stderr: "" };
    });
    syncBuiltinESMExports();
    try {
      approved = await prepareDiscoveryListingAdditions({
        ...options,
        validatorCli,
        approval: { document: approval },
      });
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.deepEqual(approved.report.changed_records, ["third-new-port"]);
    assert.equal(
      (approved.report.listing_validation as ListingReceipt).listings.length,
      accepted.directory.listings.length + 1,
    );
    const admission = approved.report.admission;
    assert.ok(admission);
    const patch = readFileSync(admission.path);
    assert.equal(createHash("sha256").update(patch).digest("hex"), admission.sha256);
    const apply = childProcess.spawnSync("git", ["apply", "--numstat", admission.path], {
      cwd: dirname(dirname(dirname(catalogRoot))),
      encoding: "utf8",
    });
    assert.equal(apply.status, 0, apply.stderr);
    assert.match(
      apply.stdout.trim(),
      /^\d+\t0\tcrates\/portcove-core\/catalog\/ports\/third-new-port\.json$/u,
    );
    await assert.rejects(
      prepareDiscoveryListingAdditions({
        ...options,
        handoff: {
          ...handoff,
          candidates: [{ ...handoff.candidates[0], integration: { adapter: "native-portable" } }],
        },
      }),
      /requires a stable ID, public repository and evidence digest/u,
    );
    assert.equal(f.requests.length, 4);
  } finally {
    f.clean();
  }
});

void test("a first-party game desktop entry can establish source-port scope without a manifest", async (t) => {
  const f = fixture();
  t.after(f.clean);
  const commit = "c".repeat(40);
  const tree = "d".repeat(40);
  const good =
    "[Desktop Entry]\nName=Fixture\nType=Application\nExec=fixture %F\nCategories=Game;ActionGame;\n";
  for (const [index, scenario] of [
    { state: "eligible" },
    { state: "held", text: good.replace("Categories=Game", "Categories=Utility") },
    { state: "held", text: good.replace("Categories=Game", "Categories=Utility\\;Game") },
    { state: "held", text: good.replace("fixture %F", "sh -c fixture") },
    { state: "held", text: good.replace("fixture %F", "fix-ture") },
    { state: "held", text: `${good}Exec = fixture\n` },
    { state: "held", text: `${good}Hidden = true\n` },
    { state: "held", text: `${good}DBusActivatable=true\n` },
    { state: "restricted", text: good.replace("Name=Fixture", "Name=ScummVM fixture") },
    { state: "held", path: "tests/fixtures/fixture.desktop" },
    { state: "held", truncated: true },
    { state: "held", duplicate: true },
    { state: "held", incorrectDigest: true },
    { state: "held", noTopic: true },
    { state: "held", fork: true },
  ].entries()) {
    const path = scenario.path ?? "data/fixture.desktop";
    const bytes = Buffer.from(scenario.text ?? good);
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    const entry = { path, type: "blob", mode: "100644", sha: blob };
    const facts = await collectPortFacts({
      projectUrl: "https://github.com/example/fixture",
      expectedRepositoryId: 123,
      route: "listing",
      discoveryScope: true,
      cacheDirectory: join(f.root, `case-${index}`),
      fetcher: f.fetcher((input) => {
        const url = new URL(input);
        if (url.pathname === "/repos/example/fixture")
          return json({
            ...metadata,
            private: false,
            fork: scenario.fork ?? false,
            mirror_url: null,
            topics: scenario.noTopic ? [] : ["source-port"],
          });
        assert.ok(url.pathname.startsWith("/repositories/123/"));
        if (url.pathname.endsWith("/commits"))
          return json([{ sha: commit, commit: { tree: { sha: tree } } }]);
        if (url.pathname.endsWith(`/git/trees/${tree}`)) {
          if (!url.search) return json({ sha: tree, truncated: false, tree: [] });
          assert.equal(url.search, "?recursive=1");
          return json({
            sha: tree,
            truncated: scenario.truncated ?? false,
            tree: scenario.duplicate ? [entry, { ...entry, path: "other.desktop" }] : [entry],
          });
        }
        assert.equal(url.pathname, `/repositories/123/contents/${path}`);
        assert.equal(url.search, `?ref=${commit}`);
        return json({
          path,
          type: "file",
          encoding: "base64",
          content: bytes.toString("base64"),
          size: bytes.length,
          sha: scenario.incorrectDigest ? "2".repeat(40) : blob,
        });
      }),
    });
    assert.equal(facts.discovery_scope?.state, scenario.state, `case ${index}`);
    if (index === 0) {
      assert.equal(facts.discovery_scope?.state, "eligible");
      assert.ok("desktop_entry" in facts.discovery_scope);
      assert.equal(facts.discovery_scope.evidence_path, path);
      assert.equal(facts.discovery_scope.repository_id, 123);
      assert.equal(facts.discovery_scope.desktop_entry_blob, blob);
      assert.deepEqual(facts.discovery_scope.desktop_entry, {
        format: 1,
        category: "Game",
        names_scummvm: false,
      });
      assert.doesNotMatch(JSON.stringify(facts.discovery_scope), /fixture %F/u);
    }
  }
});

void test("scheduled discovery scope binds first-party manifest bytes and keeps independent results", async (context) => {
  const f = fixture();
  try {
    const sha = "a".repeat(40);
    const tree = "c".repeat(40);
    const candidates = [
      "eligible",
      "missing",
      "fork",
      "wrong-bytes",
      "scummvm",
      "legacy",
      "symlink",
      "multi",
      "truncated",
      "unknown-mirror",
      "bad-tree",
      "provider-missing-file",
      "launcher",
      "launcher-foreign",
      "launcher-multigame",
      "launcher-unsafe",
      "launcher-excluded-program",
      "launcher-optional",
      "launcher-nongame",
      "launcher-extra-game",
      "launcher-excluded-title",
      "launcher-primary-conflict",
      "launcher-partial-mods",
      "launcher-legacy",
      "launcher-legacy-mixed-inputs",
      "launcher-legacy-update",
    ].map((name, index) => ({
      id: `github-${80_000 + index}`,
      project_url: `https://github.com/fixture/${name}`,
      repository_id: 80_000 + index,
      evidence_sha256: "b".repeat(64),
    }));
    const handoff = { format: "portcove-discovery-listing-handoff", format_version: 1, candidates };
    const validatorCli = join(f.root, "fixture-cli");
    writeFileSync(validatorCli, "inert");
    const spawn = childProcess.spawnSync;
    let refuse = false;
    let scheduledReader = true;
    context.mock.method(
      childProcess,
      "spawnSync",
      (artifact: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        if (artifact === "git") return spawn(artifact, args, options);
        if (scheduledReader)
          assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "PATH", "TMPDIR"]);
        if (refuse)
          return { status: 1, signal: null, stdout: "", stderr: "fixture refuses this format" };
        assert.deepEqual(args.slice(-3, -1), ["inspect-listings", "--path"]);
        const data: unknown = JSON.parse(readFileSync(args.at(-1)!, "utf8"));
        return { status: 0, signal: null, stdout: JSON.stringify({ data }), stderr: "" };
      },
    );
    syncBuiltinESMExports();
    let validatorRequests = 0;
    const options: Parameters<typeof prepareDiscoveryListingAdditions>[0] = {
      catalogRoot,
      outputDirectory: join(f.root, "automatic-scope"),
      handoff,
      automaticScope: true,
      acquireValidator: async () => {
        assert.ok(f.requests.length > 0);
        validatorRequests++;
        return {
          cli: validatorCli,
          receipt: { version: "fixture" },
          sha256: createHash("sha256").update("inert").digest("hex"),
          version: "fixture",
        };
      },
      facts: {
        now: () => Date.parse("2026-11-26T00:00:00Z"),
        fetcher: f.fetcher((url) => {
          const candidate = candidates.find(({ project_url }) =>
            url.endsWith(project_url.slice("https://github.com".length)),
          );
          if (candidate) {
            return json({
              id: candidate.repository_id,
              private: false,
              fork: candidate.project_url.endsWith("/fork"),
              ...(candidate.project_url.endsWith("/unknown-mirror") ? {} : { mirror_url: null }),
              default_branch: "main",
              full_name: new URL(candidate.project_url).pathname.slice(1),
            });
          }
          const match = /\/repositories\/(\d+)\/(.*)$/u.exec(url);
          if (!match) assert.fail(`Unexpected provider request ${url}`);
          const selected = candidates.find(
            ({ repository_id }) => repository_id === Number(match[1]),
          );
          if (!selected || /\/(?:fork|unknown-mirror)$/u.test(selected.project_url))
            assert.fail("Unbound or fork metadata request");
          if (match[2] === "commits?per_page=1")
            return json([{ sha, commit: { tree: { sha: tree } } }]);
          const name = selected.project_url.split("/").at(-1);
          const primaryConflict = name === "launcher-primary-conflict";
          const launcher = name?.startsWith("launcher") === true && !primaryConflict;
          const manifestPath = launcher
            ? "recomplauncher.json"
            : name === "legacy"
              ? ".recomp-board.json"
              : ".recomp.json";
          const bytes = Buffer.from(
            JSON.stringify(
              launcher
                ? {
                    format: 1,
                    repo: name === "launcher-foreign" ? "fixture/other" : `fixture/${name}`,
                    ...(name === "launcher-excluded-title" ? { name: "ScummVM example" } : {}),
                    ...(name === "launcher-legacy" || name === "launcher-legacy-update"
                      ? {
                          game: {
                            kind: "iso",
                            label: "Original game copy",
                            check: { iso9660: "SCUS_944.26" },
                            ...(name === "launcher-legacy-update"
                              ? { update: { label: "Required update copy", into: "update" } }
                              : {}),
                          },
                        }
                      : {
                          inputs: [
                            {
                              id: "game",
                              label: "Original game disc image",
                              ...(name === "launcher-optional" ? { optional: true } : {}),
                              ...(name === "launcher-nongame" ? { role: "key" } : {}),
                              formats: [{ type: "file" }],
                              check: { iso9660: "SLUS_206.51" },
                            },
                            ...(name === "launcher-extra-game"
                              ? [
                                  {
                                    id: "extra",
                                    label: "Other original game",
                                    formats: [{ type: "file" }],
                                  },
                                ]
                              : []),
                          ],
                        }),
                    ...(name === "launcher-legacy-mixed-inputs"
                      ? { game: { label: "Second game" } }
                      : {}),
                    start: {
                      program: [
                        name === "launcher-unsafe"
                          ? "../outside.exe"
                          : name === "launcher-excluded-program"
                            ? "scummvm_x64.exe"
                            : "bin/unknown-port.exe",
                      ],
                      args: ["--original", "{input:game}"],
                    },
                    ...(name === "launcher-multigame" ? { games: [{ id: "other" }] } : {}),
                    mods: {
                      thunderstore: name === "launcher-partial-mods" ? "../other" : "fixture-mods",
                      gamebanana: 12345,
                      loader: "nrm",
                      data: "PrivateFixtureDirectory",
                    },
                  }
                : {
                    game: "Fixture game",
                    type: primaryConflict ? "framework" : "recomp",
                    system: "SNES",
                    ...(selected.project_url.endsWith("/scummvm") ? { toolchain: "ScummVM" } : {}),
                  },
            ),
          );
          const digest = createHash("sha1")
            .update(`blob ${bytes.length}\0`)
            .update(bytes)
            .digest("hex");
          if (match[2] === `git/trees/${tree}`) {
            const entries =
              name === "missing"
                ? []
                : [
                    {
                      path: manifestPath,
                      type: "blob",
                      mode: name === "symlink" ? "120000" : "100644",
                      sha: digest,
                    },
                  ];
            if (name === "multi")
              entries.push({ path: ".recomp-2.json", type: "blob", mode: "100644", sha: digest });
            if (primaryConflict)
              entries.push({
                path: "recomplauncher.json",
                type: "blob",
                mode: "100644",
                sha: "d".repeat(40),
              });
            return json({
              sha: tree,
              tree: name === "bad-tree" ? [...entries, null] : entries,
              truncated: name === "truncated",
            });
          }
          assert.ok(!["missing", "symlink", "multi", "truncated", "bad-tree"].includes(name!));
          assert.equal(match[2], `contents/${manifestPath}?ref=${sha}`);
          if (name === "provider-missing-file") return new Response(null, { status: 404 });
          if (name === "wrong-bytes") bytes[10] = bytes[10]! ^ 1;
          return json({
            type: "file",
            path: manifestPath,
            encoding: "base64",
            size: bytes.length,
            content: bytes.toString("base64"),
            sha: digest,
          });
        }),
      },
    };
    const { report } = await prepareDiscoveryListingAdditions(options);
    assert.deepEqual(report.changed_records, [
      "github-80000",
      "github-80005",
      "github-80012",
      "github-80022",
      "github-80023",
    ]);
    assert.deepEqual(
      report.outcomes.map(({ status }) => status),
      [
        "prepared",
        "held",
        "held",
        "held",
        "restricted",
        "prepared",
        "held",
        "held",
        "held",
        "held",
        "held",
        "unavailable",
        "prepared",
        "held",
        "held",
        "held",
        "restricted",
        "held",
        "held",
        "held",
        "restricted",
        "held",
        "prepared",
        "prepared",
        "held",
        "held",
      ],
    );
    assert.equal(report.automatic_scope_policy, "github-primary-game-scope/6");
    assert.ok(report.admission);
    assert.deepEqual(report.released_validation, {
      status: "validated",
      receipt: { version: "fixture" },
    });
    const held = await prepareDiscoveryListingAdditions({
      ...options,
      outputDirectory: join(f.root, "held-only"),
      handoff: { ...handoff, candidates: [candidates[1]] },
    });
    assert.equal(validatorRequests, 1);
    assert.equal(held.report.released_validation, undefined);
    assert.equal(held.report.admission, null);
    context.mock.method(console, "error", () => {});
    const deferred = await prepareDiscoveryListingAdditions({
      ...options,
      outputDirectory: join(f.root, "validator-unavailable"),
      handoff: { ...handoff, candidates: [candidates[0]] },
      async acquireValidator() {
        throw new Error("Fixture reader acquisition failed");
      },
    });
    assert.deepEqual(deferred.report.released_validation, { status: "deferred-unavailable" });
    assert.deepEqual(deferred.report.changed_records, ["github-80000"]);
    assert.equal(deferred.report.admission, null);
    refuse = true;
    const independent = await prepareDiscoveryListingAdditions({
      ...options,
      outputDirectory: join(f.root, "core-refuses-format"),
      handoff: { ...handoff, candidates: [candidates[0]] },
    });
    assert.deepEqual(independent.report.released_validation, {
      status: "deferred-core-inspection",
    });
    assert.deepEqual(independent.report.changed_records, ["github-80000"]);
    assert.equal(independent.report.admission, null);
    assert.equal(report.operational_changed, false);
    const result = checkedAuthoredPort(
      JSON.parse(readFileSync(report.files.records[0]!.path, "utf8")),
    );
    assert.equal(
      result.original_game_review?.evidence_urls[1],
      `https://github.com/fixture/eligible/blob/${sha}/.recomp.json`,
    );
    assert.equal(result.listing.original_game, undefined);
    assert.equal(result.integration, undefined);
    const declared = checkedAuthoredPort(
      JSON.parse(readFileSync(report.files.records[2]!.path, "utf8")),
    );
    assert.equal(
      declared.original_game_review?.evidence_urls[1],
      `https://github.com/fixture/launcher/blob/${sha}/recomplauncher.json`,
    );
    assert.equal(declared.listing.original_game, undefined);
    assert.equal(declared.integration, undefined);
    assert.equal(declared.listing.mod_portals, undefined);
    const partial = checkedAuthoredPort(
      JSON.parse(readFileSync(report.files.records[3]!.path, "utf8")),
    );
    assert.equal(partial.listing.mod_portals, undefined);
    const legacy = checkedAuthoredPort(
      JSON.parse(readFileSync(report.files.records[4]!.path, "utf8")),
    );
    assert.equal(
      legacy.original_game_review?.evidence_urls[1],
      `https://github.com/fixture/launcher-legacy/blob/${sha}/recomplauncher.json`,
    );
    assert.equal(legacy.listing.original_game, undefined);
    assert.equal(legacy.listing.mod_portals, undefined);
    assert.equal(legacy.integration, undefined);
    const delivered: unknown = JSON.parse(readFileSync(report.files.listings, "utf8"));
    assert.ok(isRecord(delivered) && Array.isArray(delivered.listings));
    assert.equal(delivered.format_version, 17);
    const projected: unknown = delivered.listings.find(
      (row: unknown) => isRecord(row) && row.id === declared.listing.id,
    );
    assert.ok(isRecord(projected));
    assert.equal(projected.mod_portals, undefined);
    assert.doesNotMatch(JSON.stringify(projected), /PrivateFixtureDirectory|--original/u);

    refuse = false;
    let clock = Date.parse("2026-11-26T00:00:00Z");
    const limitedHandoff = { ...handoff, candidates: [candidates[0], candidates[5]] };
    const normalFetch = options.facts?.fetcher;
    assert.ok(normalFetch);
    const limited = await prepareDiscoveryListingAdditions({
      ...options,
      handoff: limitedHandoff,
      deadline: clock + 1_000,
      outputDirectory: join(f.root, "deadline-preview"),
      facts: {
        ...options.facts,
        now: () => clock,
        fetcher: async (...args) => {
          const response = await normalFetch(...args);
          const [input] = args;
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (url.includes("/repositories/80000/contents/")) clock += 1_001;
          return response;
        },
      },
    });
    assert.deepEqual(
      limited.report.outcomes.map(({ status }) => status),
      ["prepared", "deferred"],
    );
    const receipt = scheduledDiscoveryReplayReceipt(limited.report, limitedHandoff, {
      GITHUB_EVENT_NAME: "schedule",
      GITHUB_REPOSITORY: "boburning/portcove",
      GITHUB_WORKFLOW_REF:
        "boburning/portcove/.github/workflows/maintenance-inventory.yml@refs/heads/main",
      GITHUB_WORKFLOW_SHA: sha,
      GITHUB_SHA: sha,
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "1",
    });
    assert.ok(receipt);
    const replayReceipt: unknown = JSON.parse(receipt.toString());
    assert.ok(isRecord(replayReceipt));
    const availableLater = await prepareDiscoveryListingAdditions({
      ...options,
      handoff: limitedHandoff,
      outputDirectory: join(f.root, "deadline-cleared"),
    });
    assert.deepEqual(availableLater.report.changed_records, ["github-80000", "github-80005"]);
    assert.notEqual(availableLater.report.admission?.sha256, limited.report.admission?.sha256);
    const replayLimited = await prepareDiscoveryListingAdditions({
      ...options,
      handoff: replayReceipt.handoff,
      outputDirectory: join(f.root, "deadline-replay"),
    });
    assert.deepEqual(replayLimited.report.changed_records, ["github-80000"]);
    assert.equal(replayLimited.report.admission?.sha256, limited.report.admission?.sha256);

    scheduledReader = false;
    const repository = join(f.root, "replay");
    const replayCatalog = join(repository, "crates", "portcove-core", "catalog");
    mkdirSync(dirname(replayCatalog), { recursive: true });
    cpSync(catalogRoot, replayCatalog, { recursive: true });
    const git = (args: string[]) => runCheckedGit(args, { cwd: repository }).trim();
    git(["init", "--quiet"]);
    git(["add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);
    const revision = git(["rev-parse", "HEAD"]);
    const replay = {
      catalogRoot: replayCatalog,
      handoff,
      automaticScope: true,
      validatorCli,
      facts: { ...options.facts, now: () => Date.parse("2026-11-27T00:00:00Z") },
    };
    const previewListedDate = report.automatic_listed_date;
    assert.equal(previewListedDate, "2026-11-26");
    const stage = {
      repository,
      revision,
      expectedPatchSha256: report.admission.sha256,
      previewListedDate,
    };
    await assert.rejects(
      prepareDiscoveryListingAdditions({
        ...replay,
        outputDirectory: join(f.root, "unbound-replay"),
        stage: { repository, revision },
      }),
      /requires the exact preview patch SHA-256/u,
    );
    await assert.rejects(
      prepareDiscoveryListingAdditions({
        ...replay,
        outputDirectory: join(f.root, "changed-replay"),
        handoff: { ...handoff, candidates: [candidates[0]] },
        stage,
      }),
      /Rebuilt discovery patch differs/u,
    );
    assert.equal(git(["status", "--porcelain=v1"]), "");
    const staged = await prepareDiscoveryListingAdditions({
      ...replay,
      outputDirectory: join(f.root, "matching-replay"),
      stage,
    });
    assert.equal(staged.report.admission?.sha256, report.admission.sha256);
    assert.equal(staged.report.staged_source_revision, revision);
    assert.deepEqual(git(["diff", "--cached", "--name-status"]).split(/\r?\n/u), [
      "A\tcrates/portcove-core/catalog/ports/github-80000.json",
      "A\tcrates/portcove-core/catalog/ports/github-80005.json",
      "A\tcrates/portcove-core/catalog/ports/github-80012.json",
      "A\tcrates/portcove-core/catalog/ports/github-80022.json",
      "A\tcrates/portcove-core/catalog/ports/github-80023.json",
    ]);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    f.clean();
  }
});

void test("discovery listing staging refuses stale or changed source before reading candidates", async () => {
  const f = fixture();
  try {
    const repository = join(f.root, "checkout");
    const catalog = join(repository, "crates", "portcove-core", "catalog");
    mkdirSync(catalog, { recursive: true });
    const git = (args: string[]) => runCheckedGit(args, { cwd: repository }).trim();
    git(["init", "--quiet"]);
    writeFileSync(join(repository, ".gitignore"), "ignored.json\n");
    git(["add", ".gitignore"]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);
    const revision = git(["rev-parse", "HEAD"]);
    const validatorCli = join(f.root, "fixture-validator");
    const options = {
      catalogRoot: catalog,
      outputDirectory: join(f.root, "output"),
      handoff: null,
      validatorCli,
      approval: { document: null },
      stage: { repository, revision },
    };
    await assert.rejects(
      prepareDiscoveryListingAdditions({
        ...options,
        stage: { repository, revision: "0".repeat(40) },
      }),
      /clean checkout at the reviewed Git revision/u,
    );
    await assert.rejects(
      prepareDiscoveryListingAdditions(options),
      /versioned discovery listing handoff/u,
    );
    const inheritedIndex = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = join(f.root, "unrelated-index");
    try {
      await assert.rejects(
        prepareDiscoveryListingAdditions(options),
        /versioned discovery listing handoff/u,
      );
      assert.equal(existsSync(process.env.GIT_INDEX_FILE), false);
    } finally {
      if (inheritedIndex === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = inheritedIndex;
    }
    writeFileSync(join(catalog, "ignored.json"), "{}");
    assert.equal(git(["status", "--porcelain=v1"]), "");
    await assert.rejects(
      prepareDiscoveryListingAdditions(options),
      /clean checkout at the reviewed Git revision/u,
    );
    rmSync(join(catalog, "ignored.json"));
    writeFileSync(join(repository, ".gitignore"), "");
    await assert.rejects(
      prepareDiscoveryListingAdditions(options),
      /clean checkout at the reviewed Git revision/u,
    );
    git(["update-index", "--assume-unchanged", ".gitignore"]);
    assert.equal(git(["status", "--porcelain=v1"]), "");
    await assert.rejects(
      prepareDiscoveryListingAdditions(options),
      /clean checkout at the reviewed Git revision/u,
    );
    assert.equal(existsSync(options.outputDirectory), false);
  } finally {
    f.clean();
  }
});

void test("discovery listing batch honors provider backoff across repositories", async () => {
  const f = fixture();
  try {
    const { report } = await prepareDiscoveryListingAdditions({
      catalogRoot,
      outputDirectory: join(f.root, "discovery-backoff"),
      handoff: {
        format: "portcove-discovery-listing-handoff",
        format_version: 1,
        candidates: [123, 124, 23038334].map((repository_id) => ({
          id: `discovery-${repository_id}`,
          project_url:
            repository_id === 23038334
              ? "https://github.com/crawl/crawl"
              : `https://github.com/example/port-${repository_id}`,
          repository_id,
          evidence_sha256: "a".repeat(64),
        })),
      },
      facts: {
        now: () => Date.parse("2026-11-26T00:00:00Z"),
        fetcher: f.fetcher(
          () =>
            new Response(null, {
              status: 429,
              headers: { "Retry-After": "3600" },
            }),
        ),
      },
    });
    assert.equal(f.requests.length, 1);
    assert.deepEqual(report.changed_records, []);
    assert.deepEqual(
      report.outcomes.map((row) => [
        row.status,
        "retry_after" in row ? row.retry_after : undefined,
      ]),
      [
        ["deferred", "2026-11-26T01:00:00.000Z"],
        ["deferred", "2026-11-26T01:00:00.000Z"],
        ["already-cataloged", undefined],
      ],
    );
  } finally {
    f.clean();
  }
});

void test("scheduled discovery preparation retains completed work when the batch deadline arrives", async () => {
  const f = fixture();
  try {
    let clock = Date.parse("2026-11-26T00:00:00Z");
    const { report } = await prepareDiscoveryListingAdditions({
      catalogRoot,
      outputDirectory: join(f.root, "discovery-deadline"),
      deadline: clock + 10,
      handoff: {
        format: "portcove-discovery-listing-handoff",
        format_version: 1,
        candidates: [123, 124].map((repository_id) => ({
          id: `discovery-${repository_id}`,
          project_url: repository_id === 123 ? project : "https://github.com/example/remaining",
          repository_id,
          evidence_sha256: "a".repeat(64),
        })),
      },
      facts: {
        now: () => clock,
        fetcher: f.fetcher(() => {
          clock += 20;
          return json({ ...metadata, private: false });
        }),
      },
    });
    assert.deepEqual(report.changed_records, ["discovery-123"]);
    assert.deepEqual(
      report.outcomes.map(({ status }) => status),
      ["prepared", "deferred"],
    );
    assert.equal(f.requests.length, 1);
  } finally {
    f.clean();
  }
});

void test("discovery-bound preparation retains a public repository and its ongoing release feed", async () => {
  const f = fixture();
  try {
    const result = await preparePort({
      catalogRoot,
      outputDirectory: join(f.root, "bound"),
      projectUrl: "https://github.com/Example/Fixture/",
      expectedRepositoryId: metadata.id,
      facts: {
        fetcher: f.fetcher((url) =>
          url.includes("/releases?") ? json([]) : json({ ...metadata, private: false }),
        ),
      },
      artwork: { inspectGame: () => [] },
    });
    const record = checkedAuthoredPort(
      JSON.parse(readFileSync(result.report.files.records[0]!.path, "utf8")),
    );
    assert.equal(record.listing.id, "fixture");
    assert.equal(record.listing.release_url?.toLowerCase(), `${project}/releases`);
    assert.deepEqual(record.upstream_lineage?.origin.repository, { host: "github.com", id: "123" });
    assert.equal(record.listing.original_game, undefined);
    assert.equal(record.listing.issue_number, undefined);
    assert.equal(record.listing.availability, undefined);
    assert.equal(record.listing.artwork, undefined);
    assert.equal(record.integration, undefined);
    assert.equal(f.requests.filter((url) => url.includes("/releases?")).length, 1);
  } finally {
    f.clean();
  }
});

void test("discovery-bound preparation refuses changed or unverified provider identity before release reads", async () => {
  const f = fixture();
  try {
    const mismatches = [
      { ...metadata, private: false, id: 999 },
      { ...metadata, private: false, full_name: "different/fixture" },
      { ...metadata, private: undefined },
      { ...metadata, private: false, id: undefined },
    ];
    for (const [index, provider] of mismatches.entries()) {
      await assert.rejects(
        preparePort({
          catalogRoot,
          outputDirectory: join(f.root, `mismatch-${index}`),
          projectUrl: project,
          expectedRepositoryId: metadata.id,
          facts: { fetcher: f.fetcher(() => json(provider)) },
        }),
        /does not match the observed repository ID and location/u,
      );
    }
    assert.equal(f.requests.length, mismatches.length);
    assert.equal(
      f.requests.some((url) => url.includes("/releases")),
      false,
    );
  } finally {
    f.clean();
  }
});

void test("discovery-bound release reads isolate repository IDs across a warm reused path", async () => {
  const f = fixture();
  try {
    let currentId = metadata.id;
    const options = {
      projectUrl: project,
      route: "download" as const,
      cacheDirectory: join(f.root, "facts"),
      fetcher: f.fetcher((url) =>
        url.includes("/releases?")
          ? json([{ tag_name: url.includes("/repositories/456/") ? "new-release" : "old-release" }])
          : json({ ...metadata, id: currentId, private: false }),
      ),
    };
    await collectPortFacts(options);
    currentId = 456;
    await assert.rejects(
      collectPortFacts({ ...options, expectedRepositoryId: metadata.id }),
      /does not match the observed repository ID and location/u,
    );
    assert.equal(f.requests.filter((url) => url.includes("/releases?")).length, 1);
    const legacy = await collectPortFacts(options);
    assert.equal(legacy.project?.status, "reused");
    assert.deepEqual(legacy.project?.body, { ...metadata, private: false });
    assert.deepEqual(legacy.release_candidates?.body, [{ tag_name: "old-release" }]);
    const result = await collectPortFacts({ ...options, expectedRepositoryId: 456 });
    assert.deepEqual(result.release_candidates?.body, [{ tag_name: "new-release" }]);
    assert.match(result.release_candidates?.endpoint ?? "", /\/repositories\/456\/releases/u);
    assert.equal(result.release_candidates?.status, "observed");
    const warm = await collectPortFacts({ ...options, expectedRepositoryId: 456 });
    assert.equal(warm.project?.status, "observed");
    assert.equal(warm.release_candidates?.status, "reused");
  } finally {
    f.clean();
  }
});

void test("discovery-bound preparation keeps a published external release source", async () => {
  const f = fixture();
  try {
    const result = await preparePort({
      catalogRoot,
      outputDirectory: join(f.root, "external-source"),
      projectUrl: "https://github.com/colobot/colobot",
      expectedRepositoryId: metadata.id,
      facts: {
        fetcher: f.fetcher(() =>
          json({ ...metadata, private: false, full_name: "colobot/colobot" }),
        ),
      },
      artwork: { inspectGame: () => [] },
    });
    assert.equal(result.report.port_id, "colobot");
    assert.deepEqual(result.report.changed_records, []);
    assert.equal(f.requests.length, 1);
    const upstream: unknown = JSON.parse(readFileSync(result.report.files.upstream, "utf8"));
    assert.ok(isRecord(upstream));
    assert.equal(upstream.release_repository, null);
    assert.equal(upstream.release_candidates, undefined);
  } finally {
    f.clean();
  }
});

void test("starts issue-free preparation from an official project and reviewed game identity", async () => {
  const f = fixture();
  try {
    const originalGame = {
      format_version: 1,
      id: "example-original",
      evidence_urls: ["https://example.com/game"],
      source_editions: [
        {
          id: "example-original-na",
          title: "Example Original (North America)",
          evidence_urls: ["https://example.com/game/na"],
        },
      ],
    };
    const options = {
      catalogRoot,
      outputDirectory: join(f.root, "output"),
      projectUrl: project,
      originalGame,
      facts: {
        fetcher: f.fetcher((url) =>
          url.includes("/releases?")
            ? json([{ tag_name: "v1" }])
            : json({ ...metadata, description: ` ${metadata.description}\n` }),
        ),
      },
      artwork: { inspectGame: () => [] },
    };
    const { report } = await preparePort(options);
    const record = checkedAuthoredPort(
      JSON.parse(readFileSync(report.files.records[0]!.path, "utf8")),
    );
    assert.equal(record.listing.id, "fixture");
    assert.equal(record.listing.summary, metadata.description);
    assert.deepEqual(record.listing.original_game, originalGame);
    assert.equal(record.listing.issue_number, undefined);
    assert.equal(record.listing.release_url, undefined);
    assert.equal(record.integration, undefined);
    assert.deepEqual(record.upstream_lineage?.origin.repository, {
      host: "github.com",
      id: "123",
    });
    assert.deepEqual(f.requests, [
      "https://api.github.com/repos/example/fixture",
      "https://api.github.com/repos/example/fixture/releases?per_page=20&page=1",
    ]);
    await preparePort(options);
    assert.equal(f.requests.length, 2);
    const withExisting = copiedCatalog(join(f.root, "existing-catalog"));
    writeFileSync(join(withExisting, "ports", "fixture.json"), JSON.stringify(record));
    const alias = await preparePort({
      ...options,
      catalogRoot: withExisting,
      outputDirectory: join(f.root, "alias"),
      projectUrl: "https://github.com/EXAMPLE/FIXTURE.git/",
    });
    assert.equal(alias.report.port_id, record.listing.id);
    const aliasRecord = alias.report.files.records[0];
    if (aliasRecord) {
      const proposed = checkedAuthoredPort(JSON.parse(readFileSync(aliasRecord.path, "utf8")));
      assert.equal(proposed.listing.project_url, project);
    }
    const originalFile = join(withExisting, "ports", "fixture.json");
    const originalBytes = readFileSync(originalFile, "utf8");
    const otherEdition = {
      id: "example-original-jp",
      title: "Example Original (Japan)",
      evidence_urls: ["https://example.com/game/jp"],
    };
    const common = {
      ...options,
      catalogRoot: withExisting,
      route: "listing" as const,
      facts: { ...options.facts, now: () => Date.parse("2026-11-20T10:00:00Z") },
    };
    const otherGame = {
      ...originalGame,
      id: "another-game",
      source_editions: [
        { ...otherEdition, id: "another-game-jp" },
        { ...otherEdition, id: "another-game-na" },
      ],
    };
    const added = await preparePort({
      ...common,
      outputDirectory: join(f.root, "distinct-game"),
      originalGame: otherGame,
    });
    const newId = added.report.port_id;
    assert.match(newId, /^fixture-[a-f0-9]{12}$/u);
    assert.deepEqual(added.report.changed_records, [newId]);
    assert.equal(added.report.operational_changed, false);
    const newFile = added.report.files.records[0]!.path;
    const newBytes = readFileSync(newFile, "utf8");
    const newRecord = checkedAuthoredPort(JSON.parse(newBytes));
    assert.deepEqual(newRecord.listing.original_game, otherGame);
    assert.equal(newRecord.listing.issue_number, undefined);
    assert.equal(newRecord.integration, undefined);
    assert.deepEqual(newRecord.upstream_lineage?.origin, record.upstream_lineage?.origin);
    const repeated = await preparePort({
      ...common,
      outputDirectory: join(f.root, "repeat-distinct-game"),
      originalGame: otherGame,
    });
    assert.equal(readFileSync(repeated.report.files.records[0]!.path, "utf8"), newBytes);
    const reordered = await preparePort({
      ...common,
      outputDirectory: join(f.root, "reordered-editions"),
      originalGame: { ...otherGame, source_editions: [...otherGame.source_editions].reverse() },
    });
    assert.equal(reordered.report.port_id, newId);
    await assert.rejects(
      preparePort({
        ...common,
        expectedRepositoryId: metadata.id,
        id: "duplicate-reviewed-game",
        outputDirectory: join(f.root, "bound-duplicate"),
        originalGame,
      }),
      /already have a stable listing/u,
    );
    await assert.rejects(
      preparePort({
        ...common,
        expectedRepositoryId: 456,
        id: record.listing.id,
        outputDirectory: join(f.root, "bound-reused-source"),
      }),
      /contradicts retained lineage/u,
    );
    await assert.rejects(
      preparePort({
        ...common,
        outputDirectory: join(f.root, "reused-source-url"),
        originalGame: otherGame,
        facts: { ...common.facts, fetcher: f.fetcher(() => json({ ...metadata, id: 456 })) },
      }),
      /already has a retained origin/u,
    );
    const distinctEdition = await preparePort({
      ...common,
      outputDirectory: join(f.root, "distinct-edition"),
      originalGame: { ...originalGame, source_editions: [otherEdition] },
    });
    assert.match(distinctEdition.report.port_id, /^fixture-[a-f0-9]{12}$/u);
    assert.notEqual(distinctEdition.report.port_id, newId);
    await assert.rejects(
      preparePort({
        ...common,
        outputDirectory: join(f.root, "overlap"),
        originalGame: {
          ...originalGame,
          source_editions: [...originalGame.source_editions, otherEdition],
        },
      }),
      /overlapping or unspecified source editions/u,
    );
    await assert.rejects(
      preparePort({
        ...common,
        outputDirectory: join(f.root, "unspecified"),
        originalGame: { ...originalGame, source_editions: [] },
      }),
      /overlapping or unspecified source editions/u,
    );
    const collisionFile = join(withExisting, "ports", `${newId}.json`);
    const occupied = {
      format_version: 1,
      listing: { ...newRecord.listing, project_url: "https://github.com/other/occupied" },
    };
    const occupiedBytes = JSON.stringify(occupied);
    writeFileSync(collisionFile, occupiedBytes);
    const proposedWithCollision = await preparePort({
      ...common,
      outputDirectory: join(f.root, "occupied-id"),
      originalGame: otherGame,
    });
    assert.equal(proposedWithCollision.report.port_id, `${newId}-2`);
    assert.deepEqual(proposedWithCollision.report.changed_records, [`${newId}-2`]);
    assert.equal(readFileSync(collisionFile, "utf8"), occupiedBytes);
    assert.equal(readFileSync(originalFile, "utf8"), originalBytes);
    const forkUrl = "https://github.com/other/fixture";
    const fork = await preparePort({
      ...options,
      catalogRoot: withExisting,
      outputDirectory: join(f.root, "fork"),
      projectUrl: forkUrl,
      facts: {
        fetcher: f.fetcher((url) =>
          url.includes("/releases?")
            ? json([])
            : json({ ...metadata, id: 456, full_name: "other/fixture" }),
        ),
      },
    });
    assert.match(fork.report.port_id, /^fixture-[a-f0-9]{12}$/u);
    assert.equal(fork.report.files.records.length, 1);
    await assert.rejects(
      preparePort({
        ...options,
        catalogRoot: withExisting,
        outputDirectory: join(f.root, "moved"),
        projectUrl: "https://github.com/example/fixture-moved",
        facts: {
          fetcher: f.fetcher((url) =>
            url.includes("/releases?")
              ? json([])
              : json({ ...metadata, full_name: "example/fixture-moved" }),
          ),
        },
      }),
      /already has a retained origin/u,
    );
    await assert.rejects(
      preparePort({
        ...options,
        catalogRoot: withExisting,
        outputDirectory: join(f.root, "redirect"),
        projectUrl: "https://github.com/example/old-project-name",
      }),
      /returned a different project name/u,
    );
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
    const sourceBytes = readFileSync(join(catalogRoot, "catalog.json"), "utf8");
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
    assert.equal(readFileSync(join(catalogRoot, "catalog.json"), "utf8"), sourceBytes);
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

void test("ordinary onboarding prefers attributable exact-port art and records missing and ambiguous fallbacks", async () => {
  const f = fixture();
  try {
    for (const outcome of ["exact", "missing", "ambiguous"] as const) {
      const queried: string[] = [];
      let images = 0;
      const result = await preparePort({
        catalogRoot,
        outputDirectory: join(f.root, outcome),
        record: {
          format_version: 1,
          listing: {
            id: `onboarding-${outcome}`,
            name: "Fixture port",
            original_game_title: "Original fixture game",
            summary: "Synthetic ordinary artwork onboarding demonstration.",
            project_url: project,
          },
        },
        facts: { fetcher: f.fetcher(() => json(metadata)) },
        artwork: {
          inspectGame: (identity) => {
            queried.push(identity.kind);
            const game = {
              id: 70,
              slug: "fixture-port",
              name: identity.names[0],
              websites: [{ url: project }],
              cover: { id: 71, image_id: "onboardingfixture" },
            };
            if (outcome === "missing") return [];
            if (outcome === "ambiguous") return [game, { ...game, id: 72, slug: "other-edition" }];
            return [game];
          },
          inspectImage: () => {
            images++;
            return {
              sha256: "d".repeat(64),
              bytes: 100,
              width: 264,
              height: 374,
              format: "jpeg",
              validator: "portcove-core",
            };
          },
        },
      });
      const evidence = JSON.parse(readFileSync(result.report.files.artwork, "utf8")) as {
        records: {
          reason: string;
          mapping: unknown;
          checks: unknown;
          exceptions: { kind: string; reason: string }[];
        }[];
      };
      const row = evidence.records[0]!;
      if (outcome === "exact") {
        assert.deepEqual(queried, ["port"]);
        assert.equal(images, 1);
        assert.equal(row.reason, "exact-port-cover");
        assert.deepEqual(row.mapping, {
          game_id: 70,
          cover_id: 71,
          image_id: "onboardingfixture",
          image_sha256: "d".repeat(64),
          game_slug: "fixture-port",
          match_kind: "port",
        });
        assert.ok(JSON.stringify(row.checks).includes(project));
      } else {
        assert.deepEqual(queried, ["port", "underlying-game"]);
        assert.equal(images, 0);
        assert.equal(row.reason, "generated-fallback");
        assert.equal(row.mapping, null);
        const reason = outcome === "ambiguous" ? "identity-not-unique" : "identity-not-found";
        assert.deepEqual(
          row.exceptions.map(({ kind, reason }) => ({ kind, reason })),
          [
            { kind: "port", reason },
            { kind: "underlying-game", reason },
          ],
        );
      }
      // Preparation records facts; it cannot admit or publish artwork or a runtime.
      const authored = JSON.parse(
        readFileSync(result.report.files.records[0]!.path, "utf8"),
      ) as AuthoredPort;
      assert.equal(authored.integration, undefined);
      assert.equal(Boolean(authored.listing.artwork), outcome === "exact");
    }
  } finally {
    f.clean();
  }
});

void test("repository authoring surfaces the Core summary refusal and retains the process receipt", (context) => {
  const f = fixture();
  try {
    const cli = join(f.root, "selected-cli");
    writeFileSync(cli, "inert proposal validator");
    const message = "spaceranger: keep 'portable' in the structured catalog fields";
    context.mock.method(childProcess, "spawnSync", (_artifact: string, args: string[]) => {
      assert.deepEqual(args.slice(-3, -1), ["inspect-proposal", "--repository-authoring"]);
      const stdout = JSON.stringify({
        ok: false,
        command: "catalog.inspect-proposal",
        error: { message },
      });
      return { status: 1, signal: null, stdout, stderr: "" };
    });
    syncBuiltinESMExports();
    const inspector = coreProposalInspector(cli, f.root);
    assert.throws(() => inspector.inspect("proposal", Buffer.from("{}"), true), /keep 'portable'/);
    const receipt: unknown = JSON.parse(
      readFileSync(join(f.root, "proposal-process.json"), "utf8"),
    );
    assert.partialDeepStrictEqual(receipt, { repository_authoring: true, status: 1 });
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
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
    const acceptedFormat = readCatalogSource(catalogRoot).directory.format_version;
    assert.equal(
      receipt.format_version,
      acceptedFormat,
      "a plain new listing preserves the accepted directory's format",
    );
    const bytes = readFileSync(first.report.files.listings);
    const directory = JSON.parse(bytes.toString()) as {
      format_version: number;
      listings: unknown[];
    };
    assert.equal(receipt.format_version, directory.format_version);
    assert.equal(receipt.input_sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(receipt.input_bytes, bytes.length);
    assert.deepEqual(receipt.listings, directory.listings);
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

void test("shared cover proposals bind exact authored scope to the signed donor", async (context) => {
  const f = fixture();
  try {
    const source = copiedCatalog(join(f.root, "shared-cover-catalog"));
    const game = {
      format_version: 1,
      id: "shared-original-fixture",
      evidence_urls: ["https://example.org/shared-game"],
      source_editions: [
        {
          id: "exact-edition",
          title: "Shared Original",
          evidence_urls: ["https://example.org/shared-edition"],
        },
      ],
    };
    const artwork = {
      game_id: 70,
      cover_id: 71,
      image_id: "sharedcover",
      image_sha256: batchImage().sha256,
      game_slug: "shared-original-fixture",
      match_kind: "underlying-game",
    };
    const donor = "fixture-cover-donor",
      peer = "fixture-cover-peer",
      other = "fixture-cover-other";
    for (const id of [donor, peer, other]) {
      const record = checkedAuthoredPort({
        format_version: 1,
        listing: {
          id,
          name: id,
          project_url: `https://example.org/${id}`,
          original_game:
            id === other
              ? { ...game, source_editions: [{ ...game.source_editions[0], id: "other-edition" }] }
              : game,
          summary: "Fixture port.",
          ...(id === donor ? { artwork } : {}),
        },
      });
      writeFileSync(join(source, "ports", `${id}.json`), JSON.stringify(record));
    }
    const validatorCli = join(f.root, "selected-cli");
    writeFileSync(validatorCli, "inert listing validator fixture");
    const anchor = readFileSync(join(catalogRoot, "official-definition-root.json"));
    writeFileSync(join(source, "official-definition-root.json"), anchor);
    const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    const accepted = readCatalogSource(source).directory;
    const rows = accepted.listings.filter((record) => [donor, peer, other].includes(record.id));
    const target = join(f.root, "compact.json");
    const status = {
      selected: true,
      fallback_reason: null,
      anchor_sha256: digest(anchor),
      revision: 1,
      listing_count: rows.length,
      expires_at: "2099-01-01T00:00:00Z",
      target_sha256: "",
      transport_target_sha256: "",
    };
    const setTarget = (listings: typeof rows, authenticated: boolean) => {
      const decoded = Buffer.from(
        JSON.stringify({
          listing_delivery_schema: 1,
          revision: 1,
          withdrawn_ids: [],
          directory: { format_version: accepted.format_version, listings },
        }),
      );
      const wire = encodeCompactListing(decoded);
      if (authenticated) {
        status.target_sha256 = digest(decoded);
        status.transport_target_sha256 = digest(wire);
        status.listing_count = listings.length;
      }
      writeFileSync(target, wire);
    };
    setTarget(rows, true);
    context.mock.method(childProcess, "spawnSync", (_artifact: string, args: string[]) => {
      if (args.at(-1) === "listing-status")
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify({
            data: status,
            ok: true,
            command: "catalog.listing-status",
          }),
          stderr: "",
        };
      assert.deepEqual(args.slice(-3, -1), ["inspect-listings", "--path"]);
      const data: unknown = JSON.parse(readFileSync(args.at(-1)!, "utf8"));
      return { status: 0, signal: null, stdout: JSON.stringify({ data }), stderr: "" };
    });
    syncBuiltinESMExports();
    const options = {
      catalogRoot: source,
      outputDirectory: join(f.root, "cover-proposals"),
      validatorCli,
      target,
      library: join(f.root, "verification-library"),
    };
    const { report } = await prepareSharedCoverBatch(options);
    assert.deepEqual(report.changed_records, [peer]);
    assert.deepEqual(report.record_changes[0]?.listing_fields, ["artwork"]);
    assert.equal(report.operational_changed, false);
    assert.deepEqual(
      report.outcomes.find(({ id }) => id === peer),
      {
        id: peer,
        game_id: game.id,
        source_edition_id: "exact-edition",
        status: "prepared",
        donor_port_id: donor,
        mapping: artwork,
      },
    );
    assert.equal(report.outcomes.find(({ id }) => id === other)?.status, "no-accepted-donor");
    setTarget(
      rows.filter(({ id }) => id === donor),
      false,
    );
    await assert.rejects(
      prepareSharedCoverBatch(options),
      /differs from the exact authenticated compact target/u,
    );
    setTarget(
      rows.map((row) =>
        row.id === donor ? { ...row, artwork: { ...artwork, image_sha256: "e".repeat(64) } } : row,
      ),
      true,
    );
    const changed = await prepareSharedCoverBatch(options);
    assert.deepEqual(changed.report.changed_records, []);
    setTarget(
      rows.map((row) =>
        row.id === other ? { ...row, artwork: { ...artwork, image_sha256: "e".repeat(64) } } : row,
      ),
      true,
    );
    assert.deepEqual((await prepareSharedCoverBatch(options)).report.changed_records, []);
    setTarget(rows, true);
    assert.deepEqual(
      (await prepareSharedCoverBatch({ ...options, identities: { [donor]: null } })).report
        .changed_records,
      [],
    );
    assert.deepEqual(
      (await prepareSharedCoverBatch({ ...options, identities: { [peer]: null } })).report
        .changed_records,
      [],
    );
    const conflicting = { ...artwork, image_sha256: "e".repeat(64) };
    const retainedResult = {
      port: { id: other, presentation: { artwork: conflicting } },
      record: {
        port_id: other,
        role: "cover",
        reason: "exact-original-game-cover",
        mapping: conflicting,
        exceptions: [],
        checks: { content: { ...batchImage(), sha256: conflicting.image_sha256 } },
      },
    };
    const refreshedAt = new Date().toISOString();
    const retainedPath = join(options.outputDirectory, `artwork-refresh-progress-${other}.json`);
    writeFileSync(
      retainedPath,
      JSON.stringify({
        format: 1,
        port_id: other,
        input_sha256: "a".repeat(64),
        result_sha256: observationHash(retainedResult),
        result: retainedResult,
        complete: true,
        observed_at: refreshedAt,
        last_live_observation_at: refreshedAt,
        retry_at: null,
      }),
    );
    assert.deepEqual((await prepareSharedCoverBatch(options)).report.changed_records, []);
    for (const reason of ["collection-image-digest-changed", "companion-image-digest-changed"]) {
      const fallback = {
        port: { id: other },
        record: {
          ...retainedResult.record,
          mapping: null,
          checks: null,
          exceptions: [{ reason, image_id: artwork.image_id }],
        },
      };
      writeFileSync(
        retainedPath,
        JSON.stringify({
          format: 1,
          port_id: other,
          input_sha256: "a".repeat(64),
          result_sha256: observationHash(fallback),
          result: fallback,
          complete: false,
          observed_at: refreshedAt,
          last_live_observation_at: null,
          retry_at: null,
        }),
      );
      assert.deepEqual((await prepareSharedCoverBatch(options)).report.changed_records, []);
    }
    rmSync(retainedPath);
    const images = [artwork.image_id];
    writeFileSync(
      join(options.outputDirectory, "artwork-gone.json"),
      JSON.stringify({
        format: 1,
        image_ids: images,
        sha256: observationHash(images),
      }),
    );
    assert.deepEqual((await prepareSharedCoverBatch(options)).report.changed_records, []);
    assert.equal(
      readCatalogSource(source).authored.find((entry) => entry.listing.id === peer)?.listing
        .artwork,
      undefined,
    );
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    f.clean();
  }
});

void test("single-port preparation reuses selected artwork and rebuilds the current composition", async () => {
  const f = fixture();
  try {
    const source = copiedCatalog(join(f.root, "source"));
    const unrelatedPath = join(source, "ports", "2xtreme-recomp-catsandsoup-2xtreme.json");
    const unrelated = JSON.parse(readFileSync(unrelatedPath, "utf8")) as AuthoredPort;
    assert.ok(unrelated.listing.artwork);
    const id = "prepare-fixture";
    writeFileSync(
      join(source, "ports", `${id}.json`),
      JSON.stringify({
        format_version: 1,
        listing: { id, name: "Selected port", project_url: project, summary: "Selected fixture." },
      }),
    );
    let queries = 0;
    let images = 0;
    const options = {
      catalogRoot: source,
      outputDirectory: join(f.root, "output"),
      projectUrl: project,
      id: "prepare-fixture",
      name: "Selected port",
      identities: {
        [unrelated.listing.id]: {
          underlying_game: { game_id: 99999, slug: "unrelated-override" },
        },
      },
      facts: { fetcher: f.fetcher(() => json(metadata)) },
      artwork: {
        inspectGame: (identity: { names: string[]; project_url: string | null }) => {
          queries++;
          return [
            {
              id: 70,
              slug: "fixture-port",
              name: identity.names[0],
              websites: [{ url: identity.project_url }],
              cover: { id: 71, image_id: "onboardingfixture" },
            },
          ];
        },
        inspectImage: () => {
          images++;
          return { ...batchImage(), sha256: (images === 1 ? "d" : "e").repeat(64) };
        },
      },
    };
    const first = await preparePort(options);
    const warm = await preparePort(options);
    const batch = await prepareArtworkBatch({ ...options, selectedPortIds: [id] });
    assert.equal(batch.report.artwork_reused, true);
    assert.deepEqual(batch.report.files.records, first.report.files.records);
    assert.equal(batch.report.files.listings, first.report.files.listings);
    unrelated.listing.name = "Unrelated title renamed";
    delete unrelated.listing.artwork;
    writeFileSync(unrelatedPath, JSON.stringify(unrelated));
    const unrelatedChange = await preparePort(options);
    const relevantChange = await preparePort({ ...options, name: "Selected port revised" });
    assert.equal(first.report.artwork_reused, false);
    assert.equal(warm.report.artwork_reused, true);
    assert.equal(unrelatedChange.report.artwork_reused, true);
    assert.equal(relevantChange.report.artwork_reused, false);
    assert.equal(queries, 2);
    assert.equal(images, 2);
    assert.deepEqual(first.report.files.records, unrelatedChange.report.files.records);
    const listings = JSON.parse(readFileSync(unrelatedChange.report.files.listings, "utf8")) as {
      listings: AuthoredPort["listing"][];
    };
    const current = listings.listings.find((listing) => listing.id === unrelated.listing.id);
    assert.equal(current?.name, unrelated.listing.name);
    assert.equal(current?.artwork, undefined);
    const updated = JSON.parse(
      readFileSync(relevantChange.report.files.records[0]!.path, "utf8"),
    ) as { listing: { artwork: { image_sha256: string } } };
    assert.equal(updated.listing.artwork.image_sha256, "e".repeat(64));
  } finally {
    f.clean();
  }
});

const hold = (explanation: string) => ({
  id: "download",
  effect: "hold" as const,
  operations: ["download" as const],
  reason: "third-party-component-terms",
  explanation,
});

void test("preparation preserves authored acquisition restrictions despite replacement records and provider facts", async () => {
  const f = fixture();
  try {
    const source = copiedCatalog(join(f.root, "source"));
    const record: AuthoredPort = {
      format_version: 1,
      listing: {
        id: "restricted-preparation-fixture",
        name: "Restricted preparation fixture",
        summary: "An unresolved acquisition condition.",
        project_url: project,
        restrictions: [hold("Resolve the exact bundled-component permission.")],
      },
    };
    const file = join(source, "ports", `${record.listing.id}.json`);
    const original = `${JSON.stringify(record, null, 2)}\n`;
    writeFileSync(file, original);
    const authoredCondition = record.listing.restrictions?.[0]?.explanation;
    for (const condition of [undefined, "A package exists now.", authoredCondition]) {
      const proposal = structuredClone(record);
      if (condition === undefined) delete proposal.listing.restrictions;
      else proposal.listing.restrictions = [hold(condition)];
      proposal.listing.availability = "packages";
      proposal.listing.release_url = `${project}/releases`;
      proposal.listing.download_asset_hints = { "windows-x86-64": ["windows", ".zip"] };
      const prepare = () =>
        preparePort({
          catalogRoot: source,
          outputDirectory: join(
            f.root,
            `proposal-${condition === undefined ? "removed" : condition === authoredCondition ? "retained" : "changed"}`,
          ),
          record: proposal,
          facts: {
            fetcher: f.fetcher((url) => {
              if (url.endsWith("/repos/example/fixture"))
                return json({ ...metadata, description: "New upstream package available." });
              if (url.includes("/releases")) return json([]);
              return assert.fail(`Unexpected request ${url}`);
            }),
          },
          artwork: { inspectGame: () => [] },
        });
      if (condition !== authoredCondition)
        await assert.rejects(prepare(), /cannot remove or change an authored download restriction/);
      else {
        const result = await prepare();
        const listing = (
          JSON.parse(readFileSync(result.report.files.listings, "utf8")) as {
            listings: AuthoredPort["listing"][];
          }
        ).listings.find((entry) => entry.id === record.listing.id) as
          | Record<string, unknown>
          | undefined;
        assert.equal(listing?.download_block_reason, condition);
        assert.equal(result.report.operational_changed, false);
      }
      assert.equal(readFileSync(file, "utf8"), original);
    }
  } finally {
    f.clean();
  }
});

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
      if (route.startsWith("managed") && route !== "managed-gitlab") {
        assert.match(result.report.next, /No authored record changes were proposed/);
      } else if (changedRecord) {
        assert.match(result.report.next, /copy accepted records into catalog\/ports/);
      }
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

void test("refresh keeps the authored regional cover selection through the listing proposal", async () => {
  const f = fixture();
  try {
    const source = copiedCatalog(join(f.root, "source"));
    const id = "kula-world-recompiled-zap0xfce2-kula-world";
    const authored = readCatalogSource(source).records.find(({ listing }) => listing.id === id)!;
    const selection = authored.igdb_regional_cover!;
    assert.throws(
      () =>
        checkedAuthoredPort({
          ...authored,
          listing: {
            ...authored.listing,
            artwork: { ...(authored.listing.artwork as object), image_id: "maincover" },
          },
        }),
      /does not match its IGDB regional cover selection/,
    );
    const inspected: string[] = [];
    const result = await prepareArtworkBatch({
      catalogRoot: source,
      outputDirectory: join(f.root, "regional"),
      selectedPortIds: [id],
      refreshPortIds: [id],
      artwork: {
        inspectGame: (identity) => {
          assert.deepEqual(identity.localization, { id: selection.localization_id, region_id: 4 });
          return [
            {
              id: selection.game_id,
              name: selection.name,
              slug: selection.slug,
              platforms: [selection.platform_id],
              cover: { id: 77, image_id: "maincover" },
              game_localizations: [
                {
                  id: selection.localization_id,
                  game: selection.game_id,
                  region: selection.region_id,
                  cover: {
                    id: selection.cover_id,
                    image_id: selection.image_id,
                    game_localization: selection.localization_id,
                  },
                },
              ],
            },
          ];
        },
        inspectImage: (id) => {
          inspected.push(id);
          return batchImage();
        },
      },
    });
    assert.deepEqual(inspected, [selection.image_id]);
    assert.deepEqual(result.report.changed_records, [id]);
    const proposed = JSON.parse(
      readFileSync(result.report.files.records[0]!.path, "utf8"),
    ) as AuthoredPort;
    assert.deepEqual(proposed.igdb_regional_cover, selection);
    assert.ok(isRecord(proposed.listing.artwork));
    assert.equal(proposed.listing.artwork.image_id, selection.image_id);
    assert.equal(proposed.listing.artwork.cover_id, selection.cover_id);
    assert.equal(result.report.operational_changed, false);
  } finally {
    f.clean();
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
    const acceptedCollection = accepted.records.find(
      ({ listing }) =>
        Array.isArray(listing.collection_covers) && listing.collection_covers.length > 0,
    );
    assert.ok(acceptedCover);
    assert.ok(acceptedCollection);
    const selectedPortIds = [
      ...additions.map((record) => record.listing.id),
      acceptedCover.listing.id,
      acceptedCollection.listing.id,
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
    for (const selectedPortIds of [[], [ids[0]!, ids[0]!], ["not-a-known-port"]]) {
      await assert.rejects(
        prepareArtworkBatch({
          catalogRoot,
          outputDirectory: join(f.root, "output"),
          selectedPortIds,
          artwork: { inspectGame: () => assert.fail("invalid selection reached provider") },
        }),
        /unique known stable IDs/,
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
      ["--artwork-ids", ids[0]!, "--artwork-due-limit", "1"],
      ["--artwork-ids", "@due", "--artwork-due-limit", "401"],
      ["--artwork-ids", "@due", "--artwork-due-limit", "1", "--artwork-retained-limit", "1"],
    ]) {
      const result = childProcess.spawnSync(
        process.execPath,
        [script, ...arguments_, "--output-dir", join(f.root, "output")],
        { encoding: "utf8", timeout: 10000 },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /cannot mix|requires --artwork-ids|requires @due|Choose either/);
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
      [...result.report.changed_records].sort(),
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

void test("artwork preparation refuses a concurrent checkpoint worker without touching its progress", async () => {
  const f = fixture();
  const entry = readCatalogSource(catalogRoot).records[0]!;
  const outputDirectory = join(f.root, "output");
  let held = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const first = prepareArtworkBatch({
      catalogRoot,
      outputDirectory,
      selectedPortIds: [entry.listing.id],
      onProgress: async () => {
        held = true;
        await gate;
      },
    });
    while (!held) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      prepareArtworkBatch({ catalogRoot, outputDirectory, selectedPortIds: [entry.listing.id] }),
      /EEXIST/,
    );
    assert.ok(readdirSync(outputDirectory).includes("active.lock"));
    release();
    await first;
    assert.ok(!readdirSync(outputDirectory).includes("active.lock"));
  } finally {
    release();
    f.clean();
  }
});

void test("due maintenance resume delivers earlier undelivered record proposals", async () => {
  const f = fixture();
  try {
    const source = copiedCatalog(join(f.root, "source"));
    rmSync(join(source, "ports"), { recursive: true });
    mkdirSync(join(source, "ports"));
    for (const id of ["due-one", "due-two"]) {
      writeFileSync(
        join(source, "ports", `${id}.json`),
        JSON.stringify({
          format_version: 1,
          listing: {
            id,
            name: id,
            summary: "Due fixture",
            project_url: `https://example.org/${id}`,
          },
        }),
      );
    }
    const calls: string[] = [];
    const options = {
      catalogRoot: source,
      outputDirectory: join(f.root, "output"),
      maintenance: true,
      artwork: {
        inspectGame(identity: { names: string[]; project_url: string | null }) {
          const name = identity.names[0]!;
          calls.push(name);
          return [
            {
              id: name === "due-one" ? 1 : 2,
              name,
              slug: name,
              websites: [{ url: identity.project_url }],
              cover: { id: 1, image_id: name.replaceAll("-", "") },
            },
          ];
        },
        inspectImage: batchImage,
      },
    };
    await assert.rejects(
      prepareArtworkBatch({
        ...options,
        onProgress() {
          throw new Error("fixture interruption");
        },
      }),
      /fixture interruption/,
    );
    const resumed = await prepareArtworkBatch(options);
    assert.deepEqual(calls.sort(), ["due-one", "due-two"]);
    assert.deepEqual(resumed.report.changed_records.sort(), ["due-one", "due-two"]);
    assert.deepEqual(resumed.report.pending_port_ids, []);
    const listings = JSON.parse(readFileSync(resumed.report.files.listings, "utf8")) as {
      listings: { artwork?: unknown }[];
    };
    assert.equal(listings.listings.length, 2);
    assert.ok(listings.listings.every((listing) => listing.artwork));
    assert.ok(readCatalogSource(source).records.every((record) => !record.listing.artwork));
  } finally {
    f.clean();
  }
});

void test("native exact-pin feedback does not borrow unrelated release hints or authenticity", () => {
  const pin = {
    version: "release-20260930",
    url: "https://github.com/example/project/releases/download/release-20260930/Complete-Win.zip",
    size: 42,
    sha256: "a".repeat(64),
  };
  const record: AuthoredPort = {
    format_version: 1,
    listing: {
      id: "pin-fixture",
      name: "Pinned fixture",
      summary: "Fixture",
      project_url: "https://github.com/example/project",
    },
    integration: {
      adapter: "native-portable",
      platforms: ["windows-x86-64"],
      release: { provider: "direct-manifest", direct: { "windows-x86-64": pin } },
      persistent_paths: [],
    },
  };
  const before = structuredClone(record);
  const feedback = portablePreparationFeedback(record, {
    assets_complete: true,
    assets: [{ name: "Wrong-Win.zip", digest: `sha256:${"b".repeat(64)}` }],
    release: {
      endpoint: "https://api.github.com/repos/example/project/releases/latest",
      status: "observed",
      body: { tag_name: "future-release", prerelease: true },
    },
  })!;
  assert.equal(feedback.maintenance.observed_release_tag, null);
  assert.equal(feedback.maintenance.observed_provider_prerelease, null);
  assert.deepEqual(feedback.platforms[0]!.hint_matches, []);
  assert.deepEqual(feedback.pinned_releases[0]!.declaration, pin);
  assert.match(feedback.maintenance.next, /capability version 3/);
  assert.match(feedback.maintenance.scope, /requires a reviewed declaration change/);
  assert.doesNotMatch(feedback.maintenance.scope, /do not require routine definition edits/);
  assert.match(feedback.pinned_releases[0]!.scope, /Declared pin only/);
  assert.deepEqual(record, before);
});

void test("package hints surface older release tokens independently of current tag spelling", () => {
  for (const tag of ["v2.4.0", "2.4.0", "release-next", null]) {
    const hints = ["Game-v1.2.3-windows-x64.zip", "game_1.2.3_win64.zip"];
    const record: AuthoredPort = {
      format_version: 1,
      listing: {
        id: "fixture",
        name: "Fixture",
        summary: "Fixture",
        project_url: "https://github.com/example/fixture",
        download_asset_hints: { "windows-x86-64": hints },
      },
    };
    const feedback = downloadPreparationFeedback(record, {
      assets_complete: false,
      assets: [],
      ...(tag
        ? {
            release: {
              endpoint: "https://api.github.com/repos/example/fixture/releases/latest",
              status: "observed" as const,
              body: { tag_name: tag },
            },
          }
        : {}),
    })!;
    assert.deepEqual(feedback.maintenance.potential_version_restrictions, [
      { platform: "windows-x86-64", hints },
    ]);
    assert.equal(feedback.assets_complete, false);
  }
});

void test("numeric architecture ABI and engine-generation fragments remain legitimate hints", () => {
  const record: AuthoredPort = {
    format_version: 1,
    listing: {
      id: "fixture",
      name: "Fixture",
      summary: "Fixture",
      project_url: "https://github.com/example/fixture",
      download_asset_hints: {
        "linux-x86-64": ["x86_64", "SDL2", "d3d11", "libc6", "UE5", "SDL2.0"],
      },
    },
  };
  const feedback = downloadPreparationFeedback(record, { assets_complete: true, assets: [] })!;
  assert.deepEqual(feedback.maintenance.potential_version_restrictions, []);
});

function listingObservationCandidate(listing: Record<string, unknown>) {
  const repository =
    typeof listing.release_url === "string"
      ? githubReleaseRepository(listing.release_url)
      : undefined;
  const fallback =
    typeof listing.project_url === "string" ? githubRepository(listing.project_url) : undefined;
  assert.ok(repository ?? fallback);
  return {
    ...structuredClone(listing),
    id: listing.id,
    upstream_observation: {
      provider: "github",
      repository: repository ?? fallback,
      repository_id: null,
      status: "failed",
      attempted_at: "2026-10-29T00:00:00Z",
      observed_at: null,
      fresh_until: null,
      facts_sha256: null,
      release_limit: 4,
      releases: [],
    },
  };
}

void test("retained observation preparation preserves contracts and authored facts without collection", (context) => {
  const f = fixture();
  const accepted = readCatalogSource(catalogRoot);
  const ids = ["marathon-aleph-one", "3d-pinball-for-windows-space-cadet-spacecadetpinball"];
  const candidates = ids.map((id) => {
    const listing = accepted.directory.listings.find((listing) => listing.id === id);
    assert.ok(listing);
    return listingObservationCandidate(listing);
  });
  const handoff = { descriptive_listing_candidates: candidates, execution: { kind: "fixture" } };
  const before = structuredClone(handoff);
  let network = 0;
  context.mock.method(globalThis, "fetch", () => {
    network++;
    throw new Error("Provider access is forbidden");
  });
  try {
    const options = { catalogRoot, outputDirectory: join(f.root, "output"), handoff };
    const result = prepareListingObservations(options);
    assert.deepEqual(result.report.selected_port_ids, [...ids].sort());
    assert.deepEqual([...result.report.changed_records].sort(), [...ids].sort());
    assert.equal(result.report.operational_changed, false);
    assert.equal(result.report.artwork_reused, true);
    assert.equal(result.report.files.records.length, 2);
    assert.deepEqual(
      JSON.parse(readFileSync(result.report.files.catalog, "utf8")),
      accepted.catalog,
    );
    for (const change of result.report.record_changes) {
      assert.equal(change.integration_changed, false);
      assert.deepEqual(change.listing_fields, ["upstream_observation"]);
    }
    for (const file of result.report.files.records) {
      const record = JSON.parse(readFileSync(file.path, "utf8")) as AuthoredPort;
      const prior = accepted.records.find((entry) => entry.listing.id === record.listing.id)!;
      const { upstream_observation, ...listing } = record.listing;
      assert.deepEqual(listing, prior.listing);
      assert.deepEqual(record.integration, prior.integration);
      assert.deepEqual(record.release_maintenance, prior.release_maintenance);
      assert.deepEqual(
        upstream_observation,
        candidates.find((entry) => entry.id === record.listing.id)!.upstream_observation,
      );
    }
    assert.deepEqual(readCatalogSource(catalogRoot), accepted);
    assert.deepEqual(handoff, before);
    assert.equal(network, 0);
    assert.equal(existsSync(join(options.outputDirectory, "active.lock")), false);
    const resumed = prepareListingObservations(options);
    assert.deepEqual(resumed.report.files.records, result.report.files.records);
    assert.equal(resumed.report.handoff_semantic_sha256, result.report.handoff_semantic_sha256);
    assert.equal(network, 0);
  } finally {
    f.clean();
  }
});

void test("observation preparation refuses stale declarations, duplicate and unknown identities before writing", () => {
  const f = fixture();
  try {
    const accepted = readCatalogSource(catalogRoot);
    const listing = accepted.directory.listings.find((value) => value.id === "marathon-aleph-one")!;
    const candidate = listingObservationCandidate(listing);
    const invalid = [
      { descriptive_listing_candidates: [{ ...candidate, name: "Old authored name" }] },
      { descriptive_listing_candidates: [{ ...candidate, release_maintenance: null }] },
      {
        descriptive_listing_candidates: [
          { ...candidate, download_block_reason: "Invented restriction" },
        ],
      },
      { descriptive_listing_candidates: [candidate, candidate] },
      { descriptive_listing_candidates: [{ ...candidate, id: "unknown-project" }] },
      { descriptive_listing_candidates: [{ ...candidate, upstream_observation: null }] },
      { descriptive_listing_candidates: "incomplete" },
      null,
    ];
    for (const handoff of invalid) {
      const outputDirectory = join(f.root, "refused");
      assert.throws(
        () => prepareListingObservations({ catalogRoot, outputDirectory, handoff }),
        /declaration changed|unique existing|requires an exact|requires.*stable ID|Each descriptive|handoff is required/,
      );
      assert.equal(existsSync(outputDirectory), false);
    }
    assert.deepEqual(readCatalogSource(catalogRoot), accepted);
  } finally {
    f.clean();
  }
});

void test("listing observation CLI rejects mixed investigation and artwork routes", () => {
  const f = fixture();
  try {
    for (const extra of [
      ["--project", project],
      ["--artwork-ids", "marathon-aleph-one"],
      ["--record", "absent.json"],
      ["--identities", "absent.json"],
    ]) {
      const result = childProcess.spawnSync(
        process.execPath,
        [
          "scripts/prepare-port.mts",
          "--listing-observations",
          "absent.json",
          "--output-dir",
          join(f.root, "output"),
          ...extra,
        ],
        { encoding: "utf8" },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Listing observation batches cannot mix/);
      assert.equal(existsSync(join(f.root, "output")), false);
    }
  } finally {
    f.clean();
  }
});

void test("prepared observations bind the accepted observation preimage and cannot erase a later snapshot", () => {
  const f = fixture();
  try {
    const localCatalog = join(f.root, "catalog");
    cpSync(catalogRoot, localCatalog, { recursive: true });
    const initial = readCatalogSource(localCatalog);
    const listing = initial.directory.listings.find((value) => value.id === "marathon-aleph-one")!;
    const candidate = listingObservationCandidate(listing);
    const first = prepareListingObservations({
      catalogRoot: localCatalog,
      outputDirectory: join(f.root, "first"),
      handoff: { descriptive_listing_candidates: [candidate] },
    });
    // Model acceptance through the existing canonical-record owner, not a new feed.
    writeFileSync(
      join(localCatalog, "ports/marathon-aleph-one.json"),
      readFileSync(first.report.files.records[0]!.path),
    );
    const accepted = readCatalogSource(localCatalog);
    const oldPreimage = {
      "marathon-aleph-one": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
    };
    for (const descriptive_listing_preimages of [
      undefined,
      oldPreimage,
      { "marathon-aleph-one": "bad" },
    ]) {
      assert.throws(
        () =>
          prepareListingObservations({
            catalogRoot: localCatalog,
            outputDirectory: join(f.root, "stale"),
            handoff: {
              descriptive_listing_candidates: [candidate],
              ...(descriptive_listing_preimages ? { descriptive_listing_preimages } : {}),
            },
          }),
        /Accepted listing observation changed/,
      );
      assert.equal(existsSync(join(f.root, "stale")), false);
    }
    const current = accepted.directory.listings.find((value) => value.id === "marathon-aleph-one")!;
    const updated = listingObservationCandidate(current);
    updated.upstream_observation.attempted_at = "2026-10-29T01:00:00Z";
    const prepared = prepareListingObservations({
      catalogRoot: localCatalog,
      outputDirectory: join(f.root, "current"),
      handoff: {
        descriptive_listing_candidates: [updated],
        descriptive_listing_preimages: {
          "marathon-aleph-one": observationHash(current.upstream_observation),
        },
      },
    });
    assert.deepEqual(prepared.report.changed_records, ["marathon-aleph-one"]);
    assert.equal(prepared.report.operational_changed, false);
    assert.deepEqual(readCatalogSource(localCatalog), accepted);
  } finally {
    f.clean();
  }
});

void test("preparation reports all declared route projections across the current catalog", () => {
  const { records } = readCatalogSource(catalogRoot);
  const routeRecords = records.filter((record) => record.route_facts_v1);
  const gbaRecords = records.filter((record) => record.gba_staged_archive_v1);
  assert.ok(routeRecords.some((record) => record.route_facts_v1?.managed_native));
  assert.ok(
    routeRecords.some((record) => record.integration?.adapter === "staged-source-portable"),
  );
  assert.ok(routeRecords.some((record) => record.integration === undefined));
  assert.ok(gbaRecords.length > 0);
  assert.ok(records.some((record) => record.psx_managed_windows_v1));
  assert.ok(records.some((record) => record.n64_recomp_persistence_v1));
  assert.ok(records.some((record) => record.reviewed_flat_package_layout_v1));
  assert.ok(records.some((record) => record.external_registration_v1));
  for (const record of records) {
    const id = record.listing.id;
    const feedback = declarativePreparationFeedback(record);
    const expected = [];
    if (record.reviewed_flat_package_layout_v1) expected.push("reviewed_flat_package_layout_v1");
    if (record.route_facts_v1) expected.push("route_facts_v1");
    if (record.gba_staged_archive_v1) expected.push("gba_staged_archive_v1");
    if (record.psx_managed_windows_v1) expected.push("psx_managed_windows_v1");
    if (record.n64_recomp_persistence_v1) expected.push("n64_recomp_persistence_v1");
    if (record.external_registration_v1) expected.push("external_registration_v1");
    assert.deepEqual(
      feedback.projections.map(({ field }) => field),
      expected,
      id,
    );
    assert.equal(feedback.status, expected.length > 0 ? "declared" : "undeclared", id);
    assert.match(feedback.original_files, /does not establish/, id);
  }
});

void test("a reviewed operational record retains the verified origin on issue-free onboarding", async (context) => {
  const f = fixture();
  try {
    const root = copiedCatalog(join(f.root, "catalog"));
    const id = "dungeon-crawl-stone-soup";
    const reviewed = readCatalogSource(root).records.find((record) => record.listing.id === id)!;
    const { upstream_lineage: expected, ...unbound } = reviewed;
    rmSync(join(root, "ports", `${id}.json`));
    const validatorCli = join(f.root, "selected-cli");
    writeFileSync(validatorCli, "inert origin validation fixture");
    context.mock.method(childProcess, "spawnSync", (_artifact: string, args: string[]) => {
      const input = readFileSync(args.at(-1)!);
      const data: unknown = args.includes("inspect-proposal")
        ? {
            format_version: 1,
            input_sha256: createHash("sha256").update(input).digest("hex"),
            input_bytes: input.length,
            ports: [],
            scope: "repository-summary-policy",
          }
        : JSON.parse(input.toString("utf8"));
      return { status: 0, signal: null, stdout: JSON.stringify({ data }), stderr: "" };
    });
    syncBuiltinESMExports();
    const options = {
      catalogRoot: root,
      outputDirectory: join(f.root, "output"),
      projectUrl: reviewed.listing.project_url,
      originalGame: reviewed.listing.original_game,
      record: unbound,
      validatorCli,
      facts: {
        fetcher: f.fetcher((url) =>
          url.includes("/releases?")
            ? json([])
            : json({ ...metadata, id: 23038334, full_name: "crawl/crawl", archived: false }),
        ),
      },
      artwork: { inspectGame: () => [] },
    };
    const result = await preparePort(options);
    const first = readFileSync(result.report.files.records[0]!.path, "utf8");
    const candidate = checkedAuthoredPort(JSON.parse(first));
    assert.deepEqual(candidate.upstream_lineage, expected);
    assert.equal(candidate.listing.issue_number, undefined);
    assert.deepEqual(candidate.listing.original_game, reviewed.listing.original_game);
    assert.deepEqual(candidate.integration, reviewed.integration);
    const repeat = await preparePort(options);
    assert.equal(readFileSync(repeat.report.files.records[0]!.path, "utf8"), first);
    await assert.rejects(
      preparePort({ ...options, projectUrl: "https://github.com/crawl/other" }),
      /reviewed record belongs to another project URL/u,
    );
    await assert.rejects(
      preparePort({ ...options, originalGame: { ...reviewed.listing.original_game, id: "other" } }),
      /reviewed record and supplied game or edition identity differ/u,
    );
    const unverifiedAssociation = {
      ...unbound,
      listing: { ...unbound.listing, issue_number: 900000001 },
    };
    await assert.rejects(
      preparePort({ ...options, record: unverifiedAssociation }),
      /cannot supply an unverified issue association/u,
    );
    const release = unbound.integration?.release;
    assert.ok(release && typeof release === "object");
    const otherRepository = {
      ...unbound,
      integration: {
        ...unbound.integration,
        release: { ...release, repository: "another/project" },
      },
    };
    await assert.rejects(
      preparePort({ ...options, record: otherRepository }),
      /must use the official or retained repository/u,
    );
    const differentOrigin = structuredClone(reviewed);
    differentOrigin.upstream_lineage!.origin.repository!.id = "42";
    await assert.rejects(
      preparePort({ ...options, record: differentOrigin, outputDirectory: join(f.root, "moved") }),
      /reviewed record and provider repository identities differ/u,
    );
    writeFileSync(
      join(root, "ports", `${id}.json`),
      JSON.stringify({ ...reviewed, listing: { ...reviewed.listing, issue_number: 900000001 } }),
    );
    await assert.rejects(
      preparePort({ ...options, record: reviewed, outputDirectory: join(f.root, "existing") }),
      /review changes to an existing issue association or lineage/iu,
    );
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    f.clean();
  }
});

void test("official URL preparation compacts the exact TechnicallyComputers PSX persistence layouts", async () => {
  const f = fixture();
  try {
    const root = copiedCatalog(join(f.root, "catalog"));
    const accepted = readCatalogSource(root);
    for (const [id, repository, recipe] of [
      [
        "bomberman-fantasy-race-recompiled",
        "TechnicallyComputers/Bomberman-Fantasy-Race-Recomp",
        "technically-computers",
      ],
      [
        "bomberman-party-edition-recompiled",
        "TechnicallyComputers/BombermanPartyEditionRecomp",
        "technically-computers-input-files",
      ],
      [
        "final-fantasy-vii-recompiled",
        "TechnicallyComputers/Final-Fantasy-VII",
        "technically-computers-input-files",
      ],
    ] as const) {
      const record = accepted.records.find((entry) => entry.listing.id === id)!;
      const explicit = projectPsxManagedWindows(record);
      delete explicit.psx_managed_windows_v1;
      const source = join(root, "ports", `${id}.json`);
      const bytes = JSON.stringify(explicit);
      writeFileSync(source, bytes);
      const result = await preparePort({
        id,
        catalogRoot: root,
        outputDirectory: join(f.root, id),
        projectUrl: record.listing.project_url,
        originalGame: record.listing.original_game,
        facts: {
          fetcher: f.fetcher((url) =>
            url.includes("/releases?")
              ? json([])
              : json({
                  ...metadata,
                  full_name: repository,
                  archived: false,
                }),
          ),
        },
        artwork: { inspectGame: () => [] },
      });
      const candidate = checkedAuthoredPort(
        JSON.parse(readFileSync(result.report.files.records[0]!.path, "utf8")),
      );
      assert.deepEqual(result.report.changed_records, [id]);
      assert.equal(result.report.operational_changed, false);
      assert.equal(candidate.psx_managed_windows_v1, recipe);
      const advice = result.report.declarative_authoring.projections.find(
        ({ field }) => field === "psx_managed_windows_v1",
      );
      assert.ok(advice);
      if (recipe === "technically-computers-input-files") {
        assert.match(advice.scope, /declare their runtime root and mutable files/u);
        assert.match(advice.next, /raw disc set/u);
      }
      assert.deepEqual(candidate.listing.original_game, record.listing.original_game);
      assert.deepEqual(projectPsxManagedWindows(candidate).integration, explicit.integration);
      assert.equal(readFileSync(source, "utf8"), bytes);
    }
  } finally {
    f.clean();
  }
});

void test("official URL preparation compacts the exact Alexbeav PSX layout without a crash log", async () => {
  const f = fixture();
  try {
    const root = copiedCatalog(join(f.root, "catalog"));
    const accepted = readCatalogSource(root);
    const id = "alexbeav-brave-fencer-musashi-recomp";
    const record = accepted.records.find((entry) => entry.listing.id === id)!;
    const explicit = projectPsxManagedWindows(record);
    delete explicit.psx_managed_windows_v1;
    const source = join(root, "ports", `${id}.json`);
    const bytes = JSON.stringify(explicit);
    writeFileSync(source, bytes);
    const result = await preparePort({
      id,
      catalogRoot: root,
      outputDirectory: join(f.root, "output"),
      projectUrl: record.listing.project_url,
      originalGame: record.listing.original_game,
      facts: {
        fetcher: f.fetcher((url) =>
          url.includes("/releases?")
            ? json([])
            : json({
                ...metadata,
                full_name: "alexbeavs-ps1-ports/brave-fencer-musashi-recomp",
                archived: false,
              }),
        ),
      },
      artwork: { inspectGame: () => [] },
    });
    const candidate = checkedAuthoredPort(
      JSON.parse(readFileSync(result.report.files.records[0]!.path, "utf8")),
    );
    assert.deepEqual(result.report.changed_records, [id]);
    assert.equal(result.report.operational_changed, false);
    assert.equal(candidate.psx_managed_windows_v1, "split-mods-no-crash-log");
    assert.deepEqual(candidate.listing.original_game, record.listing.original_game);
    assert.equal(readFileSync(source, "utf8"), bytes);
  } finally {
    f.clean();
  }
});

void test("official URL preparation keeps both explicit PSX diagnostics routes explicit", async () => {
  const f = fixture();
  try {
    const root = copiedCatalog(join(f.root, "catalog"));
    const accepted = readCatalogSource(root);
    for (const [id, repositoryId] of [
      ["alexbeav-medievil-recomp", 1355812398],
      ["mortal-kombat-4-recompiled", 1352192597],
    ] as const) {
      const record = accepted.records.find((entry) => entry.listing.id === id)!;
      assert.equal(record.psx_managed_windows_v1, undefined);
      assert.ok(
        (record.integration!.persistent_paths as string[]).includes("diagnostics-location.txt"),
      );
      const source = join(root, "ports", `${id}.json`);
      const bytes = readFileSync(source, "utf8");
      const result = await preparePort({
        id,
        catalogRoot: root,
        outputDirectory: join(f.root, id),
        projectUrl: record.listing.project_url,
        originalGame: record.listing.original_game,
        facts: {
          fetcher: f.fetcher((url) =>
            url.includes("/releases?")
              ? json([])
              : json({
                  ...metadata,
                  id: repositoryId,
                  full_name: new URL(record.listing.project_url).pathname.slice(1),
                  archived: false,
                }),
          ),
        },
        artwork: { inspectGame: () => [] },
      });
      // No title-keyed shorthand reproduces these routes, so nothing is compacted.
      assert.deepEqual(result.report.changed_records, []);
      assert.deepEqual(result.report.files.records, []);
      assert.equal(result.report.operational_changed, false);
      assert.deepEqual(
        JSON.parse(readFileSync(result.report.files.catalog, "utf8")),
        accepted.catalog,
      );
      assert.equal(readFileSync(source, "utf8"), bytes);
    }
  } finally {
    f.clean();
  }
});

void test("official URL preparation proposes the exact reviewed N64 persistence layout", async () => {
  const f = fixture();
  try {
    const root = copiedCatalog(join(f.root, "catalog"));
    const accepted = readCatalogSource(root);
    const cases = [
      ["quest-64-recompiled", "Rainchus/Quest64-Recomp", true],
      ["dinosaur-planet", "DinosaurPlanetRecomp/dino-recomp", "config-directory"],
      ["donkey-kong-64-recompiled", "Rainchus/Donkey-Kong-64-Recompiled", "technical-settings"],
    ] as const;
    for (const [id, repository, variant] of cases) {
      const selected = accepted.records.find((entry) => entry.listing.id === id)!;
      const explicit = projectN64RecompPersistence(selected);
      delete explicit.n64_recomp_persistence_v1;
      const source = join(root, "ports", `${id}.json`);
      const original = readFileSync(source);
      const bytes = JSON.stringify(explicit);
      writeFileSync(source, bytes);
      const result = await preparePort({
        catalogRoot: root,
        outputDirectory: join(f.root, id),
        projectUrl: selected.listing.project_url,
        originalGame: selected.listing.original_game,
        facts: {
          fetcher: f.fetcher((url) =>
            url.includes("/releases?")
              ? json([])
              : json({ ...metadata, full_name: repository, archived: false }),
          ),
        },
        artwork: { inspectGame: () => [] },
      });
      assert.equal(result.report.port_id, id);
      assert.deepEqual(result.report.changed_records, [id]);
      assert.equal(result.report.operational_changed, false);
      const proposed = checkedAuthoredPort(
        JSON.parse(readFileSync(result.report.files.records[0]!.path, "utf8")),
      );
      assert.equal(proposed.n64_recomp_persistence_v1, variant);
      assert.deepEqual(proposed.listing.original_game, selected.listing.original_game);
      assert.deepEqual(proposed.listing.issue_number, selected.listing.issue_number);
      assert.deepEqual(
        JSON.parse(readFileSync(result.report.files.catalog, "utf8")),
        accepted.catalog,
      );
      assert.equal(readFileSync(source, "utf8"), bytes);
      writeFileSync(source, original);
    }
  } finally {
    f.clean();
  }
});

void test("reviewed preparation preserves the release origin of an explicit OpenMoHAA route", async () => {
  const f = fixture();
  try {
    const id = "medal-of-honor-allied-assault-spearhead-openmohaa";
    const { records } = readCatalogSource(catalogRoot);
    const selected = records.find((record) => record.listing.id === id)!;
    const explicit = structuredClone(selected);
    const release = explicit.integration!.release;
    assert.ok(release && typeof release === "object");
    explicit.integration!.release = {
      ...release,
      provider: "gitlab",
      repository: "unrelated/mohaa",
    };
    await assert.rejects(
      preparePort({
        id,
        catalogRoot,
        outputDirectory: join(f.root, "output"),
        projectUrl: selected.listing.project_url,
        originalGame: selected.listing.original_game,
        record: explicit,
        facts: {
          fetcher: f.fetcher((url) =>
            url.includes("/releases?")
              ? json([])
              : json({ ...metadata, id: 29029846, full_name: "openmoh/openmohaa" }),
          ),
        },
        artwork: { inspectGame: () => [] },
      }),
      /Review changes to an existing release provider as a record edit/u,
    );
  } finally {
    f.clean();
  }
});

void test("unsupported managed subshapes and contradictory GBA paths fail authoring validation", () => {
  const { records } = readCatalogSource(catalogRoot);
  const native = structuredClone(records.find((record) => record.route_facts_v1?.managed_native)!);
  native.integration!.source_profile = "required-original";
  assert.throws(() => checkedAuthoredPort(native), /without a Core source binding/);

  const gba = structuredClone(records.find((record) => record.gba_staged_archive_v1)!);
  gba.integration!.persistent_paths = ["contradictory"];
  assert.throws(() => checkedAuthoredPort(gba), /already own persistent_paths/);
});

void test("official URL preparation compacts an already reviewed exact flat package layout", async () => {
  const f = fixture();
  try {
    const root = copiedCatalog(join(f.root, "catalog"));
    const id = "gunstar-heroes-gunstars";
    const selected = readCatalogSource(root).records.find((record) => record.listing.id === id)!;
    const explicit = projectReviewedFlatPackageLayout(selected);
    delete explicit.reviewed_flat_package_layout_v1;
    const source = join(root, "ports", `${id}.json`);
    const bytes = JSON.stringify(explicit);
    writeFileSync(source, bytes);
    const prepared = await preparePort({
      id,
      catalogRoot: root,
      outputDirectory: join(f.root, "output"),
      projectUrl: selected.listing.project_url,
      originalGame: selected.listing.original_game,
      facts: {
        fetcher: f.fetcher((url) =>
          url.includes("/releases?")
            ? json([])
            : json({ ...metadata, id: 1424763220, full_name: "1nputs/gunstars", archived: false }),
        ),
      },
      artwork: { inspectGame: () => [] },
    });
    const candidate = checkedAuthoredPort(
      JSON.parse(readFileSync(prepared.report.files.records[0]!.path, "utf8")),
    );
    assert.deepEqual(prepared.report.changed_records, [id]);
    assert.equal(prepared.report.operational_changed, false);
    assert.deepEqual(candidate.reviewed_flat_package_layout_v1, ["windows-x86-64", "linux-x86-64"]);
    assert.deepEqual(candidate.listing.original_game, selected.listing.original_game);
    assert.equal(readFileSync(source, "utf8"), bytes);
  } finally {
    f.clean();
  }
});

void test("settings qualification requests complete exact package facts and limits missing evidence to settings", async () => {
  const f = fixture();
  try {
    const authored = readCatalogSource(catalogRoot);
    const ship = authored.records.find((entry) => entry.listing.id === "shipwright")!;
    const upstream = ship.listing.project_url;
    const tag = "9.9.9";
    const result = await preparePort({
      catalogRoot,
      outputDirectory: join(f.root, "settings"),
      id: ship.listing.id,
      releaseTag: tag,
      settingsNativeScope: {},
      facts: {
        fetcher: f.fetcher((url) =>
          url.includes("/assets?")
            ? json([
                {
                  id: 31,
                  name: "settings-fixture.zip",
                  size: 42,
                  browser_download_url: `${upstream}/releases/download/${tag}/settings-fixture.zip`,
                },
              ])
            : url.includes("/releases/tags/")
              ? json({
                  id: 30,
                  tag_name: tag,
                  draft: false,
                  html_url: `${upstream}/releases/tag/${tag}`,
                })
              : json({ ...metadata, full_name: "HarbourMasters/Shipwright", private: false }),
        ),
      },
      artwork: { inspectGame: () => [] },
    });
    assert.equal(f.requests.filter((url) => url.includes("/assets?")).length, 1);
    assert.match(JSON.stringify(result.report.settings_qualification), /settings-unqualified/u);
    assert.equal(result.report.operational_changed, false);
    assert.deepEqual(
      JSON.parse(readFileSync(result.report.files.catalog, "utf8")),
      authored.catalog,
    );
  } finally {
    f.clean();
  }
});

void test("first-party mod refresh binds descriptive facts to the accepted public repo and Git blob", async () => {
  const repository = { id: 91000, slug: "fixture/available-port" };
  const root = "repositories/91000";
  const commit = "a".repeat(40);
  const tree = "b".repeat(40);
  const path = "recomplauncher.json";
  const bytes = Buffer.from(
    JSON.stringify({
      format: 1,
      repo: repository.slug,
      start: { program: ["port.exe"], args: ["private-original"] },
      inputs: [
        {
          id: "game",
          label: "Fixture Game",
          formats: [{ type: "file" }],
          check: { ids: ["SLUS-01212"] },
        },
      ],
      mods: { thunderstore: "fixture-mods", gamebanana: 456, loader: "nrm", data: "private-data" },
    }),
  );
  const blob = createHash("sha1")
    .update("blob " + bytes.length + "\0")
    .update(bytes)
    .digest("hex");
  const file = { type: "blob", mode: "100644", sha: blob, path };
  const commitEndpoint = root + "/commits?per_page=1";
  const treeEndpoint = root + "/git/trees/" + tree;
  const contentEndpoint = root + "/contents/" + path + "?ref=" + commit;
  const responses = new Map<string, unknown>([
    [root, { id: repository.id, full_name: repository.slug, private: false }],
    [commitEndpoint, [{ sha: commit, commit: { tree: { sha: tree } } }]],
    [treeEndpoint, { sha: tree, truncated: false, tree: [file] }],
    [
      contentEndpoint,
      {
        type: "file",
        path,
        sha: blob,
        size: bytes.length,
        encoding: "base64",
        content: bytes.toString("base64"),
      },
    ],
  ]);
  const calls: string[] = [];
  const read = async (endpoint: string) => {
    calls.push(endpoint);
    assert(responses.has(endpoint), endpoint);
    return { status: "observed" as const, body: responses.get(endpoint) };
  };
  const result = await observeLauncherModPortals(repository, read);
  assert.deepEqual(calls.splice(0), [root, commitEndpoint, treeEndpoint, contentEndpoint]);
  assert(result.state === "observed");
  assert.equal(result.repository_id, repository.id);
  assert.equal(result.commit, commit);
  assert.equal(result.blob, blob);
  assert.deepEqual(result.game_input_ids, ["SLUS-01212"]);
  assert.deepEqual(
    result.mod_portals.map(({ url }) => url),
    ["https://thunderstore.io/c/fixture-mods/", "https://gamebanana.com/games/456"],
  );
  assert.doesNotMatch(JSON.stringify(result), /private-(?:original|data)|"loader"/u);

  const content = responses.get(contentEndpoint) as Record<string, unknown>;
  responses.set(contentEndpoint, {
    ...content,
    content: Buffer.alloc(bytes.length).toString("base64"),
  });
  assert.deepEqual(await observeLauncherModPortals(repository, read), {
    state: "unavailable",
    reason: "project-scope-evidence-bytes-unverified",
  });

  calls.length = 0;
  responses.set(treeEndpoint, { sha: tree, truncated: false, tree: [] });
  const absence = await observeLauncherModPortals(repository, read);
  assert.deepEqual(absence, {
    state: "absent",
    repository_id: repository.id,
    commit,
    tree,
  });
  assert.deepEqual(calls.splice(0), [root, commitEndpoint, treeEndpoint]);
  assert(absence.state === "absent");

  const newCommit = "e".repeat(40);
  responses.set(commitEndpoint, [{ sha: newCommit, commit: { tree: { sha: tree } } }]);
  const withAbsence = { ...repository, priorAbsence: absence };
  assert.deepEqual(await observeLauncherModPortals(withAbsence, read), {
    ...absence,
    commit: newCommit,
  });
  assert.deepEqual(calls, [root, commitEndpoint]);

  const newTree = "f".repeat(40);
  const newTreeEndpoint = root + "/git/trees/" + newTree;
  const newContentEndpoint = root + "/contents/" + path + "?ref=" + newCommit;
  responses.set(commitEndpoint, [{ sha: newCommit, commit: { tree: { sha: newTree } } }]);
  responses.set(newTreeEndpoint, { sha: newTree, truncated: false, tree: [file] });
  responses.set(newContentEndpoint, content);
  calls.length = 0;
  assert.deepEqual(await observeLauncherModPortals(withAbsence, read), {
    ...result,
    commit: newCommit,
    tree: newTree,
  });
  assert.deepEqual(calls, [root, commitEndpoint, newTreeEndpoint, newContentEndpoint]);
  responses.set(commitEndpoint, [{ sha: commit, commit: { tree: { sha: tree } } }]);

  calls.length = 0;
  responses.set(treeEndpoint, {
    sha: tree,
    truncated: false,
    tree: [file, { ...file, path: ".recomp.json" }],
  });
  assert.deepEqual(await observeLauncherModPortals(repository, read), {
    state: "held",
    reason: "multiple-manifest-subjects",
  });
  assert.deepEqual(calls, [root, commitEndpoint, treeEndpoint]);

  calls.length = 0;
  responses.set(root, { id: repository.id + 1, full_name: repository.slug, private: false });
  assert.deepEqual(await observeLauncherModPortals(withAbsence, read), {
    state: "held",
    reason: "repository-binding-unresolved",
  });
  assert.deepEqual(calls, [root]);

  const legacy = {
    format: 1,
    repo: repository.slug,
    start: { program: ["port.exe"], args: ["private-original"] },
    game: { kind: "iso", label: "Original copy", check: { iso9660: "SCUS_944.26" } },
  };
  responses.set(root, { id: repository.id, full_name: repository.slug, private: false });
  function setManifest(value: unknown) {
    const body = Buffer.from(JSON.stringify(value));
    const sha = createHash("sha1")
      .update("blob " + body.length + "\0")
      .update(body)
      .digest("hex");
    responses.set(treeEndpoint, {
      sha: tree,
      truncated: false,
      tree: [{ ...file, sha }],
    });
    responses.set(contentEndpoint, {
      type: "file",
      path,
      sha,
      size: body.length,
      encoding: "base64",
      content: body.toString("base64"),
    });
  }
  setManifest(legacy);
  assert.deepEqual(await observeLauncherModPortals(repository, read), {
    state: "absent",
    repository_id: repository.id,
    commit,
    tree,
  });
  setManifest({ ...legacy, mods: { gamebanana: 456, loader: "nrm", data: "private-data" } });
  const legacyObservation = await observeLauncherModPortals(repository, read);
  assert(legacyObservation.state === "observed");
  assert.deepEqual(legacyObservation.game_input_ids, ["SCUS-94426"]);
  assert.deepEqual(
    legacyObservation.mod_portals.map(({ url }) => url),
    ["https://gamebanana.com/games/456"],
  );
  assert.doesNotMatch(JSON.stringify(legacyObservation), /private-(?:original|data)|"loader"/u);
  const { verifyLauncherModGameScope } = await import("./launcher-mod-game-scope.mts");
  assert.equal(
    verifyLauncherModGameScope(legacyObservation, {
      system: "playstation",
      codes: new Set(["SCUS-94426"]),
    }).state,
    "observed",
  );
  assert.equal(
    verifyLauncherModGameScope(legacyObservation, {
      system: "playstation",
      codes: new Set(["SCUS-94427"]),
    }).state,
    "held",
  );
  const { recordLauncherModAttempt } = await import("./upstream-launcher-mod-progress.mts");
  const at = Date.parse("2026-11-27T00:00:00Z");
  const bound = "a".repeat(64);
  const gameScope = { system: "playstation", codes: new Set(["SCUS-94426"]) } as const;
  const known = recordLauncherModAttempt(bound, undefined, legacyObservation, at, 60_000);
  for (const mods of [{ gamebanana: "456" }, { gamebanana: "456", thunderstore: "valid-slug" }]) {
    setManifest({ ...legacy, mods });
    const malformed = await observeLauncherModPortals(repository, read);
    assert.deepEqual(malformed, {
      state: "unavailable",
      reason: "legacy-mod-declaration-unresolved",
      game_input_ids: ["SCUS-94426"],
    });
    const unresolved = verifyLauncherModGameScope(malformed, gameScope);
    const retry = recordLauncherModAttempt(bound, known, unresolved, at + 60_000, 60_000);
    assert.deepEqual(retry.last_complete, known.last_complete);
    assert.equal(retry.last_complete?.observed_at, new Date(at).toISOString());
    assert.equal(retry.next_due_at, new Date(at + 120_000).toISOString());
  }
  setManifest({
    ...legacy,
    game: { ...legacy.game, check: { iso9660: "SLUS_206.51" } },
    mods: { gamebanana: "456" },
  });
  const conflict = verifyLauncherModGameScope(
    await observeLauncherModPortals(repository, read),
    gameScope,
  );
  assert.deepEqual(conflict, { state: "held", reason: "game-input-scope-conflict" });
  assert.equal(
    recordLauncherModAttempt(bound, known, conflict, at + 60_000, 60_000).last_complete,
    undefined,
  );

  const withLegacyGame = (game: unknown) => ({
    ...legacy,
    game,
    mods: { gamebanana: 456 },
  });
  const check = { ...legacy.game.check, ids: ["SCUS-94426"] };
  setManifest(withLegacyGame({ ...legacy.game, check }));
  const consistent = await observeLauncherModPortals(repository, read);
  assert(consistent.state === "observed");
  assert.deepEqual(consistent.game_input_ids, ["SCUS-94426"]);
  setManifest(withLegacyGame({ ...legacy.game, check: { ...check, ids: ["SLUS-20651"] } }));
  assert.equal((await observeLauncherModPortals(repository, read)).state, "held");

  setManifest({
    ...withLegacyGame(legacy.game),
    inputs: [{ id: "game", label: "Game", formats: [{ type: "file" }], check }],
  });
  assert.equal((await observeLauncherModPortals(repository, read)).state, "held");

  for (const kind of ["folder", "iso_or_folder"]) {
    setManifest(withLegacyGame({ ...legacy.game, kind }));
    const unscoped = await observeLauncherModPortals(repository, read);
    assert.deepEqual(unscoped, { state: "held", reason: "legacy-folder-scope-unproven" });
    assert.equal(
      recordLauncherModAttempt(bound, known, unscoped, at + 60_000, 60_000).last_complete,
      undefined,
    );

    setManifest(withLegacyGame({ ...legacy.game, kind, check }));
    const scoped = await observeLauncherModPortals(repository, read);
    assert(scoped.state === "observed");
    assert.deepEqual(scoped.game_input_ids, ["SCUS-94426"]);
    assert.equal(verifyLauncherModGameScope(scoped, gameScope).state, "observed");
  }

  const outage = await observeLauncherModPortals(repository, async (endpoint) =>
    endpoint === root
      ? {
          status: "observed",
          body: { id: repository.id, full_name: repository.slug, private: false },
        }
      : { status: "unavailable", reason: "provider-backoff", retry_after: "2026-11-27T06:00:00Z" },
  );
  assert.deepEqual(outage, {
    state: "unavailable",
    reason: "provider-backoff",
    retry_after: "2026-11-27T06:00:00Z",
  });
});
