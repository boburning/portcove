/** Derived review evidence over the authored catalog; never a second game registry. */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  assembleCatalogRecords,
  checkedAuthoredPort,
  parseCatalogSource,
  projectAuthoredPort,
  readCatalogSource,
  type AuthoredListing,
  type AuthoredPort,
} from "./catalog-authoring.mts";
import { buildUniverse, universeGroups } from "./maintenance-universe.mts";
import { isRecord } from "./runtime-values.mts";
import { listingDirectoryTextMaximum } from "./listing-directory-carrier.mts";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const stableId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function bytes(file: string, maximum = 512 * 1024): Buffer {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum)
    throw new Error(`Expected a bounded regular file: ${file}`);
  return readFileSync(file);
}

function generatedRecords(root: string, file: string, key: string) {
  const path = join(root, file);
  if (!existsSync(path)) return null;
  const content = bytes(path, listingDirectoryTextMaximum);
  const document: unknown = parseCatalogSource(content.toString("utf8"));
  if (!isRecord(document) || !Array.isArray(document[key]))
    throw new Error(`Malformed generated projection: ${file}`);
  const members = document[key] as unknown[];
  if (members.some((member) => !isRecord(member) || typeof member.id !== "string"))
    throw new Error(`Malformed generated projection members: ${file}`);
  const records = new Map(
    members.map((member) => [(member as Record<string, unknown>).id, member]),
  );
  if (records.size !== members.length) throw new Error(`Duplicate generated IDs: ${file}`);
  return { sha256: sha256(content), records };
}

/** Review signals only: absence in authored fields is not effective unavailability,
 * and shared repositories or artwork never authorize a merge or reassignment. */
export function catalogSemanticReview(records: readonly AuthoredPort[]) {
  const byGame = new Map<string, AuthoredListing[]>();
  const byRepositoryGame = new Map<string, AuthoredListing[]>();
  const byArtwork = new Map<string, AuthoredListing[]>();
  const append = (map: Map<string, AuthoredListing[]>, key: string, listing: AuthoredListing) => {
    const members = map.get(key) ?? [];
    members.push(listing);
    map.set(key, members);
  };
  const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
  const portIds = (members: AuthoredListing[]) => sorted(members.map(({ id }) => id));
  const artworkId = (listing: AuthoredListing) =>
    isRecord(listing.artwork) && typeof listing.artwork.game_id === "number"
      ? String(listing.artwork.game_id)
      : null;
  const listings = records.map(({ listing }) => listing);
  for (const listing of listings) {
    const game = listing.original_game?.id;
    if (!game) continue;
    append(byGame, game, listing);
    const repository = listing.project_url
      .match(/^https:\/\/github\.com\/([a-z0-9_.-]+\/[a-z0-9_.-]+)\/?$/iu)?.[1]
      ?.replace(/\.git$/iu, "")
      .toLowerCase();
    if (repository) append(byRepositoryGame, JSON.stringify([game, repository]), listing);
    const art = artworkId(listing);
    if (art !== null) append(byArtwork, art, listing);
  }
  const gameTitles = [...byGame].flatMap(([game_id, members]) => {
    const titles = sorted(
      members.flatMap(({ original_game_title }) =>
        original_game_title ? [original_game_title] : [],
      ),
    );
    return titles.length > 1 ? [{ game_id, titles, port_ids: portIds(members) }] : [];
  });
  const gameArtwork = [...byGame].flatMap(([game_id, members]) => {
    const artwork_ids = sorted(
      members.flatMap((listing) => {
        const art = artworkId(listing);
        return art === null ? [] : [art];
      }),
    );
    return artwork_ids.length > 1 ? [{ game_id, artwork_ids, port_ids: portIds(members) }] : [];
  });
  const sharedArtwork = [...byArtwork].flatMap(([artwork_id, members]) => {
    const game_ids = sorted(members.map(({ original_game }) => original_game!.id));
    return game_ids.length > 1 ? [{ artwork_id, game_ids, port_ids: portIds(members) }] : [];
  });
  const repositoryGame = [...byRepositoryGame].flatMap(([key, members]) => {
    const [game_id, repository] = JSON.parse(key) as [string, string];
    return members.length > 1 ? [{ game_id, repository, port_ids: portIds(members) }] : [];
  });
  return {
    scope:
      "Authored-field review signals only; resolve editions, delivery routes and effective facts before any correction.",
    missing_authored_metadata: {
      original_game: portIds(listings.filter((listing) => !listing.original_game)),
      source_editions: portIds(
        listings.filter(
          (listing) => listing.original_game && !listing.original_game.source_editions.length,
        ),
      ),
      edition_system: portIds(
        listings.filter((listing) =>
          listing.original_game?.source_editions.some((edition) => !edition.system),
        ),
      ),
      platforms: portIds(listings.filter((listing) => !listing.platforms?.length)),
      availability: portIds(listings.filter((listing) => listing.availability === undefined)),
      artwork: portIds(
        listings.filter((listing) => listing.artwork == null && listing.collection_covers == null),
      ),
    },
    same_game_different_titles: gameTitles.sort((a, b) => a.game_id.localeCompare(b.game_id, "en")),
    same_game_repository: repositoryGame.sort(
      (a, b) =>
        a.game_id.localeCompare(b.game_id, "en") || a.repository.localeCompare(b.repository, "en"),
    ),
    same_game_different_artwork: gameArtwork.sort((a, b) =>
      a.game_id.localeCompare(b.game_id, "en"),
    ),
    shared_artwork_different_games: sharedArtwork.sort((a, b) =>
      a.artwork_id.localeCompare(b.artwork_id, "en"),
    ),
  };
}

/** Every port appears once. Candidate labels/targets flag research, never establish identity. */
export function catalogGameIdentityReport(catalogRoot: string) {
  const { records, catalog, directory } = readCatalogSource(catalogRoot);
  const revision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: catalogRoot,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024,
  });
  const universe = buildUniverse({ records, catalogComplete: true });
  const universePorts = new Map(
    universe.filter(({ kind }) => kind === "port").map((entry) => [entry.key, entry]),
  );
  const embedded = generatedRecords(catalogRoot, "catalog.json", "ports");
  const listings = generatedRecords(catalogRoot, "listings.json", "listings");
  const projected = new Map(catalog.ports.map((port) => [port.id, port]));
  const projectedListings = new Map(directory.listings.map((listing) => [listing.id, listing]));
  const sameIdentity = (value: unknown, expected: unknown, operational: boolean) => {
    if (!isRecord(value)) return false;
    const presentation = operational ? value.presentation : value;
    const game = isRecord(presentation) ? presentation.original_game : undefined;
    return isDeepStrictEqual(game ?? null, expected ?? null);
  };
  const ports = records
    .map((record) => {
      const { listing, integration } = record;
      const contracts = catalog.source_catalog.contracts.filter(
        (contract) => contract.port_id === listing.id,
      );
      const profiles = new Set(
        contracts.flatMap((contract) =>
          typeof contract.profile_id === "string" ? [contract.profile_id] : [],
        ),
      );
      const identities = catalog.source_catalog.identities.filter((identity) =>
        profiles.has(identity.id),
      );
      const evidenceIds = new Set<string>();
      const collectEvidence = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(collectEvidence);
        else if (isRecord(value)) {
          if (Array.isArray(value.evidence_ids))
            for (const id of value.evidence_ids) if (typeof id === "string") evidenceIds.add(id);
          Object.values(value).forEach(collectEvidence);
        }
      };
      collectEvidence([contracts, identities]);
      const entry = universePorts.get(`port:${listing.id}`)!;
      const content = bytes(join(catalogRoot, "ports", `${listing.id}.json`));
      if (
        !isDeepStrictEqual(
          checkedAuthoredPort(parseCatalogSource(content.toString("utf8")), listing.id),
          record,
        )
      )
        throw new Error(`Authored source changed while reporting: ${listing.id}`);
      return {
        port_id: listing.id,
        source_sha256: sha256(content),
        name: listing.name,
        displayed_title: listing.original_game_title ?? listing.name,
        project_url: listing.project_url,
        summary: listing.summary,
        operational: projected.has(listing.id),
        original_game: listing.original_game ?? null,
        target_key: entry.target_key,
        lineage_gap: entry.identity_gap,
        grouping_gap: entry.grouping_gap,
        lineage_decisions: record.upstream_lineage?.decisions ?? [],
        authoring_review: record.original_game_review ?? null,
        source_facts: {
          source_profile: integration?.source_profile ?? null,
          bios_source_profile: integration?.bios_source_profile ?? null,
          source_contracts: contracts,
          source_identities: identities,
          evidence: catalog.source_catalog.evidence.filter((evidence) =>
            evidenceIds.has(evidence.id),
          ),
          setup: listing.manual_setup ?? null,
        },
        projection: {
          authored_definition:
            !projected.has(listing.id) ||
            sameIdentity(projected.get(listing.id), listing.original_game, true),
          authored_listing: sameIdentity(
            projectedListings.get(listing.id),
            listing.original_game,
            false,
          ),
          embedded_definition: !projected.has(listing.id)
            ? "not-applicable"
            : !embedded
              ? "unavailable"
              : sameIdentity(embedded.records.get(listing.id), listing.original_game, true),
          generated_listing: !listings
            ? "unavailable"
            : sameIdentity(listings.records.get(listing.id), listing.original_game, false),
        },
      };
    })
    .sort((a, b) => a.port_id.localeCompare(b.port_id, "en"));
  const membersById = new Map(ports.map((port) => [port.port_id, port]));
  const targets = [...universeGroups(universe)].flatMap(([key, values]) => {
    const members = values
      .filter(({ kind }) => kind === "port")
      .map(({ key: portKey }) => membersById.get(portKey.slice(5))!);
    if (!key.startsWith("target:") || members.length < 2) return [];
    const gameIds = [
      ...new Set(
        members.flatMap((member) => (member.original_game ? [member.original_game.id] : [])),
      ),
    ].sort();
    return [
      {
        key,
        port_ids: members.map(({ port_id }) => port_id).sort(),
        original_game_ids: gameIds,
        disposition:
          gameIds.length > 1
            ? "review-conflicting-scope"
            : members.some(({ original_game }) => !original_game)
              ? gameIds.length
                ? "review-partial-mapping"
                : "review-unmapped"
              : "mapped",
      },
    ];
  });
  const titleFamilies = new Map<string, string[]>();
  for (const port of ports) {
    const title = port.displayed_title
      .normalize("NFKC")
      .toLocaleLowerCase("en")
      .replace(/\s+/gu, " ")
      .trim();
    titleFamilies.set(title, [...(titleFamilies.get(title) ?? []), port.port_id]);
  }
  const mapped = ports.filter(({ original_game }) => original_game);
  const gameIds = new Set(mapped.map(({ original_game }) => original_game!.id));
  const sourceBinding = ports.map(({ port_id, source_sha256 }) => [port_id, source_sha256]);
  return {
    format_version: 1,
    source_revision:
      revision.status === 0 && /^[a-f0-9]{40}$/u.test(revision.stdout.trim())
        ? revision.stdout.trim()
        : null,
    scope:
      "Complete authored port catalog; title/lineage candidates require semantic review. Grouping grants no source compatibility or installation authority.",
    authored_catalog_sha256: sha256(
      JSON.stringify([
        sha256(bytes(join(catalogRoot, "catalog-shared.json"), 8 * 1024 * 1024)),
        sourceBinding,
      ]),
    ),
    generated: {
      embedded_sha256: embedded?.sha256 ?? null,
      listings_sha256: listings?.sha256 ?? null,
    },
    coverage: {
      port_records: ports.length,
      operational_definitions: catalog.ports.length,
      mapped_ports: mapped.length,
      original_game_ids: gameIds.size,
      unresolved_project_entries: ports.length - mapped.length,
      production_groups: gameIds.size + ports.length - mapped.length,
      multi_port_lineage_targets: targets.length,
      multi_port_lineage_members: targets.reduce(
        (count, target) => count + target.port_ids.length,
        0,
      ),
      projection_identity_gaps: ports.filter(({ projection }) =>
        Object.values(projection).some((value) => value === false || value === "unavailable"),
      ).length,
    },
    semantic_review: catalogSemanticReview(records),
    lineage_families: targets,
    title_candidates: [...titleFamilies]
      .filter(([, members]) => members.length > 1)
      .map(([title, port_ids]) => ({ title, port_ids })),
    ports,
  };
}

export interface ReviewedGameAssignment {
  port_id: string;
  /** SHA-256 of the complete authored input file bytes, including unrelated fields. */
  expected_sha256: string;
  original_game?: NonNullable<AuthoredListing["original_game"]>;
  original_game_review?: AuthoredPort["original_game_review"];
  original_game_title?: string;
}

export interface ReviewedGameAssignments {
  format_version: 1;
  assignments: ReviewedGameAssignment[];
}

/** A batch is fully checked before the first source mutation. Dry-run is the default. */
export function applyReviewedGameAssignments(
  catalogRoot: string,
  input: ReviewedGameAssignments,
  write = false,
) {
  if (
    input.format_version !== 1 ||
    !Array.isArray(input.assignments) ||
    !input.assignments.length ||
    input.assignments.length > 10000
  )
    throw new Error("Expected a finite format-1 reviewed assignment batch.");
  const { records } = readCatalogSource(catalogRoot);
  const byId = new Map(records.map((record) => [record.listing.id, record]));
  const seen = new Set<string>();
  const plans = input.assignments.map((assignment) => {
    if (
      !isRecord(assignment) ||
      Object.keys(assignment).some(
        (key) =>
          ![
            "port_id",
            "expected_sha256",
            "original_game",
            "original_game_title",
            "original_game_review",
          ].includes(key),
      ) ||
      (!assignment.original_game && !assignment.original_game_review) ||
      !stableId.test(assignment.port_id) ||
      !/^[a-f0-9]{64}$/u.test(assignment.expected_sha256) ||
      seen.has(assignment.port_id)
    )
      throw new Error(
        "Assignments require unique stable port IDs and exact input SHA-256 bindings.",
      );
    seen.add(assignment.port_id);
    const existing = byId.get(assignment.port_id);
    if (!existing) throw new Error(`Unknown authored port: ${assignment.port_id}`);
    const path = join(catalogRoot, "ports", `${assignment.port_id}.json`);
    const before = bytes(path);
    if (sha256(before) !== assignment.expected_sha256)
      throw new Error(`Stale authored input: ${assignment.port_id}`);
    if (
      existing.listing.original_game &&
      assignment.original_game !== undefined &&
      existing.listing.original_game.id !== assignment.original_game.id
    )
      throw new Error(
        `Changing an existing game ID requires the Core preference/media compatibility route: ${assignment.port_id}`,
      );
    const next = structuredClone(existing);
    if (assignment.original_game !== undefined)
      next.listing.original_game = assignment.original_game;
    if (assignment.original_game_review !== undefined)
      next.original_game_review = assignment.original_game_review;
    if (assignment.original_game_title !== undefined)
      next.listing.original_game_title = assignment.original_game_title;
    checkedAuthoredPort(next, assignment.port_id);
    projectAuthoredPort(next);
    return {
      path,
      port_id: assignment.port_id,
      before,
      after: Buffer.from(`${JSON.stringify(next, null, 2)}\n`),
      record: next,
    };
  });
  const replacements = new Map(plans.map((plan) => [plan.port_id, plan.record]));
  const shared = parseCatalogSource(
    bytes(join(catalogRoot, "catalog-shared.json"), 8 * 1024 * 1024).toString("utf8"),
  );
  assembleCatalogRecords(
    shared,
    records.map((record) => replacements.get(record.listing.id) ?? record),
  );
  const result = plans.map(({ port_id, before, after }) => ({
    port_id,
    before_sha256: sha256(before),
    after_sha256: sha256(after),
  }));
  if (!write) return { written: false, records: result };

  // Stage on the catalog filesystem. Retain a recovery receipt if a filesystem error
  // interrupts publication; concurrent source edits must never be overwritten by recovery.
  const staging = join(catalogRoot, `.game-identity-${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  const changed: typeof plans = [];
  try {
    for (const plan of plans) {
      writeFileSync(join(staging, `${plan.port_id}.before.json`), plan.before, { flag: "wx" });
      writeFileSync(join(staging, `${plan.port_id}.after.json`), plan.after, { flag: "wx" });
    }
    writeFileSync(join(staging, "receipt.json"), `${JSON.stringify(result, null, 2)}\n`, {
      flag: "wx",
    });
    for (const plan of plans)
      if (!bytes(plan.path).equals(plan.before))
        throw new Error(`Concurrent authored edit: ${plan.port_id}`);
    for (const plan of plans) {
      if (!bytes(plan.path).equals(plan.before))
        throw new Error(`Concurrent authored edit: ${plan.port_id}`);
      renameSync(join(staging, `${plan.port_id}.after.json`), plan.path);
      changed.push(plan);
    }
    rmSync(staging, { recursive: true });
    return { written: true, records: result };
  } catch (error) {
    if (!changed.length) rmSync(staging, { recursive: true });
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${changed.length ? `; partial batch retained for reconciliation: ${staging}` : ""}`,
    );
  }
}

function main(args: string[]) {
  const action = args.shift();
  if (action === "--help" || !action) {
    process.stdout.write(
      "Usage: node scripts/catalog-game-identity.mts report [--catalog-root <path>] [--output <path>]\n       node scripts/catalog-game-identity.mts apply --assignments <path> [--catalog-root <path>] [--write]\nReport is derived review evidence. Apply defaults to a validated dry-run; regenerate with the standard catalog generator after an explicit write.\n",
    );
    return;
  }
  const values = new Map<string, string>();
  let write = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--write" && !write) {
      write = true;
      continue;
    }
    if (
      !["--catalog-root", "--output", "--assignments"].includes(flag) ||
      values.has(flag) ||
      !args[index + 1] ||
      args[index + 1]!.startsWith("--")
    )
      throw new Error(`Unexpected argument: ${flag}`);
    values.set(flag, args[++index]!);
  }
  const root = resolve(
    values.get("--catalog-root") ??
      fileURLToPath(new URL("../crates/portcove-core/catalog", import.meta.url)),
  );
  let result: unknown;
  if (action === "report" && !write && !values.has("--assignments"))
    result = catalogGameIdentityReport(root);
  else if (action === "apply" && values.has("--assignments")) {
    const assignments = parseCatalogSource(
      bytes(resolve(values.get("--assignments")!), 8 * 1024 * 1024).toString("utf8"),
    ) as ReviewedGameAssignments;
    result = applyReviewedGameAssignments(root, assignments, write);
  } else throw new Error("Choose report, or apply --assignments <path> [--write].");
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (values.has("--output")) {
    const destination = resolve(values.get("--output")!);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, output, { flag: "wx" });
  } else process.stdout.write(output);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
