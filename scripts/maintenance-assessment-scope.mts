/**
 * Scoped dependencies of one Core port assessment (#1422).
 *
 * `portcove --json port-capabilities PORT` on a fresh library is a function of:
 *
 * 1. the mechanism: every repository file compiled into the CLI binary (its
 *    Cargo dep-info), the Cargo manifests, lockfile, toolchain and vendored
 *    sources, and any other file the build recorded, by content;
 * 2. the shared data: every part of the embedded `catalog.json` and
 *    `listings.json` that is not partitioned to one port below, and every other
 *    embedded data file (as part of the mechanism);
 * 3. the subject's partition: its `ports[]` entries, its `listings[]` entries and
 *    the `source_catalog` records it reaches (a record naming its port ID, or a
 *    record whose `id` is any string in the partition, to a fixpoint);
 * 4. the policy: CLI API schema, projection, host platform, compiled features
 *    and isolation scope;
 * 5. time: Core compares numeric `observed_at` values with its clock.
 *
 * Whole-catalog validation is the only cross-record read. It either succeeds
 * for the whole embedded document or fails every port, and a selective run
 * requires the same binary's catalog inspection to have succeeded first.
 *
 * Unknown structure is shared, never omitted: an undeclared top-level field or
 * `source_catalog` array is shared data, a record no port reaches is shared
 * data, and a binary without usable dep-info keys every subject by the whole
 * Core tree (the earlier key), so any change reassesses everything.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Bump when the dependency model below changes. */
export const assessmentScopeVersion = 1;

export const catalogPath = "crates/portcove-core/catalog/catalog.json";
export const listingsPath = "crates/portcove-core/catalog/listings.json";

/** Embedded documents partitioned per port. Every other embedded file is mechanism. */
export const partitionedDocuments = [catalogPath, listingsPath] as const;

/**
 * The declared shape of the partitioned documents. Keys outside these lists
 * are shared; the tests require this declaration to match the current data so
 * a new field is reviewed rather than silently shared.
 */
export const declaredCatalogKeys = ["schema_version", "source_catalog", "ports"] as const;
export const declaredSourceCatalogArrays = [
  "evidence",
  "identities",
  "contracts",
  "validators",
  "qualification",
] as const;
export const declaredListingsKeys = ["format_version", "listings"] as const;

/**
 * Every build environment variable compiled Core and CLI sources read with
 * `env!` or `option_env!`, other than Cargo's own `CARGO_*` values (derived
 * from the manifests, which are keyed). Cargo's binary dep-info does not
 * record their values, so each is declared with its readers and why its value
 * cannot change a fresh-library capability report. A test fails when a source
 * reads an undeclared variable or a declared one from another file. The
 * declaration itself is part of the mechanism key.
 */
export const buildEnvironment: Readonly<
  Record<string, { readers: readonly string[]; reason: string }>
> = {
  PORTCOVE_SOURCE_REVISION: {
    readers: ["crates/portcove-core/src/target_inspection.rs"],
    reason:
      "labels the producer in target inspection; the collector checks it against the checkout separately",
  },
  PORTCOVE_GITHUB_CLIENT_ID: {
    readers: ["crates/portcove-core/src/auth.rs"],
    reason: "the GitHub sign-in client ID; capability reports do not authenticate",
  },
};

/** Paths whose content defines every build (in addition to dep-info). */
export const buildDefinitionPaths = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "vendor"];

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

type Json = Record<string, unknown>;

function strings(value: unknown, into: Set<string>) {
  if (typeof value === "string") into.add(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) strings(item, into);
  return into;
}

/** Numeric `observed_at` values anywhere in a value: the only clock comparisons on this path. */
export function clockValues(value: unknown, into: number[] = []) {
  if (Array.isArray(value)) for (const item of value) clockValues(item, into);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      if (key === "observed_at" && typeof item === "number") into.push(item);
      clockValues(item, into);
    }
  return into;
}

interface RecordRef {
  array: string;
  index: number;
  record: Json;
}

export interface DataPartition {
  /** Digest of everything not partitioned to one port. */
  shared: string;
  /** Clock values in the shared data. */
  sharedClock: number[];
  /** Per port: digest of its partition and its clock values. */
  subjects: Map<string, { digest: string; clock: number[]; records: number }>;
  /** Source-catalog records no port reaches (kept in the shared digest). */
  unassignedRecords: number;
  /** Keys present in the data but not declared above (kept in the shared digest). */
  undeclared: string[];
}

/**
 * Splits the embedded catalog and listings into shared data and one partition
 * per port. Partitions overlap where records are shared by reference, and a
 * record reached by no port stays shared, so an edit to it reassesses every
 * subject.
 */
export function partitionData(
  catalog: Json,
  listings: Json,
  ids: readonly string[],
): DataPartition {
  const undeclared = [
    ...Object.keys(catalog)
      .filter((key) => !(declaredCatalogKeys as readonly string[]).includes(key))
      .map((key) => `catalog.${key}`),
    ...Object.keys((catalog.source_catalog as Json | undefined) ?? {})
      .filter((key) => !(declaredSourceCatalogArrays as readonly string[]).includes(key))
      .map((key) => `catalog.source_catalog.${key}`),
    ...Object.keys(listings)
      .filter((key) => !(declaredListingsKeys as readonly string[]).includes(key))
      .map((key) => `listings.${key}`),
  ];
  const sourceCatalog = (catalog.source_catalog as Json | undefined) ?? {};
  const records: RecordRef[] = [];
  for (const array of declaredSourceCatalogArrays) {
    const items = sourceCatalog[array];
    if (Array.isArray(items))
      items.forEach((record, index) => {
        if (record && typeof record === "object")
          records.push({ array, index, record: record as Json });
      });
  }
  const byId = new Map<string, RecordRef[]>();
  const byPort = new Map<string, RecordRef[]>();
  for (const ref of records) {
    if (typeof ref.record.id === "string")
      byId.set(ref.record.id, [...(byId.get(ref.record.id) ?? []), ref]);
    const owner =
      typeof ref.record.port_id === "string"
        ? ref.record.port_id
        : typeof (ref.record.scope as Json | undefined)?.port_id === "string"
          ? ((ref.record.scope as Json).port_id as string)
          : undefined;
    if (owner !== undefined) byPort.set(owner, [...(byPort.get(owner) ?? []), ref]);
  }
  const ports = Array.isArray(catalog.ports) ? (catalog.ports as Json[]) : [];
  const listingEntries = Array.isArray(listings.listings) ? (listings.listings as Json[]) : [];
  const portsById = new Map<string, Json[]>();
  for (const port of ports)
    if (typeof port?.id === "string")
      portsById.set(port.id, [...(portsById.get(port.id) ?? []), port]);
  const listingsById = new Map<string, Json[]>();
  for (const listing of listingEntries)
    if (typeof listing?.id === "string")
      listingsById.set(listing.id, [...(listingsById.get(listing.id) ?? []), listing]);

  const assigned = new Set<RecordRef>();
  const subjects = new Map<string, { digest: string; clock: number[]; records: number }>();
  for (const id of ids) {
    const own = { ports: portsById.get(id) ?? [], listings: listingsById.get(id) ?? [] };
    const reached = new Set<RecordRef>(byPort.get(id) ?? []);
    const seen = strings(own, new Set([id]));
    for (const ref of reached) strings(ref.record, seen);
    // Fixpoint over id references; each new record can name further records.
    for (let changed = true; changed;) {
      changed = false;
      for (const value of [...seen])
        for (const ref of byId.get(value) ?? [])
          if (!reached.has(ref)) {
            reached.add(ref);
            strings(ref.record, seen);
            changed = true;
          }
    }
    for (const ref of reached) assigned.add(ref);
    const ordered = [...reached].sort((left, right) =>
      left.array === right.array ? left.index - right.index : left.array < right.array ? -1 : 1,
    );
    const partition = {
      ...own,
      source_catalog: ordered.map(({ array, record }) => ({ array, record })),
    };
    subjects.set(id, {
      digest: sha256(canonical(partition)),
      clock: clockValues(partition),
      records: ordered.length,
    });
  }
  // Shared: the documents without the partitioned parts. Records no port
  // reaches stay here, in their original order.
  // A non-array `ports` or `listings` partitions nothing and stays shared.
  const sharedCatalog: Json = { ...catalog };
  if (Array.isArray(catalog.ports)) delete sharedCatalog.ports;
  const sharedSource: Json = { ...sourceCatalog };
  const assignedAt = new Set([...assigned].map((ref) => `${ref.array}:${ref.index}`));
  for (const array of declaredSourceCatalogArrays)
    if (Array.isArray(sourceCatalog[array]))
      sharedSource[array] = (sourceCatalog[array] as unknown[]).filter(
        (_, index) => !assignedAt.has(`${array}:${index}`),
      );
  if (catalog.source_catalog !== undefined) sharedCatalog.source_catalog = sharedSource;
  // Ports and listings that are not subjects of this run are shared, so a run
  // over a subset never ignores them.
  const subjectIds = new Set(ids);
  const sharedListings: Json = { ...listings };
  if (Array.isArray(listings.listings)) delete sharedListings.listings;
  const shared = {
    catalog: sharedCatalog,
    other_ports: ports.filter((port) => !subjectIds.has(port?.id as string)),
    listings: sharedListings,
    other_listings: listingEntries.filter((listing) => !subjectIds.has(listing?.id as string)),
  };
  return {
    shared: sha256(canonical(shared)),
    sharedClock: clockValues(shared),
    subjects,
    unassignedRecords: records.length - assigned.size,
    undeclared,
  };
}

/** A Cargo dep-info file: the target and every input file and environment dependency. */
export interface DepInfo {
  target: string;
  files: string[];
  env: string[];
}

/** Parses Make-style dep-info: escaped spaces, `\` continuations, `# env-dep:` lines. */
export function parseDepInfo(text: string): DepInfo | null {
  const env: string[] = [];
  const rules: string[] = [];
  for (const line of text.replace(/\\\r?\n/gu, " ").split(/\r?\n/u)) {
    if (line.startsWith("# env-dep:")) env.push(line.slice("# env-dep:".length));
    else if (line.trim() && !line.startsWith("#")) rules.push(line);
  }
  if (!rules.length) return null;
  const split = (value: string) =>
    (value.match(/(?:\\.|[^\s\\])+/gu) ?? []).map((token) => token.replace(/\\(.)/gu, "$1"));
  // Only the first rule names the artifact; later rules are empty `path:` stubs.
  const first = rules[0]!;
  const colon = first.search(/:(\s|$)/u);
  if (colon < 0) return null;
  const target = split(first.slice(0, colon)).join(" ");
  return { target, files: split(first.slice(colon + 1)), env: env.sort() };
}

/** The mechanism a binary was built from, keyed by exact content identities. */
export interface Mechanism {
  mode: "dep-info" | "whole-tree";
  digest: string;
  /** Why the conservative whole-tree key was used, when it was. */
  reason?: string;
  /** Repository files in the key. */
  files: number;
}

export interface MechanismInput {
  repositoryRoot: string;
  cli: string;
  /** Path to Git object ID at the collected revision, for every tracked blob. */
  blobs: ReadonlyMap<string, string>;
  /** Object IDs of `buildDefinitionPaths` and the whole-tree fallback paths. */
  trees: Readonly<Record<string, string>>;
  /** Paths whose bytes differ from the revision (from `git status`). */
  dirty: ReadonlySet<string>;
  /** Out-of-repository roots whose files Cargo.lock or the toolchain pin. */
  pinnedRoots?: readonly string[];
}

export function defaultPinnedRoots() {
  const home = os.homedir();
  return [
    path.join(process.env.CARGO_HOME ?? path.join(home, ".cargo"), "registry"),
    path.join(process.env.CARGO_HOME ?? path.join(home, ".cargo"), "git"),
    path.join(process.env.RUSTUP_HOME ?? path.join(home, ".rustup"), "toolchains"),
  ];
}

/**
 * Keys the binary's mechanism by the dep-info Cargo wrote beside it. Any doubt
 * (missing or unparseable dep-info, another target, a file outside the
 * revision, an unreadable out-of-tree input, a dirty input) falls back to the
 * whole Core tree.
 */
export function mechanismOf(input: MechanismInput): Mechanism {
  const fallback = (reason: string): Mechanism => ({
    mode: "whole-tree",
    reason,
    digest: sha256(canonical({ fallback: "whole-tree", trees: input.trees })),
    files: 0,
  });
  const depInfoPath = input.cli.replace(/\.exe$/u, "") + ".d";
  if (!existsSync(depInfoPath)) return fallback("the CLI has no Cargo dep-info beside it");
  let cliReal: string;
  try {
    cliReal = realpathSync(input.cli);
    if (statSync(depInfoPath).mtimeMs + 1 < statSync(input.cli).mtimeMs)
      return fallback("the CLI's dep-info is older than the binary");
  } catch {
    return fallback("the CLI or its dep-info is unreadable");
  }
  const depInfo = parseDepInfo(readFileSync(depInfoPath, "utf8"));
  if (!depInfo) return fallback("the CLI's dep-info could not be parsed");
  let targetReal = depInfo.target;
  try {
    targetReal = realpathSync(depInfo.target);
  } catch {
    // compared below as written
  }
  if (targetReal !== cliReal) return fallback("the dep-info names another artifact");
  const root = realpathSync(input.repositoryRoot);
  const pinned = (input.pinnedRoots ?? defaultPinnedRoots()).map((entry) =>
    existsSync(entry) ? realpathSync(entry) : entry,
  );
  const repository: Record<string, string> = {};
  const external: Record<string, string> = {};
  for (const file of depInfo.files) {
    // Compare real paths, so a symlinked checkout keeps its repository inputs.
    let absolute = path.resolve(path.dirname(depInfoPath), file);
    try {
      absolute = realpathSync(absolute);
    } catch {
      // A missing input is reported below as missing or unreadable.
    }
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (!relative.startsWith("../") && !path.isAbsolute(relative)) {
      if ((partitionedDocuments as readonly string[]).includes(relative)) continue;
      const blob = input.blobs.get(relative);
      if (!blob) return fallback(`${relative} is a build input missing at the revision`);
      if (input.dirty.has(relative)) return fallback(`${relative} differs from the revision`);
      repository[relative] = blob;
    } else if (
      pinned.some((entry) => absolute === entry || absolute.startsWith(entry + path.sep))
    ) {
      continue;
    } else {
      try {
        external[absolute] = sha256(readFileSync(absolute));
      } catch {
        return fallback(`the build input ${absolute} is unreadable`);
      }
    }
  }
  for (const document of partitionedDocuments)
    if (
      !depInfo.files.some((file) =>
        path.resolve(path.dirname(depInfoPath), file).endsWith(document),
      )
    )
      return fallback(`the dep-info does not name ${document}`);
  // Every package manifest at any depth, because features and dependencies live there.
  const manifests = Object.fromEntries(
    [...input.blobs].filter(([file]) => /(^|\/)Cargo\.toml$/u.test(file)),
  );
  return {
    mode: "dep-info",
    digest: sha256(
      canonical({
        repository,
        external,
        // Should Cargo record environment values, they count, except the
        // provenance label that changes with every revision.
        env: depInfo.env.filter((entry) => !entry.startsWith("PORTCOVE_SOURCE_REVISION=")),
        build_environment: Object.fromEntries(
          Object.entries(buildEnvironment).map(([name, { readers }]) => [name, readers]),
        ),
        manifests,
        build: Object.fromEntries(
          buildDefinitionPaths.map((entry) => [entry, input.trees[entry] ?? "absent"]),
        ),
      }),
    ),
    files: Object.keys(repository).length,
  };
}

export interface ScopePolicy {
  features: readonly string[];
  apiSchema: number;
  projection: number;
  platform: string;
  isolation: string;
}

export interface SubjectScope {
  /** The subject's scoped reuse key. */
  key: string;
  /** The newest clock value visible at `now`, in seconds (null when none). */
  visibleUntil: number | null;
  /** Every clock value the subject depends on (its partition and the shared data). */
  clock: readonly number[];
}

/** The newest of `values` visible at `nowSeconds`, or null when none is. */
export function newestVisible(values: readonly number[], nowSeconds: number) {
  return values.reduce<number | null>(
    (newest, value) =>
      value <= nowSeconds && (newest === null || value > newest) ? value : newest,
    null,
  );
}

/**
 * The clock value a binding may record for a read: the planned value when the
 * newest visible value did not change while Core read, otherwise -1, which no
 * later run's value equals, so the next run reads the subject again.
 */
export function boundVisible(subject: SubjectScope, afterReadSeconds: number) {
  return newestVisible(subject.clock, afterReadSeconds) === subject.visibleUntil
    ? subject.visibleUntil
    : -1;
}

export interface AssessmentScope {
  mechanism: Mechanism;
  /** Everything every subject shares: mechanism, shared data and policy. */
  baseKey: string;
  subjects: Map<string, SubjectScope>;
  partition: Pick<DataPartition, "unassignedRecords" | "undeclared">;
}

/**
 * Each subject's key: the shared base plus its own partition. Equal keys mean
 * Core computes the same report, apart from the clock, which the store checks
 * per subject through `visibleUntil`.
 */
export function assessmentScope(input: {
  mechanism: Mechanism;
  catalog: Json;
  listings: Json;
  ids: readonly string[];
  policy: ScopePolicy;
  nowSeconds: number;
}): AssessmentScope {
  const partition = partitionData(input.catalog, input.listings, input.ids);
  const baseKey = sha256(
    canonical({
      version: assessmentScopeVersion,
      mechanism: input.mechanism.digest,
      // Under the whole-tree fallback the tree already covers all data; the
      // per-subject split below then cannot narrow anything.
      shared: partition.shared,
      policy: { ...input.policy, features: [...input.policy.features].sort() },
    }),
  );
  const visible = (values: readonly number[]) => newestVisible(values, input.nowSeconds);
  const sharedVisible = visible(partition.sharedClock);
  const subjects = new Map<string, SubjectScope>();
  for (const id of input.ids) {
    const own = partition.subjects.get(id)!;
    const ownVisible = visible(own.clock);
    subjects.set(id, {
      key: sha256(canonical({ base: baseKey, subject: id, partition: own.digest })),
      visibleUntil:
        sharedVisible === null
          ? ownVisible
          : ownVisible === null
            ? sharedVisible
            : Math.max(sharedVisible, ownVisible),
      clock: [...partition.sharedClock, ...own.clock],
    });
  }
  return {
    mechanism: input.mechanism,
    baseKey,
    subjects,
    partition: { unassignedRecords: partition.unassignedRecords, undeclared: partition.undeclared },
  };
}
