import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assembleCatalogRecords,
  parseCatalogSource,
  readCatalogSource,
  type AuthoredPort,
} from "./catalog-authoring.mts";
import {
  checkListingFactsTable,
  digestOf,
  emptyFactsTable,
  enrollmentDelta,
  enrollmentTable,
  FACTS_PARSER,
  FACTS_PARSER_VERSION,
  fitDecision,
  gateGeneration,
  generateRegistrations,
  machineRunsOn,
  type ArtifactFactV1,
  type ListingFactsEntry,
  type ListingFactsTable,
} from "./catalog-generated-registration.mts";
import { routeFitReport } from "./catalog-route-fit.mts";
import { artifactFact, deriveListingFacts, type ObservedAsset } from "./listing-package-facts.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalogRoot = join(root, "crates/portcove-core/catalog");
const shared = parseCatalogSource(readFileSync(join(catalogRoot, "catalog-shared.json"), "utf8"));
const sha = (seed: string) => digestOf(seed);

// An identity no non-test source names: it can only enroll from data.
const unseen = "zz-unseen-observed-runtime-fixture";
function listing(id = unseen, fields: Record<string, unknown> = {}): AuthoredPort {
  return {
    format_version: 1,
    listing: {
      id,
      name: "Unseen Observed Runtime",
      summary: "A native runtime observed only through release facts.",
      project_url: `https://github.com/fixture-owner/${id}`,
      availability: "packages",
      platforms: ["windows-x86-64"],
      ...fields,
    },
  };
}
function artifact(fields: Partial<ArtifactFactV1> = {}): ArtifactFactV1 {
  const archive = sha("archive");
  return {
    asset_id: 11,
    name: "Unseen-v1.0-windows-x64.zip",
    size: 4096,
    sha256: archive,
    role: "desktop-game-runtime",
    os: "windows",
    arch: "x86-64",
    source: {
      kind: "exact-release-structured",
      shape_version: 2,
      archive_sha256: archive,
    },
    players: [
      {
        path: "unseen/unseen.exe",
        machine: "pe-x86-64",
        sha256: sha("player"),
      },
    ],
    contradictory: false,
    ...fields,
  };
}
function entry(
  artifacts: ArtifactFactV1[] = [artifact()],
  fields: Partial<ListingFactsEntry["observation"]> = {},
  id = unseen,
): ListingFactsEntry {
  return {
    port_id: id,
    provider: "github",
    repository: `fixture-owner/${id}`,
    parser: FACTS_PARSER,
    parser_version: FACTS_PARSER_VERSION,
    observation: {
      release_id: 7,
      tag: "v1.0",
      published_at: "2026-11-01T00:00:00Z",
      provider_prerelease: false,
      observed_at: "2026-11-20T00:00:00Z",
      coverage: "complete",
      assets_complete: true,
      ...fields,
    },
    artifacts,
  };
}
function table(...entries: ListingFactsEntry[]): ListingFactsTable {
  const sorted = entries.toSorted((left, right) => (left.port_id < right.port_id ? -1 : 1));
  return {
    ...emptyFactsTable(),
    entries: sorted,
    entries_sha256: digestOf(sorted),
  };
}
type Guide = {
  steps: { title: string; instruction: string }[];
  warnings: string[];
  references: { title: string; instruction: string }[];
};
const decide = (record: AuthoredPort, facts?: ListingFactsEntry) => fitDecision(record, facts);

void test("the fixture identity appears nowhere in non-test sources", () => {
  for (const directory of ["scripts", "apps/desktop/src", "crates/portcove-core/src"]) {
    const walk = (path: string): string[] =>
      readdirSync(join(root, path), { withFileTypes: true }).flatMap((item) =>
        item.isDirectory()
          ? item.name === "node_modules" || item.name === "fixtures"
            ? []
            : walk(join(path, item.name))
          : /\.(?:mts|ts|tsx|rs)$/u.test(item.name) &&
              !/(?:\.test\.|tests?\.rs$|_tests\.rs$)/u.test(item.name)
            ? [join(path, item.name)]
            : [],
      );
    for (const file of walk(directory))
      assert.ok(!readFileSync(join(root, file), "utf8").includes(unseen), file);
  }
});

void test("an unseen identity enrolls from an observation fixture alone and validates like an authored route", () => {
  const { records } = readCatalogSource(catalogRoot);
  const assembled = assembleCatalogRecords(shared, [...records, listing()], table(entry()));
  const port = assembled.catalog.ports.find((candidate) => candidate.id === unseen);
  assert.ok(port, "generated route is an operational definition");
  assert.equal(port.adapter, "staged-source-portable");
  assert.deepEqual(port.platforms, ["windows-x86-64"]);
  const release = port.release as {
    provider: string;
    user_prepared: Record<string, { trust: string }>;
  };
  assert.equal(release.provider, "user-prepared");
  assert.equal(release.user_prepared["windows-x86-64"]!.trust, "user-selected");
  const generated = assembled.records.find((record) => record.listing.id === unseen)!;
  assert.equal(generated.external_registration_v1, true);
  // Exactly the hand-authored registration-only form.
  const authored = JSON.parse(
    readFileSync(join(catalogRoot, "ports/earthbound-recomp.json"), "utf8"),
  ) as AuthoredPort;
  const shape = (record: AuthoredPort) => {
    const integration = structuredClone(record.integration!) as {
      platforms?: unknown;
      release: { repository?: unknown };
      presentation: { manual_preparation?: unknown };
    };
    delete integration.platforms;
    delete integration.release.repository;
    delete integration.presentation.manual_preparation;
    return integration;
  };
  assert.deepEqual(shape(generated), shape(authored));
  const guide = generated.listing.manual_setup as Guide;
  assert.match(guide.steps[2]!.instruction, /Select unseen\.exe from your prepared copy/u);
  assert.match(guide.references[1]!.instruction, /without a title-specific review/u);
  assert.deepEqual(
    assembled.generation.enrollments.map((row) => row.port_id),
    [unseen],
  );

  const report = routeFitReport({
    records: assembled.records,
    ports: assembled.catalog.ports,
    packageShapes: { entries: [] },
    routeEnrollment: { cases: [] },
    generatedRegistration: enrollmentTable(assembled.generation),
  });
  const fitted = report.identities.find((identity) => identity.id === unseen)!;
  assert.equal(fitted.disposition, "enrolled");
  assert.equal(fitted.generated, true);
  assert.match(fitted.reason, /no title-specific authority/u);
  assert.equal(report.summary.generated_registrations, 1);
});

void test("impersonating artifacts named like a desktop zip never enroll", () => {
  const cases: [Partial<ArtifactFactV1>, string][] = [
    [{ role: "installer", players: [] }, "no-runtime-role"],
    [{ role: "builder" }, "no-runtime-role"],
    [{ role: "mobile-package", os: "android", arch: "aarch64" }, "no-runtime-role"],
    [{ source: { kind: "filename-suggestion", rule_version: 1 } }, "no-authorizing-source"],
    [{ source: { kind: "stable-declaration" } }, "no-authorizing-source"],
    [{ contradictory: true }, "contradictory-role"],
    [{ os: "web" }, "wrong-host"],
    [
      {
        players: [{ path: "game/game", machine: "elf64-arm64", sha256: sha("arm") }],
      },
      "no-player-for-host",
    ],
  ];
  for (const [fields, reason] of cases) {
    const decision = decide(listing(), entry([artifact(fields)]));
    assert.equal(decision.fit, false, JSON.stringify(fields));
    assert.equal(!decision.fit && decision.reason, reason, JSON.stringify(fields));
  }
  // The worker never types a player-free archive as a runtime.
  const asset: ObservedAsset = {
    id: 3,
    name: "Game-windows-x64.zip",
    url: "https://github.com/o/r/releases/download/v1/Game-windows-x64.zip",
    size: 10,
    sha256: sha("x"),
  };
  assert.equal(artifactFact(asset, []).role, "unknown");
});

void test("incomplete or unknown coverage is never eligible", () => {
  for (const [observation, reason] of [
    [{ coverage: "partial" }, "incomplete-coverage"],
    [{ coverage: "failed" }, "incomplete-coverage"],
    [{ coverage: "unavailable" }, "incomplete-coverage"],
    [{ assets_complete: false }, "incomplete-coverage"],
  ] as const) {
    const decision = decide(listing(), entry([artifact()], observation));
    assert.equal(!decision.fit && decision.reason, reason);
  }
  assert.equal((decide(listing()) as { reason: string }).reason, "no-observation");
  const stale = { ...entry(), parser_version: FACTS_PARSER_VERSION + 1 };
  assert.equal((decide(listing(), stale) as { reason: string }).reason, "stale-parser");
  const moved = { ...entry(), repository: "someone-else/fork" };
  assert.equal((decide(listing(), moved) as { reason: string }).reason, "repository-mismatch");
});

void test("structural and upstream exclusions apply by data, not title", () => {
  const scummvm = listing(unseen, {
    implementation: {
      format_version: 1,
      methods: [
        {
          kind: "engine-reimplementation",
          evidence_urls: ["https://github.com/scummvm/scummvm"],
        },
      ],
      dependencies: [
        {
          kind: "runtime",
          project_url: "https://github.com/scummvm/scummvm",
          name: "Engine",
          confidence: "confirmed",
          evidence_urls: [],
        },
      ],
    },
  });
  assert.equal((decide(scummvm, entry()) as { reason: string }).reason, "scummvm-engine");
  assert.equal(
    (
      decide(listing(unseen, { availability: "source-only" }), entry()) as {
        reason: string;
      }
    ).reason,
    "upstream-unavailable",
  );
  assert.equal(
    (
      decide(listing(unseen, { project_url: "https://example.org/game" }), entry()) as {
        reason: string;
      }
    ).reason,
    "no-readable-upstream",
  );
  const prepared = {
    ...listing(),
    route_facts_v1: {
      format_version: 1 as const,
      prepared_player: {
        executable: "game.exe",
        working_directory: "executable-parent" as const,
        arguments: [],
        data_locations: ["saves"],
      },
    },
  };
  assert.equal((decide(prepared, entry()) as { reason: string }).reason, "operational-route");
  const operational = {
    ...listing(),
    integration: { adapter: "native-portable" },
  };
  assert.equal((decide(operational, entry()) as { reason: string }).reason, "operational-route");
});

void test("a download hold does not block registration; a registration or launch hold does", () => {
  const hold = (operations: string[]) =>
    listing(unseen, {
      restrictions: [{ id: "held", effect: "hold", operations, reason: "bundled-game-data" }],
    });
  assert.equal(decide(hold(["download"]), entry()).fit, true);
  for (const operation of ["register-external", "launch"])
    assert.equal((decide(hold([operation]), entry()) as { reason: string }).reason, "route-held");
});

void test("platforms come from the artifact's host and its players' machines", () => {
  const linux = artifact({
    asset_id: 12,
    name: "Unseen-linux.tar.gz",
    os: "linux",
    players: [{ path: "unseen", machine: "elf64-x86-64", sha256: sha("linux") }],
  });
  const universal = artifact({
    asset_id: 13,
    name: "Unseen-mac.zip",
    os: "macos",
    arch: "universal",
    players: [
      {
        path: "unseen.app/contents/macos/unseen",
        machine: "macho-universal-x86-64+arm64",
        sha256: sha("mac"),
      },
    ],
  });
  const decision = decide(listing(), entry([artifact(), linux, universal]));
  assert.ok(decision.fit);
  assert.deepEqual(decision.enrollment.platforms, [
    "windows-x86-64",
    "linux-x86-64",
    "macos-x86-64",
    "macos-aarch64",
  ]);
  assert.ok(machineRunsOn("macho-arm64", "macos-aarch64"));
  assert.ok(!machineRunsOn("pe-x86", "windows-x86-64"));
  assert.ok(!machineRunsOn("elf32-x86-64", "linux-x86-64"));
});

void test("a route withdraws deterministically when a fact stops holding", () => {
  const before = generateRegistrations([listing()], table(entry()));
  const committed = enrollmentTable(before);
  for (const [facts, reason] of [
    [table(entry([])), /no-runtime-role/u],
    [table(entry([artifact({ contradictory: true })])), /contradictory-role/u],
    [table(entry([artifact()], { coverage: "partial" })), /incomplete-coverage/u],
    [table(), /no-observation/u],
  ] as const) {
    const after = generateRegistrations([listing()], facts);
    assert.deepEqual(after.enrollments, []);
    const delta = enrollmentDelta(committed, after);
    assert.equal(delta.withdrawn.length, 1);
    assert.match(delta.withdrawn[0]!.reason, reason);
    // The listing itself stays; only the generated route leaves.
    assert.equal(after.records[0]!.integration, undefined);
  }
  const moved = generateRegistrations(
    [listing()],
    table(entry([artifact()], { tag: "v1.1", release_id: 8 })),
  );
  assert.match(enrollmentDelta(committed, moved).changed[0]!.reason, /release v1\.0 -> v1\.1/u);
});

void test("the gate refuses a run beyond its bounds or resting on a non-authorizing fact", () => {
  const ids = ["zz-gate-a", "zz-gate-b", "zz-gate-c"];
  const generation = generateRegistrations(
    ids.map((id) => listing(id)),
    table(...ids.map((id) => entry([artifact()], {}, id))),
  );
  assert.equal(gateGeneration(undefined, generation).added.length, 3);
  assert.throws(
    () =>
      gateGeneration(undefined, generation, {
        added: 2,
        withdrawn: 0,
        changed: 0,
      }),
    /3 added routes exceed the bound of 2/u,
  );
  assert.throws(
    () =>
      gateGeneration(enrollmentTable(generation), generateRegistrations([], table()), {
        added: 0,
        withdrawn: 2,
        changed: 0,
      }),
    /3 withdrawn routes exceed/u,
  );
  const tampered = structuredClone(generation);
  tampered.enrollments[0]!.runtimes[0]!.source = "filename-suggestion";
  assert.throws(() => gateGeneration(undefined, tampered), /non-authorizing filename-suggestion/u);
});

void test("generation is deterministic and the facts table is strict", () => {
  const facts = table(entry());
  assert.deepEqual(
    generateRegistrations([listing()], facts),
    generateRegistrations([listing()], structuredClone(facts)),
  );
  assert.throws(
    () => checkListingFactsTable({ ...facts, entries_sha256: sha("other") }),
    /digest/u,
  );
  const unknownField = table({
    ...entry(),
    extra: true,
  } as unknown as ListingFactsEntry);
  assert.throws(() => checkListingFactsTable(unknownField), /unknown field extra/u);
  assert.throws(
    () => generateRegistrations([], table(entry())),
    /name zz-unseen-observed-runtime-fixture, which is not listed/u,
  );
  const unbound = table(
    entry([
      artifact({
        source: {
          kind: "exact-release-structured",
          shape_version: 2,
          archive_sha256: sha("else"),
        },
      }),
    ]),
  );
  assert.throws(() => checkListingFactsTable(unbound), /bind these exact archive bytes/u);
});

void test("the committed tables are well formed and generation equals the committed output", () => {
  checkListingFactsTable(
    parseCatalogSource(
      readFileSync(join(catalogRoot, "listing-package-facts.generated.json"), "utf8"),
    ),
  );
  const { generation } = readCatalogSource(catalogRoot);
  assert.equal(
    readFileSync(join(catalogRoot, "generated-registration.generated.json"), "utf8"),
    `${JSON.stringify(enrollmentTable(generation), null, 2)}\n`,
  );
});

// ---------------------------------------------------------------------------
// The facts worker, with fixture observations and no network.

function observerReport(ids: string[], fields: Record<string, unknown> = {}) {
  return {
    listings: ids.map((id) => ({
      listing_update: {
        id,
        upstream_observation: {
          provider: "github",
          repository: `fixture-owner/${id}`,
          status: "complete",
          observed_at: "2026-11-20T00:00:00Z",
          releases: [
            {
              id: 9,
              version: "v2.0-rc",
              published_at: "2026-11-10T00:00:00Z",
              provider_prerelease: true,
              assets_complete: true,
              assets: [],
            },
            {
              id: 8,
              version: "v1.0",
              published_at: "2026-11-01T00:00:00Z",
              provider_prerelease: false,
              assets_complete: true,
              assets: [
                {
                  id: 21,
                  name: `${id}-windows-x64.zip`,
                  url: `https://github.com/fixture-owner/${id}/releases/download/v1.0/a.zip`,
                  size: 100,
                  sha256: sha(`${id}-zip`),
                },
                {
                  id: 22,
                  name: "README.md",
                  url: `https://github.com/fixture-owner/${id}/releases/download/v1.0/README.md`,
                  size: 5,
                  sha256: null,
                },
              ],
            },
          ],
          ...fields,
        },
      },
    })),
  };
}

void test("the worker derives authorizing facts from bytes, bounded and resumable, and the route follows", async () => {
  const ids = ["zz-worker-a", "zz-worker-b", "zz-worker-c"];
  const records = ids.map((id) => listing(id));
  const inspected: string[] = [];
  const inspect = async (asset: ObservedAsset) => {
    inspected.push(asset.name);
    if (asset.name.startsWith("zz-worker-b")) throw new Error("download failed");
    return [{ path: "game/game.exe", machine: "pe-x86-64", sha256: sha(asset.name) }];
  };
  const first = await deriveListingFacts({
    records,
    observerReport: observerReport(ids),
    table: emptyFactsTable(),
    budget: { maxIdentities: 2 },
    inspect,
    now: "2026-11-21T00:00:00Z",
  });
  // Only the stable release's archive is read; b failed, so the cursor stays at a.
  assert.deepEqual(inspected, ["zz-worker-a-windows-x64.zip", "zz-worker-b-windows-x64.zip"]);
  assert.deepEqual(first.cursor, { format: 1, after: "zz-worker-a" });
  assert.deepEqual(
    first.report.map(({ port_id, coverage }) => [port_id, coverage]),
    [
      ["zz-worker-a", "complete"],
      ["zz-worker-b", "failed"],
    ],
  );
  const a = first.table.entries.find((row) => row.port_id === "zz-worker-a")!;
  assert.equal(a.observation.tag, "v1.0");
  assert.deepEqual(a.artifacts[0]!.source, {
    kind: "exact-release-structured",
    shape_version: 2,
    archive_sha256: sha("zz-worker-a-zip"),
  });
  // The generated route follows the facts: a enrolls, b is UNKNOWN.
  const generation = generateRegistrations(records, first.table);
  assert.deepEqual(
    generation.enrollments.map((row) => row.port_id),
    ["zz-worker-a"],
  );

  // Resume: b is retried first, a's unchanged archive is never read again.
  inspected.length = 0;
  const second = await deriveListingFacts({
    records,
    observerReport: observerReport(ids),
    table: first.table,
    cursor: first.cursor,
    inspect: async (asset) => {
      inspected.push(asset.name);
      return [
        {
          path: "game/game.exe",
          machine: "pe-x86-64",
          sha256: sha(asset.name),
        },
      ];
    },
    now: "2026-11-22T00:00:00Z",
  });
  assert.deepEqual(inspected, ["zz-worker-b-windows-x64.zip", "zz-worker-c-windows-x64.zip"]);
  assert.deepEqual(second.cursor, { format: 1, after: null });
  const third = await deriveListingFacts({
    records,
    observerReport: observerReport(ids),
    table: second.table,
    inspect: async () => assert.fail("unchanged archives are reused"),
    now: "2026-11-23T00:00:00Z",
  });
  assert.deepEqual(
    third.report.map(({ reused }) => reused),
    [1, 1, 1],
  );
  assert.equal(third.bytes, 0);
});

void test("the worker records an incomplete observation as UNKNOWN and respects the byte budget", async () => {
  const records = [listing("zz-worker-a")];
  const incomplete = await deriveListingFacts({
    records,
    observerReport: observerReport(["zz-worker-a"], { status: "incomplete" }),
    table: emptyFactsTable(),
    inspect: async () => [{ path: "g.exe", machine: "pe-x86-64", sha256: sha("g") }],
    now: "2026-11-21T00:00:00Z",
  });
  assert.equal(incomplete.table.entries[0]!.observation.coverage, "partial");
  assert.equal(generateRegistrations(records, incomplete.table).enrollments.length, 0);
  assert.deepEqual(incomplete.cursor, { format: 1, after: null });

  const starved = await deriveListingFacts({
    records,
    observerReport: observerReport(["zz-worker-a"]),
    table: emptyFactsTable(),
    budget: { maxBytes: 50 },
    inspect: async () => assert.fail("over-budget bytes are not read"),
    now: "2026-11-21T00:00:00Z",
  });
  assert.equal(starved.table.entries.length, 0);
  assert.deepEqual(starved.cursor, { format: 1, after: null });
});

void test("an authored listing guide stays first and gains the generated selection step", () => {
  const authored = listing(unseen, {
    manual_setup: {
      steps: [
        {
          title: "Import your files",
          instruction: "Use the upstream importer first.",
        },
      ],
      warnings: ["Title-specific warning."],
    },
  });
  const generation = generateRegistrations([authored], table(entry()));
  const guide = generation.records[0]!.listing.manual_setup as Guide;
  assert.deepEqual(
    guide.steps.map((step) => step.title),
    ["Import your files", "Select the game program", "Review the registration, then choose Play"],
  );
  assert.equal(guide.warnings[0], "Title-specific warning.");
  assert.equal(guide.references.length, 2);
  const crowded = listing(unseen, {
    manual_setup: {
      steps: Array.from({ length: 7 }, (_, index) => ({
        title: `Step ${index}`,
        instruction: "Do it.",
      })),
      warnings: [],
    },
  });
  assert.equal((decide(crowded, entry()) as { reason: string }).reason, "guide-bound");
});
