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
  fileOnlyHelpers,
  toolchainNames,
  channelOnlyTag,
  gateChannelOnlyTag,
  checkFactsProvenance,
  compareCodePoints,
  machineSystem,
  registrationQueues,
  checkListingFactsTable,
  refusalReceipt,
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
  gateLauncher,
  gateProduct,
  gateStatement,
  gateListingWords,
  bodyFirstLine,
  statementText,
  listingWords,
  listingCounts,
  productIdentity,
  releaseStatement,
  sourceArchive,
  textStatement,
  observedTextStatement,
  lineStatement,
  launcherProgram,
  programRoleWord,
  gateRoleProgram,
  archiveNameAccount,
  sameProductForm,
  reliefForm,
  archiveNameTokens,
  gateArchiveAccount,
  programNameUnaccounted,
  gateProgramAccounted,
  nameForm,
  romanNumbers,
  authorHandles,
  gateHandles,
  numberTwin,
  numberTwinGroups,
  spelledNumberWords,
  gateSpelledNumbers,
  spelledNumber,
  romanValue,
  romanOf,
  laterRomanNumber,
  subtitleDroppedByName,
  literalProgramName,
  nameInitialisms,
  reliefSpelling,
  dropsLinkedNumber,
  digitRuns,
  catalogNameCollisions,
  gateCollisions,
  platformNumberWords,
  gatePlatformNumberWords,
  initialismVetoWords,
  gateInitialismVeto,
  portDescriptorWords,
  regionDescriptorWords,
  nameReliefs,
  reliefForms,
  hashToken,
  gateProviderRepository,
  neutralArchiveWords,
  nonAsciiName,
  gateNonAscii,
  blockedReasons,
  ineligibleReasons,
  gateExemptions,
  evidenceReasons,
  type BlockedReason,
  type Generation,
  gateLineNamesProduct,
  gateRoleWord,
  gateHelper,
  otherPackageForm,
  otherPackagePlatforms,
  listedRepositories,
  gateFactsAgeDays,
  gateRetentionDays,
  lastGoodRetentionDays,
  maxFactsAgeDays,
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
  listingProviderIdentity,
  projectListingObservation,
  withoutListingReleaseText,
  withReleaseText,
} from "./listing-upstream-observation.mts";
import { withholdRefused } from "./listing-facts-batch.mts";
import { accumulatedObservations } from "./listing-facts-observations.mts";
import {
  checkpoint as observerCheckpoint,
  keyOf as observerKeyOf,
  progress as observerProgress,
} from "./fixtures/upstream-checkpoint-fixture.mts";
import { observationHash, type ProviderObservation } from "./upstream-observer.mts";
import {
  artifactFact,
  cliInspector,
  coreData,
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
      // The fixture's product name: its archives (`Game-v1.0-…`) and programs
      // (`Game.exe`) are named for it. An archive or program name that is not
      // the listing's id or name or the repository name (with a version and
      // neutral words) is withheld (`archive-name-unaccounted`,
      // `program-name-unaccounted`); the original game's title is not one.
      name: "Game",
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
  // The fixture's product program: `Game` is its listing's original title.
  players: PlayerFact[] = [player("Game/Game.exe")],
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
/**
 * A listing titled for an archive's product, and an entry whose facts judged
 * release text with that listing's words: R4 withholds an archive whose
 * product shares no word with the listing or its repository.
 */
function titledFor(archive: string, fields: Record<string, unknown> = {}) {
  // The listing's name is the archive's product (the original game's title
  // accounts for nothing).
  const record = listing(unseen, {
    name: productIdentity(archive).words.join(" "),
    ...fields,
  });
  const facts = (
    artifacts: ArtifactFactV2[],
    extra: Partial<ListingFactsEntry> = {},
  ): ListingFactsEntry =>
    entry(artifacts, {}, unseen, { listing_words: listingWords(record.listing), ...extra });
  return { record, facts };
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
    listing_words: listingWords(listing(id).listing),
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
        core_prerelease: false,
        prerelease: false,
        published_at: fields.published_at ?? "2026-11-01T00:00:00.000Z",
        packaged: true,
        text: "observed" as const,
        title: null,
        statement: null,
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
  /**
   * The release's own name and body as the observer would report them
   * absent:
   * observed with neither; null: unobserved.
   */
  text?: { name: string | null; body: string | null } | null;
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
            ...(release.text === null
              ? {}
              : {
                  name: release.text?.name ?? null,
                  body: release.text?.body ?? null,
                }),
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
    /** Core's name answers; by default only the recorded ones. */
    classify?: NameClassifier;
  } = {},
): Promise<DeriveResult> {
  return await deriveListingFacts({
    records,
    observerReport: report,
    table: previous,
    ...(options.state ? { state: options.state } : {}),
    ...(options.plan ? { inspectBytes: false } : {}),
    inspect: listed(options.inspect ?? inspector()),
    classify: options.classify ?? coreClassifier,
    now: options.now ?? "2026-11-21T00:00:00.000Z",
  });
}
void test("a worker shares only successful inspection of an exact release asset", async () => {
  const ids = ["zz-game-one", "zz-game-two", "zz-game-three", "zz-game-four"];
  const repository = "fixture-owner/shared-release";
  const projectUrl = `https://github.com/${repository}`;
  const records = ids.map((id) => listing(id, { project_url: projectUrl }));
  const report = observerReport(
    Object.fromEntries(
      ids.map((id, index) => [
        id,
        {
          repository,
          repository_id: index === 3 ? 4243 : 4242,
          releases: [
            {
              ...defaultRelease(id),
              assets: [{ id: 21, name: windowsZip, sha256: sha(index === 2 ? "other" : "shared") }],
            },
          ],
        },
      ]),
    ),
  );
  for (const row of report.listings)
    row.listing_update.upstream_observation.releases[0]!.assets[0]!.url = `${projectUrl}/releases/download/v1.0/${windowsZip}`;

  const calls: string[] = [];
  const reader = inspector({}, calls);
  const result = await derive(records, report, undefined, { inspect: reader });
  assert.equal(calls.length, 3);
  assert.equal(result.bytes, 300);
  assert.equal(result.report.filter((row) => row.reused === 1).length, 1);
  assert.equal(result.table.entries.filter((entry) => entry.artifacts.length === 1).length, 4);

  let attempts = 0;
  const retry = await derive(
    records.slice(0, 2),
    { listings: report.listings.slice(0, 2) },
    undefined,
    {
      async inspect() {
        if (++attempts === 1)
          throw new InspectionError("temporary", false, "core-network", "network");
        return [player("Game/Game.exe")];
      },
    },
  );
  assert.equal(attempts, 2);
  assert.equal(retry.table.entries.filter((entry) => entry.artifacts.length === 1).length, 1);
});

void test("shared inspections retain the time needed by independent reproduction", async (context) => {
  const ids = ["zz-one-release-item", "zz-two-release-item", "zz-z-both-items"];
  const repository = "fixture-owner/shared-release";
  const projectUrl = `https://github.com/${repository}`;
  const records = ids.map((id) => listing(id, { project_url: projectUrl }));
  const first = { id: 24, name: windowsZip, sha256: sha("first-item") };
  const second = {
    id: 25,
    name: linuxTar,
    sha256: sha("second-item"),
  };
  const report = observerReport(
    Object.fromEntries(
      [[first], [second], [first, second]].map((assets, index) => [
        ids[index]!,
        { repository, releases: [{ ...defaultRelease(ids[index]!), assets }] },
      ]),
    ),
  );
  for (const row of report.listings)
    for (const asset of row.listing_update.upstream_observation.releases[0]!.assets)
      asset.url = `${projectUrl}/releases/download/v1.0/${asset.name}`;
  let clock = Date.now();
  context.mock.method(Date, "now", () => clock);
  const attempts: number[] = [];
  const result = await deriveListingFacts({
    records,
    observerReport: report,
    table: emptyFactsTable("2026-11-01T00:00:00.000Z"),
    classify: coreClassifier,
    now: "2026-11-21T00:00:00.000Z",
    identityBudgetMs: 100,
    async inspect(asset, _, deadline) {
      attempts.push(asset.id);
      if (clock + 60 >= deadline!) throw new OverBudgetError("no time left to reproduce");
      clock += 60;
      return {
        players: [asset.id === 25 ? player("Game/Game", "elf64-x86-64") : player("Game/Game.exe")],
        names: [],
        leaves: [],
      };
    },
  });
  assert.deepEqual(attempts, [24, 25, 25]);
  assert.equal(result.table.entries.filter((entry) => entry.artifacts.length === 1).length, 2);
  assert.equal(result.state.retry.find((entry) => entry.port_id === ids[2])?.cause, "runner-time");
});

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
    inspect: inspector({ [windowsZip]: [player("Game/Game.exe")] }),
  });
  const assembled = assembleCatalogRecords(shared, [...records, listing()], derived.table);
  const port = assembled.catalog.ports.find((candidate) => candidate.id === unseen);
  assert.ok(port, "generated route is an operational definition");
  assert.equal(port.summary, "Register a copy you prepared from the upstream project.");
  assert.equal(
    assembled.directory.listings.find(({ id }) => id === unseen)!.summary,
    listing().listing.summary,
  );
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
  assert.match(guide.steps[2]!.instruction, /^Select Game\.exe in your prepared copy\./u);
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
  const exe = [player("Game/Game.exe")];
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
  const exe = [player("Game/Game.exe")];
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
  const linux = artifact(linuxTar, [player("Game", "elf64-x86-64")], 12);
  const universal = artifact(
    macZip,
    [player("Game.app/Contents/MacOS/Game", "macho-universal-x86-64+arm64")],
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
    artifact(windowsZip, [player("A/Game.exe"), player("B/Game.exe")], 12),
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
    /contradicted, role-named, source or non-runtime artifact/u,
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
  // Five builds of one program on one platform no longer enroll: exactly one
  // player must survive the platform selection (fifth review at 9a0c323a;
  // before it they enrolled and the guide listed three of them).
  assert.equal(
    reasonOf(
      decide(
        listing(),
        entry([
          artifact(
            windowsZip,
            ["Game.exe", "Game-x64.exe", "Game.x64.exe", "Game_win64.exe", "Game.x86_64.exe"].map(
              (path) => player(path),
            ),
          ),
        ]),
      ),
    ),
    "ambiguous-player",
  );
  const hidden = guideOf([player("game.exe")], windowsZip);
  assert.match(hidden.references[1]!.instruction, /release v1\.0/u);
  // A name outside ASCII is never shown, and (F3, review at 997e30a5) is no
  // longer enrolled at all: it is withheld as `non-ascii-name`. Before F3
  // this row enrolled with generic wording.
  const confusable = structuredClone(entry());
  confusable.artifacts[0]!.players = [player("gаme.exe")];
  const withheld = generateRegistrations([listing()], table(confusable));
  assert.equal(reasonOf(withheld.decisions[0]!), "non-ascii-name");
  assert.equal(withheld.records[0]!.listing.manual_setup, undefined);
  assert.doesNotMatch(JSON.stringify(withheld.records[0]), /gаme/u);
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
  assert.equal(combined.archive_body_bytes, undefined);
  const measuredPlan = { ...plan, archive_body_bytes: 0 };
  const measuredShards = results.map(({ only, result }, index) => ({
    only,
    result: { ...result, archive_body_bytes: index + 1 },
  }));
  assert.equal(combineShards(measuredPlan, measuredShards).archive_body_bytes, 36);
  assert.equal(combineShards(measuredPlan, measuredShards.slice(1)).archive_body_bytes, undefined);
  assert.equal(combineShards({ ...measuredPlan, needs: [] }, []).archive_body_bytes, 0);
  assert.throws(() => combineShards(plan, [results[0]!, { ...results[0]! }]), /is in two shards/u);
});

void test("a cohort past one batch's reproduction budget completes by automatic continuation, oldest wait first, each archive read once", async () => {
  const { carryOver, reproductionBatchRequests, reproductionRequestsPerEntry } =
    await import("./listing-facts-batch.mts");
  const perBatch = reproductionBatchRequests / reproductionRequestsPerEntry;
  // The full cohort is larger than one batch, and a second wave of
  // identities that sort before it arrives while it is still carried.
  const late = Array.from(
    { length: 600 },
    (_, index) => `zz-cohort-${String(index).padStart(3, "0")}`,
  );
  const early = Array.from(
    { length: 250 },
    (_, index) => `aa-cohort-${String(index).padStart(3, "0")}`,
  );
  assert.ok(late.length > perBatch);
  const records = [...early, ...late].map((id) => listing(id));
  const reads = new Map<string, number>();
  const inspect: TestInspector = async (asset) => {
    const id = /fixture-owner\/([^/]+)\//u.exec(asset.url)![1]!;
    reads.set(id, (reads.get(id) ?? 0) + 1);
    return [player("Game/Game.exe")];
  };
  // One scheduled run: the worker derives over the accumulated observations,
  // the carry step keeps one batch's budget and queues the rest, and the
  // batch merges (its table becomes the baseline). No person acts.
  let baseline = emptyFactsTable("2026-11-01T00:00:00.000Z");
  let state: WorkerState = { format: 3, pending: [], retry: [] };
  const run = async (day: number, observed: readonly string[], waiting = state.carried ?? []) => {
    const result = await derive(
      records,
      observerReport(Object.fromEntries(observed.map((id) => [id, {}]))),
      baseline,
      { state, inspect, now: `2026-11-${String(day).padStart(2, "0")}T00:00:00.000Z` },
    );
    const batch = carryOver(baseline, result.table, reproductionBatchRequests, waiting);
    const { carried: _queue, ...rest } = result.state;
    return {
      result,
      batch,
      state: batch.waiting.length ? { ...rest, carried: batch.waiting } : rest,
    };
  };
  const land = (step: Awaited<ReturnType<typeof run>>) => {
    baseline = step.batch.table;
    state = step.state;
    return step.batch;
  };
  const first = land(await run(2, late));
  assert.equal(first.carried.length, late.length - perBatch);
  assert.equal(enrolledIds(records, baseline).length, perBatch);
  // The second wave arrives. Ordered by name alone, the identities carried
  // since the first run would wait behind it.
  const step = await run(3, [...early, ...late]);
  const byName = carryOver(baseline, step.result.table, reproductionBatchRequests, []);
  assert.ok(byName.carried.includes(late[perBatch]!));
  // Oldest wait first: the identities carried since the first run land
  // before the newer wave, which waits its turn.
  const second = land(step);
  assert.deepEqual(second.carried, [...early, ...late.slice(2 * perBatch)].toSorted());
  const enrolled = new Set(enrolledIds(records, baseline));
  assert.ok(late.slice(0, 2 * perBatch).every((id) => enrolled.has(id)));
  let day = 4;
  while (state.carried?.length) {
    land(await run(day, [...early, ...late]));
    day++;
    assert.ok(day < 10, "the cohort completes in a bounded number of runs");
  }
  // Every identity is enrolled, nothing stays queued, and each archive was
  // downloaded exactly once: carried entries reused their receipts.
  assert.deepEqual(enrolledIds(records, baseline).toSorted(), [...early, ...late].toSorted());
  assert.equal(state.carried, undefined);
  assert.equal(day, 6);
  assert.deepEqual(new Set(reads.values()), new Set([1]));
  assert.equal(reads.size, early.length + late.length);
});

void test("a carried entry's receipts are reused only for its repository id and parser version", async () => {
  const id = "zz-receipt";
  const records = [listing(id)];
  const report = observerReport({ [id]: {} });
  const reads: string[] = [];
  const inspect: TestInspector = async (asset) => {
    reads.push(asset.name);
    return [player("Game/Game.exe")];
  };
  const first = await derive(records, report, undefined, { inspect });
  const entry = first.table.entries.find((row) => row.port_id === id)!;
  assert.deepEqual(reads, [windowsZip]);
  const again = async (carried: unknown[]) => {
    reads.length = 0;
    const result = await derive(records, report, undefined, {
      inspect,
      state: { format: 3, pending: [], retry: [], carried } as WorkerState,
    });
    return { reads: [...reads], entry: result.table.entries.find((row) => row.port_id === id) };
  };
  const since = "2026-11-02T00:00:00.000Z";
  // The same release under the same id and parser version: nothing is read,
  // and the entry is the one the bytes produced.
  const reused = await again([{ since, entry }]);
  assert.deepEqual(reused.reads, []);
  assert.deepEqual(reused.entry!.artifacts, entry.artifacts);
  // A sharded run carries the queue through its plan to the combined state,
  // which the job's carry step then rewrites.
  const plan = await derive(records, report, undefined, {
    inspect,
    plan: true,
    state: { format: 3, pending: [], retry: [], carried: [{ since, entry }] },
  });
  assert.deepEqual(plan.state.carried, [{ since, entry }]);
  assert.deepEqual(combineShards(plan, []).state.carried, [{ since, entry }]);
  // Another repository id, another parser version or a malformed item: read again.
  assert.deepEqual((await again([{ since, entry: { ...entry, repository_id: 9 } }])).reads, [
    windowsZip,
  ]);
  assert.deepEqual(
    (await again([{ since, entry: { ...entry, parser_version: entry.parser_version - 1 } }])).reads,
    [windowsZip],
  );
  assert.deepEqual((await again([{ since: "not a time", entry }])).reads, [windowsZip]);
  assert.deepEqual((await again([{ since, entry: { port_id: id } }])).reads, [windowsZip]);
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
      [macZip]: [player("Game.app/Contents/MacOS/Game", "macho-universal-arm64+x86-64")],
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
  // A ...Recomp archive is not a tool, but its program names another product
  // than the archive and relates to neither the listing nor its repository:
  // F5 (review at 997e30a5) withholds it. Before F5 this row was "fit".
  // Fourth review (closed vocabulary): the archive's own name now carries
  // tokens the listing does not account for, which withholds first.
  assert.equal(reason(sampleIds.recomp), "archive-name-unaccounted");
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
  for (const name of ["HaikuQuest-v1.0-windows-x64.zip", "Switchblade-v1.0-windows-x64.zip"]) {
    const { record, facts } = titledFor(name);
    const program = `${productIdentity(name)
      .words.map((word) => word[0]!.toUpperCase() + word.slice(1))
      .join("")}.exe`;
    assert.equal(decide(record, facts([artifact(name, [player(program)])])).fit, true, name);
  }
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
    // Architecture builds of one program (the listing is named `OpenJK` for
    // its rows below). Console and bare-number builds were "fit" before the
    // closed vocabulary; `64` and `console` are unaccounted tokens now.
    [[exe("openjk.x86_64.exe"), exe("openjk.x86.exe", "pe-x86")], "fit"],
    [
      [exe("Game/Game.exe"), exe("Game/Game-64.exe"), exe("Game/Game.console.exe")],
      "ambiguous-player",
    ],
    // R2 (review at f92d6f2c): a debug build is one program by name, but a
    // role word in a program name always withholds; this row was "fit".
    // Two players running on one platform (fifth review): ambiguous; this row
    // was "fit" before.
    [[exe("Game/Game.x64.exe"), exe("Game/Game_win64.exe")], "ambiguous-player"],
    [
      [exe("Game/Game.x64.exe"), exe("Game/Game_win64.exe"), exe("Game/Game.debug.exe")],
      "role-program",
    ],
    // A number glued to the name is part of the name (H2): Doom 64 is not
    // Doom, and `Game64.exe` cannot be told from such a title by name alone.
    [[exe("Doom.exe"), exe("Doom64.exe")], "ambiguous-player"],
    [[exe("Game/Game.exe"), exe("Game/Game64.exe")], "ambiguous-player"],
    [[exe("Quake.exe"), exe("Quake32.exe")], "ambiguous-player"],
    // A tool beside the game is vetoed by name, not counted.
    [[exe("Game.exe"), exe("Patcher.exe")], "fit"],
  ];
  // The listing is named for the programs; its repository `game` accounts
  // for the `Game-…` archive (the original title no longer does).
  const openjk = listing(unseen, {
    name: "OpenJK",
    project_url: "https://github.com/fixture-owner/game",
  });
  for (const [players, reason] of cases)
    assert.equal(
      reasonOf(
        decide(
          openjk,
          entry([artifact(windowsZip, players)], {}, unseen, {
            repository: "fixture-owner/game",
            listing_words: listingWords(openjk.listing),
          }),
        ),
      ),
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
  const second = player("Game/Other.exe");
  assert.throws(
    () =>
      gateGeneration(
        null,
        withFacts((fact) => fact.players.push(second)),
      ),
    /does not name every player[\s\S]*2 distinct programs/u,
  );
  const sameName = player("Elsewhere/Game.exe", "pe-x86-64", "elsewhere");
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
    core_prerelease: true,
    prerelease: true,
    published_at: "2026-10-25T00:00:00.000Z",
    packaged: true,
    text: "observed" as const,
    title: null,
    statement: null,
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
  // The repository name accounts for the `Game-…` archives; each listing's
  // name accounts for its program.
  const repository = "fixture-owner/game";
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
  // Each listing is named for its program (closed vocabulary).
  const bound = [
    listing(pair[0], {
      name: "Spider Man",
      release_url: `https://github.com/${repository}/releases/tag/sm1-v1.0`,
    }),
    listing(pair[1], {
      name: "Spider Man 2",
      release_url: `https://github.com/${repository}/releases/tag/sm2-v1.1`,
    }),
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
      name: record.listing.name,
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
    // As the tag's first word a hex-looking word names the product (R6). A
    // hash-only tag keeps a line of its own here, but it is channel-only
    // (R-F4), so it never counts as a stable line and is never offered.
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
    // A year alone is a date, so `build-2025` is a channel build too.
    ["build-2025", true],
    // A tag that is only a commit hash is a channel build (R-F4), also with
    // build targets; a hex-looking word without a digit is no hash.
    ["abc1234", true],
    ["1a2b3c4d5e6f7a8b", true],
    ["abc1234-win64", true],
    ["deadbeef", false],
    ["1234567", false],
    ["facade1-v1.0", false],
    ["cafe2024-v2", false],
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
  // A release tagged only with a commit hash is no stable release (R-F4).
  const hashOnly = entry([artifact()], { tag: "abc1234" });
  assert.equal(reasonOf(decide(listing(), hashOnly)), "no-stable-release");
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
      core_prerelease: prerelease,
      prerelease,
      published_at,
      packaged: true,
      text: "observed" as const,
      title: null,
      statement: null,
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
      core_prerelease: prerelease,
      prerelease,
      published_at: `2026-11-0${index + 1}T00:00:00.000Z`,
      packaged: true,
      text: "observed" as const,
      title: null,
      statement: null,
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
  // The archive holds the product's own program (closed vocabulary), so each
  // row is decided by its release line alone.
  const window = (
    id: string,
    tags: string[],
    artifacts = [artifact(windowsZip, [player("Game.exe")])],
  ) =>
    entry(
      artifacts,
      {
        tag: tags.at(-1)!,
        release_id: 7 + tags.length - 1,
      },
      id,
      {
        observed_releases: tags.map((tag, index) => ({
          release_id: 7 + index,
          tag,
          core_prerelease: false,
          prerelease: false,
          published_at: `2026-11-0${index + 1}T00:00:00.000Z`,
          packaged: true,
          text: "observed" as const,
          title: null,
          statement: null,
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
  const namedLine = window(decomp, ["sotn-v1.2"]);
  assert.ok(decide(listing(decomp), namedLine).fit);
  // A line equal to the repository name is the main line.
  const own = window(decomp, ["zz-sotn-decomp-v1.2"]);
  assert.ok(decide(listing(decomp), own).fit);
  // A line the listing's name holds enrolls too.
  const studio = listing(remaster, { name: "Texture Studio" });
  const studioTools = window(
    remaster,
    [
      "texture-studio-v1.0.0",
      "texture-studio-v1.0.1",
      "texture-studio-v1.0.2",
      "texture-studio-v1.0.3",
    ],
    [named("TextureStudio-1.0-win64.zip", [player("TextureStudio.exe")], 11, "windows")],
  );
  assert.ok(decide(studio, { ...studioTools, listing_words: listingWords(studio.listing) }).fit);
  // Facts judged with another listing's words are not this listing's.
  assert.equal(reasonOf(decide(studio, tools)), "repository-mismatch");
  // The gate restates the rule from the listing alone.
  const generation = generateRegistrations([listing(decomp)], table(namedLine));
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
      core_prerelease: false,
      prerelease: false,
      published_at: `2026-11-0${index + 1}T00:00:00.000Z`,
      packaged: true,
      text: "observed" as const,
      title: null,
      statement: null,
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
  const studiopolis = titledFor("Studiopolis-v1.0-windows-x64.zip");
  const title = studiopolis.facts([
    artifact("Studiopolis-v1.0-windows-x64.zip", [player("Studiopolis.exe")], 11),
  ]);
  assert.ok(decide(studiopolis.record, title).fit);
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
function forcedGate(
  facts: ListingFactsEntry,
  assetId: number,
  record = listing(),
  platform: "windows-x86-64" | "linux-x86-64" = "windows-x86-64",
) {
  const offered = facts.artifacts.find((item) => item.asset_id === assetId)!;
  const machine = platform === "windows-x86-64" ? "pe-x86-64" : "elf64-x86-64";
  const generation = generateRegistrations([record], table(facts));
  generation.enrollments = [
    {
      port_id: record.listing.id,
      platforms: [platform],
      generator_version: 0,
      facts_sha256: digestOf(facts),
      repository: facts.repository,
      repository_id: facts.repository_id,
      release: { id: 7, tag: "v1.0", observed_at: facts.observation.observed_at },
      runtimes: [
        {
          platform,
          asset_id: assetId,
          asset_name: offered.name,
          archive_sha256: offered.sha256,
          source: "exact-release-structured",
          players: offered.players.filter((item) => item.machine === machine),
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
  const full = named("Game-v0.5.10-Windows-x64.zip", [game], 11, "windows");
  const update = named("update-0.5.10.zip", [game], 12);
  // The update archive is vetoed by its whole-word role name: the full build enrolls.
  // The listing names the full build's product (`Game`, closed vocabulary;
  // the full build was `Game-PC-…` before `pc` became an unaccounted token).
  const titled = titledFor("Game-v0.5.10-Windows-x64.zip");
  const both = titled.facts([full, update]);
  const decision = decide(titled.record, both);
  assert.ok(decision.fit, JSON.stringify(decision));
  assert.equal(decision.enrollment.runtimes[0]!.asset_name, "Game-v0.5.10-Windows-x64.zip");
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
  // The listing names each archive's product (R4 withholds an unrelated one).
  for (const title of ["Updated-Game-v1.0.zip", "Deltarune-Fan-v1.0.zip", "Patchwork-v1.0.zip"]) {
    // The program is named for the listing (closed vocabulary).
    const { record, facts } = titledFor(title);
    const program = `${productIdentity(title)
      .words.map((word) => word[0]!.toUpperCase() + word.slice(1))
      .join("")}.exe`;
    assert.ok(decide(record, facts([named(title, [player(program)], 12)])).fit, title);
  }
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
  // A role word that is also a word of the product's own name still vetoes:
  // the earlier own-name exemption is removed, and these rows assert the
  // opposite of the exemption rows it replaced (B1). The archive name alone
  // cannot tell a title word from a role suffix, so the title is withheld.
  const ownNames: [string, Record<string, unknown>][] = [
    ["Delta-Force-win64.zip", { name: "Delta Force" }],
    ["Mega-Update-Edition-v1.zip", { name: "Mega Update Edition" }],
    ["Debug-Quest-v1.zip", { original_game_title: "Debug Quest" }],
    ["Hotfix-Hero-v1.zip", { id: "hotfix-hero" }],
  ];
  for (const [title, fields] of ownNames) {
    const id = typeof fields.id === "string" ? fields.id : unseen;
    const record = listing(id, fields);
    const facts = entry([named(title, [game], 12)], {}, id, {
      listing_words: listingWords(record.listing),
    });
    assert.equal(reasonOf(decide(record, facts)), "contradictory-role", title);
    assert.ok(
      artifactExclusions(facts.artifacts[0]!).some((item) => item.reason === "asset-role-name"),
      title,
    );
    assert.match(forcedGate(facts, 12, record), /role-named/u, title);
  }
  const repositoryNamed = entry([named("Patch-Quest-v1.zip", [game], 12)], {}, unseen, {
    repository: "fixture-owner/patch-quest",
  });
  assert.equal(
    reasonOf(
      decide(
        listing(unseen, {
          project_url: "https://github.com/fixture-owner/patch-quest",
        }),
        repositoryNamed,
      ),
    ),
    "contradictory-role",
  );
  // The rule's two copies agree word by word. Camel case splits into words:
  // `DeltaSquadron` is `delta` + `squadron` and is vetoed; a glued word that
  // stays one word (`Deltaforce`, `Patchwork`, `Updated`) is not a role word.
  const occurrenceRows: [string, boolean][] = [
    ["Game-update.zip", true],
    ["Game-update7.zip", true],
    ["Game-2update.zip", true],
    ["Game-updates.zip", false],
    ["Delta-Force.zip", true],
    ["DeltaForce.zip", true],
    ["Deltaforce-v1.zip", false],
    ["Patch-Patch.zip", true],
    ["Delta-Force-win64.zip", true],
    ["DeltaSquadron-1.1-win64.zip", true],
    ["Delta-Squadron-1.1-win64.zip", true],
    ["Delta-Squadron-1.1-linux-delta.tar.gz", true],
    ["Mega-Update-Edition-v1.zip", true],
    ["update-0.5.10.zip", true],
    ["Game-1.1-linux-update1.tar.gz", true],
    ["Game-1.1-win64.zip", false],
    ["Patch-1.0.zip", true],
    ["GameUpdate-linux.tar.gz", true],
    ["GameDebug-win64.zip", true],
    ["Game-Win64-Hotfix3.zip", true],
    ["PatchWork-v1.zip", true],
    ["Patchwork-v1.zip", false],
    ["Updated-Game.zip", false],
    ["DebugQuest-v1.zip", true],
    ["Debuggery-v1.zip", false],
    // R3 (review at f92d6f2c): dedicated, headless and demo builds.
    ["Game-Dedicated-1.0-win64.zip", true],
    ["Game-Headless-1.0-linux.tar.gz", true],
    ["Game-Demo-1.0-win64.zip", true],
    ["GameDemo-1.0-win64.zip", true],
    ["Game-demo2-win64.zip", true],
    ["Demolition-1.0-win64.zip", false],
    ["Demos-1.0-win64.zip", false],
    ["Headlessness-1.0.zip", false],
  ];
  for (const [name, expected] of occurrenceRows) {
    assert.equal(archiveRoleToken(name) !== null, expected, `fit ${name}`);
    assert.equal(gateRoleWord(name), expected, `gate ${name}`);
  }
  // The gate refuses the update archive independently.
  assert.match(forcedGate(both, 12, titled.record), /role-named/u);
  assert.equal(forcedGate(both, 11, titled.record), "accepted");
});

void test("a role word vetoes its archive whatever the product's or repository's name (B1)", () => {
  const roleGame = player("Game/Game.exe", "pe-x86-64", "scenario-game");
  const linux = player("Game/Game", "elf64-x86-64", "scenario-game-linux");
  // Repository, listing name, Windows archive, Linux role archive, and whether
  // the Windows archive name is itself free of role words.
  const scenarios: [string, string, string, string, boolean][] = [
    [
      "fixture-owner/delta-squadron",
      "Delta Squadron",
      "DeltaSquadron-1.1-win64.zip",
      "Delta-Squadron-1.1-linux-delta.tar.gz",
      false,
    ],
    [
      "fixture-owner/update-tools",
      "Game",
      "Game-1.1-win64.zip",
      "Game-1.1-linux-update1.tar.gz",
      true,
    ],
    // A one-word repository name equal to the role word exempts nothing.
    [
      "o/delta",
      "Delta Squadron",
      "Delta-Squadron-1.1-win64.zip",
      "Delta-Squadron-1.1-linux-delta.tar.gz",
      false,
    ],
    [
      "o/update",
      "Space Game",
      "Space-Game-1.1-win64.zip",
      "Space-Game-1.1-linux-update.tar.gz",
      true,
    ],
    [
      "o/Patch",
      "Patch Quest",
      "Patch-Quest-1.1-win64.zip",
      "Patch-Quest-1.1-linux-patch.tar.gz",
      false,
    ],
  ];
  for (const [repository, name, windowsName, linuxName, windowsClean] of scenarios) {
    // A clean Windows archive holds the listing's own program.
    const windows = windowsClean ? player(`Game/${name.replaceAll(" ", "")}.exe`) : roleGame;
    const record = listing(unseen, {
      name,
      project_url: `https://github.com/${repository}`,
      platforms: ["windows-x86-64", "linux-x86-64"],
    });
    const both = entry(
      [named(windowsName, [windows], 11, "windows"), named(linuxName, [linux], 12, "linux")],
      {},
      unseen,
      { repository, listing_words: listingWords(record.listing) },
    );
    // Linux never enrolls from the role archive; Windows only from a name
    // without a role word.
    const decision = decide(record, both);
    if (windowsClean) {
      assert.ok(decision.fit, repository);
      assert.deepEqual(decision.enrollment.platforms, ["windows-x86-64"], repository);
      assert.equal(forcedGate(both, 11, record), "accepted", repository);
    } else {
      assert.equal(reasonOf(decision), "contradictory-role", repository);
      assert.match(forcedGate(both, 11, record), /role-named/u, repository);
    }
    // The role archive alone ends `contradictory-role`.
    const alone = entry([named(linuxName, [linux], 12, "linux")], {}, unseen, {
      repository,
      listing_words: listingWords(record.listing),
    });
    assert.equal(reasonOf(decide(record, alone)), "contradictory-role", repository);
    // A forged Linux enrollment from the role archive is refused by the gate.
    assert.match(forcedGate(both, 12, record, "linux-x86-64"), /role-named/u, repository);
  }
  // A title holding a role word as its own word is withheld until
  // attribution data vouches for the archive; a glued word is not vetoed.
  const titled = listing(unseen, { name: "Delta Squadron" });
  const only = entry(
    [named("Delta-Squadron-1.1-win64.zip", [roleGame], 11, "windows")],
    {},
    unseen,
    {
      listing_words: listingWords(titled.listing),
    },
  );
  assert.equal(reasonOf(decide(titled, only)), "contradictory-role");
  assert.match(forcedGate(only, 11, titled), /role-named/u);
  const glued = listing(unseen, { name: "Deltaforce" });
  const gluedOnly = entry(
    [named("Deltaforce-1.1-win64.zip", [player("Deltaforce.exe")], 11, "windows")],
    {},
    unseen,
    { listing_words: listingWords(glued.listing) },
  );
  assert.ok(decide(glued, gluedOnly).fit);
  assert.equal(forcedGate(gluedOnly, 11, glued), "accepted");
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
  const launcher = player("Game/Game.exe", "pe-x86-64", "game");
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
    // Versioned or renamed compiler and interpreter file leaves (R-F3);
    // never a directory, and never another extension.
    [["bin", "python3.11"], ["python3.11"], ["python"]],
    [["bin", "python3.12.exe"], ["python3.12.exe"], ["python"]],
    [["bin", "python3-config"], ["python3-config"], ["python3"]],
    [["bin", "clang-17"], ["clang-17"], ["clang"]],
    [["bin", "clang++-17"], ["clang++-17"], ["clang++"]],
    [["bin", "gcc-13"], ["gcc-13"], ["gcc"]],
    [["bin", "g++-13.exe"], ["g++-13.exe"], ["g++"]],
    [["bin", "ld.lld"], ["ld.lld"], ["ld.lld"]],
    [["zig-x86_64"], ["zig-x86_64"], ["zig"]],
    [["pythonw.exe"], ["pythonw.exe"], ["pythonw"]],
    [["python311.dll"], ["python311.dll"], []],
    [["gcc-libs", "readme.txt"], ["readme.txt"], []],
    [["clang-17", "readme.txt"], ["readme.txt"], []],
    [["pythonw", "readme.txt"], ["readme.txt"], []],
    [["python-license.txt"], ["python-license.txt"], []],
    [["gccgo"], ["gccgo"], []],
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
  // The fit's and the gate's helper derivations agree entry by entry (R-F3).
  for (const recorded of [
    "python3.11",
    "python3.11.exe",
    "python311",
    "python-3",
    "pythonw3",
    "python3-config",
    "clang-17",
    "clang++17",
    "gcc-13",
    "gcc-libs",
    "gcc-libs/",
    "zig-x86_64",
    "zig-x86_64/",
    "zig/",
    "python3.11/",
    "ld.lld",
    "lld-link",
    "python311.dll",
    "gcc.13",
    "gcc-",
    "python3..1",
  ]) {
    const fit = bundledToolchain([recorded]);
    const gate = gateHelper(recorded);
    const folderOnly = recorded.endsWith("/") && gate !== null && fileOnlyHelpers.includes(gate);
    assert.deepEqual(fit, gate === null || folderOnly ? [] : [gate], recorded);
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

  // Linux: a tarball of the game beside the same product and version as an
  // AppImage is that product in another package form: not a competitor.
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
  assert.equal(reasonOf(decide(listing(linuxId), linuxFacts)), "fit");

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
  const game = player("Game/Game.exe");
  const linuxGame = player("Game/Game", "elf64-x86-64");
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
  const macPlayer = player("Game.app/Contents/MacOS/Game", "macho-arm64");
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
  const universal = player("Game.app/Contents/MacOS/Game", "macho-universal-arm64+x86-64");
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
    // Sixth review: a `.wad` beside a desktop archive competes as a
    // container (it was ignored as a console package before).
    ["Game.wad", "container", []],
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
    // An App Installer file names an MSIX package by URI (R-F2).
    ["Game.appinstaller", "windows", W],
    ["Game-x64.AppInstaller", "windows", W],
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
      text: null,
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
  const launcher = entry([artifact(windowsZip, [player("Game.exe")])], {}, unseen, {
    other_packages: recorded.slice(0, 2),
  });
  assert.equal(reasonOf(decide(listing(), launcher)), "other-package-form-beside-archive");
  const generation = generateRegistrations(
    [listing()],
    table(entry([artifact(windowsZip, [player("Game.exe")])])),
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
      text: null,
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
  const client = entry([artifact(windowsZip, [player("Game.exe")])], {}, unseen, {
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
    text: null,
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
    table(entry([artifact(windowsZip, [player("Game.exe")])])),
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
  const launcher = entry([artifact(linuxTar, [player("Game", "elf64-x86-64")], 12)], {}, unseen, {
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
  const beside = entry([artifact(windowsZip, [player("Game.exe")])], {}, unseen, {
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
  const plain = entry([artifact(windowsZip, [player("Game.exe")])], {}, unseen, {
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
    ["Woof-v15.0.0-windows.zip", player("woof/woof.exe")],
    ["OpenTIE-v1.0-windows-x64.zip", player("opentie.exe")],
    [
      "MiniQuake-v0.9-macos-arm64.zip",
      player("MiniQuake.app/Contents/MacOS/miniquake", "macho-arm64"),
    ],
    ["Peggle-v1.0-windows-x64.zip", player("Peggle/Peggle.exe")],
    ["PokePlatinum-v1.1.0-linux-x86_64.tar.gz", player("pokeplatinum", "elf64-x86-64")],
  ];
  // Sixth review: a folder's short integer must complete an accounted name, so
  // the shape `woof-15/woof.exe` (this row's earlier program) now withholds.
  {
    const titled = titledFor("Woof-v15.0.0-windows.zip");
    const facts = titled.facts([
      artifact("Woof-v15.0.0-windows.zip", [player("woof-15/woof.exe")]),
    ]);
    assert.equal(reasonOf(decide(titled.record, facts)), "program-name-unaccounted");
  }
  for (const [name, program] of shapes) {
    const facts = entry([artifact(name, [program])]);
    assert.deepEqual(artifactExclusions(facts.artifacts[0]!), [], name);
    // The listing names the archive's product; a listing that does not is
    // withheld (R4).
    const titled = titledFor(name);
    assert.ok(decide(titled.record, titled.facts([artifact(name, [program])])).fit, name);
    const other = titledFor("Unrelated.zip");
    assert.equal(
      reasonOf(decide(other.record, other.facts([artifact(name, [program])]))),
      "archive-name-unaccounted",
      name,
    );
  }
});

void test("a launcher, settings or setup program as the only player is withheld as launcher-entry (1c)", () => {
  // Whole words of the program name, also as a camel-case part.
  for (const program of [
    "Launcher.exe",
    "GameConfig.exe",
    "Game_Settings.exe",
    "GameLauncher.exe",
    // R5 (review at f92d6f2c): launch, start, cfg, configure and loader.
    "Launch.exe",
    "StartGame.exe",
    "Game-start.exe",
    "GameCfg.exe",
    "Configure.exe",
    "GameLoader.exe",
    "Install.exe",
  ]) {
    const facts = entry([named(windowsZip, [player(`Game/${program}`)], 11, "windows")]);
    const decision = decide(listing(), facts);
    assert.equal(reasonOf(decision), "launcher-entry", program);
    assert.match((decision as { detail: string }).detail, /declares it the game's runtime entry/u);
    // The gate restates the rule: an enrollment forced past the fit is refused.
    assert.match(forcedGate(facts, 11), /launcher, settings or setup program/u, program);
    assert.equal(launcherProgram(`Game/${program}`), true, program);
  }
  // A launcher on one platform withholds the whole identity.
  const both = entry([
    named("Game-v1.0-windows.zip", [player("Game/Game.exe")], 11, "windows"),
    named("Game-v1.0-linux.tar.gz", [player("Game/launcher", "elf64-x86-64")], 12, "linux"),
  ]);
  assert.equal(
    reasonOf(decide(listing(unseen, { platforms: ["windows-x86-64", "linux-x86-64"] }), both)),
    "launcher-entry",
  );
  // Setup and installer programs are already Core tool names: excluded
  // players, never the platform's program. The launcher rule names them too,
  // as a second guard.
  for (const program of ["Setup.exe", "game-installer.exe"]) {
    const facts = entry([named(windowsZip, [player(`Game/${program}`)], 11, "windows")]);
    assert.equal(reasonOf(decide(listing(), facts)), "tool-not-game", program);
    assert.equal(launcherProgram(`Game/${program}`), true, program);
    assert.equal(gateLauncher(`Game/${program}`), true, program);
  }
  // Words that merely contain the letters are not launcher words. `Launch.exe`
  // was such a row before R5 made `launch` a launcher word; it is now above.
  for (const program of [
    "Settler.exe",
    "Game.exe",
    "Upset.exe",
    "Starfall.exe",
    "Startup.exe",
    "Restart.exe",
    "Installation.exe",
    "Loaders2.exe",
    "Cfgame.exe",
  ]) {
    assert.equal(launcherProgram(`Game/${program}`), false, program);
    assert.equal(gateLauncher(`Game/${program}`), false, program);
    // No launcher word matches; the closed vocabulary (fourth review) still
    // withholds every program that is not the product's name. These rows
    // were "fit" before it.
    assert.equal(
      reasonOf(
        decide(listing(), entry([named(windowsZip, [player(`Game/${program}`)], 11, "windows")])),
      ),
      program === "Game.exe" ? "fit" : "program-name-unaccounted",
      program,
    );
  }
  // `Configurator.exe` is no launcher word either (Core's tool veto excludes it).
  assert.equal(launcherProgram("Game/Configurator.exe"), false);
  assert.equal(gateLauncher("Game/Configurator.exe"), false);
  // The guide's generic wording stays as a second guard.
  const generation = generateRegistrations([listing()], table(entry([artifact()])));
  assert.notEqual(
    (generation.records[0]!.listing.manual_setup as Guide).steps[2]!.instruction,
    genericSelection,
  );
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

// ---------------------------------------------------------------------------
// Part J: the worker's runner limits, shard ordering and shard state.

const slowInspector =
  (log: string[] = []): ByteInspector =>
  async (asset, _platform, deadline) => {
    log.push(asset.url.split("/")[4]!);
    await new Promise((resolve) => setTimeout(resolve, 15));
    if (deadline !== undefined && Date.now() >= deadline)
      throw new OverBudgetError("The download reached the deadline.");
    return { players: [player("Game/Game.exe")], names: [], leaves: [] };
  };

void test("an identity over the budget CI can reproduce it in settles with the runner-time cause (J3)", async () => {
  const id = "zz-slow-identity";
  const run = (table: ListingFactsTable, state?: WorkerState) =>
    deriveListingFacts({
      records: [listing(id)],
      observerReport: observerReport({ [id]: {} }),
      table,
      ...(state ? { state } : {}),
      inspect: slowInspector(),
      classify: coreClassifier,
      now: "2026-11-21T00:00:00.000Z",
      identityBudgetMs: 1,
    });
  const first = await run(emptyFactsTable("2026-11-01T00:00:00.000Z"));
  // The first time it is retried, never settled as facts.
  assert.deepEqual(
    first.state.retry.map(({ port_id, cause }) => [port_id, cause]),
    [[id, "runner-time"]],
  );
  assert.equal(first.table.entries.length, 0);
  // A second consecutive one settles it ineligible, grouped by its cause.
  const second = await run(first.table, first.state);
  const entry = second.table.entries[0]!;
  assert.equal(entry.ineligible?.reason, "repeated-inspection-failure");
  assert.equal(entry.ineligible?.cause, "runner-time");
  assert.match(entry.ineligible.detail, /per-identity budget CI can reproduce/u);
  // Within the budget the identity settles normally.
  const fits = await deriveListingFacts({
    records: [listing(id)],
    observerReport: observerReport({ [id]: {} }),
    table: emptyFactsTable("2026-11-01T00:00:00.000Z"),
    inspect: slowInspector(),
    classify: coreClassifier,
    now: "2026-11-21T00:00:00.000Z",
  });
  assert.equal(fits.table.entries[0]!.ineligible, null);
  // Core running out of runner disk is transient, never a refusal (J7).
  const full = {
    stdout: JSON.stringify({
      ok: false,
      error: { code: "state", presentation: { presentation_key: "storage_full" } },
    }),
    exited: true,
  };
  assert.throws(
    () => coreData(full, "inspection"),
    (error: unknown) =>
      error instanceof InspectionError && !error.permanent && error.cause === "runner-disk",
  );
  const refused = {
    stdout: JSON.stringify({ ok: false, error: { code: "unsupported" } }),
    exited: true,
  };
  assert.throws(
    () => coreData(refused, "inspection"),
    (error: unknown) => error instanceof InspectionError && error.permanent,
  );
  // The gate restates the age bounds; they are tested equal.
  assert.equal(gateFactsAgeDays, maxFactsAgeDays);
  assert.equal(gateRetentionDays, lastGoodRetentionDays);
});

void test("an unsharded run inspects identities a deadline cut last; a sharded plan keeps no order (J4, J-F1)", async () => {
  const ids = ["zz-order-a", "zz-order-b", "zz-order-c"];
  const log: string[] = [];
  const common = {
    records: ids.map((id) => listing(id)),
    observerReport: observerReport(Object.fromEntries(ids.map((id) => [id, {}]))),
    table: emptyFactsTable("2026-11-01T00:00:00.000Z"),
    state: { format: 3 as const, pending: ["zz-order-a"], retry: [] },
    classify: coreClassifier,
    now: "2026-11-21T00:00:00.000Z",
  };
  await deriveListingFacts({ ...common, inspect: slowInspector(log) });
  assert.deepEqual(log, ["zz-order-b", "zz-order-c", "zz-order-a"]);
  // A sharded run's plan reads no bytes and returns no pending order, so its
  // shards order a previously cut identity like any other identity.
  const plan = await deriveListingFacts({
    ...common,
    inspect: slowInspector([]),
    inspectBytes: false,
  });
  assert.deepEqual(plan.state.pending, []);
});

void test("each identity's retry state comes from its own shard only (J5)", async () => {
  const ids = ["zz-retry-0", "zz-retry-1", "zz-retry-2"];
  const records = ids.map((id) => listing(id));
  const report = observerReport(Object.fromEntries(ids.map((id) => [id, {}])));
  const state: WorkerState = {
    format: 3,
    pending: [],
    retry: [
      { port_id: "zz-retry-1", since: "2026-11-18T00:00:00.000Z", failures: 2, cause: "network" },
      { port_id: "zz-retry-2", since: "2026-11-18T00:00:00.000Z", failures: 1, cause: "network" },
    ],
  };
  // zz-retry-1 recovers; zz-retry-2 fails again.
  const inspect: ByteInspector = async (asset) => {
    if (asset.url.includes("/zz-retry-2/"))
      throw new InspectionError("Download failed.", false, "core-unknown", "network");
    return { players: [player("Game/Game.exe")], names: [], leaves: [] };
  };
  const previous = emptyFactsTable("2026-11-01T00:00:00.000Z");
  const common = { records, observerReport: report, classify: coreClassifier };
  const now = "2026-11-21T00:00:00.000Z";
  const whole = await deriveListingFacts({ ...common, table: previous, state, inspect, now });
  const plan = await deriveListingFacts({
    ...common,
    table: previous,
    state,
    inspect,
    now,
    inspectBytes: false,
  });
  const results: { only: string[]; result: DeriveResult }[] = [];
  for (const only of identityShards(plan.needs.map((need) => need.port_id)))
    results.push({
      only,
      result: await deriveListingFacts({
        ...common,
        table: plan.table,
        state: plan.state,
        inspect,
        now,
        only,
      }),
    });
  const combined = combineShards(plan, results);
  assert.deepEqual(combined.state, whole.state);
  assert.deepEqual(
    combined.state.retry.map(({ port_id, failures }) => [port_id, failures]),
    [["zz-retry-2", 2]],
  );
  assert.deepEqual(combined.table, whole.table);
});

// ---------------------------------------------------------------------------
// #8569 cohort quality: withhold the doubtful by rule (1a–1c) and stop
// withholding the same product in another package form (2a–2d), plus worker
// defects (3a, 3b). Synthetic shapes only.

/** Another package form as the worker records it. */
const otherForm = (
  asset_id: number,
  name: string,
  platforms: string[],
  sha256: string | null = sha(`other-${name}`),
) => ({ asset_id, name, size: 2048, sha256, platforms });
const W = ["windows-x86-64"];
const L = ["linux-x86-64"];
const M = ["macos-x86-64", "macos-aarch64"];

void test("release text statements: title and first body line only, whole words, never the product's own words (1a)", () => {
  const repository = "fixture-owner/zz-unseen";
  const rows: [string, string | null][] = [
    ["v1.0 Beta", "beta"],
    ["Version 2.0 (beta 3)", "beta"],
    ["v2.0 RC1", "release-candidate"],
    ["1.0rc2", "release-candidate"],
    ["Release Candidate 3", "release-candidate"],
    ["Pre-release build 7", "prerelease"],
    ["pre release", "prerelease"],
    ["prerelease", "prerelease"],
    ["Alpha 4", "alpha"],
    ["alpha2", "alpha"],
    ["v1.0", null],
    ["Arc Survivors 1.0", null],
    ["Alphabet Soup 2", null],
    ["Betamax Edition", null],
    ["Source release", null],
    ["Final release", null],
    ["", null],
    // R6 (review at f92d6f2c): a qualified status word, early access and
    // unstable state a prerelease where a status stands.
    ["Public beta test", "beta"],
    ["Open alpha", "alpha"],
    ["Closed Beta for the new mode", "beta"],
    ["Early access 0.3 (unstable)", "early-access"],
    ["v0.4 Early Access", "early-access"],
    ["Game 1.0 (unstable)", "unstable"],
    ["v2.0 unstable", "unstable"],
    ["Now on the store in early access for everyone", null],
    ["Fixes an unstable framerate on start", null],
    ["Open the beta menu with F1", null],
    ["Out of early access", null],
    ["Leaving early access 1.0", null],
    ["No longer a public beta", null],
    ["Opener Beta Edition 2", null],
    ["Publicity release", null],
  ];
  for (const [line, token] of rows) {
    assert.equal(releaseStatement(line, repository), token, `fit: ${line}`);
    assert.equal(gateStatement(line, repository), token, `gate: ${line}`);
  }
  // A status word that is a word of the repository's own name is the product.
  for (const repo of ["fixture-owner/alpha-quest", "fixture-owner/AlphaQuest"]) {
    assert.equal(releaseStatement("Alpha Quest 1.0", repo), null, repo);
    assert.equal(gateStatement("Alpha Quest 1.0", repo), null, repo);
    assert.equal(releaseStatement("Alpha Quest 1.1 beta", repo), "beta", repo);
    assert.equal(gateStatement("Alpha Quest 1.1 beta", repo), "beta", repo);
  }
  // Only the first non-empty line or heading of the body is judged.
  assert.equal(bodyFirstLine("\n\n## Beta 3 is here\nMore text"), "Beta 3 is here");
  assert.deepEqual(textStatement("v1.0", "\n## Release candidate\nNotes", repository), {
    field: "body-first-line",
    token: "release-candidate",
  });
  // A project-level remark further down the body never matches.
  assert.equal(
    textStatement(
      "v1.0",
      "Fixes a crash on start.\n\nThis project is pre-release quality software; expect beta bugs.",
      repository,
    ),
    null,
  );
  // The title comes first.
  assert.deepEqual(textStatement("v1.0 Alpha", "## Beta", repository), {
    field: "title",
    token: "alpha",
  });
});

void test("a release whose title or first body line states a prerelease is never offered (1a)", async () => {
  const id = "zz-stated-prerelease";
  type Text = ReleaseSpec["text"];
  const withText = (release: ReleaseSpec, text: Text): ReleaseSpec =>
    text === undefined ? release : { ...release, text };
  const releases = (newest: Text, older?: Text) => [
    withText(releaseWith(1, "v1.0", "2026-10-01T00:00:00Z", [{ id: 11, name: windowsZip }]), older),
    withText(
      releaseWith(2, "v3.0", "2026-10-20T00:00:00Z", [{ id: 21, name: windowsZip }]),
      newest,
    ),
  ];
  const run = async (newest: ReleaseSpec["text"], older?: ReleaseSpec["text"]) =>
    (await derive([listing(id)], observerReport({ [id]: { releases: releases(newest, older) } })))
      .table.entries[0]!;
  // The provider flags v3.0 stable, but its title says beta: the worker
  // chooses v1.0, and the fit never offers it on the words alone: it is
  // withheld for a person to hand-check v3.0's text.
  const titled = await run({ name: "v3.0 Beta", body: "Notes" }, { name: "v1.0", body: null });
  assert.equal(titled.observation.tag, "v1.0");
  const newer = titled.observed_releases.find((release) => release.release_id === 2)!;
  assert.deepEqual(
    [newer.text, newer.title, newer.statement, newer.core_prerelease, newer.prerelease],
    ["observed", "v3.0 Beta", { field: "title", token: "beta" }, false, true],
  );
  assert.equal(reasonOf(decide(listing(id), titled)), "worded-prerelease-skipped");
  // The body's first heading says release candidate: the same.
  const bodied = await run({ name: "v3.0", body: "## Release Candidate 2\n\n- fixes" });
  assert.equal(bodied.observation.tag, "v1.0");
  assert.deepEqual(bodied.observed_releases.find((r) => r.release_id === 2)!.statement, {
    field: "body-first-line",
    token: "release-candidate",
  });
  // A remark further down is no statement: v3.0 is offered.
  const remark = await run({
    name: "v3.0",
    body: "Bug fixes.\n\nThis game is still pre-release quality.",
  });
  assert.equal(remark.observation.tag, "v3.0");
  assert.equal(remark.observed_releases.find((r) => r.release_id === 2)!.statement, null);
  // Older facts can include inspected bytes with unobserved release text.
  const unobserved = structuredClone(remark);
  Object.assign(
    unobserved.observed_releases.find((r) => r.release_id === 2)!,
    {
      text: "unobserved",
      title: null,
      statement: null,
    },
  );
  assert.equal(reasonOf(decide(listing(id), unobserved)), "release-text-unobserved");
  const generation = generateRegistrations([listing(id)], table(unobserved));
  assert.deepEqual(registrationQueues(generation).release_text_unobserved, [id]);
  assert.equal(generation.enrollments.length, 0);
  assert.deepEqual(
    registrationQueues(generateRegistrations([listing(id)], table(titled))).release_statements,
    {
      [id]: ["v3.0: title beta"],
    },
  );
  // The fit rule refuses an offered release whose recorded text states a
  // prerelease, and the validator refuses a statement left out of the verdict
  // or a title whose statement is not recorded.
  const forgedTitle = structuredClone(remark);
  const offered = forgedTitle.observed_releases.find((r) => r.release_id === 2)!;
  offered.title = "v3.0 beta";
  assert.throws(() => checkListingFactsTable(table(forgedTitle)), /prerelease statement/u);
  offered.statement = { field: "title", token: "beta" };
  assert.throws(() => checkListingFactsTable(table(forgedTitle)), /prerelease statement/u);
  assert.equal(reasonOf(decide(listing(id), forgedTitle)), "no-stable-release");
  // The gate re-derives the title itself and reads the recorded body statement.
  const accepted = generateRegistrations([listing(id)], table(remark));
  assert.equal(gateGeneration(null, accepted).added.length, 1);
  for (const change of [
    (release: ListingFactsEntry["observed_releases"][number]) => {
      release.title = "v3.0 RC1";
    },
    (release: ListingFactsEntry["observed_releases"][number]) => {
      release.statement = { field: "body-first-line", token: "alpha" };
    },
  ]) {
    const forged = structuredClone(accepted);
    change(forged.facts.entries[0]!.observed_releases.find((r) => r.release_id === 2)!);
    forged.enrollments[0]!.facts_sha256 = digestOf(forged.facts.entries[0]);
    assert.throws(() => gateGeneration(null, forged), /do not record as stable/u);
  }
});

void test("a toolchain in any runtime archive withholds every platform of the identity (1b)", () => {
  const both = listing(unseen, { platforms: ["windows-x86-64", "linux-x86-64"] });
  const windows = named(
    "Game-v1.0-windows.zip",
    [player("Game/Game.exe")],
    11,
    "windows",
    toolchainNames(["game", "python", "python.exe"], ["game.exe", "python.exe"]),
  );
  const linux = named("Game-v1.0-linux.tar.gz", [player("Game/game", "elf64-x86-64")], 12, "linux");
  const facts = entry([windows, linux]);
  assert.equal(reasonOf(decide(both, facts)), "bundled-toolchain");
  assert.match((decide(both, facts) as { detail: string }).detail, /every platform/u);
  // The gate refuses the clean Linux platform too.
  assert.match(forcedGate(facts, 12, both, "linux-x86-64"), /bundles python/u);
  // Without the toolchain both platforms enroll.
  const clean = entry([
    named("Game-v1.0-windows.zip", [player("Game/Game.exe")], 11, "windows"),
    linux,
  ]);
  const decision = decide(both, clean);
  assert.ok(decision.fit);
  assert.deepEqual(decision.enrollment.platforms, ["windows-x86-64", "linux-x86-64"]);
  assert.equal(forcedGate(clean, 12, both, "linux-x86-64"), "accepted");
  // A source archive (no program in its listing) never counts.
  const source = named(
    "Game-src-v1.0.zip",
    [],
    13,
    "unknown",
    toolchainNames(["make", "cmake"], ["make"]),
  );
  const withSource = entry([...clean.artifacts, source]);
  assert.ok(decide(both, withSource).fit);
  assert.equal(forcedGate(withSource, 12, both, "linux-x86-64"), "accepted");
  // A source-named archive that holds a program is an ordinary candidate
  // (F3): its toolchain withholds every platform, in fit and gate.
  const built = named(
    "Game-src-v1.0.zip",
    [player("build/Game.exe", "pe-x86-64", "built")],
    13,
    "unknown",
    toolchainNames(["make", "cmake"], ["make"]),
  );
  const withBuilt = entry([...clean.artifacts, built]);
  assert.equal(reasonOf(decide(both, withBuilt)), "bundled-toolchain");
  assert.match(
    forcedGate(withBuilt, 12, both, "linux-x86-64"),
    /Game-src-v1.0.zip bundles cmake, make/u,
  );
  // A vetoed archive (a role word) does not count either.
  const update = named(
    "Game-update-v1.0.zip",
    [player("Game/Game.exe")],
    14,
    "unknown",
    toolchainNames(["python.exe"], ["python.exe"]),
  );
  assert.ok(decide(both, entry([...clean.artifacts, update])).fit);
});

void test("product words name an asset's product and version, by fit and gate alike (2a)", () => {
  const rows: [string, string[], string[]][] = [
    ["Game-1.0-linux.tar.gz", ["game"], ["1", "0"]],
    ["Game-1.0.AppImage", ["game"], ["1", "0"]],
    ["game_1.0_amd64.deb", ["game"], ["1", "0"]],
    ["Game-1.0.flatpak", ["game"], ["1", "0"]],
    ["Game-1.0-win64.zip", ["game"], ["1", "0"]],
    ["Game-1.0-Setup.exe", ["game"], ["1", "0"]],
    ["GameSetup-v1.0.exe", ["game"], ["1", "0"]],
    ["Install-Game-1.0.exe", ["game"], ["1", "0"]],
    ["Game-1.0-macos.zip", ["game"], ["1", "0"]],
    ["Game-1.0-macos.app.zip", ["game"], ["1", "0"]],
    ["Game-1.0.dmg", ["game"], ["1", "0"]],
    ["Game-v1.0-x86_64-linux.tar.gz", ["game"], ["1", "0"]],
    ["Game-1.0-64-bit-portable.zip", ["game"], ["1", "0"]],
    ["TableTennis-Windows-v1.7.0.zip", ["table", "tennis"], ["1", "7", "0"]],
    ["GameStudio-1.0-win64.zip", ["game", "studio"], ["1", "0"]],
    ["Game-1.0-update.7z", ["game", "update"], ["1", "0"]],
    ["Game-1.0-beta2.zip", ["game"], ["1", "0"]],
    ["Lantern64-2.1.exe", ["lantern", "64"], ["2", "1"]],
    ["Setup.exe", [], []],
    ["1.0-win64.zip", [], ["1", "0"]],
    ["Game-win64.7z.001", ["game", "7", "z"], ["001"]],
  ];
  for (const [name, words, version] of rows) {
    assert.deepEqual(productIdentity(name), { words, version }, `fit: ${name}`);
    assert.deepEqual(gateProduct(name), { words, version }, `gate: ${name}`);
  }
});

void test("the same product and version in another package form is not a competitor (2a)", () => {
  const record = (platforms: string[]) => listing(unseen, { platforms });
  const enrolls = (facts: ListingFactsEntry, platforms: string[]) => {
    const decision = decide(record(platforms), facts);
    assert.ok(decision.fit, JSON.stringify(decision));
    const generation = generateRegistrations([record(platforms)], table(facts));
    assert.equal(gateGeneration(null, generation).added.length, 1);
    return generation;
  };
  // A Linux tarball beside the same game as an AppImage, a .deb or a Flatpak.
  const tarball = named(
    "Game-1.0-linux.tar.gz",
    [player("Game/game", "elf64-x86-64")],
    11,
    "linux",
  );
  for (const form of ["Game-1.0.AppImage", "Game-1.0.deb", "Game-1.0.flatpak"]) {
    const generation = enrolls(
      entry([tarball], {}, unseen, { other_packages: [otherForm(12, form, L)] }),
      L,
    );
    assert.deepEqual(registrationQueues(generation).same_product_forms, { [unseen]: [form] });
  }
  // A Windows zip beside the same game's setup program.
  const zip = named("Game-1.0-win64.zip", [player("Game/Game.exe")], 11, "windows");
  enrolls(
    entry([zip], {}, unseen, { other_packages: [otherForm(12, "Game-1.0-Setup.exe", W)] }),
    W,
  );
  // A macOS zip beside the same game's disk image.
  const mac = named(
    "Game-1.0-macos.zip",
    [player("Game.app/Contents/MacOS/Game", "macho-universal-arm64+x86-64")],
    11,
    "macos",
  );
  enrolls(entry([mac], {}, unseen, { other_packages: [otherForm(12, "Game-1.0.dmg", M)] }), M);
  // An unknown digest changes nothing: the names decide attribution.
  enrolls(
    entry([zip], {}, unseen, { other_packages: [otherForm(12, "Game-1.0-Setup.exe", W, null)] }),
    W,
  );
});

void test("other product words, versions, programs or empty words still withhold the identity (2a)", () => {
  const withheld = (artifacts: ArtifactFactV2[], form: string, platforms = W) => {
    const facts = entry(artifacts, {}, unseen, {
      other_packages: [otherForm(19, form, platforms)],
    });
    assert.equal(reasonOf(decide(listing(), facts)), "other-package-form-beside-archive", form);
    assert.match(
      forcedGate(facts, artifacts[0]!.asset_id),
      /another package for windows-x86-64/u,
      form,
    );
  };
  // A tools archive holding only a code generator beside the game's installer.
  withheld(
    [named("Codegen-1.0-win64.zip", [player("bin/rexglue.exe")], 11, "windows")],
    "Install-Game-1.0.exe",
  );
  // The same, with the tools archive named for the game: its program is not.
  withheld(
    [named("Game-1.0-win64.zip", [player("bin/rexglue.exe")], 11, "windows")],
    "Install-Game-1.0.exe",
  );
  withheld(
    [named("TableTennis-Windows-v1.7.0.zip", [player("bin/rexglue.exe")], 11, "windows")],
    "TableTennis-v1.7.0.exe",
  );
  // A small update archive beside the full build.
  withheld(
    [named("Game-1.0-win64.zip", [player("Game/Game.exe")], 11, "windows")],
    "Game-1.0-update.7z",
  );
  // A studio or tools archive beside the game's archives and installer.
  withheld(
    [named("GameStudio-1.0-win64.zip", [player("GameStudio/GameStudio.exe")], 11, "windows")],
    "Game-1.0-Setup.exe",
  );
  // Another version, empty product words, or a split volume.
  const zip = named("Game-1.0-win64.zip", [player("Game/Game.exe")], 11, "windows");
  withheld([zip], "Game-1.1-Setup.exe");
  withheld([zip], "Setup.exe");
  withheld([zip], "Game-win64.7z.001");
  // Every archive that could be offered must agree: a second archive of
  // other product words beside the game's zip keeps the form a competitor.
  withheld(
    [zip, named("Other-1.0-win64.zip", [player("Other/Other.exe")], 12, "windows")],
    "Game-1.0-Setup.exe",
  );
});

void test("names are classified by system and checksum words before the bare-binary and .pkg forms (2b, 2c)", () => {
  const rows: [string, ReturnType<typeof otherPackageForm>, string[]][] = [
    ["Game-1.0-macos", "macos", M],
    ["game-darwin-arm64", "macos", M],
    ["Game.osx", "container", []],
    ["Game-1.0-linux", "linux", L],
    ["Game-1.0-ps4.pkg", undefined, []],
    ["Game-1.0-PS5.pkg", undefined, []],
    ["Game-1.0.pkg", "macos", M],
    ["Game-1.0-SHA256SUMS", undefined, []],
    ["checksums-linux", undefined, []],
    ["game_sha512sums", undefined, []],
    ["sha256sums-of-game.txt", undefined, []],
    // Game data packs for a host engine, scripts and ahead-of-time images
    // can be or launch the program: they keep competing (F4).
    ["Game.rtz", "container", []],
    ["Game.vbmod", "container", []],
    ["base.pk4", "container", []],
    ["helper.py", "container", []],
    ["Game.dll.aot", "container", []],
    ["settings.ini", undefined, []],
    ["run.bat", "container", []],
    ["run.cmd", "container", []],
    ["run.ps1", "container", []],
    ["Game.1.0.nupkg", "container", []],
    ["Game.7z", "container", []],
    ["Game.lha", "container", []],
  ];
  for (const [name, kind, served] of rows) {
    assert.equal(otherPackageForm(name), kind, `fit: ${name}`);
    assert.equal(gateFormKind(name), kind, `gate: ${name}`);
    assert.deepEqual(gateFormPlatforms(name), served, `gate platforms: ${name}`);
  }
});

void test("source and third-party source archives are never offered and never offer a platform (2d)", () => {
  const both = listing(unseen, { platforms: ["windows-x86-64", "linux-x86-64"] });
  const zip = named("Game-1.0-windows.zip", [player("Game/Game.exe")], 11, "windows");
  const withCounts = (artifact: ArtifactFactV2, leaves: number, source_leaves: number) => ({
    ...artifact,
    listing_counts: { leaves, source_leaves },
  });
  const bare = otherForm(19, "unseen-linux", L);
  const decideWith = (extra: ArtifactFactV2) =>
    entry([zip, extra], {}, unseen, { other_packages: [bare] });
  // A neutral source archive would make Linux "offered" beside the bare
  // Linux program; as a source archive it offers nothing, so the form is
  // ignored and Windows enrolls (and is queued for review).
  for (const source of [
    named("Unseen-1.0-src.zip", [], 12),
    named("Unseen-Source-1.0.zip", [], 12),
    withCounts(named("zlib-1.3.zip", [], 12), 40, 38),
  ]) {
    const facts = decideWith(source);
    assert.ok(decide(both, facts).fit, source.name);
    assert.equal(forcedGate(facts, 11, both), "accepted", source.name);
    const generation = generateRegistrations([both], table(facts));
    assert.deepEqual(registrationQueues(generation).source_archives, { [unseen]: [source.name] });
    assert.equal(sourceArchive(source, `fixture-owner/${unseen}`), true, source.name);
  }
  // Not a source dump: it shares the product's words, holds too few source
  // files, or holds a program; the bare Linux program then competes.
  for (const data of [
    withCounts(named("Unseen-data-1.0.zip", [], 12), 40, 38),
    withCounts(named("assets-1.3.zip", [], 12), 40, 10),
  ]) {
    const facts = decideWith(data);
    assert.equal(reasonOf(decide(both, facts)), "other-package-form-beside-archive", data.name);
    assert.match(forcedGate(facts, 11, both), /another package for linux-x86-64/u, data.name);
    assert.equal(sourceArchive(data, `fixture-owner/${unseen}`), false, data.name);
  }
  // A source-named archive holding a program is no source archive (F3): it
  // stays one of the platform's archives, so the binary zip is not chosen
  // by dropping it, and it is never itself offered.
  const built = named("Unseen-src-1.0.zip", [player("Game/Game.exe")], 12);
  assert.equal(sourceArchive(built, `fixture-owner/${unseen}`), false);
  assert.equal(reasonOf(decide(listing(), entry([zip, built]))), "ambiguous-artifact");
  assert.match(forcedGate(entry([zip, built]), 11), /one of 2 different archives/u);
  assert.match(forcedGate(entry([zip, built]), 12), /source or non-runtime artifact/u);
  // Alone, it is still never offered: its own name contradicts it.
  assert.equal(reasonOf(decide(listing(), entry([built]))), "contradictory-role");
  assert.match(forcedGate(entry([built]), 12), /source or non-runtime artifact/u);
  // F3: a source-named archive holding another program keeps the platform
  // ambiguous; the game's zip never enrolls by dropping it.
  const game = named("Game-1.0-win64.zip", [player("Game/Game.exe")], 11, "windows");
  const other = named("Game-1.0-win64-source.zip", [player("Other/Other.exe")], 12, "windows");
  assert.equal(other.contradictory, false, "the fixture's name verdict is not a source role");
  const coreSource: ArtifactFactV2 = {
    ...other,
    name_suggestion: { ...other.name_suggestion, role: "source-archive" },
    contradictory: true,
  };
  for (const second of [other, coreSource]) {
    const facts = entry([game, second]);
    assert.equal(
      reasonOf(decide(listing(), facts)),
      "ambiguous-player",
      second.name_suggestion.role,
    );
    assert.match(forcedGate(facts, 11), /2 distinct programs/u, second.name_suggestion.role);
  }
  // Without programs the same name is a source archive and is ignored.
  const empty = named("Game-1.0-win64-source.zip", [], 12, "windows");
  assert.ok(decide(listing(), entry([game, empty])).fit);
  assert.equal(forcedGate(entry([game, empty]), 11), "accepted");
  // The listing counts are recorded by the worker and checked as facts.
  assert.deepEqual(listingCounts(["main.c", "Main.C", "util.h", "readme.txt", "Makefile"]), {
    leaves: 4,
    source_leaves: 3,
  });
  const forged = structuredClone(zip);
  forged.listing_counts = { leaves: 1, source_leaves: 2 };
  assert.throws(() => checkListingFactsTable(table(entry([forged]))), /listing_counts/u);
});

void test("everything the worker writes validates: a container serving no desktop platform is recorded with none (3a)", async () => {
  const id = "zz-container-none";
  const result = await derive(
    [listing(id)],
    observerReport({
      [id]: {
        releases: [
          releaseWith(1, "v1.0", "2026-10-01T00:00:00Z", [
            { id: 11, name: windowsZip },
            { id: 12, name: "Game-v1.0-android.7z" },
            { id: 13, name: "Game-win32.7z" },
            { id: 14, name: "Game-1.0-ps4.pkg" },
          ]),
        ],
      },
    }),
  );
  const facts = result.table.entries[0]!;
  assert.equal(facts.ineligible, null, JSON.stringify(facts.ineligible));
  assert.deepEqual(
    facts.other_packages.map((other) => [other.name, other.platforms]),
    [
      ["Game-v1.0-android.7z", []],
      ["Game-win32.7z", []],
    ],
  );
  assert.deepEqual(facts.asset_names, [
    "Game-v1.0-android.7z",
    "Game-win32.7z",
    "Game-1.0-ps4.pkg",
  ]);
  // Round trip: the table and every entry the worker wrote validate.
  assert.doesNotThrow(() => checkListingFactsTable(result.table));
  assert.ok(decide(listing(id), facts).fit);
  assert.equal(
    gateGeneration(null, generateRegistrations([listing(id)], result.table)).added.length,
    1,
  );
  // Only a container may serve no platform.
  const forged = structuredClone(facts);
  forged.other_packages = [{ ...forged.other_packages[0]!, name: "Game.exe", platforms: [] }];
  forged.asset_names = ["Game.exe"];
  assert.throws(() => checkListingFactsTable(table(forged)), /platforms its form serves/u);
});

void test("every archive answering 404 is upstream-unavailable; one 404 is that archive's refusal (3b)", async () => {
  const id = "zz-not-found";
  const notFound = () =>
    new InspectionError("Download failed: 404 Not Found.", true, "asset-not-found");
  const releases = [
    releaseWith(1, "v1.0", "2026-10-01T00:00:00Z", [
      { id: 11, name: windowsZip },
      { id: 12, name: linuxTar },
    ]),
  ];
  const all = await derive([listing(id)], observerReport({ [id]: { releases } }), undefined, {
    inspect: byAsset({ 11: notFound(), 12: notFound() }),
  });
  const gone = all.table.entries[0]!;
  assert.equal(gone.ineligible?.reason, "upstream-unavailable");
  assert.equal(reasonOf(decide(listing(id), gone)), "upstream-unavailable");
  const one = await derive([listing(id)], observerReport({ [id]: { releases } }), undefined, {
    inspect: byAsset({ 12: notFound() }),
  });
  const partly = one.table.entries[0]!;
  assert.equal(partly.ineligible, null);
  assert.deepEqual(
    partly.refused_archives.map((archive) => [archive.asset_id, archive.refusal]),
    [[12, "asset-not-found"]],
  );
  // The download itself: 404 is a permanent refusal, 5xx stays transient.
  const original = globalThis.fetch;
  const work = await mkdtemp(join(tmpdir(), "portcove-404-"));
  try {
    const received: number[] = [];
    const inspect = cliInspector("/nonexistent/portcove", work, {
      recordArchiveBodyBytes: (bytes) => received.push(bytes),
    });
    const asset = {
      id: 11,
      name: windowsZip,
      url: "https://github.com/fixture-owner/x/releases/download/v1/11",
      size: 100,
      sha256: sha("bytes"),
    };
    for (const [status, permanent, refusal] of [
      [404, true, "asset-not-found"],
      [503, false, "core-unknown"],
      [500, false, "core-unknown"],
      [429, false, "core-unknown"],
    ] as const) {
      globalThis.fetch = async () => new Response(null, { status });
      await assert.rejects(inspect(asset, "windows-x86-64"), (error: unknown) => {
        assert.ok(error instanceof InspectionError, String(status));
        assert.equal(error.permanent, permanent, String(status));
        assert.equal(error.refusal, refusal, String(status));
        if (!permanent) assert.equal(error.cause, "network", String(status));
        return true;
      });
    }
    assert.deepEqual(received, [0, 0, 0, 0]);
    globalThis.fetch = async () => new Response("partial");
    await assert.rejects(
      inspect(asset, "windows-x86-64"),
      (error: unknown) => error instanceof InspectionError && error.refusal === "digest-mismatch",
    );
    assert.equal(received.at(-1), 7, "a failed archive still records its received body");
    await assert.rejects(
      inspect({ ...asset, size: 4 }, "windows-x86-64"),
      (error: unknown) => error instanceof InspectionError && error.refusal === "size-exceeded",
    );
    assert.equal(received.at(-1), 7, "received bytes can exceed the provider size");
  } finally {
    globalThis.fetch = original;
    await rm(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Review repairs: the fit rule and the gate agree on launcher identities (B1),
// product-named programs (B2, F2), release text (F1), source-named archives
// holding programs (F3) and data packs (F4).

const allPlatforms = ["windows-x86-64", "linux-x86-64", "macos-x86-64", "macos-aarch64"];
const runningOn: Record<string, (machine: string) => boolean> = Object.fromEntries(
  allPlatforms.map((platform) => [platform, (machine: string) => machineRunsOn(machine, platform)]),
);
/** The gate's verdict on one enrollment forced onto these facts for one artifact and platform. */
function forcedOn(
  facts: ListingFactsEntry,
  record: AuthoredPort,
  assetId: number,
  platform: string,
) {
  const offered = facts.artifacts.find((item) => item.asset_id === assetId)!;
  const generation = generateRegistrations([record], table(facts));
  generation.enrollments = [
    {
      port_id: record.listing.id,
      platforms: [platform],
      generator_version: 0,
      facts_sha256: digestOf(facts),
      repository: facts.repository,
      repository_id: facts.repository_id,
      release: {
        id: facts.observation.release_id!,
        tag: facts.observation.tag!,
        observed_at: facts.observation.observed_at,
      },
      runtimes: [
        {
          platform,
          asset_id: assetId,
          asset_name: offered.name,
          archive_sha256: offered.sha256,
          source: "exact-release-structured",
          players: offered.players.filter((item) => runningOn[platform]!(item.machine)),
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

void test("a launcher on a platform the fit would not enroll still refuses every forged runtime (B1)", () => {
  const record = listing(unseen, { platforms: ["windows-x86-64", "linux-x86-64"] });
  // The fit withholds the identity; a forged Windows-only enrollment from
  // the clean Windows zip is refused by the gate as well.
  const facts = entry([
    named("Game-win64.zip", [player("Game/Game.exe")], 11, "windows"),
    named("Game-linux.tar.gz", [player("Game/launcher", "elf64-x86-64")], 12, "linux"),
  ]);
  assert.equal(reasonOf(decide(record, facts)), "launcher-entry");
  assert.match(forcedGate(facts, 11, record), /only program on linux-x86-64/u);
  assert.match(forcedGate(facts, 12, record, "linux-x86-64"), /launcher, settings or setup/u);
  // The cross-platform shape of the 1c test, forced past the fit.
  const both = entry([
    named("Game-v1.0-windows.zip", [player("Game/Game.exe")], 11, "windows"),
    named("Game-v1.0-linux.tar.gz", [player("Game/launcher", "elf64-x86-64")], 12, "linux"),
  ]);
  assert.match(forcedGate(both, 11, record), /only program on linux-x86-64/u);
  // A launcher that is not the platform's one program, or one the fit cannot
  // decide (a refused archive beside it, a second archive), does not refuse
  // the identity: the fit enrolls Windows and the gate accepts it.
  for (const linux of [
    [
      named(
        "Game-linux.tar.gz",
        [player("Game/launcher", "elf64-x86-64"), player("Game/game", "elf64-x86-64")],
        12,
        "linux",
      ),
    ],
    [
      named("Game-linux.tar.gz", [player("Game/launcher", "elf64-x86-64")], 12, "linux"),
      named("Game-extra-linux.tar.gz", [player("Game/launcher", "elf64-x86-64", "x")], 13, "linux"),
    ],
  ]) {
    const mixed = entry([
      named("Game-win64.zip", [player("Game/Game.exe")], 11, "windows"),
      ...linux,
    ]);
    const decision = decide(record, mixed);
    assert.ok(decision.fit, JSON.stringify(decision));
    assert.deepEqual(decision.enrollment.platforms, ["windows-x86-64"]);
    assert.equal(forcedGate(mixed, 11, record), "accepted");
  }
});

void test("the gate refuses every enrollment the fit did not choose, over generated entries (B1, F3)", () => {
  const random = seeded(8630);
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const names: [string, string][] = [
    ["Game-win64.zip", "windows"],
    ["Game-1.0-win64.zip", "windows"],
    ["Game-linux.tar.gz", "linux"],
    ["Game-1.0-linux.tar.gz", "linux"],
    ["Game-macos.zip", "macos"],
    ["Game-1.0.zip", "unknown"],
    ["Game-1.0-win64-source.zip", "windows"],
    ["Game-src.zip", "unknown"],
    ["Game-1.0-update.zip", "unknown"],
  ];
  const programs = [
    "Game/Game.exe",
    "Game/Launcher.exe",
    "Game/Other.exe",
    "Game/game",
    "Game/launcher",
    "Tools/Game.exe",
    "Game.app/Contents/MacOS/Game",
  ];
  const machines = [
    "pe-x86-64",
    "pe-x86-64",
    "elf64-x86-64",
    "elf64-x86-64",
    "macho-universal-arm64+x86-64",
    "macho-arm64",
    "pe-x86",
  ];
  const forms = ["Game-1.0-Setup.exe", "Game-1.0.AppImage", "Game.7z", "SHA256SUMS", "Tool.exe"];
  const record = listing(unseen, { platforms: allPlatforms });
  let forced = 0;
  let fits = 0;
  let launchers = 0;
  for (let round = 0; round < 1500; round++) {
    const artifacts = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, index) => {
      const [name, os] = pick(names);
      const count = Math.floor(random() * 3);
      const players = [
        ...new Map(
          Array.from({ length: count }, () => {
            const path = pick(programs);
            const machine = pick(machines);
            return [path, player(path, machine, random() < 0.3 ? "shared" : path)];
          }),
        ).values(),
      ];
      return named(name, players, 11 + index, os);
    });
    const extra: Partial<ListingFactsEntry> = {};
    if (random() < 0.2) {
      const name = pick(forms);
      const kind = otherPackageForm(name);
      if (kind !== undefined)
        extra.other_packages = [
          otherForm(30, name, kind === "container" ? allPlatforms : gateFormPlatforms(name)),
        ];
    }
    if (random() < 0.1)
      extra.refused_archives = [
        {
          asset_id: 40,
          name: "Game-linux-x64.zip",
          size: 100,
          sha256: sha("refused"),
          name_suggestion: { ...suggestion(neutralZip), os: "linux" },
          refusal: "core-unsupported",
        },
      ];
    const facts = entry(artifacts, {}, unseen, extra);
    const decision = decide(record, facts);
    if (decision.fit) fits++;
    else if (decision.reason === "launcher-entry") launchers++;
    const chosen = new Set(
      decision.fit
        ? decision.enrollment.runtimes.map((runtime) => `${runtime.platform}|${runtime.asset_id}`)
        : [],
    );
    for (const artifact of facts.artifacts)
      for (const platform of allPlatforms) {
        const verdict = forcedOn(facts, record, artifact.asset_id, platform);
        if (chosen.has(`${platform}|${artifact.asset_id}`)) continue;
        forced++;
        assert.notEqual(
          verdict,
          "accepted",
          `${platform} ${artifact.name} ${JSON.stringify(artifact.players.map((p) => [p.display_path, p.machine]))} beside ${JSON.stringify(facts.artifacts.map((a) => [a.name, a.players.map((p) => [p.display_path, p.machine])]))} fit=${decision.fit ? "fit" : decision.reason}`,
        );
      }
    if (decision.fit)
      assert.equal(
        gateGeneration(null, generateRegistrations([record], table(facts))).added.length,
        1,
      );
  }
  assert.ok(forced > 3000, `only ${forced} forged enrollments`);
  assert.ok(fits > 50, `only ${fits} fits`);
  assert.ok(launchers > 20, `only ${launchers} launcher-entry identities`);
});

void test("only a program named exactly for the product relieves another package form (B2, F2)", () => {
  // The listing names the archive's product unless a row says otherwise, so
  // each row tests the program name alone.
  const titled = (artifact: ArtifactFactV2, platforms: string[], title?: string) =>
    listing(unseen, {
      platforms,
      name: title ?? productIdentity(artifact.name).words.join(" "),
    });
  const factsOf = (
    record: AuthoredPort,
    artifact: ArtifactFactV2,
    form: string,
    platforms: string[],
  ) =>
    entry([artifact], {}, unseen, {
      listing_words: listingWords(record.listing),
      other_packages: [otherForm(19, form, platforms)],
    });
  const withheld = (
    artifact: ArtifactFactV2,
    form: string,
    platforms: string[],
    title?: string,
  ) => {
    const record = titled(artifact, platforms, title);
    const facts = factsOf(record, artifact, form, platforms);
    assert.equal(reasonOf(decide(record, facts)), "other-package-form-beside-archive", form);
    assert.match(
      forcedOn(facts, record, artifact.asset_id, platforms[0]!),
      /another package for/u,
      `gate: ${artifact.name} beside ${form}`,
    );
  };
  const enrolls = (artifact: ArtifactFactV2, form: string, platforms: string[]) => {
    const record = titled(artifact, platforms);
    const facts = factsOf(record, artifact, form, platforms);
    const decision = decide(record, facts);
    assert.ok(decision.fit, `${artifact.name} beside ${form}: ${JSON.stringify(decision)}`);
    assert.equal(
      gateGeneration(null, generateRegistrations([record], table(facts))).added.length,
      1,
      `gate: ${artifact.name} beside ${form}`,
    );
  };
  const windows = (name: string, program: string) => named(name, [player(program)], 11, "windows");
  const linux = (name: string, program: string) =>
    named(name, [player(program, "elf64-x86-64")], 11, "linux");
  // A NAME never establishes that the archive is the game: a program that
  // merely shares a word with, starts with, or contains the product is
  // another program.
  withheld(windows("Game-1.0-win64.zip", "Game/GameCodegen.exe"), "Game-1.0-Setup.exe", W);
  withheld(windows("Game-1.0-win64.zip", "GameRecomp.exe"), "Install-Game-1.0.exe", W);
  withheld(linux("Game-1.0-linux.tar.gz", "game-gen"), "Game-1.0.AppImage", L);
  withheld(windows("The-Game-1.0-win64.zip", "the-mapper.exe"), "The-Game-1.0-Setup.exe", W);
  withheld(windows("TableGame-1.0-win64.zip", "Table.exe"), "TableGame-1.0-Setup.exe", W);
  withheld(windows("Game-1.0-win64.zip", "Game/MyGame.exe"), "Game-1.0-Setup.exe", W);
  // B2 (review at f92d6f2c): the program name is compared LITERALLY with
  // the product: no trailing-digit pop, no variant-word drop and no
  // architecture-word allowance. These rows enrolled before the literal
  // rule (`Game-x64.exe`, `game.x86_64`, `supergame2.exe`) and are now
  // withheld.
  for (const program of [
    "Game/Game-debug.exe",
    "Game/Game2.exe",
    "Game/Game-2.exe",
    "Game/Game64.exe",
    "Game/Game-x64.exe",
    "Game/Game.console.exe",
  ])
    withheld(windows("Game-1.0-win64.zip", program), "Game-1.0-Setup.exe", W);
  withheld(linux("Game-1.0-linux.tar.gz", "Game/game.x86_64"), "game_1.0_amd64.deb", L);
  withheld(windows("Super-Game-1.0-win64.zip", "supergame2.exe"), "Super-Game-1.0-Setup.exe", W);
  // R4: the relief attributes the other form to the LISTING's product: the
  // same product as the archive is not enough when the listing names another.
  withheld(
    windows("Game-1.0-win64.zip", "Game/Game.exe"),
    "Game-1.0-Setup.exe",
    W,
    "Different Title",
  );
  // The product's own program, named literally, still relieves.
  enrolls(windows("Game-1.0-win64.zip", "Game/Game.exe"), "Game-1.0-Setup.exe", W);
  for (const form of ["Game-1.0.AppImage", "Game-1.0.deb", "Game-1.0.flatpak"])
    enrolls(linux("Game-1.0-linux.tar.gz", "Game"), form, L);
  enrolls(linux("Game-1.0-linux.tar.gz", "Game/game"), "game_1.0_amd64.deb", L);
  enrolls(
    named(
      "Game-1.0-macos.zip",
      [player("Game.app/Contents/MacOS/Game", "macho-universal-arm64+x86-64")],
      11,
      "macos",
    ),
    "Game-1.0.dmg",
    M,
  );
  enrolls(windows("Super-Game-1.0-win64.zip", "Super_Game.exe"), "Super-Game-1.0-Setup.exe", W);
  enrolls(windows("TableGame-1.0-win64.zip", "Table_Game.exe"), "TableGame-1.0-Setup.exe", W);
  // F2: a Debian revision, an unversioned AppImage and trailing zero
  // components are the same version.
  enrolls(linux("Game-1.0-linux.tar.gz", "Game"), "game_1.0-1_amd64.deb", L);
  enrolls(linux("Game-1.0-linux.tar.gz", "Game"), "Game.AppImage", L);
  enrolls(linux("Game-1.0.0-linux.tar.gz", "Game"), "Game-1.0.AppImage", L);
  enrolls(windows("Game-1.0-win64.zip", "Game/Game.exe"), "Game-1.0.0-Setup.exe", W);
  // Another version, and any other unversioned form, still compete.
  withheld(linux("Game-1.0-linux.tar.gz", "Game"), "game_1.1-1_amd64.deb", L);
  withheld(linux("Game-1.0-linux.tar.gz", "Game"), "Game-1.0.1.AppImage", L);
  withheld(windows("Game-1.0-win64.zip", "Game/Game.exe"), "Game-Setup.exe", W);
  withheld(windows("Game-1.0-win64.zip", "Game/Game.exe"), "Game.7z", W);
  for (const [name, words, version] of [
    ["game_1.0-1_amd64.deb", ["game"], ["1", "0"]],
    ["game_1.0-12.deb", ["game"], ["1", "0"]],
    ["Game-1.0-1.zip", ["game"], ["1", "0", "1"]],
  ] as const) {
    assert.deepEqual(productIdentity(name), { words, version }, `fit: ${name}`);
    assert.deepEqual(gateProduct(name), { words, version }, `gate: ${name}`);
  }
});

void test("a generator glued to the game's name beside the AppImage is withheld (B2, Linux pin)", async () => {
  const id = "zz-codegen-glued-linux";
  const run = await derive(
    [listing(id, { platforms: ["linux-x86-64"] })],
    observerReport({
      [id]: {
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
    { inspect: byAsset({ 11: [player("bin/gamegen", "elf64-x86-64")] }) },
  );
  const facts = run.table.entries[0]!;
  assert.deepEqual(
    facts.other_packages.map((other) => other.name),
    ["Game-v1.0.AppImage"],
  );
  const record = listing(id, { platforms: ["linux-x86-64"] });
  assert.equal(reasonOf(decide(record, facts)), "other-package-form-beside-archive");
  assert.match(forcedOn(facts, record, 11, "linux-x86-64"), /another package for linux-x86-64/u);
});

void test("a status word states a prerelease only where a status stands (F1)", () => {
  const repository = "fixture-owner/zz-unseen";
  const rows: [string, string | null][] = [
    // (iii) next to a version, last in the title, or parenthesised.
    ["Game 1.0 (Beta)", "beta"],
    ["[RC] Game 1.0 for everyone", "release-candidate"],
    ["v2.0-beta.2", "beta"],
    ["Beta build 7", "beta"],
    ["Game 2.0 beta", "beta"],
    ["This is beta software for testing", null],
    ["Join the alpha test group on our forum", null],
    ["Beta testers wanted for the new mode", null],
    // (ii) URLs, link targets, image references and compare ranges.
    ["Full Changelog: https://github.com/o/r/compare/v0.9-beta...v1.0", null],
    ["**Full Changelog**: v0.9-beta...v1.0", null],
    ["![banner](beta.png) Version 1.0", null],
    ['<img src="beta.png"> Version 1.0', null],
    ["See [the notes](https://example.com/beta-2) for v1.0", null],
    ["Download at www.example.com/beta 2", null],
    ["Screenshot beta.png attached", null],
    ["[Beta 2](https://example.com/notes)", "beta"],
    // (iv) negations and past transitions.
    ["Out of beta", null],
    ["No longer a release candidate", null],
    ["Changes since beta 3", null],
    ["Changes since the last beta", null],
    ["Not a beta: v1.0", null],
    ["Graduated from alpha 4", null],
    ["Final Beta", "beta"],
    ["Beta 3 is out", "beta"],
  ];
  for (const [line, token] of rows) {
    assert.equal(releaseStatement(line, repository), token, `fit: ${line}`);
    assert.equal(gateStatement(line, repository), token, `gate: ${line}`);
  }
  // (i) and (v): the listing's name, title and id words are the product's
  // own words before the first version; after a version they state again.
  const listingRows: [string, string, Record<string, unknown>, string | null][] = [
    ["Alpha Centauri Port v1.0", "fixture-owner/smac-port", { name: "Alpha Centauri" }, null],
    ["Alpha Centauri Port v1.0", "fixture-owner/smac-port", { name: "Other" }, null],
    [
      "Alpha Centauri 1.0",
      "fixture-owner/smac-port",
      { original_game_title: "Alpha Centauri" },
      null,
    ],
    ["Beta Squadron 1.2", "fixture-owner/squadron", { name: "Beta Squadron" }, null],
    ["Beta Squadron 1.2", "fixture-owner/squadron", { name: "Squadron" }, null],
    ["Super Beta 2", "fixture-owner/sb", { name: "Super Beta" }, null],
    ["Super Beta 2", "fixture-owner/sb", { name: "Super Game" }, "beta"],
    ["RC Racing v3", "fixture-owner/racing", { id: "rc-racing" }, null],
    ["RC Racing v3", "fixture-owner/racing", { name: "Racing" }, null],
    ["Beta Squadron 1.3 Beta 2", "fixture-owner/squadron", { name: "Beta Squadron" }, "beta"],
    ["Beta Squadron 1.3 (beta)", "fixture-owner/squadron", { name: "Beta Squadron" }, "beta"],
    ["Beta Squadron", "fixture-owner/squadron", { name: "Beta Squadron" }, null],
    ["v1.2 Beta", "fixture-owner/beta", { name: "Beta" }, "beta"],
    ["RC Racing v3 RC1", "fixture-owner/racing", { id: "rc-racing" }, "release-candidate"],
  ];
  for (const [line, repo, fields, token] of listingRows) {
    const words = listingWords({ id: "zz-listing", name: "Zz", ...fields });
    assert.equal(
      releaseStatement(line, repo, words),
      token,
      `fit: ${line} ${JSON.stringify(fields)}`,
    );
    assert.equal(
      gateStatement(line, repo, words),
      token,
      `gate: ${line} ${JSON.stringify(fields)}`,
    );
  }
  // The body's first line is judged after removing what states nothing: a
  // banner image line or a link-only line is skipped.
  assert.equal(bodyFirstLine("![beta](beta.png)\n\nVersion 1.0 is here"), "Version 1.0 is here");
  assert.equal(
    textStatement(
      "v1.0",
      "**Full Changelog**: https://github.com/o/r/compare/v0.9-beta...v1.0",
      repository,
    ),
    null,
  );
  assert.deepEqual(textStatement("v1.0", "![x](y.png)\nBeta 2 of the new engine", repository), {
    field: "body-first-line",
    token: "beta",
  });
});

void test("fit and gate read release text alike over generated lines (F1)", () => {
  const random = seeded(8631);
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const pieces = [
    "beta",
    "Beta",
    "alpha",
    "RC",
    "rc2",
    "pre",
    "release",
    "Pre-release",
    "candidate",
    "prerelease",
    "v1.0",
    "1.0rc1",
    "2",
    "3.1",
    "build",
    "version",
    "out",
    "of",
    "no",
    "longer",
    "since",
    "the",
    "last",
    "a",
    "game",
    "squadron",
    "(",
    ")",
    "[",
    "]",
    "beta.png",
    "![x](beta.png)",
    "https://x.io/beta",
    "v0.9-beta...v1.0",
    "beta._2",
    "1._x._beta",
    "_",
    ".",
    "-",
    ":",
    "<b>",
    "[link](https://x.io/rc1)",
    "...",
    "..",
    "…",
    "....",
    "finally",
    "<html>",
    "</body>",
    "<font color=red>",
    "<style>x</style>",
    "<Beta 3>",
    '<a title="',
    "<a title='",
    '">',
    "'>",
    "\n\n",
    "\r\n\r\n",
    "\n",
  ];
  const repositories = ["fixture-owner/beta-squadron", "fixture-owner/game", "fixture-owner/rc"];
  const listings = [[], ["beta", "squadron"], ["game"], ["alpha"]];
  let stated = 0;
  for (let round = 0; round < 20_000; round++) {
    const line = Array.from({ length: 1 + Math.floor(random() * 7) }, () => pick(pieces)).join(
      pick([" ", " ", "", "-"]),
    );
    const repository = pick(repositories);
    const words = pick(listings);
    const fit = releaseStatement(line, repository, words);
    assert.equal(
      gateStatement(line, repository, words),
      fit,
      `${line} ${repository} ${words.join(",")}`,
    );
    if (fit !== null) stated++;
  }
  assert.ok(stated > 2000 && stated < 18_000, `${stated} statements`);
});

void test("release text is judged with the listing's own words by worker, fit and gate (F1)", async () => {
  const id = "zz-beta-squadron";
  // The repository `game` accounts for the `Game-…` archive and program.
  const repository = "fixture-owner/game";
  const record = listing(id, {
    name: "Beta Squadron",
    project_url: `https://github.com/${repository}`,
  });
  const releases = [
    {
      ...releaseWith(1, "v1.0", "2026-10-01T00:00:00Z", [{ id: 11, name: windowsZip }]),
      text: { name: "Beta Squadron 1.0", body: null },
    },
    {
      ...releaseWith(2, "v3.0", "2026-10-20T00:00:00Z", [{ id: 21, name: windowsZip }]),
      text: {
        name: "Beta Squadron 3.0",
        body: "**Full Changelog**: https://github.com/o/r/compare/v3.0-beta...v3.0",
      },
    },
  ];
  const run = await derive([record], observerReport({ [id]: { repository, releases } }));
  const facts = run.table.entries[0]!;
  assert.deepEqual(facts.listing_words, ["beta", "squadron", "zz"]);
  assert.equal(facts.observation.tag, "v3.0");
  assert.deepEqual(
    facts.observed_releases.map((release) => release.statement),
    [null, null],
  );
  const decision = decide(record, facts);
  assert.ok(decision.fit, JSON.stringify(decision));
  assert.equal(gateGeneration(null, generateRegistrations([record], table(facts))).added.length, 1);
  // A trailing status after the version is a prerelease again: v1.0 is offered.
  const second = await derive(
    [record],
    observerReport({
      [id]: {
        repository,
        releases: [
          releases[0]!,
          { ...releases[1]!, text: { name: "Beta Squadron 3.0 Beta 2", body: null } },
        ],
      },
    }),
  );
  assert.equal(second.table.entries[0]!.observation.tag, "v1.0");
  // Facts judged with other words are refused by the facts check (a title
  // statement left out), the fit rule and the gate.
  const forged = structuredClone(facts);
  forged.listing_words = ["squadron", "zz"];
  forged.observed_releases[1]!.title = "Squadron 3.0 Beta";
  assert.throws(() => checkListingFactsTable(table(forged)), /prerelease statement/u);
  const renamed = structuredClone(facts);
  renamed.listing_words = ["other", "zz"];
  assert.equal(reasonOf(decide(record, renamed)), "repository-mismatch");
  const generation = generateRegistrations([record], table(facts));
  generation.facts = table(renamed);
  generation.enrollments[0]!.facts_sha256 = digestOf(renamed);
  assert.throws(() => gateGeneration(null, generation), /other listing words/u);
  assert.deepEqual(gateListingWords(record.listing), listingWords(record.listing));
});

void test("role words in program names and folders, role archives and unrelated archives withhold, in fit and gate (R2, R3, R4)", () => {
  // R2: a role word in a program's file name or in any folder of its path
  // always withholds the whole identity; the gate refuses a forced runtime.
  for (const program of [
    "Game/Game-debug.exe",
    "Game/Game-dedicated.exe",
    "Game/Game-demo.exe",
    "Game/Game-headless.exe",
    "Game/GameServer.exe",
    "Game/GameEditor.exe",
    "server/Game.exe",
    "tools/Game.exe",
    "editor/Game.exe",
    "Game/sdk/Game.exe",
    "Game Demo/Game.exe",
  ]) {
    assert.ok(programRoleWord(program) !== null, `fit ${program}`);
    assert.ok(gateRoleProgram(program), `gate ${program}`);
    const facts = entry([named(windowsZip, [player(program)], 11, "windows")]);
    const decision = decide(listing(), facts);
    assert.ok(!decision.fit, program);
    assert.ok(
      ["role-program", "tool-not-game"].includes(reasonOf(decision)),
      `${program}: ${reasonOf(decision)}`,
    );
    if (facts.artifacts[0]!.players.length) {
      assert.equal(reasonOf(decision), "role-program", program);
      assert.match(forcedGate(facts, 11), /another role than the game/u, program);
    }
  }
  // Beside the game's own program, in the same archive, it still withholds.
  const beside = entry([
    named(windowsZip, [player("Game/Game.exe"), player("Game/Game-debug.exe")], 11, "windows"),
  ]);
  assert.equal(reasonOf(decide(listing(), beside)), "role-program");
  assert.match(forcedGate(beside, 11), /another role than the game/u);
  // Whole words only: a word that merely contains the letters is no role.
  for (const program of [
    "Game/Observer.exe",
    "Game/Demon.exe",
    "Toolset/Game.exe",
    "Editorial/Game.exe",
    "Game/Serverless.exe",
    "Game/Demos.exe",
  ]) {
    assert.equal(programRoleWord(program), null, `fit ${program}`);
    assert.equal(gateRoleProgram(program), false, `gate ${program}`);
    // No role word matches; the closed vocabulary (fourth review) withholds
    // the other program or folder name. These rows were "fit" before it.
    assert.equal(
      reasonOf(decide(listing(), entry([named(windowsZip, [player(program)], 11, "windows")]))),
      "program-name-unaccounted",
      program,
    );
  }
  // `Debugger.exe` is no role word either (Core's tool veto excludes it).
  assert.equal(programRoleWord("Game/Debugger.exe"), null);
  assert.equal(gateRoleProgram("Game/Debugger.exe"), false);
  // R3: dedicated, headless and demo archives withhold, with or without an
  // installer of their own.
  const game = player("Game/Game.exe");
  for (const [archive, installer] of [
    ["Game-Dedicated-1.0-win64.zip", "Game-Dedicated-1.0-Setup.exe"],
    ["Game-Headless-1.0-win64.zip", "Game-Headless-1.0-Setup.exe"],
    ["Game-Demo-1.0-win64.zip", "Game-Demo-1.0-Setup.exe"],
  ] as const) {
    const alone = entry([named(archive, [game], 12, "windows")]);
    assert.equal(reasonOf(decide(listing(), alone)), "contradictory-role", archive);
    assert.match(forcedGate(alone, 12), /role-named/u, archive);
    const installed = entry([named(archive, [game], 12, "windows")], {}, unseen, {
      other_packages: [otherForm(19, installer, W)],
    });
    assert.equal(
      reasonOf(decide(listing(), installed)),
      "other-package-form-beside-archive",
      installer,
    );
    assert.match(forcedGate(installed, 12), /role-named/u, installer);
    assert.match(forcedGate(installed, 12), /another package for/u, installer);
  }
  // R4, now closed-vocabulary (fourth review at 599f7eac): an archive whose
  // name is not the listing's or repository's name, a version and neutral
  // words is not the listing's: `Other-1.0-win64.zip` for listing Game.
  const other = entry([named("Other-1.0-win64.zip", [player("Other.exe")], 11, "windows")]);
  const unrelated = decide(listing(), other);
  assert.equal(reasonOf(unrelated), "archive-name-unaccounted");
  assert.match(forcedGate(other, 11), /unaccounted token/u);
  // `Unseen-Game-…` and `Fixture-Tools-…` were related by a shared word
  // before the closed vocabulary; they now carry an unaccounted token.
  for (const [archive, accounted] of [
    ["Other-1.0-win64.zip", false],
    ["win64.zip", false],
    ["Game-1.0-win64.zip", true],
    ["Unseen-Game-1.0-win64.zip", false],
    ["Gamer-1.0-win64.zip", false],
    ["Fixture-Tools-1.0.zip", false],
  ] as const) {
    assert.equal(
      !("unaccounted" in archiveNameAccount(archive, listing().listing, `fixture-owner/${unseen}`)),
      accounted,
      `fit ${archive}`,
    );
    assert.equal(
      gateArchiveAccount(archive, listing().listing, `fixture-owner/${unseen}`) !== null,
      accounted,
      `gate ${archive}`,
    );
  }
  // The repository's name accounts for an archive too: a listing named
  // otherwise whose repository is the product's.
  const record = listing("zz-elsewhere", {
    name: "Different Title",
    original_game_title: "Elsewhere",
    project_url: "https://github.com/fixture-owner/other",
  });
  const byRepository = entry(
    [named("Other-1.0-win64.zip", [player("Other.exe")], 11, "windows")],
    {},
    "zz-elsewhere",
    { repository: "fixture-owner/other", listing_words: listingWords(record.listing) },
  );
  assert.ok(decide(record, byRepository).fit);
  assert.equal(
    gateGeneration(null, generateRegistrations([record], table(byRepository))).added.length,
    1,
  );
});

// ---------------------------------------------------------------------------
// Third review at 997e30a5: B-2, B-3, F1, F3, F4, F5, F6.

/** The gate's verdict on one enrollment forced onto these facts, without the facts check. */
function gateOn(
  record: AuthoredPort,
  facts: ListingFactsEntry | undefined,
  options: { asset?: number; platform?: string; others?: AuthoredPort[] } = {},
) {
  const platform = options.platform ?? "windows-x86-64";
  const reference = facts ?? entry();
  const offered =
    reference.artifacts.find((item) => item.asset_id === (options.asset ?? 11)) ??
    reference.artifacts[0]!;
  const records = [record, ...(options.others ?? [])];
  const generation: Generation = {
    records,
    authored: records,
    decisions: [],
    enrollments: [
      {
        port_id: record.listing.id,
        platforms: [platform],
        generator_version: 0,
        facts_sha256: digestOf(reference),
        repository: reference.repository,
        repository_id: reference.repository_id,
        release: {
          id: reference.observation.release_id!,
          tag: reference.observation.tag!,
          observed_at: reference.observation.observed_at,
        },
        runtimes: [
          {
            platform,
            asset_id: offered.asset_id,
            asset_name: offered.name,
            archive_sha256: offered.sha256,
            source: "exact-release-structured",
            players: offered.players.filter((item) => machineRunsOn(item.machine, platform)),
          },
        ],
      },
    ],
    facts: facts ? table(facts) : table(),
  };
  try {
    gateGeneration(null, generation);
    return "accepted";
  } catch (error) {
    return (error as Error).message;
  }
}

void test("an archive name is the listing's name, a version and neutral words, or it withholds, in fit and gate (B-2, A)", () => {
  const account = (fields: Record<string, unknown>, archive: string) => {
    const id = String(fields.id);
    const record = listing(id, { original_game_title: fields.name, ...fields });
    const repository = `fixture-owner/${id}`;
    const fit = archiveNameAccount(archive, record.listing, repository);
    const gate = gateArchiveAccount(archive, record.listing, repository);
    assert.equal("product" in fit ? fit.product : null, gate, `fit and gate agree on ${archive}`);
    return { record, fit, id };
  };
  // Every earlier must-withhold row still withholds, and the fourth review's
  // rows: another word, a sequel number, a role, a channel or an edition.
  const withheld: [Record<string, unknown>, string, string[]][] = [
    [{ id: "zz-the-game", name: "The Game" }, "The-Other-1.0-win64.zip", ["other"]],
    [{ id: "zz-life", name: "Game of Life" }, "Lord-of-Rings-1.0-win64.zip", ["lord", "rings"]],
    [{ id: "zz-space", name: "Space Game" }, "Other-Game-1.0-win64.zip", ["other"]],
    [{ id: "zz-doom", name: "Doom 2" }, "Quake2-win64.zip", ["quake"]],
    [{ id: "zz-a", name: "A Game" }, "A-Other-1.0-win64.zip", ["other"]],
    [{ id: "zz-two", name: "Saga II" }, "Other-II-1.0-win64.zip", ["other"]],
    [{ id: "zz-x", name: "X" }, "Game-1.0-win64.zip", ["game"]],
    [{ id: "zz-doom", name: "Doom 2" }, "Doom3-win64.zip", ["3"]],
    [{ id: "zz-doom", name: "Doom 2" }, "Doom-1.0-win64.zip", ["missing:2"]],
    [{ id: "zz-super", name: "Super Game" }, "SuperGame2-1.0-win64.zip", ["2"]],
    [{ id: "zz-super", name: "Super Game" }, "Super-Other-1.0-win64.zip", ["other"]],
    [{ id: "zz-super", name: "Super Game" }, "SuperGame-Trial-1.0-win64.zip", ["trial"]],
    [{ id: "zz-super", name: "Super Game" }, "SuperGame-beta-1.0-win64.zip", ["beta"]],
    [{ id: "zz-super", name: "Super Game" }, "SuperGame-rc1-win64.zip", ["rc", "1"]],
    [{ id: "zz-super", name: "Super Game" }, "SuperGame-Lite-1.0-win64.zip", ["lite"]],
    [{ id: "zz-space", name: "Space Game" }, "Space-Invaders-1.0-win64.zip", ["invaders"]],
    [{ id: "zz-space", name: "Space Game" }, "Space-Other-1.0-win64.zip", ["other"]],
    [{ id: "zz-space", name: "Space Game" }, "win64.zip", ["no-product"]],
  ];
  for (const [fields, archive, tokens] of withheld) {
    const { record, fit, id } = account(fields, archive);
    assert.deepEqual("unaccounted" in fit ? fit.unaccounted : [], tokens, archive);
    const facts = entry([named(archive, [player("Other.exe")], 11, "windows")], {}, id, {
      listing_words: listingWords(record.listing),
    });
    const decision = decide(record, facts);
    assert.equal(reasonOf(decision), "archive-name-unaccounted", archive);
    assert.deepEqual((decision as { tokens?: string[] }).tokens, tokens, archive);
    assert.match(gateOn(record, facts), /unaccounted token/u, archive);
  }
  // Accounted: the name joined, a version and neutral words, numbers and
  // number-only titles by equality.
  const accounted: [Record<string, unknown>, string, string][] = [
    [{ id: "zz-super", name: "Super Game" }, "supergame-1.0-win64.zip", "supergame"],
    [{ id: "zz-super", name: "Super Game" }, "Super-Game-v1.0-windows-x64.zip", "supergame"],
    [{ id: "zz-super", name: "Super Game" }, "SuperGame-portable-x86_64.zip", "supergame"],
    [{ id: "zz-doom", name: "Doom 2" }, "Doom-2-1.0-win64.zip", "doom2"],
    [{ id: "zz-doom", name: "Doom 2" }, "Doom2-win64.zip", "doom2"],
    [{ id: "zz-2048", name: "2048" }, "2048-win64.zip", "2048"],
    [{ id: "zz-2048", name: "2048" }, "2048-1.2-linux-x86_64.tar.gz", "2048"],
    [{ id: "zz-x", name: "Game" }, "Game-1.0-win64.zip", "game"],
    [{ id: "zz-x", name: "Game" }, "Game-v1.0-macos-universal.zip", "game"],
  ];
  // Digit-only chunks may be product words or versions; glued digits are product.
  // A dotted digit run is a version only; a standalone integer must be a
  // number of the name at that position; glued digits are word tokens.
  assert.deepEqual(archiveNameTokens("Doom-2-1.0-win64.zip").tokens, [
    { word: "doom", kind: "word", chunk: "doom" },
    { word: "2", kind: "integer", chunk: "2" },
    { word: "v0", kind: "version", chunk: "v0" },
    { word: "win64", kind: "neutral", chunk: "win64" },
  ]);
  assert.deepEqual(archiveNameTokens("Doom3-v1.2-x86_64.tar.gz").tokens, [
    { word: "doom", kind: "word", chunk: "doom3" },
    { word: "3", kind: "word", chunk: "doom3" },
    { word: "v0", kind: "version", chunk: "v0" },
    { word: "x8664", kind: "neutral", chunk: "x8664" },
  ]);
  for (const [fields, archive, product] of accounted) {
    const { fit } = account(fields, archive);
    assert.equal("product" in fit ? fit.product : null, product, archive);
  }
  const super_ = listing("zz-super", { name: "Super Game", original_game_title: "Super Game" });
  const superFacts = entry(
    [named("supergame-1.0-win64.zip", [player("SuperGame.exe")], 11, "windows")],
    {},
    "zz-super",
    { listing_words: listingWords(super_.listing) },
  );
  assert.ok(decide(super_, superFacts).fit);
  assert.equal(gateOn(super_, superFacts), "accepted");
  const numbered = listing("zz-2048", { name: "2048", original_game_title: "2048" });
  const numberFacts = entry(
    [named("2048-win64.zip", [player("2048.exe")], 11, "windows")],
    {},
    "zz-2048",
    { listing_words: listingWords(numbered.listing) },
  );
  assert.ok(decide(numbered, numberFacts).fit, JSON.stringify(decide(numbered, numberFacts)));
  assert.equal(gateOn(numbered, numberFacts), "accepted");
});

void test("a program is the product's name, with an architecture suffix only without another form, in folders of accounted words (B)", () => {
  const record = listing("zz-super", { name: "Super Game", original_game_title: "Super Game" });
  const names = new Set(["zzsuper", "supergame"]);
  const words = new Set(["zz", "super", "game", "1", "0", "win64", "zip"]);
  const rows: [string, boolean, string | null][] = [
    ["SuperGame.exe", false, null],
    ["supergame", false, null],
    ["Super_Game.exe", true, null],
    ["SuperGame-x64.exe", false, null],
    ["supergame.x86_64", false, null],
    ["SuperGame-x64.exe", true, "supergamex64"],
    ["SuperGame64.exe", false, "supergame64"],
    ["supergameserver64.exe", false, "supergameserver64"],
    ["SUPERGAMELAUNCHER.EXE", false, "supergamelauncher"],
    ["SGSERVER.EXE", false, "sgserver"],
    ["SGEDIT.EXE", false, "sgedit"],
    ["supergame-cli.exe", false, "supergamecli"],
    ["Other.exe", false, "other"],
    ["engine.exe", false, "engine"],
    ["bin/SuperGame.exe", false, null],
    ["x64/SuperGame.exe", false, null],
    ["SuperGame-1.0/bin/SuperGame.exe", false, null],
    ["SuperGame.app/Contents/MacOS/SuperGame", false, null],
    ["game/SuperGame.exe", false, null],
    ["data/SuperGame.exe", false, "data/"],
    ["server/SuperGame.exe", false, "server/"],
    ["tools/SuperGame.exe", false, "tools/"],
    ["editor/SuperGame.exe", false, "editor/"],
    ["Other Thing/SuperGame.exe", false, "Other Thing/"],
  ];
  for (const [path, strict, leftover] of rows) {
    assert.equal(programNameUnaccounted(path, names, words, strict), leftover, `fit ${path}`);
    assert.equal(
      gateProgramAccounted(path, [...names], [...words], strict),
      leftover === null,
      `gate ${path}`,
    );
  }
  // Whole decisions: a program the closed vocabulary does not account for withholds.
  for (const program of ["SGEDIT.EXE", "supergame-cli.exe", "Other.exe", "data/SuperGame.exe"]) {
    const facts = entry(
      [named("SuperGame-1.0-win64.zip", [player(program)], 11, "windows")],
      {},
      "zz-super",
      { listing_words: listingWords(record.listing) },
    );
    const decision = decide(record, facts);
    assert.equal(reasonOf(decision), "program-name-unaccounted", program);
    assert.match(gateOn(record, facts), /unaccounted token/u, program);
  }
  // An architecture suffix enrolls alone, and beside another package form
  // the name stays literal.
  const suffixed = entry(
    [named("SuperGame-1.0-win64.zip", [player("SuperGame-x64.exe")], 11, "windows")],
    {},
    "zz-super",
    { listing_words: listingWords(record.listing) },
  );
  assert.ok(decide(record, suffixed).fit);
  assert.equal(gateOn(record, suffixed), "accepted");
});

void test("any token outside the vocabulary withholds an archive or a program, and fit and gate agree (A, B property)", () => {
  let seed = 8_569_004;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const letters = "bcdfghjklmnpqrstvwxz";
  const extraToken = () => {
    for (;;) {
      const word = Array.from({ length: 3 + Math.floor(random() * 5) }, () =>
        pick(letters.split("")),
      ).join("");
      if (!(neutralArchiveWords as readonly string[]).includes(word)) return word;
    }
  };
  const record = listing("zz-super", { name: "Super Game", original_game_title: "Super Game" });
  const repository = "fixture-owner/zz-super";
  const separators = ["-", "_", ".", " "];
  const neutrals = ["win64", "x64", "linux", "x86_64", "macos", "portable", "universal", "release"];
  let withheldArchives = 0;
  for (let round = 0; round < 3000; round++) {
    const parts = ["Super", "Game"];
    if (random() < 0.5) parts.push(`v${Math.floor(random() * 9)}`, `${Math.floor(random() * 9)}`);
    if (random() < 0.7) parts.push(pick(neutrals));
    const extra = random() < 0.6 ? extraToken() : null;
    if (extra !== null) parts.splice(Math.floor(random() * (parts.length + 1)), 0, extra);
    const sep = pick(separators);
    const name = `${parts.join(sep)}.${pick(["zip", "tar.gz", "tar.xz"])}`;
    const fit = archiveNameAccount(name, record.listing, repository);
    const gate = gateArchiveAccount(name, record.listing, repository);
    assert.equal("product" in fit ? fit.product : null, gate, `parity ${name}`);
    if (extra !== null) {
      assert.ok("unaccounted" in fit, `extra ${extra} withholds ${name}`);
      withheldArchives++;
    }
  }
  assert.ok(withheldArchives > 1000);
  // Programs: any extra token, glued or separated, withholds.
  const names = new Set(["zzsuper", "supergame"]);
  const words = new Set(["zz", "super", "game"]);
  for (let round = 0; round < 3000; round++) {
    const extra = random() < 0.6 ? extraToken() : null;
    const suffix = random() < 0.3 ? pick(["-x64", ".x86_64", "_amd64", "-arm64"]) : "";
    const folder = random() < 0.3 ? `${pick(["bin", "x64", "game", extra ?? "bin"])}/` : "";
    const glue = pick(["", "-", "_", " "]);
    const file = `${random() < 0.5 ? "SuperGame" : "supergame"}${extra !== null && random() < 0.5 ? glue + extra : ""}${suffix}${pick([".exe", ""])}`;
    const path = folder + file;
    const strict = random() < 0.3;
    const fit = programNameUnaccounted(path, names, words, strict);
    assert.equal(
      gateProgramAccounted(path, [...names], [...words], strict),
      fit === null,
      `parity ${path}`,
    );
    if (extra !== null && path.includes(extra))
      assert.notEqual(fit, null, `extra ${extra} withholds ${path}`);
  }
});

void test("the gate's repository identity restates the fit's provider identity exactly (D)", () => {
  const github = `https://github.com/fixture-owner/${unseen}`;
  const rows: [Record<string, unknown>, string | null][] = [
    [{ project_url: github }, `fixture-owner/${unseen}`],
    [{ project_url: `${github}/` }, `fixture-owner/${unseen}`],
    [{ project_url: `${github}.git` }, `fixture-owner/${unseen}`],
    [
      { release_url: `${github}/releases/tag/v1.0`, project_url: github },
      `fixture-owner/${unseen}`,
    ],
    [{ release_url: `${github}/releases` }, `fixture-owner/${unseen}`],
    [{ project_url: `${github}?x=1` }, null],
    [{ project_url: `${github}#readme` }, null],
    [{ project_url: `${github}/tree/main` }, null],
    [{ project_url: `${github}/wiki` }, null],
    [
      { release_url: "https://gitlab.com/fixture-owner/game/-/releases", project_url: github },
      null,
    ],
    [
      {
        release_url: "https://github.com/fixture-owner/other/releases/tag/v1.0",
        project_url: github,
      },
      "fixture-owner/other",
    ],
    [{ project_url: "https://github.com:8443/fixture-owner/game" }, null],
    [{ project_url: "https://user@github.com/fixture-owner/game" }, null],
    [{ project_url: "http://github.com/fixture-owner/game" }, null],
    [{ project_url: "https://www.github.com/fixture-owner/game" }, null],
    [{ project_url: "https://github.com/fixture-owner" }, null],
    [{ project_url: "https://github.com/fixture-owner/game/releasesx" }, null],
  ];
  for (const [fields, repository] of rows) {
    const fit = listingProviderIdentity(fields);
    assert.equal(
      fit?.provider === "github" ? fit.repository : null,
      repository,
      JSON.stringify(fields),
    );
    assert.equal(gateProviderRepository(fields), repository, JSON.stringify(fields));
  }
  // Generated URLs agree too.
  let seed = 3;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const pieces = [
    "",
    "/",
    ".git",
    "/releases",
    "/releases/tag/v1",
    "/tree/main",
    "?q=1",
    "#x",
    "//",
    "/wiki",
    ".git/releases",
  ];
  const hosts = [
    "https://github.com",
    "https://GitHub.com",
    "http://github.com",
    "https://gitlab.com",
    "https://github.com:443",
    "https://a@github.com",
  ];
  for (let round = 0; round < 2000; round++) {
    const url = `${hosts[Math.floor(random() * hosts.length)]}/${["o", "o.o", "..", "o-o"][Math.floor(random() * 4)]}/${["r", "r.git", ".git", "r_r"][Math.floor(random() * 4)]}${pieces[Math.floor(random() * pieces.length)]}`;
    const fields =
      random() < 0.5 ? { project_url: url } : { release_url: url, project_url: github };
    const fit = listingProviderIdentity(fields);
    assert.equal(
      gateProviderRepository(fields),
      fit?.provider === "github" ? fit.repository : null,
      url,
    );
  }
  // Forced enrollments the gate refuses: eight repository rows.
  const forced: [Record<string, unknown>, RegExp][] = [
    [
      { release_url: "https://gitlab.com/fixture-owner/game/-/releases", project_url: github },
      /names no GitHub repository/u,
    ],
    [
      {
        release_url: "https://github.com/fixture-owner/other/releases/tag/v1.0",
        project_url: github,
      },
      /repository its listing does not name/u,
    ],
    [{ project_url: `${github}?x=1` }, /names no GitHub repository/u],
    [{ project_url: `${github}#readme` }, /names no GitHub repository/u],
    [{ project_url: `${github}/tree/main` }, /names no GitHub repository/u],
    [{ project_url: `${github}/wiki` }, /names no GitHub repository/u],
    [
      { project_url: `https://github.com:8443/fixture-owner/${unseen}` },
      /names no GitHub repository/u,
    ],
    [
      { project_url: `https://user@github.com/fixture-owner/${unseen}` },
      /names no GitHub repository/u,
    ],
  ];
  for (const [fields, refusal] of forced) {
    const record = listing(unseen, fields);
    assert.notEqual(reasonOf(decide(record, entry())), "fit", JSON.stringify(fields));
    assert.match(gateOn(record, entry()), refusal, JSON.stringify(fields));
  }
});

void test("glued, capitalised and abbreviated role words withhold, in fit and gate (F1)", () => {
  for (const program of [
    "gameserver.exe",
    "GAMESERVER.EXE",
    "gamedebug.exe",
    "servergame.exe",
    "gamed.exe",
    "Game-dbg.exe",
    "Game-srv.exe",
    "Game-ded.exe",
    "Game-trial.exe",
    "Game-shareware.exe",
    "Game-test.exe",
  ]) {
    const facts = entry([named(windowsZip, [player(`Game/${program}`)], 11, "windows")]);
    assert.equal(reasonOf(decide(listing(), facts)), "role-program", program);
    assert.match(gateOn(listing(), facts), /another role than the game/u, program);
    assert.notEqual(programRoleWord(`Game/${program}`, ["game"]), null, `fit ${program}`);
    assert.ok(gateRoleProgram(`Game/${program}`, ["game"]), `gate ${program}`);
  }
  // A test folder is a role folder.
  assert.equal(programRoleWord("test/Game.exe"), "test");
  assert.ok(gateRoleProgram("test/Game.exe"));
  // Words that only contain the letters, or a name plus another word, are no role.
  for (const program of ["Gamedev.exe", "Testament.exe", "Trialsmith.exe", "Gamer.exe"]) {
    assert.equal(programRoleWord(`Game/${program}`, ["game"]), null, `fit ${program}`);
    assert.equal(gateRoleProgram(`Game/${program}`, ["game"]), false, `gate ${program}`);
    // No role word matches; the closed vocabulary (fourth review) withholds
    // them as other program names. These rows were "fit" before it.
    assert.equal(
      reasonOf(
        decide(listing(), entry([named(windowsZip, [player(`Game/${program}`)], 11, "windows")])),
      ),
      "program-name-unaccounted",
      program,
    );
  }
});

void test("names with characters outside ASCII withhold the identity, in fit and gate (F3)", () => {
  for (const program of ["G\u0430me.exe", "\uff27\uff41\uff4d\uff45.exe"]) {
    const facts = entry([named(windowsZip, [player(`Game/${program}`)], 11, "windows")]);
    assert.equal(reasonOf(decide(listing(), facts)), "non-ascii-name", program);
    assert.match(gateOn(listing(), facts), /name outside ASCII/u, program);
    assert.ok(nonAsciiName(program) && gateNonAscii(program), program);
  }
  const archive = "G\u0430me-1.0-win64.zip";
  const facts = entry([named(archive, [player("Game/Game.exe")], 11, "windows")]);
  assert.equal(reasonOf(decide(listing(), facts)), "non-ascii-name");
  assert.match(gateOn(listing(), facts), /name outside ASCII/u);
  assert.ok(!nonAsciiName("Game-1.0-win64.zip") && !gateNonAscii("Game-1.0-win64.zip"));
});

void test("nightly, preview, experimental, test-build, snapshot, wip and dev state a prerelease where a status stands (F4)", () => {
  const repository = "fixture-owner/zz-unseen";
  const rows: [string, string | null][] = [
    ["v2.0 nightly", "nightly"],
    ["Nightly 2026-11-20", "nightly"],
    ["Preview 2", "preview"],
    ["v1.0-preview.3", "preview"],
    ["v1.0 (experimental)", "experimental"],
    ["Experimental build 4", "experimental"],
    ["Test build 12", "test-build"],
    ["v3.0 test build", "test-build"],
    ["Development snapshot", "development-snapshot"],
    ["v0.9 WIP", "wip"],
    ["Dev 3", "dev"],
    ["v1.1-dev2", "dev"],
    // False positives: no status stands.
    ["Nightly builds are published separately", null],
    ["Preview of the new renderer", null],
    ["Previewing the new mode in v1.0", null],
    ["Experimental features are off by default in this release", null],
    ["Developer notes for v1.0", null],
    ["Dev notes", null],
    ["No longer a nightly: v1.0", null],
    ["Graduated from preview 4", null],
    ["Testing build scripts", null],
    ["Wipeout fixes in 1.0", null],
  ];
  for (const [line, token] of rows) {
    assert.equal(releaseStatement(line, repository), token, `fit: ${line}`);
    assert.equal(gateStatement(line, repository), token, `gate: ${line}`);
  }
  // The listing's own words still name the product before the first number.
  const words = listingWords({ id: "zz-nightly-racer", name: "Nightly Racer" });
  assert.equal(releaseStatement("Nightly Racer 1.0", repository, words), null);
  assert.equal(gateStatement("Nightly Racer 1.0", repository, words), null);
});

void test("the reason evidence and the unaccounted tokens queue name what a person acts on (F6, F)", () => {
  const records = [
    listing("zz-ev-role"),
    listing("zz-ev-launcher"),
    listing("zz-ev-unrelated"),
    listing("zz-ev-unrelated-2"),
    listing("zz-ev-edition"),
    listing("zz-ev-ascii"),
    listing("zz-ev-program"),
  ];
  const facts = table(
    entry([named(windowsZip, [player("server/Game.exe")], 11, "windows")], {}, "zz-ev-role"),
    entry([named(windowsZip, [player("Game/Launcher.exe")], 11, "windows")], {}, "zz-ev-launcher"),
    entry(
      [named("Other-1.0-win64.zip", [player("Other.exe")], 11, "windows")],
      {},
      "zz-ev-unrelated",
    ),
    entry(
      [named("Other-2.0-win64.zip", [player("Other.exe")], 11, "windows")],
      {},
      "zz-ev-unrelated-2",
    ),
    entry(
      [named("Game-Lite-1.0-win64.zip", [player("Game.exe")], 11, "windows")],
      {},
      "zz-ev-edition",
    ),
    entry([named(windowsZip, [player("Game/Gаme.exe")], 11, "windows")], {}, "zz-ev-ascii"),
    entry([named(windowsZip, [player("Game/SGEDIT.EXE")], 11, "windows")], {}, "zz-ev-program"),
  );
  const queues = registrationQueues(generateRegistrations(records, facts));
  assert.deepEqual(Object.keys(queues.reason_evidence).toSorted(), [...evidenceReasons].toSorted());
  assert.deepEqual(queues.reason_evidence["role-program"], {
    "zz-ev-role": ["server: server/Game.exe"],
  });
  assert.deepEqual(queues.reason_evidence["launcher-entry"], {
    "zz-ev-launcher": ["windows-x86-64: Game/Launcher.exe"],
  });
  assert.deepEqual(queues.reason_evidence["archive-name-unaccounted"]["zz-ev-unrelated"], [
    "windows-x86-64: Other-1.0-win64.zip (other)",
  ]);
  assert.deepEqual(queues.reason_evidence["non-ascii-name"], {
    "zz-ev-ascii": ["Game/Gаme.exe"],
  });
  assert.deepEqual(queues.reason_evidence["program-name-unaccounted"], {
    "zz-ev-program": ["windows-x86-64: Game/SGEDIT.EXE (sgedit)"],
  });
  // Grouped by token, most frequent first.
  assert.deepEqual(queues.unaccounted_tokens["archive-name-unaccounted"], [
    { token: "other", count: 2, identities: ["zz-ev-unrelated", "zz-ev-unrelated-2"] },
    { token: "lite", count: 1, identities: ["zz-ev-edition"] },
  ]);
  assert.deepEqual(queues.unaccounted_tokens["program-name-unaccounted"], [
    { token: "sgedit", count: 1, identities: ["zz-ev-program"] },
  ]);
});

void test("every fit withholding reason is restated by the gate or exempted with a reason, over several scenarios each (B-3, D)", () => {
  const W64 = "windows-x86-64";
  const game = [player("Game/Game.exe")];
  const clean = () => entry([named(windowsZip, game, 11, "windows")]);
  const with_ = (extra: Partial<ListingFactsEntry>, fields = {}) =>
    entry([named(windowsZip, game, 11, "windows")], fields, unseen, extra);
  const neutral = (extra: Partial<ListingFactsEntry> = {}, fields = {}) =>
    entry([named(neutralZip, [player("Game.exe")], 11)], fields, unseen, extra);
  const ineligible = (reason: string, base = with_) =>
    base({ ineligible: { reason, detail: "Forced." } as ListingFactsEntry["ineligible"] });
  type Case = {
    record?: AuthoredPort;
    facts: ListingFactsEntry | undefined;
    others?: AuthoredPort[];
  };
  const github = `https://github.com/fixture-owner/${unseen}`;
  const sharing = (id: string) => listing(id, { project_url: github });
  const release = (id: number, tag: string, at: string) => ({
    release_id: id,
    tag,
    core_prerelease: false,
    prerelease: false,
    published_at: at,
    packaged: true,
    text: "observed" as const,
    title: null,
    statement: null,
  });
  const twoLines = (tag: string) =>
    with_({
      observed_releases: [
        release(7, "v1.0", "2026-11-01T00:00:00.000Z"),
        release(8, tag, "2026-10-01T00:00:00.000Z"),
      ],
    });
  const refused = (name: string, kind = suggestion(name)) =>
    with_({
      refused_archives: [
        {
          asset_id: 12,
          name,
          size: 100,
          sha256: sha(name),
          name_suggestion: kind,
          refusal: "core-unsupported",
        },
      ],
    });
  const toolchain = (helper: string, recorded: string) => {
    const facts = clean();
    facts.artifacts[0]!.bundled_toolchain = [helper];
    facts.artifacts[0]!.toolchain_names = [recorded];
    return facts;
  };
  const sourced = (kind: string) => {
    const forged = clean();
    (forged.artifacts[0]!.source as { kind: string }).kind = kind;
    return forged;
  };
  const spaceRecord = listing(unseen, { name: "Space Game", original_game_title: "Space Game" });
  const fixtureSubtitled = listing(unseen, {
    name: "Runtime Fixture: Unseen",
    original_game_title: "Runtime Fixture",
  });
  const wordsOf = (record: AuthoredPort, artifacts: ArtifactFactV2[]) =>
    entry(artifacts, {}, unseen, { listing_words: listingWords(record.listing) });
  const deadOrAlive = listing(unseen, {
    name: "Dead or Alive 3",
    original_game_title: "Dead or Alive 3",
  });
  const dawnOfAges = listing("zz-other-dawn", {
    name: "Dawn of Ages 3: Rise",
    original_game_title: "Dawn of Ages 3: Rise",
  });
  const spaceFacts = (program: string) =>
    entry([named("Space-Game-1.0-win64.zip", [player(program)], 11, "windows")], {}, unseen, {
      listing_words: listingWords(spaceRecord.listing),
    });
  const cases: Partial<Record<BlockedReason, Case[]>> = {
    "operational-route": [
      { record: { ...listing(), integration: { adapter: "native-portable" } }, facts: clean() },
      { record: { ...listing(), route_facts_v1: {} } as unknown as AuthoredPort, facts: clean() },
    ],
    "scummvm-engine": [
      ...["https://github.com/scummvm/scummvm", "https://github.com/ScummVM/ScummVM.git"].map(
        (url) => ({
          record: listing(unseen, {
            implementation: { dependencies: [{ kind: "runtime", project_url: url }] },
          }),
          facts: clean(),
        }),
      ),
    ],
    "no-readable-upstream": [
      `${github}?x=1`,
      `${github}#readme`,
      `${github}/tree/main`,
      `${github}/wiki`,
      `https://github.com:8443/fixture-owner/${unseen}`,
      `https://user@github.com/fixture-owner/${unseen}`,
      "https://gitlab.com/fixture-owner/game",
    ]
      .map((url) => ({ record: listing(unseen, { project_url: url }), facts: clean() }))
      .concat([
        {
          record: listing(unseen, {
            release_url: "https://gitlab.com/fixture-owner/game/-/releases",
            project_url: github,
          }),
          facts: clean(),
        },
      ]),
    "no-observation": [
      { facts: undefined },
      { record: listing(unseen, { name: "Other" }), facts: undefined },
    ],
    "repository-mismatch": [
      { facts: with_({ repository: "fixture-owner/another-project" }) },
      {
        record: listing(unseen, {
          release_url: "https://github.com/fixture-owner/other/releases/tag/v1.0",
          project_url: github,
        }),
        facts: clean(),
      },
    ],
    "stale-parser": [
      { facts: with_({ parser_version: FACTS_PARSER_VERSION - 1 }) },
      { facts: with_({ parser_version: FACTS_PARSER_VERSION + 1 }) },
    ],
    "incomplete-coverage": [
      { facts: with_({}, { coverage: "partial" }) },
      { facts: with_({}, { assets_complete: false }) },
    ],
    "stale-facts": [
      { facts: with_({}, { observed_at: "2026-09-01T00:00:00Z" }) },
      { facts: neutral({}, { observed_at: "2026-08-01T00:00:00Z" }) },
    ],
    "shared-repository": [
      { facts: clean(), others: [sharing("zz-sharing")] },
      { facts: neutral(), others: [sharing("zz-sharing-a"), sharing("zz-sharing-b")] },
    ],
    "ambiguous-release-line": [
      { facts: twoLines("level-editor-v2.0") },
      { facts: twoLines("tools-v3.1") },
    ],
    "release-text-unobserved": [
      {
        facts: with_({
          observed_releases: [
            { ...release(7, "v1.0", "2026-11-01T00:00:00.000Z"), text: "unobserved" as const },
          ],
        }),
      },
      {
        facts: neutral({
          observed_releases: [
            release(6, "v0.9", "2026-10-01T00:00:00.000Z"),
            { ...release(7, "v1.0", "2026-11-01T00:00:00.000Z"), text: "unobserved" as const },
          ],
        }),
      },
    ],
    "worded-prerelease-skipped": [
      // Faxanadu's measured shape: newer stable-flagged releases titled as an
      // experimental mod are skipped by words alone; the older is not offered.
      {
        facts: with_({
          observed_releases: [
            release(7, "v1.0", "2026-11-01T00:00:00.000Z"),
            {
              ...release(8, "v2.4.0", "2026-11-05T00:00:00.000Z"),
              prerelease: true,
              title: "Faxanadu v2.4.0 experimental mod",
              statement: { field: "title" as const, token: "experimental" as const },
            },
          ],
        }),
      },
      {
        facts: neutral({
          observed_releases: [
            release(7, "v1.0", "2026-11-01T00:00:00.000Z"),
            {
              ...release(9, "v1.1", "2026-11-09T00:00:00.000Z"),
              prerelease: true,
              statement: { field: "body-first-line" as const, token: "beta" as const },
            },
          ],
        }),
      },
    ],
    "other-package-form-beside-archive": [
      { facts: with_({ other_packages: [otherForm(19, "Tool-1.0-Setup.exe", W)] }) },
      { facts: with_({ other_packages: [otherForm(19, "Game.7z", W)] }) },
    ],
    "no-player": [
      { facts: entry([named(windowsZip, [], 11, "windows")]) },
      { facts: entry([named(neutralZip, [], 11)]) },
    ],
    "tool-not-game": [
      { facts: entry([named(windowsZip, [player("Game/Patcher.exe")], 11, "windows")]) },
      { facts: entry([named(neutralZip, [player("Patcher.exe")], 11)]) },
    ],
    "no-authorizing-source": [
      { facts: sourced("listing-name") },
      { facts: sourced("package-shape") },
    ],
    "contradictory-role": [
      { facts: entry([named("Game-update-1.0.zip", game, 11)]) },
      { facts: entry([named("Game-Demo-1.0-win64.zip", game, 11, "windows")]) },
    ],
    "unknown-platform": [
      { facts: entry([named(windowsZip, [player("Game/Game.exe", "pe-unknown-x86-64")], 11)]) },
      { facts: entry([named(neutralZip, [player("Game", "elf64-unknown-x86-64")], 11)]) },
    ],
    "wrong-host": [
      { facts: entry([named(windowsZip, [player("Game/Game.exe", "pe-x86")], 11)]) },
      { facts: entry([named(neutralZip, [player("Game.exe", "pe-x86")], 11)]) },
    ],
    "ambiguous-player": [
      {
        facts: entry([named(windowsZip, [player("Game/Game.exe"), player("Game/Other.exe")], 11)]),
      },
      { facts: entry([named(windowsZip, [player("A/Game.exe"), player("B/Game.exe")], 11)]) },
    ],
    "ambiguous-artifact": [
      { facts: entry([named(windowsZip, game, 11, "windows"), named(neutralZip, game, 12)]) },
      { facts: entry([named(neutralZip, game, 11), named("Game-v1.1.zip", game, 12)]) },
    ],
    "core-refused": [{ facts: refused(neutralZip) }, { facts: refused(windowsZip) }],
    "bundled-toolchain": [
      { facts: toolchain("python", "python.exe") },
      { facts: toolchain("zig", "zig") },
    ],
    "launcher-entry": [
      { facts: entry([named(windowsZip, [player("Game/Launcher.exe")], 11, "windows")]) },
      { facts: entry([named(windowsZip, [player("Game/StartGame.exe")], 11, "windows")]) },
    ],
    "role-program": [
      { facts: entry([named(windowsZip, [player("server/Game.exe")], 11, "windows")]) },
      { facts: entry([named(windowsZip, [player("Game/gameserver.exe")], 11, "windows")]) },
      { facts: entry([named(windowsZip, [player("Game/Game-trial.exe")], 11, "windows")]) },
    ],
    "non-ascii-name": [
      { facts: entry([named(windowsZip, [player("Game/Gаme.exe")], 11, "windows")]) },
      { facts: entry([named("Gаme-1.0-win64.zip", game, 11, "windows")]) },
    ],
    "archive-name-unaccounted": [
      { facts: entry([named("Other-1.0-win64.zip", [player("Other.exe")], 11, "windows")]) },
      { facts: entry([named("Game-Lite-1.0-win64.zip", game, 11, "windows")]) },
      { facts: entry([named("Game2-1.0-win64.zip", game, 11, "windows")]) },
    ],
    "split-package": [
      {
        facts: entry([named(windowsZip, game, 11, "windows"), named("Game-data-1.0.zip", [], 12)]),
      },
      {
        facts: entry([
          named("Game-1.0-win64.zip", game, 11, "windows"),
          named("Game-assets-1.0.zip", [], 12),
        ]),
      },
    ],
    "archive-names-another-listing": [
      {
        // The first title segment of a listing in another repository.
        // (Generator 26: the record is named so that `Runtime-Fixture` is a
        // partial name of it; N4 no longer drops the id's leading words.)
        record: fixtureSubtitled,
        facts: wordsOf(fixtureSubtitled, [
          named("Runtime-Fixture-1.0-win64.zip", game, 11, "windows"),
        ]),
        others: [
          listing("zz-other-unseen", {
            name: "Runtime Fixture — Remade (someone)",
            original_game_title: "Runtime Fixture",
          }),
        ],
      },
      {
        record: fixtureSubtitled,
        facts: wordsOf(fixtureSubtitled, [
          named("Runtime-Fixture-1.0-win64.zip", game, 11, "windows"),
        ]),
        others: [
          listing("zz-other-runtime", {
            name: "Other",
            original_game_title: "Other",
            project_url: "https://github.com/fixture-owner/runtime-fixture-recomp",
          }),
        ],
      },
    ],
    "name-not-unique-in-catalog": [
      {
        // An initialism archive another repository's listing accepts too.
        record: deadOrAlive,
        facts: wordsOf(deadOrAlive, [
          named("doa3-1.0-win64.zip", [player("DOA3.exe")], 11, "windows"),
        ]),
        others: [dawnOfAges],
      },
      {
        // A relieved program name, in an archive spelling the name exactly.
        record: deadOrAlive,
        facts: wordsOf(deadOrAlive, [
          named("Dead-or-Alive-3-1.0-win64.zip", [player("DOA3.exe")], 11, "windows"),
        ]),
        others: [dawnOfAges],
      },
      {
        // A partial name another listing accepts by dropping a possessive run.
        record: fixtureSubtitled,
        facts: wordsOf(fixtureSubtitled, [
          named("Runtime-Fixture-1.0-win64.zip", game, 11, "windows"),
        ]),
        others: [
          listing("zz-other-hawk", {
            name: "Tony Hawk's Runtime Fixture",
            original_game_title: "Tony Hawk's Runtime Fixture",
          }),
        ],
      },
    ],
    "program-name-unaccounted": [
      { record: spaceRecord, facts: spaceFacts("Other.exe") },
      { record: spaceRecord, facts: spaceFacts("SpaceGame-cli.exe") },
      { record: spaceRecord, facts: spaceFacts("data/SpaceGame.exe") },
    ],
    "upstream-unavailable": [
      { record: listing(unseen, { availability: "unavailable" }), facts: clean() },
      { record: listing(unseen, { availability: "source-only" }), facts: clean() },
    ],
  };
  for (const reason of ineligibleReasons)
    if (!(reason in cases))
      cases[reason] = [{ facts: ineligible(reason) }, { facts: ineligible(reason, neutral) }];
  let scenarios = 0;
  for (const reason of new Set(blockedReasons)) {
    const exemption = gateExemptions[reason];
    const scenarioList = cases[reason];
    assert.ok(
      (exemption !== undefined) !== (scenarioList !== undefined),
      `${reason} needs exactly one of gate restatement scenarios or a justified exemption`,
    );
    if (exemption !== undefined || scenarioList === undefined) {
      assert.ok((exemption ?? "").length > 80, `${reason}'s exemption states why`);
      continue;
    }
    assert.ok(scenarioList.length >= 2, `${reason} has several scenarios`);
    for (const scenario of scenarioList) {
      const record = scenario.record ?? listing();
      const others = scenario.others ?? [];
      const decision = fitDecision(
        record,
        scenario.facts,
        generatedAt,
        fitContext([record, ...others]),
      );
      assert.equal(reasonOf(decision), reason, `the fit withholds a ${reason} scenario`);
      assert.notEqual(
        gateOn(record, scenario.facts, { others, platform: W64 }),
        "accepted",
        `the gate restates ${reason}`,
      );
      scenarios++;
    }
  }
  assert.ok(scenarios > 80, `only ${scenarios} scenarios`);
  // The clean scenario is accepted, so each refusal above is the case's own.
  assert.equal(gateOn(listing(), clean()), "accepted");
});

// ---------------------------------------------------------------------------
// Fifth review at 9a0c323a: digits, `b<N>`, split packages, release titles,
// the original title, one player and the repository-only queue.

void test("digits are versions unless the name has that number there, and b<N> or bin is no version or neutral word (B1, B2)", () => {
  const decideOn = (
    fields: Record<string, unknown>,
    archive: string,
    program: string,
    repository?: string,
  ) => {
    const id = String(fields.id);
    const repo = repository ?? `fixture-owner/${id}`;
    const record = listing(id, { ...fields, project_url: `https://github.com/${repo}` });
    const facts = entry([named(archive, [player(program)], 11, "windows")], {}, id, {
      repository: repo,
      listing_words: listingWords(record.listing),
    });
    return { record, facts, decision: decide(record, facts) };
  };
  const withheld: [Record<string, unknown>, string, string, string[], string?][] = [
    [
      { id: "zz-game-two", name: "Game 2" },
      "Game-1.0.2-win64.zip",
      "Game/engine.exe",
      ["missing:2"],
      "fixture-owner/engine",
    ],
    [{ id: "zz-doom", name: "Doom" }, "Doom-2-win64.zip", "Doom2/engine.exe", ["number:2"]],
    [
      { id: "zz-super", name: "Super Game" },
      "Super-Game-2-1.0-win64.zip",
      "SuperGame.exe",
      ["number:2"],
    ],
    [{ id: "zz-doom-two", name: "Doom 2" }, "doom-2.1.0-win64.zip", "Doom2.exe", ["missing:2"]],
    [{ id: "zz-x", name: "Game" }, "Game-b2-win64.zip", "Game.exe", ["b2"]],
    [{ id: "zz-x", name: "Game" }, "Game-bin-1.0-win64.zip", "Game.exe", ["bin"]],
    [{ id: "zz-x", name: "Game" }, "Game-1-win64.zip", "Game.exe", ["number:1"]],
  ];
  for (const [fields, archive, program, tokens, repository] of withheld) {
    const { record, facts, decision } = decideOn(fields, archive, program, repository);
    assert.equal(reasonOf(decision), "archive-name-unaccounted", archive);
    assert.deepEqual((decision as { tokens?: string[] }).tokens, tokens, archive);
    assert.equal(gateArchiveAccount(archive, record.listing, facts.repository), null, archive);
    assert.match(gateOn(record, facts), /unaccounted token/u, archive);
  }
  // Doom 2's own archives enroll with a program named for it.
  for (const archive of ["doom2-1.0-win64.zip", "doom-2-1.0-win64.zip", "Doom-2-win64.zip"]) {
    const { record, facts, decision } = decideOn(
      { id: "zz-doom-two", name: "Doom 2" },
      archive,
      "Doom2.exe",
    );
    assert.ok(decision.fit, `${archive}: ${JSON.stringify(decision)}`);
    assert.equal(gateOn(record, facts), "accepted", archive);
  }
  // A dated build number of four digits stays a version.
  const dated = decideOn({ id: "zz-x", name: "Game" }, "Game-20261120-win64.zip", "Game.exe");
  assert.ok(dated.decision.fit, JSON.stringify(dated.decision));
  // Folders: a glued number is accounted only as an accounted name; `b2/`
  // is no version.
  const names = new Set(["doom"]);
  const words = new Set(["doom"]);
  for (const [path, leftover] of [
    ["Doom2/Doom.exe", "Doom2/"],
    ["b2/Doom.exe", "b2/"],
    // Sixth review: a folder's short integer must spell an accounted name.
    ["Doom-2/Doom.exe", "Doom-2/"],
    ["v2/Doom.exe", null],
    ["bin/Doom.exe", null],
  ] as const) {
    assert.equal(programNameUnaccounted(path, names, words, false), leftover, `fit ${path}`);
    assert.equal(
      gateProgramAccounted(path, [...names], [...words], false),
      leftover === null,
      `gate ${path}`,
    );
  }
  assert.equal(programNameUnaccounted("Doom2/Doom2.exe", new Set(["doom2"]), words, false), null);
  assert.ok(gateProgramAccounted("Doom2/Doom2.exe", ["doom2"], [...words], false));
});

void test("an archive without programs beside the offered one splits the package, in fit and gate (B3)", () => {
  const game = [player("Game/Game.exe")];
  for (const [offered, part] of [
    ["Game-1.0-win64.zip", "Game-assets-1.0.zip"],
    ["Game-1.0-win64.zip", "Game-data-1.0-win64.zip"],
    [windowsZip, "Game-data-1.0.zip"],
  ] as const) {
    const facts = entry([named(offered, game, 11, "windows"), named(part, [], 12)]);
    const decision = decide(listing(), facts);
    assert.equal(reasonOf(decision), "split-package", part);
    assert.match(gateOn(listing(), facts), /splits the game|rest of the game/u, part);
  }
  // `Game-bin-…` beside a data archive is withheld too (its `bin` is now unaccounted).
  const binary = entry([
    named("Game-bin-1.0-win64.zip", game, 11, "windows"),
    named("Game-data-1.0.zip", [], 12),
  ]);
  assert.ok(
    ["split-package", "archive-name-unaccounted"].includes(reasonOf(decide(listing(), binary))),
  );
  assert.notEqual(gateOn(listing(), binary), "accepted");
  // A part tied by its name to another platform, or a source archive, is no part.
  const linuxPart = entry([
    named("Game-1.0-win64.zip", game, 11, "windows"),
    named("Game-data-1.0-linux.tar.gz", [], 12, "linux"),
  ]);
  assert.ok(decide(listing(), linuxPart).fit);
  assert.equal(gateOn(listing(), linuxPart), "accepted");
  const source = entry([
    named("Game-1.0-win64.zip", game, 11, "windows"),
    named("Game-1.0-src.zip", [], 12),
  ]);
  assert.ok(decide(listing(), source).fit);
  assert.equal(gateOn(listing(), source), "accepted");
});

void test("a status word followed only by connector words and release, build or version stands (B4)", () => {
  const repository = "fixture-owner/zz-unseen";
  const rows: [string, string | null][] = [
    ["Demo version", "demo"],
    ["Demo build", "demo"],
    ["Beta build", "beta"],
    ["Beta release", "beta"],
    ["Alpha build", "alpha"],
    ["Nightly build", "nightly"],
    ["Preview build", "preview"],
    ["Canary release", "canary"],
    ["Release candidate build", "release-candidate"],
    ["Early access build", "early-access"],
    ["Super Game - Demo Version", "demo"],
    ["Beta release notes", null],
    ["Demolition release", null],
  ];
  for (const [line, token] of rows) {
    assert.equal(releaseStatement(line, repository), token, `fit: ${line}`);
    assert.equal(gateStatement(line, repository), token, `gate: ${line}`);
  }
  const words = listingWords({ id: "zz-beta-squadron", name: "Beta Squadron" });
  assert.equal(releaseStatement("Beta Squadron build", repository, words), null);
  assert.equal(gateStatement("Beta Squadron build", repository, words), null);
});

void test("the original title is no accepted name, one player only, and repository-only and numbered enrollments are queued (lead decisions)", () => {
  // A remake's listing does not enroll an archive named only for the original.
  const remake = listing(unseen, { name: "Remake", original_game_title: "Game" });
  const original = entry(
    [named(windowsZip, [player("Game/Game.exe")], 11, "windows")],
    {},
    unseen,
    {
      listing_words: listingWords(remake.listing),
    },
  );
  assert.equal(reasonOf(decide(remake, original)), "archive-name-unaccounted");
  assert.match(gateOn(remake, original), /unaccounted token/u);
  // Two product-named programs on one platform are ambiguous.
  const two = entry([
    named(windowsZip, [player("Game/bin/Game.exe"), player("Game/x64/Game.exe")], 11, "windows"),
  ]);
  assert.equal(reasonOf(decide(listing(), two)), "ambiguous-player");
  assert.match(gateOn(listing(), two), /more than one player/u);
  // Exactly one surviving the platform selection enrolls.
  const one = entry([
    named(
      windowsZip,
      [player("Game/bin/Game.exe"), player("Game/x64/Game.exe", "elf64-x86-64")],
      11,
    ),
  ]);
  assert.ok(decide(listing(), one).fit, JSON.stringify(decide(listing(), one)));
  // Queues: accepted by repository name only, and numbered products.
  const byRepository = listing("zz-other-name", {
    name: "Other Name",
    project_url: "https://github.com/fixture-owner/game",
  });
  const numbered = listing("zz-doom-two", { name: "Doom 2" });
  const facts = table(
    entry([named(windowsZip, [player("Game/Game.exe")], 11, "windows")], {}, "zz-other-name", {
      repository: "fixture-owner/game",
      listing_words: listingWords(byRepository.listing),
    }),
    entry([named("Doom-2-win64.zip", [player("Doom2.exe")], 11, "windows")], {}, "zz-doom-two", {
      listing_words: listingWords(numbered.listing),
    }),
  );
  const generation = generateRegistrations([byRepository, numbered], facts);
  assert.equal(generation.enrollments.length, 2);
  const queues = registrationQueues(generation);
  assert.deepEqual(queues.accepted_by_repository_name_only, ["zz-other-name"]);
  assert.deepEqual(queues.numbered_products, ["zz-doom-two"]);
});

void test("any digit chunk, b<N>, bin or extra token outside the rules withholds, in fit and gate (B property)", () => {
  let seed = 8_569_005;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const record = listing("zz-super", { name: "Super Game" });
  const repository = "fixture-owner/zz-super";
  const bad = () =>
    pick([
      String(1 + Math.floor(random() * 99)),
      `b${1 + Math.floor(random() * 9)}`,
      "bin",
      "lite",
      `rc${Math.floor(random() * 5)}`,
      "demo2",
    ]);
  let withheld = 0;
  for (let round = 0; round < 4000; round++) {
    const parts = ["Super", "Game"];
    if (random() < 0.6) parts.push(pick(["1.0", "v1.2.3", "2.0.1", "v3"]));
    if (random() < 0.6) parts.push(pick(["win64", "x86_64", "linux", "macos", "portable"]));
    const extra = random() < 0.6 ? bad() : null;
    if (extra !== null) parts.splice(Math.floor(random() * (parts.length + 1)), 0, extra);
    const name = `${parts.join(pick(["-", "_", " "]))}.zip`;
    const fit = archiveNameAccount(name, record.listing, repository);
    const gate = gateArchiveAccount(name, record.listing, repository);
    assert.equal("product" in fit ? fit.product : null, gate, `parity ${name}`);
    if (extra !== null) {
      assert.ok("unaccounted" in fit, `${extra} withholds ${name}`);
      withheld++;
    }
  }
  assert.ok(withheld > 1500);
});

// ---------------------------------------------------------------------------
// Sixth review at a1b2e364: the ordered grammar, folder numbers, relief forms,
// release titles before a number, and the year and tool-only queues.

void test("archive names follow PRODUCT (VERSION | NEUTRAL)*, in fit and gate (grammar 1)", () => {
  const check = (fields: Record<string, unknown>, archive: string, product: string | null) => {
    const id = String(fields.id);
    const record = listing(id, fields);
    const repository = `fixture-owner/${id}`;
    const fit = archiveNameAccount(archive, record.listing, repository);
    assert.equal("product" in fit ? fit.product : null, product, `fit ${archive}`);
    assert.equal(
      gateArchiveAccount(archive, record.listing, repository),
      product,
      `gate ${archive}`,
    );
    return { record, id };
  };
  const two = { id: "zz-game-two", name: "Game 2" };
  for (const archive of [
    "Game-1.0-2-win64.zip",
    "Game-v1-2-win64.zip",
    "Game-r5-2-win64.zip",
    "Game-2024-2-win64.zip",
    "Game-win64-2.zip",
    "Game-1.0.0-2_amd64.zip",
  ]) {
    const { record, id } = check(two, archive, null);
    const facts = entry([named(archive, [player("Game2.exe")], 11, "windows")], {}, id, {
      listing_words: listingWords(record.listing),
    });
    assert.equal(reasonOf(decide(record, facts)), "archive-name-unaccounted", archive);
    assert.match(gateOn(record, facts), /unaccounted token/u, archive);
  }
  check({ id: "zz-open-three", name: "Open 3" }, "OPEN_1.2-3.win64.tar.xz", null);
  check({ id: "zz-super", name: "Super Game" }, "Super-1.0-Game.zip", null);
  check({ id: "zz-super", name: "Super Game" }, "Super-Game-v3-32-linux.zip", null);
  check(two, "Game-2-1.0-win64.zip", "game2");
  check({ id: "zz-doom-two", name: "Doom 2" }, "doom2-2.1.0-win64.zip", "doom2");
  check({ id: "zz-doom-two", name: "Doom 2" }, "doom2-1.0-win64.zip", "doom2");
  check({ id: "zz-x", name: "Game" }, "Game-1.0-win64-20261120.zip", "game");
  // A four-digit integer read as a version is queued for a person.
  const doom = check({ id: "zz-doom", name: "Doom" }, "doom-2016-win64.zip", "doom");
  const facts = entry(
    [named("doom-2016-win64.zip", [player("Doom.exe")], 11, "windows")],
    {},
    doom.id,
    {
      listing_words: listingWords(doom.record.listing),
    },
  );
  const generation = generateRegistrations([doom.record], table(facts));
  assert.deepEqual(registrationQueues(generation).integer_as_version, ["zz-doom"]);
});

void test("folders follow the grammar per segment: a short integer must spell an accounted name (grammar 2)", () => {
  const words = new Set(["doom", "game"]);
  for (const [path, names, leftover] of [
    ["Doom-2/doom.exe", ["doom"], "Doom-2/"],
    ["Doom 2/doom.exe", ["doom"], "Doom 2/"],
    ["Doom/2/doom.exe", ["doom"], "2/"],
    ["Game-3/game.exe", ["game"], "Game-3/"],
    ["Game-1.0-2/game.exe", ["game", "game2"], "Game-1.0-2/"],
    ["Doom-2/doom2.exe", ["doom2"], null],
    ["Game-1.0.2/game.exe", ["game"], null],
    ["Game-v3/game.exe", ["game"], null],
    ["Game-2026/game.exe", ["game"], null],
  ] as const) {
    assert.equal(
      programNameUnaccounted(path, new Set(names), words, false),
      leftover,
      `fit ${path}`,
    );
    assert.equal(
      gateProgramAccounted(path, [...names], [...words], false),
      leftover === null,
      `gate ${path}`,
    );
  }
});

void test("same-product relief applies only to recognised package forms and the listing's own names (relief 3)", () => {
  const record = listing(unseen, { name: "Game" });
  const archive = named("Game-1.0-win64.zip", [player("Game.exe")], 11, "windows");
  const decideWith = (form: string) => {
    const facts = entry([archive], {}, unseen, { other_packages: [otherForm(19, form, W)] });
    return { facts, decision: decide(record, facts) };
  };
  for (const form of ["Game-1.0.pk3", "Game-1.0.wad", "Game-1.0.xyz"]) {
    const { facts, decision } = decideWith(form);
    assert.equal(reasonOf(decision), "other-package-form-beside-archive", form);
    assert.match(forcedOn(facts, record, 11, "windows-x86-64"), /another package for/u, form);
    assert.equal(reliefForm(form), false, form);
  }
  for (const form of ["Game-1.0-Setup.exe", "Game-1.0.7z", "Game-1.0.rar", "Game-1.0.tar.bz2"]) {
    const { facts, decision } = decideWith(form);
    assert.ok(decision.fit, `${form}: ${JSON.stringify(decision)}`);
    assert.equal(
      gateGeneration(null, generateRegistrations([record], table(facts))).added.length,
      1,
    );
    assert.equal(reliefForm(form), true, form);
  }
  // The original game's title gives no relief.
  assert.equal(
    sameProductForm("Game-1.0-Setup.exe", [archive], "windows-x86-64", {
      id: "zz-remake",
      name: "Remake",
      original_game_title: "Game",
    }),
    false,
  );
});

void test("release, build and version between a status word and its number keep it standing (titles 4)", () => {
  const repository = "fixture-owner/zz-unseen";
  for (const [line, token] of [
    ["Beta release 1.0", "beta"],
    ["Alpha release 0.1", "alpha"],
    ["Demo release 2", "demo"],
    ["Nightly release 20261101", "nightly"],
    ["Super Game Beta Release 0.9", "beta"],
    ["Beta release (1.0)", "beta"],
    ["Beta release 0.9.1 - new maps", "beta"],
    ["Beta release notes", null],
  ] as const) {
    assert.equal(releaseStatement(line, repository), token, `fit: ${line}`);
    assert.equal(gateStatement(line, repository), token, `gate: ${line}`);
  }
  const words = listingWords({ id: "zz-beta-squadron", name: "Beta Squadron" });
  assert.equal(releaseStatement("Beta Squadron release 2", repository, words), null);
  assert.equal(gateStatement("Beta Squadron release 2", repository, words), null);
});

void test("archives holding only tool-vetoed programs beside the offered one are counted", () => {
  const facts = entry([
    named(windowsZip, [player("Game/Game.exe")], 11, "windows"),
    named("Game-tools-1.0-win64.zip", [player("Game/Patcher.exe")], 12, "windows"),
  ]);
  const generation = generateRegistrations([listing()], table(facts));
  assert.equal(generation.enrollments.length, 1, JSON.stringify(generation.decisions));
  assert.deepEqual(registrationQueues(generation).tool_only_archives_beside, [unseen]);
});

void test("any product word or short integer after a version or neutral token withholds, in fit and gate (grammar property)", () => {
  let seed = 8_569_006;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const record = listing("zz-super-two", { name: "Super Game 2" });
  const repository = "fixture-owner/zz-super-two";
  const product = ["Super", "Game", "2"];
  const tail = ["1.0", "v3", "r2", "win64", "x86_64", "linux", "portable", "20261120", "macos"];
  let late = 0;
  for (let round = 0; round < 5000; round++) {
    const parts = [...product];
    const after: string[] = Array.from({ length: Math.floor(random() * 3) }, () => pick(tail));
    let lateBad = false;
    if (after.length && random() < 0.5) {
      const bad = pick(["Game", "Super", "Other", "2", "7", "42"]);
      after.splice(1 + Math.floor(random() * after.length), 0, bad);
      lateBad = true;
    }
    const name = `${[...parts, ...after].join(pick(["-", "_", " "]))}.zip`;
    const fit = archiveNameAccount(name, record.listing, repository);
    const gate = gateArchiveAccount(name, record.listing, repository);
    assert.equal("product" in fit ? fit.product : null, gate, `parity ${name}`);
    if (lateBad) {
      assert.ok("unaccounted" in fit, `a late token withholds ${name}`);
      late++;
    } else assert.ok("product" in fit, `accounted ${name}`);
  }
  assert.ok(late > 1000);
});

// ---------------------------------------------------------------------------
// Name reliefs (generator 23): partial names, initialisms, measured port
// descriptors, build identifiers and folders spelled like the archive. Each
// relief only accounts for tokens; every contradiction still withholds.

/** A listing whose id spells nothing an archive below uses, bound to its own repository. */
function reliefRecord(key: string, name: string, repository: string) {
  return listing(`zz-relief-${key}`, {
    name,
    original_game_title: name,
    project_url: `https://github.com/fixture-owner/${repository}`,
  });
}
/** The archive account in fit and gate, which must agree on the product. */
function reliefAccount(
  name: string,
  repository: string,
  archive: string,
  others: readonly AuthoredPort[] = [],
) {
  const record = reliefRecord("account", name, repository);
  const lists = others.map((other) => other.listing as Record<string, unknown>);
  const fit = archiveNameAccount(archive, record.listing, `fixture-owner/${repository}`, lists);
  const gate = gateArchiveAccount(archive, record.listing, `fixture-owner/${repository}`, lists);
  assert.equal("product" in fit ? fit.product : null, gate, `fit and gate agree on ${archive}`);
  return fit;
}
/** A whole Windows decision in fit and gate for one archive holding one program. */
function reliefDecision(
  key: string,
  name: string,
  repository: string,
  archive: string,
  programs: readonly string[],
  options: { extra?: ArtifactFactV2[]; others?: AuthoredPort[] } = {},
) {
  const record = reliefRecord(key, name, repository);
  const facts = entry(
    [
      named(
        archive,
        programs.map((path) => player(path)),
        11,
        "windows",
      ),
      ...(options.extra ?? []),
    ],
    {},
    record.listing.id,
    { repository: `fixture-owner/${repository}`, listing_words: listingWords(record.listing) },
  );
  const others = options.others ?? [];
  const decision = fitDecision(record, facts, generatedAt, fitContext([record, ...others]));
  return { record, facts, decision, gate: gateOn(record, facts, { others }) };
}

void test("measured shapes (a)-(f) enroll under the name reliefs, in fit and gate, and record their relief", () => {
  // Archive accounts: [listing title, repository, archive, reliefs].
  const accounted: [string, string, string, string[]][] = [
    // (a) the archive spells part of an accepted name.
    [
      "Crackdown (Crackdown Recompiled)",
      "crackdown-xbox360-recompiled",
      "Crackdown-v0.6.2-windows-x64.zip",
      ["partial-name"],
    ],
    // Generator 26: the repository's name minus its descriptor spells it
    // (equal, no uniqueness check needed), before the listing's initialism.
    ["Dead or Alive 3 (DOA3 Recomp)", "doa3-recomp", "DOA3-v1.0.7-win64.zip", ["partial-name"]],
    [
      "The Sims (Original Xbox Static Recompilation)",
      "sims1-recomp",
      "Sims1-win64.zip",
      // The omitted trailing "Recompilation" is recorded as a partial name.
      ["partial-name"],
    ],
    [
      "Crusader: No Remorse / SDL port",
      "crusader-no-remorse-decomp",
      "crusader-no-remorse-1.69.0-windows-x64.zip",
      ["partial-name"],
    ],
    [
      "SEAL Team / SealTeam Source Port",
      "SealTeam-Source-Port",
      "SealTeam-0.6.1-windows-x64.zip",
      ["partial-name"],
    ],
    [
      "Earthworm Jim HD Recompiled",
      "earthworm-jim-hd-recompiled",
      "EarthwormJimHD-v0.9.6-windows-x64.zip",
      ["partial-name"],
    ],
    [
      "CyberMage: Darklight Re-Awakening",
      "cybermage-darklight-re-awakening",
      "cybermage-windows-x64.zip",
      ["partial-name"],
    ],
    // The title as measured already spells these exactly.
    ["The Bigs 2", "The-Bigs-2-Recompiled", "TheBigs2-windows-x64.zip", []],
    ["Bust A Groove", "BustAGrooveRecompiled-Releases", "BustAGroove-v0.1.0-windows-x64.zip", []],
    // Generator 26: the repository's name minus its descriptor, as for DOA3.
    ["Import Tuner Challenge", "ITC-Recomp", "itc-v0.5.0-win-amd64.zip", ["partial-name"]],
    // (b) the archive adds a measured port descriptor.
    ["Dark Rift", "DarkRiftRecomp", "DarkRiftRecompiled-macOS-arm64.zip", ["descriptor"]],
    ["F-Zero X", "f-zero-x-recomp", "FZeroXRecompiled-v0.1.16-windows-x64.zip", ["descriptor"]],
    // Generator 26: `ki` is no initialism (N1); the repository name spells it.
    [
      "Killer Instinct",
      "ki-recomp",
      "KIRecompiled-macOS-arm64.zip",
      ["partial-name", "descriptor"],
    ],
    [
      "Gears of War 2",
      "gears-of-war-2-pc-port",
      "gow2-recomp-0.4.7-linux-x86_64.tar.gz",
      ["initialism", "descriptor"],
    ],
    [
      "MechAssault 2: Lone Wolf",
      "mechassault-2-recomp",
      "MechAssault2-PC-v0.1.0-win-x64.zip",
      ["partial-name", "descriptor"],
    ],
    ["Skate 2", "skate2-recomp", "Skate2-PC-v0.2.0.zip", ["descriptor"]],
    ["Skate", "skate1-recomp", "Skate1-PC-v0.2.0.zip", ["partial-name", "descriptor"]],
    ["Lantern", "lantern", "Lantern-native-1.4-win64.zip", ["descriptor"]],
    ["Lantern", "lantern", "Lantern-1.4-windows-native.zip", ["descriptor"]],
    ["Lantern", "lantern", "Lantern-1.4-macos-uni.zip", ["descriptor"]],
    ["Lantern", "lantern", "Lantern-uni-macOS-1.4.zip", ["descriptor"]],
    ["Lantern", "lantern", "Lantern-USA-1.0-win64.zip", ["descriptor"]],
    ["Lantern", "lantern", "Lantern-1.0-ntsc-win64.zip", ["descriptor"]],
    ["Lantern", "lantern", "Lantern-PAL-1.0-win64.zip", ["descriptor"]],
    // (c) initialisms of an accepted name.
    ["Tony Hawk's Pro Skater", "skater-port", "thps-1.0-win64.zip", ["initialism"]],
    ["Sega Superstars Tennis", "tennis-port", "sst-1.0-win64.zip", ["initialism"]],
    ["RalliSport Challenge", "challenge-port", "rsc-1.0-win64.zip", ["initialism"]],
    ["God Hand Rearmed", "rearmed-port", "ghr-1.0-win64.zip", ["initialism"]],
    ["Gears of War", "war-port", "gow-1.0-win64.zip", ["initialism"]],
    ["Monster Hunter Generations Ultimate", "ultimate-port", "mhgu-1.0-win64.zip", ["initialism"]],
    ["Digimon World 2", "world-port", "dw2-1.0-win64.zip", ["initialism"]],
    ["Wayne Gretzky's 3D Hockey", "hockey-port", "wg3d-1.0-win64.zip", ["initialism"]],
    ["Dead or Alive 3", "alive-port", "doa3-1.0-win64.zip", ["initialism"]],
    ["OpenTESArena", "arena-port", "otesa-1.0-win64.zip", ["initialism"]],
    // (f) build identifiers.
    ["Lantern", "lantern", "Lantern-e1625759-windows-x64.zip", ["build-id"]],
    ["Lantern", "lantern", "Lantern-0.79.0c97cca-windows-x64.zip", ["build-id"]],
    ["Symphony", "SymphonyRecomp", "SymphonyRecomp-v1.2.0p-windows-x64.zip", ["build-id"]],
    ["Condemned 2", "condemned2recomp", "condemned2recompV0.6.1_windows.zip", ["build-id"]],
  ];
  for (const [name, repository, archive, reliefs] of accounted) {
    const fit = reliefAccount(name, repository, archive);
    assert.ok("product" in fit, `${archive}: ${JSON.stringify(fit)}`);
    assert.deepEqual(
      fit.reliefs.toSorted(),
      reliefs.toSorted(),
      `${archive} is accounted under ${reliefs.join(", ") || "exact names"}`,
    );
  }
  // Whole decisions on Windows: the archive and its program enroll, in fit and gate.
  const decisions: [string, string, string, string, string[]][] = [
    [
      "Crackdown (Crackdown Recompiled)",
      "crackdown-xbox360-recompiled",
      "Crackdown-v0.6.2-windows-x64.zip",
      "Crackdown.exe",
      ["partial-name"],
    ],
    [
      "Dead or Alive 3 (DOA3 Recomp)",
      "doa3-recomp",
      "DOA3-v1.0.7-win64.zip",
      "DOA3.exe",
      ["partial-name"],
    ],
    [
      "Crusader: No Remorse / SDL port",
      "crusader-no-remorse-decomp",
      "crusader-no-remorse-1.69.0-windows-x64.zip",
      "crusader.exe",
      ["partial-name"],
    ],
    [
      "SEAL Team / SealTeam Source Port",
      "SealTeam-Source-Port",
      "SealTeam-0.6.1-windows-x64.zip",
      "SealTeam.exe",
      ["partial-name"],
    ],
    [
      "CyberMage: Darklight Re-Awakening",
      "cybermage-darklight-re-awakening",
      "cybermage-windows-x64.zip",
      "CyberMage.exe",
      ["partial-name"],
    ],
    [
      "F-Zero X",
      "f-zero-x-recomp",
      "FZeroXRecompiled-v0.1.16-windows-x64.zip",
      "FZeroX.exe",
      ["descriptor"],
    ],
    [
      "MechAssault 2: Lone Wolf",
      "mechassault-2-recomp",
      "MechAssault2-PC-v0.1.0-win-x64.zip",
      "MechAssault2.exe",
      ["partial-name", "descriptor"],
    ],
    [
      "Import Tuner Challenge",
      "ITC-Recomp",
      "itc-v0.5.0-win-amd64.zip",
      "itc.exe",
      ["partial-name"],
    ],
    ["Lantern", "lantern", "Lantern-e1625759-windows-x64.zip", "Lantern.exe", ["build-id"]],
    [
      "Condemned 2",
      "condemned2recomp",
      "condemned2recompV0.6.1_windows.zip",
      "Condemned2.exe",
      ["build-id"],
    ],
  ];
  for (const [index, [name, repository, archive, program, reliefs]] of decisions.entries()) {
    const { decision, gate } = reliefDecision(`d${index}`, name, repository, archive, [program]);
    assert.ok(decision.fit, `${archive}: ${JSON.stringify(decision)}`);
    assert.deepEqual(decision.reliefs.toSorted(), reliefs.toSorted(), archive);
    assert.equal(gate, "accepted", archive);
  }
});

void test("program and folder names use the reliefs, beside no other package form (d, e)", () => {
  // (d) programs that spell part of an accepted name, a descriptor or an initialism.
  const programs: [string, string, string, string][] = [
    ["Star Wars: Shadows of the Empire", "sote-port", "shadowsoftheempire.exe", "partial-name"],
    ["Silent Hill: Origins Recompiled", "sho-port", "silenthillorigins.exe", "partial-name"],
    [
      "Final Fantasy Crystal Chronicles: Crystal Defenders",
      "ffcd-port",
      "crystaldefenders.exe",
      "partial-name",
    ],
    ["Dragon's Crown Pro Recompiled", "dcp-port", "dragonscrownpro.exe", "partial-name"],
    ["Ogre Battle 64: Person of Lordly Caliber", "ob-port", "ogrebattle64.exe", "partial-name"],
    ["Tony Hawk's Proving Ground", "thpg-port", "provingground.exe", "partial-name"],
    ["Rampage: Total Destruction", "rtd-port", "rampage.exe", "partial-name"],
    ["Brogue CE", "bce-port", "brogue.exe", "partial-name"],
    ["Digimon World 2", "dmw-port", "dw2.exe", "initialism"],
    ["Wayne Gretzky's 3D Hockey", "wgh-port", "wg3d.exe", "initialism"],
    ["OpenTESArena", "ota-port", "otesa.exe", "initialism"],
    ["Battle Arena Toshinden", "bat-port", "battlearenatoshindenrecompiled.exe", "descriptor"],
    ["Macross VF-X2", "vfx-port", "macrossvfx2recompiled.exe", "descriptor"],
    ["Naruto: The Broken Bond", "ntbb-port", "narutothebrokenbondpc.exe", "descriptor"],
    ["Ogre Battle 64: Person of Lordly Caliber", "ob-port", "ogrebattle64-x64.exe", "partial-name"],
  ];
  for (const [name, repository, path, relief] of programs) {
    const record = reliefRecord("program", name, repository);
    const names = new Set([repository.replace(/[^a-z0-9]/gu, "")]);
    const forms = reliefForms(record.listing, `fixture-owner/${repository}`, "");
    const used = new Set<(typeof nameReliefs)[number]>();
    assert.equal(programNameUnaccounted(path, names, new Set(), false, forms, used), null, path);
    assert.ok(used.has(relief as (typeof nameReliefs)[number]), `${path} under ${relief}`);
    assert.ok(gateProgramAccounted(path, [...names], [], false, forms), `gate ${path}`);
    // Beside another package form the literal stays strict.
    assert.equal(programNameUnaccounted(path, names, new Set(), true, forms), literalOf(path));
    assert.equal(gateProgramAccounted(path, [...names], [], true, forms), false, `strict ${path}`);
  }
  // Whole decisions: a relieved program enrolls.
  const shadows = reliefDecision(
    "shadows",
    "Star Wars: Shadows of the Empire",
    "shadows-recomp",
    "ShadowsRecomp-1.0-win64.zip",
    ["shadowsoftheempire.exe"],
  );
  assert.ok(shadows.decision.fit, JSON.stringify(shadows.decision));
  assert.deepEqual(shadows.decision.reliefs, ["partial-name"]);
  assert.equal(shadows.gate, "accepted");
  // (e) folders that are the accepted product, versions and neutral words.
  const folders: [string, string, string, string][] = [
    [
      "Amped 2 (Xbox)",
      "Amped2-Recomp",
      "Amped2-Recomp-v0.2.0-windows-x86_64.zip",
      "Amped2-Recomp-v0.2.0-windows-x86_64/Amped2Recomp.exe",
    ],
    [
      "SSX 3 (Recompiled)",
      "SSX3-Recomp",
      "SSX3-Recomp-v0.3.0-windows-x86_64.zip",
      "SSX3-Recomp-v0.3.0-windows-x86_64/SSX3Recomp.exe",
    ],
    [
      "Dora 64 3 (Nintendo 64)",
      "Dora64-3",
      "Dora64-3-1.0.0-Windows-x64.zip",
      "Dora64-3-1.0.0-Windows-x64/Dora643.exe",
    ],
  ];
  for (const [index, [name, repository, archive, path]] of folders.entries()) {
    const { decision, gate } = reliefDecision(`f${index}`, name, repository, archive, [path]);
    assert.ok(decision.fit, `${path}: ${JSON.stringify(decision)}`);
    assert.deepEqual(decision.reliefs, ["folder"], path);
    assert.equal(gate, "accepted", path);
  }
  // A folder of the product's name with a wrong number, another word or a
  // channel word still withholds.
  for (const path of [
    "Amped3-Recomp-v0.2.0-windows-x86_64/Amped2Recomp.exe",
    "Amped2-Recomp-Server-v0.2.0/Amped2Recomp.exe",
    "Amped2-Recomp-beta-v0.2.0/Amped2Recomp.exe",
    "Amped2-Recomp-v0.2.0-uni/Amped2Recomp.exe",
  ]) {
    const { decision, gate } = reliefDecision(
      "fx",
      "Amped 2 (Xbox)",
      "Amped2-Recomp",
      "Amped2-Recomp-v0.2.0-windows-x86_64.zip",
      [path],
    );
    assert.ok(!decision.fit, path);
    assert.notEqual(gate, "accepted", path);
  }
});

/** A program's literal name, as the fit reports it unaccounted. */
function literalOf(path: string) {
  return path
    .slice(path.lastIndexOf("/") + 1)
    .toLowerCase()
    .replace(/\.exe$/u, "")
    .replace(/[^a-z0-9]+/gu, "");
}

void test("what the reliefs do not cover stays withheld: channel, variant and role words, numbers, generic partial names (stay withheld)", () => {
  const withheld: [string, string, string][] = [
    // Channel and prerelease words, glued or apart.
    ["Conan", "conan", "Conan.Beta1.FIXED.zip"],
    ["OpenH3M", "OpenH3M", "OpenH3M-beta-0.8-win-x64.zip"],
    ["PaxDino", "paxdino", "PaxDino-0.1.6-beta-windows.zip"],
    ["Lantern", "lantern", "Lantern-1.0-preview-win64.zip"],
    ["Lantern", "lantern", "Lantern-1.2.0b2-win64.zip"],
    ["Lantern", "lantern", "Lantern-1.2.0rc1-win64.zip"],
    ["Lantern", "lantern", "Lantern-1.0a-win64.zip"],
    ["Lantern", "lantern", "Lantern-1.0b-win64.zip"],
    ["Lantern", "lantern", "Lantern-1.0r-win64.zip"],
    ["Lantern", "lantern", "Lantern-v1.0-beta2-win64.zip"],
    // Variant words that are no descriptors.
    ["Lantern", "lantern", "Lantern-mods-1.0-win64.zip"],
    ["Lantern", "lantern", "Lantern-deck-1.0-linux.tar.gz"],
    ["Lantern", "lantern", "Lantern-Extended-1.0-win64.zip"],
    ["Lantern", "lantern", "Lantern-1.0-fixed-win64.zip"],
    ["Lantern", "lantern", "Lantern-HD-1.0-win64.zip"],
    ["Lantern", "lantern", "Lantern-Remastered-1.0-win64.zip"],
    ["Lantern", "lantern", "Lantern-Classic-1.0-win64.zip"],
    ["Lantern", "lantern", "Lantern-Lite-1.0-win64.zip"],
    ["Lantern", "lantern", "Lantern-nightly-win64.zip"],
    // Descriptors cannot smuggle a variant.
    ["Lantern", "lantern", "Lantern-PC-Demo-1.0-win64.zip"],
    ["Lantern", "lantern", "Lantern-Recompiled-Server-1.0-win64.zip"],
    ["Lantern", "lantern", "Lantern-Recomp-Trial-1.0-win64.zip"],
    ["Lantern", "lantern", "Lantern-1.0-win64-native-dev.zip"],
    // `uni` only beside a macOS word.
    ["Lantern", "lantern", "Lantern-1.4-uni.zip"],
    ["Lantern", "lantern", "Lantern-1.4-windows-uni.zip"],
    // A hash before the product, or a short hex word, is no build identifier.
    ["Lantern", "lantern", "e1625759-Lantern-win64.zip"],
    ["Lantern", "lantern", "Lantern-abc12-win64.zip"],
    // A partial name of generic words only.
    ["The Game", "the-game", "game-1.0.zip"],
    ["Star Wars: The Game", "star-wars-the-game", "The-Game-1.0-win64.zip"],
    ["Super Mario Edition", "sme", "Edition-1.0-win64.zip"],
    ["Lantern Recompiled", "lantern-recompiled", "Recompiled-1.0-win64.zip"],
    // Numbers are never optional, in either direction and across names.
    ["Doom 2", "zz-doom", "Doom-1.0-win64.zip"],
    ["Doom 2", "zz-doom", "doom-2.1.0-win64.zip"],
    ["Doom 2", "zz-doom", "Doom3-win64.zip"],
    ["Doom", "zz-doom", "Doom-2-win64.zip"],
    ["Doom", "doom-port", "Doom2-PC-win64.zip"],
    ["Skate 2", "skate-port", "Skate-PC-v0.2.0.zip"],
    ["Skate", "skate-recomp", "Skate2-PC-v0.2.0.zip"],
    ["The Sims 2", "sims1-recomp", "Sims1-win64.zip"],
    ["MechAssault 2: Lone Wolf", "mechassault-recomp", "MechAssault-PC-v0.1.0-win-x64.zip"],
    ["Digimon World 2", "world-port", "dw-1.0-win64.zip"],
    ["Digimon World 2", "world-port", "dw3-1.0-win64.zip"],
    // Initialisms that are deny, edition or neutral words, or no initials.
    ["Hyper Drive", "hyper-port", "hd-1.0-win64.zip"],
    ["Deluxe Xtreme", "xtreme-port", "dx-1.0-win64.zip"],
    ["Crystal Dungeon", "dungeon-port", "cd-1.0-win64.zip"],
    ["Rogue Escape", "escape-port", "re-1.0-win64.zip"],
    ["Data Editor Bundle Utility Group", "group-port", "debug-1.0-win64.zip"],
    ["Dead Easy Mode Overture", "overture-port", "demo-1.0-win64.zip"],
    ["Space Game", "space-port", "sc-1.0-win64.zip"],
    ["Dead or Alive 3", "alive-port", "do-1.0-win64.zip"],
    ["Wayne Gretzky's 3D Hockey", "hockey-port", "wg3-1.0-win64.zip"],
    ["The Game", "the-port", "tg-1.0-win64.zip"],
    ["Earthworm Jim", "jim-port", "ewj-1.0-win64.zip"],
    // Review findings: roman sequel numbers are numbers, a number beside a
    // distinctive word is never optional, and descriptors are whole tokens.
    ["Doom II", "doom-ii-port", "Doom-1.0-win64.zip"],
    ["Star Wars Battlefront II", "swbf2-port", "StarWarsBattlefront-1.0-win64.zip"],
    ["Final Fantasy VII", "ff7-port", "FinalFantasy-1.0-win64.zip"],
    ["Final Fantasy VII", "ff7-port", "Final-1.0-win64.zip"],
    ["Diablo II: Lord of Destruction", "lod-port", "Diablo-1.0-win64.zip"],
    ["Teenage Mutant Ninja Turtles II", "tmnt2-port", "tmnt-1.0-win64.zip"],
    ["Super Mario Bros. 3", "smb3-port", "Super-1.0-win64.zip"],
    ["Silent Hill 2", "sh2-port", "Silent-1.0-win64.zip"],
    ["Sonic 3: Angel Island Revisited", "s3air-port", "Island-1.0-win64.zip"],
    ["Al", "al-game", "Portal-1.0-win64.zip"],
    ["Super Mario Bros", "smb-port", "Superport-1.0-win64.zip"],
    // Older must-withhold rows.
    ["Super Game", "super-port", "SuperGame2-1.0-win64.zip"],
    ["Super Game", "super-port", "Super-Other-1.0-win64.zip"],
    ["Super Game", "super-port", "SuperGame-Trial-1.0-win64.zip"],
    ["Game 2", "game-port", "Game-1.0-2-win64.zip"],
    ["Game", "game", "Game-b2-win64.zip"],
    ["Game", "game", "Game-bin-1.0-win64.zip"],
  ];
  for (const [name, repository, archive] of withheld) {
    const fit = reliefAccount(name, repository, archive);
    assert.ok(!("product" in fit), `${archive} for ${name}: ${JSON.stringify(fit)}`);
  }
  // An exact spelling of the id or repository name drops no number another
  // accepted name links to a kept word either (`doom` for "Doom 2").
  for (const repository of ["doom", "doom-port"]) {
    const record = listing("doom", {
      name: "Doom 2",
      original_game_title: "Doom 2",
      project_url: `https://github.com/fixture-owner/${repository}`,
    });
    const fit = archiveNameAccount(
      "Doom-1.0-win64.zip",
      record.listing,
      `fixture-owner/${repository}`,
    );
    assert.ok(!("product" in fit), `${repository}: ${JSON.stringify(fit)}`);
    assert.equal(
      gateArchiveAccount("Doom-1.0-win64.zip", record.listing, `fixture-owner/${repository}`),
      null,
    );
  }
  // The roman number kept, and a descriptor as its own token, still enroll.
  assert.ok("product" in reliefAccount("Doom II", "doom-ii-port", "Doom-II-1.0-win64.zip"));
  assert.ok(
    "product" in reliefAccount("Final Fantasy VII", "ff7-port", "FinalFantasyVII-PC-win64.zip"),
  );
  assert.ok("product" in reliefAccount("Al", "al-game", "Port-Al-1.0-win64.zip"));
  // Program descriptors stand only in a leading or trailing run.
  const portal = reliefForms(
    reliefRecord("program", "Al", "al-game").listing,
    "fixture-owner/al-game",
    "",
  );
  assert.notEqual(programNameUnaccounted("Portal.exe", new Set(), new Set(), false, portal), null);
  assert.equal(gateProgramAccounted("Portal.exe", [], [], false, portal), false);
  assert.equal(programNameUnaccounted("AlPort.exe", new Set(), new Set(), false, portal), null);
  assert.ok(gateProgramAccounted("AlPort.exe", [], [], false, portal));
  // A folder may end in a date or build number of four or more digits.
  const dated = reliefDecision(
    "dated",
    "Amped 2 (Xbox)",
    "Amped2-Recomp",
    "Amped2-Recomp-v0.2.0-windows-x86_64.zip",
    ["Amped2-Recomp-v0.2.0-20240101/Amped2Recomp.exe"],
  );
  assert.ok(dated.decision.fit, JSON.stringify(dated.decision));
  assert.equal(dated.gate, "accepted");
  // A real initialism no list holds is one: `sc2` for "Super Contra 2". Two
  // letters alone are no initialism since generator 26 (N1): `sc` for "Super
  // Contra" withholds.
  assert.ok("product" in reliefAccount("Super Contra 2", "contra-port", "sc2-1.0-win64.zip"));
  assert.ok(!("product" in reliefAccount("Super Contra", "contra-port", "sc-1.0-win64.zip")));
  for (const word of ["sc", "dx", "hd", "cd", "re"])
    assert.equal(
      nameInitialisms(nameForm(`${word[0]!.toUpperCase()}ame ${word[1]!.toUpperCase()}ore 2`)).has(
        `${word}2`,
      ),
      !["dx", "hd", "cd", "re"].includes(word),
      word,
    );
  // A year in brackets and a console number apart from a kept word may go.
  assert.ok("product" in reliefAccount("Lantern (1998)", "lantern-port", "Lantern-1.0-win64.zip"));
  assert.ok(
    "product" in reliefAccount("Lantern: Xbox 360 Edition", "x-port", "Lantern-1.0-win64.zip"),
  );
  // Whole decisions on a relieved archive: launcher entries, role programs,
  // split packages and another package form still withhold.
  const crackdown = (programs: string[], extra: ArtifactFactV2[] = []) =>
    reliefDecision(
      "c",
      "Crackdown (Crackdown Recompiled)",
      "crackdown-xbox360-recompiled",
      "Crackdown-v0.6.2-windows-x64.zip",
      programs,
      { extra },
    );
  const launcher = crackdown(["CrackdownLauncher.exe"]);
  assert.equal(reasonOf(launcher.decision), "launcher-entry");
  assert.notEqual(launcher.gate, "accepted");
  // Core's tool veto or the role rule excludes a server program first.
  const server = crackdown(["Crackdown-server.exe"]);
  assert.ok(!server.decision.fit);
  assert.notEqual(server.gate, "accepted");
  const folderRole = crackdown(["server/Crackdown.exe"]);
  assert.equal(reasonOf(folderRole.decision), "role-program");
  assert.notEqual(folderRole.gate, "accepted");
  const recompiledServer = crackdown(["CrackdownRecompiledServer.exe"]);
  assert.ok(!recompiledServer.decision.fit);
  assert.notEqual(recompiledServer.gate, "accepted");
  const split = crackdown(["Crackdown.exe"], [named("Crackdown-data-0.6.2.zip", [], 12)]);
  assert.equal(reasonOf(split.decision), "split-package");
  assert.notEqual(split.gate, "accepted");
  const other = crackdown(["Other.exe"]);
  assert.equal(reasonOf(other.decision), "program-name-unaccounted");
  assert.notEqual(other.gate, "accepted");
  const debug = crackdown(["Crackdown-debug.exe"]);
  assert.ok(!debug.decision.fit);
  assert.notEqual(debug.gate, "accepted");
  const nonAscii = reliefDecision(
    "n",
    "Crackdown (Crackdown Recompiled)",
    "crackdown-xbox360-recompiled",
    "Сrackdown-v0.6.2-windows-x64.zip",
    ["Crackdown.exe"],
  );
  assert.equal(reasonOf(nonAscii.decision), "non-ascii-name");
  assert.notEqual(nonAscii.gate, "accepted");
});

void test("a relieved name that spells another catalog listing's complete name is a contradiction, in fit and gate", () => {
  const starWars = listing("zz-star-wars", {
    name: "Star Wars",
    original_game_title: "Star Wars",
    project_url: "https://github.com/fixture-owner/star-wars-port",
  });
  const battlefront = (others: AuthoredPort[]) =>
    reliefDecision(
      "battlefront",
      "Star Wars: Battlefront",
      "battlefront-recomp",
      "StarWars-1.0-win64.zip",
      ["StarWars.exe"],
      { others },
    );
  // Alone, `StarWars` is a partial name of "Star Wars: Battlefront": its
  // whole first title segment.
  const alone = battlefront([]);
  assert.ok(alone.decision.fit, JSON.stringify(alone.decision));
  assert.deepEqual(alone.decision.reliefs, ["partial-name"]);
  assert.equal(alone.gate, "accepted");
  // Beside a listing named "Star Wars" it names that listing instead.
  const beside = battlefront([starWars]);
  assert.equal(reasonOf(beside.decision), "archive-names-another-listing");
  assert.deepEqual((beside.decision as { evidence?: string[] }).evidence, [
    "windows-x86-64: StarWars-1.0-win64.zip (zz-star-wars)",
  ]);
  assert.match(beside.gate, /spells another catalog listing/u);
  assert.equal(
    gateArchiveAccount(
      "StarWars-1.0-win64.zip",
      reliefRecord("battlefront", "Star Wars: Battlefront", "battlefront-recomp").listing,
      "fixture-owner/battlefront-recomp",
      [starWars.listing as Record<string, unknown>],
    ),
    null,
  );
  // Through the other listing's repository name, with descriptors, too.
  const portNamed = listing("zz-other", {
    name: "Classic Space",
    original_game_title: "Classic Space",
    project_url: "https://github.com/fixture-owner/StarWars-Recomp",
  });
  const viaRepository = battlefront([portNamed]);
  assert.equal(reasonOf(viaRepository.decision), "archive-names-another-listing");
  assert.notEqual(viaRepository.gate, "accepted");
  // An initialism equal to another listing's whole name is one too.
  const gow = listing("zz-gow", {
    name: "GOW",
    original_game_title: "GOW",
    project_url: "https://github.com/fixture-owner/gow-engine",
  });
  assert.ok(
    "anotherListing" in
      archiveNameAccount(
        "gow-1.0-win64.zip",
        reliefRecord("gears", "Gears of War", "war-port").listing,
        "fixture-owner/war-port",
        [gow.listing],
      ),
  );
  // An exact spelling of the listing's own name is no relief and is not compared.
  const exact = reliefDecision(
    "exact",
    "Star Wars Battlefront",
    "battlefront-recomp",
    "StarWars-Battlefront-1.0-win64.zip",
    ["StarWarsBattlefront.exe"],
    { others: [starWars] },
  );
  assert.ok(exact.decision.fit);
  assert.deepEqual(exact.decision.reliefs, []);
  assert.equal(exact.gate, "accepted");
  // F1: another listing's FIRST title segment, in another repository, is
  // named too (real names carry `— X (author)` suffixes); in the same
  // repository it is not compared.
  const titled = listing("zz-star-wars-titled", {
    name: "Star Wars — Remade Edition (someone)",
    original_game_title: "Star Wars",
    project_url: "https://github.com/fixture-owner/sw-remade",
  });
  const firstSegment = battlefront([titled]);
  assert.equal(reasonOf(firstSegment.decision), "archive-names-another-listing");
  assert.notEqual(firstSegment.gate, "accepted");
  const sameRepository = listing("zz-star-wars-same", {
    name: "Star Wars — Remade Edition (someone)",
    original_game_title: "Star Wars",
    project_url: "https://github.com/fixture-owner/battlefront-recomp",
  });
  const own = reliefRecord("battlefront", "Star Wars: Battlefront", "battlefront-recomp").listing;
  assert.ok(
    "product" in
      archiveNameAccount("StarWars-1.0-win64.zip", own, "fixture-owner/battlefront-recomp", [
        sameRepository.listing,
      ]),
  );
  assert.equal(
    gateArchiveAccount("StarWars-1.0-win64.zip", own, "fixture-owner/battlefront-recomp", [
      sameRepository.listing as Record<string, unknown>,
    ]),
    "starwars",
  );
  // F5: a long integer read as a version that, with the product, names
  // another listing withholds; alone it stays an accounted year-as-version.
  const wipeout = reliefRecord("wipeout", "Wipeout", "wipeout").listing;
  const wipeout2048 = listing("zz-wipeout-2048", {
    name: "Wipeout 2048",
    original_game_title: "Wipeout 2048",
    project_url: "https://github.com/fixture-owner/wipeout-2048-port",
  }).listing;
  assert.ok(
    "product" in archiveNameAccount("Wipeout-2048-win64.zip", wipeout, "fixture-owner/wipeout"),
  );
  assert.ok(
    "anotherListing" in
      archiveNameAccount("Wipeout-2048-win64.zip", wipeout, "fixture-owner/wipeout", [wipeout2048]),
  );
  assert.equal(
    gateArchiveAccount("Wipeout-2048-win64.zip", wipeout, "fixture-owner/wipeout", [
      wipeout2048 as Record<string, unknown>,
    ]),
    null,
  );
});

void test("a partial name that is a prefix of two or more listings' names is queued as franchise_only_partial", () => {
  const crackdown = reliefRecord("crackdown", "Crackdown: Recompiled", "crackdown-recomp");
  const sequel = listing("zz-crackdown-2", {
    name: "Crackdown 2: Recompiled",
    original_game_title: "Crackdown 2",
    project_url: "https://github.com/fixture-owner/crackdown-2-recomp",
  });
  const facts = entry(
    [named("Crackdown-v0.6.2-windows-x64.zip", [player("Crackdown.exe")], 11, "windows")],
    {},
    crackdown.listing.id,
    {
      repository: "fixture-owner/crackdown-recomp",
      listing_words: listingWords(crackdown.listing),
    },
  );
  const decision = fitDecision(crackdown, facts, generatedAt, fitContext([crackdown, sequel]));
  assert.ok(decision.fit, JSON.stringify(decision));
  assert.ok(decision.franchise_only_partial.length);
  const alone = fitDecision(crackdown, facts, generatedAt, fitContext([crackdown]));
  // "Recompiled" is a descriptor segment, no subtitle: alone it is not queued.
  assert.ok(alone.fit && alone.franchise_only_partial.length === 0, JSON.stringify(alone));
  const generation = generateRegistrations([crackdown, sequel], table(facts));
  assert.deepEqual(registrationQueues(generation).franchise_only_partial, {
    [crackdown.listing.id]: [
      "windows-x86-64: Crackdown-v0.6.2-windows-x64.zip shares its words with two or more listings",
    ],
  });
  assert.equal(gateGeneration(null, generation).added.length, 1);
});

void test("relieved enrollments are listed by relief for a person to hand-check first", () => {
  const rows: [string, string, string, string, string][] = [
    [
      "a",
      "Crackdown (Crackdown Recompiled)",
      "crackdown-xbox360-recompiled",
      "Crackdown-v0.6.2-windows-x64.zip",
      "Crackdown.exe",
    ],
    ["b", "Import Tuner Challenge", "ITC-Recomp", "itc-v0.5.0-win-amd64.zip", "itc.exe"],
    ["c", "Lantern", "lantern", "Lantern-e1625759-windows-x64.zip", "Lantern.exe"],
    [
      "d",
      "Amped 2 (Xbox)",
      "Amped2-Recomp",
      "Amped2-Recomp-v0.2.0-windows-x86_64.zip",
      "Amped2-Recomp-v0.2.0-windows-x86_64/Amped2Recomp.exe",
    ],
    ["e", "F-Zero X", "f-zero-x-recomp", "FZeroXRecompiled-v0.1.16-windows-x64.zip", "FZeroX.exe"],
    ["f", "Lantern Two", "lantern-two", "Lantern-Two-1.0-win64.zip", "LanternTwo.exe"],
    ["g", "Dead or Alive 3", "alive-port", "doa3-1.0-win64.zip", "DOA3.exe"],
  ];
  const records: AuthoredPort[] = [];
  const entries: ListingFactsEntry[] = [];
  for (const [key, name, repository, archive, program] of rows) {
    const record = reliefRecord(key, name, repository);
    records.push(record);
    entries.push(
      entry([named(archive, [player(program)], 11, "windows")], {}, record.listing.id, {
        repository: `fixture-owner/${repository}`,
        listing_words: listingWords(record.listing),
      }),
    );
  }
  const generation = generateRegistrations(records, table(...entries));
  assert.equal(generation.enrollments.length, rows.length);
  gateGeneration(null, generation);
  const queues = registrationQueues(generation);
  assert.deepEqual(queues.enrollment_reliefs, {
    "zz-relief-a": ["partial-name"],
    // Generator 26: the repository's name minus its descriptor.
    "zz-relief-b": ["partial-name"],
    "zz-relief-c": ["build-id"],
    "zz-relief-d": ["folder"],
    "zz-relief-e": ["descriptor"],
    "zz-relief-f": [],
    "zz-relief-g": ["initialism"],
  });
  assert.deepEqual(queues.relieved_enrollments, {
    "partial-name": ["zz-relief-a", "zz-relief-b"],
    initialism: ["zz-relief-g"],
    descriptor: ["zz-relief-e"],
    "build-id": ["zz-relief-c"],
    folder: ["zz-relief-d"],
  });
  // The existing queues stay.
  assert.ok(Array.isArray(queues.accepted_by_repository_name_only));
  assert.ok(Array.isArray(queues.numbered_products));
  assert.ok(Array.isArray(queues.integer_as_version));
});

void test("the gate restates the relief vocabularies and the tokeniser's build identifiers", () => {
  assert.deepEqual([...gateInitialismVeto], [...initialismVetoWords]);
  // Every descriptor and region word is listed with its measured example in docs.
  const docs = readFileSync(join(root, "docs/CATALOG.md"), "utf8");
  for (const word of [...portDescriptorWords, ...regionDescriptorWords])
    assert.match(docs, new RegExp(`\`${word}\``, "u"), `docs list ${word}`);
  for (const word of [
    "beta",
    "alpha",
    "rc",
    "preview",
    "nightly",
    "dev",
    "test",
    "demo",
    "trial",
    "lite",
    "deck",
    "mods",
    "extended",
    "fixed",
    "hd",
    "remaster",
    "remastered",
    "classic",
  ])
    assert.ok(
      !(portDescriptorWords as readonly string[]).includes(word) &&
        initialismVetoWords.includes(word),
      `${word} is no descriptor and never an initialism`,
    );
  assert.deepEqual(
    archiveNameTokens("SymphonyRecomp-v1.2.0p-win64.zip").tokens.map((t) => t.kind),
    ["word", "word", "build", "neutral"],
  );
  assert.deepEqual(
    archiveNameTokens("Game-e1625759-x64.zip").tokens.map((t) => t.kind),
    ["word", "build", "neutral"],
  );
  assert.deepEqual(
    archiveNameTokens("Game-1.2.0b2-x64.zip").tokens.map((t) => t.word),
    ["game", "v0", "b", "2", "x64"],
  );
  assert.ok(hashToken("e1625759") && !hashToken("abc12") && !hashToken("deadbeef"));
  assert.deepEqual(
    [...digitRuns("ogrebattle64x2")],
    [
      [10, 2],
      [13, 1],
    ],
  );
  assert.deepEqual(reliefSpelling("doom", digitRuns("doom"), nameForm("Doom 2")), null);
  assert.deepEqual(reliefSpelling("skate2pc", digitRuns("skate2pc"), nameForm("Skate 2")), [
    "descriptor",
  ]);
});

void test("random archive names: any token outside product subsequence, initialism, descriptor, version, build id or neutral withholds, and fit and gate agree (relief property)", () => {
  let seed = 8_569_023;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const letters = "bcfghjklmnqvwxz";
  // Real words that hold descriptor letters, channel and variant words.
  const tricky = [
    "portal",
    "sports",
    "pcs",
    "natives",
    "recomps",
    "beta",
    "deck",
    "mods",
    "server",
    "editor",
    "lite",
    "demo",
    "unity",
    "palace",
  ];
  const extraToken = () => {
    if (random() < 0.3) return pick(tricky);
    for (;;) {
      const word = Array.from({ length: 3 + Math.floor(random() * 4) }, () =>
        pick(letters.split("")),
      ).join("");
      if (
        !initialismVetoWords.includes(word) &&
        !(neutralArchiveWords as readonly string[]).includes(word)
      )
        return word;
    }
  };
  const titles: [string, string][] = [
    ["Crackdown (Crackdown Recompiled)", "crackdown-xbox360-recompiled"],
    ["MechAssault 2: Lone Wolf", "mechassault-2-recomp"],
    ["Gears of War 2", "gears-of-war-2-pc-port"],
    ["Star Wars: Shadows of the Empire", "sote-port"],
    ["Digimon World 2", "world-port"],
  ];
  const others = [
    listing("zz-star-wars", {
      name: "Star Wars",
      original_game_title: "Star Wars",
      project_url: "https://github.com/fixture-owner/star-wars-port",
    }),
  ].map((other) => other.listing as Record<string, unknown>);
  const products: Record<string, string[][]> = {
    "Crackdown (Crackdown Recompiled)": [
      ["Crackdown"],
      ["Crackdown", "Recompiled"],
      ["Crackdown", "PC"],
    ],
    "MechAssault 2: Lone Wolf": [
      ["MechAssault2"],
      ["MechAssault", "2", "PC"],
      ["Lone", "Wolf"],
      ["MechAssault"],
    ],
    "Gears of War 2": [
      ["gow2"],
      ["gow2", "recomp"],
      ["Gears", "of", "War", "2"],
      ["gow"],
      ["War", "2"],
      // A descriptor before an initialism.
      ["recomp", "gow2"],
      ["Native", "gow2", "usa"],
    ],
    "Star Wars: Shadows of the Empire": [
      ["Shadows"],
      ["StarWars"],
      ["Shadows", "of", "the", "Empire"],
      ["sote"],
      ["The", "Empire"],
    ],
    "Digimon World 2": [["dw2"], ["Digimon", "World", "2"], ["Digimon"], ["dw"], ["port", "dw2"]],
  };
  const tails = [
    "v1.0",
    "1.2.3",
    "win64",
    "x64",
    "linux",
    "x86_64",
    "macos",
    "native",
    "usa",
    "e1625759",
    "2024",
    "portable",
  ];
  const separators = ["-", "_", ".", " "];
  let withheld = 0;
  let accounted = 0;
  for (let round = 0; round < 2500; round++) {
    const [title, repository] = pick(titles);
    const parts = [...pick(products[title]!)];
    const tailCount = Math.floor(random() * 3);
    for (let index = 0; index < tailCount; index++) parts.push(pick(tails));
    const extra = random() < 0.5 ? extraToken() : null;
    if (extra !== null) parts.splice(Math.floor(random() * (parts.length + 1)), 0, extra);
    const name = `${parts.join(pick(separators))}.${pick(["zip", "tar.gz"])}`;
    const record = reliefRecord("p", title, repository);
    const fit = archiveNameAccount(name, record.listing, `fixture-owner/${repository}`, others);
    const gate = gateArchiveAccount(name, record.listing, `fixture-owner/${repository}`, others);
    assert.equal("product" in fit ? fit.product : null, gate, `parity ${name}`);
    if (extra !== null) {
      assert.ok(!("product" in fit), `extra ${extra} withholds ${name}`);
      withheld++;
    } else if ("product" in fit) accounted++;
  }
  assert.ok(withheld > 1000, `withheld ${withheld}`);
  assert.ok(accounted > 500, `accounted ${accounted}`);
  // Programs: random relieved literals, with and without an extra token.
  for (let round = 0; round < 2500; round++) {
    const [title, repository] = pick(titles);
    const record = reliefRecord("q", title, repository);
    const forms = reliefForms(record.listing, `fixture-owner/${repository}`, "");
    const core = pick(products[title]!).join("");
    const extra = random() < 0.5 ? extraToken() : null;
    const file = `${extra !== null && random() < 0.5 ? extra : ""}${core}${extra !== null && random() < 0.5 ? extra : ""}${pick(["", "-x64", "recompiled", "PC"])}${pick([".exe", ""])}`;
    const folder = random() < 0.3 ? `${pick(["bin", `${core}-v1.0-win64`, extra ?? "x64"])}/` : "";
    const path = folder + file;
    const strict = random() < 0.2;
    const names = new Set([repository.replace(/[^a-z0-9]/gu, "")]);
    const fit = programNameUnaccounted(path, names, new Set(), strict, forms);
    assert.equal(
      gateProgramAccounted(path, [...names], [], strict, forms),
      fit === null,
      `parity ${path}`,
    );
    if (extra !== null && path.includes(extra))
      assert.notEqual(fit, null, `extra ${extra} withholds ${path}`);
  }
});

void test("forced enrollments over random relieved names: the gate never accepts what the fit withholds (relief parity)", () => {
  let seed = 8_569_230;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const archives = [
    "Crackdown-v0.6.2-windows-x64.zip",
    "Crackdown-Recompiled-1.0-win64.zip",
    "Crackdown-Beta-1.0-win64.zip",
    "Crackdown2-1.0-win64.zip",
    "cdr-1.0-win64.zip",
    "Crackdown-PC-Demo-win64.zip",
    "Crackdown-e1625759-win64.zip",
    "Crackdown-1.0b2-win64.zip",
    "Crackdown-1.0p-win64.zip",
    "Xbox-1.0-win64.zip",
    "Recompiled-1.0-win64.zip",
    "Crackdown-native-usa-win64.zip",
    "Crackdown-uni-win64.zip",
  ];
  const programs = [
    "Crackdown.exe",
    "CrackdownRecompiled.exe",
    "crackdown-x64.exe",
    "CrackdownServer.exe",
    "Other.exe",
    "Crackdown-v0.6.2-windows-x64/Crackdown.exe",
    "Crackdown2-v0.6.2/Crackdown.exe",
    "tools/Crackdown.exe",
    "Crackdown-debug.exe",
    "cd.exe",
  ];
  const starWars = listing("zz-crackdown-other", {
    name: "Crackdown",
    original_game_title: "Crackdown",
    project_url: "https://github.com/fixture-owner/crackdown-other",
  });
  let refused = 0;
  let enrolled = 0;
  for (let round = 0; round < 200; round++) {
    const others = random() < 0.3 ? [starWars] : [];
    const { decision, gate } = reliefDecision(
      "r",
      "Crackdown (Crackdown Recompiled)",
      "crackdown-xbox360-recompiled",
      pick(archives),
      [pick(programs)],
      { others },
    );
    if (decision.fit) {
      assert.equal(gate, "accepted", JSON.stringify(decision));
      enrolled++;
    } else {
      assert.notEqual(gate, "accepted", `${decision.reason}: ${decision.detail}`);
      refused++;
    }
  }
  assert.ok(refused > 50 && enrolled > 10, `${refused} refused, ${enrolled} enrolled`);
});

void test("second review: a partial name keeps its segment's tail, initialisms keep later numbers, title descriptors stay, in fit and gate", () => {
  // B2 + B4: names that spell a different game withhold.
  const withheld: [string, string, string][] = [
    ["Mega Man X4", "mmx4-port", "MegaManX-1.0-win64.zip"],
    ["Mega Man Legends 2", "mml2-port", "MegaMan2-1.0-win64.zip"],
    ["Mega Man X", "mmx-port", "Mega-X-1.0-win64.zip"],
    ["Star Wars Episode II", "swe2-port", "StarWars-1.0-win64.zip"],
    ["Shenmue Chapter 2", "sc2-port", "Shenmue-1.0-win64.zip"],
    ["Kingdom Hearts HD 1.5 Remix Volume 2", "kh-port", "KingdomHearts-1.0-win64.zip"],
    ["Perfect Dark Zero", "pdz-port", "PerfectDark-1.0-win64.zip"],
    ["Batman Returns", "br-port", "Batman-1.0-win64.zip"],
    ["Street Fighter Alpha", "sfa-port", "StreetFighter-1.0-win64.zip"],
    ["Half-Life Blue Shift", "hlbs-port", "HalfLife-1.0-win64.zip"],
    ["Star Wars Battlefront", "swbf-port", "StarWars-1.0-win64.zip"],
    ["Star Wars Battlefront", "swbf-port", "Star-1.0-win64.zip"],
    ["World of Goo", "wog-port", "World-1.0-win64.zip"],
    ["Need for Speed", "nfs-port", "Need-1.0-win64.zip"],
    ["Open Racer", "or-port", "Open-1.0-win64.zip"],
    ["Super Contra", "contra-port", "Super-1.0-win64.zip"],
    ["Sonic and the Black Knight", "satbk-port", "Sonic-1.0-win64.zip"],
    // B1 and F2: an initialism never omits a later number or a final word.
    ["Need for Speed Underground 2", "nfsu2-port", "nfs-1.0-win64.zip"],
    ["Monster Hunter Generations Ultimate", "mhgu-port", "mhg-1.0-win64.zip"],
    ["Digital Sound Voyage", "dsv-port", "ds-1.0-win64.zip"],
    ["Super Village", "village-port", "sv-1.0-win64.zip"],
    ["Card Legends", "legends-port", "cl-1.0-win64.zip"],
    ["Emerald Dungeon", "dungeon-port", "ed-1.0-win64.zip"],
    ["Mystic Empire", "empire-port", "me-1.0-win64.zip"],
    ["Dark Lantern Castle", "castle-port", "dlc-1.0-win64.zip"],
    ["Orbit Star Trail", "trail-port", "ost-1.0-win64.zip"],
    ["Iron Island Isles", "isles-port", "iii-1.0-win64.zip"],
    // B5: a descriptor that is a title word is never dropped.
    ["Static Shock", "ss-port", "Shock-1.0-win64.zip"],
    ["Native Hunter", "nh-port", "Hunter-1.0-win64.zip"],
    ["Pal Game Party", "pgp-port", "Game-Party-1.0-win64.zip"],
    // F3: only `p` is a patch letter; glued channel markers withhold.
    ["Lantern", "lantern", "Lantern-1.0d-win64.zip"],
    ["Lantern", "lantern", "Lantern-1.2.0x-win64.zip"],
    ["Lantern", "lantern", "Lantern-1.0s-win64.zip"],
    ["Lantern", "lantern", "Lantern-1.0t-win64.zip"],
    ["Lantern", "lantern", "Lantern-1.0e-win64.zip"],
    ["Lantern", "lantern", "Lantern-1.0x-win64.zip"],
    ["Lantern", "lantern", "Lantern-1.0b2-win64.zip"],
    ["Lantern", "lantern", "Lantern-1.0rc1-win64.zip"],
    ["Lantern", "lantern", "Lantern-1.0a1-win64.zip"],
    // B1 across names: an initialism or partial name of a repository name
    // that lacks the title's sequel number, or omits its final words, never
    // stands for a numbered entry of the series (also an exact spelling of
    // such a repository name).
    ...["Gears of War 2", "Gears of War 3", "Gears of War 4"].flatMap(
      (title): [string, string, string][] => [
        [title, "gears-of-war-port", "gow-1.0-win64.zip"],
        [title, "gow-recomp", "gow-1.0-win64.zip"],
        [title, "gow-recomp", "GOW-Recomp-1.0-win64.zip"],
        [title, "gears-of-war-port", "Native-gow-1.0-win64.zip"],
      ],
    ),
    ["Need for Speed Underground 2", "nfs-recomp", "nfs-1.0-win64.zip"],
    ["Need for Speed Underground", "nfs-recomp", "nfs-1.0-win64.zip"],
    ["Tony Hawk's Pro Skater 2", "thps-port", "thps-1.0-win64.zip"],
    ["Monster Hunter Generations Ultimate", "mh-port", "mh-1.0-win64.zip"],
    ["SSX 3", "ssx-recomp", "SSX-Recomp-1.0-win64.zip"],
  ];
  for (const [name, repository, archive] of withheld) {
    const fit = reliefAccount(name, repository, archive);
    assert.ok(!("product" in fit), `${archive} for ${name}: ${JSON.stringify(fit)}`);
  }
  // The measured shapes that rest on these rules still enroll.
  const enrolled: [string, string, string][] = [
    [
      "Crackdown (Crackdown Recompiled)",
      "crackdown-xbox360-recompiled",
      "Crackdown-v0.6.2-windows-x64.zip",
    ],
    [
      "CyberMage: Darklight Re-Awakening",
      "cybermage-darklight-re-awakening",
      "cybermage-windows-x64.zip",
    ],
    ["MechAssault 2: Lone Wolf", "mechassault-2-recomp", "MechAssault2-PC-v0.1.0-win-x64.zip"],
    [
      "Crusader: No Remorse / SDL port",
      "crusader-no-remorse-decomp",
      "crusader-no-remorse-1.69.0-windows-x64.zip",
    ],
    ["SEAL Team / SealTeam Source Port", "SealTeam-Source-Port", "SealTeam-0.6.1-windows-x64.zip"],
    ["Static Shock", "ss-port", "StaticShock-1.0-win64.zip"],
    ["Lantern", "lantern", "Lantern-1.2.0p-win64.zip"],
    ["Wayne Gretzky's 3D Hockey", "hockey-port", "wg3d-1.0-win64.zip"],
    ["Digimon World 2", "world-port", "dw2-1.0-win64.zip"],
    ["Dead or Alive 3", "alive-port", "doa3-1.0-win64.zip"],
    ["Monster Hunter Generations Ultimate", "ultimate-port", "mhgu-1.0-win64.zip"],
    // B1: the whole series name keeps its repository initialism, and a
    // numbered entry its own.
    ["Gears of War", "gears-of-war-port", "gow-1.0-win64.zip"],
    ["Gears of War", "gow-recomp", "GOW-Recomp-1.0-win64.zip"],
    ["Gears of War 2", "gears-of-war-port", "gow2-1.0-win64.zip"],
    ["Tony Hawk's Pro Skater", "thps-port", "thps-1.0-win64.zip"],
    ["Earthworm Jim", "ewj-port", "ewj-1.0-win64.zip"],
    ["Sega Superstars Tennis", "tennis-port", "sst-1.0-win64.zip"],
    ["RalliSport Challenge", "challenge-port", "rsc-1.0-win64.zip"],
    ["God Hand Rearmed", "rearmed-port", "ghr-1.0-win64.zip"],
    ["Import Tuner Challenge", "ITC-Recomp", "itc-v0.5.0-win-amd64.zip"],
  ];
  for (const [name, repository, archive] of enrolled)
    assert.ok("product" in reliefAccount(name, repository, archive), `${archive} for ${name}`);
  // B5: `shock.exe` in a `StaticShock` archive withholds, in fit and gate.
  const shock = reliefDecision(
    "b5",
    "Static Shock",
    "static-shock-port",
    "StaticShock-1.0-win64.zip",
    ["shock.exe"],
  );
  assert.equal(reasonOf(shock.decision), "program-name-unaccounted");
  assert.notEqual(shock.gate, "accepted");
  // B3: the fit and the gate agree on descriptors before an initialism.
  // (Generator 26: three letters, since two-letter initialisms need a number.)
  for (const [name, repository, archive] of [
    ["Super Contra Force", "contra-port", "recomp-scf-1.0-win64.zip"],
    ["Super Contra Force", "contra-port", "usa-scf-1.0-win64.zip"],
    ["Gears of War 2", "gears-port", "Native_Gow2.zip"],
  ] as const)
    assert.ok("product" in reliefAccount(name, repository, archive), archive);
  const kigForms = reliefForms(
    reliefRecord("kig", "Killer Instinct Gold", "kig-port").listing,
    "fixture-owner/kig-port",
    "kigport",
  );
  assert.equal(
    programNameUnaccounted(
      "port-kig-win64/kig.exe",
      new Set(["kigport"]),
      new Set(),
      false,
      kigForms,
    ),
    null,
  );
  assert.ok(gateProgramAccounted("port-kig-win64/kig.exe", ["kigport"], [], false, kigForms));
  // B1 across names for programs and folders: `gow` through a repository
  // name without the `2` withholds; `gow2` stays accounted.
  const gowForms = reliefForms(
    reliefRecord("gow", "Gears of War 2", "gears-of-war-port").listing,
    "fixture-owner/gears-of-war-port",
    "",
  );
  const gowNames = new Set(["gearsofwarport"]);
  for (const path of [
    "gow.exe",
    "gowrecomp.exe",
    "gow-win64/gow2.exe",
    "native-gow-v1.0/gow2.exe",
  ]) {
    assert.notEqual(programNameUnaccounted(path, gowNames, new Set(), false, gowForms), null, path);
    assert.equal(gateProgramAccounted(path, [...gowNames], [], false, gowForms), false, path);
  }
  for (const path of ["gow2.exe", "gow2-win64/gow2.exe"]) {
    assert.equal(programNameUnaccounted(path, gowNames, new Set(), false, gowForms), null, path);
    assert.ok(gateProgramAccounted(path, [...gowNames], [], false, gowForms), path);
  }
});

void test("random titles: no dropped segment tail, dropped or re-attached number, or initialism omitting a later number enrolls; fit and gate agree (second-review property)", () => {
  let seed = 8_569_024;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const vocabulary = [
    "mega",
    "man",
    "dark",
    "zero",
    "storm",
    "hunter",
    "legend",
    "castle",
    "river",
    "night",
    "blade",
    "orbit",
  ];
  const separators = [" ", ": ", " - ", " / "];
  let withheld = 0;
  let parity = 0;
  for (let round = 0; round < 1500; round++) {
    // A title of one or two segments, with an optional number.
    const segments: string[][] = [];
    for (let index = 0; index < 1 + Math.floor(random() * 2); index++) {
      const words = Array.from({ length: 2 + Math.floor(random() * 2) }, () => pick(vocabulary));
      if (random() < 0.5) words.push(String(2 + Math.floor(random() * 7)));
      segments.push([...new Set(words)]);
    }
    const title = segments.map((words) => words.join(" ")).join(pick(separators.slice(1)));
    const first = segments[0]!;
    // Mutations that must withhold: drop the first segment's tail word, or
    // its number, or re-attach its number to a word that is not its own.
    const kind = pick(["tail", "number", "reattach", "initialism"] as const);
    let product: string[] | null = null;
    const numberAt = first.findIndex((word) => /^[0-9]+$/u.test(word));
    if (kind === "tail" && first.length >= 3 && numberAt < 0) product = first.slice(0, -1);
    if (kind === "number" && numberAt > 0) product = first.filter((_, at) => at !== numberAt);
    if (kind === "reattach" && numberAt > 1) product = [first[0]!, first[numberAt]!];
    if (kind === "initialism" && numberAt > 1)
      product = [
        first
          .slice(0, numberAt)
          .map((word) => word[0])
          .join(""),
      ];
    if (product === null) continue;
    const archive = `${product.map((word) => word[0]!.toUpperCase() + word.slice(1)).join("-")}-v1.0-win64.zip`;
    const record = reliefRecord("t", title, "zz-title-port");
    const fit = archiveNameAccount(archive, record.listing, "fixture-owner/zz-title-port");
    const gate = gateArchiveAccount(archive, record.listing, "fixture-owner/zz-title-port");
    assert.equal("product" in fit ? fit.product : null, gate, `parity ${archive} for ${title}`);
    parity++;
    // A shorter product that spells a different whole word sequence of the
    // title by chance (a repeated vocabulary word) is skipped.
    const titleWords = title
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter(Boolean);
    const literal = product.join("").toLowerCase();
    const coincident = segments.some((words) => {
      for (let start = 0; start < words.length; start++)
        if (words.slice(start).join("") === literal) return true;
      return false;
    });
    if (coincident || titleWords.join("") === literal) continue;
    assert.ok(!("product" in fit), `${kind}: ${archive} must withhold for ${title}`);
    withheld++;
  }
  assert.ok(parity > 300 && withheld > 200, `${parity} parity, ${withheld} withheld`);
  // Across names: a numbered title whose repository name lacks the number
  // never enrolls the repository's initialism or its exact spelling.
  let series = 0;
  for (let round = 0; round < 600; round++) {
    const words = [
      ...new Set(Array.from({ length: 2 + Math.floor(random() * 3) }, () => pick(vocabulary))),
    ];
    if (words.length < 2) continue;
    const number = String(2 + Math.floor(random() * 7));
    const title = `${words.join(" ")} ${number}`;
    const repository = `${words.join("-")}${pick(["", "-port", "-recomp"])}`;
    const initials = words.map((word) => word[0]).join("");
    const descriptor = pick(["", "recomp-", "native-"]);
    const archive = pick([
      `${descriptor}${initials}-v1.0-win64.zip`,
      `${repository}-v1.0-win64.zip`,
      `${initials}-${pick(["port", "recomp"])}-1.0-win64.zip`,
    ]);
    const record = reliefRecord("s", title, repository);
    const fit = archiveNameAccount(archive, record.listing, `fixture-owner/${repository}`);
    const gate = gateArchiveAccount(archive, record.listing, `fixture-owner/${repository}`);
    assert.equal("product" in fit ? fit.product : null, gate, `parity ${archive} for ${title}`);
    assert.ok(!("product" in fit), `${archive} must withhold for ${title} [${repository}]`);
    // Keeping the number enrolls the initialism again, in fit and gate.
    const kept = `${initials}${number}-v1.0-win64.zip`;
    const keptFit = archiveNameAccount(kept, record.listing, `fixture-owner/${repository}`);
    const keptGate = gateArchiveAccount(kept, record.listing, `fixture-owner/${repository}`);
    assert.equal("product" in keptFit ? keptFit.product : null, keptGate, `parity ${kept}`);
    series++;
  }
  assert.ok(series > 400, `${series} series titles`);
});

// ---------------------------------------------------------------------------
// Generator 26: one name must name one catalog game (U), and the reliefs
// follow the partial-name rule (N1 to N4).

void test("generator 26: initialisms follow the partial-name rule, sequel segments stay, only articles or a possessive run lead, an annotation alone names nothing, in fit and gate (N1-N4)", () => {
  const withheld: [string, string, string, string][] = [
    // N1: an initialism only where the partial name of the same words, with
    // the same omitted later segments, is accepted; two letters only with a number.
    ["N1", "Need for Speed: Underground 2", "zzrepo", "nfs-1.0-win64.zip"],
    ["N1", "Dragon Ball Z: Budokai 3", "zzrepo", "dbz-1.0-win64.zip"],
    ["N1", "Star Wars: Episode II", "zzrepo", "sw-1.0-win64.zip"],
    ["N1", "Mega Man: X4", "zzrepo", "mm-1.0-win64.zip"],
    ["N1", "Kingdom Hearts: Volume 2", "zzrepo", "kh-1.0-win64.zip"],
    ["N1", "Gears of War: 2", "zzrepo", "gow-1.0-win64.zip"],
    ["N1", "Dynasty Warriors: Gundam 2", "zzrepo", "dw-1.0-win64.zip"],
    ["N1", "Gears of War — Gears of War 2 port", "zzrepo", "gow-1.0-win64.zip"],
    ["N1", "Midtown Madness", "madness-port", "mm-v1.0-windows-x64.zip"],
    ["N1", "Killer Instinct", "instinct-port", "ki-1.0-win64.zip"],
    ["N1", "Super Contra", "contra-port", "sc-1.0-win64.zip"],
    // N2: no omitted segment holds a sequel number or a glued sequel chunk.
    ["N2", "Halo: 2", "zzrepo", "Halo-1.0-win64.zip"],
    ["N2", "Halo — 2", "zzrepo", "Halo-1.0-win64.zip"],
    ["N2", "Halo, 2", "zzrepo", "Halo-1.0-win64.zip"],
    ["N2", "Doom (2)", "zzrepo", "Doom-1.0-win64.zip"],
    ["N2", "Doom: 3", "zzrepo", "Doom-1.0-win64.zip"],
    ["N2", "Star Wars: Episode II", "zzrepo", "StarWars-1.0-win64.zip"],
    ["N2", "Shenmue: Chapter 2", "zzrepo", "Shenmue-1.0-win64.zip"],
    ["N2", "Kingdom Hearts: Volume 2", "zzrepo", "KingdomHearts-1.0-win64.zip"],
    ["N2", "Mega Man: X4", "zzrepo", "MegaMan-1.0-win64.zip"],
    ["N2", "Mega Man (X4)", "zzrepo", "MegaMan-1.0-win64.zip"],
    ["N2", "Final Fantasy VII / VIII", "zzrepo", "FinalFantasyVII-1.0-win64.zip"],
    // N3: an annotation alone (an author handle, a project or tool name).
    [
      "N3",
      "Gears of War 3 — squarehole360 Gears3 (GloriousEggroll)",
      "zzrepo",
      "GloriousEggroll-1.0-win64.zip",
    ],
    ["N3", "TimeSplitters 2 — split2-recomp (phobos665)", "zzrepo", "phobos665-1.0-win64.zip"],
    ["N3", "Lantern — Lantern Engine (someone)", "zzrepo", "Someone-1.0-win64.zip"],
    [
      "N3",
      "Import Tuner Challenge — ITC-Recomp (Spooky098529)",
      "zzrepo",
      "Spooky098529-1.0-win64.zip",
    ],
    // N4: leading words go only as articles or a run ending in a possessive;
    // `&`, `+` and `,` link like `and`.
    ["N4", "Super Contra", "zzrepo", "Contra-1.0-win64.zip"],
    ["N4", "Super Metroid", "zzrepo", "Metroid-1.0-win64.zip"],
    ["N4", "Ms. Pac-Man", "zzrepo", "PacMan-1.0-win64.zip"],
    ["N4", "Super Mario Bros.", "zzrepo", "MarioBros-1.0-win64.zip"],
    ["N4", "Ultimate Mortal Kombat 3", "zzrepo", "MortalKombat3-1.0-win64.zip"],
    ["N4", "Return to Castle Wolfenstein", "zzrepo", "CastleWolfenstein-1.0-win64.zip"],
    ["N4", "Grand Theft Auto: Vice City", "zzrepo", "Auto-1.0-win64.zip"],
    ["N4", "Paper Mario", "zzrepo", "Mario-1.0-win64.zip"],
    ["N4", "Sonic & Knuckles", "zzrepo", "Sonic-1.0-win64.zip"],
    ["N4", "Sonic + Knuckles", "zzrepo", "Sonic-1.0-win64.zip"],
    ["N4", "Hot Shots Tennis", "zzrepo", "Tennis-1.0-win64.zip"],
    ["N4", "The Legend of Zelda", "zzrepo", "Zelda-1.0-win64.zip"],
  ];
  for (const [rule, name, repository, archive] of withheld) {
    const fit = reliefAccount(name, repository, archive);
    assert.ok("unaccounted" in fit, `${rule}: ${archive} for ${name}: ${JSON.stringify(fit)}`);
  }
  const enrolled: [string, string, string, string[]][] = [
    // Articles and a possessive run may lead; a colon subtitle is a title segment.
    ["The Lantern", "zzrepo", "Lantern-1.0-win64.zip", ["partial-name"]],
    ["Tony Hawk's Proving Ground", "zzrepo", "ProvingGround-1.0-win64.zip", ["partial-name"]],
    ["Disney's Lantern Quest", "zzrepo", "LanternQuest-1.0-win64.zip", ["partial-name"]],
    [
      "Star Wars: Shadows of the Empire",
      "zzrepo",
      "ShadowsOfTheEmpire-1.0-win64.zip",
      ["partial-name"],
    ],
    // Exempt numbers: a year, a dotted version, a platform's number, an
    // annotation token's number, and an annotation repeating a carried number.
    ["Lantern (1998)", "zzrepo", "Lantern-1.0-win64.zip", ["partial-name"]],
    ["Lantern — Lantern Remake 0.1", "zzrepo", "Lantern-1.0-win64.zip", ["partial-name"]],
    ["Crackdown: Xbox 360", "zzrepo", "Crackdown-1.0-win64.zip", ["partial-name"]],
    ["Lantern (N64)", "zzrepo", "Lantern-1.0-win64.zip", ["partial-name"]],
    ["Gears of War 2 — BT2 Recomp", "zzrepo", "GearsOfWar2-1.0-win64.zip", ["partial-name"]],
    ["Lantern — Lantern Port (oric212)", "zzrepo", "Lantern-1.0-win64.zip", ["partial-name"]],
    [
      "Gears of War 2 — Gears of War 2 — native PC port (unofficial) (santiquiroz)",
      "gears-of-war-2-pc-port",
      "gow2-recomp-0.4.7-linux-x86_64.tar.gz",
      ["descriptor", "initialism"],
    ],
    // A franchise-only partial name of a colon title (queued, see below).
    ["Half-Life: Blue Shift", "zzrepo", "HalfLife-1.0-win64.zip", ["partial-name"]],
    // Two letters with the name's number.
    ["Mega Man 2", "zzrepo", "mm2-1.0-win64.zip", ["initialism"]],
  ];
  for (const [name, repository, archive, reliefs] of enrolled) {
    const fit = reliefAccount(name, repository, archive);
    assert.ok("product" in fit, `${archive} for ${name}: ${JSON.stringify(fit)}`);
    assert.deepEqual(fit.reliefs.toSorted(), reliefs.toSorted(), archive);
  }
  // The same rules for program names, in fit and gate.
  const programs: [string, string, boolean][] = [
    ["Super Contra", "contra.exe", false],
    ["Mega Man: X4", "megaman.exe", false],
    ["Need for Speed: Underground 2", "nfs.exe", false],
    ["Killer Instinct", "ki.exe", false],
    ["Lantern — Lantern Engine (someone)", "someone.exe", false],
    ["Tony Hawk's Proving Ground", "provingground.exe", true],
    ["Digimon World 2", "dw2.exe", true],
    ["Rampage: Total Destruction", "rampage.exe", true],
  ];
  for (const [name, path, accounted] of programs) {
    const forms = reliefForms(
      reliefRecord("n", name, "zz-n-port").listing,
      "fixture-owner/zz-n-port",
      "",
    );
    const fit = programNameUnaccounted(path, new Set(), new Set(), false, forms);
    assert.equal(fit === null, accounted, `${path} for ${name}`);
    assert.equal(gateProgramAccounted(path, [], [], false, forms), accounted, `gate ${path}`);
  }
  // Platform words whose number is no sequel are restated by the gate.
  assert.deepEqual(gatePlatformNumberWords, [...platformNumberWords]);
  // N1: a two-letter initialism needs a number of the run; three letters do not.
  assert.equal(nameInitialisms(nameForm("Killer Instinct")).has("ki"), false);
  assert.equal(nameInitialisms(nameForm("Killer Instinct 2")).has("ki2"), true);
  assert.equal(nameInitialisms(nameForm("Killer Instinct Gold")).has("kig"), true);
});

/** A fixture listing as an authored record, bound to its own upstream URLs. */
function fixtureRecord(fields: Record<string, unknown>) {
  return listing(String(fields.id), {
    ...fields,
    original_game_title: fields.name,
    project_url: fields.project_url ?? fields.release_url,
  });
}
/** The GitHub repository a fixture listing names. */
function fixtureRepository(fields: Record<string, unknown>) {
  const repository = gateProviderRepository(fields);
  assert.ok(repository !== null, String(fields.id));
  return repository;
}

void test("generator 26: measured names and real-catalog collisions keep their stated outcome, in fit and gate (U fixture)", () => {
  const fixture = JSON.parse(
    readFileSync(
      join(root, "scripts/fixtures/generated-registration-name-uniqueness.json"),
      "utf8",
    ),
  ) as {
    listings: Record<string, unknown>[];
    archives: { listing: string; archive: string; expected: Record<string, string[]> }[];
    programs: { listing: string; program: string; expected: Record<string, string[]> }[];
  };
  const records = fixture.listings.map(fixtureRecord);
  const catalog = records.map((record) => record.listing as Record<string, unknown>);
  const own = (id: string) => catalog.find((item) => item.id === id)!;
  let collisions = 0;
  for (const { listing: id, archive, expected } of fixture.archives) {
    const listed = own(id);
    const repository = fixtureRepository(listed);
    const fit = archiveNameAccount(archive, listed, repository, catalog);
    const gate = gateArchiveAccount(archive, listed, repository, catalog);
    const [outcome, detail] = Object.entries(expected)[0]!;
    const where = `${archive} for ${String(listed.name)}`;
    assert.equal("product" in fit ? fit.product : null, gate, `fit and gate agree on ${where}`);
    if (outcome === "enrolls") {
      assert.ok("product" in fit, `${where}: ${JSON.stringify(fit)}`);
      assert.deepEqual(fit.reliefs, detail, where);
    } else if (outcome === "name-not-unique-in-catalog") {
      assert.deepEqual("notUnique" in fit ? fit.notUnique : fit, detail, where);
      collisions++;
    } else if (outcome === "archive-names-another-listing")
      assert.deepEqual("anotherListing" in fit ? fit.anotherListing : fit, detail, where);
    else assert.deepEqual("unaccounted" in fit ? fit.unaccounted : fit, detail, where);
  }
  for (const { listing: id, program, expected } of fixture.programs) {
    const listed = own(id);
    const repository = fixtureRepository(listed);
    const forms = reliefForms(listed, repository, "");
    const relieved: string[] = [];
    const used = new Set<(typeof nameReliefs)[number]>();
    const left = programNameUnaccounted(
      program,
      new Set(),
      new Set(),
      false,
      forms,
      used,
      forms,
      relieved,
      // As the fit decision reads it: no initial from an author handle (D3).
      { handles: authorHandles(listed, repository) },
    );
    const colliding = relieved.flatMap((literal) =>
      catalogNameCollisions(literal, digitRuns(literal), catalog, id, repository),
    );
    const unique = (literal: string) =>
      gateCollisions(literal, gateDigits(literal), catalog, id, repository, null).length === 0;
    const gate = gateProgramAccounted(
      program,
      [],
      [],
      false,
      forms,
      forms,
      unique,
      gateHandles(listed, repository),
    );
    const [outcome, detail] = Object.entries(expected)[0]!;
    const where = `${program} for ${String(listed.name)}`;
    if (outcome === "enrolls") {
      assert.equal(left, null, where);
      assert.deepEqual(colliding, [], where);
      assert.deepEqual([...used], detail, where);
      assert.ok(gate, `gate ${where}`);
    } else {
      assert.ok(!gate, `gate ${where}`);
      if (outcome === "name-not-unique-in-catalog") {
        assert.equal(left, null, where);
        assert.deepEqual(colliding, detail, where);
        collisions++;
      } else assert.equal(left, detail, where);
    }
  }
  assert.ok(collisions >= 8, `${collisions} collisions`);
  // A whole decision: `thps` in the repository of one Tony Hawk's Pro Skater
  // port collides with the other port's listing, and the withhold names it.
  const skater = records.find(
    (record) => record.listing.id === "alexbeav-tony-hawk-s-pro-skater-recomp",
  )!;
  const facts = entry(
    [named("thps-1.0-win64.zip", [player("DOA3.exe")], 11, "windows")],
    {},
    skater.listing.id,
    {
      repository: fixtureRepository(skater.listing),
      listing_words: listingWords(skater.listing),
    },
  );
  const decision = fitDecision(skater, facts, generatedAt, fitContext(records));
  assert.equal(reasonOf(decision), "name-not-unique-in-catalog");
  assert.deepEqual((decision as { evidence?: string[] }).evidence, [
    "windows-x86-64: thps-1.0-win64.zip (lancommander-tonywasaproskater)",
  ]);
  const others = records.filter((record) => record !== skater);
  assert.match(gateOn(skater, facts, { others }), /accepts too, so it names no one game/u);
  const queued = registrationQueues(generateRegistrations(records, table(facts)));
  assert.deepEqual(queued.reason_evidence["name-not-unique-in-catalog"], {
    "alexbeav-tony-hawk-s-pro-skater-recomp": [
      "windows-x86-64: thps-1.0-win64.zip (lancommander-tonywasaproskater)",
    ],
  });
});

/** A literal's digit runs, for the gate's helpers. */
function gateDigits(literal: string) {
  return digitRuns(literal);
}

void test("generator 26: initialisms are queued as franchise-only by the words of their run; a colon title's partial name too", () => {
  const records = [
    reliefRecord("hl", "Half-Life: Blue Shift", "blue-shift-port"),
    listing("zz-half-life", {
      name: "Half-Life 2",
      original_game_title: "Half-Life 2",
      project_url: "https://github.com/fixture-owner/half-life-2-port",
    }),
    reliefRecord("mm2", "Mega Man 2", "mega-port"),
    // Its own rules refuse `mm2` (N1: a sequel segment), so it shares the
    // run's words without accepting the initialism.
    listing("zz-mega-man-2-disc-3", {
      name: "Mega Man 2: Disc 3",
      original_game_title: "Mega Man 2",
      project_url: "https://github.com/fixture-owner/mega-man-2-disc-3",
    }),
  ];
  const catalog = records.map((record) => record.listing as Record<string, unknown>);
  const halfLife = archiveNameAccount(
    "HalfLife-1.0-win64.zip",
    records[0]!.listing,
    "fixture-owner/blue-shift-port",
    catalog,
  );
  assert.ok("product" in halfLife && halfLife.franchise, JSON.stringify(halfLife));
  const megaMan = archiveNameAccount(
    "mm2-1.0-win64.zip",
    records[2]!.listing,
    "fixture-owner/mega-port",
    catalog,
  );
  assert.ok("product" in megaMan && megaMan.franchise, JSON.stringify(megaMan));
  // Beside "Half-Life: Opposing Force" in another repository, `HalfLife`
  // spells that listing's first title segment (archive-names-another-listing);
  // beside "Valve's Half-Life: Decay" it is accepted by both, only under a
  // relief (name-not-unique-in-catalog). Both withhold, in fit and gate.
  for (const [other, expected] of [
    ["Half-Life: Opposing Force", { anotherListing: ["zz-half-life-other"] }],
    ["Valve's Half-Life: Decay", { notUnique: ["zz-half-life-other"] }],
  ] as const) {
    const sibling = listing("zz-half-life-other", {
      name: other,
      original_game_title: other,
      project_url: "https://github.com/fixture-owner/half-life-other-port",
    });
    const both = [...catalog, sibling.listing as Record<string, unknown>];
    assert.deepEqual(
      archiveNameAccount(
        "HalfLife-1.0-win64.zip",
        records[0]!.listing,
        "fixture-owner/blue-shift-port",
        both,
      ),
      expected,
      other,
    );
    assert.equal(
      gateArchiveAccount(
        "HalfLife-1.0-win64.zip",
        records[0]!.listing,
        "fixture-owner/blue-shift-port",
        both,
      ),
      null,
      other,
    );
  }
  // In the same repository the other listing is the shared-repository rule's concern.
  const sameRepository = listing("zz-half-life-same", {
    name: "Half-Life: Opposing Force",
    original_game_title: "Half-Life: Opposing Force",
    project_url: "https://github.com/fixture-owner/blue-shift-port",
  });
  assert.deepEqual(
    catalogNameCollisions(
      "halflife",
      digitRuns("halflife"),
      [...catalog, sameRepository.listing as Record<string, unknown>],
      records[0]!.listing.id,
      "fixture-owner/blue-shift-port",
    ),
    [],
  );
});

void test("random catalogs: a relieved literal accepted for a listing is never accepted for a listing in another repository; fit and gate agree (U property)", () => {
  let seed = 8_569_026;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const vocabulary = [
    "dark",
    "storm",
    "hunter",
    "blade",
    "orbit",
    "the",
    "of",
    "super",
    "tony",
    "hawk's",
  ];
  const segmentText = () => {
    const words = Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(vocabulary));
    if (random() < 0.3) words.push(pick(["2", "3", "II", "X4", "64"]));
    return words.join(" ");
  };
  // Each round shares a few segments between its listings, so names collide.
  let shared: string[] = [];
  const title = () => {
    let text = random() < 0.5 ? pick(shared) : segmentText();
    if (random() < 0.5) text += `: ${random() < 0.5 ? pick(shared) : segmentText()}`;
    if (random() < 0.4) text += ` — ${segmentText()}`;
    if (random() < 0.3) text += ` (${pick(["someone", "oric212", "Recomp", "N64", "2"])})`;
    return text;
  };
  const literalsOf = (name: string) => {
    const form = nameForm(name);
    const literals = new Set<string>(nameInitialisms(form));
    const segments = new Map<number, string[]>();
    for (const word of form)
      segments.set(word.segment, [...(segments.get(word.segment) ?? []), word.word]);
    for (const words of segments.values())
      for (let start = 0; start < words.length; start++) literals.add(words.slice(start).join(""));
    return [...literals];
  };
  let relievedChecked = 0;
  let collided = 0;
  for (let round = 0; round < 150; round++) {
    const size = 3 + Math.floor(random() * 6);
    shared = [segmentText(), segmentText()];
    const repositories = Array.from({ length: size }, (_, at) => `zz-u-${round}-${at}`);
    const records = Array.from({ length: size }, (_, at) =>
      listing(`zz-u-${round}-${at}`, {
        name: title(),
        original_game_title: "Original",
        // Some listings share a repository.
        project_url: `https://github.com/fixture-owner/${random() < 0.2 ? repositories[0] : repositories[at]}`,
      }),
    );
    const catalog = records.map((record) => record.listing as Record<string, unknown>);
    for (const record of records) {
      const repository = `fixture-owner/${String(record.listing.project_url).split("/").pop()}`;
      for (const literal of literalsOf(String(record.listing.name))) {
        if (!/^[a-z]/u.test(literal)) continue;
        const archive = `${literal}-1.0-win64.zip`;
        const fit = archiveNameAccount(archive, record.listing, repository, catalog);
        const gate = gateArchiveAccount(archive, record.listing, repository, catalog);
        assert.equal(
          "product" in fit ? fit.product : null,
          gate,
          `parity ${archive} for ${String(record.listing.name)}`,
        );
        if ("notUnique" in fit) collided++;
        if (!("product" in fit)) continue;
        const product = fit.product;
        const equal = [record.listing.id, record.listing.name, repository.split("/")[1]]
          .map((raw) =>
            nameForm(String(raw))
              .filter((word) => !word.optional)
              .map((word) => word.word)
              .join(""),
          )
          .includes(product);
        if (
          equal ||
          fit.reliefs.every((relief) => relief === "descriptor" || relief === "build-id")
        )
          continue;
        relievedChecked++;
        // No listing in another repository accepts the literal, by equality
        // or by the reliefs: checked over every listing, without the index.
        for (const other of catalog) {
          if (other.id === record.listing.id) continue;
          const otherRepository = `fixture-owner/${String(other.project_url).split("/").pop()}`;
          if (otherRepository === repository) continue;
          const forms = [other.id, other.name, otherRepository.split("/")[1]].map((raw) =>
            nameForm(String(raw)),
          );
          const digits = digitRuns(product);
          const cuts = new Set([0, product.length]);
          const accepts =
            forms.some(
              (form) =>
                form.map((word) => word.word).join("") === product ||
                reliefSpelling(product, digits, form, cuts) !== null,
            ) && !dropsLinkedNumber(product, digits, forms, cuts);
          assert.ok(
            !accepts,
            `${archive} enrolled for ${String(record.listing.name)} but ${String(other.name)} accepts it`,
          );
        }
      }
    }
  }
  assert.ok(relievedChecked > 200, `${relievedChecked} relieved enrollments checked`);
  assert.ok(collided > 50, `${collided} collisions withheld`);
});

void test("forced enrollments over random catalogs with colliding listings: the gate never accepts what the fit withholds, nor withholds what it accepts (U parity)", () => {
  let seed = 8_569_260;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const archives = [
    "Crackdown-v0.6.2-windows-x64.zip",
    "cdr-1.0-win64.zip",
    "cdx-1.0-win64.zip",
    "Crackdown-Recompiled-1.0-win64.zip",
    "Recompiled-1.0-win64.zip",
    "Crackdown-Xbox-1.0-win64.zip",
  ];
  const programs = ["Crackdown.exe", "CrackdownRecompiled.exe", "cd.exe", "crackdown-x64.exe"];
  const others = [
    // Accept `crackdown` by a partial name, in another repository.
    listing("zz-u-crackdown-other", {
      name: "Crackdown: Other City",
      original_game_title: "Crackdown",
      project_url: "https://github.com/fixture-owner/crackdown-other-city",
    }),
    listing("zz-u-crackdown-hawk", {
      name: "Tony Hawk's Crackdown",
      original_game_title: "Tony Hawk's Crackdown",
      project_url: "https://github.com/fixture-owner/hawk-crackdown",
    }),
    // Accepts the initialism `cdr`, in another repository.
    listing("zz-u-cdr", {
      name: "Cosmic Dust Rally",
      original_game_title: "Cosmic Dust Rally",
      project_url: "https://github.com/fixture-owner/cosmic-dust-rally",
    }),
    // The same repository: never a collision.
    listing("zz-u-same", {
      name: "Crackdown: Same Repository",
      original_game_title: "Crackdown",
      project_url: "https://github.com/fixture-owner/crackdown-xbox360-recompiled",
    }),
  ];
  let refused = 0;
  let enrolled = 0;
  let notUnique = 0;
  for (let round = 0; round < 400; round++) {
    const chosen = others.filter(() => random() < 0.5);
    const { decision, gate } = reliefDecision(
      "u",
      pick([
        "Crackdown (Crackdown Recompiled)",
        "Crackdown Recompiled: Xbox",
        "Crack Down Recompiled",
      ]),
      "crackdown-xbox360-recompiled",
      pick(archives),
      [pick(programs)],
      { others: chosen },
    );
    if (decision.fit) {
      assert.equal(gate, "accepted", JSON.stringify(decision));
      enrolled++;
    } else {
      assert.notEqual(gate, "accepted", `${decision.reason}: ${decision.detail}`);
      if (decision.reason === "name-not-unique-in-catalog") notUnique++;
      refused++;
    }
  }
  assert.ok(
    refused > 100 && enrolled > 10 && notUnique > 5,
    `${refused} refused, ${enrolled} enrolled, ${notUnique} not unique`,
  );
});

// ---------------------------------------------------------------------------
// Generator 27: spelled and four-digit numbers in a later title segment (B1),
// dropped subtitles always hand-checked (D1), numbers by value in uniqueness
// (D2), no initial from an author handle (D3) and relieved folders unique (D4).

void test("generator 27: a later title segment holding a spelled or four-digit number is never omitted, in fit and gate (B1)", () => {
  const withheld: [string, string][] = [
    ["Halo: Chapter Two", "Halo"],
    ["Halo: Second", "Halo"],
    ["Serious Sam: The Second Encounter", "SeriousSam"],
    ["Wipeout: 2048", "Wipeout"],
    ["Battlefield: 1942", "Battlefield"],
    ["Anno: 1602", "Anno"],
    ["The Order: 1886", "TheOrder"],
    // Every spelled number from one to twenty and from first to twentieth.
    ...spelledNumberWords.map((word): [string, string] => [`Lantern: ${word} Night`, "Lantern"]),
  ];
  for (const [name, product] of withheld) {
    const fit = reliefAccount(name, "zzrepo", `${product}-1.0-win64.zip`);
    assert.ok("unaccounted" in fit, `${product} for ${name}: ${JSON.stringify(fit)}`);
    // The same for a program name beside no other package form.
    const forms = reliefForms(
      reliefRecord("b1", name, "zz-b1-port").listing,
      "fixture-owner/zz-b1-port",
      "",
    );
    const path = `${product.toLowerCase()}.exe`;
    assert.notEqual(
      programNameUnaccounted(path, new Set(), new Set(), false, forms),
      null,
      `${path} for ${name}`,
    );
    assert.equal(gateProgramAccounted(path, [], [], false, forms), false, `gate ${path} ${name}`);
  }
  // `zero` is no sequel number, an annotation's number is none, and a
  // literal keeping the segment spells the name.
  const enrolled: [string, string, string[]][] = [
    ["Lantern: Zero Hour", "Lantern-1.0-win64.zip", ["partial-name"]],
    ["Lantern (Two Player)", "Lantern-1.0-win64.zip", ["partial-name"]],
    ["Lantern (2048)", "Lantern-1.0-win64.zip", ["partial-name"]],
    ["Halo: Chapter Two", "HaloChapterTwo-1.0-win64.zip", []],
    ["Wipeout: 2048", "Wipeout2048-1.0-win64.zip", []],
  ];
  for (const [name, archive, reliefs] of enrolled) {
    const fit = reliefAccount(name, "zzrepo", archive);
    assert.ok("product" in fit, `${archive} for ${name}: ${JSON.stringify(fit)}`);
    assert.deepEqual(fit.reliefs, reliefs, archive);
  }
  assert.deepEqual(gateSpelledNumbers, [...spelledNumberWords]);
  assert.ok(!(spelledNumberWords as readonly string[]).includes("zero"));
  const sequels = (name: string) =>
    nameForm(name)
      .filter((word) => word.sequel)
      .map((word) => word.word);
  assert.deepEqual(sequels("Halo: Chapter Two"), ["two"]);
  assert.deepEqual(sequels("Battlefield: 1942"), ["1942"]);
  // The first segment and annotations are not later title segments.
  assert.deepEqual(sequels("Two Worlds"), []);
  assert.deepEqual(sequels("Lantern (2048) — Second Port"), []);
});

void test("random titles: no relieved name whose omitted segment holds a digit, roman, spelled or four-digit number enrolls, in fit and gate (B1 property)", () => {
  let seed = 8_569_027;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const vocabulary = ["lantern", "storm", "hunter", "castle", "river", "night", "blade", "orbit"];
  const numbers = [
    () => String(1 + Math.floor(random() * 99)),
    () => pick(romanNumbers),
    () => pick(spelledNumberWords),
    () => String(1000 + Math.floor(random() * 9000)),
  ];
  let checked = 0;
  for (let round = 0; round < 1200; round++) {
    const head = [
      ...new Set(Array.from({ length: 1 + Math.floor(random() * 2) }, () => pick(vocabulary))),
    ];
    const subtitle = [
      ...new Set(Array.from({ length: Math.floor(random() * 3) }, () => pick(vocabulary))),
    ];
    const number = pick(numbers)();
    subtitle.splice(Math.floor(random() * (subtitle.length + 1)), 0, number);
    const title = `${head.join(" ")}: ${subtitle.join(" ")}${pick(["", " — Port (someone)", " (Recomp)"])}`;
    const product = head.map((word) => word[0]!.toUpperCase() + word.slice(1)).join("");
    const archive = `${product}-${pick(["1.0", "v2.1"])}-win64.zip`;
    const record = reliefRecord("p", title, "zz-p-port");
    const fit = archiveNameAccount(archive, record.listing, "fixture-owner/zz-p-port");
    const gate = gateArchiveAccount(archive, record.listing, "fixture-owner/zz-p-port");
    assert.equal("product" in fit ? fit.product : null, gate, `parity ${archive} for ${title}`);
    assert.ok(!("product" in fit), `${archive} must withhold for ${title}`);
    const forms = reliefForms(record.listing, "fixture-owner/zz-p-port", "");
    const path = `${product.toLowerCase()}.exe`;
    assert.notEqual(programNameUnaccounted(path, new Set(), new Set(), false, forms), null, path);
    assert.equal(gateProgramAccounted(path, [], [], false, forms), false, `gate ${path}`);
    checked++;
  }
  assert.ok(checked >= 1200, `${checked} titles`);
});

void test("generator 27: a relieved name that drops a later title segment is always queued as franchise-only, naming the segment, and still enrolls (D1)", () => {
  const cases: [string, string, string, string, string[]][] = [
    [
      "CyberMage: Darklight Re-Awakening",
      "cybermage-darklight-re-awakening",
      "cybermage-windows-x64.zip",
      "CyberMage.exe",
      // The program spells the accepted archive product: one finding.
      ['windows-x86-64: cybermage-windows-x64.zip drops "darklight re awakening"'],
    ],
    // The archive spells the repository name; the program drops the subtitle
    // (as `rampage` for "Rampage: Total Destruction" and `RampageRE`).
    [
      "Lantern: Total Destruction — LanternRE (someone)",
      "LanternRE",
      "LanternRE-1.0-win64.zip",
      "Lantern.exe",
      ['windows-x86-64: Lantern.exe drops "total destruction"'],
    ],
    [
      "Star Wars: Shadows of the Empire",
      "zz-sote-port",
      "StarWars-1.0-win64.zip",
      "StarWars.exe",
      ['windows-x86-64: StarWars-1.0-win64.zip drops "shadows of the empire"'],
    ],
    // An initialism drops every later title segment.
    [
      "Symphony of the Night: Requiem",
      "zz-sotn-port",
      "sotn-1.0-win64.zip",
      "sotn.exe",
      ['windows-x86-64: sotn-1.0-win64.zip drops "requiem"'],
    ],
    // Omitting an annotation, or only a descriptor segment, is not queued.
    ["Lantern (Total Destruction)", "zz-lantern-port", "Lantern-1.0-win64.zip", "Lantern.exe", []],
    ["Crackdown: Recompiled", "zz-crackdown-port", "Crackdown-1.0-win64.zip", "Crackdown.exe", []],
  ];
  const records: AuthoredPort[] = [];
  const entries: ListingFactsEntry[] = [];
  cases.forEach(([name, repository, archive, program, queued], at) => {
    const { decision, gate, record, facts } = reliefDecision(
      `d1-${at}`,
      name,
      repository,
      archive,
      [program],
    );
    assert.ok(decision.fit, `${archive} for ${name}: ${JSON.stringify(decision)}`);
    assert.equal(gate, "accepted", `gate ${archive} for ${name}`);
    assert.deepEqual(decision.franchise_only_partial, queued, `${archive} for ${name}`);
    if (at < 2) {
      records.push(record);
      entries.push(facts);
    }
  });
  // The route report lists each queued identity with its findings.
  const queues = registrationQueues(generateRegistrations(records, table(...entries)));
  assert.deepEqual(queues.franchise_only_partial, {
    "zz-relief-d1-0": cases[0]![4],
    "zz-relief-d1-1": cases[1]![4],
  });
});

void test("generator 27: numbers compare by value in the uniqueness index and the cross-listing check, both ways, in fit and gate (D2)", () => {
  const other = (id: string, name: string, repository: string) =>
    listing(id, {
      name,
      original_game_title: name,
      project_url: `https://github.com/fixture-owner/${repository}`,
    });
  const godOfWarII = other("zz-god-of-war-ii", "God of War II", "god-of-war-ii-port");
  const godOfWarIV = other("zz-god-of-war-iv", "God of War IV", "god-of-war-iv-port");
  const streetFighter = other("zz-street-fighter-iii", "Street Fighter III", "street-fighter-port");
  const shiningForce = other("zz-shining-force-iii", "Shining Force III", "shining-force-port");
  const syphonFilter = other("zz-syphon-filter-3", "Syphon Filter 3", "syphon-filter-port");
  const lanternII = other("zz-lantern-ii", "Lantern II", "lantern-ii-port");
  const lantern2 = other("zz-lantern-2", "Lantern 2", "lantern-2-port");
  const rows: [string, string, string, AuthoredPort[], Record<string, string[]> | null][] = [
    [
      "Gears of War 2",
      "gears-port",
      "gow2-1.0-win64.zip",
      [godOfWarII],
      { notUnique: [godOfWarII.listing.id] },
    ],
    // A different number never collides.
    ["Gears of War 2", "gears-port", "gow2-1.0-win64.zip", [godOfWarIV], null],
    [
      "Syphon Filter 3",
      "syphon-port",
      "sf3-1.0-win64.zip",
      [streetFighter, shiningForce],
      {
        notUnique: [shiningForce.listing.id, streetFighter.listing.id].toSorted(compareCodePoints),
      },
    ],
    [
      "Shining Force III",
      "shining-port",
      "sfiii-1.0-win64.zip",
      [syphonFilter],
      { notUnique: [syphonFilter.listing.id] },
    ],
    [
      "Street Fighter III",
      "street-port",
      "sfiii-1.0-win64.zip",
      [syphonFilter],
      { notUnique: [syphonFilter.listing.id] },
    ],
    // The cross-listing check: the relieved product spells the other
    // listing's whole name with its number written the other way.
    [
      "Lantern 2: Echoes",
      "lantern-port",
      "Lantern2-1.0-win64.zip",
      [lanternII],
      { anotherListing: [lanternII.listing.id] },
    ],
    [
      "Lantern II: Echoes",
      "lantern-port",
      "LanternII-1.0-win64.zip",
      [lantern2],
      { anotherListing: [lantern2.listing.id] },
    ],
  ];
  for (const [name, repository, archive, others, expected] of rows) {
    const fit = reliefAccount(name, repository, archive, others);
    if (expected === null)
      assert.ok("product" in fit, `${archive} for ${name}: ${JSON.stringify(fit)}`);
    else assert.deepEqual(fit, expected, `${archive} for ${name}`);
  }
  // The index both ways on the real listings of the uniqueness fixture.
  const fixture = JSON.parse(
    readFileSync(
      join(root, "scripts/fixtures/generated-registration-name-uniqueness.json"),
      "utf8",
    ),
  ) as { listings: Record<string, unknown>[] };
  const catalog = fixture.listings.map(
    (fields) => fixtureRecord(fields).listing as Record<string, unknown>,
  );
  const own = (id: string) => catalog.find((item) => item.id === id)!;
  const collisions = (literal: string, id: string) => {
    const repository = fixtureRepository(own(id));
    const fit = catalogNameCollisions(literal, digitRuns(literal), catalog, id, repository);
    const gate = gateCollisions(literal, digitRuns(literal), catalog, id, repository, null);
    assert.deepEqual(fit, gate, `fit and gate agree on ${literal}`);
    return fit;
  };
  assert.deepEqual(collisions("gow2", "fenix-reborn-0-1-josuloku-new-gears-of-war-2"), [
    "gow2-nativo-ps2-cxldsakeb-god-of-war-ii",
    "gow2-recomp-andrebrumdev-andrebrumdev-god-of-war-ii-hd",
  ]);
  assert.deepEqual(collisions("sf3", "alexbeav-syphon-filter-3-recomp"), [
    "sfiii-native-mattkuhnqaai-shining-force-iii",
  ]);
  assert.deepEqual(collisions("sfiii", "alexbeav-syphon-filter-3-recomp"), [
    "sfiii-native-mattkuhnqaai-shining-force-iii",
  ]);
  assert.deepEqual(collisions("sfiii", "sfiii-native-mattkuhnqaai-shining-force-iii"), [
    "alexbeav-syphon-filter-3-recomp",
  ]);
  // "Street Fighter III: 3rd Strike" accepts neither: its subtitle holds a
  // sequel number, so no initialism may omit it (N1).
  assert.ok(
    !collisions("sf3", "fenix-reborn-0-1-josuloku-new-gears-of-war-2").includes(
      "street-fighter-iii-3rd-strike-3sx",
    ),
  );
  // The twins: one group per way, the form itself where unchanged.
  const twins = numberTwinGroups([nameForm("God of War II"), nameForm("Gears 2")]).map((group) =>
    group.map((form) => form.map((word) => word.word).join(" ")),
  );
  assert.deepEqual(twins, [
    ["god of war ii", "gears 2"],
    ["god of war ii", "gears ii"],
    ["god of war 2", "gears 2"],
  ]);
  const plain = nameForm("Lantern");
  assert.equal(numberTwin(plain, "roman"), plain);
  // Generator 28 (F5): no bound of 20; a lone `1` stays as it is but as the
  // last word of a title segment right after the product words.
  assert.deepEqual(
    numberTwin(nameForm("Lantern 21"), "roman").map((word) => word.word),
    ["lantern", "xxi"],
  );
  const lantern1 = nameForm("Lantern 1 Night");
  assert.equal(numberTwin(lantern1, "roman"), lantern1);
});

void test("random catalogs with numbers written both ways: a relieved literal is never accepted when a listing in another repository accepts its roman or digit twin (D2 property)", () => {
  let seed = 8_569_272;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const vocabulary = ["dark", "storm", "hunter", "blade", "orbit", "sky", "force", "filter"];
  const roman = ["i", ...romanNumbers];
  const writeNumber = (value: number) =>
    random() < 0.5 ? String(value) : roman[value - 1]!.toUpperCase();
  const titleOf = () => {
    const words = Array.from({ length: 2 + Math.floor(random() * 2) }, () => pick(vocabulary));
    if (random() < 0.8) words.push(writeNumber(2 + Math.floor(random() * 5)));
    let text = words.join(" ");
    if (random() < 0.4) text += `: ${pick(vocabulary)} ${pick(vocabulary)}`;
    return text;
  };
  // The other way of writing every number of a raw name: digits as roman
  // numerals, roman numerals as digits, word by word.
  const swapped = (raw: string, way: "roman" | "digits") =>
    raw.replace(/[A-Za-z0-9]+/gu, (word) => {
      const low = word.toLowerCase();
      if (way === "roman" && /^(?:[1-9]|1[0-9]|20)$/u.test(low)) return roman[Number(low) - 1]!;
      if (way === "digits" && (romanNumbers as readonly string[]).includes(low))
        return String(roman.indexOf(low) + 1);
      return word;
    });
  let checked = 0;
  for (let round = 0; round < 200; round++) {
    const size = 3 + Math.floor(random() * 5);
    const shared = titleOf();
    const records = Array.from({ length: size }, (_, at) =>
      listing(`zz-d2-${round}-${at}`, {
        name: random() < 0.5 ? swapped(shared, pick(["roman", "digits"] as const)) : titleOf(),
        original_game_title: "Original",
        project_url: `https://github.com/fixture-owner/zz-d2-${round}-${at}`,
      }),
    );
    const catalog = records.map((record) => record.listing as Record<string, unknown>);
    for (const record of records) {
      const repository = `fixture-owner/${String(record.listing.id)}`;
      const literals = new Set<string>(nameInitialisms(nameForm(String(record.listing.name))));
      const words = nameForm(String(record.listing.name)).map((word) => word.word);
      for (let end = 1; end <= words.length; end++) literals.add(words.slice(0, end).join(""));
      for (const literal of literals) {
        if (!/^[a-z]/u.test(literal)) continue;
        const archive = `${literal}-1.0-win64.zip`;
        const fit = archiveNameAccount(archive, record.listing, repository, catalog);
        const gate = gateArchiveAccount(archive, record.listing, repository, catalog);
        assert.equal("product" in fit ? fit.product : null, gate, `parity ${archive}`);
        if (!("product" in fit) || fit.reliefs.every((relief) => relief === "descriptor")) continue;
        if (!fit.reliefs.includes("partial-name") && !fit.reliefs.includes("initialism")) continue;
        const product: string = fit.product;
        const ownWhole = nameForm(String(record.listing.name))
          .filter((word) => !word.optional)
          .map((word) => word.word)
          .join("");
        if (product === ownWhole) continue;
        checked++;
        for (const other of catalog) {
          if (other.id === record.listing.id) continue;
          for (const way of ["roman", "digits"] as const)
            for (const raw of [other.id, other.name].map((value) => swapped(String(value), way))) {
              const form = nameForm(raw);
              const digits = digitRuns(product);
              const cuts = new Set([0, product.length]);
              const accepts =
                (form.map((word) => word.word).join("") === product ||
                  reliefSpelling(product, digits, form, cuts) !== null) &&
                !dropsLinkedNumber(product, digits, [form], cuts);
              assert.ok(
                !accepts,
                `${archive} enrolled for ${String(record.listing.name)} but ${raw} (${String(other.name)}) accepts it`,
              );
            }
        }
      }
    }
  }
  assert.ok(checked > 100, `${checked} relieved enrollments checked`);
});

void test("generator 27: no initialism takes an initial from an author handle that prefixes a listing id or repository name, in fit and gate (D3)", () => {
  const handles: [string, string, string, string[]][] = [
    [
      "alexbeav-suikoden-ii-recomp",
      "Suikoden II / Alexbeav PSXRecomp",
      "alexbeavs-ps1-ports/suikoden-ii-recomp",
      ["alexbeav"],
    ],
    [
      "abilliontokens-sims2-recomp",
      "The Sims 2 — Original Xbox (The Sims 2 - Static Recompilation)",
      "abilliontokens/sims2-recomp",
      ["abilliontokens"],
    ],
    ["zz-lantern-quest", "Lantern Quest", "ownerco/ownerco-lantern-quest", ["ownerco", "zz"]],
    // Title and repository words are no handles.
    [
      "itc-recomp-spooky098529-import-tuner-challenge",
      "Import Tuner Challenge — ITC-Recomp (Spooky098529)",
      "Spooky098529/ITC-Recomp",
      [],
    ],
    [
      "crackdown-crackdown-recompiled",
      "Crackdown (Crackdown Recompiled)",
      "saulob/crackdown-xbox360-recompiled",
      [],
    ],
    ["lantern-quest", "Lantern Quest", "lantern/lantern-quest", []],
  ];
  for (const [id, name, repository, expected] of handles) {
    const own = { id, name };
    assert.deepEqual([...authorHandles(own, repository)].toSorted(compareCodePoints), expected, id);
    assert.deepEqual(
      gateHandles(own, repository).toSorted(compareCodePoints),
      expected,
      `gate ${id}`,
    );
  }
  const withheld: [string, string, string, string][] = [
    [
      "alexbeav-suikoden-ii-recomp",
      "Suikoden II / Alexbeav PSXRecomp",
      "alexbeavs-ps1-ports/suikoden-ii-recomp",
      "asii",
    ],
    [
      "abilliontokens-sims2-recomp",
      "The Sims 2 — Original Xbox (The Sims 2 - Static Recompilation)",
      "abilliontokens/sims2-recomp",
      "as2",
    ],
    ["zz-lantern-quest", "Lantern Quest", "ownerco/ownerco-lantern-quest", "olq"],
  ];
  for (const [id, name, repository, literal] of withheld) {
    const own = listing(id, {
      name,
      original_game_title: name,
      project_url: `https://github.com/${repository}`,
    });
    const archive = `${literal}-1.0-win64.zip`;
    const fit = archiveNameAccount(archive, own.listing, repository);
    assert.ok("unaccounted" in fit, `${archive} for ${id}: ${JSON.stringify(fit)}`);
    assert.equal(gateArchiveAccount(archive, own.listing, repository), null, `gate ${archive}`);
    const forms = reliefForms(own.listing, repository, "");
    const path = `${literal}.exe`;
    assert.equal(
      programNameUnaccounted(path, new Set(), new Set(), false, forms, new Set(), forms, [], {
        handles: authorHandles(own.listing, repository),
      }),
      literal,
      path,
    );
    assert.equal(
      gateProgramAccounted(
        path,
        [],
        [],
        false,
        forms,
        forms,
        () => true,
        gateHandles(own.listing, repository),
      ),
      false,
      `gate ${path}`,
    );
  }
  // The same repository name without the owner's handle gives its initialism.
  const control = listing("zz-lantern-quest-hero", {
    name: "Lantern Quest Hero",
    project_url: "https://github.com/ownerco/lantern-quest-hero",
  });
  assert.ok(
    "product" in
      archiveNameAccount("lqh-1.0-win64.zip", control.listing, "ownerco/lantern-quest-hero"),
  );
  assert.equal(
    gateArchiveAccount("lqh-1.0-win64.zip", control.listing, "ownerco/lantern-quest-hero"),
    "lqh",
  );
});

void test("generator 27: a relieved folder name on the program's path must be unique like a program name, in fit and gate (D4)", () => {
  const spaceMarine = listing("zz-space-marine-2", {
    name: "Space Marine 2",
    original_game_title: "Space Marine 2",
    project_url: "https://github.com/fixture-owner/space-marine-2-port",
  });
  // `sm2/` is the initialism of "Spider Man 2", which "Space Marine 2" in
  // another repository accepts too.
  const collided = reliefDecision(
    "d4",
    "Spider Man 2",
    "spider-man-2-port",
    "SpiderMan2-1.0-win64.zip",
    ["sm2/SpiderMan2.exe"],
    { others: [spaceMarine] },
  );
  assert.equal(reasonOf(collided.decision), "name-not-unique-in-catalog");
  assert.deepEqual((collided.decision as { evidence?: string[] }).evidence, [
    "windows-x86-64: sm2/SpiderMan2.exe (zz-space-marine-2)",
  ]);
  assert.notEqual(collided.gate, "accepted");
  // Alone, the relieved folder is unique and enrolls.
  const alone = reliefDecision(
    "d4",
    "Spider Man 2",
    "spider-man-2-port",
    "SpiderMan2-1.0-win64.zip",
    ["sm2/SpiderMan2.exe"],
  );
  assert.ok(
    alone.decision.fit && alone.decision.reliefs.includes("folder"),
    JSON.stringify(alone.decision),
  );
  assert.equal(alone.gate, "accepted");
  // A folder that spells the accepted product is not compared.
  const equal = reliefDecision(
    "d4",
    "Spider Man 2",
    "spider-man-2-port",
    "SpiderMan2-1.0-win64.zip",
    ["SpiderMan2-v1.0/SpiderMan2.exe"],
    { others: [spaceMarine] },
  );
  assert.ok(equal.decision.fit, JSON.stringify(equal.decision));
  assert.equal(equal.gate, "accepted");
});

void test("forced enrollments over random names and catalogs: the gate never accepts what the fit withholds, nor withholds what it accepts, with subtitles, number twins, handles and folders (generator 27 parity)", () => {
  let seed = 8_569_277;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  // Heads with the programs Core's fixture classifies.
  const heads: [string, string[]][] = [
    ["Lantern", ["Lantern.exe", "LanternTwo.exe"]],
    ["Spider Man 2", ["SpiderMan2.exe", "SpiderMan.exe"]],
    ["Star Wars", ["StarWars.exe", "StarWarsBattlefront.exe"]],
    ["Doom", ["Doom.exe", "Doom2.exe"]],
    ["Crackdown", ["Crackdown.exe", "CrackdownRecompiled.exe"]],
    ["CyberMage", ["CyberMage.exe"]],
  ];
  const subtitles = [
    "",
    ": Total Destruction",
    ": Chapter Two",
    ": 2048",
    ": Second Night",
    " II",
    " 2",
    " (Two Player)",
    " — Port (someone)",
    ": Zero Hour",
    ": Recompiled",
  ];
  const pool = [
    ["zz-g-lantern-ii", "Lantern II"],
    ["zz-g-lantern-2-echoes", "Lantern 2: Echoes"],
    ["zz-g-space-marine-2", "Space Marine 2"],
    ["zz-g-spider-man-ii", "Spider Man II"],
    ["zz-g-star-wars-dark-forces", "Star Wars: Dark Forces"],
    ["zz-g-doom-ii", "Doom II"],
    ["zz-g-crackdown-2", "Crackdown 2"],
    ["zz-g-lantern-quest", "Lantern Quest"],
    ["zz-g-cybermage-two", "CyberMage: Chapter Two"],
  ].map(([id, name]) =>
    listing(id, {
      name,
      original_game_title: name,
      project_url: `https://github.com/fixture-owner/${id}-port`,
    }),
  );
  const camel = (text: string) =>
    text
      .split(/[^A-Za-z0-9]+/u)
      .filter(Boolean)
      .map((word) => word[0]!.toUpperCase() + word.slice(1))
      .join("");
  const initials = (text: string) =>
    text
      .split(/[^A-Za-z0-9]+/u)
      .filter(Boolean)
      .map((word) => (/^[0-9]+$/u.test(word) ? word : word[0]!.toLowerCase()))
      .join("");
  let enrolled = 0;
  let withheld = 0;
  const reasons = new Set<string>();
  for (let round = 0; round < 500; round++) {
    const [head, programs] = pick(heads);
    const name = `${head}${pick(subtitles)}`;
    const slug = head.toLowerCase().replace(/[^a-z0-9]+/gu, "-");
    const repository = pick([`${slug}-port`, `fixture-${slug}`, `${slug}-recomp`]);
    const product = pick([camel(head), initials(head), camel(name), `${camel(head)}-Recomp`]);
    const archive = `${product}-${pick(["1.0", "v2.1"])}-win64.zip`;
    const program = pick(programs);
    const folder = pick(["", `${initials(head)}/`, `${camel(head)}/`, "bin/", `${camel(name)}/`]);
    const { decision, gate } = reliefDecision(
      `g${round}`,
      name,
      repository,
      archive,
      [`${folder}${program}`],
      { others: pool.filter(() => random() < 0.3) },
    );
    if (decision.fit) {
      assert.equal(gate, "accepted", `${archive} ${folder}${program} for ${name}: ${gate}`);
      enrolled++;
    } else {
      assert.notEqual(
        gate,
        "accepted",
        `${archive} ${folder}${program} for ${name}: ${decision.reason}`,
      );
      reasons.add(decision.reason);
      withheld++;
    }
  }
  assert.ok(enrolled > 30 && withheld > 100, `${enrolled} enrolled, ${withheld} withheld`);
  for (const reason of ["name-not-unique-in-catalog", "archive-name-unaccounted"])
    assert.ok(reasons.has(reason), `${reason} among ${[...reasons].join(", ")}`);
});

// ---------------------------------------------------------------------------
// Generator 28: every number of a later title segment is a sequel number
// (R1, F1), numbers compare by value without a bound (F5), and a dropped
// subtitle of a name equal to the repository or id name is queued (F3).

/** The rows of R1 and F1: a relieved name that drops a numbered subtitle. */
const generator28Withheld: [string, string][] = [
  ["Kingdom Hearts: 2.8", "KingdomHearts"],
  ["Halo: 2.5", "Halo"],
  ["Halo: 1.5", "Halo"],
  ["Halo: 3.0", "Halo"],
  ["Halo: 2.0", "Halo"],
  ["Halo: Version 2.0", "Halo"],
  ["Halo: Episode 2.5", "Halo"],
  ["Halo: Chapter 1.5", "Halo"],
  ["Halo Wars: 2.5", "HaloWars"],
  ["Halo Wars: XXI", "HaloWars"],
  ["Halo: XXI", "Halo"],
  ["Halo: XL", "Halo"],
  ["Halo: XXV", "Halo"],
  ["Halo: XXXIII", "Halo"],
  ["Halo: MMXX", "Halo"],
  ["Halo: V", "Halo"],
  ["Halo: X", "Halo"],
  // F1: spelled numbers beyond twenty, joined or hyphenated.
  ["Halo: Thirty", "Halo"],
  ["Halo: Ninety Nights", "Halo"],
  ["Halo: Hundred", "Halo"],
  ["Halo: Thousand Suns", "Halo"],
  ["Halo: Thirtieth", "Halo"],
  ["Halo: Twentyfirst", "Halo"],
  ["Halo: Twenty-One", "Halo"],
  ["Halo: Thirty-One", "Halo"],
  ["Halo: Twentysecond", "Halo"],
  ["Halo: TwentyFirst Century", "Halo"],
  ["Halo: Ninetynine", "Halo"],
  ["Halo: Onehundred", "Halo"],
];

void test("generator 28: a later title segment holding a dotted, roman or spelled number of any size is never omitted, in fit and gate, archive and program (R1, F1)", () => {
  for (const [name, product] of generator28Withheld) {
    const fit = reliefAccount(name, "zzrepo", `${product}-1.0-win64.zip`);
    assert.ok("unaccounted" in fit, `${product} for ${name}: ${JSON.stringify(fit)}`);
    const forms = reliefForms(
      reliefRecord("r1", name, "zz-r1-port").listing,
      "fixture-owner/zz-r1-port",
      "",
    );
    const path = `${product.toLowerCase()}.exe`;
    assert.notEqual(
      programNameUnaccounted(path, new Set(), new Set(), false, forms),
      null,
      `${path} for ${name}`,
    );
    assert.equal(gateProgramAccounted(path, [], [], false, forms), false, `gate ${path} ${name}`);
  }
  // Still enrolling: a lone `I`, `zero`, a platform's number, an annotation's
  // number, and a literal that keeps the segment.
  const enrolled: [string, string, string[]][] = [
    ["Halo: I", "Halo-1.0-win64.zip", ["partial-name"]],
    ["Halo: Zero Hour", "Halo-1.0-win64.zip", ["partial-name"]],
    ["Crackdown: Xbox 360", "Crackdown-1.0-win64.zip", ["partial-name"]],
    ["Halo (2.5)", "Halo-1.0-win64.zip", ["partial-name"]],
    ["Halo — Port XXI (someone)", "Halo-1.0-win64.zip", ["partial-name"]],
    ["Halo: XXI", "HaloXXI-1.0-win64.zip", []],
    ["Halo: Thirty", "HaloThirty-1.0-win64.zip", []],
  ];
  for (const [name, archive, reliefs] of enrolled) {
    const fit = reliefAccount(name, "zzrepo", archive);
    assert.ok("product" in fit, `${archive} for ${name}: ${JSON.stringify(fit)}`);
    assert.deepEqual(fit.reliefs, reliefs, archive);
  }
  assert.deepEqual(gateSpelledNumbers, [...spelledNumberWords]);
  for (const word of ["thirty", "ninety", "hundred", "thousand", "twentyfirst", "ninetynine"])
    assert.ok(spelledNumber(word), word);
  for (const word of ["zero", "thirtyzero", "hundredone", "twenties"])
    assert.ok(!spelledNumber(word), word);
  const sequels = (name: string) =>
    nameForm(name)
      .filter((word) => word.sequel)
      .map((word) => word.word);
  assert.deepEqual(sequels("Halo: Version 2.0"), ["2", "0"]);
  assert.deepEqual(sequels("Halo: MMXX"), ["mmxx"]);
  assert.deepEqual(sequels("Halo: I"), []);
  assert.deepEqual(sequels("Crackdown: Xbox 360"), []);
  // The first segment keeps its dotted-version reading.
  assert.deepEqual(sequels("Lantern 0.1"), []);
});

void test("generator 28: roman numerals read by value without a bound, both ways (F5)", () => {
  const values: [string, number | null][] = [
    ["i", 1],
    ["iv", 4],
    ["xx", 20],
    ["xxi", 21],
    ["xl", 40],
    ["mcmxlii", 1942],
    ["mmxx", 2020],
    ["mmmmx", 4010],
    ["iiii", null],
    ["vx", null],
    ["il", null],
    ["mix", 1009],
    ["mid", null],
    ["", null],
  ];
  for (const [word, value] of values) assert.equal(romanValue(word), value, word);
  for (let value = 1; value <= 3999; value++) assert.equal(romanValue(romanOf(value)), value);
  assert.ok(laterRomanNumber("v") && laterRomanNumber("x") && laterRomanNumber("xxxiii"));
  assert.ok(!laterRomanNumber("i") && !laterRomanNumber("l") && !laterRomanNumber("halo"));
});

void test("generator 28: numbers compare by value without a bound, and `1` meets a lone `I` only right after a title's product words, in fit and gate (F5)", () => {
  const other = (id: string, name: string, repository: string) =>
    listing(id, {
      name,
      original_game_title: name,
      project_url: `https://github.com/fixture-owner/${repository}`,
    });
  const godOfWarXXI = other("zz-god-of-war-xxi", "God of War XXI", "god-of-war-xxi-port");
  const godOfWar21 = other("zz-god-of-war-21", "God of War 21", "god-of-war-21-port");
  const finalFantasyI = other("zz-final-fantasy-i", "Final Fantasy I", "final-fantasy-i-port");
  const finalFantasy1 = other("zz-final-fantasy-1", "Final Fantasy 1", "final-fantasy-1-port");
  const lanternXL = other("zz-lantern-xl", "Lantern XL", "lantern-xl-port");
  const lanternOne = other("zz-lantern-1-night", "Lantern 1 Night", "lantern-1-night-port");
  const rows: [string, string, string, AuthoredPort[], Record<string, string[]> | null][] = [
    [
      "Gears of War 21",
      "gears-port",
      "gow21-1.0-win64.zip",
      [godOfWarXXI],
      { notUnique: [godOfWarXXI.listing.id] },
    ],
    [
      "Gears of War XXI",
      "gears-port",
      "gowxxi-1.0-win64.zip",
      [godOfWar21],
      { notUnique: [godOfWar21.listing.id] },
    ],
    [
      "Fighting Force 1",
      "fighting-port",
      "ff1-1.0-win64.zip",
      [finalFantasyI],
      { notUnique: [finalFantasyI.listing.id] },
    ],
    [
      "Fighting Force I",
      "fighting-port",
      "ffi-1.0-win64.zip",
      [finalFantasy1],
      { notUnique: [finalFantasy1.listing.id] },
    ],
    // The cross-listing check: 40 written the other way.
    [
      "Lantern 40: Echoes",
      "lantern-port",
      "Lantern40-1.0-win64.zip",
      [lanternXL],
      { anotherListing: [lanternXL.listing.id] },
    ],
    // A `1` that is not the last word of its segment is no `I`.
    ["Lantern I Night", "lantern-i-port", "lin-1.0-win64.zip", [lanternOne], null],
  ];
  for (const [name, repository, archive, others, expected] of rows) {
    const fit = reliefAccount(name, repository, archive, others);
    if (expected === null)
      assert.ok("product" in fit, `${archive} for ${name}: ${JSON.stringify(fit)}`);
    else assert.deepEqual(fit, expected, `${archive} for ${name}`);
  }
  const catalog = [godOfWarXXI, finalFantasyI, lanternOne].map(
    (record) => record.listing as Record<string, unknown>,
  );
  const collisions = (literal: string) => {
    const fit = catalogNameCollisions(literal, digitRuns(literal), catalog, "zz-own", "x/own");
    const gate = gateCollisions(literal, digitRuns(literal), catalog, "zz-own", "x/own", null);
    assert.deepEqual(fit, gate, `fit and gate agree on ${literal}`);
    return fit;
  };
  assert.deepEqual(collisions("gow21"), [godOfWarXXI.listing.id]);
  assert.deepEqual(collisions("ff1"), [finalFantasyI.listing.id]);
  assert.deepEqual(collisions("l1n"), [lanternOne.listing.id]);
  assert.deepEqual(collisions("lin"), []);
});

void test("generator 28: a name equal to the repository or id name that drops a later title segment is queued for a hand check and still enrolls (F3)", () => {
  assert.deepEqual(subtitleDroppedByName("halo2", { name: "Halo 2: Chapter Two" }), [
    "chapter two",
  ]);
  // The name's own rules refuse every spelling: the segments after the run.
  assert.deepEqual(subtitleDroppedByName("halo", { name: "Halo: 2.5" }), ["2 5"]);
  assert.deepEqual(subtitleDroppedByName("halochaptertwo", { name: "Halo: Chapter Two" }), []);
  assert.deepEqual(subtitleDroppedByName("lantern", { name: "Lantern (2048)" }), []);
  const cases: [string, string, string, string, string[], string[]][] = [
    // A repository named for the franchise and a number.
    [
      "Doom 2: Total Destruction",
      "doom2",
      "Doom2-1.0-win64.zip",
      "Doom2.exe",
      [],
      [
        'windows-x86-64: Doom2-1.0-win64.zip drops "total destruction"',
        'windows-x86-64: Doom2.exe drops "total destruction"',
      ],
    ],
    // A sequel subtitle the listing name never lets go is withheld by the
    // base rules even through the repository name (`missing:2`,
    // `missing:thirty`), so it never reaches this queue.
    // A relieved name is D1's, never listed twice.
    [
      "Lantern: Total Destruction — LanternRE (someone)",
      "LanternRE",
      "LanternRE-1.0-win64.zip",
      "Lantern.exe",
      ['windows-x86-64: Lantern.exe drops "total destruction"'],
      [],
    ],
    // A name equal to the listing's is not queued.
    ["Doom 2", "doom2", "Doom2-1.0-win64.zip", "Doom2.exe", [], []],
  ];
  const records: AuthoredPort[] = [];
  const entries: ListingFactsEntry[] = [];
  cases.forEach(([name, repository, archive, program, franchise, queued], at) => {
    const { decision, gate, record, facts } = reliefDecision(
      `f3-${at}`,
      name,
      repository,
      archive,
      [program],
    );
    assert.ok(decision.fit, `${archive} for ${name}: ${JSON.stringify(decision)}`);
    assert.equal(gate, "accepted", `gate ${archive} for ${name}`);
    assert.deepEqual(decision.franchise_only_partial, franchise, `${archive} for ${name}`);
    assert.deepEqual(decision.subtitle_dropped_by_repository_name, queued, `${archive} ${name}`);
    // The route report, beside a listing it does not queue (one per repository).
    if (at < 2) {
      records.push(record);
      entries.push(facts);
    }
  });
  const queues = registrationQueues(generateRegistrations(records, table(...entries)));
  assert.deepEqual(queues.subtitle_dropped_by_repository_name, {
    "zz-relief-f3-0": cases[0]![5],
  });
});

void test("random titles: no relieved name whose omitted segment holds a dotted number, a roman numeral of any size or a spelled number beyond twenty enrolls, in fit and gate (R1/F1 property)", () => {
  let seed = 8_569_028;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const vocabulary = ["lantern", "storm", "hunter", "castle", "river", "night", "blade", "orbit"];
  const tens = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const units = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  const ordinals = ["first", "second", "third", "fourth", "fifth", "ninth"];
  const roman = () => {
    let value = 2 + Math.floor(random() * 3998);
    if (random() < 0.5) value = 2 + Math.floor(random() * 60);
    let text = romanOf(value);
    // A lone `L`, `C`, `D` or `M` is a word, not a number: one more `I`.
    if (text.length === 1 && text !== "v" && text !== "x") text += "i";
    return random() < 0.5 ? text.toUpperCase() : text;
  };
  const numbers = [
    () => String(1 + Math.floor(random() * 99)),
    () => `${Math.floor(random() * 10)}.${Math.floor(random() * 10)}`,
    () =>
      `${1 + Math.floor(random() * 9)}.${Math.floor(random() * 10)}.${Math.floor(random() * 10)}`,
    roman,
    () => pick(["V", "X", "v", "x"]),
    () => pick(spelledNumberWords),
    () => `${pick(tens)}-${pick([...units, ...ordinals])}`,
    () => `${pick(tens)}${pick([...units, ...ordinals])}`,
    () => `${pick(units)}${pick(["hundred", "thousand"])}`,
  ];
  let checked = 0;
  for (let round = 0; round < 1500; round++) {
    const head = [
      ...new Set(Array.from({ length: 1 + Math.floor(random() * 2) }, () => pick(vocabulary))),
    ];
    const subtitle = [
      ...new Set(Array.from({ length: Math.floor(random() * 3) }, () => pick(vocabulary))),
    ];
    const number = pick(numbers)();
    subtitle.splice(Math.floor(random() * (subtitle.length + 1)), 0, number);
    const title = `${head.join(" ")}: ${subtitle.join(" ")}${pick(["", " — Port (someone)", " (Recomp)"])}`;
    const product = head.map((word) => word[0]!.toUpperCase() + word.slice(1)).join("");
    const archive = `${product}-${pick(["1.0", "v2.1"])}-win64.zip`;
    const record = reliefRecord("q", title, "zz-q-port");
    const fit = archiveNameAccount(archive, record.listing, "fixture-owner/zz-q-port");
    const gate = gateArchiveAccount(archive, record.listing, "fixture-owner/zz-q-port");
    assert.equal("product" in fit ? fit.product : null, gate, `parity ${archive} for ${title}`);
    assert.ok(!("product" in fit), `${archive} must withhold for ${title}`);
    const forms = reliefForms(record.listing, "fixture-owner/zz-q-port", "");
    const path = `${product.toLowerCase()}.exe`;
    assert.notEqual(programNameUnaccounted(path, new Set(), new Set(), false, forms), null, path);
    assert.equal(gateProgramAccounted(path, [], [], false, forms), false, `gate ${path}`);
    checked++;
  }
  assert.ok(checked >= 1500, `${checked} titles`);
});

void test("forced enrollments over random names and catalogs with numbered subtitles and large numbers: the gate never accepts what the fit withholds, nor withholds what it accepts (generator 28 parity)", () => {
  let seed = 8_569_288;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const heads: [string, string[]][] = [
    ["Lantern", ["Lantern.exe", "LanternTwo.exe"]],
    ["Spider Man 2", ["SpiderMan2.exe", "SpiderMan.exe"]],
    ["Star Wars", ["StarWars.exe", "StarWarsBattlefront.exe"]],
    ["Doom", ["Doom.exe", "Doom2.exe"]],
    ["Crackdown", ["Crackdown.exe", "CrackdownRecompiled.exe"]],
  ];
  const subtitles = [
    "",
    ": 2.5",
    ": Version 2.0",
    ": XXI",
    ": MMXX",
    ": XL",
    ": V",
    ": I",
    ": Thirty",
    ": Twenty-One",
    ": Twentyfirst",
    ": Zero Hour",
    ": Xbox 360",
    " 21",
    " XXI",
    " I",
    " 1",
    " (2.5)",
    ": Total Destruction",
  ];
  const pool = [
    ["zz-h-lantern-xxi", "Lantern XXI"],
    ["zz-h-lantern-21-echoes", "Lantern 21: Echoes"],
    ["zz-h-lantern-i", "Lantern I"],
    ["zz-h-doom-1", "Doom 1"],
    ["zz-h-spider-man-ii", "Spider Man II"],
    ["zz-h-star-wars-mmxx", "Star Wars: MMXX"],
    ["zz-h-crackdown-40", "Crackdown 40"],
    ["zz-h-doom-xl", "Doom XL"],
  ].map(([id, name]) =>
    listing(id, {
      name,
      original_game_title: name,
      project_url: `https://github.com/fixture-owner/${id}-port`,
    }),
  );
  const camel = (text: string) =>
    text
      .split(/[^A-Za-z0-9]+/u)
      .filter(Boolean)
      .map((word) => word[0]!.toUpperCase() + word.slice(1))
      .join("");
  const initials = (text: string) =>
    text
      .split(/[^A-Za-z0-9]+/u)
      .filter(Boolean)
      .map((word) => (/^[0-9]+$/u.test(word) ? word : word[0]!.toLowerCase()))
      .join("");
  let enrolled = 0;
  let withheld = 0;
  for (let round = 0; round < 500; round++) {
    const [head, programs] = pick(heads);
    const name = `${head}${pick(subtitles)}`;
    const slug = head.toLowerCase().replace(/[^a-z0-9]+/gu, "-");
    const repository = pick([`${slug}-port`, `fixture-${slug}`, `${slug}-recomp`]);
    const product = pick([
      camel(head),
      initials(head),
      camel(name),
      `${camel(head)}-Recomp`,
      `${camel(head)}21`,
      `${camel(head)}XXI`,
      `${initials(head)}1`,
    ]);
    const archive = `${product}-${pick(["1.0", "v2.1"])}-win64.zip`;
    const program = pick(programs);
    const folder = pick(["", `${initials(head)}/`, `${camel(head)}/`, "bin/"]);
    const { decision, gate } = reliefDecision(
      `h${round}`,
      name,
      repository,
      archive,
      [`${folder}${program}`],
      { others: pool.filter(() => random() < 0.3) },
    );
    if (decision.fit) {
      assert.equal(gate, "accepted", `${archive} ${folder}${program} for ${name}: ${gate}`);
      enrolled++;
    } else {
      assert.notEqual(
        gate,
        "accepted",
        `${archive} ${folder}${program} for ${name}: ${decision.reason}`,
      );
      withheld++;
    }
  }
  assert.ok(enrolled > 20 && withheld > 100, `${enrolled} enrolled, ${withheld} withheld`);
});

// ---------------------------------------------------------------------------
// Hand-check queues are reporting only: integers read as versions, and status
// words a release title holds without stating a status.

/** One identity's archive and release title, generated alone. */
function handCheckCase(
  fields: Record<string, unknown>,
  archive: string,
  title: string | null = null,
) {
  const id = String(fields.id);
  const record = listing(id, fields);
  const words = listingWords(record.listing);
  // A title that states a status is recorded with that statement.
  const token = title === null ? null : releaseStatement(title, `fixture-owner/${id}`, words);
  const facts = entry(
    [named(archive, [player(`${String(fields.name)}.exe`)], 11, "windows")],
    {},
    id,
    {
      listing_words: words,
      observed_releases: [
        {
          release_id: 7,
          tag: "v1.0",
          core_prerelease: false,
          prerelease: token !== null,
          published_at: "2026-11-01T00:00:00.000Z",
          packaged: true,
          text: "observed" as const,
          title,
          statement: token === null ? null : { field: "title", token },
        },
      ],
    },
  );
  return generateRegistrations([record], table(facts));
}
const handCheckCorpus: [Record<string, unknown>, string, string | null][] = [
  [{ id: "zz-doom", name: "Doom" }, "doom-2016-win64.zip", null],
  [{ id: "zz-game", name: "Game" }, "game-1942-win64.zip", null],
  [{ id: "zz-game", name: "Game" }, "Game-1000-win64.zip", null],
  [{ id: "zz-game", name: "Game" }, "Game-0042-win64.zip", null],
  [{ id: "zz-game", name: "Game" }, "Game-00042-win64.zip", null],
  [{ id: "zz-game", name: "Game" }, "Game-12345-win64.zip", null],
  [{ id: "zz-game", name: "Game" }, "Game-20261120-win64.zip", null],
  [{ id: "zz-game", name: "Game" }, "Game-01234567-win64.zip", null],
  [{ id: "zz-game", name: "Game" }, "Game-1.0-win64-20261120.zip", null],
  [{ id: "zz-game", name: "Game" }, "Game-1.0-win64-1942.zip", null],
  [{ id: "zz-game", name: "Game" }, "Game-042-win64.zip", null],
  [{ id: "zz-game", name: "Game" }, "Game-v1.0-win64.zip", "Beta release notes"],
  [{ id: "zz-game", name: "Game" }, "Game-v1.0-win64.zip", "Demo day update"],
  [{ id: "zz-game", name: "Game" }, "Game-v1.0-win64.zip", "Fixes for alpha and rc users"],
  [
    { id: "zz-game", name: "Game" },
    "Game-v1.0-win64.zip",
    "Nightly-free preview of the store page",
  ],
  [{ id: "zz-game", name: "Game" }, "Game-v1.0-win64.zip", "Arc and Alphabet 1.0"],
  [{ id: "zz-game", name: "Game" }, "Game-v1.0-win64.zip", "Release 1.0"],
];

void test("the hand-check queues leave every enrollment of the existing fixtures unchanged", async () => {
  // Decisions and enrollments as main decided them before the queues widened.
  const decided = handCheckCorpus.map(([fields, archive, title]) => {
    const generation = handCheckCase(fields, archive, title);
    return [archive, title, reasonOf(generation.decisions[0]!)];
  });
  assert.deepEqual(decided, HAND_CHECK_DECISIONS);
  const { records, result } = await sampleRun();
  const enrollments = [
    ...handCheckCorpus.flatMap(
      ([fields, archive, title]) => handCheckCase(fields, archive, title).enrollments,
    ),
    ...generateRegistrations(records, result.table).enrollments,
  ];
  assert.equal(digestOf(enrollments), HAND_CHECK_ENROLLMENTS_SHA256);
});
void test("integer_as_version queues every four-digit or zero-padded integer read as a version, not date-length runs", () => {
  const queued = (archive: string) =>
    registrationQueues(handCheckCase({ id: "zz-game", name: "Game" }, archive)).integer_as_version;
  // Any value of four digits, and any leading zero, is queued: the year
  // range of the former year queue no longer decides.
  for (const archive of [
    "game-1942-win64.zip",
    "Game-1000-win64.zip",
    "Game-0042-win64.zip",
    "Game-00042-win64.zip",
    "Game-2016-win64.zip",
    "Game-9999-win64.zip",
  ])
    assert.deepEqual(queued(archive), ["zz-game"], archive);
  // Five to seven digits without a leading zero, date-length runs (eight or
  // more digits, also zero-padded) and integers after a version are not.
  for (const archive of [
    "Game-12345-win64.zip",
    "Game-20261120-win64.zip",
    "Game-01234567-win64.zip",
    "Game-1.0-win64-20261120.zip",
    "Game-1.0-win64-1942.zip",
    "Game-v1.0-win64.zip",
  ])
    assert.deepEqual(queued(archive), [], archive);
  // A withheld identity is never queued: the queue lists enrollments only.
  assert.deepEqual(queued("Game-042-win64.zip"), []);
  // The account names the flag for the fit rule's callers too.
  const account = archiveNameAccount(
    "Game-0042-win64.zip",
    listing("zz-game").listing,
    "fixture-owner/zz-game",
  );
  assert.ok("product" in account && account.integerAsVersion);
  assert.ok(
    !(
      "year_as_version" in
      registrationQueues(handCheckCase({ id: "zz-game", name: "Game" }, "Game-1942-win64.zip"))
    ),
  );
});

void test("unstated_status_words lists enrolled titles holding a status word that state no status", () => {
  const queue = (title: string | null) =>
    registrationQueues(handCheckCase({ id: "zz-game", name: "Game" }, "Game-v1.0-win64.zip", title))
      .unstated_status_words;
  assert.deepEqual(queue("Beta release notes"), {
    "zz-game": ["v1.0: title beta"],
  });
  assert.deepEqual(queue("Demo day update"), {
    "zz-game": ["v1.0: title demo"],
  });
  assert.deepEqual(queue("Fixes for alpha and rc users"), {
    "zz-game": ["v1.0: title alpha", "v1.0: title rc"],
  });
  assert.deepEqual(queue("Nightly-free preview of the store page"), {
    "zz-game": ["v1.0: title nightly", "v1.0: title preview"],
  });
  // Whole words only, and no title (or an unobserved one) lists nothing.
  assert.deepEqual(queue("Arc and Alphabet 1.0"), {});
  assert.deepEqual(queue("Release 1.0"), {});
  assert.deepEqual(queue(null), {});
});

const HAND_CHECK_DECISIONS = [
  ["doom-2016-win64.zip", null, "fit"],
  ["game-1942-win64.zip", null, "fit"],
  ["Game-1000-win64.zip", null, "fit"],
  ["Game-0042-win64.zip", null, "fit"],
  ["Game-00042-win64.zip", null, "fit"],
  ["Game-12345-win64.zip", null, "fit"],
  ["Game-20261120-win64.zip", null, "fit"],
  ["Game-01234567-win64.zip", null, "fit"],
  ["Game-1.0-win64-20261120.zip", null, "fit"],
  ["Game-1.0-win64-1942.zip", null, "fit"],
  ["Game-042-win64.zip", null, "archive-name-unaccounted"],
  ["Game-v1.0-win64.zip", "Beta release notes", "fit"],
  ["Game-v1.0-win64.zip", "Demo day update", "fit"],
  ["Game-v1.0-win64.zip", "Fixes for alpha and rc users", "fit"],
  ["Game-v1.0-win64.zip", "Nightly-free preview of the store page", "fit"],
  ["Game-v1.0-win64.zip", "Arc and Alphabet 1.0", "fit"],
  ["Game-v1.0-win64.zip", "Release 1.0", "fit"],
];
// Re-pinned for generator 33: only each enrollment's recorded generator version changed.
const HAND_CHECK_ENROLLMENTS_SHA256 =
  "9a6ced44bc22ff78b2ed365731ef0e18cfbdd6a2283814ecc405857b13e51c6d";

void test("a relieved name joins integer_as_version under the same condition as an equal name", () => {
  const relieved = { id: "zz-lantern", name: "Lantern: Echoes of Night" };
  const equal = { id: "zz-lantern", name: "Lantern" };
  // One identity whose archive holds Lantern.exe, generated alone.
  const generate = (fields: Record<string, unknown>, archive: string) => {
    const record = listing(String(fields.id), fields);
    const facts = entry(
      [named(archive, [player("Lantern.exe")], 11, "windows")],
      {},
      record.listing.id,
      { listing_words: listingWords(record.listing) },
    );
    return generateRegistrations([record], table(facts));
  };
  const queues = (fields: Record<string, unknown>, archive: string) =>
    registrationQueues(generate(fields, archive));
  // A four-digit integer read as a version after a relieved partial name is
  // queued exactly as it is after an equal name.
  for (const fields of [relieved, equal]) {
    const generation = generate(fields, "Lantern-2016-win64.zip");
    assert.equal(generation.enrollments.length, 1, String(fields.name));
    assert.deepEqual(queues(fields, "Lantern-2016-win64.zip").integer_as_version, ["zz-lantern"]);
    for (const archive of ["Lantern-12345-win64.zip", "Lantern-v1.0-win64.zip"])
      assert.deepEqual(queues(fields, archive).integer_as_version, [], archive);
  }
  // The relieved enrollment is relieved, and its account names the flag.
  assert.deepEqual(
    queues(relieved, "Lantern-2016-win64.zip").relieved_enrollments["partial-name"],
    ["zz-lantern"],
  );
  const account = archiveNameAccount(
    "Lantern-2016-win64.zip",
    listing("zz-lantern", relieved).listing,
    "fixture-owner/zz-lantern",
  );
  assert.ok("product" in account && account.integerAsVersion && account.reliefs.length > 0);
});

// ---------------------------------------------------------------------------
// Release text observed end to end (#1422): the observer carries each
// release's title and body window through the handoff into the worker.

/** A provider observation of one repository's releases, each titled and dated. */
function textObservation(
  repository: string,
  releases: {
    id: number;
    tag: string;
    at: string;
    title: string | null;
    body?: string | null;
    prerelease?: boolean;
  }[],
): ProviderObservation {
  const facts = {
    repository: { id: 4242, full_name: repository, archived: false },
    releases: releases.map((release) => ({
      id: release.id,
      tag_name: release.tag,
      draft: false,
      prerelease: release.prerelease ?? false,
      created_at: release.at,
      published_at: release.at,
      text: {
        title: release.title,
        line: release.body ? bodyFirstLine(release.body) : null,
        line_complete: true,
      },
      assets: [
        {
          id: release.id * 10 + 1,
          name: windowsZip,
          size: 100,
          state: "uploaded",
          digest: `sha256:${sha(`${repository}-${release.id}`)}`,
          browser_download_url: `https://github.com/${repository}/releases/download/${release.tag}/${windowsZip}`,
          created_at: release.at,
          updated_at: release.at,
        },
      ],
    })),
  };
  return {
    format: 2,
    config_sha256: sha("config"),
    port_id: "observer",
    started_at: "2026-11-20T00:00:00.000Z",
    completed_at: "2026-11-20T00:00:00.000Z",
    validation_started_at: "2026-11-20T00:00:00.000Z",
    facts_sha256: observationHash(facts),
    facts,
    consumed: { requests: 1, response_bytes: 1, conditional_hits: 0 },
    coverage: {
      kind: "channel-candidate-assets",
      complete_release_headers: true,
      asset_release_ids: releases.map((release) => release.id),
    },
    authority: "provider-observation-only",
  } as unknown as ProviderObservation;
}
/**
 * One listing's projection retained in the observer's checkpoint, read back
 * as the batch job reads it (`accumulatedObservations`). Without `withText`,
 * the projection is one an observer retained before it kept release text.
 */
function throughHandoff(record: AuthoredPort, observation: ProviderObservation, withText = true) {
  const policy = projectListingObservation(record.listing, observation, 12);
  const retained = withText ? policy : withoutListingReleaseText(policy);
  const repository = observation.facts.repository.full_name;
  const handed = accumulatedObservations(
    {
      revision: "upstream-observer-run:1-1@fixture",
      config_sha256: "a".repeat(64),
      checkpoint: observerCheckpoint({
        [observerKeyOf(repository)]: observerProgress(repository, [], {
          repository_id: observation.facts.repository.id,
          last_complete_facts_sha256: observation.facts_sha256,
          last_complete_policies: [retained],
        }),
      }),
      catalog: { ports: [], listings: [record.listing] },
    },
    { format_version: 11, listings: [record.listing] },
  );
  assert.deepEqual(handed.gaps, []);
  return { listings: handed.listings };
}

void test("youkaicountry-yknytt: releases titled as betas are withheld once their text is observed (#1422 1)", async () => {
  // Measured: all four visible releases are titled "vX beta" and none is
  // flagged prerelease; with unobserved text the fit enrolled tag 0.7.3.
  const id = "youkaicountry-yknytt";
  const record = listing(id);
  const repository = `fixture-owner/${id}`;
  const releases = [
    { id: 1, tag: "0.7.0", at: "2026-08-01T00:00:00Z", title: "v0.7.0 beta" },
    { id: 2, tag: "0.7.1", at: "2026-09-01T00:00:00Z", title: "v0.7.1 beta" },
    { id: 3, tag: "0.7.2", at: "2026-10-01T00:00:00Z", title: "v0.7.2 beta" },
    { id: 4, tag: "0.7.3", at: "2026-11-01T00:00:00Z", title: "v0.7.3 beta" },
  ];
  const observation = textObservation(repository, releases);
  // The text travels beside (never inside) the Core-shaped observation.
  const policy = projectListingObservation(record.listing, observation, 12);
  assert.equal(
    (policy.listing_update.upstream_observation.releases as Record<string, unknown>[]).some(
      (release) => "name" in release || "body" in release || "text" in release,
    ),
    false,
  );
  const observed = await derive([record], throughHandoff(record, observation), undefined, {
    classify: anyNameClassifier,
  });
  const facts = observed.table.entries[0]!;
  assert.equal(facts.ineligible?.reason, "no-stable-release");
  // An old handoff without release text defers archive inspection.
  const inspected: string[] = [];
  const unread = await derive([record], throughHandoff(record, observation, false), undefined, {
    classify: anyNameClassifier,
    inspect: inspector({}, inspected),
  });
  assert.deepEqual(inspected, []);
  assert.deepEqual(unread.needs, []);
  assert.deepEqual(unread.table.entries, []);
  assert.equal(unread.report[0]?.outcome, "unknown");
  assert.equal(unread.report[0]?.reason, "release-text-unobserved");
  // Text of other facts is never attached.
  const stale = textObservation(repository, [
    { id: 4, tag: "0.7.3", at: "2026-11-01T00:00:00Z", title: "v0.7.3" },
  ]);
  const report = {
    listings: [
      {
        id,
        upstream_observation: withReleaseText(policy.listing_update.upstream_observation, {
          ...policy.listing_release_text,
          facts_sha256: stale.facts_sha256,
        }),
      },
    ],
  };
  const mismatched = await derive([record], report, undefined, { classify: anyNameClassifier });
  assert.deepEqual(mismatched.needs, []);
  assert.equal(mismatched.report[0]?.reason, "release-text-unobserved");

  // Observed text wakes the same candidate without a version or asset change.
  const stable = textObservation(
    repository,
    releases.map((release) => (release.id === 4 ? { ...release, title: "v0.7.3" } : release)),
  );
  const rechecked = await derive([record], throughHandoff(record, stable), unread.table, {
    classify: anyNameClassifier,
    state: unread.state,
    inspect: inspector({}, inspected),
  });
  assert.equal(inspected.length, 1);
  assert.equal(rechecked.table.entries[0]?.observation.tag, "0.7.3");
  assert.equal(
    rechecked.table.entries[0]?.observed_releases.find((r) => r.release_id === 4)?.text,
    "observed",
  );
});

void test("Faxanadu: newer releases skipped by their words alone are hand-checked, never silently replaced (#1422 3a)", async () => {
  const id = "faxanadu";
  // Named `Game` so the shared fixture archive (`Game-v1.0-windows-x64.zip`)
  // is the listing's own.
  const record = listing(id, { name: "Game" });
  const repository = `fixture-owner/${id}`;
  const observation = textObservation(repository, [
    { id: 1, tag: "v2.3.2", at: "2026-07-01T00:00:00Z", title: "v2.3.2" },
    { id: 2, tag: "v2.3.3", at: "2026-08-01T00:00:00Z", title: "v2.3.3" },
    { id: 3, tag: "v2.4.0", at: "2026-09-01T00:00:00Z", title: "Faxanadu v2.4.0 experimental mod" },
    { id: 4, tag: "v2.5.0", at: "2026-10-01T00:00:00Z", title: "Faxanadu v2.5.0 experimental mod" },
  ]);
  const derived = await derive([record], throughHandoff(record, observation), undefined, {
    classify: anyNameClassifier,
  });
  const facts = derived.table.entries[0]!;
  // The worker still skips the worded releases for its choice ...
  assert.equal(facts.observation.tag, "v2.3.3");
  // ... but the fit withholds the older release and queues the newer ones.
  const decision = decide(record, facts);
  assert.equal(reasonOf(decision), "worded-prerelease-skipped");
  assert.match((decision as { detail: string }).detail, /v2\.4\.0, v2\.5\.0/u);
  assert.match(gateOn(record, facts), /only its own words call a prerelease/u);
  const generation = generateRegistrations([record], table(facts));
  assert.equal(generation.enrollments.length, 0);
  assert.deepEqual(registrationQueues(generation).worded_prerelease_skipped, {
    [id]: ["v2.4.0: title experimental", "v2.5.0: title experimental"],
  });
  // Flagged by the provider, the newer releases are prereleases by Core's
  // own semantics: the older stable release is offered as before.
  const flagged = textObservation(repository, [
    { id: 2, tag: "v2.3.3", at: "2026-08-01T00:00:00Z", title: "v2.3.3" },
    {
      id: 4,
      tag: "v2.5.0",
      at: "2026-10-01T00:00:00Z",
      title: "Faxanadu v2.5.0 experimental mod",
      prerelease: true,
    },
  ]);
  const offered = (
    await derive([record], throughHandoff(record, flagged), undefined, {
      classify: anyNameClassifier,
    })
  ).table.entries[0]!;
  assert.equal(offered.observation.tag, "v2.3.3");
  assert.ok(decide(record, offered).fit);
  assert.equal(gateOn(record, offered), "accepted");
});

void test("a hyphenated status compound states a status: Alpha-Testing 0.0.11 (#1422 3b)", () => {
  const repository = "fixture-owner/game";
  for (const [line, token] of [
    ["Alpha-Testing 0.0.11", "alpha"],
    ["alpha-testing 0.0.11", "alpha"],
    ["Beta-Test 3", "beta"],
    ["Game 1.0 Beta-Test", "beta"],
    ["Beta-Phase 2", "beta"],
    ["Alpha-Stage build 4", "alpha"],
    ["Open Beta-Testing 2", "beta"],
    // Only a hyphen joins the compound, only the closed words, and a
    // negation still states nothing.
    ["Alpha Testing 0.0.11", null],
    ["Alpha - Testing 0.0.11", null],
    ["Alpha-Centauri 1.0", null],
    ["Post-Beta-Testing 2", null],
    ["Out of Beta-Testing 2", null],
  ] as const) {
    assert.equal(releaseStatement(line, repository), token, `fit: ${line}`);
    assert.equal(gateStatement(line, repository), token, `gate: ${line}`);
  }
  // The product's own words still name the product before the first number.
  const words = listingWords({ id: "zz-alpha", name: "Alpha Testing Grounds" });
  assert.equal(releaseStatement("Alpha-Testing Grounds 1.0", repository, words), null);
  assert.equal(gateStatement("Alpha-Testing Grounds 1.0", repository, words), null);
});

void test("the whole judged line of the whole body is read; text not kept is never read as stating nothing (#1422 1, 3)", () => {
  const repository = "fixture-owner/game";
  // Measured: bustagrooverecompiled-releases-brankomatija-bust-a-groove v0.1.0
  // pastes about 47 KB of HTML notes whose first readable line ran 8,276
  // characters, so the old 4,096-character window left it unobserved. The
  // whole body is read now, and HTML block tags end a line.
  const pasted = `<div><p><img src="cover.png" alt="Bust A Groove">${"<span>Recompiled from the original game.</span> ".repeat(200)}</p><p>Beta 2 of the recompilation</p></div>`;
  assert.ok(pasted.length > 8_000);
  assert.deepEqual(observedTextStatement("v0.1.0", pasted, false, repository), {
    observed: true,
    statement: null,
  });
  // The same long paragraph ending in a status is judged whole.
  const paragraph = `${"<b>Many fixes.</b> ".repeat(500)}(beta)`;
  assert.deepEqual(observedTextStatement("v0.1.0", paragraph, false, repository), {
    observed: true,
    statement: { field: "body-first-line", token: "beta" },
  });
  // A tag whose attributes continue on the next line never becomes the line.
  assert.equal(bodyFirstLine('<img src="a"\nalt=x>\nBeta 3'), "Beta 3");
  assert.deepEqual(observedTextStatement("v1", '<img src="a"\nalt=x>\nBeta 3', false, repository), {
    observed: true,
    statement: { field: "body-first-line", token: "beta" },
  });
  // Text a source did not keep (over its budget) states nothing either way.
  assert.deepEqual(lineStatement(null, null, false, repository), { observed: false });
  assert.deepEqual(observedTextStatement("v1.0", "Bug fixes.", true, repository), {
    observed: false,
  });
  // A statement found still stands.
  assert.deepEqual(lineStatement("v1.0 RC1", null, false, repository), {
    observed: true,
    statement: { field: "title", token: "release-candidate" },
  });
});

void test("raw HTML is removed whether or not GitHub renders it; other angle brackets are text (#1422)", () => {
  const repository = "fixture-owner/game";
  // Found in review: a `<` with no rendered element after it reached a later
  // blockquote `>` and erased the status between them.
  for (const body of [
    "Upgrade path: v1 <- Beta 2\n\n> Thanks to all testers",
    "Build 5 (2 < 3, Beta)\n> quote",
    "Requires Windows < 10 Beta 3\n\n- item\n> x",
    "<Beta 3>",
    // Found in review: wrapper tags GitHub strips without rendering them
    // once became the judged line, so a beta read as stating nothing.
    "<html>\r\n<body>\r\nBeta 2 of the game\r\n</body></html>",
    "<html>\n<body>\nBeta 2",
    "<center>\nBeta 2",
    "<font color=red>\nBeta 2",
    "<style>p { color: red }</style>\nBeta 2",
    "<script>var beta;</script>\nBeta 2",
    "<!DOCTYPE html>\nBeta 2",
  ])
    assert.deepEqual(
      observedTextStatement("v1", body, false, repository),
      { observed: true, statement: { field: "body-first-line", token: "beta" } },
      JSON.stringify(body),
    );
  // Measured: brankomatija/BustAGrooveRecompiled-Releases v0.1.0 notes open
  // with this shape; their first readable line is the game's name.
  assert.equal(
    bodyFirstLine(
      '<html>\r\n<body>\r\n<!--StartFragment--><div style="text-align: center;"><h1>Bust A Groove Recompiled</h1><p>Beta 2</p></div>',
    ),
    "Bust A Groove Recompiled",
  );
  // Found in review: a quoted value never spans a blank line (the paragraph
  // ends there), so it cannot hide the lines GitHub shows; the unclosed
  // `<a title="` is then the text shown first.
  for (const [quote, blank] of [
    ['"', "\n\n"],
    ["'", "\n\n"],
    ['"', "\r\n\r\n"],
    ["'", "\r\n \r\n"],
  ] as const) {
    const body = `<a title=${quote}${blank}Beta 2${blank}${quote}>\nStable release`;
    assert.equal(bodyFirstLine(body), `<a title=${quote}`, JSON.stringify(body));
    const line = `v1 <a title=${quote}${blank}Beta 2${blank}${quote}> ok`;
    assert.equal(releaseStatement(line, repository), "beta", `fit: ${JSON.stringify(line)}`);
    assert.equal(gateStatement(line, repository), "beta", `gate: ${JSON.stringify(line)}`);
  }
  // One line break inside a quoted value is still one tag.
  assert.equal(bodyFirstLine('<a title="x\ny">\nBeta 3'), "Beta 3");
  // A quoted attribute value may hold `>`.
  assert.equal(bodyFirstLine('<a title="a>b">\nBeta 5'), "Beta 5");
  // Comments and tags, also across one line break, state nothing.
  assert.equal(
    bodyFirstLine("<!-- Release notes generated using configuration -->\n## Beta 2"),
    "Beta 2",
  );
  assert.equal(bodyFirstLine('<IMG src="a"\r\nalt=x>\nBeta 3'), "Beta 3");
  assert.equal(bodyFirstLine("<b>\n\nBeta 4\n</b>"), "Beta 4");
  // A span reaching a blank line is no tag: it stays text.
  assert.equal(bodyFirstLine("<b\n\nBeta 3\n>"), "<b");
  // An unclosed comment is text.
  assert.equal(bodyFirstLine("<!-- Beta 5"), "<!-- Beta 5");
  for (const [line, token] of [
    ["v1 <- Beta 2", "beta"],
    ["Game <b>1.0</b>", null],
    ["Game 1.0 <sup>beta</sup>", "beta"],
    ["Game <!-- beta --> 1.0", null],
    // `<beta>` is a tag (GitHub removes it), `<Beta 3>` is not.
    ["Game <beta> 1.0", null],
    ["Game <Beta 3> 1.0", "beta"],
    ["Game <center>1.0</center>", null],
    ["Game <b class=x\n>1.0", null],
    // Found in review: `İ` lowercases to two characters, which once shifted
    // the `www.` removal; and names match in ASCII only, never by Unicode
    // case folding (`ſ` is no `s`, the Kelvin sign no `k`).
    ["rc1=<İwww.v1...v2İ", "release-candidate"],
    ["v2 İwww.rc1", null],
    ["v1 <ſpan Beta 2> notes", "beta"],
    ["v1 <\u212Abd Beta 2>", "beta"],
  ] as const) {
    assert.equal(releaseStatement(line, repository), token, `fit: ${line}`);
    assert.equal(gateStatement(line, repository), token, `gate: ${line}`);
  }
});

void test("release text of any length is read in time linear in its length (#1422)", () => {
  // Found in review: several removals were quadratic on untrusted text, so a
  // 125,000-character body (the provider's maximum) took about 37 seconds.
  // Each of these used to take seconds; read linearly, all take milliseconds.
  const started = performance.now();
  for (const unit of ["a", "![", "[", "[a](", "[a][", "<", "<b ", "<!--", "a.", "www.", "a://"]) {
    const body = unit.repeat(Math.ceil(125_000 / unit.length));
    bodyFirstLine(body);
    statementText(body);
  }
  // A generous bound: quadratic reading takes minutes here.
  assert.ok(performance.now() - started < 20_000);
});

void test("an ellipsis never erases a status word; only a range between two versions is removed (#1422)", () => {
  const repository = "fixture-owner/game";
  for (const [line, token] of [
    ["v1.0 Beta...", "beta"],
    ["v1.0 Beta...!", "beta"],
    ["beta...v2", "beta"],
    ["Beta..", "beta"],
    ["Beta....", "beta"],
    ["Beta…", "beta"],
    ["v1.0...v1.1 beta", "beta"],
    // Removed as a compare range: digits on both sides of the dots.
    ["v0.9-beta...v1.0", null],
    ["1.0-beta...1.0", null],
    ["**Full Changelog**: https://github.com/o/r/compare/v0.9-beta...v1.0", null],
    // A status word trailing off into an ellipsis stands wherever it is.
    ["Beta... finally", "beta"],
    ["Beta… finally", "beta"],
    ["Beta.. finally", "beta"],
    ["Beta.... finally", "beta"],
    ["Alpha-Test... soon", "alpha"],
    // Known limit: without the ellipsis the word does not stand.
    ["Beta finally", null],
    ["Beta. finally", null],
    // An en dash joins a compound like a hyphen.
    ["Beta–Test 3", "beta"],
  ] as const) {
    assert.equal(releaseStatement(line, repository), token, `fit: ${line}`);
    assert.equal(gateStatement(line, repository), token, `gate: ${line}`);
  }
});

void test("fit and gate agree on the release-text rules over generated release windows (#1422)", () => {
  const random = seeded(1422);
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const lines = [
    null,
    "v1.1",
    "v1.1 Beta",
    "Game 1.1 experimental mod",
    "Alpha-Testing 0.0.11",
    "Alpha Testing 0.0.11",
    "Out of beta",
    "Beta-Test",
    "Release 1.1",
  ];
  const statementOf = (title: string | null) => {
    const token = title === null ? null : releaseStatement(title, `fixture-owner/${unseen}`);
    return token === null ? null : { field: "title" as const, token };
  };
  let withheld = 0;
  let accepted = 0;
  for (let round = 0; round < 3000; round++) {
    const count = 1 + Math.floor(random() * 4);
    const releases = Array.from({ length: count }, (_, index) => {
      const text = random() < 0.15 ? ("unobserved" as const) : ("observed" as const);
      const title = text === "observed" ? pick(lines) : null;
      const bodied = text === "observed" && title === null && random() < 0.3;
      const statement = bodied
        ? { field: "body-first-line" as const, token: pick(["beta", "alpha"] as const) }
        : statementOf(title);
      const core = random() < 0.2;
      return {
        release_id: 7 + index,
        tag: `v1.${index}`,
        core_prerelease: core,
        prerelease: core || statement !== null,
        published_at: `2026-1${pick(["0", "1"])}-0${1 + Math.floor(random() * 9)}T00:00:00.000Z`,
        packaged: true,
        text,
        title,
        statement,
      };
    });
    const offered = pick(releases);
    // The worker offers only a release its verdict calls stable.
    if (offered.prerelease) continue;
    const facts = entry(
      [named(windowsZip, [player("Game/Game.exe")], 11, "windows")],
      { release_id: offered.release_id, tag: offered.tag, published_at: offered.published_at },
      unseen,
      { observed_releases: releases },
    );
    const fit = decide(listing(), facts).fit;
    const gate = gateOn(listing(), facts) === "accepted";
    assert.equal(
      gate,
      fit,
      JSON.stringify(
        releases.map((r) => [
          r.release_id,
          r.core_prerelease,
          r.text,
          r.title,
          r.statement?.token,
          r.published_at,
        ]),
      ) + ` offered ${offered.release_id}`,
    );
    if (fit) accepted++;
    else withheld++;
  }
  assert.ok(accepted > 100 && withheld > 100, `${accepted} accepted, ${withheld} withheld`);
});

void test("fit and gate read hyphenated status compounds alike over generated lines (#1422 3b)", () => {
  const random = seeded(14223);
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const pieces = [
    "alpha",
    "Beta",
    "testing",
    "Test",
    "tests",
    "phase",
    "stage",
    "centauri",
    "post",
    "out",
    "of",
    "open",
    "0.0.11",
    "2",
    "v1.0",
    "build",
    "release",
    "(",
    ")",
    "_",
    ".",
    "._",
    "-",
    "--",
    "game",
    "...",
    "..",
    "....",
    "\u2026",
    "\u2013",
    "v0.9",
    "1.0",
  ];
  let stated = 0;
  for (let round = 0; round < 20_000; round++) {
    const line = Array.from({ length: 1 + Math.floor(random() * 6) }, () => pick(pieces))
      .map(
        (piece, index) =>
          (index
            ? pick(["-", "-", " ", "", " - ", "_-", "-.", "...", "\u2013", "..", " ..."])
            : "") + piece,
      )
      .join("");
    const words = pick([[], ["alpha", "testing"], ["game"]]);
    const fit = releaseStatement(line, "fixture-owner/game", words);
    assert.equal(gateStatement(line, "fixture-owner/game", words), fit, line);
    if (fit !== null) stated++;
  }
  assert.ok(stated > 1000, `${stated} statements`);
});

void test("an identity withheld after reproduction stays withheld without downloading until its receipt changes (#1422 2)", async () => {
  const downloads: string[] = [];
  const inner = inspector({ [windowsZip]: [player("Game/Game.exe")] });
  const inspect: TestInspector = async (asset, platform) => {
    downloads.push(asset.name);
    return await inner(asset, platform);
  };
  const first = await derive([listing()], observerReport({ [unseen]: {} }), undefined, { inspect });
  assert.equal(first.table.entries[0]!.ineligible, null);
  const { table } = withholdRefused(first.table, [
    { port_id: unseen, reason: "mismatch", detail: "The provider no longer states it." },
  ]);
  const refused = table.entries[0]!;
  assert.equal(refused.ineligible?.reason, "reproduction-refused");
  // The receipt binds what the refusal was derived from without bytes.
  assert.equal(
    refused.ineligible?.receipt,
    refusalReceipt({
      repository_id: first.table.entries[0]!.repository_id,
      release_id: first.table.entries[0]!.observation.release_id,
      assets_sha256: first.table.entries[0]!.observation.assets_sha256,
      observed_releases: first.table.entries[0]!.observed_releases,
    }),
  );
  // The withheld identity offers nothing, and it is queued for a person.
  const generation = generateRegistrations([listing()], table);
  assert.equal(generation.enrollments.length, 0);
  assert.deepEqual(registrationQueues(generation).reasons["reproduction-refused"], [unseen]);
  // Unchanged receipt: reconfirmed, still withheld and queued, no download.
  downloads.length = 0;
  const same = await derive([listing()], observerReport({ [unseen]: {} }), table, {
    inspect,
    now: "2026-11-22T00:00:00.000Z",
  });
  assert.deepEqual(downloads, []);
  assert.equal(same.table.entries[0]!.ineligible?.reason, "reproduction-refused");
  assert.equal(outcome(same, unseen)?.outcome, "unchanged");
  // Changed release text (another observed verdict) changes the receipt: the
  // identity is inspected and derived again, and can land.
  const changed = await derive(
    [listing()],
    observerReport({
      [unseen]: {
        releases: [{ ...defaultRelease(unseen), text: { name: "v1.0", body: "Notes" } }],
      },
    }),
    table,
    { inspect, now: "2026-11-22T00:00:00.000Z" },
  );
  assert.ok(downloads.length > 0);
  assert.equal(changed.table.entries[0]!.ineligible, null);
  // A refusal record without its receipt is refused by the facts check.
  const forged = structuredClone(table);
  delete forged.entries[0]!.ineligible!.receipt;
  forged.entries_sha256 = digestOf(forged.entries);
  assert.throws(() => checkListingFactsTable(forged), /ineligible/u);
});

/** The archive account of a measured identity in fit and gate, which must agree on the product. */
function measuredAccount(
  id: string,
  name: string,
  repository: string,
  archive: string,
  others: readonly Record<string, unknown>[] = [],
) {
  const record = listing(id, {
    name,
    original_game_title: name,
    project_url: `https://github.com/${repository}`,
  });
  const fit = archiveNameAccount(archive, record.listing, repository, others);
  const gate = gateArchiveAccount(archive, record.listing, repository, others);
  assert.equal("product" in fit ? fit.product : null, gate, `fit and gate agree on ${archive}`);
  return fit;
}

void test("generator 29: a carried number compares by value with a roman number of two or more letters, and nothing else gets through, in fit and gate (measured Saboteur II)", () => {
  // Measured: "Saboteur II" in `petarov/saboteur2` was withheld
  // `archive-name-unaccounted` (`saboteur-2`) while "Saboteur 2" enrolled.
  for (const name of ["Saboteur II", "Saboteur 2"]) {
    const fit = measuredAccount(
      "petarov-saboteur2",
      name,
      "petarov/saboteur2",
      "saboteur2-1.1-windows-x86_64.zip",
    );
    assert.ok("product" in fit && fit.product === "saboteur2", `${name}: ${JSON.stringify(fit)}`);
  }
  const literal = "saboteur2";
  assert.equal(dropsLinkedNumber(literal, digitRuns(literal), [nameForm("Saboteur II")]), false);
  // A different value, an absent number, a lone `V` or `X` (a letter's name)
  // still drop the number.
  const drops = (value: string, name: string) =>
    dropsLinkedNumber(value, digitRuns(value), [nameForm(name)]);
  assert.equal(drops("saboteur2", "Saboteur III"), true);
  assert.equal(drops("saboteur3", "Saboteur II"), true);
  assert.equal(drops("saboteur", "Saboteur II"), true);
  assert.equal(drops("megaman10", "Mega Man X"), true);
  assert.equal(drops("saboteur5", "Saboteur V"), true);
  const rows: [string, string, string][] = [
    ["Saboteur III", "saboteur2", "saboteur2-1.1-windows-x86_64.zip"],
    ["Saboteur II", "saboteur3", "saboteur3-1.1-windows-x86_64.zip"],
    ["Saboteur II", "saboteur", "saboteur-1.1-windows-x86_64.zip"],
    ["Saboteur II", "saboteur", "saboteur3-1.1-windows-x86_64.zip"],
    ["Saboteur V", "saboteur5", "saboteur5-1.1-windows-x86_64.zip"],
    ["Mega Man X", "megaman10", "megaman10-1.0-windows.zip"],
    ["Doom II", "doom", "doom-1.0-win64.zip"],
    ["Doom XIX", "doom91", "doom91-1.0-win64.zip"],
  ];
  for (const [name, repository, archive] of rows) {
    const fit = reliefAccount(name, repository, archive);
    assert.ok(!("product" in fit), `${archive} for ${name} must withhold: ${JSON.stringify(fit)}`);
  }
});

void test("generator 29: a title segment is queued as dropped only when every accepted spelling omits it (measured Bustin' Out and Hard Corps: Uprising)", () => {
  const listed = (
    parseCatalogSource(readFileSync(join(catalogRoot, "listings.json"), "utf8")) as {
      listings: Record<string, unknown>[];
    }
  ).listings;
  const measured = (id: string) => {
    const found = listed.find((each) => each.id === id);
    assert.ok(found, id);
    return found;
  };
  const bustin = measured("abilliontokens-bustinout-recomp");
  const hardCorps = measured("hard-corps-uprising-hard-corps-uprising-recompiled");
  assert.equal(
    bustin.name,
    "The Sims: Bustin' Out — Original Xbox (The Sims: Bustin' Out - Static Recompilation)",
  );
  assert.equal(hardCorps.name, "Hard Corps: Uprising (Hard Corps: Uprising Recompiled)");
  // The literal holds the subtitle (also as the program `hard_corps_uprising.exe`): not queued.
  for (const literal of ["simsbustinout", "thesimsbustinout"])
    assert.deepEqual(subtitleDroppedByName(literal, bustin), [], literal);
  for (const path of ["hard_corps_uprising.exe", "HardCorpsUprising.exe"])
    assert.deepEqual(subtitleDroppedByName(literalProgramName(path), hardCorps), [], path);
  // The literal lacks the subtitle: still queued.
  assert.deepEqual(subtitleDroppedByName("hardcorps", hardCorps), ["uprising"]);
  assert.deepEqual(subtitleDroppedByName("sims", bustin), ["bustin out"]);
  const cases: [Record<string, unknown>, string, string, string[]][] = [
    [bustin, "abilliontokens/bustinout-recomp", "SimsBustinOut-windows-x64.zip", []],
    [bustin, "abilliontokens/bustinout-recomp", "TheSimsBustinOut-windows-x64.zip", []],
    [
      hardCorps,
      "saulob/hard-corps-uprising-recompiled",
      "HardCorpsUprising-v0.7.1-windows-x64.zip",
      [],
    ],
    [
      hardCorps,
      "saulob/hard-corps-uprising-recompiled",
      "HardCorps-v0.7.1-windows-x64.zip",
      ["uprising"],
    ],
  ];
  for (const [record, repository, archive, dropped] of cases) {
    const fit = measuredAccount(String(record.id), String(record.name), repository, archive);
    assert.ok("product" in fit, `${archive}: ${JSON.stringify(fit)}`);
    assert.deepEqual(fit.dropped, dropped, archive);
    assert.equal(fit.franchise, dropped.length > 0, archive);
  }
});

void test("random titles with a roman or digit number, and with an annotation repeating the subtitle: fit and gate agree, a carried number enrolls only at the same value, and a subtitle is queued exactly when the literal lacks it (generator 29 property)", () => {
  let seed = 8_569_029;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const vocabulary = ["lantern", "storm", "hunter", "castle", "river", "orbit", "falcon", "ember"];
  const camel = (words: readonly string[]) =>
    words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join("");
  let enrolled = 0;
  let withheld = 0;
  let queued = 0;
  let unqueued = 0;
  for (let round = 0; round < 800; round++) {
    const head = [
      ...new Set(Array.from({ length: 1 + Math.floor(random() * 2) }, () => pick(vocabulary))),
    ];
    // The title's number in roman or digits, the archive's and repository's
    // in digits, the same value or another.
    const value = 2 + Math.floor(random() * 19);
    const roman = romanOf(value);
    const written = pick(["roman", "digits"] as const);
    const titleNumber = written === "roman" ? pick([roman.toUpperCase(), roman]) : String(value);
    const archiveValue = random() < 0.5 ? value : 2 + Math.floor(random() * 19);
    const repository = `${head.join("")}${archiveValue}`;
    const archive = `${camel(head)}${archiveValue}-1.1-windows-x86_64.zip`;
    const title = `${camel(head)} ${titleNumber}`;
    const fit = reliefAccount(title, repository, archive);
    // A lone `V` or `X` is never carried by digits.
    const expected = archiveValue === value && !(written === "roman" && roman.length < 2);
    assert.equal("product" in fit, expected, `${archive} for ${title}: ${JSON.stringify(fit)}`);
    if (expected) enrolled++;
    else withheld++;
    // A subtitle the annotation repeats: queued exactly when the literal lacks it.
    const subtitle = [
      ...new Set(Array.from({ length: 1 + Math.floor(random() * 2) }, () => pick(vocabulary))),
    ].filter((word) => !head.includes(word));
    if (!subtitle.length) continue;
    const name = `${camel(head)}: ${camel(subtitle)} (${camel(head)}: ${camel(subtitle)} ${pick(["Recompiled", "Port", "Static Recompilation"])})`;
    const keeps = random() < 0.5;
    const literal = (keeps ? [...head, ...subtitle] : head).join("");
    assert.deepEqual(
      subtitleDroppedByName(literal, { name }),
      keeps ? [] : [subtitle.join(" ")],
      `${literal} for ${name}`,
    );
    const account = reliefAccount(
      name,
      `zz-p${round}-port`,
      `${camel(keeps ? [...head, ...subtitle] : head)}-1.0-win64.zip`,
    );
    if ("product" in account) {
      assert.deepEqual(account.dropped, keeps ? [] : [subtitle.join(" ")], `${literal} ${name}`);
      if (keeps) unqueued++;
      else queued++;
    }
  }
  assert.ok(enrolled > 100 && withheld > 100, `${enrolled} enrolled, ${withheld} withheld`);
  assert.ok(queued > 50 && unqueued > 50, `${queued} queued, ${unqueued} not queued`);
});

void test("an architecture word in a listing name's annotation names the build, not a sequel, in fit and gate (real petarov-saboteur2 listing)", () => {
  const listed = (
    parseCatalogSource(readFileSync(join(catalogRoot, "listings.json"), "utf8")) as {
      listings: Record<string, unknown>[];
    }
  ).listings;
  const saboteur = listed.find((each) => each.id === "petarov-saboteur2");
  assert.ok(saboteur);
  assert.equal(saboteur.name, "Saboteur II: Avenging Angel (Saboteur II x86-64 recomp)");
  assert.equal(saboteur.project_url, "https://github.com/petarov/saboteur2");
  for (const archive of ["saboteur2-1.1-windows-x86_64.zip", "saboteur2-1.0-win64.zip"]) {
    const fit = archiveNameAccount(archive, saboteur, "petarov/saboteur2", listed);
    const gate = gateArchiveAccount(archive, saboteur, "petarov/saboteur2", listed);
    assert.ok(
      "product" in fit && fit.product === "saboteur2",
      `${archive}: ${JSON.stringify(fit)}`,
    );
    assert.equal(gate, "saboteur2", archive);
  }
  // The two other listed names whose annotation holds an architecture word
  // (assumed archive names, not measured release assets).
  for (const [id, repository, archive, product] of [
    ["petarov-alleycat-exe", "petarov/alleycat.exe", "alleycat-1.0-windows-x86_64.zip", "alleycat"],
    ["touhou-4-lotus-land-story-portable64", "N0zoM1z0/th04", "touhou4-1.0-win64.zip", "touhou4"],
  ] as const) {
    const record = listed.find((each) => each.id === id);
    assert.ok(record, id);
    const fit = archiveNameAccount(archive, record, repository, listed);
    assert.ok("product" in fit && fit.product === product, `${archive}: ${JSON.stringify(fit)}`);
    assert.equal(gateArchiveAccount(archive, record, repository, listed), product, archive);
  }
  // Every spelling of the architecture word, and the digit form of the title.
  for (const name of [
    "Saboteur 2: Avenging Angel (Saboteur 2 x86-64 recomp)",
    "Saboteur II: Avenging Angel (Saboteur II x86_64 recomp)",
    "Saboteur II (Saboteur II x64 recomp)",
    "Saboteur II (Saboteur II Win64 port)",
    "Saboteur II — amd64 recomp",
    "Saboteur II (i386 build)",
    "Saboteur II — Portable 64-bit",
  ]) {
    const fit = reliefAccount(name, "saboteur2", "saboteur2-1.1-windows-x86_64.zip");
    assert.ok("product" in fit && fit.product === "saboteur2", `${name}: ${JSON.stringify(fit)}`);
  }
  // The title proper keeps every number rule, and an annotation number that
  // spells no architecture word is still a number.
  const rows: [string, string, string][] = [
    ["Mario 64 (x86-64 recomp)", "mario", "mario-1.0-win64.zip"],
    ["Lantern 64 (x64 recomp)", "lantern", "lantern-1.0-win64.zip"],
    ["Rush 2049 (x64)", "rush", "rush-1.0-win64.zip"],
    ["Lantern 64 (N64 recomp)", "lantern", "lantern-1.0-win64.zip"],
    [
      "Saboteur II: Avenging Angel (Saboteur II x86-64 recomp)",
      "saboteur",
      "saboteur-1.1-win64.zip",
    ],
    [
      "Saboteur II: Avenging Angel (Saboteur II x86-64 recomp)",
      "saboteur3",
      "saboteur3-1.1-win64.zip",
    ],
    ["Saboteur II (Saboteur II 64 recomp)", "saboteur2", "saboteur2-1.1-win64.zip"],
    ["Saboteur II (Saboteur II x65 recomp)", "saboteur2", "saboteur2-1.1-win64.zip"],
  ];
  for (const [name, repository, archive] of rows) {
    const fit = reliefAccount(name, repository, archive);
    assert.ok(!("product" in fit), `${archive} for ${name} must withhold: ${JSON.stringify(fit)}`);
  }
});

void test("the F3 fallback compares a head number by value, and a subtitle spelled only without the first title segment stays queued", () => {
  const rows: [string, string, string[]][] = [
    ["Saboteur II: Avenging Angel", "saboteur2", ["avenging angel"]],
    ["Saboteur 2: Avenging Angel", "saboteur2", ["avenging angel"]],
    ["Lantern II: Storm", "lantern2", ["storm"]],
    ["Rocky IV: The Return", "rocky4", ["the return"]],
    ["Hunter XVII: Castle", "hunter17", ["castle"]],
    // A different value or no number spells no head: nothing to report.
    ["Lantern II: Storm", "lantern3", []],
    ["Lantern II: Storm", "lantern", []],
    // A lone `V` or `X` is never carried by digits.
    ["Hunter X: Castle", "hunter10", []],
    // The literal holds the subtitle.
    ["Lantern II: Storm", "lantern2storm", []],
    // "The Lantern" spelled with the head omitted is no spelling of the title.
    ["Lantern: The Lantern", "lantern", ["the lantern"]],
    ["Lantern: The Lantern", "lanternthelantern", []],
  ];
  for (const [name, literal, dropped] of rows)
    assert.deepEqual(subtitleDroppedByName(literal, { name }), dropped, `${literal} for ${name}`);
  assert.deepEqual(
    subtitleDroppedByName("saboteur2", {
      name: "Saboteur II: Avenging Angel (Saboteur II x86-64 recomp)",
    }),
    ["avenging angel"],
  );
});

void test("random titles with a roman number of two or more letters and a subtitle: the F3 fallback queues the subtitle exactly when the literal carries the number by value and lacks the subtitle (generator 29 property)", () => {
  let seed = 8_658_029;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const vocabulary = ["lantern", "storm", "hunter", "castle", "river", "orbit", "falcon", "ember"];
  const camel = (words: readonly string[]) =>
    words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
  const values = Array.from({ length: 19 }, (_, at) => at + 2).filter(
    (value) => romanOf(value).length >= 2,
  );
  const outcomes = { queued: 0, kept: 0, other: 0 };
  for (let round = 0; round < 600; round++) {
    const head = [
      ...new Set(Array.from({ length: 1 + Math.floor(random() * 2) }, () => pick(vocabulary))),
    ];
    const subtitle = [
      ...new Set(Array.from({ length: 1 + Math.floor(random() * 2) }, () => pick(vocabulary))),
    ].filter((word) => !head.includes(word));
    if (!subtitle.length) continue;
    const value = pick(values);
    const roman = romanOf(value);
    const name = `${camel(head)} ${pick([roman.toUpperCase(), roman])}: ${camel(subtitle)}`;
    const kind = pick(["queued", "kept", "other"] as const);
    const literalValue = kind === "other" ? pick(values.filter((each) => each !== value)) : value;
    const literal = `${head.join("")}${literalValue}${kind === "kept" ? subtitle.join("") : ""}`;
    assert.deepEqual(
      subtitleDroppedByName(literal, { name }),
      kind === "queued" ? [subtitle.join(" ")] : [],
      `${literal} for ${name}`,
    );
    // The digit form of the same name answers alike.
    assert.deepEqual(
      subtitleDroppedByName(literal, { name: `${camel(head)} ${value}: ${camel(subtitle)}` }),
      kind === "queued" ? [subtitle.join(" ")] : [],
      `${literal} for the digit form of ${name}`,
    );
    outcomes[kind]++;
  }
  assert.ok(
    outcomes.queued > 100 && outcomes.kept > 100 && outcomes.other > 100,
    JSON.stringify(outcomes),
  );
});

void test("random names with an architecture word or a bare number in the annotation: fit and gate agree, and only the title's number decides (generator 29 property)", () => {
  let seed = 8_658_064;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const vocabulary = ["lantern", "storm", "hunter", "castle", "river", "orbit", "falcon", "ember"];
  const architecture = [
    "x86-64",
    "x86_64",
    "x64",
    "Win64",
    "win32",
    "amd64",
    "arm64",
    "i386",
    "64-bit",
  ];
  const counts = { enrolled: 0, withheld: 0 };
  for (let round = 0; round < 500; round++) {
    const word = pick(vocabulary);
    const title = word[0]!.toUpperCase() + word.slice(1);
    const value = 2 + Math.floor(random() * 18);
    const numbered = random() < 0.6;
    const number = numbered ? ` ${pick([String(value), romanOf(value).toUpperCase()])}` : "";
    const lone = numbered && !/^\d/u.test(number.trim()) && romanOf(value).length < 2;
    const architectural = random() < 0.7;
    const tail = architectural ? pick(architecture) : pick(["64", "x65", "86"]);
    const name = `${title}${number} (${title}${number} ${tail} ${pick(["recomp", "port"])})`;
    const carried = numbered ? pick([value, value + 1]) : null;
    const product = `${word}${carried ?? ""}`;
    const fit = reliefAccount(name, product, `${product}-1.0-windows-x86_64.zip`);
    // The annotation's architecture word never decides; a bare annotation
    // number is a number the literal must carry.
    const expected = architectural && (!numbered || (carried === value && !lone));
    if (expected) {
      assert.ok("product" in fit, `${product} for ${name}: ${JSON.stringify(fit)}`);
      counts.enrolled++;
    } else {
      assert.ok(!("product" in fit), `${product} for ${name}: ${JSON.stringify(fit)}`);
      counts.withheld++;
    }
  }
  assert.ok(counts.enrolled > 100 && counts.withheld > 100, JSON.stringify(counts));
});
