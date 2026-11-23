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
  checkFactsProvenance,
  compareCodePoints,
  machineSystem,
  registrationQueues,
  checkListingFactsTable,
  deltaBounds,
  digestOf,
  displayableName,
  emptyFactsTable,
  enrollmentDelta,
  enrollmentTable,
  enrollmentTablePath,
  failSafeExclusions,
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
  maximumNameBytes,
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
    assets: {
      name: string;
      role: NameSuggestion["role"];
      os: string;
      arch: string;
      tool_token: string | null;
      system_token: string | null;
    }[];
    programs: { name: string; tool_token: string | null }[];
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
  programs: input.programs.map((name) => {
    const known = classification.output.programs.find((candidate) => candidate.name === name);
    assert.ok(known, `Core fixture has no program verdict for ${name}`);
    return known;
  }),
});
/** Core's recorded tool token for a program name. */
function programToken(name: string): string | null {
  const known = classification.output.programs.find((candidate) => candidate.name === name);
  assert.ok(known, `Core fixture has no program verdict for ${name}`);
  return known.tool_token;
}
function suggestion(name: string): NameSuggestion {
  const known = classification.output.assets.find((candidate) => candidate.name === name);
  assert.ok(known, name);
  return {
    rule_version: classification.output.filename_rule_version,
    role: known.role,
    os: known.os,
    arch: known.arch,
    tool_token: known.tool_token,
    system_token: known.system_token,
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
    programToken,
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
    unread_forms: [],
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
  previous: ListingFactsTable = emptyFactsTable("2026-11-01T00:00:00.000Z"),
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
    const expected = [
      "dedicated-server",
      "installer",
      "builder",
      "compiler",
      "dev-tool",
      "importer",
    ].includes(why)
      ? "tool-not-game"
      : ["mobile-package", "console-output"].includes(why)
        ? "non-desktop-platform"
        : "contradictory-role";
    assert.equal(reasonOf(decision), expected, name);
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
    [artifact(windowsZip, []), "no-player"],
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

void test("the gate checks one top-level directory across every name-permitted artifact (H3)", () => {
  const generation = generateRegistrations([listing()], table(entry()));
  assert.equal(gateGeneration(null, generation).added.length, 1);
  // A second archive the name allows for the same platform holds the same
  // program under two top-level directories: the generator calls that
  // ambiguous, and the gate must refuse it too even though the enrolled
  // runtime's own archive is clean.
  const copy = structuredClone(generation);
  copy.facts.entries[0]!.artifacts.push(
    artifact(windowsZip, [player("A/Unseen.exe"), player("B/Unseen.exe")], 12),
  );
  copy.enrollments[0]!.facts_sha256 = digestOf(copy.facts.entries[0]);
  assert.throws(() => gateGeneration(null, copy), /several top-level directories/u);
  assert.equal(
    reasonOf(decide(listing(), copy.facts.entries[0])),
    "ambiguous-player",
    "the generator agrees",
  );
});

void test("malformed asset records and an undated newest release are invalid facts, never dropped (H4)", async () => {
  const id = unseen;
  const malformed = observerReport({ [id]: {} });
  const assets = malformed.listings[0]!.listing_update.upstream_observation.releases[0]!
    .assets as unknown[];
  assets.push({ id: "not-a-number", name: "Game-v1.0-linux-x86_64.tar.gz", url: "x", size: 1 });
  const first = await derive([listing()], malformed);
  assert.equal(outcome(first, id)?.reason, "invalid-facts");
  assert.match(first.table.entries[0]!.ineligible!.detail, /asset record/u);
  // A malformed asset in an older, superseded release does not matter.
  const older = observerReport({
    [id]: {
      releases: [
        {
          id: 9,
          tag: "v1.0",
          published_at: "2026-11-02T00:00:00Z",
          assets: [{ id: 31, name: windowsZip }],
        },
        { id: 8, tag: "alphabet-1.0", assets: [{ id: 21, name: windowsZip }] },
      ],
    },
  });
  (older.listings[0]!.listing_update.upstream_observation.releases[1]!.assets as unknown[]).push({
    name: "broken",
  });
  assert.equal((await derive([listing()], older)).table.entries[0]!.ineligible, null);
  // The newest release (highest id) without a parseable publication time
  // makes the latest stable release unknown.
  for (const published of [null, "not-a-date"]) {
    const undated = observerReport({
      [id]: {
        releases: [
          { id: 9, tag: "v1.0", assets: [{ id: 31, name: windowsZip }] },
          { id: 8, tag: "alphabet-1.0", assets: [{ id: 21, name: windowsZip }] },
        ],
      },
    });
    undated.listings[0]!.listing_update.upstream_observation.releases[0]!.published_at =
      published as unknown as string;
    const result = await derive([listing()], undated);
    assert.equal(outcome(result, id)?.reason, "invalid-facts", String(published));
    assert.match(result.table.entries[0]!.ineligible!.detail, /publication time/u);
  }
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
  assert.equal(blocked["no-digest"], 25);
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
  assert.equal(outcome(first, "zz-retry-b")!.reason, "core-refused");
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
    { inspect: inspector({ "MyGame-dedicated-server-win64.zip": [player("game.exe")] }) },
  );
  assert.equal(reasonOf(decide(records[0]!, serverOnly.table.entries[0])), "tool-not-game");
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
  // Five distinct programs are never one game.
  const distinct = ["A.exe", "B.exe", "C.exe", "D.exe", "E.exe"].map((path) => player(path));
  assert.equal(
    reasonOf(decide(listing(), entry([artifact(windowsZip, distinct)]))),
    "ambiguous-player",
  );
  // Five builds of one program enroll; the guide names none and lists three.
  const many = guideOf(
    ["Game.exe", "Game-64.exe", "Game.x64.exe", "Game.console.exe", "Game.x86_64.exe"].map((path) =>
      player(path),
    ),
  );
  assert.equal(many.steps[2]!.instruction, genericSelection);
  assert.match(
    many.references[1]!.instruction,
    /contains Game-64\.exe, Game\.console\.exe, Game\.exe and 2 more\./u,
  );
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
  // Held facts are backlog too, named apart from inspection work.
  assert.equal(first.backlog.held_for_batch, 6);
  assert.equal(first.backlog.runs_to_land_held, 1);
  assert.equal(first.no_progress, false);
  log.length = 0;
  const second = await derive(records, report, first.table, {
    state: first.state,
    inspect: inspector({}, log),
    now: "2026-11-22T00:00:00.000Z",
  });
  assert.deepEqual(log, [], "held and landed facts are reused, not downloaded again");
  assert.deepEqual(enrolledIds(records, second.table), ids);
  assert.deepEqual(second.state.held, []);
  assert.equal(second.backlog.held_for_batch, 0);
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

// ---------------------------------------------------------------------------
// One identity never fails a run (N1).

/** Refuses a request like Core does: any name over the byte bound or malformed. */
function refusingLikeCore(inner: NameClassifier, refusals: { count: number }): NameClassifier {
  return async (input) => {
    const names = [
      ...input.releases.map((release) => release.tag),
      ...input.assets,
      ...input.programs,
    ];
    if (names.some((name) => !name.isWellFormed() || Buffer.byteLength(name) > maximumNameBytes)) {
      refusals.count++;
      throw new InspectionError("listing name classification exceeds its bounds", true);
    }
    return await inner(input);
  };
}
/** Core's recorded answers where known; any other well-formed name has no suggestion. */
const anyNameClassifier: NameClassifier = async (input) => ({
  filename_rule_version: classification.output.filename_rule_version,
  releases: input.releases.map(
    (release) =>
      classification.output.releases.find(
        (known) =>
          known.tag === release.tag && known.provider_prerelease === release.provider_prerelease,
      ) ?? { ...release, prerelease: release.provider_prerelease },
  ),
  assets: input.assets.map(
    (name) =>
      classification.output.assets.find((known) => known.name === name) ?? {
        name,
        role: "unknown" as const,
        os: "unknown",
        arch: "unknown",
        tool_token: null,
        system_token: null,
      },
  ),
  programs: input.programs.map(
    (name) =>
      classification.output.programs.find((known) => known.name === name) ?? {
        name,
        tool_token: null,
      },
  ),
});

void test("an oversized tag and release file name settle only their identity; another identity still enrolls", async () => {
  const bad = "zz-oversized";
  const good = "zz-ordinary";
  const records = [listing(bad), listing(good)];
  const longTag = `v${"1".repeat(1099)}`;
  const longName = `${"G".repeat(1096)}.zip`;
  assert.equal(Buffer.byteLength(longTag), 1100);
  assert.equal(Buffer.byteLength(longName), 1100);
  const refusals = { count: 0 };
  const log: string[] = [];
  const result = await deriveListingFacts({
    records,
    observerReport: observerReport({
      [bad]: {
        releases: [
          // Newest, but its tag cannot be classified: never skipped as a
          // prerelease, so the identity records invalid facts.
          {
            id: 12,
            tag: longTag,
            published_at: "2026-11-10T00:00:00Z",
            assets: [{ id: 51, name: windowsZip }],
          },
          {
            id: 8,
            tag: "v1.0",
            assets: [
              { id: 21, name: windowsZip },
              { id: 23, name: longName },
            ],
          },
        ],
      },
      [good]: {},
    }),
    table: emptyFactsTable("2026-11-01T00:00:00.000Z"),
    inspect: async (asset) => {
      log.push(asset.url);
      return [player("Game/Game.exe")];
    },
    classify: refusingLikeCore(coreClassifier, refusals),
    now: "2026-11-21T00:00:00.000Z",
  });
  assert.equal(refusals.count, 0, "the worker never sends a name Core refuses");
  assert.equal(outcome(result, bad)!.reason, "invalid-facts");
  const badEntry = result.table.entries.find((item) => item.port_id === bad)!;
  assert.equal(badEntry.observation.release_id, 12, "no silent fallback to an older release");
  assert.equal(badEntry.observation.tag, "release-12");
  assert.match(badEntry.ineligible!.detail, /tag Core could not classify/u);
  assert.ok(
    log.every((url) => url.includes(good)),
    "an identity with an unclassified release file reads no bytes",
  );
  assert.deepEqual(enrolledIds(records, result.table), [good]);
  checkListingFactsTable(result.table);
});

void test("a name Core refuses alone is isolated by splitting the request; an unusable CLI fails the run", async () => {
  const poison = "Game-v1.0-windows-x64-poison.zip";
  const records = [listing("zz-poison"), listing("zz-clean")];
  let calls = 0;
  const classify: NameClassifier = async (input) => {
    calls++;
    if (input.assets.includes(poison)) throw new InspectionError("Core refused", true);
    return await anyNameClassifier(input);
  };
  const report = observerReport({
    "zz-poison": { releases: [{ id: 8, tag: "v1.0", assets: [{ id: 21, name: poison }] }] },
    "zz-clean": {},
  });
  const result = await derive(records, report, undefined, {});
  // `derive` replays the strict fixture; the poisoned name is not in it.
  assert.equal(outcome(result, "zz-poison")!.reason, "invalid-facts");
  const isolated = await deriveListingFacts({
    records,
    observerReport: report,
    table: emptyFactsTable("2026-11-01T00:00:00.000Z"),
    inspect: inspector(),
    classify,
    now: "2026-11-21T00:00:00.000Z",
  });
  assert.ok(calls > 2);
  assert.equal(outcome(isolated, "zz-poison")!.reason, "invalid-facts");
  assert.deepEqual(enrolledIds(records, isolated.table), ["zz-clean"]);
  await assert.rejects(
    deriveListingFacts({
      records,
      observerReport: report,
      table: emptyFactsTable("2026-11-01T00:00:00.000Z"),
      inspect: inspector(),
      classify: async () => {
        throw new Error("no CLI");
      },
      now: "2026-11-21T00:00:00.000Z",
    }),
    /CLI is unusable/u,
  );
});

void test("an unexpected failure while inspecting one identity settles only that identity", async () => {
  const records = [listing("zz-broken"), listing("zz-fine")];
  const result = await derive(
    records,
    observerReport({ "zz-broken": {}, "zz-fine": {} }),
    undefined,
    {
      inspect: async (asset) => {
        if (asset.url.includes("zz-broken"))
          return [{ path: 7, display_path: null }] as unknown as PlayerFact[];
        return [player("Game/Game.exe")];
      },
    },
  );
  assert.equal(outcome(result, "zz-broken")!.reason, "invalid-facts");
  assert.deepEqual(enrolledIds(records, result.table), ["zz-fine"]);
});

/** A small deterministic generator for fuzzing (mulberry32). */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

void test("malformed per-identity observations never fail the run (fuzz)", async () => {
  const random = seeded(8569);
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const junk = () =>
    pick<unknown>([
      null,
      undefined,
      -1,
      0,
      1.5,
      2 ** 60,
      "",
      " ",
      "\ud800",
      "‮.exe",
      "a\u0000b",
      "x".repeat(5000),
      `${"G".repeat(1100)}.zip`,
      [],
      [null],
      {},
      { id: 1 },
      true,
      "2026-13-45T99:99:99Z",
      "Game-v1.0-windows-x64.zip",
    ]);
  const ids = Array.from({ length: 6 }, (_, index) => `zz-fuzz-${index}`);
  const good = "zz-fuzz-good";
  const records = [...ids, good].map((id) => listing(id));
  const base = observerReport(Object.fromEntries([...ids, good].map((id) => [id, {}])));
  const paths = (value: unknown, prefix: (string | number)[] = []): (string | number)[][] =>
    isObject(value)
      ? [
          prefix,
          ...Object.entries(value).flatMap(([key, child]) =>
            paths(child, [...prefix, Array.isArray(value) ? Number(key) : key]),
          ),
        ]
      : [prefix];
  for (let round = 0; round < 120; round++) {
    const report = structuredClone(base) as { listings: Record<string, unknown>[] };
    for (const [index] of ids.entries()) {
      const target = report.listings[index]!;
      const candidates = paths(target).filter((path) => path.length > 1);
      for (let mutation = 0; mutation < 1 + Math.floor(random() * 4); mutation++) {
        const path = pick(candidates);
        let parent = target as Record<string | number, unknown>;
        for (const key of path.slice(0, -1)) {
          const next = parent[key];
          if (!isObject(next)) break;
          parent = next as Record<string | number, unknown>;
        }
        const key = path.at(-1)!;
        if (random() < 0.15) delete parent[key];
        else if (random() < 0.1)
          parent[key] = Array.from({ length: 300 }, (_, item) => ({
            id: item + 1,
            name: `asset-${item}.zip`,
            url: "https://github.com/x",
            size: 10,
            sha256: sha(`${item}`),
          }));
        else parent[key] = junk();
      }
    }
    if (random() < 0.3) report.listings.push(structuredClone(report.listings[0]!));
    const refusals = { count: 0 };
    const result = await deriveListingFacts({
      records,
      observerReport: report,
      table: emptyFactsTable("2026-11-01T00:00:00.000Z"),
      inspect: inspector(),
      classify: refusingLikeCore(anyNameClassifier, refusals),
      now: "2026-11-21T00:00:00.000Z",
      budget: { maxIdentities: 100 },
    });
    assert.equal(refusals.count, 0, `round ${round}`);
    checkListingFactsTable(result.table);
    assert.ok(enrolledIds(records, result.table).includes(good), `round ${round}`);
  }
});
const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

// ---------------------------------------------------------------------------
// The worker's own backlog is not upstream unavailability (N2).

/** A newer stable release with a fresh archive, so the identity needs bytes again. */
const changedRelease = (id: string): ObservationSpec => ({
  releases: [
    {
      id: 9,
      tag: "alphabet-1.0",
      published_at: "2026-11-15T00:00:00Z",
      assets: [{ id: 61, name: windowsZip, sha256: sha(`${id}-changed`) }],
    },
  ],
});
const dayAfter = (start: string, days: number) =>
  new Date(Date.parse(start) + days * 86_400_000).toISOString();

void test("enrolled identities whose release changed stay offered as pending-inspection, never as unavailable upstream", async () => {
  const ids = Array.from(
    { length: 41 },
    (_, index) => `zz-backlog-${String(index).padStart(2, "0")}`,
  );
  const records = ids.map((id) => listing(id));
  const start = "2026-11-02T00:00:00.000Z";
  const first = await derive(
    records,
    observerReport(Object.fromEntries(ids.map((id) => [id, { observed_at: start }]))),
    undefined,
    { budget: { maxIdentities: 100 }, now: start },
  );
  assert.deepEqual(enrolledIds(records, first.table), ids);
  let facts = first.table;
  let state: WorkerState | undefined = first.state;
  let drainedOn: number | undefined;
  for (let day = 1; day <= 25; day++) {
    const now = dayAfter(start, day);
    const run = await derive(
      records,
      observerReport(
        Object.fromEntries(ids.map((id) => [id, { ...changedRelease(id), observed_at: now }])),
      ),
      facts,
      { state, now, budget: { maxIdentities: 2 } },
    );
    if (day === 1) {
      assert.equal(run.backlog.enrolled_pending, 39);
      assert.equal(run.backlog.new_pending, 0);
      assert.equal(run.backlog.runs_to_drain_enrolled, 20);
      assert.equal(run.backlog.days_to_drain_enrolled, 20);
      assert.ok(run.report.some((row) => row.reason === "pending-inspection"));
    }
    assert.ok(
      run.table.entries.every((item) => item.ineligible?.reason !== "observation-unavailable"),
      `day ${day}: the backlog is not an upstream failure`,
    );
    assert.deepEqual(enrolledIds(records, run.table), ids, `day ${day}: still offered`);
    gateGeneration(
      enrollmentTable(generateRegistrations(records, facts)),
      generateRegistrations(records, run.table),
      deltaBounds,
      facts,
    );
    facts = run.table;
    state = run.state;
    if (drainedOn === undefined && run.backlog.enrolled_pending === 0) drainedOn = day;
  }
  assert.equal(drainedOn, 21, "two identities per run drain 41 in 21 runs");
  assert.ok(facts.entries.every((item) => item.observation.tag === "alphabet-1.0"));
  assert.ok(facts.entries.every((item) => item.attempt === null));
});

void test("pending last-good facts withdraw only at the stale-facts age", async () => {
  const id = "zz-starved";
  const newcomers = Array.from(
    { length: 40 },
    (_, index) => `zz-new-${String(index).padStart(2, "0")}`,
  );
  const records = [id, ...newcomers].map((item) => listing(item));
  const start = "2026-11-02T00:00:00.000Z";
  const first = await derive(records, observerReport({ [id]: { observed_at: start } }), undefined, {
    now: start,
  });
  let facts = first.table;
  let state: WorkerState | undefined = first.state;
  for (let day = 1; day <= 32; day++) {
    const now = dayAfter(start, day);
    // One identity per run, always taken by the cursor's next new identity.
    const run = await derive(
      records,
      observerReport({
        [id]: { ...changedRelease(id), observed_at: now },
        ...Object.fromEntries(newcomers.map((item) => [item, { observed_at: now }])),
      }),
      facts,
      { state, now, budget: { maxIdentities: 1 } },
    );
    const decision = decide(
      records[0]!,
      run.table.entries.find((item) => item.port_id === id),
      now,
    );
    if (day <= 30) assert.equal(reasonOf(decision), "fit", `day ${day}`);
    else assert.equal(reasonOf(decision), "stale-facts", `day ${day}`);
    assert.notEqual(outcome(run, id)?.reason, "observation-unavailable");
    facts = run.table;
    state = run.state;
  }
});

void test("offered identities are refreshed before growth, and growth still advances every run", async () => {
  const enrolled = Array.from({ length: 5 }, (_, index) => `zz-held-${index}`);
  const newcomers = Array.from(
    { length: 10 },
    (_, index) => `zz-grow-${String(index).padStart(2, "0")}`,
  );
  const records = [...enrolled, ...newcomers].map((id) => listing(id));
  const start = "2026-11-02T00:00:00.000Z";
  const first = await derive(
    records,
    observerReport(Object.fromEntries(enrolled.map((id) => [id, { observed_at: start }]))),
    undefined,
    { now: start },
  );
  assert.deepEqual(enrolledIds(records, first.table), enrolled);
  let facts = first.table;
  let state: WorkerState | undefined = first.state;
  const grown: number[] = [];
  for (let day = 1; day <= 4; day++) {
    const now = dayAfter(start, day);
    const log: string[] = [];
    const run = await derive(
      records,
      observerReport({
        ...Object.fromEntries(
          enrolled.map((id) => [id, { ...changedRelease(id), observed_at: now }]),
        ),
        ...Object.fromEntries(newcomers.map((id) => [id, { observed_at: now }])),
      }),
      facts,
      {
        state,
        now,
        budget: { maxIdentities: 4 },
        inspect: async (asset) => {
          log.push(asset.url.split("/")[4]!);
          return [player("Game/Game.exe")];
        },
      },
    );
    const inspectedNew = log.filter((id) => id.startsWith("zz-grow")).length;
    grown.push(inspectedNew);
    if (day === 1) {
      assert.deepEqual(
        log.filter((id) => id.startsWith("zz-held")),
        enrolled.slice(0, 3),
        "offered identities take all but the reserved share",
      );
      assert.equal(inspectedNew, 1);
    }
    facts = run.table;
    state = run.state;
  }
  assert.ok(
    grown.every((count) => count >= 1),
    `growth advances every run: ${grown.join(",")}`,
  );
  assert.ok(
    facts.entries
      .filter((item) => enrolled.includes(item.port_id))
      .every((item) => item.observation.tag === "alphabet-1.0"),
  );
});

// ---------------------------------------------------------------------------
// Provenance and the facts table's own time (N3).

void test("table provenance is optional, checked when present and carried into the enrollment table", async () => {
  const provenance = {
    workflow_run_id: "123456789",
    source_commit: "a".repeat(40),
    cli_sha256: sha("cli"),
    inputs_sha256: sha("inputs"),
  };
  checkFactsProvenance(provenance);
  for (const bad of [
    { ...provenance, workflow_run_id: "0x1" },
    { ...provenance, source_commit: "abc" },
    { ...provenance, cli_sha256: "z".repeat(64) },
    { ...provenance, inputs_sha256: "z".repeat(64) },
    { ...provenance, extra: 1 },
    { workflow_run_id: "1", source_commit: "a".repeat(40), cli_sha256: sha("cli") },
    { workflow_run_id: "1", source_commit: "a".repeat(40) },
  ])
    assert.throws(() => checkFactsProvenance(bad), /provenance/u);
  const local = table(entry());
  assert.equal(enrollmentTable(generateRegistrations([listing()], local)).facts_provenance, null);
  const unattended = { ...local, provenance };
  checkListingFactsTable(unattended);
  assert.deepEqual(
    enrollmentTable(generateRegistrations([listing()], unattended)).facts_provenance,
    provenance,
  );
  assert.throws(
    () => checkListingFactsTable({ ...local, provenance: { ...provenance, cli_sha256: "x" } }),
    /provenance/u,
  );
  const run = await deriveListingFacts({
    records: [listing()],
    observerReport: observerReport({ [unseen]: {} }),
    table: emptyFactsTable("2026-11-01T00:00:00.000Z"),
    inspect: inspector(),
    classify: coreClassifier,
    now: "2026-11-21T00:00:00.000Z",
    provenance,
  });
  assert.deepEqual(run.table.provenance, provenance);
});

void test("the facts table's time never moves backwards from the baseline's", async () => {
  const facts = table(entry());
  const generation = generateRegistrations([listing()], facts);
  gateGeneration(null, generation, deltaBounds, { ...facts, generated_at: generatedAt });
  assert.throws(
    () =>
      gateGeneration(null, generation, deltaBounds, {
        ...facts,
        generated_at: "2026-11-25T00:00:00.000Z",
      }),
    /before the baseline/u,
  );
  assert.throws(
    () => gateGeneration(null, generation, deltaBounds, { generated_at: "never" }),
    /no generation time/u,
  );
  await assert.rejects(
    derive(
      [listing()],
      observerReport({ [unseen]: {} }),
      emptyFactsTable("2026-11-25T00:00:00.000Z"),
      {
        now: "2026-11-21T00:00:00.000Z",
      },
    ),
    /before the facts table's generation time/u,
  );
});

// ---------------------------------------------------------------------------
// Listing-only tool veto with real worker output (N4).

const samplePath = join(root, "scripts/fixtures/listing-package-facts-sample.json");
const sampleIds = {
  windows: "zz-sample-a-windows",
  patcherOnly: "zz-sample-b-patcher-only",
  patcherArchive: "zz-sample-c-patcher-archive",
  several: "zz-sample-d-several",
  recomp: "zz-sample-e-recomp",
  linux: "zz-sample-f-linux",
  mac: "zz-sample-g-mac",
} as const;
async function sampleRun() {
  const release = (name: string): ObservationSpec => ({
    releases: [{ id: 8, tag: "v1.0", assets: [{ id: 21, name }] }],
  });
  const contents: Record<string, Record<string, PlayerFact[]>> = {
    [sampleIds.windows]: {
      [windowsZip]: [
        player("Game/Game.exe"),
        player("Game/Patcher.exe"),
        player("Game/UnityCrashHandler64.exe"),
      ],
    },
    [sampleIds.patcherOnly]: { "Patcher-v1.0-windows-x64.zip": [player("Patcher.exe")] },
    [sampleIds.patcherArchive]: { "Patcher-v1.0-windows-x64.zip": [player("Game.exe")] },
    [sampleIds.several]: { [windowsZip]: [player("Game.exe"), player("Launcher.exe")] },
    [sampleIds.recomp]: {
      "MarioKart64Recomp-v1.0-windows-x64.zip": [player("Zelda64Recompiled.exe")],
    },
    [sampleIds.linux]: { [linuxTar]: [player("Game/Game.x86_64", "elf64-x86-64")] },
    [sampleIds.mac]: {
      [macZip]: [player("Unseen.app/Contents/MacOS/Unseen", "macho-universal-arm64+x86-64")],
    },
  };
  const records = Object.values(sampleIds).map((id) => listing(id));
  const result = await derive(
    records,
    observerReport({
      [sampleIds.windows]: release(windowsZip),
      [sampleIds.patcherOnly]: release("Patcher-v1.0-windows-x64.zip"),
      [sampleIds.patcherArchive]: release("Patcher-v1.0-windows-x64.zip"),
      [sampleIds.several]: release(windowsZip),
      [sampleIds.recomp]: release("MarioKart64Recomp-v1.0-windows-x64.zip"),
      [sampleIds.linux]: release(linuxTar),
      [sampleIds.mac]: release(macZip),
    }),
    undefined,
    {
      inspect: async (asset) => {
        const id = asset.url.split("/")[4]!;
        return contents[id]![asset.name]!;
      },
    },
  );
  return { records, result };
}

void test("the listing-only tool veto excludes tool programs and archives, and reports every exclusion", async () => {
  const { records, result } = await sampleRun();
  const generation = generateRegistrations(records, result.table);
  const decisions = new Map(generation.decisions.map((decision) => [decision.port_id, decision]));
  const reason = (id: string) => reasonOf(decisions.get(id)!);
  assert.equal(reason(sampleIds.windows), "fit");
  assert.equal(reason(sampleIds.patcherOnly), "tool-not-game");
  assert.equal(reason(sampleIds.patcherArchive), "tool-not-game");
  assert.match(
    (decisions.get(sampleIds.patcherArchive) as { detail: string }).detail,
    /asset-tool-name patcher \(Patcher-v1\.0-windows-x64\.zip\)/u,
  );
  // Game.exe beside Launcher.exe: two programs cannot be told from two titles.
  assert.equal(reason(sampleIds.several), "ambiguous-player");
  assert.equal(reason(sampleIds.recomp), "fit", "a ...Recomp game port is not a tool");
  assert.equal(reason(sampleIds.linux), "fit");
  assert.equal(reason(sampleIds.mac), "fit");
  const guide = (id: string) =>
    generation.records.find((record) => record.listing.id === id)!.listing.manual_setup as Guide;
  assert.match(guide(sampleIds.windows).steps[2]!.instruction, /^Select Game\.exe in/u);
  assert.doesNotMatch(JSON.stringify(guide(sampleIds.windows)), /Patcher|CrashHandler/u);
  assert.equal(
    generation.records.find((record) => record.listing.id === sampleIds.several)!.integration,
    undefined,
  );
  const windows = generation.enrollments.find((row) => row.port_id === sampleIds.windows)!;
  assert.deepEqual(
    windows.runtimes[0]!.players.map((item) => item.display_path),
    ["Game/Game.exe"],
  );
  const groups = failSafeExclusions(generation).map((group) => ({
    key: `${group.reason}:${group.token}`,
    count: group.count,
    examples: group.examples.map(
      (example) => `${example.port_id}=${example.outcome}:${example.name}`,
    ),
  }));
  assert.deepEqual(groups, [
    {
      key: "asset-tool-name:patcher",
      count: 2,
      examples: [
        `${sampleIds.patcherOnly}=tool-not-game:Patcher-v1.0-windows-x64.zip`,
        `${sampleIds.patcherArchive}=tool-not-game:Patcher-v1.0-windows-x64.zip`,
      ],
    },
    {
      key: "player-tool-name:patcher",
      count: 2,
      examples: [
        `${sampleIds.windows}=enrolled:Patcher.exe`,
        `${sampleIds.patcherOnly}=tool-not-game:Patcher.exe`,
      ],
    },
    {
      key: "ambiguous-player:several-programs",
      count: 1,
      examples: [`${sampleIds.several}=ambiguous-player:Game.exe + Launcher.exe`],
    },
    {
      key: "player-tool-name:crashhandler",
      count: 1,
      examples: [`${sampleIds.windows}=enrolled:UnityCrashHandler64.exe`],
    },
  ]);
  const committed = enrollmentTable(generation);
  assert.deepEqual(committed.blocked_exclusions, failSafeExclusions(generation));
  // The gate refuses an enrollment that names an excluded player.
  const forged = structuredClone(generation);
  const runtime = forged.enrollments.find((row) => row.port_id === sampleIds.windows)!.runtimes[0]!;
  const excluded = result.table.entries.find((item) => item.port_id === sampleIds.windows)!
    .artifacts[0]!.excluded_players[0]!;
  runtime.players.push({
    path: excluded.path,
    display_path: excluded.display_path,
    machine: excluded.machine,
    sha256: excluded.sha256,
  });
  assert.throws(() => gateGeneration(null, forged), /tool veto excluded/u);
});

void test("the worker's sample output is pinned for Core's forged-fact guard", async () => {
  const { result } = await sampleRun();
  const text = `${JSON.stringify(result.table, null, 2)}\n`;
  if (process.env.UPDATE_LISTING_FACTS_SAMPLE === "1") writeFileSync(samplePath, text);
  // portcove-core re-runs its own rules on every fact of this file
  // (`worker_sample_facts_equal_what_core_computes_and_forgeries_do_not`).
  assert.equal(readFileSync(samplePath, "utf8"), text);
});

// ---------------------------------------------------------------------------
// Platform-true hosts (F1): a player's own machine names its system.

const neutralZip = "Game-v1.0.zip";

void test("non-desktop and unknown-platform players never enroll, whatever the archive is called", () => {
  for (const [machine, reason] of [
    // An iOS application in a neutral archive (`Payload/X.app/X`).
    ["macho-ios-arm64", "non-desktop-platform"],
    ["macho-ios-universal-arm64+x86-64", "non-desktop-platform"],
    ["macho-tvos-arm64", "non-desktop-platform"],
    ["elf64-android-arm64", "non-desktop-platform"],
    ["elf64-android-x86-64", "non-desktop-platform"],
    ["elf64-freebsd-x86-64", "non-desktop-platform"],
    ["pe-xbox-x86-64", "non-desktop-platform"],
    ["elf64-unknown-x86-64", "unknown-platform"],
    ["macho-unplatformed-arm64", "unknown-platform"],
    ["macho-unknown-universal-arm64+x86-64", "unknown-platform"],
    ["pe-unknown-x86-64", "unknown-platform"],
  ] as const) {
    const fact = artifact(neutralZip, [player("Payload/Game.app/Game", machine)]);
    assert.equal(fact.contradictory, false, machine);
    const decision = decide(listing(), entry([fact]));
    assert.equal(reasonOf(decision), reason, machine);
    for (const platform of ["windows-x86-64", "linux-x86-64", "macos-x86-64", "macos-aarch64"])
      assert.equal(machineRunsOn(machine, platform), false, `${machine} on ${platform}`);
  }
  // The same layouts with desktop machines still enroll.
  assert.deepEqual(
    (
      decide(
        listing(),
        entry([artifact(neutralZip, [player("Game.app/Contents/MacOS/Game", "macho-arm64")])]),
      ) as { enrollment: { platforms: string[] } }
    ).enrollment.platforms,
    ["macos-aarch64"],
  );
  assert.equal(machineSystem("elf64-x86-64").platformClass, "desktop");
  assert.equal(machineSystem("elf64-android-arm64").os, "android");
  assert.equal(machineSystem("macho-ios-arm64").os, "ios");
  assert.equal(machineSystem("macho-unplatformed-arm64").platformClass, "unknown");
});

void test("system tokens in an archive name veto it as non-desktop; titles that merely contain one do not", () => {
  const linux = [player("Game/Game.x86_64", "elf64-x86-64")];
  for (const name of [
    "Game-v1.0-freebsd-x86_64.tar.gz",
    "Game-v1.0-iphone.zip",
    "Game-v1.0-android-tv.zip",
    "Game-v1.0-ps4.zip",
  ]) {
    const fact = artifact(name, linux);
    assert.equal(fact.contradictory, true, name);
    assert.equal(reasonOf(decide(listing(), entry([fact]))), "non-desktop-platform", name);
  }
  for (const name of ["HaikuQuest-v1.0-windows-x64.zip", "Switchblade-v1.0-windows-x64.zip"])
    assert.equal(decide(listing(), entry([artifact(name, [player("Game.exe")])])).fit, true, name);
});

void test("the gate refuses an enrollment resting on a non-desktop machine even when the fit rule is bypassed", () => {
  const generation = generateRegistrations([listing()], table(entry()));
  const forged = structuredClone(generation);
  const facts = forged.facts.entries[0]!;
  facts.artifacts[0]!.players[0]!.machine = "pe-xbox-x86-64";
  forged.enrollments[0]!.runtimes[0]!.players[0]!.machine = "pe-xbox-x86-64";
  forged.enrollments[0]!.facts_sha256 = digestOf(facts);
  assert.throws(() => gateGeneration(null, forged), /has no matching player/u);
});

void test("release forms the worker does not read are recorded, and decide the reason when nothing else is there", async () => {
  const spec = (names: string[]): ObservationSpec => ({
    releases: [
      { id: 8, tag: "v1.0", assets: names.map((name, index) => ({ id: 21 + index, name })) },
    ],
  });
  const ids = {
    desktop: "zz-forms-a-desktop",
    mobile: "zz-forms-b-mobile",
    mixed: "zz-forms-c-mixed",
    none: "zz-forms-d-none",
  };
  const records = Object.values(ids).map((id) => listing(id));
  const result = await derive(
    records,
    observerReport({
      [ids.desktop]: spec(["Game-v1.0-win64.7z", "Game-v1.0.rar", "Game.exe", "Game.AppImage"]),
      [ids.mobile]: spec(["Game.ipa", "Game.apk", "Game.vpk", "Game.nro"]),
      [ids.mixed]: spec([windowsZip, "Game.dmg", "Game.apk", "Game.msi"]),
      [ids.none]: spec(["README.md"]),
    }),
  );
  const entryOf = (id: string) => result.table.entries.find((item) => item.port_id === id)!;
  assert.equal(entryOf(ids.desktop).ineligible!.reason, "unsupported-archive-format");
  assert.deepEqual(entryOf(ids.desktop).unread_forms, [".7z", ".appimage", ".exe", ".rar"]);
  assert.match(entryOf(ids.desktop).ineligible!.detail, /\.7z, \.appimage, \.exe, \.rar/u);
  assert.equal(entryOf(ids.mobile).ineligible!.reason, "non-desktop-platform");
  assert.deepEqual(entryOf(ids.mobile).unread_forms, [".apk", ".ipa", ".nro", ".vpk"]);
  assert.equal(entryOf(ids.mixed).ineligible, null);
  assert.deepEqual(entryOf(ids.mixed).unread_forms, [".apk", ".dmg", ".msi"]);
  assert.equal(entryOf(ids.none).ineligible!.reason, "no-release-archive");
  const generation = generateRegistrations(records, result.table);
  assert.deepEqual(
    generation.enrollments.map((row) => row.port_id),
    [ids.mixed],
  );
  const queues = registrationQueues(generation);
  assert.deepEqual(queues.reasons["unsupported-archive-format"], [ids.desktop]);
  assert.deepEqual(queues.reasons["non-desktop-platform"], [ids.mobile]);
  assert.deepEqual(queues.reasons["no-release-archive"], [ids.none]);
  assert.deepEqual(queues.unread_forms[".apk"], [ids.mobile, ids.mixed]);
  assert.deepEqual(queues.unread_forms[".7z"], [ids.desktop]);
});

// ---------------------------------------------------------------------------
// Multi-title archives (F2): one program per platform.

void test("two distinct programs on a platform are ambiguous; builds of one program are not", () => {
  const exe = (path: string, machine = "pe-x86-64") => player(path, machine);
  const cases: [PlayerFact[], string][] = [
    // Two titles of one engine in one directory.
    [[exe("OpenJK/openjk.x86_64.exe"), exe("OpenJK/openjo.x86_64.exe")], "ambiguous-player"],
    [[exe("openjk.x86_64.exe"), exe("openjo.x86_64.exe")], "ambiguous-player"],
    // A launcher beside its game cannot be told from a second title.
    [[exe("Game.exe"), exe("Launcher.exe")], "ambiguous-player"],
    // One program under two top-level directories.
    [[exe("A/Game.exe"), exe("B/Game.exe")], "ambiguous-player"],
    // Architecture, console and debug builds of one program.
    [[exe("openjk.x86_64.exe"), exe("openjk.x86.exe", "pe-x86")], "fit"],
    [[exe("Game/Game.exe"), exe("Game/Game-64.exe"), exe("Game/Game.console.exe")], "fit"],
    [[exe("Game/Game.x64.exe"), exe("Game/Game_win64.exe"), exe("Game/Game.debug.exe")], "fit"],
    // A number glued to the name is part of the name (H2): Doom 64 is not
    // Doom, and `Game64.exe` cannot be told from such a title by name alone.
    [[exe("Doom.exe"), exe("Doom64.exe")], "ambiguous-player"],
    [[exe("Game/Game.exe"), exe("Game/Game64.exe")], "ambiguous-player"],
    [[exe("Quake.exe"), exe("Quake32.exe")], "ambiguous-player"],
    // A tool beside the game is vetoed by name, not counted.
    [[exe("Game.exe"), exe("Patcher.exe")], "fit"],
  ];
  for (const [players, reason] of cases)
    assert.equal(
      reasonOf(decide(listing(), entry([artifact(windowsZip, players)]))),
      reason,
      players.map((item) => item.display_path).join(" + "),
    );
  // Ambiguous sets are grouped beside the name vetoes, by kind.
  const pair = generateRegistrations(
    [listing()],
    table(entry([artifact(windowsZip, [exe("openjk.x86_64.exe"), exe("openjo.x86_64.exe")])])),
  );
  assert.deepEqual(
    enrollmentTable(pair).blocked_exclusions.map((group) => [
      `${group.reason}:${group.token}`,
      group.examples.map((example) => `${example.outcome}:${example.name}`),
    ]),
    [
      [
        "ambiguous-player:several-programs",
        ["ambiguous-player:openjk.x86_64.exe + openjo.x86_64.exe"],
      ],
    ],
  );
  const split = generateRegistrations(
    [listing()],
    table(entry([artifact(windowsZip, [exe("A/Game.exe"), exe("B/Game.exe")])])),
  );
  assert.deepEqual(registrationQueues(split).exclusions, {
    "ambiguous-player:several-directories": [unseen],
  });
  // Distinct programs in two archives for the same platform are ambiguous too.
  const two = entry([
    artifact(windowsZip, [exe("Game.exe")], 11),
    artifact(neutralZip, [exe("Other.exe")], 12),
  ]);
  assert.equal(reasonOf(decide(listing(), two)), "ambiguous-player");
  // One program on Windows and another on Linux: each platform has one.
  const combined = entry([artifact(neutralZip, [exe("Game.exe"), player("Game", "elf64-x86-64")])]);
  assert.deepEqual(
    (decide(listing(), combined) as { enrollment: { platforms: string[] } }).enrollment.platforms,
    ["windows-x86-64", "linux-x86-64"],
  );
});

void test("the gate independently refuses several programs, a trimmed player list and split directories", () => {
  const generation = generateRegistrations([listing()], table(entry()));
  const withFacts = (change: (fact: ArtifactFactV2) => void) => {
    const forged = structuredClone(generation);
    const facts = forged.facts.entries[0]!;
    change(facts.artifacts[0]!);
    forged.enrollments[0]!.facts_sha256 = digestOf(facts);
    return forged;
  };
  const second = player("Unseen/Other.exe");
  assert.throws(
    () =>
      gateGeneration(
        null,
        withFacts((fact) => fact.players.push(second)),
      ),
    /does not name every player[\s\S]*2 distinct programs/u,
  );
  const sameName = player("Elsewhere/Unseen.exe", "pe-x86-64", "elsewhere");
  const directories = withFacts((fact) => fact.players.push(sameName));
  directories.enrollments[0]!.runtimes[0]!.players.push(sameName);
  assert.throws(() => gateGeneration(null, directories), /several top-level directories/u);
});

// ---------------------------------------------------------------------------
// Per-player hosts (F4): helpers and combined archives.

void test("a 32-bit helper and a combined Windows and Linux archive no longer block their real platforms", () => {
  const helper = entry([
    artifact(windowsZip, [player("Game/Game.exe"), player("Game/Helper.exe", "pe-x86")]),
  ]);
  const decision = decide(listing(), helper);
  assert.ok(decision.fit);
  assert.deepEqual(
    decision.enrollment.runtimes[0]!.players.map((item) => item.display_path),
    ["Game/Game.exe"],
  );
  for (const name of [neutralZip, "Game-v1.0-x64.zip"]) {
    const combined = entry([
      artifact(name, [player("Game/Game.exe"), player("Game/Game.x86_64", "elf64-x86-64")]),
    ]);
    const fitted = decide(listing(), combined);
    assert.ok(fitted.fit, name);
    assert.deepEqual(fitted.enrollment.platforms, ["windows-x86-64", "linux-x86-64"]);
    assert.deepEqual(
      fitted.enrollment.runtimes.map((runtime) => runtime.players[0]!.machine),
      ["pe-x86-64", "elf64-x86-64"],
    );
    gateGeneration(null, generateRegistrations([listing()], table(combined)));
  }
  // A name that says Windows still vetoes Linux for the same combined archive.
  const named = decide(
    listing(),
    entry([
      artifact(windowsZip, [player("Game/Game.exe"), player("Game/Game.x86_64", "elf64-x86-64")]),
    ]),
  );
  assert.ok(named.fit);
  assert.deepEqual(named.enrollment.platforms, ["windows-x86-64"]);
});

void test("no generated enrollment names a platform its artifact has no running player for", () => {
  const random = seeded(8569);
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const machines = [
    "pe-x86-64",
    "pe-x86",
    "pe-arm64",
    "pe-xbox-x86-64",
    "elf64-x86-64",
    "elf64-arm64",
    "elf32-x86",
    "elf64-android-x86-64",
    "elf64-freebsd-x86-64",
    "elf64-unknown-x86-64",
    "macho-x86-64",
    "macho-arm64",
    "macho-universal-arm64+x86-64",
    "macho-ios-arm64",
    "macho-unplatformed-arm64",
  ];
  const names = [
    windowsZip,
    linuxTar,
    macZip,
    neutralZip,
    "Game-v1.0-x64.zip",
    "Game-win32.zip",
    "Game-v1.0-macos-arm64.zip",
    "Game-v1.0-freebsd-x86_64.tar.gz",
  ];
  const programs = [
    "Game/Game.exe",
    "Game/Game.x86_64",
    "Game/Game64.exe",
    "Game/Other.exe",
    "Game",
  ];
  let enrolled = 0;
  for (let round = 0; round < 400; round++) {
    const artifacts = Array.from({ length: 1 + Math.floor(random() * 2) }, (_, index) =>
      artifact(
        pick(names),
        [
          ...new Set(Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(programs))),
        ].map((path) => player(path, pick(machines))),
        11 + index,
      ),
    );
    const facts = entry(artifacts);
    const decision = decide(listing(), facts);
    if (!decision.fit) continue;
    enrolled++;
    for (const runtime of decision.enrollment.runtimes) {
      const source = facts.artifacts.find((item) => item.asset_id === runtime.asset_id)!;
      assert.equal(source.contradictory, false);
      assert.ok(runtime.players.length > 0);
      for (const item of runtime.players) {
        assert.ok(
          machineRunsOn(item.machine, runtime.platform),
          `${item.machine} ${runtime.platform}`,
        );
        assert.ok(source.players.some((candidate) => candidate.path === item.path));
      }
    }
    gateGeneration(null, generateRegistrations([listing()], table(facts)));
  }
  assert.ok(enrolled > 20, `only ${enrolled} rounds enrolled`);
});

// ---------------------------------------------------------------------------
// Determinism (F5) and honest run output (F6).

void test("orders are by code point, never by locale", () => {
  const values = ["b", "B", "a", "é", "\u{1F600}", "\uFFFF", "Z", "aa", ""];
  assert.deepEqual(values.toSorted(compareCodePoints), [
    "",
    "B",
    "Z",
    "a",
    "aa",
    "b",
    "é",
    "\uFFFF",
    "\u{1F600}",
  ]);
  for (const file of [
    "scripts/listing-package-facts.mts",
    "scripts/catalog-generated-registration.mts",
  ])
    assert.doesNotMatch(readFileSync(join(root, file), "utf8"), /\.localeCompare\(/u, file);
});

void test("a run that settles nothing while work waits reports no progress", async () => {
  const records = [listing("zz-stall-a"), listing("zz-stall-b")];
  const result = await derive(
    records,
    observerReport({ "zz-stall-a": {}, "zz-stall-b": {} }),
    undefined,
    {
      inspect: inspector({ [windowsZip]: new InspectionError("Download failed.", false) }),
      budget: { maxIdentities: 1 },
    },
  );
  assert.equal(result.settled, 0);
  assert.equal(result.backlog.new_pending, 1);
  assert.equal(result.no_progress, true);
  const moving = await derive(records, observerReport({ "zz-stall-a": {}, "zz-stall-b": {} }));
  assert.equal(moving.settled, 2);
  assert.equal(moving.no_progress, false);
});

void test("a malformed release record makes the identity invalid instead of choosing another release", async () => {
  const id = "zz-malformed";
  const report = observerReport({ [id]: {} });
  const update = (
    report.listings[0]!.listing_update as { upstream_observation: { releases: unknown[] } }
  ).upstream_observation;
  update.releases.unshift({ id: 99, version: 12, assets: [] });
  const result = await derive([listing(id)], report);
  assert.equal(outcome(result, id)!.reason, "invalid-facts");
  assert.match(result.table.entries[0]!.ineligible!.detail, /cannot read/u);
  assert.deepEqual(enrolledIds([listing(id)], result.table), []);
});

void test("the route fit report carries every exception queue with its identities", () => {
  const records = [listing("zz-queue-a"), listing("zz-queue-b"), listing("zz-queue-c")];
  const facts = table(
    entry([artifact(windowsZip, [player("A.exe"), player("B.exe")])], {}, "zz-queue-a"),
    entry([artifact(neutralZip, [player("Game", "elf64-android-x86-64")])], {}, "zz-queue-b"),
    entry(undefined, {}, "zz-queue-c"),
  );
  const assembled = assembleCatalogRecords(shared, records, facts);
  const report = routeFitReport({
    records: assembled.records,
    ports: assembled.catalog.ports,
    packageShapes: { entries: [] },
    routeEnrollment: { cases: [] },
    generatedRegistration: enrollmentTable(assembled.generation),
    generation: assembled.generation,
  });
  const queues = report.registration_queues!;
  assert.deepEqual(queues.reasons["ambiguous-player"], ["zz-queue-a"]);
  assert.deepEqual(queues.reasons["non-desktop-platform"], ["zz-queue-b"]);
  assert.deepEqual(Object.values(queues.reasons).flat().toSorted(), ["zz-queue-a", "zz-queue-b"]);
  assert.equal(enrollmentTable(assembled.generation).blocked["ambiguous-player"], 1);
});
