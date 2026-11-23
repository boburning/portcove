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
  archiveRoleToken,
  artifactExclusions,
  bundledToolchain,
  toolchainNames,
  channelOnlyTag,
  gateChannelOnlyTag,
  checkFactsProvenance,
  compareCodePoints,
  machineSystem,
  registrationQueues,
  checkListingFactsTable,
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
  fitContext,
  gateFormKind,
  identityShards,
  gateFormPlatforms,
  gateLine,
  gateLineNamesProduct,
  gateRoleWord,
  productNameWords,
  otherPackageForm,
  otherPackagePlatforms,
  listedRepositories,
  releaseLine,
  lineNamesProduct,
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
  OverBudgetError,
  otherPackagesOf,
  runCore,
  type ArchiveInspection,
  type ByteInspector,
  combineShards,
  type DeriveResult,
  type NameClassifier,
  type ObservedAsset,
  type WorkerState,
  workerRecords,
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
    observed_releases: [
      {
        release_id: fields.release_id ?? 7,
        tag: fields.tag ?? "v1.0",
        prerelease: false,
        published_at: fields.published_at ?? "2026-11-01T00:00:00.000Z",
        packaged: true,
      },
    ],
    other_packages: [],
    refused_archives: [],
    attempt: null,
    artifacts,
    ...extra,
    asset_names: extra.asset_names ?? (extra.other_packages ?? []).map((other) => other.name),
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
/** One record decided alone: no other identity names its repository. */
const decide = (record: AuthoredPort, facts?: ListingFactsEntry, at = generatedAt) =>
  fitDecision(record, facts, at, fitContext([record]));
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
/** A test inspector may answer with players only: the listing is then empty. */
type TestInspector = (
  asset: ObservedAsset,
  platform: string,
) => Promise<PlayerFact[] | ArchiveInspection>;
const listed =
  (inspect: TestInspector): ByteInspector =>
  async (asset, platform) => {
    const found = await inspect(asset, platform);
    return Array.isArray(found) ? { players: found, names: [], leaves: [] } : found;
  };
/** Players per asset name; an Error value throws it. */
function inspector(
  contents: Record<string, PlayerFact[] | ArchiveInspection | Error> = {},
  log: string[] = [],
): TestInspector {
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
    inspect?: TestInspector;
    now?: string;
    /** Plan only: settle what needs no bytes and leave the rest pending. */
    plan?: boolean;
  } = {},
): Promise<DeriveResult> {
  return await deriveListingFacts({
    records,
    observerReport: report,
    table: previous,
    ...(options.state ? { state: options.state } : {}),
    ...(options.plan ? { inspectBytes: false } : {}),
    inspect: listed(options.inspect ?? inspector()),
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

void test("the gate has no delta bound: a migration of 400 routes lands in one change (B1)", () => {
  // Replaces the former 64 added / 32 withdrawn / 64 changed bounds.
  const wave = fittingFacts(400);
  const generation = generateRegistrations(wave.records, wave.facts);
  assert.equal(gateGeneration(null, generation).added.length, 400);
  // Against a baseline holding them, one more is a delta of one.
  const fewer = fittingFacts(399);
  const baseline = enrollmentTable(generateRegistrations(fewer.records, fewer.facts));
  assert.equal(gateGeneration(baseline, generation).added.length, 1);
  // Every one may be withdrawn, or changed, in one change too: what holds a
  // mass withdrawal a bug causes is the batch job's withdrawal-held stop.
  assert.equal(
    gateGeneration(enrollmentTable(generation), generateRegistrations([], table())).withdrawn
      .length,
    400,
  );
  // The per-enrollment checks still refuse every unfit enrollment.
  const forged = structuredClone(generation);
  forged.enrollments[399]!.facts_sha256 = "0".repeat(64);
  assert.throws(() => gateGeneration(null, forged), /does not rest on the committed facts entry/u);
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

void test("the gate keeps each name-permitted artifact's players under one top-level directory (H3)", () => {
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
  // The loop skips a contradictory artifact, so such an artifact can never be
  // the enrolled one: the gate refuses a runtime that rests on it.
  const contradicted = structuredClone(generation);
  contradicted.facts.entries[0]!.artifacts[0]!.contradictory = true;
  contradicted.enrollments[0]!.facts_sha256 = digestOf(contradicted.facts.entries[0]);
  assert.throws(
    () => gateGeneration(null, contradicted),
    /contradicted, role-named or non-runtime artifact/u,
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

void test("every derived entry of a large wave lands in one run, with no batch bound (B3)", async () => {
  // Replaces the former successive bounded batches of 64.
  const ids = Array.from(
    { length: 150 },
    (_, index) => `zz-wave-${String(index).padStart(3, "0")}`,
  );
  const records = ids.map((id) => listing(id));
  const report = observerReport(Object.fromEntries(ids.map((id) => [id, {}])));
  const result = await derive(records, report);
  assert.deepEqual(enrolledIds(records, result.table), ids);
  assert.deepEqual(result.state.pending, []);
  assert.equal(result.settled, 150);
  assert.equal(result.no_progress, false);
  // The whole wave passes the gate against the empty table in one change.
  assert.equal(
    gateGeneration(null, generateRegistrations(records, result.table)).added.length,
    150,
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
    // The delta is measured against the base: all 65 are added.
    assert.equal(
      gateGeneration(local, generateRegistrations(sixtyFive.records, sixtyFive.facts)).added.length,
      65,
    );
    // So is any other generation's delta.
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

void test("every identity of a 60-identity fixture is attempted in one run (B3)", async () => {
  // Replaces the former bounded-runs sweep (12 identities and 1,500 bytes a run).
  const ids = Array.from(
    { length: 60 },
    (_, index) => `zz-sweep-${String(index).padStart(2, "0")}`,
  );
  const records = ids.map((id) => listing(id));
  const specs: Record<string, ObservationSpec> = {};
  for (const [index, id] of ids.entries()) {
    // 25 identities publish no provider digest; one carries large archives;
    // three fail transiently every time.
    const sha256 = index % 12 < 5 ? null : undefined;
    const size = index === 5 ? 2 * 1024 ** 3 - 1 : 100;
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
  const inspect: TestInspector = async (asset) => {
    const id = /fixture-owner\/([^/]+)\//u.exec(asset.url)![1]!;
    if (flaky.has(id)) throw new Error("network reset");
    return asset.name === linuxTar ? [player("Game", "elf64-x86-64")] : [player("Game.exe")];
  };
  const result = await derive(records, report, emptyFactsTable("2026-11-20T00:00:00.000Z"), {
    inspect,
  });
  const attempted = new Set(result.report.map((row) => row.port_id));
  assert.equal(attempted.size, 60);
  assert.deepEqual(result.state.pending, []);
  assert.deepEqual(
    result.state.retry.map((item) => item.port_id),
    ids.slice(55, 58),
  );
  const generation = generateRegistrations(records, result.table);
  const blocked = enrollmentTable(generation).blocked;
  assert.equal(blocked["no-digest"], 25);
  // The large archives are read like any other (no size bound).
  assert.ok(generation.enrollments.some((row) => row.port_id === ids[5]));
  assert.equal(generation.enrollments.length, 32);
});

void test("a large archive is read, never completed for its size (B4)", async () => {
  // Replaces the former `too-large` (512 MiB) and `exceeds-run-budget` (2 GiB) reasons.
  const id = "zz-cost-a";
  const report = observerReport({
    [id]: {
      releases: [
        {
          id: 8,
          tag: "v1.0",
          assets: [
            { id: 21, name: windowsZip, size: 1900 * 1024 ** 2 },
            { id: 22, name: linuxTar, size: 1900 * 1024 ** 2 },
          ],
        },
      ],
    },
  });
  const log: string[] = [];
  const first = await derive([listing(id)], report, undefined, {
    inspect: inspector({ [linuxTar]: [player("Game", "elf64-x86-64")] }, log),
  });
  assert.equal(outcome(first, id)!.outcome, "complete");
  assert.deepEqual(log, [windowsZip, linuxTar]);
  log.length = 0;
  const second = await derive([listing(id)], report, first.table, {
    state: first.state,
    inspect: inspector({}, log),
    now: "2026-11-22T00:00:00.000Z",
  });
  assert.deepEqual(log, [], "an unchanged release is not read again");
  assert.equal(outcome(second, id)!.outcome, "unchanged");
});

void test("transient failures retry every run until the retention bound; permanent refusals complete", async () => {
  const ids = ["zz-retry-a", "zz-retry-b", "zz-retry-c"];
  const records = ids.map((id) => listing(id));
  const report = observerReport(Object.fromEntries(ids.map((id) => [id, {}])));
  let calls = 0;
  const inspect: TestInspector = async (asset) => {
    calls++;
    if (asset.url.includes("zz-retry-a"))
      throw new InspectionError("Download failed.", false, "core-unknown", "network");
    if (asset.url.includes("zz-retry-b"))
      throw new InspectionError("Core refused the archive during inspection.", true);
    return [player("Game.exe")];
  };
  const first = await derive(records, report, undefined, { inspect });
  assert.deepEqual(
    first.state.retry.map((item) => item.port_id),
    ["zz-retry-a"],
  );
  // A permanent refusal is scoped to its archive (D5): the identity completes,
  // records the refusal class, and blocks as core-refused when nothing else fits.
  assert.equal(outcome(first, "zz-retry-b")!.outcome, "complete");
  const refusedEntry = first.table.entries.find((item) => item.port_id === "zz-retry-b")!;
  assert.deepEqual(
    refusedEntry.refused_archives.map((archive) => archive.refusal),
    ["core-unknown"],
  );
  assert.equal(reasonOf(decide(records[1]!, refusedEntry)), "core-refused");
  assert.equal(outcome(first, "zz-retry-c")!.outcome, "complete");
  const second = await derive(records, report, first.table, {
    state: first.state,
    inspect,
    now: "2026-11-22T00:00:00.000Z",
  });
  assert.equal(second.state.retry[0]!.failures, 2);
  // Within the last-good retention bound (14 days) a failure is retried,
  // however often it recurs; no attempt count settles it.
  const within = await derive(records, report, second.table, {
    state: second.state,
    inspect,
    now: "2026-12-05T00:00:00.000Z",
  });
  assert.equal(within.state.retry[0]!.failures, 3);
  assert.equal(
    within.table.entries.find((item) => item.port_id === "zz-retry-a"),
    undefined,
  );
  const third = await derive(records, report, within.table, {
    state: within.state,
    inspect,
    now: "2026-12-06T00:00:00.000Z",
  });
  assert.equal(outcome(third, "zz-retry-a")!.reason, "repeated-inspection-failure");
  assert.deepEqual(third.state.retry, []);
  // The typed cause is recorded and grouped for the queue (A5).
  const failed = third.table.entries.find((item) => item.port_id === "zz-retry-a")!;
  assert.equal(failed.ineligible!.cause, "network");
  assert.deepEqual(
    registrationQueues(generateRegistrations(records, third.table)).inspection_failures,
    { network: ["zz-retry-a"] },
  );
  // A cause outside the bounded classes, or on another reason, is refused.
  const forged = structuredClone(failed);
  forged.ineligible!.cause = "flaky" as never;
  assert.throws(() => checkListingFactsTable(table(forged)), /cause/u);
  const misplaced = structuredClone(refusedEntry);
  misplaced.artifacts = [];
  misplaced.observed_releases = [];
  misplaced.refused_archives = [];
  misplaced.ineligible = { reason: "no-digest", detail: "x", cause: "network" };
  assert.throws(() => checkListingFactsTable(table(misplaced)), /cause/u);
  calls = 0;
  await derive(records, report, third.table, {
    state: third.state,
    inspect,
    now: "2026-12-07T00:00:00.000Z",
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
  // The listing's name holds the line word, so `alphabet-1.0` names the product.
  const records = [listing(id, { name: "Alphabet" })];
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
  const inspect: TestInspector = async (asset) => {
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
  // Its release line is unknown, so it is never offered without a binding.
  assert.deepEqual(enrolledIds([listing("zz-tag")], tagged.table), []);
  assert.equal(
    reasonOf(decide(listing("zz-tag"), tagged.table.entries[0])),
    "ambiguous-release-line",
  );
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

void test("the worker lands every fact in one run and reuses unchanged archives (B3)", async () => {
  // Replaces the former "holds facts beyond one batch" test (64 per batch).
  const ids = Array.from(
    { length: 70 },
    (_, index) => `zz-batch-${String(index).padStart(2, "0")}`,
  );
  const records = ids.map((id) => listing(id));
  const report = observerReport(Object.fromEntries(ids.map((id) => [id, {}])));
  const log: string[] = [];
  const first = await derive(records, report, undefined, { inspect: inspector({}, log) });
  assert.equal(log.length, 70);
  assert.deepEqual(enrolledIds(records, first.table), ids);
  assert.deepEqual(first.backlog, { enrolled_pending: 0, new_pending: 0, bytes_pending: 0 });
  assert.equal(first.no_progress, false);
  log.length = 0;
  const second = await derive(records, report, first.table, {
    state: first.state,
    inspect: inspector({}, log),
    now: "2026-11-22T00:00:00.000Z",
  });
  assert.deepEqual(log, [], "landed facts are reused, not downloaded again");
  assert.deepEqual(enrolledIds(records, second.table), ids);
  gateGeneration(
    enrollmentTable(generateRegistrations(records, first.table)),
    generateRegistrations(records, second.table),
  );
});

void test("a deadline cuts a run cleanly; the cut identities lead the next run (B3)", async () => {
  const ids = Array.from({ length: 6 }, (_, index) => `zz-cut-${index}`);
  const records = ids.map((id) => listing(id));
  const report = observerReport(Object.fromEntries(ids.map((id) => [id, {}])));
  const log: string[] = [];
  let deadline = Number.POSITIVE_INFINITY;
  const inspect: TestInspector = async (asset) => {
    const id = /fixture-owner\/([^/]+)\//u.exec(asset.url)![1]!;
    log.push(id);
    // The third inspection runs past the deadline and is cut.
    if (log.length === 3) {
      deadline = 0;
      throw new OverBudgetError("The download reached the deadline.");
    }
    return [player("Game/Game.exe")];
  };
  const first = await deriveListingFacts({
    records,
    observerReport: report,
    table: emptyFactsTable("2026-11-01T00:00:00.000Z"),
    inspect: listed(inspect),
    classify: coreClassifier,
    now: "2026-11-21T00:00:00.000Z",
    get deadline() {
      return deadline;
    },
  });
  assert.deepEqual(log, ids.slice(0, 3));
  assert.deepEqual(enrolledIds(records, first.table), ids.slice(0, 2));
  assert.deepEqual(first.state.pending, ids.slice(2));
  assert.equal(first.backlog.new_pending, 4);
  assert.equal(outcome(first, ids[2]!)!.outcome, "deferred-deadline");
  assert.equal(first.no_progress, false);
  // The next run starts with the cut identities.
  log.length = 0;
  deadline = Number.POSITIVE_INFINITY;
  const second = await derive(records, report, first.table, {
    state: { ...first.state, pending: [ids[4]!, ids[2]!, ids[5]!, ids[3]!] },
    inspect: async (asset) => {
      log.push(/fixture-owner\/([^/]+)\//u.exec(asset.url)![1]!);
      return [player("Game/Game.exe")];
    },
    now: "2026-11-22T00:00:00.000Z",
  });
  assert.deepEqual(log, [ids[4], ids[2], ids[5], ids[3]]);
  assert.deepEqual(enrolledIds(records, second.table), ids);
  assert.deepEqual(second.state.pending, []);
});

void test("a sharded run plans, inspects each shard and combines to the unsharded result (B3)", async () => {
  const ids = Array.from({ length: 9 }, (_, index) => `zz-shard-${index}`);
  const records = ids.map((id) => listing(id));
  const report = observerReport(
    Object.fromEntries(
      ids.map((id, index) => [
        id,
        index === 0
          ? {
              releases: [
                { id: 8, tag: "v1.0", assets: [{ id: 21, name: windowsZip, sha256: null }] },
              ],
            }
          : {},
      ]),
    ),
  );
  const previous = emptyFactsTable("2026-11-01T00:00:00.000Z");
  const whole = await derive(records, report, previous);
  const plan = await deriveListingFacts({
    records,
    observerReport: report,
    table: previous,
    inspect: listed(async () => {
      throw new Error("a plan reads no bytes");
    }),
    classify: coreClassifier,
    now: "2026-11-21T00:00:00.000Z",
    inspectBytes: false,
  });
  // The plan settles what needs no bytes and lists every identity that does.
  assert.deepEqual(
    plan.needs.map((need) => need.port_id),
    ids.slice(1),
  );
  assert.equal(plan.no_progress, false);
  const shards = identityShards(plan.needs.map((need) => need.port_id));
  assert.equal(shards.length, 8);
  const results: { only: string[]; result: DeriveResult }[] = [];
  for (const only of shards)
    results.push({
      only,
      result: await deriveListingFacts({
        records,
        observerReport: report,
        table: plan.table,
        state: plan.state,
        inspect: listed(inspector()),
        classify: coreClassifier,
        now: "2026-11-21T00:00:00.000Z",
        only,
      }),
    });
  const combined = combineShards(plan, results);
  assert.deepEqual(combined.table, whole.table);
  assert.deepEqual(combined.state, whole.state);
  assert.equal(combined.settled, whole.settled);
  assert.deepEqual(combined.ineligible, whole.ineligible);
  assert.throws(() => combineShards(plan, [results[0]!, { ...results[0]! }]), /is in two shards/u);
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
    inspect: listed(async (asset) => {
      log.push(asset.url);
      return [player("Game/Game.exe")];
    }),
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
    inspect: listed(inspector()),
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
      inspect: listed(inspector()),
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
      inspect: listed(inspector()),
      classify: refusingLikeCore(anyNameClassifier, refusals),
      now: "2026-11-21T00:00:00.000Z",
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
      tag: "v1.0",
      published_at: "2026-11-15T00:00:00Z",
      assets: [{ id: 61, name: windowsZip, sha256: sha(`${id}-changed`) }],
    },
  ],
});
const dayAfter = (start: string, days: number) =>
  new Date(Date.parse(start) + days * 86_400_000).toISOString();

void test("enrolled identities whose release changed stay offered as pending-inspection, never as unavailable upstream", async () => {
  // A plan (or a shard cut by its deadline) leaves them pending; the next
  // full run drains all of them at once (formerly two per run over 21 runs).
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
    { now: start },
  );
  assert.deepEqual(enrolledIds(records, first.table), ids);
  const now = dayAfter(start, 1);
  const changed = observerReport(
    Object.fromEntries(ids.map((id) => [id, { ...changedRelease(id), observed_at: now }])),
  );
  const planned = await derive(records, changed, first.table, {
    state: first.state,
    now,
    plan: true,
  });
  assert.equal(planned.backlog.enrolled_pending, 41);
  assert.equal(planned.backlog.new_pending, 0);
  assert.equal(planned.needs.length, 41);
  assert.ok(planned.report.every((row) => row.reason === "pending-inspection"));
  assert.ok(
    planned.table.entries.every((item) => item.ineligible?.reason !== "observation-unavailable"),
    "the backlog is not an upstream failure",
  );
  assert.deepEqual(enrolledIds(records, planned.table), ids, "still offered");
  gateGeneration(
    enrollmentTable(generateRegistrations(records, first.table)),
    generateRegistrations(records, planned.table),
    first.table,
  );
  const drained = await derive(records, changed, planned.table, {
    state: planned.state,
    now: dayAfter(start, 2),
  });
  assert.equal(drained.backlog.enrolled_pending, 0);
  assert.ok(drained.table.entries.every((item) => item.observation.release_id === 9));
  assert.ok(drained.table.entries.every((item) => item.attempt === null));
});

void test("pending last-good facts withdraw only at the stale-facts age", async () => {
  const id = "zz-starved";
  const records = [listing(id)];
  const start = "2026-11-02T00:00:00.000Z";
  const first = await derive(records, observerReport({ [id]: { observed_at: start } }), undefined, {
    now: start,
  });
  let facts = first.table;
  let state: WorkerState | undefined = first.state;
  for (let day = 1; day <= 32; day++) {
    const now = dayAfter(start, day);
    // Every run's shard deadline cuts the identity before its inspection.
    const run = await derive(
      records,
      observerReport({ [id]: { ...changedRelease(id), observed_at: now } }),
      facts,
      { state, now, plan: true },
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
    inspect: listed(inspector()),
    classify: coreClassifier,
    now: "2026-11-21T00:00:00.000Z",
    provenance,
  });
  assert.deepEqual(run.table.provenance, provenance);
});

void test("the facts table's time never moves backwards from the baseline's", async () => {
  const facts = table(entry());
  const generation = generateRegistrations([listing()], facts);
  gateGeneration(null, generation, { ...facts, generated_at: generatedAt });
  assert.throws(
    () =>
      gateGeneration(null, generation, {
        ...facts,
        generated_at: "2026-11-25T00:00:00.000Z",
      }),
    /before the baseline/u,
  );
  assert.throws(
    () => gateGeneration(null, generation, { generated_at: "never" }),
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
  // The `.msi` beside the archive is a different Windows program than it holds.
  assert.deepEqual(generation.enrollments, []);
  const queues = registrationQueues(generation);
  assert.deepEqual(queues.reasons["other-package-form-beside-archive"], [ids.mixed]);
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

void test("a run whose deadline left work pending but that settled nothing reports no progress", async () => {
  const records = [listing("zz-stall-a"), listing("zz-stall-b")];
  const result = await deriveListingFacts({
    records,
    observerReport: observerReport({ "zz-stall-a": {}, "zz-stall-b": {} }),
    table: emptyFactsTable("2026-11-01T00:00:00.000Z"),
    inspect: listed(inspector()),
    classify: coreClassifier,
    now: "2026-11-21T00:00:00.000Z",
    deadline: 0,
  });
  assert.equal(result.settled, 0);
  assert.equal(result.backlog.new_pending, 2);
  assert.equal(result.no_progress, true);
  // Transient failures alone are retries, not a stalled run.
  const failing = await derive(
    records,
    observerReport({ "zz-stall-a": {}, "zz-stall-b": {} }),
    undefined,
    {
      inspect: inspector({ [windowsZip]: new InspectionError("Download failed.", false) }),
    },
  );
  assert.equal(failing.settled, 0);
  assert.equal(failing.no_progress, false);
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

void test("fit and gate read a listing's repository alike, and the report lists shared repositories (R5)", async () => {
  const repository = "fixture-owner/zz-shared-tree";
  const pair = ["zz-shared-main", "zz-shared-sub"];
  const releases = [releaseWith(1, "v1.0", "2026-10-01T00:00:00Z", [{ id: 11, name: windowsZip }])];
  const report = observerReport(
    Object.fromEntries(pair.map((id) => [id, { repository, releases }])),
  );
  // One listing names the repository through a path below it.
  const records = [
    listing(pair[0], { project_url: `https://github.com/${repository}` }),
    listing(pair[1], { project_url: `https://github.com/${repository}/tree/main/sub` }),
  ];
  assert.deepEqual(listedRepositories(records[1]!.listing), [repository]);
  const facts = await derive([records[0]!], report, undefined, {
    inspect: byAsset({ 11: [player("Game/Game.exe")] }),
  });
  // The fit rule sees the sharing identity, so it never offers the release
  // the gate would refuse: the generation passes the gate with nothing added.
  const generation = generateRegistrations(records, facts.table);
  assert.equal(reasonOf(generation.decisions[0]!), "shared-repository");
  assert.equal(gateGeneration(null, generation).added.length, 0);
  // The gate restates the permissive reading: forged past the fit rule, the
  // enrollment is refused.
  const alone = generateRegistrations([records[0]!], facts.table);
  assert.equal(alone.enrollments.length, 1);
  const forged = { ...structuredClone(alone), records: structuredClone(records) };
  assert.throws(() => gateGeneration(null, forged), /shares its repository/u);
  // The report lists the repository with its identities.
  assert.deepEqual(registrationQueues(generation).shared_repositories, {
    [repository]: [...pair],
  });
});

// ---------------------------------------------------------------------------
// #8569 real-data defects (D1-D6): fixtures rebuild the observed shapes; no
// game data is committed.

/** One worker run as `main()` runs it: records come from the assembled catalog source. */
async function sourceRun(
  authored: AuthoredPort[],
  report: unknown,
  facts: ListingFactsTable,
  options: Parameters<typeof derive>[3] = {},
) {
  const source = assembleCatalogRecords(shared, authored, facts);
  return await derive([...workerRecords(source)], report, facts, options);
}

void test("the worker keeps its own enrollments across runs and counts their withdrawals (D1)", async () => {
  const ids = Array.from({ length: 40 }, (_, index) => `zz-keep-${String(index).padStart(2, "0")}`);
  const authored = ids.map((id) => listing(id));
  const start = "2026-11-02T00:00:00.000Z";
  const report = (now: string, spec: (id: string) => ObservationSpec = () => ({})) =>
    observerReport(Object.fromEntries(ids.map((id) => [id, { ...spec(id), observed_at: now }])));
  let facts = (await sourceRun(authored, report(start), emptyFactsTable(start), { now: start }))
    .table;
  assert.deepEqual(enrolledIds(authored, facts), ids, "run 1 enrolls every identity");
  // The assembled catalog now carries the generated routes. Reading those
  // records (the defect) would make every enrolled identity look operational
  // and drop its facts.
  const assembled = assembleCatalogRecords(shared, authored, facts);
  assert.equal(assembled.generation.enrollments.length, ids.length);
  const dropped = await derive(assembled.records, report(dayAfter(start, 1)), facts, {
    now: dayAfter(start, 1),
  });
  assert.equal(dropped.table.entries.length, 0, "the defect this test guards against");
  let state: WorkerState | undefined;
  for (let run = 2; run <= 6; run++) {
    const now = dayAfter(start, run);
    const result = await sourceRun(authored, report(now), facts, { state, now });
    assert.deepEqual(enrolledIds(authored, result.table), ids, `run ${run} keeps run 1's routes`);
    assert.equal(result.table.entries.length, ids.length);
    gateGeneration(
      enrollmentTable(generateRegistrations(authored, facts)),
      generateRegistrations(authored, result.table),
      facts,
    );
    facts = result.table;
    state = result.state;
  }
  // Changed releases a plan leaves pending stay offered.
  const changed = await sourceRun(authored, report(dayAfter(start, 7), changedRelease), facts, {
    state,
    now: dayAfter(start, 7),
    plan: true,
  });
  assert.ok(changed.backlog.enrolled_pending > 0, "offered identities wait as enrolled_pending");
  assert.deepEqual(enrolledIds(authored, changed.table), ids, "still offered while pending");
  // A genuine withdrawal (no stable release any more) lands for every
  // identity in one run: there is no withdrawal bound.
  const prereleaseOnly = (id: string): ObservationSpec => ({
    releases: [
      {
        id: 9,
        tag: "v2.0-rc1",
        published_at: "2026-11-15T00:00:00Z",
        assets: [{ id: 61, name: windowsZip, sha256: sha(`${id}-rc`) }],
      },
    ],
  });
  const withdrawing = await sourceRun(authored, report(dayAfter(start, 8), prereleaseOnly), facts, {
    state,
    now: dayAfter(start, 8),
  });
  const delta = gateGeneration(
    enrollmentTable(generateRegistrations(authored, facts)),
    generateRegistrations(authored, withdrawing.table),
    facts,
  );
  assert.equal(delta.withdrawn.length, ids.length);
  assert.match(delta.withdrawn[0]!.reason, /^no-stable-release/u);
});

void test("workerRecords refuses a generated enrollment without an authored listing-only record", () => {
  const authored = [listing("zz-a")];
  assert.throws(
    () =>
      workerRecords({
        authored: [],
        generation: generateRegistrations(authored, table(entry(undefined, {}, "zz-a"))),
      }),
    /no authored listing-only GitHub record/u,
  );
});

/** A release spec with one Windows archive holding these players, by URL. */
const releaseWith = (
  id: number,
  tag: string,
  published: string,
  assets: { id: number; name: string }[],
  provider_prerelease = false,
): ReleaseSpec => ({
  id,
  tag,
  published_at: published,
  provider_prerelease,
  assets: assets.map((asset) => ({ ...asset, sha256: sha(`${tag}-${asset.id}`) })),
});
/** Players by asset id, read from the asset URL. */
const byAsset =
  (contents: Record<number, PlayerFact[] | Error>): TestInspector =>
  async (asset) => {
    const found = contents[asset.id];
    if (!found) return [player("Game/Game.exe")];
    if (found instanceof Error) throw found;
    return found;
  };

void test("a release is bound to its product's release line (D2a: a tool's release beside game betas)", async () => {
  const id = "zz-line-texture";
  const releases = [
    releaseWith(1, "v1.0", "2026-10-01T00:00:00Z", [{ id: 11, name: windowsZip }]),
    releaseWith(2, "texture-studio-v1.0.0", "2026-10-10T00:00:00Z", [{ id: 21, name: windowsZip }]),
    releaseWith(3, "v2.0.0-beta", "2026-10-20T00:00:00Z", [{ id: 31, name: windowsZip }]),
  ];
  const inspect = byAsset({
    11: [player("Game/Game.exe")],
    21: [player("TextureStudio.exe")],
    31: [player("Game/Game.exe")],
  });
  const unbound = await derive([listing(id)], observerReport({ [id]: { releases } }), undefined, {
    inspect,
  });
  const facts = unbound.table.entries[0]!;
  assert.equal(facts.observation.tag, "texture-studio-v1.0.0", "the latest stable is the tool's");
  assert.equal(reasonOf(decide(listing(id), facts)), "ambiguous-release-line");
  // The listing's own release URL binds the identity to the game's line.
  const bound = listing(id, {
    release_url: `https://github.com/fixture-owner/${id}/releases/tag/v1.0`,
  });
  const result = await derive([bound], observerReport({ [id]: { releases } }), undefined, {
    inspect,
  });
  const decision = decide(bound, result.table.entries[0]);
  assert.ok(decision.fit);
  assert.equal(decision.enrollment.release.tag, "v1.0");
  assert.equal(decision.enrollment.runtimes[0]!.players[0]!.display_path, "Game/Game.exe");
  // A stable release older than a newer prerelease on the main line, or on
  // a line naming the product, is never offered: here the listing binds the
  // tool's line, and the game's betas follow it.
  const toolBound = listing(id, {
    release_url: `https://github.com/fixture-owner/${id}/releases/tag/texture-studio-v1.0.0`,
  });
  const besideBetas = await derive([toolBound], observerReport({ [id]: { releases } }), undefined, {
    inspect,
  });
  assert.equal(besideBetas.table.entries[0]!.observation.tag, "texture-studio-v1.0.0");
  assert.equal(reasonOf(decide(toolBound, besideBetas.table.entries[0])), "ambiguous-release-line");
  // A newer prerelease on a line of other product words (a tool's beta)
  // does not decide the game's bound line (A4 ii).
  const tooOld = [
    releases[0]!,
    releaseWith(4, "texture-studio-v2.0-beta", "2026-10-25T00:00:00Z", [
      { id: 41, name: windowsZip },
    ]),
  ];
  const older = await derive([bound], observerReport({ [id]: { releases: tooOld } }), undefined, {
    inspect,
  });
  assert.equal(reasonOf(decide(bound, older.table.entries[0])), "fit");
  // The gate refuses the unbound tool release independently of the fit rule.
  const generation = generateRegistrations([bound], result.table);
  assert.equal(gateGeneration(null, generation).added.length, 1);
  const forged = structuredClone(generation);
  forged.records = [listing(id)];
  assert.throws(() => gateGeneration(null, forged), /release line is ambiguous/u);
  const prerelease = structuredClone(generation);
  const entryCopy = prerelease.facts.entries[0]!;
  entryCopy.observed_releases.push({
    release_id: 99,
    tag: "v3.0-beta",
    prerelease: true,
    published_at: "2026-10-25T00:00:00.000Z",
    packaged: true,
  });
  prerelease.enrollments[0]!.facts_sha256 = digestOf(entryCopy);
  // Bound to the main line, a newer main-line beta is the same line: accepted.
  assert.equal(gateGeneration(null, prerelease).added.length, 1);
  const toolGeneration = generateRegistrations([toolBound], besideBetas.table);
  assert.equal(toolGeneration.enrollments.length, 0);
  const forcedTool = structuredClone(generation);
  forcedTool.records = [toolBound];
  forcedTool.facts = besideBetas.table;
  forcedTool.enrollments = [
    {
      ...generation.enrollments[0]!,
      facts_sha256: digestOf(besideBetas.table.entries[0]),
      release: {
        id: 2,
        tag: "texture-studio-v1.0.0",
        observed_at: besideBetas.table.entries[0]!.observation.observed_at,
      },
      runtimes: [
        {
          ...generation.enrollments[0]!.runtimes[0]!,
          asset_id: 21,
          asset_name: windowsZip,
          archive_sha256: besideBetas.table.entries[0]!.artifacts[0]!.sha256,
          players: besideBetas.table.entries[0]!.artifacts[0]!.players,
        },
      ],
    },
  ];
  assert.throws(
    () => gateGeneration(null, forcedTool),
    /older than a prerelease of the main or a product-naming line/u,
  );
});

void test("identities sharing a repository enroll only on lines of their own (D2b)", async () => {
  const repository = "fixture-owner/zz-spider-pair";
  const pair = ["zz-spider-one", "zz-spider-two"];
  const releases = [
    releaseWith(1, "sm1-v1.0", "2026-10-01T00:00:00Z", [{ id: 11, name: windowsZip }]),
    releaseWith(2, "sm2-v1.1", "2026-10-10T00:00:00Z", [{ id: 21, name: windowsZip }]),
  ];
  const inspect = byAsset({ 11: [player("SpiderMan.exe")], 21: [player("SpiderMan2.exe")] });
  const report = observerReport(
    Object.fromEntries(pair.map((id) => [id, { repository, releases }])),
  );
  const unbound = pair.map((id) =>
    listing(id, { project_url: `https://github.com/${repository}` }),
  );
  const first = await derive(unbound, report, undefined, { inspect });
  const generation = generateRegistrations(unbound, first.table);
  assert.deepEqual(generation.enrollments, []);
  assert.deepEqual(
    generation.decisions.map(reasonOf),
    ["shared-repository", "shared-repository"],
    "the first title never gets the second title's newest release",
  );
  // Each listing names its own line through its release URL.
  const bound = [
    listing(pair[0], { release_url: `https://github.com/${repository}/releases/tag/sm1-v1.0` }),
    listing(pair[1], { release_url: `https://github.com/${repository}/releases/tag/sm2-v1.1` }),
  ];
  const second = await derive(bound, report, undefined, { inspect });
  const enrolled = generateRegistrations(bound, second.table);
  assert.deepEqual(
    enrolled.enrollments.map((row) => [
      row.port_id,
      row.release.tag,
      row.runtimes[0]!.players[0]!.path,
    ]),
    [
      ["zz-spider-one", "sm1-v1.0", "spiderman.exe"],
      ["zz-spider-two", "sm2-v1.1", "spiderman2.exe"],
    ],
  );
  assert.equal(gateGeneration(null, enrolled).added.length, 2);
  // Two identities bound to the same line still share it.
  const same = bound.map((record) =>
    listing(record.listing.id, {
      release_url: `https://github.com/${repository}/releases/tag/sm1-v1.0`,
    }),
  );
  assert.deepEqual(generateRegistrations(same, second.table).decisions.map(reasonOf), [
    "shared-repository",
    "shared-repository",
  ]);
  // The gate restates the shared-repository rule from the listings alone.
  const forged = structuredClone(enrolled);
  forged.records = unbound.map((record) => ({ ...record }));
  assert.throws(() => gateGeneration(null, forged), /shares its repository/u);
});

void test("release lines err toward one line for version noise and different lines for product words (R2, R3)", () => {
  // [tag, repository, line]: the fit rule and the gate derive every row alike.
  const rows: [string, string, string][] = [
    // Versions and channels are one line.
    ["v1.0", "owner/spider-game", ""],
    ["2.0.0-beta", "owner/spider-game", ""],
    ["v1.2.0p", "owner/spider-game", ""],
    ["r14388", "owner/spider-game", ""],
    ["2025.01.01", "owner/spider-game", ""],
    ["1.2", "owner/spider-game", ""],
    ["release-1.2", "owner/spider-game", ""],
    ["nightly-2026-11-01", "owner/spider-game", ""],
    ["game-1-2-0", "owner/spider-game", "game"],
    ["spider-game-v3", "owner/spider-game", ""],
    // Channel words glued to a number are channel markers, never line words.
    ["rc1", "owner/spider-game", ""],
    ["rc2", "owner/spider-game", ""],
    ["beta5", "owner/spider-game", ""],
    ["alpha3", "owner/spider-game", ""],
    ["pre1", "owner/spider-game", ""],
    ["build123", "owner/spider-game", ""],
    ["nightly20250101", "owner/spider-game", ""],
    ["release1.2", "owner/spider-game", ""],
    ["v1.0-rc2", "owner/spider-game", ""],
    // A glued `v<digits>` ends the product word.
    ["openmb2v0.3", "owner/openmb2", ""],
    ["openmb2v0.3", "owner/spider-game", "openmb2"],
    // A number glued to letters is a product word, never a version.
    ["d1x-v1.0", "owner/spider-game", "d1x"],
    ["d2x-v1.0", "owner/spider-game", "d2x"],
    ["x2-v1.0", "owner/spider-game", "x2"],
    ["t2-v1.0", "owner/spider-game", "t2"],
    ["2ship-v1.0", "owner/spider-game", "2ship"],
    ["sm1-v1.1", "owner/spider-game", "sm1"],
    ["sm2-v1.1", "owner/spider-game", "sm2"],
    // A short bare number between product words belongs to the product...
    ["doom-64-v1", "owner/spider-game", "doom-64"],
    ["doom-v1", "owner/spider-game", "doom"],
    ["doom-64-1.0", "owner/spider-game", "doom-64"],
    ["half-life-2-v1", "owner/spider-game", "half-life-2"],
    ["half-life-v1", "owner/spider-game", "half-life"],
    ["sm-2-v1", "owner/spider-game", "sm-2"],
    // ...and so is a final one directly after a product word (B2): `sm-1` and
    // `sm-2` may be two games, so they are two lines. A repository tagging
    // major versions this way is `ambiguous-release-line`: an honest exclusion.
    ["sm-1", "owner/spider-game", "sm-1"],
    ["sm-2", "owner/spider-game", "sm-2"],
    // The repository's own name does not change that: on `sm`, `sm-1` and
    // `sm-2` are still two lines, so a listing for game 1 never enrolls game
    // 2's release. A repository tagging major versions `<repo>-N` is
    // `ambiguous-release-line` unless the listing binds its release.
    ["sm-1", "owner/sm", "sm-1"],
    ["sm-2", "owner/sm", "sm-2"],
    ["sm-1-v1.0", "owner/sm", "sm-1"],
    ["proj-3", "owner/proj", "proj-3"],
    ["proj-4", "owner/proj", "proj-4"],
    ["proj-4-win64", "owner/proj", "proj-4"],
    ["my-proj-3", "owner/my-proj", "my-proj-3"],
    ["proj-64-v1", "owner/proj", "proj-64"],
    ["proj2-3", "owner/proj", "proj2-3"],
    // Version-shaped product words still make lines of their own: honest exclusions.
    ["v1-2", "owner/spider-game", "v1-2"],
    ["v1-r1", "owner/spider-game", "v1"],
    // A literal `x8664` is the same build-target word as `x86_64` (X2).
    ["x8664", "owner/spider-game", ""],
    ["game-x8664-v1.0", "owner/spider-game", "game"],
    ["game-2", "owner/spider-game", "game-2"],
    ["game-3", "owner/spider-game", "game-3"],
    ["game-2-v1.0", "owner/spider-game", "game-2"],
    ["game-2-v1.1", "owner/spider-game", "game-2"],
    ["game-2-win64", "owner/spider-game", "game-2"],
    // After a dropped word a bare number is the version.
    ["game-beta-2", "owner/spider-game", "game"],
    // A version-shaped word before another version is a product word (B2).
    ["r2-v1.0", "owner/spider-game", "r2"],
    ["b2-v1.0", "owner/spider-game", "b2"],
    ["texture-studio-v1.0.0", "owner/spider-game", "texture-studio"],
    // These stay the main line.
    ["v2", "owner/spider-game", ""],
    ["2.0", "owner/spider-game", ""],
    ["v2.0-win", "owner/spider-game", ""],
    ["1.0.0-windows-x64", "owner/spider-game", ""],
    ["64-v1", "owner/spider-game", ""],
    ["b5", "owner/spider-game", ""],
    ["r3", "owner/spider-game", ""],
    ["hotfix-1", "owner/spider-game", ""],
    ["latest", "owner/spider-game", ""],
    ["nightly", "owner/spider-game", ""],
    ["continuous", "owner/spider-game", ""],
    ["20250101", "owner/spider-game", ""],
    ["2025-01-01-nightly", "owner/spider-game", ""],
    ["build-123", "owner/spider-game", ""],
    // Operating-system and architecture words are dropped (F3).
    ["windows-v1.0", "owner/spider-game", ""],
    ["win64-1.0", "owner/spider-game", ""],
    ["linux", "owner/spider-game", ""],
    ["macos", "owner/spider-game", ""],
    ["x64", "owner/spider-game", ""],
    ["arm64", "owner/spider-game", ""],
    ["v1.0-linux-x86_64", "owner/spider-game", ""],
    ["spider-game-linux-x86_64", "owner/spider-game", ""],
    ["level-editor-win64-v1.0", "owner/spider-game", "level-editor"],
    // `final` and `update` can name a product; they are not channel words (F2).
    ["final-v1.0", "owner/spider-game", "final"],
    ["update-v1.0", "owner/spider-game", "update"],
    // Tag-style noise is version or channel noise (A4): commit hashes,
    // `v.` before digits, and conditional channel words beside a version,
    // date or hash, or alone.
    ["native-only-1a2b3c4", "owner/spider-game", "native-only"],
    // As the tag's first word a hex-looking word names the product (R6): it
    // is never read as a hash, so a hash-only tag is a line of its own.
    ["abc1234", "owner/spider-game", "abc1234"],
    ["facade1-v1.0", "owner/spider-game", "facade1"],
    ["decade2-v1.0", "owner/spider-game", "decade2"],
    ["cafe2024-v2", "owner/spider-game", "cafe2024"],
    // `test` and `testing` are conditional channel words (R6).
    ["test-drive-v1.0", "owner/spider-game", "test-drive"],
    ["v1.0-test", "owner/spider-game", ""],
    // `x86_64` / `x86-64` standing alone is one non-numeric build-target
    // word in both copies (R2).
    ["sm-x86-64-fixed-mac", "owner/spider-game", "sm-fixed"],
    ["game-x86_64-new", "owner/game-new", ""],
    ["v0.9", "owner/game-new", ""],
    ["nightly-x86-6412", "owner/spider-game", ""],
    ["x86-64-v1", "owner/spider-game", ""],
    ["dev-abc1234", "owner/spider-game", ""],
    ["v.0.1.1", "owner/spider-game", ""],
    ["v.2", "owner/spider-game", ""],
    ["pr42", "owner/spider-game", ""],
    ["pr42-v1.0", "owner/spider-game", ""],
    ["tester-v0.3", "owner/spider-game", ""],
    ["test", "owner/spider-game", ""],
    ["testing-2026-01-01", "owner/spider-game", ""],
    ["prealpha-0.1", "owner/spider-game", ""],
    ["pre-alpha-0.1", "owner/spider-game", ""],
    ["preview-3", "owner/spider-game", ""],
    ["snapshot-20260101", "owner/spider-game", ""],
    ["canary-1a2b3c4d", "owner/spider-game", ""],
    ["wip", "owner/spider-game", ""],
    ["wip-v0.4", "owner/spider-game", ""],
    ["experimental", "owner/spider-game", ""],
    ["experimental-2", "owner/spider-game", ""],
    ["fixed", "owner/spider-game", ""],
    ["v1.0-fix", "owner/spider-game", ""],
    ["v1.0.1-fixed", "owner/spider-game", ""],
    ["new-v2", "owner/spider-game", ""],
    ["new", "owner/spider-game", ""],
    ["build_20261120_2250", "owner/spider-game", ""],
    // Beside product words only, those words stay product words.
    ["new-game-v1", "owner/spider-game", "new-game"],
    ["fix-it-v1", "owner/spider-game", "fix-it"],
    ["canary-tools-v1", "owner/spider-game", "canary-tools"],
    // A hash needs a digit and a letter a-f: a hex-looking word is a product.
    ["deadbeef-v1", "owner/spider-game", "deadbeef"],
    ["1234567", "owner/spider-game", ""],
  ];
  for (const [tag, repository, expected] of rows) {
    assert.equal(releaseLine(tag, 7, repository), expected, `fit: ${tag} on ${repository}`);
    assert.equal(gateLine(tag, 7, repository), expected, `gate: ${tag} on ${repository}`);
  }
  for (const derive of [releaseLine, gateLine]) {
    assert.equal(derive("v1.0\u202e", 7, "owner/x"), "#7", "a non-ASCII tag is a line of its own");
    assert.equal(derive(null, 9, "owner/x"), "#9");
  }
});

void test("a tag of only channel words with a date, time or hash is a prerelease (A3)", async () => {
  // [tag, channel only]: the fit rule and the gate judge every row alike.
  const rows: [string, boolean][] = [
    ["build_20261120_2250", true],
    ["nightly-2025-01-01", true],
    ["nightly20250101", true],
    ["continuous", true],
    ["latest", true],
    ["dev-abc1234", true],
    ["canary-1a2b3c4d", true],
    ["nightly-windows-x86_64", true],
    ["nightly-x86-64", true],
    ["test", true],
    ["build-2026", true],
    ["nightly-2025-01-01-2250", true],
    ["build-202611202250", true],
    // Only real date and time shapes are dates (R5): these are versions.
    ["build-42", false],
    ["build-12", false],
    ["build-1234", false],
    ["beta-01", false],
    ["nightly-2025-13-01", false],
    ["build-20261320", false],
    ["build_20261120_2575", false],
    // `x86-64` glued to more digits is no build-target word (R2).
    ["nightly-x86-6412", false],
    ["v1.0", false],
    ["1.0.0", false],
    ["2025.01.01", false],
    ["release-2025-01-01", false],
    ["build-123", false],
    ["nightly-1", false],
    ["latest-v2", false],
    ["game-nightly", false],
    ["stable", false],
  ];
  for (const [tag, expected] of rows) {
    assert.equal(channelOnlyTag(tag), expected, `fit: ${tag}`);
    assert.equal(gateChannelOnlyTag(tag), expected, `gate: ${tag}`);
  }
  // The worker never offers such a release as the newest stable one, even
  // when the provider and Core call it stable.
  const id = "zz-channel-only";
  const releases = [
    releaseWith(1, "v1.0", "2026-10-01T00:00:00Z", [{ id: 11, name: windowsZip }]),
    releaseWith(2, "build_20261120_2250", "2026-10-20T00:00:00Z", [{ id: 21, name: windowsZip }]),
  ];
  const result = await derive([listing(id)], observerReport({ [id]: { releases } }));
  const facts = result.table.entries[0]!;
  assert.equal(facts.observation.tag, "v1.0");
  assert.equal(
    facts.observed_releases.find((release) => release.release_id === 2)!.prerelease,
    true,
  );
  // The newer channel-only build is on the main line: v1.0 still fits.
  assert.ok(decide(listing(id), facts).fit);
  // The fit rule and the gate each refuse a channel-only release as the
  // offered one, whatever the recorded verdict says.
  const forged = structuredClone(facts);
  forged.observation.tag = "nightly-2025-01-01";
  forged.observed_releases.find((release) => release.release_id === 1)!.tag = "nightly-2025-01-01";
  assert.equal(reasonOf(decide(listing(id), forged)), "no-stable-release");
  const generation = generateRegistrations([listing(id)], result.table);
  generation.facts = table(forged);
  generation.enrollments[0]!.facts_sha256 = digestOf(forged);
  assert.throws(() => gateGeneration(null, generation), /do not record as stable/u);
});

void test("release lines are counted over stable releases; prereleases only protect (A4)", () => {
  const releaseFacts = (
    items: [number, string, boolean | null, string][],
  ): ListingFactsEntry["observed_releases"] =>
    items.map(([release_id, tag, prerelease, published_at]) => ({
      release_id,
      tag,
      prerelease,
      published_at,
      packaged: true,
    }));
  const withReleases = (
    chosen: [number, string, string],
    others: [number, string, boolean | null, string][],
  ) =>
    entry(
      [artifact()],
      { release_id: chosen[0], tag: chosen[1], published_at: chosen[2] },
      unseen,
      {
        observed_releases: releaseFacts(
          [
            [chosen[0], chosen[1], false, chosen[2]] as [number, string, boolean, string],
            ...others,
          ].toSorted((left, right) => left[0] - right[0]),
        ),
      },
    );
  const gateOf = (facts: ListingFactsEntry, record = listing()) => {
    const generation = generateRegistrations([listing()], table(entry()));
    generation.records = [record];
    generation.enrollments[0]!.repository = facts.repository;
    generation.facts = table(facts);
    generation.enrollments[0]!.facts_sha256 = digestOf(facts);
    generation.enrollments[0]!.release = {
      id: facts.observation.release_id!,
      tag: facts.observation.tag!,
      observed_at: facts.observation.observed_at,
    };
    try {
      gateGeneration(null, generation);
      return "fit";
    } catch {
      return "refused";
    }
  };
  // Prerelease tag noise (a hash, a test build) no longer splits the line.
  const noisy = withReleases(
    [7, "v1.2", "2026-11-01T00:00:00.000Z"],
    [
      [5, "native-only-test-1a2b3c4", true, "2026-10-01T00:00:00.000Z"],
      [6, "pr12-preview", true, "2026-10-15T00:00:00.000Z"],
    ],
  );
  assert.equal(reasonOf(decide(listing(), noisy)), "fit");
  assert.equal(gateOf(noisy), "fit");
  // Two stable lines are still ambiguous.
  const twoStable = withReleases(
    [7, "v1.2", "2026-11-01T00:00:00.000Z"],
    [[5, "level-editor-v1.0", false, "2026-10-01T00:00:00.000Z"]],
  );
  assert.equal(reasonOf(decide(listing(), twoStable)), "ambiguous-release-line");
  assert.equal(gateOf(twoStable), "refused");
  // `sm-1` beside `sm-2`, both stable, stay two lines.
  const sm = withReleases(
    [7, "sm-2", "2026-11-01T00:00:00.000Z"],
    [[5, "sm-1", false, "2026-10-01T00:00:00.000Z"]],
  );
  const smListing = listing(unseen, { project_url: "https://github.com/fixture-owner/sm" });
  const smEntry = { ...sm, repository: "fixture-owner/sm" };
  assert.equal(reasonOf(decide(smListing, smEntry)), "ambiguous-release-line");
  assert.equal(gateOf(smEntry, smListing), "refused");
  // A tool's stable release beside the game's newer betas stays excluded:
  // the tool line does not name the product (R1) and a newer main-line
  // prerelease follows it.
  const tool = withReleases(
    [7, "texture-studio-v1.0.0", "2026-10-10T00:00:00.000Z"],
    [[8, "v0.9-beta", true, "2026-10-20T00:00:00.000Z"]],
  );
  assert.equal(reasonOf(decide(listing(), tool)), "ambiguous-release-line");
  assert.equal(gateOf(tool), "refused");
  // Bound to the tool's line, the newer main-line beta still excludes (ii).
  const bound = listing(unseen, {
    release_url: `https://github.com/fixture-owner/${unseen}/releases/tag/texture-studio-v1.0.0`,
  });
  assert.equal(reasonOf(decide(bound, tool)), "ambiguous-release-line");
  assert.equal(gateOf(tool, bound), "refused");
  // A newer prerelease whose verdict Core did not give excludes on any other line.
  const unknown = withReleases(
    [7, "v1.2", "2026-11-01T00:00:00.000Z"],
    [[8, "level-editor-v2", null, "2026-11-10T00:00:00.000Z"]],
  );
  assert.equal(reasonOf(decide(listing(), unknown)), "ambiguous-release-line");
  assert.equal(gateOf(unknown), "refused");
  // A newer beta of a tool's line (other product words) does not decide the game.
  const toolBeta = withReleases(
    [7, "v1.2", "2026-11-01T00:00:00.000Z"],
    [[8, "level-editor-v2-beta", true, "2026-11-10T00:00:00.000Z"]],
  );
  assert.equal(reasonOf(decide(listing(), toolBeta)), "fit");
  assert.equal(gateOf(toolBeta), "fit");
});

void test("a line names the product only as whole words of at least three characters (F1)", () => {
  // [line, repository, listing fields, names the product]
  const rows: [string, string, Record<string, unknown>, boolean][] = [
    ["", "owner/anything", {}, true],
    ["#7", "owner/rec", {}, false],
    // Part of a word never counts.
    ["rec", "owner/zelda64recomp", {}, false],
    ["open", "owner/reopen-game", {}, false],
    ["spidey", "owner/OpenSpideyPS1", {}, true],
    ["open", "owner/OpenSpideyPS1", {}, true],
    ["spid", "owner/OpenSpideyPS1", {}, false],
    // Whole words, and contiguous runs of them, across camel case and digits.
    ["recomp", "owner/zelda64recomp", {}, true],
    ["zelda64", "owner/zelda64recomp", {}, true],
    ["zelda-64", "owner/zelda64recomp", {}, true],
    ["ps1", "owner/OpenSpideyPS1", {}, true],
    ["sotn", "owner/sotn-decomp", {}, true],
    ["spider-game", "owner/spidergame", {}, true],
    ["spidergame", "owner/spider-game", {}, true],
    ["texture-studio", "owner/omf", { name: "Texture Studio" }, true],
    ["studio", "owner/omf", { id: "zz-texture-studio" }, true],
    ["sotn", "owner/elsewhere", { original_game_title: "SOTN" }, true],
    // Shorter than three characters is never enough.
    ["sm", "owner/sm-decomp", {}, false],
    ["x2", "owner/x2-game", {}, false],
  ];
  for (const [line, repository, fields, expected] of rows) {
    assert.equal(
      lineNamesProduct(line, repository, fields),
      expected,
      `fit: ${line} on ${repository}`,
    );
    assert.equal(
      gateLineNamesProduct(line, repository, fields),
      expected,
      `gate: ${line} on ${repository}`,
    );
  }
});

void test("glued channel markers keep a stable release and its newer candidate on one line (R3)", () => {
  // A stable `v1.0` followed by a newer `rc2` prerelease still enrolls.
  const releases = (tags: [string, boolean][]) =>
    tags.map(([tag, prerelease], index) => ({
      release_id: 7 + index,
      tag,
      prerelease,
      published_at: `2026-11-0${index + 1}T00:00:00.000Z`,
      packaged: true,
    }));
  const stableThenCandidate = entry([artifact()], {}, unseen, {
    observed_releases: releases([
      ["v1.0", false],
      ["rc2", true],
    ]),
  });
  assert.ok(decide(listing(), stableThenCandidate).fit);
  const generation = generateRegistrations([listing()], table(stableThenCandidate));
  assert.equal(gateGeneration(null, generation).added.length, 1);
  // An all-glued series is one line too.
  const glued = entry([artifact()], { tag: "build123" }, unseen, {
    observed_releases: releases([
      ["build123", false],
      ["build124", true],
    ]),
  });
  assert.ok(decide(listing(), glued).fit);
  assert.equal(
    gateGeneration(null, generateRegistrations([listing()], table(glued))).added.length,
    1,
  );
});

void test("an unbound named release line enrolls only when it names the listed product (R1)", () => {
  const window = (id: string, tags: string[]) =>
    entry(
      [artifact(windowsZip, [player("TextureStudio.exe")])],
      {
        tag: tags.at(-1)!,
        release_id: 7 + tags.length - 1,
      },
      id,
      {
        observed_releases: tags.map((tag, index) => ({
          release_id: 7 + index,
          tag,
          prerelease: false,
          published_at: `2026-11-0${index + 1}T00:00:00.000Z`,
          packaged: true,
        })),
      },
    );
  // Every release in the observer window is the tool's line: never the game.
  const remaster = "zz-omf-remastered";
  const tools = window(remaster, [
    "texture-studio-v1.0.0",
    "texture-studio-v1.0.1",
    "texture-studio-v1.0.2",
    "texture-studio-v1.0.3",
  ]);
  assert.equal(reasonOf(decide(listing(remaster), tools)), "ambiguous-release-line");
  // A line inside the repository name (`sotn` on `sotn-decomp`) enrolls.
  const decomp = "zz-sotn-decomp";
  const named = window(decomp, ["sotn-v1.2"]);
  assert.ok(decide(listing(decomp), named).fit);
  // A line equal to the repository name is the main line.
  const own = window(decomp, ["zz-sotn-decomp-v1.2"]);
  assert.ok(decide(listing(decomp), own).fit);
  // A line the listing's name holds enrolls too.
  assert.ok(decide(listing(remaster, { name: "Texture Studio" }), tools).fit);
  // The gate restates the rule from the listing alone.
  const generation = generateRegistrations([listing(decomp)], table(named));
  assert.equal(gateGeneration(null, generation).added.length, 1);
  const forged = structuredClone(generation);
  forged.records = [listing(decomp, { project_url: "https://github.com/fixture-owner/elsewhere" })];
  forged.facts.entries[0]!.observed_releases[0]!.tag = "texture-studio-v1.0.0";
  forged.facts.entries[0]!.observation.tag = "texture-studio-v1.0.0";
  forged.enrollments[0]!.release.tag = "texture-studio-v1.0.0";
  forged.enrollments[0]!.facts_sha256 = digestOf(forged.facts.entries[0]);
  assert.throws(() => gateGeneration(null, forged), /unbound release line of other product words/u);
});

void test("final short numbers and version-shaped product words keep products apart (B2)", () => {
  const releases = (tags: string[]) =>
    tags.map((tag, index) => ({
      release_id: 7 + index,
      tag,
      prerelease: false,
      published_at: `2026-11-0${index + 1}T00:00:00.000Z`,
      packaged: true,
    }));
  const id = "sm";
  const window = (tags: string[]) =>
    entry([artifact()], { tag: tags.at(-1)!, release_id: 7 + tags.length - 1 }, id, {
      observed_releases: releases(tags),
    });
  // On repository `fixture-owner/sm`, `sm-1` and `sm-2` may be two games:
  // the newest (game 2) is never enrolled for an unbound listing.
  for (const tags of [
    ["sm-1", "sm-2"],
    ["game-2", "game-3"],
    ["r2-v1.0", "b2-v1.0"],
  ])
    assert.equal(
      reasonOf(decide(listing(id), window(tags))),
      "ambiguous-release-line",
      tags.join(),
    );
  // One product's releases stay one line.
  for (const tags of [
    ["v1.0", "v2.0-win"],
    ["windows-v1.0", "linux-v1.1"],
    ["1.0.0-windows-x64", "b5"],
  ])
    assert.ok(decide(listing(id), window(tags)).fit, tags.join());
  // A listing bound to `sm-2` is read on that line and enrolls.
  const bound = listing(id, {
    release_url: "https://github.com/fixture-owner/sm/releases/tag/sm-2",
  });
  const two = window(["sm-1", "sm-2"]);
  assert.ok(decide(bound, two).fit);
  // The gate restates it: forging a bound listing away is refused.
  const generation = generateRegistrations([bound], table(two));
  assert.equal(gateGeneration(null, generation).added.length, 1);
  const forged = structuredClone(generation);
  forged.records = [listing(id)];
  assert.throws(() => gateGeneration(null, forged), /release line is ambiguous/u);
  // A final number after words spelling the repository's own name is not
  // read as a version: on repository `proj`, `proj-3` and `proj-4` stay two
  // lines, so the unbound listing is excluded and the gate refuses a forged
  // enrollment of the newest.
  const ownName = entry([artifact()], { tag: "proj-4", release_id: 8 }, "proj", {
    observed_releases: releases(["proj-3", "proj-4"]),
  });
  assert.equal(reasonOf(decide(listing("proj"), ownName)), "ambiguous-release-line");
  const boundOwn = listing("proj", {
    release_url: "https://github.com/fixture-owner/proj/releases/tag/proj-4",
  });
  assert.ok(decide(boundOwn, ownName).fit);
  const ownGeneration = generateRegistrations([boundOwn], table(ownName));
  assert.equal(gateGeneration(null, ownGeneration).added.length, 1);
  const forgedOwn = structuredClone(ownGeneration);
  forgedOwn.records = [listing("proj")];
  assert.throws(() => gateGeneration(null, forgedOwn), /release line is ambiguous/u);
});

void test("two different archives for one platform are ambiguous even with one program name (D3)", () => {
  const game = player("Game/Game.exe", "pe-x86-64", "game-build");
  const studio = player("Game/Game.exe", "pe-x86-64", "studio-build");
  const two = entry([
    artifact(windowsZip, [game], 11),
    artifact("Game-Extras-v1.0-windows-x64.zip", [studio], 12),
  ]);
  assert.equal(reasonOf(decide(listing(), two)), "ambiguous-artifact");
  // Equal player bytes in different archives are not one package (A1): an
  // update archive can hold the same game program as the full build.
  const samePlayers = entry([
    artifact(windowsZip, [game], 11),
    artifact("Game-Extras-v1.0-windows-x64.zip", [game], 12),
  ]);
  assert.equal(reasonOf(decide(listing(), samePlayers)), "ambiguous-artifact");
  // The same archive bytes under two asset ids are one package.
  const copy = { ...artifact(windowsZip, [game], 11), asset_id: 12 };
  const twins = entry([artifact(windowsZip, [game], 11), copy]);
  assert.ok(decide(listing(), twins).fit);
  // An authoring-tool archive is vetoed by its whole-word name and never counts.
  const vetoed = entry([
    artifact(windowsZip, [game], 11),
    artifact("Game-Studio-v1.0-windows-x64.zip", [studio], 12),
  ]);
  assert.ok(vetoed.artifacts[1]!.contradictory);
  assert.ok(decide(listing(), vetoed).fit);
  // A title containing the word as part of a longer word is not vetoed.
  const title = entry([
    artifact("Studiopolis-v1.0-windows-x64.zip", [player("Studiopolis.exe")], 11),
  ]);
  assert.ok(decide(listing(), title).fit);
  // The gate refuses two different archives independently.
  const generation = generateRegistrations([listing()], table(twins));
  assert.equal(gateGeneration(null, generation).added.length, 1);
  const forged = structuredClone(generation);
  forged.facts.entries[0]!.artifacts[1] = artifact("Game-Extras-v1.0-windows-x64.zip", [game], 12);
  forged.enrollments[0]!.facts_sha256 = digestOf(forged.facts.entries[0]);
  assert.throws(() => gateGeneration(null, forged), /2 different archives/u);
});

/** An artifact fact for a name Core's fixture does not hold, with the verdict Core would give. */
function named(
  name: string,
  players: PlayerFact[],
  id: number,
  os = "unknown",
  listingNames: string[] = [],
): ArtifactFactV2 {
  return artifactFact(
    {
      id,
      name,
      url: `https://github.com/fixture-owner/x/releases/download/v1/${id}`,
      size: 4096,
      sha256: sha(`archive-${id}-${name}`),
    },
    players,
    {
      rule_version: classification.output.filename_rule_version,
      role: "unknown",
      os,
      arch: "unknown",
      tool_token: null,
      system_token: null,
    },
    programToken,
    listingNames,
  );
}
/** The gate's verdict on an enrollment forced onto these facts for Windows. */
function forcedGate(facts: ListingFactsEntry, assetId: number, record = listing()) {
  const offered = facts.artifacts.find((item) => item.asset_id === assetId)!;
  const generation = generateRegistrations([record], table(facts));
  generation.enrollments = [
    {
      port_id: unseen,
      platforms: ["windows-x86-64"],
      generator_version: 0,
      facts_sha256: digestOf(facts),
      repository: facts.repository,
      repository_id: facts.repository_id,
      release: { id: 7, tag: "v1.0", observed_at: facts.observation.observed_at },
      runtimes: [
        {
          platform: "windows-x86-64",
          asset_id: assetId,
          asset_name: offered.name,
          archive_sha256: offered.sha256,
          source: "exact-release-structured",
          players: offered.players.filter((item) => item.machine === "pe-x86-64"),
        },
      ],
    },
  ];
  try {
    gateGeneration(null, generation);
    return "accepted";
  } catch (error) {
    return (error as Error).message;
  }
}

void test("an update archive holding the game's program is never chosen over the full build (A1)", () => {
  const game = player("Game/Game.exe", "pe-x86-64", "same-game");
  const full = named("Game-PC-v0.5.10-Windows-x64.zip", [game], 11, "windows");
  const update = named("update-0.5.10.zip", [game], 12);
  // The update archive is vetoed by its whole-word role name: the full build enrolls.
  const both = entry([full, update]);
  const decision = decide(listing(), both);
  assert.ok(decision.fit);
  assert.equal(decision.enrollment.runtimes[0]!.asset_name, "Game-PC-v0.5.10-Windows-x64.zip");
  assert.ok(
    artifactExclusions(update).some(
      (item) => item.reason === "asset-role-name" && item.token === "update",
    ),
  );
  // Each role word vetoes as a whole word only.
  for (const word of [
    "update",
    "updater",
    "hotfix",
    "delta",
    "incremental",
    "patch",
    "symbols",
    "debug",
  ]) {
    const alone = entry([named(`Game-${word}-v1.0.zip`, [game], 12)]);
    assert.equal(reasonOf(decide(listing(), alone)), "contradictory-role", word);
    assert.match(forcedGate(alone, 12), /role-named/u, word);
  }
  for (const title of ["Updated-Game-v1.0.zip", "Deltarune-Fan-v1.0.zip", "Patchwork-v1.0.zip"])
    assert.ok(decide(listing(), entry([named(title, [game], 12)])).fit, title);
  // A role word with trailing digits is still that role word (R1).
  for (const title of ["Game-Windows-Update1.zip", "Game-patch01-win64.zip", "Game-debug2.zip"]) {
    const alone = entry([named(title, [game], 12)]);
    assert.equal(reasonOf(decide(listing(), alone)), "contradictory-role", title);
    assert.match(forcedGate(alone, 12), /role-named/u, title);
  }
  // `Game-Windows-Update1.zip` beside the OS-neutral full build is vetoed,
  // so the full build is the one package (R1).
  const updateBeside = entry([
    named("Game-v1.2.zip", [game], 11),
    named("Game-Windows-Update1.zip", [game], 12, "windows"),
  ]);
  const fullChosen = decide(listing(), updateBeside);
  assert.ok(fullChosen.fit);
  assert.equal(fullChosen.enrollment.runtimes[0]!.asset_id, 11);
  assert.equal(forcedGate(updateBeside, 11), "accepted");
  assert.match(forcedGate(updateBeside, 12), /role-named/u);
  // A role word that is also a word of the product's own name names the
  // product, not a role: the listing's name, original title or id, and the
  // repository's name (R1). Fit and gate each drop it.
  const ownNames: [string, Record<string, unknown>][] = [
    ["Delta-Force-win64.zip", { name: "Delta Force" }],
    ["Mega-Update-Edition-v1.zip", { name: "Mega Update Edition" }],
    ["Debug-Quest-v1.zip", { original_game_title: "Debug Quest" }],
    ["Hotfix-Hero-v1.zip", { id: "hotfix-hero" }],
  ];
  for (const [title, fields] of ownNames) {
    const id = typeof fields.id === "string" ? fields.id : unseen;
    const record = listing(id, fields);
    const facts = entry([named(title, [game], 12)], {}, id);
    assert.ok(decide(record, facts).fit, title);
    assert.ok(
      !artifactExclusions(facts.artifacts[0]!, productNameWords(facts.repository, record.listing))
        .length,
      title,
    );
    if (record.listing.id === unseen)
      assert.equal(forcedGate(facts, 12, record), "accepted", title);
    // The same name is vetoed for a listing whose names do not hold the word.
    assert.equal(
      reasonOf(decide(listing(), entry([named(title, [game], 12)]))),
      "contradictory-role",
    );
    assert.match(forcedGate(entry([named(title, [game], 12)]), 12), /role-named/u, title);
  }
  const repositoryNamed = entry([named("Patch-Quest-v1.zip", [game], 12)], {}, unseen, {
    repository: "fixture-owner/patch-quest",
  });
  assert.ok(
    decide(
      listing(unseen, {
        project_url: "https://github.com/fixture-owner/patch-quest",
      }),
      repositoryNamed,
    ).fit,
  );
  // The rule's two copies agree word by word.
  for (const [name, record, repository] of [
    ["Game-update.zip", listing(), "o/game"],
    ["Game-update7.zip", listing(), "o/game"],
    ["Game-2update.zip", listing(), "o/game"],
    ["Game-updates.zip", listing(), "o/game"],
    ["Delta-Force.zip", listing(unseen, { name: "Delta Force" }), "o/game"],
    ["Delta-Force.zip", listing(), "o/delta-force"],
    ["DeltaForce.zip", listing(unseen, { name: "DeltaForce" }), "o/game"],
    ["Patch-Patch.zip", listing(unseen, { name: "Patch" }), "o/game"],
  ] as const) {
    const fit = archiveRoleToken(name, productNameWords(repository, record.listing)) !== null;
    assert.equal(gateRoleWord(name, record.listing, repository), fit, name);
  }
  // The gate refuses the update archive independently.
  assert.match(forcedGate(both, 12), /role-named/u);
  assert.equal(forcedGate(both, 11), "accepted");
});

void test("several archives for a platform are ambiguous, whatever their names say (A1, R1)", () => {
  const game = player("Game/Game.exe", "pe-x86-64", "same-game");
  const linux = player("Game/Game", "elf64-x86-64", "same-game-linux");
  // Two OS-neutral archives of one game: ambiguous, never chosen by order or size.
  const neutralPair = entry([
    named("Game-v1.0.zip", [game, linux], 11),
    named("Game-v1.0.tar.gz", [game, linux], 12),
  ]);
  assert.equal(reasonOf(decide(listing(), neutralPair)), "ambiguous-artifact");
  assert.match(forcedGate(neutralPair, 11), /2 different archives/u);
  // One names Windows explicitly beside an OS-neutral one that also holds a
  // Windows player: ambiguous on Windows, because a Windows-named partial
  // build cannot be told apart from the full build by name (R1 replaced the
  // earlier explicit-system exception with this rule). Linux, which only the
  // neutral archive serves, still fits.
  const explicit = entry([
    named("Game-v1.0-windows.zip", [game], 11, "windows"),
    named("Game-v1.0.tar.gz", [game, linux], 12),
  ]);
  const decision = decide(listing(), explicit);
  assert.ok(decision.fit);
  assert.deepEqual(
    decision.enrollment.runtimes.map((runtime) => [runtime.platform, runtime.asset_id]),
    [["linux-x86-64", 12]],
  );
  assert.match(forcedGate(explicit, 11), /2 different archives/u);
  assert.match(forcedGate(explicit, 12), /2 different archives/u);
  // The cases the exception got wrong: a Windows-named partial build beside
  // the OS-neutral full build is never chosen.
  const partial = entry([
    named("Game-v1.2.zip", [game], 11),
    named("Game-v1.2-windows-exe-only.zip", [game], 12, "windows"),
  ]);
  assert.equal(reasonOf(decide(listing(), partial)), "ambiguous-artifact");
  assert.match(forcedGate(partial, 12), /2 different archives/u);
  assert.match(forcedGate(partial, 11), /2 different archives/u);
  // A neutral archive holding no Windows player does not compete on Windows.
  const linuxOnly = entry([
    named("Game-windows.zip", [game], 11, "windows"),
    named("Game.tar.gz", [linux], 12),
  ]);
  const both = decide(listing(), linuxOnly);
  assert.ok(both.fit);
  assert.deepEqual(
    both.enrollment.runtimes.map((runtime) => [runtime.platform, runtime.asset_id]),
    [
      ["windows-x86-64", 11],
      ["linux-x86-64", 12],
    ],
  );
  assert.equal(forcedGate(linuxOnly, 11), "accepted");
  // Names that separate the systems: each platform has one archive.
  const separated = entry([
    named("Game-v1.0-windows.zip", [game], 11, "windows"),
    named("Game-v1.0-linux.tar.gz", [linux], 12, "linux"),
  ]);
  assert.ok(decide(listing(), separated).fit);
  // Two explicit Windows archives stay ambiguous.
  const twoExplicit = entry([
    named("Game-v1.0-windows.zip", [game], 11, "windows"),
    named("Game-v1.0-win64.zip", [game], 12, "windows"),
    named("Game-v1.0.zip", [game], 13),
  ]);
  assert.equal(reasonOf(decide(listing(), twoExplicit)), "ambiguous-artifact");
  assert.match(forcedGate(twoExplicit, 11), /3 different archives/u);
});

void test("an archive bundling a compiler or interpreter toolchain is withheld (A2, R4)", () => {
  const launcher = player("Game/Launcher.exe", "pe-x86-64", "launcher");
  const toolchain = named(
    "Game-v1.0-windows.zip",
    [launcher],
    11,
    "windows",
    toolchainNames(
      ["game", "launcher.exe", "tools", "zig", "zig.exe", "lib"],
      ["launcher.exe", "zig.exe"],
    ),
  );
  assert.deepEqual(toolchain.toolchain_names, ["zig.exe", "zig/"]);
  assert.deepEqual(toolchain.bundled_toolchain, ["zig"]);
  assert.equal(reasonOf(decide(listing(), entry([toolchain]))), "bundled-toolchain");
  assert.match(forcedGate(entry([toolchain]), 11), /bundles zig/u);
  // Whole names only, with or without `.exe`, in any letter case; a file
  // leaf is recorded as is, a directory with a trailing `/`.
  assert.deepEqual(
    toolchainNames(
      [
        "python.exe",
        "python311.dll",
        "scripts",
        "clang",
        "7z.exe",
        "7za.exe",
        "g++",
        "makefile",
        "linker.dll",
        "node_modules",
        "cmake",
      ],
      ["Python.EXE", "python311.dll", "7z.exe", "7za.exe", "g++", "makefile", "linker.dll"],
    ),
    ["clang/", "cmake/", "g++", "python.exe"],
  );
  // Short helper names that also name ordinary folders match only as a file
  // leaf (R4): `assets/link/`, `levels/ld/`, `make/`, `node/` and a
  // `lib/python3.11/` folder never do; `Python/python.exe` does.
  const rows: [string[], string[], string[]][] = [
    [["assets", "link", "door.png"], ["door.png"], []],
    [["levels", "ld", "one.map"], ["one.map"], []],
    [["make", "node", "cl", "pip", "python3", "x.png"], ["x.png"], []],
    [["lib", "python3.11", "os.py"], ["os.py"], []],
    [["python", "python.exe"], ["python.exe"], ["python"]],
    [["bin", "ld"], ["ld"], ["ld"]],
    [["tools", "link.exe"], ["link.exe"], ["link"]],
    [["make"], ["make"], ["make"]],
    [["zig", "lib"], ["readme.txt"], ["zig"]],
  ];
  for (const [names, leaves, helpers] of rows) {
    const recorded = toolchainNames(names, leaves);
    assert.deepEqual(bundledToolchain(recorded), helpers, names.join("/"));
    const archive = named("Game-v1.0-windows.zip", [launcher], 11, "windows", recorded);
    // Fit and gate each derive the decision from the recorded entries.
    assert.equal(
      reasonOf(decide(listing(), entry([archive]))) === "bundled-toolchain",
      helpers.length > 0,
      names.join("/"),
    );
    assert.equal(
      forcedGate(entry([archive]), 11) === "accepted",
      helpers.length === 0,
      names.join("/"),
    );
  }
  // A normal game shipping python311.dll and a scripts/ folder is not withheld.
  const normal = named(
    "Game-v1.0-windows.zip",
    [launcher],
    11,
    "windows",
    toolchainNames(
      ["game", "launcher.exe", "python311.dll", "scripts", "7z.exe"],
      ["launcher.exe", "python311.dll", "7z.exe"],
    ),
  );
  assert.deepEqual(normal.bundled_toolchain, []);
  assert.ok(decide(listing(), entry([normal])).fit);
  // The report queue names the helpers per identity.
  const generation = generateRegistrations([listing()], table(entry([toolchain])));
  assert.deepEqual(registrationQueues(generation).bundled_toolchains, { [unseen]: ["zig"] });
  // Recorded helper names outside the closed list, or a summary the recorded
  // entries do not show, are refused as facts: the gate never trusts it.
  const forged = structuredClone(toolchain);
  forged.bundled_toolchain = ["notatool"];
  assert.throws(() => checkListingFactsTable(table(entry([forged]))), /toolchain helper/u);
  const hidden = structuredClone(toolchain);
  hidden.bundled_toolchain = [];
  assert.throws(() => checkListingFactsTable(table(entry([hidden]))), /toolchain_names/u);
  const folderOnly = structuredClone(toolchain);
  folderOnly.toolchain_names = ["link/"];
  folderOnly.bundled_toolchain = ["link"];
  assert.throws(() => checkListingFactsTable(table(entry([folderOnly]))), /toolchain_names/u);
});

void test("the gate classifies every recorded other asset name with its own classifier (R7)", () => {
  const game = player("Game/Game.exe", "pe-x86-64", "same-game");
  const zip = named("Game-v1.0-windows.zip", [game], 11, "windows");
  // Harmless names the gate ignores itself: accepted.
  const harmless = entry([zip], {}, unseen, {
    asset_names: ["README.md", "Game.zip.sha256", "Soundtrack.ogg"],
  });
  assert.equal(forcedGate(harmless, 11), "accepted");
  // A program the worker's classifier did not record as another package form
  // is still seen by the gate, with an unknown digest: refused.
  for (const name of ["Setup.exe", "Game.7z", "Game.AppImage"]) {
    const missed = entry([zip], {}, unseen, { asset_names: ["README.md", name] });
    const verdict = forcedGate(missed, 11);
    if (name === "Game.AppImage") assert.equal(verdict, "accepted", name);
    else assert.match(verdict, new RegExp(name.replace(".", "\\."), "u"), name);
  }
  // The recorded other package forms must be among the recorded names.
  const inconsistent = entry([zip], {}, unseen, {
    other_packages: [
      { asset_id: 12, name: "Setup.exe", size: 1, sha256: sha("x"), platforms: ["windows-x86-64"] },
    ],
    asset_names: [],
  });
  assert.throws(() => checkListingFactsTable(table(inconsistent)), /asset_names/u);
});

void test("another package form competing with an offered archive excludes the identity (B3, W1)", async () => {
  const id = "zz-codegen-release";
  const generatorZip = "TableTennis-Windows-v1.7.0.zip";
  const inspect = byAsset({ 11: [player("bin/rexglue.exe")] });
  // The archive holds only a code generator; the release's own program is a
  // bare executable beside it, whatever either is called.
  const both = await derive(
    [listing(id)],
    observerReport({
      [id]: {
        releases: [
          releaseWith(1, "v1.0", "2026-10-01T00:00:00Z", [
            { id: 11, name: generatorZip },
            { id: 12, name: "TableTennis-v1.7.0.exe" },
          ]),
        ],
      },
    }),
    undefined,
    { inspect },
  );
  const facts = both.table.entries[0]!;
  assert.deepEqual(facts.other_packages, [
    {
      asset_id: 12,
      name: "TableTennis-v1.7.0.exe",
      size: 100,
      sha256: sha("v1.0-12"),
      platforms: ["windows-x86-64"],
    },
  ]);
  assert.equal(reasonOf(decide(listing(id), facts)), "other-package-form-beside-archive");

  // Linux: a tarball holding only a generator beside the game's AppImage.
  const linuxId = "zz-codegen-linux";
  const linux = await derive(
    [listing(linuxId, { platforms: ["linux-x86-64"] })],
    observerReport({
      [linuxId]: {
        releases: [
          releaseWith(1, "v1.0", "2026-10-01T00:00:00Z", [
            { id: 11, name: linuxTar },
            { id: 12, name: "Game-v1.0.AppImage" },
            { id: 13, name: "SHA256SUMS" },
          ]),
        ],
      },
    }),
    undefined,
    { inspect: byAsset({ 11: [player("bin/Game", "elf64-x86-64")] }) },
  );
  const linuxFacts = linux.table.entries[0]!;
  assert.deepEqual(
    linuxFacts.other_packages.map((other) => [other.name, other.platforms]),
    [["Game-v1.0.AppImage", ["linux-x86-64"]]],
    "a checksum file is not a program",
  );
  assert.equal(reasonOf(decide(listing(linuxId), linuxFacts)), "other-package-form-beside-archive");

  // Windows: a launcher-only zip beside the game in a `.7z` the worker does not read.
  const sevenId = "zz-launcher-7z";
  const seven = await derive(
    [listing(sevenId)],
    observerReport({
      [sevenId]: {
        releases: [
          releaseWith(1, "v1.0", "2026-10-01T00:00:00Z", [
            { id: 11, name: windowsZip },
            { id: 12, name: "Game-win64.7z" },
          ]),
        ],
      },
    }),
    undefined,
    { inspect: byAsset({ 11: [player("Launcher.exe")] }) },
  );
  const sevenFacts = seven.table.entries[0]!;
  assert.deepEqual(sevenFacts.other_packages[0]!.platforms, ["windows-x86-64"]);
  assert.equal(reasonOf(decide(listing(sevenId), sevenFacts)), "other-package-form-beside-archive");

  // Fixture entries for the per-platform rule.
  const game = player("Unseen/Unseen.exe");
  const linuxGame = player("Unseen/Unseen", "elf64-x86-64");
  const other = (
    sha256: string | null,
    name = "Unseen-Setup.exe",
    platforms = ["windows-x86-64"],
  ) => ({
    asset_id: 30,
    name,
    size: 2048,
    sha256,
    platforms,
  });
  const both2 = listing(unseen, {
    platforms: ["windows-x86-64", "linux-x86-64"],
  });
  // Portable zip, Setup.exe and a Linux tarball: the Setup.exe competes with
  // the Windows archive, so the archives' role is unknown and the whole
  // identity is excluded (W1; this replaces the earlier Linux-only enrollment).
  const setupAndLinux = entry(
    [artifact(windowsZip, [game], 11), artifact(linuxTar, [linuxGame], 12)],
    {},
    unseen,
    { other_packages: [other(sha("setup-bytes"))] },
  );
  assert.equal(reasonOf(decide(both2, setupAndLinux)), "other-package-form-beside-archive");
  // The two-platform code-generator release has the same facts: a generator
  // in the Windows zip and the Linux tarball beside a separate game installer.
  const generator = player("bin/rexglue.exe");
  const linuxGenerator = player("bin/Game", "elf64-x86-64", "generator");
  const generatorRelease = entry(
    [artifact(windowsZip, [generator], 11), artifact(linuxTar, [linuxGenerator], 12)],
    {},
    unseen,
    { other_packages: [other(sha("installer-bytes"), "Install-Game.exe")] },
  );
  const generatorDecision = decide(both2, generatorRelease);
  assert.equal(reasonOf(generatorDecision), "other-package-form-beside-archive");
  assert.match(generatorDecision.fit ? "" : generatorDecision.detail, /Install-Game\.exe/u);
  // A setup program beside the portable archive alone excludes the release.
  const setup = entry([artifact(windowsZip, [game])], {}, unseen, {
    other_packages: [other(sha("setup-bytes"))],
  });
  assert.equal(reasonOf(decide(listing(), setup)), "other-package-form-beside-archive");
  // Another package without a provider digest is UNKNOWN, so excluded.
  const unknown = entry([artifact(windowsZip, [game])], {}, unseen, {
    other_packages: [other(null, "Unseen.exe")],
  });
  assert.equal(reasonOf(decide(listing(), unknown)), "other-package-form-beside-archive");
  // A single-file program equal to the archive's player is the same package.
  const same = entry([artifact(windowsZip, [game])], {}, unseen, {
    other_packages: [other(game.sha256, "Unseen.exe")],
  });
  assert.ok(decide(listing(), same).fit);
  // An AppImage equal to the Windows player is still another program on
  // Linux, where the release also offers a tarball: the identity is excluded.
  const crossed = entry(
    [artifact(windowsZip, [game], 11), artifact(linuxTar, [linuxGame], 12)],
    {},
    unseen,
    {
      other_packages: [other(game.sha256, "Unseen.AppImage", ["linux-x86-64"])],
    },
  );
  assert.equal(reasonOf(decide(both2, crossed)), "other-package-form-beside-archive");
  // A `.dmg` beside Windows and Linux archives only competes with no offered
  // archive: both platforms enroll.
  const dmg = entry(
    [artifact(windowsZip, [game], 11), artifact(linuxTar, [linuxGame], 12)],
    {},
    unseen,
    {
      other_packages: [other(sha("dmg-bytes"), "Unseen.dmg", ["macos-x86-64", "macos-aarch64"])],
    },
  );
  const dmgDecision = decide(both2, dmg);
  assert.ok(dmgDecision.fit);
  assert.deepEqual(dmgDecision.enrollment.platforms, ["windows-x86-64", "linux-x86-64"]);
  // A `.dmg` beside a macOS zip competes with it: always withheld.
  const macPlayer = player("Unseen.app/Contents/MacOS/Unseen", "macho-arm64");
  const macDmg = entry([artifact(macZip, [macPlayer], 13)], {}, unseen, {
    other_packages: [other(sha("dmg-bytes"), "Unseen.dmg", ["macos-x86-64", "macos-aarch64"])],
  });
  assert.equal(
    reasonOf(decide(listing(unseen, { platforms: ["macos-aarch64"] }), macDmg)),
    "other-package-form-beside-archive",
  );

  // The gate restates the rule from the facts alone, independently.
  const generation = generateRegistrations([listing()], table(same));
  assert.equal(gateGeneration(null, generation).added.length, 1);
  for (const forgedDigest of [sha("setup-bytes"), null]) {
    const forged = structuredClone(generation);
    forged.facts.entries[0]!.other_packages = [other(forgedDigest)];
    forged.enrollments[0]!.facts_sha256 = digestOf(forged.facts.entries[0]);
    assert.throws(() => gateGeneration(null, forged), /another package for windows-x86-64/u);
  }
  // Recorded platforms cannot narrow a form: an `.exe` marked as macOS-only
  // still serves Windows to the gate.
  const narrowed = structuredClone(generation);
  narrowed.facts.entries[0]!.other_packages = [
    other(sha("setup-bytes"), "Unseen-Setup.exe", ["macos-x86-64", "macos-aarch64"]),
  ];
  narrowed.enrollments[0]!.facts_sha256 = digestOf(narrowed.facts.entries[0]);
  assert.throws(() => gateGeneration(null, narrowed), /another package for windows-x86-64/u);
  // A `.dmg` forged beside an enrolled macOS zip is refused by the gate, which
  // names the `.dmg`'s platforms itself, even when recorded with none (Y5).
  const macListing = listing(unseen, { platforms: ["macos-aarch64"] });
  const universal = player("Unseen.app/Contents/MacOS/Unseen", "macho-universal-arm64+x86-64");
  const macGeneration = generateRegistrations(
    [macListing],
    table(entry([artifact(macZip, [universal], 13)])),
  );
  assert.equal(gateGeneration(null, macGeneration).added.length, 1);
  for (const recorded of [["macos-x86-64", "macos-aarch64"], []]) {
    const forged = structuredClone(macGeneration);
    forged.facts.entries[0]!.other_packages = [other(sha("dmg-bytes"), "Unseen.dmg", recorded)];
    forged.enrollments[0]!.facts_sha256 = digestOf(forged.facts.entries[0]);
    assert.throws(
      () => gateGeneration(null, forged),
      /another package for macos-aarch64 \(Unseen\.dmg\)/u,
    );
  }
  // Two-platform enrollments: the gate passes the `.dmg` release and refuses
  // a Linux-only enrollment forged over the Setup.exe and generator releases,
  // whichever platform the enrollment names.
  const twoPlatforms = generateRegistrations([both2], table(dmg));
  assert.equal(gateGeneration(null, twoPlatforms).added.length, 1);
  // The `.dmg` serves only a platform without an offered archive, so it is
  // ignored by the rule; the enrollment is listed for review instead (Y6).
  assert.deepEqual(registrationQueues(twoPlatforms).enrolled_beside_unoffered_forms, [unseen]);
  assert.deepEqual(registrationQueues(generation).enrolled_beside_unoffered_forms, []);
  // A Windows installer beside a Linux-named tarball: the installer serves
  // only Windows, where no archive is offered, so the Linux program enrolls —
  // whatever it is — and is listed for review (residual f).
  const installerAndTarball = entry([artifact(linuxTar, [linuxGame], 12)], {}, unseen, {
    other_packages: [other(sha("setup-bytes"))],
  });
  const linuxOnly = listing(unseen, { platforms: ["linux-x86-64"] });
  const installerGeneration = generateRegistrations([linuxOnly], table(installerAndTarball));
  assert.equal(installerGeneration.enrollments.length, 1);
  assert.deepEqual(registrationQueues(installerGeneration).enrolled_beside_unoffered_forms, [
    unseen,
  ]);
  // Beside a neutral-named archive, which permits every platform, the same
  // installer competes on Windows and the whole identity is excluded.
  assert.equal(
    reasonOf(
      decide(
        linuxOnly,
        entry([artifact(neutralZip, [linuxGame], 12)], {}, unseen, {
          other_packages: [other(sha("setup-bytes"))],
        }),
      ),
    ),
    "other-package-form-beside-archive",
  );
  // An excluded identity is not listed: the queue holds enrollments only.
  assert.deepEqual(
    registrationQueues(generateRegistrations([both2], table(setupAndLinux)))
      .enrolled_beside_unoffered_forms,
    [],
  );
  for (const [facts, name] of [
    [setupAndLinux, "Unseen-Setup.exe"],
    [generatorRelease, "Install-Game.exe"],
  ] as const) {
    const forged = structuredClone(twoPlatforms);
    forged.facts.entries[0]!.other_packages = facts.other_packages;
    forged.facts.entries[0]!.artifacts = facts.artifacts;
    forged.enrollments[0]!.runtimes = forged.enrollments[0]!.runtimes.filter(
      (runtime) => runtime.platform === "linux-x86-64",
    );
    forged.enrollments[0]!.runtimes[0]!.players = forged.facts.entries[0]!.artifacts[1]!.players;
    forged.enrollments[0]!.runtimes[0]!.archive_sha256 =
      forged.facts.entries[0]!.artifacts[1]!.sha256;
    forged.enrollments[0]!.platforms = ["linux-x86-64"];
    forged.enrollments[0]!.facts_sha256 = digestOf(forged.facts.entries[0]);
    assert.throws(
      () => gateGeneration(null, forged),
      new RegExp(`another package for windows-x86-64 \\(${name.replace(".", "\\.")}\\)`, "u"),
    );
  }
  // The gate names AppImage, extension-less, container and split-volume forms
  // itself (a container by its recorded name verdict); a checksum sidecar is
  // never a program.
  const linuxEnrollment = generateRegistrations(
    [listing(unseen, { platforms: ["linux-x86-64"] })],
    table(entry([artifact(linuxTar, [linuxGame], 12)])),
  );
  assert.equal(gateGeneration(null, linuxEnrollment).added.length, 1);
  for (const [name, recorded, refused] of [
    ["Unseen.AppImage", [], true],
    ["Unseen-v1.0-linux", [], true],
    ["Unseen.x86_64", [], true],
    ["Unseen-installer.sh", [], true],
    ["Unseen-linux.7z", ["linux-x86-64"], true],
    ["Unseen-linux.7z.001", ["linux-x86-64"], true],
    ["Unseen-windows.7z", ["windows-x86-64"], false],
    ["Unseen.tar.gz.sha256", [], false],
    ["libunseen.so.1", [], false],
  ] as const) {
    const forged = structuredClone(linuxEnrollment);
    forged.facts.entries[0]!.other_packages = [other(sha("other-bytes"), name, [...recorded])];
    forged.enrollments[0]!.facts_sha256 = digestOf(forged.facts.entries[0]);
    if (refused)
      assert.throws(() => gateGeneration(null, forged), /another package for linux-x86-64/u, name);
    else assert.equal(gateGeneration(null, forged).added.length, 1, name);
  }
  // The table check refuses a form recorded with platforms it cannot serve.
  assert.throws(
    () =>
      checkListingFactsTable(
        table({
          ...setupAndLinux,
          other_packages: [other(sha("setup-bytes"), "Unseen-Setup.exe", ["linux-x86-64"])],
        }),
      ),
    /platforms its form serves/u,
  );
  // A delimited code-generator program name is a tool; a glued one is judged by the rules above.
  const glue = entry([artifact(windowsZip, [player("bin/rex-glue.exe")])]);
  assert.equal(glue.artifacts[0]!.excluded_players[0]!.token, "glue");
  assert.equal(reasonOf(decide(listing(), glue)), "tool-not-game");
});

void test("release file names are classified as other package forms by fit and gate alike (W2, X1, Z1)", () => {
  const W = ["windows-x86-64"];
  const L = ["linux-x86-64"];
  const M = ["macos-x86-64", "macos-aarch64"];
  // [name, fit kind, platforms the gate names itself]
  const rows: [string, ReturnType<typeof otherPackageForm>, string[]][] = [
    // Not a program: documentation, checksums, signatures, metadata, libraries.
    ["LICENSE", undefined, []],
    ["README", undefined, []],
    ["SHA256SUMS", undefined, []],
    ["SHASUMS256", undefined, []],
    ["RELEASES", undefined, []],
    ["VERSION", undefined, []],
    ["CHECKSUM", undefined, []],
    ["CHECKSUMS", undefined, []],
    ["B3SUMS", undefined, []],
    ["manifest", undefined, []],
    ["Makefile", undefined, []],
    ["Game.exe.sig", undefined, []],
    ["Game.zip.asc", undefined, []],
    ["notes.txt", undefined, []],
    ["meta.json", undefined, []],
    ["config.yml", undefined, []],
    ["latest.yml", undefined, []],
    ["Game.pdb", undefined, []],
    ["Game.AppImage.zsync", undefined, []],
    ["Game-Setup.exe.blockmap", undefined, []],
    ["Game.zip.sha1", undefined, []],
    ["Game.zip.sha256", undefined, []],
    ["Game.zip.sha512", undefined, []],
    ["Game.zip.sha256sum", undefined, []],
    ["Game.zip.sha512sum", undefined, []],
    ["Game.zip.md5", undefined, []],
    ["Game.zip.minisig", undefined, []],
    ["Game.torrent", undefined, []],
    ["signing.pem", undefined, []],
    ["game.so", undefined, []],
    ["game.so.1", undefined, []],
    ["libgame.so.1.2.3", undefined, []],
    ["game.dll", undefined, []],
    ["libgame.dylib", undefined, []],
    // Documentation names with suffixes and other non-program names (Y4).
    ["COPYING.LESSER", undefined, []],
    ["README.markdown", undefined, []],
    ["LICENSE-MIT", undefined, []],
    ["Licence-Apache", undefined, []],
    ["CHANGES", undefined, []],
    ["NOTICE-THIRD-PARTY", undefined, []],
    ["AUTHORS", undefined, []],
    ["NEWS", undefined, []],
    ["TODO", undefined, []],
    ["INSTALL", undefined, []],
    ["CHANGELOG", undefined, []],
    ["Dockerfile", undefined, []],
    ["hashes", undefined, []],
    ["signatures", undefined, []],
    ["sha256sum", undefined, []],
    ["sha1sum", undefined, []],
    ["md5sum", undefined, []],
    ["sha512sum", undefined, []],
    ["gpl-3.0", undefined, []],
    // The closed non-program list (Z1): suffixes in any letter case.
    ["Game.zip.sig", undefined, []],
    ["Game.zip.asc", undefined, []],
    ["Game.zip.minisig", undefined, []],
    ["key.pem", undefined, []],
    ["Game.zip.gpg", undefined, []],
    ["Game.zip.sigstore", undefined, []],
    ["Game.zip.intoto.jsonl", undefined, []],
    ["Game.zip.sha384", undefined, []],
    ["Game.zip.sha224", undefined, []],
    ["Game.zip.md5sum", undefined, []],
    ["Game.zip.sha1sum", undefined, []],
    ["Game.zip.sha256sums", undefined, []],
    ["Game.zip.checksum", undefined, []],
    ["Game.zip.checksums", undefined, []],
    ["latest-linux.yml", undefined, []],
    ["latest-mac.yaml", undefined, []],
    ["update.json", undefined, []],
    ["appcast.xml", undefined, []],
    ["Info.plist", undefined, []],
    ["Game.AppImage.zsync", undefined, []],
    ["notes.txt", undefined, []],
    ["README.md", undefined, []],
    ["CHANGELOG.markdown", undefined, []],
    ["guide.rst", undefined, []],
    ["Manual.pdf", undefined, []],
    ["index.html", undefined, []],
    ["index.htm", undefined, []],
    ["notes.rtf", undefined, []],
    ["Game.nfo", undefined, []],
    ["build.log", undefined, []],
    ["scores.csv", undefined, []],
    ["screenshot.png", undefined, []],
    ["cover.jpg", undefined, []],
    ["cover.jpeg", undefined, []],
    ["demo.gif", undefined, []],
    ["banner.webp", undefined, []],
    ["logo.svg", undefined, []],
    ["icon.ico", undefined, []],
    ["trailer.mp4", undefined, []],
    ["trailer.webm", undefined, []],
    ["trailer.mov", undefined, []],
    ["Game.pdb", undefined, []],
    ["Game.dbg", undefined, []],
    ["Game.x86_64.debug", undefined, []],
    ["Game.sym", undefined, []],
    ["Game.torrent", undefined, []],
    ["fix.patch", undefined, []],
    ["fix.diff", undefined, []],
    ["GAME.ZIP.SHA256", undefined, []],
    ["Screenshot.PNG", undefined, []],
    // ...exact names, license names and documentation words followed only by a license identifier.
    ["sha512sums", undefined, []],
    ["SHASUMS256", undefined, []],
    ["checksums", undefined, []],
    ["checksum", undefined, []],
    ["b3sums", undefined, []],
    ["hashes", undefined, []],
    ["signatures", undefined, []],
    ["sha256sum", undefined, []],
    ["sha1sum", undefined, []],
    ["md5sum", undefined, []],
    ["sha512sum", undefined, []],
    ["releases", undefined, []],
    ["version", undefined, []],
    ["manifest", undefined, []],
    ["license", undefined, []],
    ["licence", undefined, []],
    ["copying", undefined, []],
    ["readme", undefined, []],
    ["changelog", undefined, []],
    ["changes", undefined, []],
    ["notice", undefined, []],
    ["authors", undefined, []],
    ["news", undefined, []],
    ["todo", undefined, []],
    ["install", undefined, []],
    ["makefile", undefined, []],
    ["dockerfile", undefined, []],
    ["gpl-2.0", undefined, []],
    ["agpl-3.0", undefined, []],
    ["lgpl-2.1-or-later", undefined, []],
    ["apache-2.0", undefined, []],
    ["mpl-2.0", undefined, []],
    ["bsd-3-clause", undefined, []],
    ["LICENSE-MIT", undefined, []],
    ["LICENSE-APACHE-2.0", undefined, []],
    ["LICENSE_BSD", undefined, []],
    ["COPYING.LESSER", undefined, []],
    ["README.markdown", undefined, []],
    ["LICENSE_THIRD_PARTY.txt", undefined, []],
    ["LICENSE-THIRD-PARTY", undefined, []],
    ["LICENSE.thirdparty", undefined, []],
    ["Licence-GPL", undefined, []],
    ["COPYING-LGPL", undefined, []],
    // Libraries before split volumes: a versioned `.so` stays a library.
    ["libgame.so.1.0.123", undefined, []],
    ["libgame.so.1.0", undefined, []],
    ["Game.DLL", undefined, []],
    // Read archives in any letter case, and non-desktop packages.
    ["Game.zip", undefined, []],
    ["Game-mac.dSYM.zip", undefined, []],
    ["Game.app.zip", undefined, []],
    ["Game.TAR.GZ", undefined, []],
    ["Game.TGZ", undefined, []],
    ["Game.aab", undefined, []],
    ["Game.vpk", undefined, []],
    ["Game.nro", undefined, []],
    ["Game.nsp", undefined, []],
    ["Game.3dsx", undefined, []],
    ["Game.cia", undefined, []],
    ["Game.wad", undefined, []],
    // A documentation word followed by anything else is not ignored (Z1):
    // the name classifies by the other rules, the safe direction.
    ["Changes-Game-linux", "linux", L],
    ["Notice-Me-Senpai", "linux", L],
    ["Readme-Launcher", "linux", L],
    ["Authors-Cut", "linux", L],
    ["installer", "linux", L],
    ["readme_first", "linux", L],
    ["Changelog_2026", "linux", L],
    ["Game.v1", "linux", L],
    ["game-1.0", "linux", L],
    ["Install-Game.sh", "linux", L],
    ["INSTALL.sh", "linux", L],
    ["Game.rpm", "linux", L],
    ["Game.flatpak", "linux", L],
    ["Game.AppImage", "linux", L],
    // Every other or unknown extension is an unread container (Z1).
    ["Game-linux.txz", "container", []],
    ["Game.tbz", "container", []],
    ["Game.tzst", "container", []],
    ["Game.tlz", "container", []],
    ["Game.taz", "container", []],
    ["Game.tz", "container", []],
    ["Game.Z", "container", []],
    ["Game.tar.Z", "container", []],
    ["Game.zipx", "container", []],
    ["Game.sit", "container", []],
    ["Game.arj", "container", []],
    ["Game.lha", "container", []],
    ["Game.wim", "container", []],
    ["Game.vhd", "container", []],
    ["Game.chd", "container", []],
    ["Game.squashfs", "container", []],
    ["Game.pck", "container", []],
    ["Game.pak", "container", []],
    ["Game.wasm", "container", []],
    ["Game.xyz", "container", []],
    ["Game-win64.xyz", "container", []],
    ["Game.jar", "container", []],
    ["Game.tar", "container", []],
    ["Game.rar", "container", []],
    ["Game.tar.zst", "container", []],
    ["Game.tbz2", "container", []],
    ["Game.7z.sha", "container", []],
    // Read archives and non-desktop packages are not other package forms.
    ["Game-v1.0-windows-x64.zip", undefined, []],
    ["Game.app.zip", undefined, []],
    ["Game.app.tar.gz", undefined, []],
    ["Game.apk", undefined, []],
    ["Game.ipa", undefined, []],
    // Windows forms.
    ["Game.exe", "windows", W],
    ["Game.msi", "windows", W],
    ["Game.msix", "windows", W],
    ["Game.appx", "windows", W],
    ["Game.msixbundle", "windows", W],
    ["Game.appxbundle", "windows", W],
    // Linux forms, self-extracting installers and bare binaries.
    ["Game.AppImage", "linux", L],
    ["Game.deb", "linux", L],
    ["Game.snap", "linux", L],
    ["Game.run", "linux", L],
    ["Game.bin", "linux", L],
    ["install.sh", "linux", L],
    ["Game.linux", "linux", L],
    ["Game.x86", "linux", L],
    ["Game.x86_64", "linux", L],
    ["Game.arm64", "linux", L],
    ["Game.aarch64", "linux", L],
    ["Game", "linux", L],
    ["Game-v1.0-linux", "linux", L],
    // An apparent extension that is only a version leaves a bare binary (Y4).
    ["game-v1.0", "linux", L],
    ["Game.v1.2", "linux", L],
    ["game.1.2.3", "linux", L],
    // A documentation word not followed by the end or a separator is a program.
    ["readmeviewer", "linux", L],
    ["noticeboard", "linux", L],
    // macOS forms.
    ["Game.dmg", "macos", M],
    ["Game.pkg", "macos", M],
    // Containers and split-archive volumes: platforms from the name verdict.
    ["Game-win64.7z", "container", []],
    ["Game.tar.bz2", "container", []],
    ["Game-win64.7z.001", "container", []],
    ["Game-win64.7z.002", "container", []],
    ["Game-win64.zip.001", "container", []],
    ["game.7z.001", "container", []],
    ["Game.tar.gz.001", "container", []],
    ["Game.z01", "container", []],
    ["Game.r00", "container", []],
    ["Game.part1.rar", "container", []],
    // Any `.<three or more digits>` ending is a split volume, whatever its
    // inner extension (Y2): never a Linux bare binary.
    ["Game.exe.001", "container", []],
    ["Game-win64.exe.002", "container", []],
    ["Game.iso.001", "container", []],
    ["Game.001", "container", []],
    ["Game.1000", "container", []],
    // Compressed files, containers and disk images the worker does not read (Y3).
    ["Game.gz", "container", []],
    ["Game.xz", "container", []],
    ["Game.bz2", "container", []],
    ["Game.zst", "container", []],
    ["Game.lz", "container", []],
    ["Game.lzma", "container", []],
    ["Game.lz4", "container", []],
    ["Game.tar.lz", "container", []],
    ["Game.tar.lzma", "container", []],
    ["Game.tar.lz4", "container", []],
    ["Game.cab", "container", []],
    ["Game.lzh", "container", []],
    ["Game.ace", "container", []],
    ["Game.cpio", "container", []],
    ["Game.iso", "container", []],
    ["Game.img", "container", []],
    ["Game.love", "container", []],
    // Harmless release decoration and metadata is on the closed list (R3).
    ...[
      "Soundtrack.mp3",
      "theme.ogg",
      "music.flac",
      "jingle.wav",
      "voice.opus",
      "Font.ttf",
      "Font.otf",
      "Font.woff",
      "Font.woff2",
      "subs.srt",
      "subs.vtt",
      "Manual.docx",
      "Manual.odt",
      "Guide.epub",
      "game.zip.cosign.bundle",
      "game.bundle",
      "game.zip.p7s",
      "signing.crt",
      "signing.cer",
      "minisign.pub",
      "game.sbom",
      "game.spdx",
      "Cargo.lock",
      "Cargo.toml",
      "go.sum",
      "go.mod",
      "package.json",
      "Game.exe.config",
      "game.js.map",
      "settings.ini",
      "game.cfg",
      "de.mo",
      "de.po",
      "style.css",
      "game.desktop",
      "Game.appinstaller",
    ].map((name): [string, undefined, string[]] => [name, undefined, []]),
    // Anything that can carry or launch a program keeps competing.
    ["game.js", "container", []],
    ["run.bat", "container", []],
    ["run.cmd", "container", []],
    ["setup.ps1", "container", []],
    ["Game.command", "container", []],
    ["Game.nupkg", "container", []],
    ["data.db", "container", []],
    ["data.dat", "container", []],
    ["Game.delta", "container", []],
    ["Game.diff.gz", "container", []],
    // ...but the read `.tar.gz`, `.tgz` and `.tar.xz` stay read archives.
    ["Game-linux.tar.gz", undefined, []],
    ["Game-linux.tgz", undefined, []],
    ["Game-linux.tar.xz", undefined, []],
  ];
  for (const [name, kind, gate] of rows) {
    assert.equal(otherPackageForm(name), kind, `fit: ${name}`);
    assert.equal(gateFormKind(name), kind, `gate kind: ${name}`);
    assert.deepEqual(gateFormPlatforms(name), gate, `gate: ${name}`);
    if (kind !== "container")
      assert.deepEqual(otherPackagePlatforms(name, undefined), gate, `fit platforms: ${name}`);
  }
  // A split volume's platforms come from its name: every platform when the
  // name is neutral, the named system's otherwise.
  const assets = ["Launcher-win64.zip", "Game-win64.7z.001", "Game-win64.7z.002", "game.7z.001"];
  const recorded = otherPackagesOf(
    {
      id: 1,
      version: "v1.0",
      published_at: "2026-10-01T00:00:00Z",
      provider_prerelease: false,
      assets_complete: true,
      malformed_assets: 0,
      assets: assets.map((name, index) => ({
        id: 11 + index,
        name,
        url: `https://github.com/fixture-owner/x/releases/download/v1/${index}`,
        size: 100,
        sha256: sha(name),
      })),
    },
    (name) => (name.includes("win64") ? suggestion("Game-win64.7z") : undefined),
  );
  assert.deepEqual(
    recorded.map((other) => [other.name, other.platforms]),
    [
      ["Game-win64.7z.001", W],
      ["Game-win64.7z.002", W],
      ["game.7z.001", ["windows-x86-64", "linux-x86-64", ...M]],
    ],
  );
  // A launcher-only zip beside the game's split 7z volumes is never enrolled.
  const launcher = entry([artifact(windowsZip, [player("Launcher.exe")])], {}, unseen, {
    other_packages: recorded.slice(0, 2),
  });
  assert.equal(reasonOf(decide(listing(), launcher)), "other-package-form-beside-archive");
  const generation = generateRegistrations(
    [listing()],
    table(entry([artifact(windowsZip, [player("Launcher.exe")])])),
  );
  const forged = structuredClone(generation);
  forged.facts.entries[0]!.other_packages = recorded.slice(0, 2);
  forged.enrollments[0]!.facts_sha256 = digestOf(forged.facts.entries[0]);
  assert.throws(() => gateGeneration(null, forged), /Game-win64\.7z\.001/u);
  // A client zip beside the game's split `.exe` volumes is never enrolled on
  // Windows: the volumes are containers serving Windows by their name (Y2).
  const exeVolumes = otherPackagesOf(
    {
      id: 2,
      version: "v1.0",
      published_at: "2026-10-01T00:00:00Z",
      provider_prerelease: false,
      assets_complete: true,
      malformed_assets: 0,
      assets: ["Client-win64.zip", "Game-win64.exe.001", "Game-win64.exe.002"].map(
        (name, index) => ({
          id: 21 + index,
          name,
          url: `https://github.com/fixture-owner/x/releases/download/v1/${index}`,
          size: 100,
          sha256: sha(name),
        }),
      ),
    },
    (name) => (name.includes("win64") ? suggestion("Game-win64.7z") : undefined),
  );
  assert.deepEqual(
    exeVolumes.map((other) => [other.name, other.platforms]),
    [
      ["Game-win64.exe.001", W],
      ["Game-win64.exe.002", W],
    ],
  );
  const client = entry([artifact(windowsZip, [player("Launcher.exe")])], {}, unseen, {
    other_packages: exeVolumes,
  });
  assert.equal(reasonOf(decide(listing(), client)), "other-package-form-beside-archive");
  const forgedClient = structuredClone(generation);
  forgedClient.facts.entries[0]!.other_packages = exeVolumes;
  forgedClient.enrollments[0]!.facts_sha256 = digestOf(forgedClient.facts.entries[0]);
  assert.throws(() => gateGeneration(null, forgedClient), /Game-win64\.exe\.001/u);
});

void test("an unknown or unlisted release file competes with the archive; only the closed list is ignored (Z1)", () => {
  const releaseOf = (names: string[], id: number) => ({
    id,
    version: "v1.0",
    published_at: "2026-10-01T00:00:00Z",
    provider_prerelease: false,
    assets_complete: true,
    malformed_assets: 0,
    assets: names.map((name, index) => ({
      id: id * 10 + index,
      name,
      url: `https://github.com/fixture-owner/x/releases/download/v1/${index}`,
      size: 100,
      sha256: sha(name),
    })),
  });
  const named = (name: string) =>
    name.includes("linux")
      ? suggestion(linuxTar)
      : name.includes("win64")
        ? suggestion("Game-win64.7z")
        : undefined;
  const generation = generateRegistrations(
    [listing()],
    table(entry([artifact(windowsZip, [player("Launcher.exe")])])),
  );
  assert.equal(generation.enrollments.length, 1);
  const forge = (others: ReturnType<typeof otherPackagesOf>) => {
    const forged = structuredClone(generation);
    forged.facts.entries[0]!.other_packages = others;
    forged.enrollments[0]!.facts_sha256 = digestOf(forged.facts.entries[0]);
    return forged;
  };
  // The game as an unread `.txz` beside a Linux tarball whose single program
  // is not the game: that program never enrolls on Linux.
  const txz = otherPackagesOf(releaseOf([linuxTar, "Game-linux.txz"], 3), named);
  assert.deepEqual(
    txz.map((other) => [other.name, other.platforms]),
    [["Game-linux.txz", ["linux-x86-64"]]],
  );
  const launcher = entry([artifact(linuxTar, [player("Unseen", "elf64-x86-64")], 12)], {}, unseen, {
    other_packages: txz,
  });
  const linuxOnly = listing(unseen, { platforms: ["linux-x86-64"] });
  assert.equal(reasonOf(decide(linuxOnly, launcher)), "other-package-form-beside-archive");
  assert.equal(reasonOf(decide(linuxOnly, { ...launcher, other_packages: [] })), "fit");
  // An unknown extension competes like any unread container.
  const unknown = otherPackagesOf(releaseOf([windowsZip, "Game-win64.xyz"], 4), named);
  assert.deepEqual(
    unknown.map((other) => [other.name, other.platforms]),
    [["Game-win64.xyz", ["windows-x86-64"]]],
  );
  const beside = entry([artifact(windowsZip, [player("Launcher.exe")])], {}, unseen, {
    other_packages: unknown,
  });
  assert.equal(reasonOf(decide(listing(), beside)), "other-package-form-beside-archive");
  assert.throws(() => gateGeneration(null, forge(unknown)), /Game-win64\.xyz/u);
  // The gate names a recorded unknown container's platforms from the record
  // and refuses it too; a `.txz` recorded for Windows is refused alike.
  const txzForWindows = otherPackagesOf(releaseOf([windowsZip, "Game-win64.txz"], 5), named);
  assert.throws(() => gateGeneration(null, forge(txzForWindows)), /Game-win64\.txz/u);
  // Checksums, update metadata, decoration and notes never exclude a release.
  const ignored = otherPackagesOf(
    releaseOf(
      [
        windowsZip,
        `${windowsZip}.sha256`,
        "SHA256SUMS",
        "latest.yml",
        "screenshot.png",
        "notes.txt",
        "LICENSE-MIT",
        `${windowsZip}.sig`,
      ],
      6,
    ),
    named,
  );
  assert.deepEqual(ignored, []);
  const plain = entry([artifact(windowsZip, [player("Launcher.exe")])], {}, unseen, {
    other_packages: ignored,
  });
  assert.equal(reasonOf(decide(listing(), plain)), "fit");
  assert.doesNotThrow(() => gateGeneration(null, forge(ignored)));
});

void test("the route fit report lists every competing asset name of each withheld identity (Z1, B4)", () => {
  // As many other assets as the observer's window leaves room for beside the archive.
  const names = Array.from(
    { length: 31 },
    (_, index) => `Extra-${String(index).padStart(2, "0")}.xyz`,
  );
  const others = names.map((name, index) => ({
    asset_id: 50 + index,
    name,
    size: 2048,
    sha256: null,
    platforms: ["windows-x86-64"],
  }));
  const generation = generateRegistrations(
    [listing()],
    table(
      entry([artifact(windowsZip, [player("Launcher.exe")])], {}, unseen, {
        other_packages: others,
      }),
    ),
  );
  assert.equal(reasonOf(generation.decisions[0]!), "other-package-form-beside-archive");
  const queues = registrationQueues(generation);
  assert.deepEqual(queues.other_package_forms, {
    [unseen]: names,
  });
  const clean = generateRegistrations(
    [listing()],
    table(entry([artifact(windowsZip, [player("Launcher.exe")])])),
  );
  assert.deepEqual(registrationQueues(clean).other_package_forms, {});
});

void test("the hand-checked correct shapes still enroll (D4 iii)", () => {
  const shapes: [string, PlayerFact][] = [
    ["SOTN-v1.2.0-windows-x64.zip", player("sotn.exe")],
    ["OpenMB2-v0.3.0-linux-x86_64.tar.gz", player("OpenMB2/openmb2", "elf64-x86-64")],
    ["Woof-v15.0.0-windows.zip", player("woof-15/woof.exe")],
    ["OpenTIE-v1.0-windows-x64.zip", player("opentie.exe")],
    [
      "MiniQuake-v0.9-macos-arm64.zip",
      player("MiniQuake.app/Contents/MacOS/miniquake", "macho-arm64"),
    ],
    ["Peggle-v1.0-windows-x64.zip", player("Peggle/Peggle.exe")],
    ["PokePlatinum-v1.1.0-linux-x86_64.tar.gz", player("pokeplatinum", "elf64-x86-64")],
  ];
  for (const [name, program] of shapes) {
    const facts = entry([artifact(name, [program])]);
    assert.deepEqual(artifactExclusions(facts.artifacts[0]!), [], name);
    assert.ok(decide(listing(), facts).fit, name);
  }
});

void test("a launcher or settings program is selected with the generic wording", () => {
  for (const program of ["Launcher.exe", "GameConfig.exe", "Game_Settings.exe"]) {
    const generation = generateRegistrations(
      [listing()],
      table(entry([artifact(windowsZip, [player(`Game/${program}`)])])),
    );
    const record = generation.records[0]!;
    const guide = record.listing.manual_setup as Guide;
    assert.equal(guide.steps[2]!.instruction, genericSelection, program);
  }
});

void test("a Core refusal is scoped to its archive and its class is reported (D5)", async () => {
  const id = "zz-refused-mac";
  const macZip2 = "Game-v1.0-macos-universal.zip";
  const releases = [
    releaseWith(1, "v1.0", "2026-10-01T00:00:00Z", [
      { id: 11, name: windowsZip },
      { id: 12, name: macZip2 },
    ]),
  ];
  const inspect = byAsset({
    11: [player("Game/Game.exe")],
    12: new InspectionError(
      "Core refused the archive during inspection.",
      true,
      "core-source-invalid",
    ),
  });
  const result = await derive([listing(id)], observerReport({ [id]: { releases } }), undefined, {
    inspect,
  });
  const facts = result.table.entries[0]!;
  assert.equal(facts.ineligible, null);
  assert.deepEqual(
    facts.refused_archives.map((archive) => [archive.asset_id, archive.refusal]),
    [[12, "core-source-invalid"]],
  );
  const decision = decide(listing(id), facts);
  assert.ok(decision.fit);
  assert.deepEqual(decision.enrollment.platforms, ["windows-x86-64"]);
  assert.ok(decision.enrollment.runtimes.every((runtime) => runtime.asset_id !== 12));
  // The refusal is reused for the unchanged release: no bytes are read again.
  let reads = 0;
  await derive([listing(id)], observerReport({ [id]: { releases } }), result.table, {
    now: "2026-11-22T00:00:00.000Z",
    inspect: async (asset) => {
      reads++;
      return await inspect(asset, "windows-x86-64");
    },
  });
  assert.equal(reads, 0);
  // A refused archive whose name allows every platform blocks every platform.
  const neutral = entry([artifact()], {}, unseen, {
    refused_archives: [
      {
        asset_id: 12,
        name: neutralZip,
        size: 100,
        sha256: sha("neutral"),
        name_suggestion: suggestion(neutralZip),
        refusal: "core-unsupported",
      },
    ],
  });
  assert.equal(reasonOf(decide(listing(), neutral)), "core-refused");
  // The report queues group the refusal classes.
  const assembled = assembleCatalogRecords(shared, [listing(id)], result.table);
  assert.deepEqual(registrationQueues(assembled.generation).refusals, {
    "core-source-invalid": [id],
  });
  // The gate refuses an enrollment decided beside a refused archive that could hold its game.
  const generation = generateRegistrations([listing()], table(entry()));
  const forged = structuredClone(generation);
  forged.facts.entries[0]!.refused_archives = neutral.refused_archives;
  forged.enrollments[0]!.facts_sha256 = digestOf(forged.facts.entries[0]);
  assert.throws(() => gateGeneration(null, forged), /refused archive that could hold its game/u);
});

void test("every archive of a release is read; several for one platform are ambiguous, never counted (D6, B4)", async () => {
  const run = async (names: string[]) => {
    const id = "zz-many";
    const result = await derive(
      [listing(id)],
      observerReport({
        [id]: {
          releases: [
            releaseWith(
              1,
              "v1.0",
              "2026-10-01T00:00:00Z",
              names.map((name, index) => ({ id: 100 + index, name })),
            ),
          ],
        },
      }),
      undefined,
      {
        inspect: async (asset) =>
          asset.name.includes("linux")
            ? [player("Game/Game", "elf64-x86-64", "linux")]
            : asset.name.includes("macos")
              ? [player("Game.app/Contents/MacOS/Game", "macho-arm64", "mac")]
              : [player("Game/Game.exe", "pe-x86-64", "windows")],
      },
    );
    return result.table.entries[0]!;
  };
  // Replaces the former `too-many-assets` (six per platform, sixteen per release).
  // Every archive the observer lists is read, whatever the count.
  const all = await run([
    ...Array.from({ length: 10 }, () => windowsZip),
    ...Array.from({ length: 10 }, () => linuxTar),
    ...Array.from({ length: 11 }, () => "Game-v1.0-macos-arm64.zip"),
  ]);
  assert.equal(all.ineligible, null);
  assert.equal(all.artifacts.length, 31);
  // Several distinct archives for one platform are judged by the fit rule.
  assert.equal(reasonOf(decide(listing("zz-many"), all)), "ambiguous-artifact");
  // One archive per platform still enrolls every platform.
  const one = await run([windowsZip, linuxTar, "Game-v1.0-macos-arm64.zip"]);
  assert.ok(decide(listing("zz-many"), one).fit);
});
