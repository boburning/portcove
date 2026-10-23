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
import { collectPortFacts, githubRepository } from "./port-upstream-facts.mts";
import { preparePort, prepareArtworkBatch } from "./prepare-port.mts";
import { readCatalogSource } from "./catalog-authoring.mts";
import { createIgdbInspector } from "./inspect-igdb-artwork.mts";
import type { ListingReceipt } from "./catalog-authoring-inspector.mts";

const catalogRoot = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "crates",
  "portcove-core",
  "catalog",
);
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

void test("bounded artwork batch enriches listing-only records in the complete large catalog and resumes without lookup", async () => {
  const f = fixture();
  try {
    const accepted = readCatalogSource(catalogRoot);
    assert.ok(accepted.records.length > 400);
    const additions = accepted.records.filter((record) => !record.integration).slice(0, 2);
    assert.equal(additions.length, 2);
    const acceptedCover = accepted.records.find((record) => record.listing.artwork)!;
    assert.ok(acceptedCover);
    const selectedPortIds = [
      ...additions.map((record) => record.listing.id),
      acceptedCover.listing.id,
    ];
    const queries: string[] = [];
    const options = {
      catalogRoot,
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
    assert.deepEqual(readCatalogSource(catalogRoot), accepted);
  } finally {
    f.clean();
  }
});

void test("partial cover batch retains useful record proposals and retries only selected pending identities", async () => {
  const f = fixture();
  try {
    const source = copiedCatalog(join(f.root, "source"));
    const accepted = readCatalogSource(source);
    const entries = accepted.records.filter((record) => !record.integration).slice(0, 2);
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
