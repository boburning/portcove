import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { realpath, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { By, Key, until } from "selenium-webdriver";
import type { WebDriver } from "selenium-webdriver";
import type { ScenarioContext, ScenarioInvoke } from "./desktop-scenario-context.mts";
import { fixtureSuccess, requiredFixtureValue as required } from "./desktop-scenario-state.mts";
import { transportValue, transportValues } from "./transport-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
import { observeCollectionLayoutReady, observeVisibleTarget } from "./browser-readiness.mts";
import { captureSettledVisual } from "../../../scripts/native-readiness.mts";
import { prepareCaptureTarget, requireCompleteCaptureTarget } from "../test/capture-target.ts";
import {
  catalogResultPortIds,
  clearCatalogFilters,
  clickVisible,
  selectPrimaryNavigation,
} from "./desktop-review-controls.mts";
import { gameProjectLabel, gameTitle } from "../src/port-identity.ts";
import { INTERFACE_SIZES } from "../src/interface-size-controller.ts";
import { errorMessage, isRecord } from "../../../scripts/runtime-values.mts";
import { decodeDiscoverPortIds } from "./desktop-review-presentation.mts";
import type { FileIdentity } from "../../../scripts/development-evidence.mts";
/** Minimal read-only catalog fields consumed by this oracle, not a full IPC DTO. */
export interface GameFirstObservedDefinition {
  id: string;
  name: string;
  presentation?: {
    original_game?: { id: string } | null;
    original_game_title?: string | null;
  } | null;
  source_profile?: string | null;
  release?: unknown;
}
export interface GameFirstObservedListing {
  id: string;
  name: string;
  original_game?: { id: string } | null;
  original_game_title?: string | null;
}
export interface GameFirstCatalogObservation {
  catalog?: { ports: GameFirstObservedDefinition[] } | null;
  listing_catalog?: { listings: GameFirstObservedListing[] } | null;
}

export const gameFirstPresentationFamilies = [
  "banjo-kazooie",
  "banjo-tooie",
  "paper-mario",
  "the-legend-of-zelda-majoras-mask",
  "perfect-dark",
  "the-legend-of-zelda-the-wind-waker",
  "kula-world",
] as const;

export interface GameFirstRelationships {
  audited_revision: string;
  audited_port_ids: string[];
  families: Record<string, string[]>;
  intentionally_separate: Record<string, string>;
  project_entries: Record<string, string>;
  selected_definition_entries: Record<
    string,
    {
      game_id: string;
      game_title: string;
      family_port_ids: string[];
    }
  >;
}

/** Independent reviewed expectations; never substitute these rows for the loaded catalog. */
export async function readGameFirstRelationships() {
  const bytes = await readFile(
    new URL("../../../scripts/fixtures/game-first-catalog-relationships.json", import.meta.url),
  );
  const value: unknown = JSON.parse(bytes.toString());
  assert.ok(
    isRecord(value) &&
      typeof value.audited_revision === "string" &&
      Array.isArray(value.audited_port_ids) &&
      isRecord(value.families) &&
      isRecord(value.intentionally_separate) &&
      isRecord(value.project_entries) &&
      isRecord(value.selected_definition_entries),
  );
  const expected = value as unknown as GameFirstRelationships;
  assert.equal(expected.audited_port_ids.length, 1649);
  assert.equal(Object.keys(expected.families).length, 257);
  assert.equal(Object.keys(expected.project_entries).length, 38);
  assert.equal(Object.keys(expected.intentionally_separate).length, 17);
  return { expected, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Read the generated documents from the same source checkout as the packaged candidate. */
export async function readGameFirstSourcePopulation(inputs?: readonly FileIdentity[]) {
  const base = new URL("../../../crates/portcove-core/catalog/", import.meta.url);
  async function read(file: string, key: string) {
    const inputPath = fileURLToPath(new URL(file, base));
    const bytes = await readFile(inputPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (inputs) {
      const captured = inputs.find((input) => input.path === inputPath);
      assert.equal(captured?.sha256, sha256, `Source population input changed: ${file}`);
    }
    const value: unknown = JSON.parse(bytes.toString());
    assert.ok(isRecord(value) && Array.isArray(value[key]), `Missing ${key} in ${file}`);
    const rows: unknown[] = value[key];
    const games = new Map<string, string | null>();
    for (const row of rows) {
      assert.ok(isRecord(row) && typeof row.id === "string" && !games.has(row.id));
      const owner = key === "ports" ? row.presentation : row;
      const identity = isRecord(owner) ? owner.original_game : undefined;
      if (identity == null) {
        games.set(row.id, null);
      } else {
        assert.ok(isRecord(identity) && typeof identity.id === "string", `${row.id}: invalid game`);
        games.set(row.id, identity.id);
      }
    }
    return { games, sha256 };
  }
  const [definitions, listings] = await Promise.all([
    read("catalog.json", "ports"),
    read("listings.json", "listings"),
  ]);
  return { definitions, listings };
}

/** Observe shipping definition/listing precedence without granting any operational capability. */
export function inspectGameFirstRelationships(
  workspace: GameFirstCatalogObservation,
  expected: GameFirstRelationships,
  catalogProvenance?: { origin: string },
  source?: Awaited<ReturnType<typeof readGameFirstSourcePopulation>>,
) {
  assert.ok(
    workspace.catalog && workspace.listing_catalog,
    "Ordinary workspace must carry both production documents",
  );
  // This readback oracle independently applies the documented precedence; UI
  // assertions below observe the shipping renderer rather than this projection.
  type Entry = GameFirstObservedDefinition & {
    definition?: GameFirstObservedDefinition;
    listing?: GameFirstObservedListing;
  };
  const definitions = new Map(workspace.catalog.ports.map((port) => [port.id, port]));
  const listings = new Map(workspace.listing_catalog.listings.map((port) => [port.id, port]));
  assert.equal(
    definitions.size,
    workspace.catalog.ports.length,
    "Duplicate operational identities",
  );
  assert.equal(
    listings.size,
    workspace.listing_catalog.listings.length,
    "Duplicate accepted listing identities",
  );
  const entries: Entry[] = [...new Set([...definitions.keys(), ...listings.keys()])].map((id) => {
    const definition = definitions.get(id);
    const listing = listings.get(id);
    const identity = definition?.presentation?.original_game ?? listing?.original_game;
    return {
      ...(definition ?? { id, name: required(listing).name }),
      presentation: {
        ...(definition?.presentation ?? {}),
        ...(identity ? { original_game: identity } : {}),
        ...(!definition && listing?.original_game_title
          ? { original_game_title: listing.original_game_title }
          : {}),
      },
      ...(definition ? { definition } : {}),
      ...(listing ? { listing } : {}),
    };
  });
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const byGroup = new Map<string, { id: string; ports: Entry[] }>();
  for (const entry of entries) {
    const id = entry.presentation?.original_game
      ? `game:${entry.presentation.original_game.id}`
      : `port:${entry.id}`;
    const group = byGroup.get(id) ?? { id, ports: [] };
    group.ports.push(entry);
    byGroup.set(id, group);
  }
  const groups = [...byGroup.values()];
  const sorted = (ids: readonly string[]) => [...ids].sort((a, b) => a.localeCompare(b));
  const selectedEntries = Object.entries(expected.selected_definition_entries).filter(
    ([id]) => byId.has(id) && !source?.definitions.games.has(id) && !source?.listings.games.has(id),
  );
  const families = { ...expected.families };
  for (const [id, reviewed] of selectedEntries) {
    assert.equal(
      catalogProvenance?.origin,
      "definition_selected",
      `${id}: selected definition provenance required`,
    );
    const entry = required(byId.get(id));
    assert.ok(entry.definition, `${id}: reviewed extra must be an actual operational definition`);
    assert.equal(
      entry.presentation?.original_game?.id,
      reviewed.game_id,
      `${id}: reviewed selected game identity`,
    );
    assert.equal(
      entry.presentation?.original_game_title,
      reviewed.game_title,
      `${id}: reviewed selected game title`,
    );
    assert.ok(reviewed.family_port_ids.includes(id));
    families[reviewed.game_id] = reviewed.family_port_ids;
  }
  const auditedIds = [...expected.audited_port_ids, ...selectedEntries.map(([id]) => id)];
  const audited = new Set(auditedIds);
  const selectedIds = selectedEntries.map(([id]) => id);
  if (source) {
    assert.deepEqual(
      sorted([...definitions.keys()]),
      sorted([...new Set([...source.definitions.games.keys(), ...selectedIds])]),
      "Complete source revision definition population",
    );
    assert.deepEqual(
      sorted([...listings.keys()]),
      sorted([...source.listings.games.keys()]),
      "Complete source revision listing population",
    );
    const definitionGames = new Map(source.definitions.games);
    for (const [id, reviewed] of selectedEntries) definitionGames.set(id, reviewed.game_id);
    for (const [id, row] of definitions) {
      assert.equal(
        row.presentation?.original_game?.id ?? null,
        definitionGames.get(id),
        `${id}: source definition game`,
      );
    }
    for (const [id, row] of listings) {
      assert.equal(
        row.original_game?.id ?? null,
        source.listings.games.get(id),
        `${id}: source listing game`,
      );
    }
  }
  assert.deepEqual(
    sorted([...byId.keys()].filter((id) => !source || audited.has(id))),
    sorted(auditedIds),
    "Complete reviewed loaded catalog universe",
  );
  const provenance = (source ? sorted([...byId.keys()]) : auditedIds).map((id) => {
    const entry = required(byId.get(id));
    const definition = definitions.get(id);
    const listing = listings.get(id);
    assert.ok(definition || listing, `Audited ${id} must be loaded, not synthesized`);
    assert.equal(entry.definition, definition);
    assert.equal(entry.listing, listing);
    assert.deepEqual(
      entry.presentation?.original_game ?? null,
      definition?.presentation?.original_game ?? listing?.original_game ?? null,
      `${id}: descriptive original-game precedence`,
    );
    if (definition) {
      assert.equal(
        entry.source_profile,
        definition.source_profile,
        `${id}: exact operational source authority`,
      );
      assert.equal(entry.release, definition.release, `${id}: exact operational release authority`);
    } else {
      assert.equal(
        entry.source_profile,
        undefined,
        `${id}: listing cannot manufacture managed setup`,
      );
      assert.equal(entry.release, undefined, `${id}: listing cannot manufacture managed release`);
    }
    return {
      port_id: id,
      definition: Boolean(definition),
      listing: Boolean(listing),
      original_game_provenance: definition?.presentation?.original_game
        ? "definition"
        : listing?.original_game
          ? "listing"
          : "project-fallback",
    };
  });
  const auditedFamily = (id: string) =>
    sorted(
      required(byGroup.get(`game:${id}`))
        .ports.map((port) => port.id)
        .filter((port) => audited.has(port)),
    );
  for (const [id, ports] of Object.entries(families))
    assert.deepEqual(auditedFamily(id), sorted(ports), `Complete reviewed family ${id}`);
  for (const [id, game] of Object.entries(expected.intentionally_separate)) {
    // A reviewed adaptation stays separate from the other original, while its
    // own faithful implementations may still form a reviewed complete family.
    assert.equal(
      required(byId.get(id)).presentation?.original_game?.id,
      game,
      `Reviewed separation identity ${id}`,
    );
    const members = expected.families[game] ?? [id];
    assert.ok(members.includes(id), `Separated ${id} must belong to its reviewed family`);
    assert.deepEqual(auditedFamily(game), sorted(members), `Reviewed separation ${id}`);
  }
  for (const id of Object.keys(expected.project_entries))
    assert.deepEqual(
      required(byGroup.get(`port:${id}`)).ports.map((port) => port.id),
      [id],
      `Unresolved/composite project fallback ${id}`,
    );
  return {
    entries,
    groups,
    provenance,
    audited_records: audited.size,
    reviewed_families: Object.keys(families).length,
  };
}

/** The dispatcher owns normal application startup, isolated output and positive-exit restart. */
export interface GameFirstContext extends ScenarioContext {
  invoke: ScenarioInvoke;
  restartApplication: (name: string) => Promise<WebDriver>;
  sourcePopulationInputs?: readonly FileIdentity[] | undefined;
}

const scenarioId = "native-game-first-choice-and-restart";
const gameId = "the-legend-of-zelda-majoras-mask";
const pair = ["2ship2harkinian", "zelda64-recomp"] as const;
const groupSelector = `[data-detail-return-group="game:${gameId}"]`;

/** Record definition and listing delivery independently; neither status substitutes for the other. */
export async function readGameFirstCatalogProvenance(invoke: ScenarioInvoke) {
  const catalog_status = transportValue(
    "catalog_status",
    fixtureSuccess(await invoke("get_catalog_status")),
  );
  const listing_delivery_status = transportValue(
    "listing_delivery_status",
    fixtureSuccess(await invoke("get_listing_delivery_status")),
  );
  return { catalog_status, listing_delivery_status };
}

/** Bind live catalog selection to a full snapshot in one unchanged library scope. */
export async function readGameFirstCatalogObservation(
  invoke: ScenarioInvoke,
  readbacks: unknown[],
) {
  const initial = transportValue(
    "desktop_bootstrap_status",
    fixtureSuccess(await invoke("get_bootstrap_status")),
  );
  assert.equal(initial.ready, true);
  const before = await readGameFirstCatalogProvenance(invoke);
  const observation = await readGameFirstObservation(invoke, readbacks);
  const after = await readGameFirstCatalogProvenance(invoke);
  const bootstrap = transportValue(
    "desktop_bootstrap_status",
    fixtureSuccess(await invoke("get_bootstrap_status")),
  );
  const bracket = {
    phase: "catalog-provenance-bracket",
    coherent: false,
    initial: { generation: initial.generation, library_root: initial.library_root },
    snapshot: {
      generation: observation.bootstrap.generation,
      library_root: observation.bootstrap.library_root,
      catalog_digest: observation.workspace.catalog_digest ?? null,
    },
    final: { generation: bootstrap.generation, library_root: bootstrap.library_root },
    before,
    after,
  };
  readbacks.push(bracket);
  assert.equal(bootstrap.ready, true);
  assert.equal(observation.bootstrap.generation, initial.generation);
  assert.equal(observation.bootstrap.library_root, initial.library_root);
  assert.equal(bootstrap.generation, initial.generation);
  assert.equal(bootstrap.library_root, initial.library_root);
  assert.deepEqual(
    after.catalog_status.provenance,
    before.catalog_status.provenance,
    "Definition selection changed during live catalog readback",
  );
  assert.deepEqual(
    after.listing_delivery_status,
    before.listing_delivery_status,
    "Listing selection changed during live catalog readback",
  );
  const catalog_digest = observation.workspace.catalog_digest;
  assert.ok(
    typeof catalog_digest === "string" && catalog_digest.length > 0,
    "Live catalog readback requires the workspace catalog digest",
  );
  bracket.coherent = true;
  return { ...observation, ...after, catalog_digest };
}

export function assertEmbeddedGameFirstCatalog(
  observation: Awaited<ReturnType<typeof readGameFirstCatalogObservation>>,
) {
  assert.equal(
    observation.catalog_status.provenance.origin,
    "embedded",
    "Expected embedded definitions",
  );
  assert.equal(observation.listing_delivery_status.selected, false, "Expected embedded listings");
}

/** Repeat only explicitly stale reads or independently confirmed transitions; never replay an action. */
export async function readGameFirstObservation(invoke: ScenarioInvoke, readbacks: unknown[]) {
  let initial: { generation: number; library_root: string | null } | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const bootstrap = transportValue(
      "desktop_bootstrap_status",
      fixtureSuccess(await invoke("get_bootstrap_status")),
    );
    assert.equal(bootstrap.ready, true);
    initial ??= { generation: bootstrap.generation, library_root: bootstrap.library_root };
    assert.equal(
      bootstrap.generation,
      initial.generation,
      "Read retries must preserve the original library generation",
    );
    assert.equal(
      bootstrap.library_root,
      initial.library_root,
      "Read retries must preserve the original library root",
    );
    const generation = initial.generation;
    const organization = transportValue(
      "desktop_library_organization",
      fixtureSuccess(await invoke("get_library_organization", { generation })),
    );
    const snapshot = await invoke("get_workspace_snapshot", { generation });
    const failure =
      isRecord(snapshot) && snapshot.ok === false
        ? transportValue("desktop_desktop_error", snapshot.error)
        : undefined;
    const refused =
      failure?.code === "conflict" &&
      failure.details.workspace_snapshot_stale === "true" &&
      failure.details.retryable === "true";
    if (refused)
      readbacks.push({
        phase: "workspace-snapshot-refusal",
        attempt,
        generation,
        code: "conflict",
        workspace_snapshot_stale: "true",
        retryable: "true",
      });
    const workspace = refused
      ? undefined
      : transportValue("desktop_workspace_snapshot", fixtureSuccess(snapshot));
    // Complete every observation, including a refused snapshot, and bracket
    // generation-less get_statuses with the original library identity.
    const statuses = transportValues("status", fixtureSuccess(await invoke("get_statuses")));
    const after = transportValue(
      "desktop_bootstrap_status",
      fixtureSuccess(await invoke("get_bootstrap_status")),
    );
    assert.equal(after.ready, true);
    assert.equal(
      after.generation,
      initial.generation,
      "Readbacks must belong to one library generation",
    );
    assert.equal(after.library_root, initial.library_root);
    if (!workspace) continue;
    const selected = (rows: typeof statuses) =>
      pair.map((id) => required(rows.find((row) => row.port_id === id)));
    if (!isDeepStrictEqual(selected(statuses), selected(workspace.statuses))) {
      // A player action may commit AFTER Core returned a consistent snapshot.
      // Confirm that transition independently; a stable disagreement remains fatal.
      const confirmation = await invoke("get_workspace_snapshot", { generation });
      const confirmedBootstrap = transportValue(
        "desktop_bootstrap_status",
        fixtureSuccess(await invoke("get_bootstrap_status")),
      );
      assert.equal(confirmedBootstrap.ready, true);
      assert.equal(confirmedBootstrap.generation, initial.generation);
      assert.equal(confirmedBootstrap.library_root, initial.library_root);
      const confirmationFailure =
        isRecord(confirmation) && confirmation.ok === false
          ? transportValue("desktop_desktop_error", confirmation.error)
          : undefined;
      if (
        confirmationFailure?.code === "conflict" &&
        confirmationFailure.details.workspace_snapshot_stale === "true" &&
        confirmationFailure.details.retryable === "true"
      ) {
        readbacks.push({
          phase: "workspace-snapshot-refusal",
          attempt,
          generation,
          code: "conflict",
          workspace_snapshot_stale: "true",
          retryable: "true",
        });
        continue;
      }
      const confirmed = transportValue("desktop_workspace_snapshot", fixtureSuccess(confirmation));
      const changed = pair.filter(
        (id) =>
          !isDeepStrictEqual(
            required(workspace.statuses.find((row) => row.port_id === id)),
            required(confirmed.statuses.find((row) => row.port_id === id)),
          ),
      );
      if (changed.length) {
        readbacks.push({
          phase: "workspace-observation-transition",
          attempt,
          generation,
          port_ids: changed,
        });
        continue;
      }
    }
    for (const id of pair)
      assert.deepEqual(
        required(statuses.find((row) => row.port_id === id)),
        required(workspace.statuses.find((row) => row.port_id === id)),
        `Ordinary status and workspace disagree for ${id}`,
      );
    return { bootstrap, organization, workspace, statuses };
  }
  throw new Error("Workspace observation did not settle after 3 full read observations");
}

/** Serialized read-only observation; optional metadata failure does not block choice. */
export function observeGameFirstCaptureReadiness(size: number) {
  const comparisonPending =
    document.querySelectorAll(".comparison-context-heading button:disabled").length > 0;
  return {
    ready:
      document.fonts.status === "loaded" &&
      document.body.textContent?.includes(`Interface size ${size}%.`) === true &&
      !comparisonPending,
    comparison_pending: comparisonPending,
    alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(
      (element) => element.textContent?.trim() ?? "",
    ),
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    documentWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  };
}

export async function captureGameFirstTarget<Semantic extends { ready: boolean }>({
  browser,
  output,
  name,
  scenario,
  target,
  readiness,
}: {
  browser: WebDriver;
  output: string;
  name: string;
  scenario: string;
  target: string;
  readiness: () => Promise<Semantic>;
}) {
  let observation: Awaited<ReturnType<typeof observeVisibleTarget>> | null = null;
  try {
    await prepareCaptureTarget({
      target,
      label: name,
      ready: () => executeBrowserScript(browser, observeCollectionLayoutReady),
      scroll: async () => {
        // A column change can remount the row while readiness is pending.
        // Resolve its exact current identity only after that owner has settled.
        const elements = await browser.findElements(By.css(target));
        assert.equal(elements.length, 1, "Capture requires one current target before reveal");
        return executeBrowserScript(
          browser,
          (selected) =>
            selected.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }),
          required(elements[0]),
        );
      },
      observe: async () => {
        observation = await executeBrowserScript(
          browser,
          observeVisibleTarget,
          target,
          "visual" as const,
        );
        return observation;
      },
    });
  } catch (error) {
    // Preflight can reject before captureSettledVisual retains its observations.
    // Keep the original failure and the actual clipping/zoom geometry before
    // the scenario restores appearance; this record never accepts a capture.
    await writeFile(
      path.join(output, `${name}-capture-failure.json`),
      JSON.stringify(
        {
          format_version: 1,
          outcome: "failed",
          phase: "target-preflight",
          scenario,
          target,
          message: errorMessage(error),
          observation,
          acceptance: false,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    ).catch(() => {});
    throw error;
  }
  return captureSettledVisual({
    browser,
    output,
    name,
    scenario,
    target,
    observeTarget: async () => {
      const observed = await executeBrowserScript(
        browser,
        observeVisibleTarget,
        target,
        "visual" as const,
      );
      requireCompleteCaptureTarget(observed, target);
      return observed;
    },
    readiness,
  });
}

async function inspectGameFirstBaseline(
  output: string,
  before: Awaited<ReturnType<typeof readGameFirstObservation>>,
) {
  const relative = path.relative(
    await realpath(output),
    await realpath(required(before.bootstrap.library_root)),
  );
  assert.ok(
    relative &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    "Game-first scenario requires the harness-owned library beneath this output scope",
  );
  const ports = pair.map((id) =>
    required(required(before.workspace.catalog).ports.find((port) => port.id === id)),
  );
  const [ship, recompiled] = ports.map((port) => required(port.presentation?.original_game));
  assert.equal(required(ship).id, gameId);
  assert.equal(required(recompiled).id, gameId);
  assert.deepEqual(
    required(ship).source_editions.map((edition) => edition.id),
    ["majoras-mask-n64-usa-1-0", "majoras-mask-gamecube-usa"],
  );
  assert.deepEqual(
    required(recompiled).source_editions.map((edition) => edition.id),
    ["majoras-mask-n64-usa-1-0"],
  );
  const picori = required(
    required(before.workspace.catalog).ports.find((port) => port.id === "project-picori"),
  );
  assert.equal(picori.presentation?.original_game?.id, "the-legend-of-zelda-the-minish-cap");
  const gzdoom = required(
    before.workspace.listing_catalog?.listings.find((port) => port.id === "zdoom-gzdoom"),
  );
  assert.equal(
    gzdoom.original_game ?? null,
    null,
    "Unresolved engine identity must remain ungrouped",
  );
  return { ports, picori, gzdoom };
}

/** Normal controls and read-only IPC only; no qualification catalog or installation fixture. */
export async function gameFirstScenarios({
  browser,
  invoke,
  scenario,
  output,
  artifacts,
  restartApplication,
  sourcePopulationInputs,
}: GameFirstContext) {
  await scenario(scenarioId, async () => {
    const originalWindow = await browser.manage().window().getRect();
    const originalSize = await executeBrowserScript(browser, () => {
      const status = Array.from(document.querySelectorAll('[role="status"]'))
        .map((element) => element.textContent ?? "")
        .find((text) => /^Interface size \d+%\./u.test(text));
      if (!status) throw new Error("Applied native interface size is unavailable");
      return Number(status.match(/^Interface size (\d+)%\./u)?.[1]);
    });
    assert.ok(INTERFACE_SIZES.some((size) => size === originalSize));
    const captures: unknown[] = [];
    const readbacks: unknown[] = [];
    const read = () => readGameFirstObservation(invoke, readbacks);
    const retainInitialFailure = async (error: unknown): Promise<never> => {
      const report = path.join(output, "game-first-choice-result.json");
      try {
        await writeFile(
          report,
          `${JSON.stringify({ scenario: scenarioId, outcome: "failed", captures, readbacks, failure: errorMessage(error) }, null, 2)}\n`,
          { flag: "wx" },
        );
        artifacts.push(report);
      } catch (retentionError) {
        console.error(
          `Could not retain initial game-first readback: ${errorMessage(retentionError)}`,
        );
      }
      throw error;
    };
    const [relationships, source] = await Promise.all([
      readGameFirstRelationships(),
      readGameFirstSourcePopulation(sourcePopulationInputs),
    ]).catch(retainInitialFailure);
    const readCatalog = async (phase: string) => {
      const observation = await readGameFirstCatalogObservation(invoke, readbacks);
      const retained: Record<string, unknown> = {
        phase,
        expected_baseline_sha256: relationships.sha256,
        audited_revision: relationships.expected.audited_revision,
        source_definitions_sha256: source.definitions.sha256,
        source_listings_sha256: source.listings.sha256,
        generation: observation.bootstrap.generation,
        library_root: observation.bootstrap.library_root,
        catalog_digest: observation.catalog_digest,
        catalog_status: observation.catalog_status,
        listing_delivery_status: observation.listing_delivery_status,
      };
      readbacks.push(retained);
      assertEmbeddedGameFirstCatalog(observation);
      const production = inspectGameFirstRelationships(
        observation.workspace,
        relationships.expected,
        observation.catalog_status.provenance,
        source,
      );
      Object.assign(retained, {
        families: production.reviewed_families,
        audited_records: production.audited_records,
        loaded_records: production.provenance.length,
        provenance: production.provenance,
      });
      return { ...observation, production };
    };
    const before = await readCatalog("production-catalog-relationships").catch(
      retainInitialFailure,
    );
    const production = before.production;
    const members = (id: string) =>
      required(production.groups.find((group) => group.id === `game:${id}`)).ports.map(
        (port) => port.id,
      );
    const family = members(gameId);
    readbacks.push({
      phase: "before",
      generation: before.bootstrap.generation,
      organization: before.organization,
      statuses: before.statuses.filter((row) => pair.some((id) => id === row.port_id)),
    });
    const { ports, picori, gzdoom } = await inspectGameFirstBaseline(output, before);
    const click = async (selector: string) => {
      const element = await browser.wait(until.elementLocated(By.css(selector)), 15_000);
      await clickVisible(browser, element);
    };
    const search = async (query: string) => {
      await selectPrimaryNavigation(browser, "Discover");
      await clearCatalogFilters(browser);
      const field = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
      await field.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, query);
    };
    const expectSearch = async (
      query: string,
      expected: readonly string[],
      excluded: readonly string[],
    ) => {
      await search(query);
      await browser.wait(
        async () => {
          const matches = await catalogResultPortIds(browser);
          return (
            expected.every((id) => matches.includes(id)) &&
            excluded.every((id) => !matches.includes(id))
          );
        },
        15_000,
        `Search ${query} must reach the authored projects and exclude unrelated identities`,
      );
    };
    const detail = async (id: string) => {
      const workspace = await browser.wait(
        until.elementLocated(By.css(`[data-detail-workspace][data-detail-port-id="${id}"]`)),
        15_000,
      );
      await browser.wait(until.elementIsVisible(workspace), 5_000);
      assert.equal(
        (await browser.findElements(By.css('[role="dialog"]'))).length,
        0,
        "Comparison must close before detail continuation",
      );
    };
    const back = async () => {
      await click(".detail-back");
      await browser.wait(
        async () => (await browser.findElements(By.css("[data-detail-workspace]"))).length === 0,
        15_000,
      );
    };
    const openComparison = async () => {
      const group = await browser.wait(
        until.elementLocated(By.css(`.discover-game${groupSelector}`)),
        15_000,
      );
      await clickVisible(
        browser,
        await group.findElement(By.xpath('.//button[starts-with(normalize-space(.),"Compare")]')),
      );
      const dialog = await browser.wait(
        until.elementLocated(By.css(".port-comparison-dialog")),
        15_000,
      );
      await browser.wait(until.elementIsVisible(dialog), 5_000);
      for (const port of ports)
        assert.ok((await dialog.getText()).includes(gameProjectLabel(port) || port.name));
      return dialog;
    };
    const capture = async (name: string, selector: string, size: number) => {
      await browser.wait(until.elementLocated(By.css(selector)), 15_000);
      const captured = await captureGameFirstTarget({
        browser,
        output,
        name: `game-first-${name}`,
        scenario: scenarioId,
        target: selector,
        readiness: () => executeBrowserScript(browser, observeGameFirstCaptureReadiness, size),
      });
      artifacts.push(captured.image.path, captured.receipt);
      captures.push({
        name,
        window: await browser.manage().window().getRect(),
        image: captured.image.path,
      });
    };
    const shortcut = (key: string) =>
      browser.actions().keyDown(Key.CONTROL).sendKeys(key).keyUp(Key.CONTROL).perform();
    const resetSize = async () => {
      await shortcut("0");
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            () => document.body.textContent?.includes("Interface size 100%.") === true,
          ),
        10_000,
      );
    };
    let failed = true;
    let failure: unknown;
    let cleanupFailure: unknown;
    const retainResultAndRestoreAppearance = async () => {
      // The scenario wrapper retains the original failure. Evidence/appearance
      // cleanup must not replace it with a secondary persistence or UI error.
      try {
        const report = path.join(output, "game-first-choice-result.json");
        await writeFile(
          report,
          `${JSON.stringify(
            {
              scenario: scenarioId,
              outcome: failed ? "failed" : "interactions-complete",
              captures,
              readbacks,
              failure: failure === undefined ? null : errorMessage(failure),
              identity: {
                game_id: gameId,
                port_ids: pair,
                independent_source_editions: ports.map((port) => ({
                  port_id: port.id,
                  editions: port.presentation?.original_game?.source_editions,
                })),
                picori_game_id: picori.presentation?.original_game?.id,
                gzdoom_game_id: null,
              },
              evidence:
                "Normal application controls and ordinary Core IPC in an owned isolated library; screenshots require separate image inspection.",
              held: [
                "Library membership and installed-alternative actions: requires separately admitted normal installations; no installations are seeded here.",
                "Original-file compatibility, preparation, real upstream runtime launch, gameplay, save compatibility and removal: unexecuted; lawful originals and complete upstream runtime inputs were not supplied to this module.",
              ],
            },
            null,
            2,
          )}\n`,
          { flag: "wx" },
        );
        artifacts.push(report);
        await resetSize();
        for (const size of INTERFACE_SIZES) {
          if (size === 100 || size > originalSize) continue;
          await shortcut("+");
          await browser.wait(
            () =>
              executeBrowserScript(
                browser,
                (size) => document.body.textContent?.includes(`Interface size ${size}%.`) === true,
                size,
              ),
            10_000,
          );
        }
        await browser.manage().window().setRect(originalWindow);
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
        if (failed)
          console.error(
            `${scenarioId}: secondary evidence/appearance cleanup failed; original scenario failure retained`,
            cleanupError,
          );
      }
    };
    const verifyProductionPresentation = async () => {
      const originalLayout = await executeBrowserScript(browser, () =>
        document
          .querySelector('[aria-label="Collection view"] button[aria-pressed="true"]')
          ?.getAttribute("aria-label"),
      );
      assert.ok(originalLayout === "Covers" || originalLayout === "Compact rows");
      try {
        for (const layout of ["Covers", "Compact rows"]) {
          await click(`[aria-label="Collection view"] button[aria-label="${layout}"]`);
          await browser.wait(
            until.elementLocated(By.css(`.discover-${layout === "Covers" ? "covers" : "rows"}`)),
            5000,
          );
          assert.equal(
            await (
              await browser.findElement(
                By.css(`[aria-label="Collection view"] button[aria-label="${layout}"]`),
              )
            ).getAttribute("aria-pressed"),
            "true",
          );
          for (const id of gameFirstPresentationFamilies) {
            const familyGroup = required(
              production.groups.find((group) => group.id === `game:${id}`),
            );
            const expected = familyGroup.ports.map((port) => port.id);
            const representative = [...familyGroup.ports].sort(
              (a, b) =>
                Number(Boolean(b.presentation?.original_game_title?.trim())) -
                  Number(Boolean(a.presentation?.original_game_title?.trim())) ||
                (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
            )[0]!;
            const title =
              representative.presentation?.original_game_title?.trim() || representative.name;
            await expectSearch(title, expected, []);
            const selector = `.discover-game[data-detail-return-group="game:${id}"]`;
            assert.equal(
              (await browser.findElements(By.css(selector))).length,
              1,
              `${layout}: one ${id} card`,
            );
            const card = await browser.findElement(By.css(selector));
            assert.deepEqual(
              decodeDiscoverPortIds(await card.getAttribute("data-discover-port-ids")).sort(
                (a, b) => String(a).localeCompare(String(b)),
              ),
              [...expected].sort((a, b) => String(a).localeCompare(String(b))),
            );
            assert.ok(
              (await card.getText()).includes(title),
              `${layout}: stable original-game title`,
            );
            await clickVisible(
              browser,
              await card.findElement(
                By.xpath('.//button[starts-with(normalize-space(.),"Compare")]'),
              ),
            );
            const dialog = await browser.wait(
              until.elementLocated(By.css(".port-comparison-dialog")),
              15_000,
            );
            await browser.wait(until.elementIsVisible(dialog), 5_000);
            const presented = await executeBrowserScript(browser, () =>
              Array.from(
                document.querySelectorAll(".port-comparison-dialog [data-discover-port-id]"),
              ).map((element) => element.getAttribute("data-discover-port-id")),
            );
            assert.deepEqual(
              presented.sort((a, b) => String(a).localeCompare(String(b))),
              [...expected].sort((a, b) => String(a).localeCompare(String(b))),
              `${layout}: every exact ${id} implementation stays reachable`,
            );
            await browser.actions().sendKeys(Key.ESCAPE).perform();
            await browser.wait(
              async () => (await browser.findElements(By.css('[role="dialog"]'))).length === 0,
              5000,
            );
            await click('[data-detail-origin^="command-trigger:"]');
            const field = await browser.wait(
              until.elementLocated(By.css('.command-palette input[aria-label="Search commands"]')),
              5000,
            );
            await browser.wait(until.elementIsVisible(field), 5000);
            assert.equal(await field.getAttribute("value"), "");
            await field.sendKeys(title);
            const command = await browser.wait(
              until.elementLocated(By.css(`[id="command-game:${id}"]`)),
              5000,
            );
            assert.ok((await command.getText()).includes(`${expected.length} options`));
            assert.equal(
              (await browser.findElements(By.css(`[id="command-game:${id}"]`))).length,
              1,
            );
            await field.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, expected[0]!);
            await browser.wait(
              until.elementLocated(By.css(`[id="command-option:${expected[0]}"]`)),
              5000,
            );
            await browser.actions().sendKeys(Key.ESCAPE).perform();
            await browser.wait(
              async () => (await browser.findElements(By.css(".command-palette"))).length === 0,
              5000,
            );
            readbacks.push({
              phase: "production-family-presentation",
              layout,
              game_id: id,
              port_ids: expected,
              command_game_and_exact_option: true,
            });
          }
          for (const alias of ["Roll Away", "KulaQuest"]) {
            const regional =
              "roll-away-psx-pc-recomp-bitsandbreakpoints-roll-away-kula-world-kulaquest";
            await expectSearch(alias, [regional], []);
            const card = await browser.findElement(
              By.css('.discover-game[data-detail-return-group="game:kula-world"]'),
            );
            assert.deepEqual(
              decodeDiscoverPortIds(await card.getAttribute("data-discover-port-ids")).sort(
                (a, b) => String(a).localeCompare(String(b)),
              ),
              members("kula-world").sort((a, b) => a.localeCompare(b)),
            );
            await click('[data-detail-origin^="command-trigger:"]');
            const commandSearch = await browser.wait(
              until.elementLocated(By.css('.command-palette input[aria-label="Search commands"]')),
              5000,
            );
            await browser.wait(until.elementIsVisible(commandSearch), 5000);
            await commandSearch.sendKeys(alias);
            await browser.wait(
              until.elementLocated(By.css('[id="command-game:kula-world"]')),
              5000,
            );
            await browser.actions().sendKeys(Key.ESCAPE).perform();
            await browser.wait(
              async () => (await browser.findElements(By.css(".command-palette"))).length === 0,
              5000,
            );
            readbacks.push({
              phase: "regional-source-alias",
              command_alias: true,
              layout,
              query: alias,
              port_id: regional,
              game_id: "kula-world",
            });
          }
          for (const id of [
            "ajncsystem-shadowofthecolossus-pc",
            "brawmario-infinite-mario-64-ever",
          ]) {
            const separateGame = required(relationships.expected.intentionally_separate[id]);
            await expectSearch(id, [id], []);
            const card = await browser.findElement(
              By.css(`.discover-game[data-detail-return-group="game:${separateGame}"]`),
            );
            assert.deepEqual(
              decodeDiscoverPortIds(await card.getAttribute("data-discover-port-ids")).sort(
                (a, b) => String(a).localeCompare(String(b)),
              ),
              members(separateGame).sort((a, b) => a.localeCompare(b)),
            );
            readbacks.push({
              phase: "reviewed-separation-presentation",
              layout,
              port_id: id,
              game_id: separateGame,
            });
          }
        }
      } finally {
        await click(`[aria-label="Collection view"] button[aria-label="${originalLayout}"]`);
      }
    };
    try {
      await resetSize();
      await browser.manage().window().setRect({ width: 1280, height: 900 });
      await selectPrimaryNavigation(browser, "Discover");
      await verifyProductionPresentation();
      const searchGame = () =>
        expectSearch(gameTitle(required(ports[0])), family, [picori.id, gzdoom.id]);
      await searchGame();
      assert.equal(
        (await browser.findElements(By.css(`.discover-game${groupSelector}`))).length,
        1,
      );
      const group = await browser.findElement(By.css(`.discover-game${groupSelector}`));
      const matchingIds = decodeDiscoverPortIds(
        await group.getAttribute("data-discover-matching-port-ids"),
      );
      assert.deepEqual(
        matchingIds.sort((a, b) => a.localeCompare(b)),
        family.toSorted((a, b) => a.localeCompare(b)),
        "Only explicit game identities may form this group; other search matches remain independent",
      );
      for (const port of ports)
        await expectSearch(
          port.name,
          [port.id],
          ports.filter((other) => other.id !== port.id).map((other) => other.id),
        );
      await expectSearch(picori.name, [picori.id], pair);
      assert.equal(
        (
          await browser.findElements(
            By.css('[data-detail-return-group="game:the-legend-of-zelda-the-minish-cap"]'),
          )
        ).length,
        1,
      );
      await (
        await browser.findElement(
          By.css(
            '.discover-game[data-detail-return-group="game:the-legend-of-zelda-the-minish-cap"] .discover-game-identity',
          ),
        )
      ).sendKeys(Key.ENTER);
      await detail(picori.id);
      await back();
      await expectSearch(gzdoom.id, [gzdoom.id], pair);
      assert.equal(
        (await browser.findElements(By.css('[data-detail-return-group="port:zdoom-gzdoom"]')))
          .length,
        1,
      );
      await (
        await browser.findElement(
          By.css(
            '.discover-game[data-detail-return-group="port:zdoom-gzdoom"] .discover-game-identity',
          ),
        )
      ).sendKeys(Key.ENTER);
      await detail(gzdoom.id);
      await back();
      await readCatalog("after-browsing-catalog-relationships");
      await searchGame();
      await openComparison();
      const chosen = required(
        ports.find((port) => port.id !== before.organization.preferred_port_by_game?.[gameId]),
      );
      const alternative = required(ports.find((port) => port.id !== chosen.id));
      const use = await browser.findElement(
        By.xpath(
          `//*[@role="dialog"]//button[normalize-space(.)="Choose ${gameProjectLabel(chosen) || chosen.name}"]`,
        ),
      );
      await capture(
        "comparison-ordinary",
        `[role="dialog"] button[data-discover-port-id="${chosen.id}"]`,
        100,
      );
      await use.sendKeys(Key.ENTER);
      await detail(chosen.id);
      await browser.wait(
        async () => (await read()).organization.preferred_port_by_game?.[gameId] === chosen.id,
        15_000,
      );
      const saved = await read();
      readbacks.push({
        phase: "chosen",
        generation: saved.bootstrap.generation,
        organization: saved.organization,
        statuses: saved.statuses.filter((row) => pair.some((id) => id === row.port_id)),
      });
      await clickVisible(
        browser,
        await browser.findElement(
          By.xpath(
            `//summary[normalize-space(.)="Other options for this game (${family.length})"]`,
          ),
        ),
      );
      for (const port of ports) {
        const alternativeControl = await browser.findElement(
          By.css(`[data-detail-origin="detail:alternative:${port.id}"]`),
        );
        const facts = await alternativeControl.findElement(By.xpath("..")).getText();
        for (const edition of required(port.presentation?.original_game).source_editions)
          assert.ok(
            facts.includes(edition.title),
            `${port.id} must present its own source editions`,
          );
        if (port.id === "zelda64-recomp")
          assert.ok(
            !facts.includes("GameCube USA re-release ROM"),
            "Shared game identity must not broaden Zelda64's admitted source edition",
          );
      }
      await click(`[data-detail-origin="detail:alternative:${alternative.id}"]`);
      await detail(alternative.id);
      assert.equal(
        (await read()).organization.preferred_port_by_game?.[gameId],
        chosen.id,
        "Viewing an alternative must not silently replace the deliberate choice",
      );
      await back();
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            (id) => document.activeElement?.getAttribute("data-detail-game-id") === id,
            chosen.id,
          ),
        10_000,
        "Back from an alternative must restore the chosen game identity focus",
      );
      await browser.wait(until.elementLocated(By.css(`.discover-game${groupSelector}`)), 15_000);
      await browser.wait(
        async () =>
          (await browser
            .findElement(By.css(`.discover-game${groupSelector}`))
            .getAttribute("data-discover-primary-port-id")) === chosen.id,
        15_000,
      );
      await capture(
        "choice-ordinary",
        `.discover-game${groupSelector} .discover-game-identity`,
        100,
      );
      await browser.manage().window().setRect({ width: 960, height: 640 });
      await capture("choice-narrow", `.discover-game${groupSelector} .discover-game-identity`, 100);
      for (const size of INTERFACE_SIZES.filter((size) => size > 100 && size <= 200)) {
        await shortcut("+");
        await browser.wait(
          () =>
            executeBrowserScript(
              browser,
              (size) => document.body.textContent?.includes(`Interface size ${size}%.`) === true,
              size,
            ),
          10_000,
        );
      }
      await capture("choice-enlarged-200", `.discover-game${groupSelector} .collection-title`, 200);
      await capture(
        "choice-action-enlarged-200",
        `.discover-game${groupSelector} .discover-game-actions .discover-card-action`,
        200,
      );
      await resetSize();
      browser = await restartApplication(scenarioId);
      await browser.manage().window().setRect({ width: 1280, height: 900 });
      const restarted = await readCatalog("restarted-catalog-relationships");
      readbacks.push({
        phase: "restarted",
        generation: restarted.bootstrap.generation,
        organization: restarted.organization,
        statuses: restarted.statuses.filter((row) => pair.some((id) => id === row.port_id)),
      });
      assert.deepEqual(
        restarted.organization,
        saved.organization,
        "Core organization survives actual host restart",
      );
      assert.deepEqual(
        restarted.workspace.sources,
        before.workspace.sources,
        "Choosing a project creates no source registrations",
      );
      for (const id of pair)
        assert.deepEqual(
          restarted.statuses.find((row) => row.port_id === id),
          before.statuses.find((row) => row.port_id === id),
          "Choice preserves independent installation/readiness state",
        );
      await searchGame();
      await browser.wait(
        async () =>
          (await browser
            .findElement(By.css(`.discover-game${groupSelector}`))
            .getAttribute("data-discover-primary-port-id")) === chosen.id,
        15_000,
      );
      await capture(
        "choice-restarted",
        `.discover-game${groupSelector} .discover-game-identity`,
        100,
      );
      await (
        await browser.findElement(By.css(`.discover-game${groupSelector} .discover-game-identity`))
      ).sendKeys(Key.ENTER);
      await detail(chosen.id);
      await back();
      failed = false;
    } catch (error) {
      failure = error;
      try {
        await readCatalog("failed-catalog-relationships");
      } catch (readbackError) {
        readbacks.push({ phase: "failed-catalog-readback", failure: errorMessage(readbackError) });
      }
      throw error;
    } finally {
      await retainResultAndRestoreAppearance();
    }
    if (cleanupFailure !== undefined) throw new Error(errorMessage(cleanupFailure));
  });
}
