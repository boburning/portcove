import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  boundFactsBatch,
  checkListingFactsTable,
  deltaBounds,
  digestOf,
  displayableName,
  emptyFactsTable,
  enrollmentDelta,
  enrollmentTable,
  enrollmentTablePath,
  FACTS_PARSER,
  FACTS_PARSER_VERSION,
  fitDecision,
  gateGeneration,
  generateRegistrations,
  genericSelection,
  machineRunsOn,
  readGateBaseline,
  type ArtifactFactV2,
  type ListingFactsEntry,
  type ListingFactsTable,
  type NameSuggestion,
  type PlayerFact,
} from "./catalog-generated-registration.mts";
import { routeFitReport } from "./catalog-route-fit.mts";
import {
  artifactFact,
  deriveListingFacts,
  InspectionError,
  runCore,
  type ByteInspector,
  type DeriveResult,
  type NameClassifier,
  type ObservedAsset,
  type WorkerState,
} from "./listing-package-facts.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalogRoot = join(root, "crates/portcove-core/catalog");
const shared = parseCatalogSource(readFileSync(join(catalogRoot, "catalog-shared.json"), "utf8"));
const sha = (seed: string) => digestOf(seed);

// ---------------------------------------------------------------------------
// Core's own classification output, pinned by a portcove-core test
// (`name_classification_matches_the_worker_fixture`), replayed here.

const classification = JSON.parse(
  readFileSync(join(root, "scripts/fixtures/listing-name-classification.json"), "utf8"),
) as {
  output: {
    filename_rule_version: number;
    releases: { tag: string; provider_prerelease: boolean; prerelease: boolean }[];
    assets: { name: string; role: NameSuggestion["role"]; os: string; arch: string }[];
  };
};
/** Replays Core's recorded answers; a name Core was not asked about fails the test. */
const coreClassifier: NameClassifier = async (input) => ({
  filename_rule_version: classification.output.filename_rule_version,
  releases: input.releases.map((release) => {
    const known = classification.output.releases.find(
      (candidate) =>
        candidate.tag === release.tag &&
        candidate.provider_prerelease === release.provider_prerelease,
    );
    assert.ok(known, `Core fixture has no verdict for tag ${release.tag}`);
    return known;
  }),
  assets: input.assets.map((name) => {
    const known = classification.output.assets.find((candidate) => candidate.name === name);
    assert.ok(known, `Core fixture has no classification for ${name}`);
    return known;
  }),
});
function suggestion(name: string): NameSuggestion {
  const known = classification.output.assets.find((candidate) => candidate.name === name);
  assert.ok(known, name);
  return {
    rule_version: classification.output.filename_rule_version,
    role: known.role,
    os: known.os,
    arch: known.arch,
  };
}

const windowsZip = "Game-v1.0-windows-x64.zip";
const linuxTar = "Game-v1.0-linux-x86_64.tar.gz";
const macZip = "Game-v1.0-macos-universal.zip";
const generatedAt = "2026-11-20T00:00:00.000Z";

const player = (path: string, machine = "pe-x86-64", seed = path): PlayerFact => ({
  path: path.toLowerCase(),
  display_path: path,
  machine,
  sha256: sha(`${seed}/${machine}`),
});

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
/** A real worker artifact fact for an archive with these players. */
function artifact(
  name = windowsZip,
  players: PlayerFact[] = [player("Unseen/Unseen.exe")],
  id = 11,
): ArtifactFactV2 {
  return artifactFact(
    {
      id,
      name,
      url: `https://github.com/fixture-owner/x/releases/download/v1/${id}.zip`,
      size: 4096,
      sha256: sha(`archive-${id}-${name}`),
    },
    players,
    suggestion(name),
  );
}
function entry(
  artifacts: ArtifactFactV2[] = [artifact()],
  fields: Partial<ListingFactsEntry["observation"]> = {},
  id = unseen,
  extra: Partial<ListingFactsEntry> = {},
): ListingFactsEntry {
  return {
    port_id: id,
    provider: "github",
    repository: `fixture-owner/${id}`,
    repository_id: 4242,
    parser: FACTS_PARSER,
    parser_version: FACTS_PARSER_VERSION,
    observation: {
      release_id: 7,
      tag: "v1.0",
      published_at: "2026-11-01T00:00:00Z",
      observed_at: "2026-11-19T00:00:00Z",
      coverage: "complete",
      assets_complete: true,
      assets_sha256: sha("assets"),
      ...fields,
    },
    ineligible: null,
    attempt: null,
    artifacts,
    ...extra,
  };
}
function table(...entries: ListingFactsEntry[]): ListingFactsTable {
  const sorted = entries.toSorted((left, right) => (left.port_id < right.port_id ? -1 : 1));
  return {
    ...emptyFactsTable(generatedAt),
    entries: sorted,
    entries_sha256: digestOf(sorted),
  };
}
type Guide = {
  steps: { title: string; instruction: string }[];
  warnings: string[];
  references: { title: string; instruction: string }[];
};
const decide = (record: AuthoredPort, facts?: ListingFactsEntry, at = generatedAt) =>
  fitDecision(record, facts, at);
const reasonOf = (decision: ReturnType<typeof decide>) => (decision.fit ? "fit" : decision.reason);

// ---------------------------------------------------------------------------
// Worker fixtures: observer reports, a byte inspector and repeated runs.

interface AssetSpec {
  id: number;
  name: string;
  size?: number;
  sha256?: string | null | undefined;
}
interface ReleaseSpec {
  id: number;
  tag: string;
  published_at?: string;
  provider_prerelease?: boolean;
  assets_complete?: boolean;
  assets: AssetSpec[];
}
interface ObservationSpec {
  status?: string;
  repository?: string;
  repository_id?: number | null;
  observed_at?: string;
  releases?: ReleaseSpec[];
}
const defaultRelease = (id: string): ReleaseSpec => ({
  id: 8,
  tag: "v1.0",
  published_at: "2026-11-01T00:00:00Z",
  assets: [
    { id: 21, name: windowsZip },
    { id: 22, name: "README.md", sha256: null },
  ].map((asset) => ({ ...asset, sha256: asset.sha256 === null ? null : sha(`${id}-${asset.id}`) })),
});
function observerReport(specs: Record<string, ObservationSpec>) {
  return {
    listings: Object.entries(specs).map(([id, spec]) => ({
      listing_update: {
        id,
        upstream_observation: {
          provider: "github",
          repository: spec.repository ?? `fixture-owner/${id}`,
          repository_id: spec.repository_id === undefined ? 4242 : spec.repository_id,
          status: spec.status ?? "complete",
          observed_at: spec.observed_at ?? "2026-11-20T00:00:00Z",
          releases: (spec.releases ?? [defaultRelease(id)]).map((release) => ({
            id: release.id,
            version: release.tag,
            published_at: release.published_at ?? "2026-11-01T00:00:00Z",
            provider_prerelease: release.provider_prerelease ?? false,
            assets_complete: release.assets_complete ?? true,
            assets: release.assets.map((asset) => ({
              id: asset.id,
              name: asset.name,
              url: `https://github.com/fixture-owner/${id}/releases/download/${release.tag}/${asset.id}`,
              size: asset.size ?? 100,
              sha256: asset.sha256 === undefined ? sha(`${id}-${asset.id}`) : asset.sha256,
            })),
          })),
        },
      },
    })),
  };
}
/** Players per asset name; an Error value throws it. */
function inspector(
  contents: Record<string, PlayerFact[] | Error> = {},
  log: string[] = [],
): ByteInspector {
  return async (asset: ObservedAsset) => {
    log.push(asset.name);
    const found = contents[asset.name] ?? [player("Game/Game.exe")];
    if (found instanceof Error) throw found;
    return found;
  };
}
async function derive(
  records: AuthoredPort[],
  report: unknown,
  previous: ListingFactsTable = emptyFactsTable(),
  options: {
    state?: WorkerState | undefined;
    inspect?: ByteInspector;
    now?: string;
    budget?: Record<string, number>;
  } = {},
): Promise<DeriveResult> {
  return await deriveListingFacts({
    records,
    observerReport: report,
    table: previous,
    ...(options.state ? { state: options.state } : {}),
    ...(options.budget ? { budget: options.budget } : {}),
    inspect: options.inspect ?? inspector(),
    classify: coreClassifier,
    now: options.now ?? "2026-11-21T00:00:00.000Z",
  });
}
const enrolledIds = (records: AuthoredPort[], facts: ListingFactsTable) =>
  generateRegistrations(records, facts).enrollments.map((row) => row.port_id);
const outcome = (result: DeriveResult, id: string) =>
  result.report.find((row) => row.port_id === id);

// ---------------------------------------------------------------------------
// The route and its shape.

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

void test("an unseen identity enrolls from worker facts alone and validates like an authored route", async () => {
  const { records } = readCatalogSource(catalogRoot);
  const derived = await derive([listing()], observerReport({ [unseen]: {} }), undefined, {
    inspect: inspector({ [windowsZip]: [player("Unseen/Unseen.exe")] }),
  });
  const assembled = assembleCatalogRecords(shared, [...records, listing()], derived.table);
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
  // The original-case name is shown, not Core's lowercase comparison key.
  assert.match(guide.steps[2]!.instruction, /^Select Unseen\.exe in your prepared copy\./u);
  assert.match(guide.references[1]!.instruction, /without a title-specific review/u);
  assert.doesNotMatch(guide.references[1]!.instruction, /SHA-256|[a-f0-9]{64}/u);
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

// ---------------------------------------------------------------------------
// F2: the asset name vetoes, never authorizes.

void test("an archive whose own name says another role, system or architecture is contradictory and never enrolls", async () => {
  const exe = [player("MyGame/mygame.exe")];
  const vetoed: [string, string][] = [
    ["MyGame-dedicated-server-win64.zip", "dedicated-server"],
    ["Game-installer-windows-x64.zip", "installer"],
    ["Game-builder-windows-x64.zip", "builder"],
    ["Game-compiler-windows-x64.zip", "compiler"],
    ["Game-tools-windows-x64.zip", "dev-tool"],
    ["Game-importer-windows-x64.zip", "importer"],
    ["Game-android-arm64.zip", "mobile-package"],
    ["Game-switch.zip", "console-output"],
    ["Game-notices.zip", "documentation"],
    ["Game-symbols-windows-x64.zip", "debug-symbols"],
    ["Game-source.zip", "source-archive"],
    // Another operating system or architecture than the header machine.
    [linuxTar, "linux"],
    [macZip, "macos"],
    ["Game-win32.zip", "x86"],
    ["Game-windows-arm64.zip", "aarch64"],
  ];
  for (const [index, [name, why]] of vetoed.entries()) {
    const id = `zz-veto-${index}`;
    const result = await derive(
      [listing(id)],
      observerReport({ [id]: { releases: [{ id: 8, tag: "v1.0", assets: [{ id: 21, name }] }] } }),
      undefined,
      { inspect: inspector({ [name]: exe }) },
    );
    const fact = result.table.entries[0]!.artifacts[0]!;
    assert.equal(fact.contradictory, true, `${name} (${why})`);
    assert.equal(fact.role, "desktop-game-runtime", "the structural claim is kept for evidence");
    const decision = decide(listing(id), result.table.entries[0]);
    assert.equal(reasonOf(decision), "contradictory-role", name);
  }
  // A plain desktop name with a matching player is not vetoed.
  const plain = artifact("Game-v1.0.zip", exe);
  assert.equal(plain.contradictory, false);
  assert.equal(decide(listing(), entry([plain])).fit, true);
  // A universal macOS player agrees with an arch-specific macOS name.
  const arm = artifact("Game-v1.0-macos-arm64.zip", [
    player("Game.app/Contents/MacOS/Game", "macho-universal-x86-64+arm64"),
  ]);
  assert.equal(arm.contradictory, false);
  // The name never authorizes: a player-free archive stays unknown.
  assert.equal(artifact(windowsZip, []).role, "unknown");
});

void test("a release whose only native archives are all vetoed does not enroll; one clean archive does", async () => {
  const id = "zz-veto-release";
  const exe = [player("MyGame/mygame.exe")];
  const only = await derive(
    [listing(id)],
    observerReport({
      [id]: {
        releases: [
          {
            id: 8,
            tag: "v1.0",
            assets: [
              { id: 21, name: "MyGame-dedicated-server-win64.zip" },
              { id: 22, name: "Game-tools-windows-x64.zip" },
            ],
          },
        ],
      },
    }),
    undefined,
    {
      inspect: inspector({
        "MyGame-dedicated-server-win64.zip": exe,
        "Game-tools-windows-x64.zip": exe,
      }),
    },
  );
  assert.deepEqual(enrolledIds([listing(id)], only.table), []);
  const mixed = await derive(
    [listing(id)],
    observerReport({
      [id]: {
        releases: [
          {
            id: 8,
            tag: "v1.0",
            assets: [
              { id: 21, name: "MyGame-dedicated-server-win64.zip" },
              { id: 22, name: windowsZip },
            ],
          },
        ],
      },
    }),
    undefined,
    { inspect: inspector({ "MyGame-dedicated-server-win64.zip": exe, [windowsZip]: exe }) },
  );
  const generation = generateRegistrations([listing(id)], mixed.table);
  assert.equal(generation.enrollments[0]!.runtimes[0]!.asset_name, windowsZip);
});

void test("structural and coverage rules still apply to worker facts", () => {
  const cases: [ArtifactFactV2, string][] = [
    [artifact(windowsZip, []), "no-runtime-role"],
    // A 32-bit player in a 64-bit-named archive: the name vetoes it.
    [artifact(windowsZip, [player("game/game.exe", "pe-x86")]), "contradictory-role"],
    // A 32-bit player in an unlabelled archive: no supported platform runs it.
    [artifact("Game-v1.0.zip", [player("game/game.exe", "pe-x86")]), "wrong-host"],
  ];
  for (const [fact, reason] of cases)
    assert.equal(reasonOf(decide(listing(), entry([fact]))), reason, fact.name);
  const arm = artifact(windowsZip, [player("game/game.exe", "pe-arm64")]);
  assert.equal(arm.contradictory, true);
  for (const [observation, reason] of [
    [{ coverage: "partial" }, "incomplete-coverage"],
    [{ coverage: "failed" }, "incomplete-coverage"],
    [{ coverage: "unavailable" }, "incomplete-coverage"],
    [{ assets_complete: false }, "incomplete-coverage"],
  ] as const)
    assert.equal(reasonOf(decide(listing(), entry([artifact()], observation))), reason);
  assert.equal(reasonOf(decide(listing())), "no-observation");
  assert.equal(
    reasonOf(decide(listing(), { ...entry(), parser_version: FACTS_PARSER_VERSION + 1 })),
    "stale-parser",
  );
  assert.equal(
    reasonOf(decide(listing(), { ...entry(), repository: "someone-else/fork" })),
    "repository-mismatch",
  );
});

void test("platforms come from the artifact's host and its players' machines", () => {
  const linux = artifact(linuxTar, [player("Unseen", "elf64-x86-64")], 12);
  const universal = artifact(
    macZip,
    [player("Unseen.app/Contents/MacOS/Unseen", "macho-universal-x86-64+arm64")],
    13,
  );
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

void test("structural and upstream exclusions apply by data, not title", () => {
  const scummvm = listing(unseen, {
    implementation: {
      format_version: 1,
      methods: [
        { kind: "engine-reimplementation", evidence_urls: ["https://github.com/scummvm/scummvm"] },
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
  assert.equal(reasonOf(decide(scummvm, entry())), "scummvm-engine");
  assert.equal(
    reasonOf(decide(listing(unseen, { availability: "source-only" }), entry())),
    "upstream-unavailable",
  );
  assert.equal(
    reasonOf(decide(listing(unseen, { project_url: "https://example.org/game" }), entry())),
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
  assert.equal(reasonOf(decide(prepared, entry())), "operational-route");
  assert.equal(
    reasonOf(decide({ ...listing(), integration: { adapter: "native-portable" } }, entry())),
    "operational-route",
  );
});

void test("a download hold does not block registration; a registration or launch hold does", () => {
  const hold = (operations: string[]) =>
    listing(unseen, {
      restrictions: [{ id: "held", effect: "hold", operations, reason: "bundled-game-data" }],
    });
  assert.equal(decide(hold(["download"]), entry()).fit, true);
  for (const operation of ["register-external", "launch"])
    assert.equal(reasonOf(decide(hold([operation]), entry())), "route-held");
});

// ---------------------------------------------------------------------------
// F4: forged and stale facts.

void test("forged facts are refused: only exact digest-bound structural facts are accepted", () => {
  const forge = (mutate: (fact: Record<string, unknown>) => void) => {
    const fact = structuredClone(artifact()) as unknown as Record<string, unknown>;
    mutate(fact);
    return table(entry([fact as unknown as ArtifactFactV2]));
  };
  const forgeries: [string, (fact: Record<string, unknown>) => void][] = [
    ["release-metadata", (fact) => (fact.source = { kind: "release-metadata", document: "x" })],
    [
      "provider-cross-reference",
      (fact) => (fact.source = { kind: "provider-cross-reference", provider: "p", reference: "r" }),
    ],
    [
      "family-extractor",
      (fact) => (fact.source = { kind: "family-extractor", extractor: "e", version: 1 }),
    ],
    [
      "filename-suggestion",
      (fact) => (fact.source = { kind: "filename-suggestion", rule_version: 1 }),
    ],
    [
      "null archive digest",
      (fact) => {
        fact.sha256 = null;
        (fact.source as Record<string, unknown>).archive_sha256 = null;
      },
    ],
    [
      "unbound archive digest",
      (fact) => ((fact.source as Record<string, unknown>).archive_sha256 = sha("other")),
    ],
    ["extra source field", (fact) => ((fact.source as Record<string, unknown>).trusted = true)],
    [
      "missing player digest",
      (fact) => ((fact.players as Record<string, unknown>[])[0]!.sha256 = null),
    ],
    ["missing name classification", (fact) => delete fact.name_suggestion],
  ];
  for (const [label, mutate] of forgeries)
    assert.throws(() => checkListingFactsTable(forge(mutate)), Error, label);
  assert.throws(
    () => generateRegistrations([listing()], forge(forgeries[0]![1])),
    /exact-release-structured/u,
  );
  // A forged entry without a bound repository id is refused too.
  assert.throws(
    () => checkListingFactsTable(table({ ...entry(), repository_id: 0 })),
    /repository id/u,
  );
});

void test("facts older than the age bound are stale and withdraw deterministically", () => {
  const fresh = entry([artifact()], { observed_at: "2026-10-22T00:00:00Z" });
  assert.equal(decide(listing(), fresh, generatedAt).fit, true);
  const stale = entry([artifact()], { observed_at: "2026-10-20T00:00:00Z" });
  assert.equal(reasonOf(decide(listing(), stale, generatedAt)), "stale-facts");
  const committed = enrollmentTable(generateRegistrations([listing()], table(fresh)));
  const later = generateRegistrations([listing()], {
    ...table(fresh),
    generated_at: "2026-11-23T00:00:00.000Z",
  });
  assert.match(enrollmentDelta(committed, later).withdrawn[0]!.reason, /^stale-facts/u);
});

// ---------------------------------------------------------------------------
// F1: the gate's baseline, bounds, batches and independent checks.

function fittingFacts(count: number, prefix = "zz-gate") {
  const ids = Array.from(
    { length: count },
    (_, index) => `${prefix}-${String(index).padStart(3, "0")}`,
  );
  return {
    ids,
    records: ids.map((id) => listing(id)),
    facts: table(...ids.map((id) => entry([artifact()], {}, id))),
  };
}

void test("the gate refuses 65 added routes against the baseline and accepts 64", () => {
  const sixtyFive = fittingFacts(65);
  const generation = generateRegistrations(sixtyFive.records, sixtyFive.facts);
  assert.throws(() => gateGeneration(null, generation), /65 added routes exceed the bound of 64/u);
  const sixtyFour = fittingFacts(64);
  assert.equal(
    gateGeneration(null, generateRegistrations(sixtyFour.records, sixtyFour.facts)).added.length,
    64,
  );
  // Against a baseline holding those 64, one more is a delta of one.
  const baseline = enrollmentTable(generateRegistrations(sixtyFour.records, sixtyFour.facts));
  assert.equal(gateGeneration(baseline, generation).added.length, 1);
  assert.throws(
    () => gateGeneration(enrollmentTable(generation), generateRegistrations([], table())),
    /65 withdrawn routes exceed the bound of 32/u,
  );
  assert.deepEqual(deltaBounds, { added: 64, withdrawn: 32, changed: 64 });
});

void test("the gate independently refuses enrollments that do not rest on their facts", () => {
  const { records, facts } = fittingFacts(1);
  const generation = generateRegistrations(records, facts);
  const tamper = (mutate: (copy: typeof generation) => void, pattern: RegExp) => {
    const copy = structuredClone(generation);
    mutate(copy);
    assert.throws(() => gateGeneration(null, copy), pattern);
  };
  tamper(
    (copy) => (copy.enrollments[0]!.runtimes[0]!.source = "filename-suggestion"),
    /non-authorizing/u,
  );
  tamper((copy) => (copy.enrollments[0]!.facts_sha256 = sha("x")), /committed facts entry/u);
  const swapPlayer = (fields: Partial<PlayerFact>) => (copy: typeof generation) => {
    const players = copy.enrollments[0]!.runtimes[0]!.players;
    players[0] = { ...players[0]!, ...fields };
  };
  tamper(swapPlayer({ sha256: sha("y") }), /no matching player/u);
  tamper(swapPlayer({ machine: "pe-x86" }), /no matching player/u);
  tamper((copy) => {
    const fact = copy.facts.entries[0]!.artifacts[0]!;
    fact.name_suggestion = { ...fact.name_suggestion, role: "dedicated-server" };
    copy.enrollments[0]!.facts_sha256 = digestOf(copy.facts.entries[0]);
  }, /its own name contradicts/u);
  tamper((copy) => {
    copy.facts.entries[0]!.observation.observed_at = "2026-10-01T00:00:00Z";
    copy.enrollments[0]!.facts_sha256 = digestOf(copy.facts.entries[0]);
  }, /older than 30 days/u);
  tamper(
    (copy) => copy.enrollments[0]!.platforms.push("windows-x86-64"),
    /twice|without a runtime/u,
  );
  assert.equal(gateGeneration(null, generation).added.length, 1);
});

void test("facts land as successive bounded batches in port_id order", () => {
  const { ids, records, facts } = fittingFacts(150, "zz-wave");
  const empty = { ...emptyFactsTable(generatedAt) };
  const first = boundFactsBatch(records, empty, facts);
  const landed = enrolledIds(records, first.table);
  assert.deepEqual(landed, ids.slice(0, 64));
  assert.equal(first.deferred.length, 86);
  assert.deepEqual(boundFactsBatch(records, empty, facts), first, "deterministic");
  const second = boundFactsBatch(records, first.table, facts);
  assert.deepEqual(enrolledIds(records, second.table), ids.slice(0, 128));
  const third = boundFactsBatch(records, second.table, facts);
  assert.deepEqual(enrolledIds(records, third.table), ids);
  assert.equal(third.deferred.length, 0);
  // Each batch passes the gate against the previous batch's table.
  for (const [before, after] of [
    [empty, first.table],
    [first.table, second.table],
    [second.table, third.table],
  ] as const)
    gateGeneration(
      enrollmentTable(generateRegistrations(records, before)),
      generateRegistrations(records, after),
    );
});

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout : undefined;
}
function scratchRepository() {
  const directory = mkdtempSync(join(tmpdir(), "generated-registration-gate-"));
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "fixture@example.invalid"],
    ["config", "user.name", "Fixture"],
    ["config", "commit.gpgsign", "false"],
  ])
    assert.notEqual(git(directory, ...args), undefined, args.join(" "));
  const commit = (table: unknown, message: string) => {
    mkdirSync(join(directory, "crates/portcove-core/catalog"), { recursive: true });
    writeFileSync(join(directory, enrollmentTablePath), JSON.stringify(table));
    assert.notEqual(git(directory, "add", "-A"), undefined);
    assert.notEqual(git(directory, "commit", "-q", "-m", message), undefined);
  };
  return { directory, commit, run: (args: string[]) => git(directory, ...args) };
}

void test("the gate's baseline is the merge base's committed table, never the working tree", () => {
  const repository = scratchRepository();
  try {
    const sixtyFour = fittingFacts(64);
    const sixtyFive = fittingFacts(65);
    const small = enrollmentTable(generateRegistrations([], table()));
    repository.commit(small, "base");
    assert.notEqual(repository.run(["update-ref", "refs/remotes/origin/main", "HEAD"]), undefined);
    assert.notEqual(repository.run(["checkout", "-q", "-b", "candidate"]), undefined);
    const big = enrollmentTable(generateRegistrations(sixtyFive.records, sixtyFive.facts));
    repository.commit(big, "65 at once");
    // Hand-editing or regenerating the working tree changes nothing: the
    // baseline is still main's one-entry table.
    writeFileSync(join(repository.directory, enrollmentTablePath), JSON.stringify(big));
    const local = readGateBaseline({}, repository.run);
    assert.deepEqual(local, small);
    assert.throws(
      () => gateGeneration(local, generateRegistrations(sixtyFive.records, sixtyFive.facts)),
      /65 added routes exceed the bound of 64/u,
    );
    // A delta of 64 from the base passes.
    assert.equal(
      gateGeneration(local, generateRegistrations(sixtyFour.records, sixtyFour.facts)).added.length,
      64,
    );
    // Pushes compare with the previous commit; pull requests with the base.
    assert.deepEqual(readGateBaseline({ GITHUB_EVENT_NAME: "push" }, repository.run), small);
    assert.deepEqual(
      readGateBaseline(
        { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" },
        repository.run,
      ),
      small,
    );
    // No table at the base is an empty baseline; no history is an error.
    const fresh = scratchRepository();
    try {
      writeFileSync(join(fresh.directory, "README"), "x");
      fresh.run(["add", "-A"]);
      fresh.run(["commit", "-q", "-m", "empty"]);
      fresh.run(["update-ref", "refs/remotes/origin/main", "HEAD"]);
      assert.equal(readGateBaseline({}, fresh.run), null);
      assert.throws(
        () => readGateBaseline({ GITHUB_EVENT_NAME: "push" }, fresh.run),
        /needs the merge base's history/u,
      );
    } finally {
      rmSync(fresh.directory, { recursive: true, force: true });
    }
    // Outside any repository the baseline is empty, never the working file.
    assert.equal(
      readGateBaseline({}, () => undefined),
      null,
    );
  } finally {
    rmSync(repository.directory, { recursive: true, force: true });
  }
});

void test("generation is deterministic and the committed tables are well formed and current", () => {
  const facts = table(entry());
  assert.deepEqual(
    generateRegistrations([listing()], facts),
    generateRegistrations([listing()], structuredClone(facts)),
  );
  assert.throws(
    () => checkListingFactsTable({ ...facts, entries_sha256: sha("other") }),
    /digest/u,
  );
  assert.throws(
    () =>
      checkListingFactsTable(table({ ...entry(), extra: true } as unknown as ListingFactsEntry)),
    /unknown field extra/u,
  );
  assert.throws(
    () => generateRegistrations([], table(entry())),
    /name zz-unseen-observed-runtime-fixture, which is not listed/u,
  );
  checkListingFactsTable(
    parseCatalogSource(
      readFileSync(join(catalogRoot, "listing-package-facts.generated.json"), "utf8"),
    ),
  );
  const { generation } = readCatalogSource(catalogRoot);
  // A hand-edited committed table differs from the generator output and is refused by --check.
  assert.equal(
    readFileSync(join(catalogRoot, "generated-registration.generated.json"), "utf8"),
    `${JSON.stringify(enrollmentTable(generation), null, 2)}\n`,
  );
});

// ---------------------------------------------------------------------------
// F3: the worker never stalls.

void test("every identity of a 60-identity fixture is attempted within a bounded number of runs", async () => {
  const ids = Array.from(
    { length: 60 },
    (_, index) => `zz-sweep-${String(index).padStart(2, "0")}`,
  );
  const records = ids.map((id) => listing(id));
  const specs: Record<string, ObservationSpec> = {};
  for (const [index, id] of ids.entries()) {
    // 25 identities publish no provider digest; the first queued needs more
    // than one run's whole byte budget; three fail transiently every time.
    const sha256 = index % 12 < 5 ? null : undefined;
    const size = index === 5 ? 900 : 100;
    specs[id] = {
      releases: [
        {
          id: 8,
          tag: "v1.0",
          assets: [
            { id: 21, name: windowsZip, size, sha256 },
            { id: 22, name: linuxTar, size, sha256 },
          ],
        },
      ],
    };
  }
  const report = observerReport(specs);
  const flaky = new Set(ids.slice(55, 58));
  const inspect: ByteInspector = async (asset) => {
    const id = /fixture-owner\/([^/]+)\//u.exec(asset.url)![1]!;
    if (flaky.has(id)) throw new Error("network reset");
    return asset.name === linuxTar ? [player("Game", "elf64-x86-64")] : [player("Game.exe")];
  };
  const budget = { maxIdentities: 12, maxBytes: 1500, maxArchiveBytes: 1000 };
  const attempted = new Set<string>();
  let facts = emptyFactsTable("2026-11-20T00:00:00.000Z");
  let state: WorkerState | undefined;
  let runs = 0;
  while (runs < 10) {
    runs++;
    const result = await derive(records, report, facts, {
      state,
      inspect,
      budget,
      now: `2026-11-2${runs}T00:00:00.000Z`,
    });
    for (const row of result.report)
      if (row.outcome !== "deferred-identities") attempted.add(row.port_id);
    assert.ok(result.report.filter((row) => row.inspected > 0).length <= 12);
    facts = result.table;
    state = result.state;
    if (attempted.size === 60 && state.after === null && !state.held.length && !state.retry.length)
      break;
  }
  assert.equal(attempted.size, 60);
  // Bytes allow seven inspections a run: 34 inspected identities take five
  // runs, and three transient failures complete on their third attempt.
  assert.ok(runs <= 8, `took ${runs} runs`);
  const blocked = enrollmentTable(generateRegistrations(records, facts)).blocked;
  assert.equal(blocked["unbound-archive"], 25);
  assert.equal(blocked["exceeds-run-budget"], 1);
  assert.equal(blocked["repeated-inspection-failure"], 3);
  assert.equal(generateRegistrations(records, facts).enrollments.length, 31);
});

void test("an identity costlier than a whole run is completed with a reason, not retried", async () => {
  const ids = ["zz-cost-a", "zz-cost-b"];
  const records = ids.map((id) => listing(id));
  const report = observerReport({
    "zz-cost-a": {
      releases: [
        {
          id: 8,
          tag: "v1.0",
          assets: [
            { id: 21, name: windowsZip, size: 900 },
            { id: 22, name: linuxTar, size: 900 },
          ],
        },
      ],
    },
    "zz-cost-b": {},
  });
  const log: string[] = [];
  const first = await derive(records, report, undefined, {
    inspect: inspector({ [linuxTar]: [player("Game", "elf64-x86-64")] }, log),
    budget: { maxBytes: 1000, maxArchiveBytes: 1000 },
  });
  assert.equal(outcome(first, "zz-cost-a")!.reason, "exceeds-run-budget");
  assert.equal(outcome(first, "zz-cost-b")!.outcome, "complete");
  log.length = 0;
  const second = await derive(records, report, first.table, {
    state: first.state,
    inspect: inspector({}, log),
    budget: { maxBytes: 1000, maxArchiveBytes: 1000 },
    now: "2026-11-22T00:00:00.000Z",
  });
  assert.deepEqual(log, [], "neither identity is read again while its release is unchanged");
  assert.equal(outcome(second, "zz-cost-a")!.outcome, "unchanged");
});

void test("transient failures retry from a bounded queue; permanent refusals complete", async () => {
  const ids = ["zz-retry-a", "zz-retry-b", "zz-retry-c"];
  const records = ids.map((id) => listing(id));
  const report = observerReport(Object.fromEntries(ids.map((id) => [id, {}])));
  let calls = 0;
  const inspect: ByteInspector = async (asset) => {
    calls++;
    if (asset.url.includes("zz-retry-a")) throw new Error("reset");
    if (asset.url.includes("zz-retry-b"))
      throw new InspectionError("Core refused the archive during inspection.", true);
    return [player("Game.exe")];
  };
  const first = await derive(records, report, undefined, { inspect });
  assert.deepEqual(
    first.state.retry.map((item) => item.port_id),
    ["zz-retry-a"],
  );
  assert.equal(outcome(first, "zz-retry-b")!.reason, "inspection-refused");
  assert.equal(outcome(first, "zz-retry-c")!.outcome, "complete");
  const second = await derive(records, report, first.table, {
    state: first.state,
    inspect,
    now: "2026-11-22T00:00:00.000Z",
  });
  assert.equal(second.state.retry[0]!.failures, 2);
  const third = await derive(records, report, second.table, {
    state: second.state,
    inspect,
    now: "2026-11-23T00:00:00.000Z",
  });
  assert.equal(outcome(third, "zz-retry-a")!.reason, "repeated-inspection-failure");
  assert.deepEqual(third.state.retry, []);
  calls = 0;
  await derive(records, report, third.table, {
    state: third.state,
    inspect,
    now: "2026-11-24T00:00:00.000Z",
  });
  assert.equal(calls, 0, "completed identities are not retried while the release is unchanged");
});

// ---------------------------------------------------------------------------
// F5: unknown never withdraws; positive evidence does; repository identity binds.

void test("an unavailable upstream keeps last-good facts for the retention bound, then withdraws with a reason", async () => {
  const id = "zz-flap";
  const records = [listing(id)];
  const good = await derive(records, observerReport({ [id]: {} }));
  assert.deepEqual(enrolledIds(records, good.table), [id]);
  const committed = enrollmentTable(generateRegistrations(records, good.table));
  for (const status of ["unavailable", "failed", "incomplete"]) {
    const unknown = await derive(
      records,
      observerReport({ [id]: { status, repository_id: null, releases: [] } }),
      good.table,
      { now: "2026-11-25T00:00:00.000Z" },
    );
    assert.equal(outcome(unknown, id)!.outcome, "retained-last-good", status);
    assert.deepEqual(enrolledIds(records, unknown.table), [id], status);
  }
  let facts = good.table;
  for (const now of [
    "2026-11-25T00:00:00.000Z",
    "2026-12-02T00:00:00.000Z",
    "2026-12-06T00:00:00.000Z",
  ]) {
    facts = (
      await derive(
        records,
        observerReport({ [id]: { status: "unavailable", repository_id: null, releases: [] } }),
        facts,
        { now },
      )
    ).table;
    assert.deepEqual(enrolledIds(records, facts), [id], now);
  }
  const expired = await derive(
    records,
    observerReport({ [id]: { status: "unavailable", repository_id: null, releases: [] } }),
    facts,
    { now: "2026-12-10T00:00:00.000Z" },
  );
  assert.equal(outcome(expired, id)!.reason, "observation-unavailable");
  const after = generateRegistrations(records, expired.table);
  assert.match(enrollmentDelta(committed, after).withdrawn[0]!.reason, /^observation-unavailable/u);
  // A complete observation again re-evaluates the identity.
  const back = await derive(records, observerReport({ [id]: {} }), expired.table, {
    now: "2026-12-11T00:00:00.000Z",
  });
  assert.deepEqual(enrolledIds(records, back.table), [id]);
});

void test("a complete observation that no longer fits withdraws immediately", async () => {
  const id = "zz-positive";
  const records = [listing(id)];
  const good = await derive(records, observerReport({ [id]: {} }));
  const noStable = await derive(
    records,
    observerReport({
      [id]: {
        releases: [
          {
            id: 9,
            tag: "v2.0-alpha",
            published_at: "2026-11-15T00:00:00Z",
            assets: [{ id: 31, name: windowsZip }],
          },
        ],
      },
    }),
    good.table,
  );
  assert.equal(outcome(noStable, id)!.reason, "no-stable-release");
  assert.deepEqual(enrolledIds(records, noStable.table), []);
  const serverOnly = await derive(
    records,
    observerReport({
      [id]: {
        releases: [
          {
            id: 10,
            tag: "alphabet-1.0",
            assets: [{ id: 41, name: "MyGame-dedicated-server-win64.zip" }],
          },
        ],
      },
    }),
    good.table,
    { inspect: inspector({ "MyGame-dedicated-server-win64.zip": [player("server.exe")] }) },
  );
  assert.equal(reasonOf(decide(records[0]!, serverOnly.table.entries[0])), "contradictory-role");
});

void test("facts bind the repository id: a rename continues, a different id withdraws", async () => {
  const id = "zz-repo";
  const records = [listing(id)];
  const good = await derive(records, observerReport({ [id]: { repository_id: 4242 } }));
  assert.equal(good.table.entries[0]!.repository_id, 4242);
  // Renamed upstream, same id: the route continues and stays bound to the listing.
  const renamed = await derive(
    records,
    observerReport({ [id]: { repository: "new-owner/new-name", repository_id: 4242 } }),
    good.table,
  );
  assert.deepEqual(enrolledIds(records, renamed.table), [id]);
  // Name reused or re-created: a different id is another repository.
  for (const replacement of [
    { repository_id: 9999 },
    { repository: "Fixture-Owner/ZZ-REPO", repository_id: 777 },
  ]) {
    const moved = await derive(records, observerReport({ [id]: replacement }), good.table);
    assert.equal(outcome(moved, id)!.reason, "repository-identity-changed");
    assert.deepEqual(enrolledIds(records, moved.table), []);
    assert.equal(moved.table.entries[0]!.repository_id, 4242, "the bound id is kept");
    const still = await derive(records, observerReport({ [id]: replacement }), moved.table, {
      now: "2026-11-22T00:00:00.000Z",
    });
    assert.deepEqual(enrolledIds(records, still.table), [], "stays withdrawn");
  }
});

// ---------------------------------------------------------------------------
// F6: hostile upstream strings and per-identity validation.

void test("one hostile or odd path marks only its identity invalid; the run continues", async () => {
  const hostile = [
    "Game/‮exe.game",
    "Game/ game.exe",
    "Game/a:b.exe",
    "Game\\game.exe",
    "Game/zero​width.exe",
  ];
  const ids = hostile.map((_, index) => `zz-hostile-${index}`);
  const records = [...ids, "zz-hostile-ok"].map((id) => listing(id));
  const report = observerReport(
    Object.fromEntries([...ids, "zz-hostile-ok"].map((id) => [id, {}])),
  );
  const inspect: ByteInspector = async (asset) => {
    const index = ids.findIndex((id) => asset.url.includes(`/${id}/`));
    return [player(index >= 0 ? hostile[index]! : "Game/Game.exe")];
  };
  const result = await derive(records, report, undefined, { inspect });
  for (const id of ids) assert.equal(outcome(result, id)!.reason, "invalid-facts", id);
  assert.deepEqual(enrolledIds(records, result.table), ["zz-hostile-ok"]);
  checkListingFactsTable(result.table);
  // A hostile tag is replaced in the facts, never stored or shown.
  const tagged = await derive(
    [listing("zz-tag")],
    observerReport({
      "zz-tag": {
        releases: [{ id: 8, tag: "v1.0\u202e", assets: [{ id: 21, name: windowsZip }] }],
      },
    }),
  );
  assert.equal(tagged.table.entries[0]!.observation.tag, "release-8");
  assert.deepEqual(enrolledIds([listing("zz-tag")], tagged.table), ["zz-tag"]);
});

void test("players are shown only through a conservative name class, at most three, with original case", () => {
  for (const [name, shown] of [
    ["Game.x86_64", true],
    ["My Game.exe", true],
    ["‮exe.game", false],
    ["ga​me.exe", false],
    ["gаme.exe", false], // Cyrillic a
    ["x".repeat(121), false],
    [" game.exe", false],
  ] as const)
    assert.equal(displayableName(name), shown, JSON.stringify(name));
  const guideOf = (players: PlayerFact[], name = windowsZip) =>
    generateRegistrations([listing()], table(entry([artifact(name, players)]))).records[0]!.listing
      .manual_setup as Guide;
  assert.match(
    guideOf([player("Game/Game.x86_64.exe")]).steps[2]!.instruction,
    /^Select Game\.x86_64\.exe in/u,
  );
  const many = guideOf(["A.exe", "B.exe", "C.exe", "D.exe", "E.exe"].map((path) => player(path)));
  assert.equal(many.steps[2]!.instruction, genericSelection);
  assert.match(many.references[1]!.instruction, /contains A\.exe, B\.exe, C\.exe and 2 more\./u);
  const hidden = guideOf([player("game.exe")], windowsZip);
  assert.match(hidden.references[1]!.instruction, /release v1\.0/u);
  // A name outside the class falls back to generic wording everywhere.
  const confusable = structuredClone(entry());
  confusable.artifacts[0]!.players = [player("gаme.exe")];
  const guide = generateRegistrations([listing()], table(confusable)).records[0]!.listing
    .manual_setup as Guide;
  assert.equal(guide.steps[2]!.instruction, genericSelection);
  assert.doesNotMatch(JSON.stringify(guide), /gаme/u);
});

// ---------------------------------------------------------------------------
// F7: Core's prerelease rule, bounded CLI runs.

void test("the latest stable release follows Core's prerelease rule, not only the provider flag", async () => {
  const id = "zz-stable";
  const log: string[] = [];
  const result = await derive(
    [listing(id)],
    observerReport({
      [id]: {
        releases: [
          {
            id: 12,
            tag: "v2.2-nightly",
            published_at: "2026-11-18T00:00:00Z",
            assets: [{ id: 51, name: linuxTar }],
          },
          {
            id: 11,
            tag: "v2.1-preview",
            published_at: "2026-11-17T00:00:00Z",
            assets: [{ id: 52, name: linuxTar }],
          },
          {
            id: 10,
            tag: "v2.0-alpha",
            published_at: "2026-11-16T00:00:00Z",
            assets: [{ id: 53, name: linuxTar }],
          },
          {
            id: 9,
            tag: "v3.0",
            provider_prerelease: true,
            published_at: "2026-11-19T00:00:00Z",
            assets: [{ id: 54, name: linuxTar }],
          },
          {
            id: 8,
            tag: "v1.0",
            published_at: "2026-11-01T00:00:00Z",
            assets: [{ id: 55, name: windowsZip }],
          },
        ],
      },
    }),
    undefined,
    { inspect: inspector({}, log) },
  );
  assert.deepEqual(log, [windowsZip]);
  assert.equal(result.table.entries[0]!.observation.tag, "v1.0");
});

void test("a CLI run that times out is killed and leaves no temporary workspace", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "listing-facts-core-"));
  try {
    const script =
      "const fs=require('node:fs'),os=require('node:os'),p=require('node:path');" +
      "fs.writeFileSync(p.join(os.tmpdir(),'workspace-marker'),'x');setTimeout(()=>{},60000);";
    const run = await runCore(process.execPath, ["-e", script], scratch, 500);
    assert.equal(run.exited, false);
    assert.ok(
      existsSync(join(scratch, "core-tmp", "workspace-marker")),
      "Core's TMPDIR is inside the scratch",
    );
    const refused = await runCore(
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify({ok:false,error:{code:'verification'}}));process.exit(2)",
      ],
      scratch,
      30_000,
    );
    assert.equal(refused.exited, true);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  assert.equal(existsSync(scratch), false);
  assert.deepEqual(
    (await readdir(tmpdir())).filter((name) => name === "workspace-marker"),
    [],
  );
});

// ---------------------------------------------------------------------------
// The worker end to end, reuse and batches.

void test("the worker reuses unchanged archives and holds facts beyond one batch for the next run", async () => {
  const ids = Array.from(
    { length: 70 },
    (_, index) => `zz-batch-${String(index).padStart(2, "0")}`,
  );
  const records = ids.map((id) => listing(id));
  const report = observerReport(Object.fromEntries(ids.map((id) => [id, {}])));
  const log: string[] = [];
  const first = await derive(records, report, undefined, {
    inspect: inspector({}, log),
    budget: { maxIdentities: 100 },
  });
  assert.equal(log.length, 70);
  assert.deepEqual(enrolledIds(records, first.table), ids.slice(0, 64));
  assert.equal(first.state.held.length, 6);
  assert.ok(first.report.filter((row) => row.outcome === "held-for-batch").length === 6);
  log.length = 0;
  const second = await derive(records, report, first.table, {
    state: first.state,
    inspect: inspector({}, log),
    now: "2026-11-22T00:00:00.000Z",
  });
  assert.deepEqual(log, [], "held and landed facts are reused, not downloaded again");
  assert.deepEqual(enrolledIds(records, second.table), ids);
  assert.deepEqual(second.state.held, []);
  gateGeneration(
    enrollmentTable(generateRegistrations(records, first.table)),
    generateRegistrations(records, second.table),
  );
});

void test("an authored listing guide stays first and gains the generated selection step", () => {
  const authored = listing(unseen, {
    manual_setup: {
      steps: [{ title: "Import your files", instruction: "Use the upstream importer first." }],
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
  assert.equal(reasonOf(decide(crowded, entry())), "guide-bound");
});
