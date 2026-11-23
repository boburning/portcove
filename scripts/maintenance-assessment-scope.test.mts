import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  assessmentScope,
  boundVisible,
  catalogPath,
  declaredCatalogKeys,
  declaredListingsKeys,
  declaredSourceCatalogArrays,
  listingsPath,
  mechanismOf,
  parseDepInfo,
  partitionData,
  buildEnvironment,
  type Mechanism,
  type ScopePolicy,
} from "./maintenance-assessment-scope.mts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const policy: ScopePolicy = {
  features: [],
  apiSchema: 101,
  projection: 1,
  platform: "linux-x86-64;cli-doctor-platform-v1",
  isolation: "fixture",
};

void test("dep-info parsing keeps escaped spaces, continuations and environment dependencies", () => {
  const parsed = parseDepInfo(
    [
      "/w/target/debug/portcove: /w/a\\ b.rs /w/c.rs \\",
      "  /w/d.json",
      "",
      "/w/a\\ b.rs:",
      "# env-dep:B=2",
      "# env-dep:A=1",
    ].join("\n"),
  );
  assert.deepEqual(parsed, {
    target: "/w/target/debug/portcove",
    files: ["/w/a b.rs", "/w/c.rs", "/w/d.json"],
    env: ["A=1", "B=2"],
  });
  assert.equal(parseDepInfo("# only comments\n"), null);
  assert.equal(parseDepInfo("no rule here"), null);
});

/** A fake checkout and binary with Cargo dep-info, for `mechanismOf`. */
function fakeBuild(files: Record<string, string>, depFiles: readonly string[], extra = "") {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-scope-"));
  const cli = path.join(root, "portcove");
  writeFileSync(cli, "binary");
  // A build input outside the checkout, such as generated code in OUT_DIR.
  const external = path.join(
    mkdtempSync(path.join(os.tmpdir(), "portcove-scope-out-")),
    "outside.rs",
  );
  writeFileSync(external, "generated");
  const depInfo = `${cli}: ${[...depFiles.map((file) => path.join(root, file)), extra]
    .filter(Boolean)
    .join(" ")}\n`;
  writeFileSync(`${cli}.d`, depInfo);
  const blobs = new Map(Object.entries(files).map(([file, content]) => [file, sha256(content)]));
  return { root, cli, external, blobs };
}

void test("the mechanism is exactly the binary's recorded inputs, or the whole tree when in doubt", (context) => {
  const files = {
    "crates/portcove-core/src/lib.rs": "lib",
    "crates/portcove-core/src/adapter.rs": "adapter",
    "crates/portcove-core/src/adapter_tests.rs": "tests",
    [catalogPath]: "{}",
    [listingsPath]: "{}",
    "crates/portcove-core/Cargo.toml": "manifest",
  };
  const compiled = [
    "crates/portcove-core/src/lib.rs",
    "crates/portcove-core/src/adapter.rs",
    catalogPath,
    listingsPath,
  ];
  const build = fakeBuild(files, compiled);
  context.after(() => rmSync(build.root, { recursive: true, force: true }));
  const trees = { crates: "tree-1", "Cargo.lock": "lock-1" };
  const mechanism = (overrides: Partial<Parameters<typeof mechanismOf>[0]> = {}) =>
    mechanismOf({
      repositoryRoot: build.root,
      cli: build.cli,
      blobs: build.blobs,
      trees,
      dirty: new Set(),
      pinnedRoots: [],
      ...overrides,
    });
  const base = mechanism();
  assert.equal(base.mode, "dep-info");
  assert.equal(base.files, 2, "the partitioned catalog documents are data, not mechanism");
  // A test-only module and catalog data are not mechanism; the crates tree is not either.
  const edited = (file: string) =>
    mechanism({ blobs: new Map([...build.blobs, [file, "changed"]]) }).digest;
  assert.equal(edited("crates/portcove-core/src/adapter_tests.rs"), base.digest);
  assert.equal(edited(catalogPath), base.digest);
  assert.equal(mechanism({ trees: { ...trees, crates: "tree-2" } }).digest, base.digest);
  // Compiled code, manifests and the lockfile are.
  assert.notEqual(edited("crates/portcove-core/src/adapter.rs"), base.digest);
  assert.notEqual(edited("crates/portcove-core/Cargo.toml"), base.digest);
  assert.notEqual(mechanism({ trees: { ...trees, "Cargo.lock": "lock-2" } }).digest, base.digest);
  // Doubt falls back to the whole tree, which changes with any Core file or data.
  for (const [overrides, reason] of [
    [{ dirty: new Set(["crates/portcove-core/src/lib.rs"]) }, /differs from the revision/u],
    [
      { blobs: new Map([...build.blobs].filter(([file]) => !file.endsWith("lib.rs"))) },
      /missing at the revision/u,
    ],
    [{ cli: path.join(build.root, "absent") }, /no Cargo dep-info/u],
  ] as const) {
    const fallback = mechanism(overrides);
    assert.equal(fallback.mode, "whole-tree");
    assert.match(fallback.reason ?? "", reason);
    assert.notEqual(
      mechanism({ ...overrides, trees: { ...trees, crates: "tree-2" } }).digest,
      fallback.digest,
    );
  }
  // An older dep-info, another artifact, or a dep-info without the catalog is refused.
  const stale = fakeBuild(files, compiled);
  context.after(() => rmSync(stale.root, { recursive: true, force: true }));
  utimesSync(`${stale.cli}.d`, new Date(0), new Date(0));
  assert.match(
    mechanismOf({
      repositoryRoot: stale.root,
      cli: stale.cli,
      blobs: stale.blobs,
      trees,
      dirty: new Set(),
      pinnedRoots: [],
    }).reason ?? "",
    /older than the binary/u,
  );
  const other = fakeBuild(files, compiled);
  context.after(() => rmSync(other.root, { recursive: true, force: true }));
  writeFileSync(`${other.cli}.d`, `${other.cli}-other: ${path.join(other.root, catalogPath)}\n`);
  assert.match(
    mechanismOf({
      repositoryRoot: other.root,
      cli: other.cli,
      blobs: other.blobs,
      trees,
      dirty: new Set(),
      pinnedRoots: [],
    }).reason ?? "",
    /another artifact/u,
  );
  const noCatalog = fakeBuild(files, ["crates/portcove-core/src/lib.rs"]);
  context.after(() => rmSync(noCatalog.root, { recursive: true, force: true }));
  assert.match(
    mechanismOf({
      repositoryRoot: noCatalog.root,
      cli: noCatalog.cli,
      blobs: noCatalog.blobs,
      trees,
      dirty: new Set(),
      pinnedRoots: [],
    }).reason ?? "",
    /does not name/u,
  );
  // Out-of-tree inputs count by content unless Cargo.lock or the toolchain pins them.
  const outside = fakeBuild(files, compiled);
  context.after(() => rmSync(outside.root, { recursive: true, force: true }));
  writeFileSync(
    `${outside.cli}.d`,
    `${outside.cli}: ${[...compiled.map((file) => path.join(outside.root, file)), outside.external].join(" ")}\n`,
  );
  const withOutside = (pinnedRoots: string[]) =>
    mechanismOf({
      repositoryRoot: outside.root,
      cli: outside.cli,
      blobs: outside.blobs,
      trees,
      dirty: new Set(),
      pinnedRoots,
    });
  const counted = withOutside([]).digest;
  writeFileSync(outside.external, "regenerated");
  assert.equal(withOutside([]).mode, "dep-info");
  assert.notEqual(withOutside([]).digest, counted);
  // A pinned root (Cargo registry, toolchain) is keyed by Cargo.lock and the toolchain instead.
  const pinned = withOutside([path.dirname(outside.external)]).digest;
  writeFileSync(outside.external, "regenerated again");
  assert.equal(withOutside([path.dirname(outside.external)]).digest, pinned);
});

void test("every build environment variable compiled code reads is declared with its readers", () => {
  const readers = new Map<string, Set<string>>();
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name).split(path.sep).join("/");
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith(".rs") && !/(_tests\.rs$|\/tests?\/)/u.test(file))
        for (const [, name] of readFileSync(file, "utf8").matchAll(
          /\b(?:option_)?env!\(\s*"([A-Z0-9_]+)"/gu,
        ))
          if (!name!.startsWith("CARGO_"))
            readers.set(name!, (readers.get(name!) ?? new Set()).add(file));
    }
  };
  // The crates linked into the CLI binary.
  for (const crate of [
    "portcove-core",
    "portcove-cli",
    "portcove-diagnostics",
    "portcove-listing-carrier",
  ])
    visit(`crates/${crate}/src`);
  assert.deepEqual(
    Object.fromEntries(
      [...readers]
        .map(([name, files]) => [name, [...files].sort()] as const)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
    Object.fromEntries(
      Object.entries(buildEnvironment)
        .map(([name, { readers: files }]) => [name, [...files].sort()] as const)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
  );
  // Excluding it leaves the mechanism unchanged across revisions; any other variable counts.
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-scope-env-"));
  try {
    const cli = path.join(root, "portcove");
    writeFileSync(cli, "binary");
    const files = [catalogPath, listingsPath].map((file) => path.join(root, file));
    const digest = (environment: string) => {
      writeFileSync(`${cli}.d`, `${cli}: ${files.join(" ")}\n${environment}\n`);
      return mechanismOf({
        repositoryRoot: root,
        cli,
        blobs: new Map(),
        trees: {},
        dirty: new Set(),
        pinnedRoots: [],
      }).digest;
    };
    assert.equal(
      digest("# env-dep:PORTCOVE_SOURCE_REVISION=aaaa"),
      digest("# env-dep:PORTCOVE_SOURCE_REVISION=bbbb"),
    );
    assert.notEqual(
      digest("# env-dep:PORTCOVE_GITHUB_CLIENT_ID=a"),
      digest("# env-dep:PORTCOVE_GITHUB_CLIENT_ID=b"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("source-catalog records name a port only through the declared owner fields", () => {
  // The partition follows references from a port to records by id, and from a
  // record to its port only through `port_id` or `scope.port_id`. A record that
  // named another port any other way would be missed for that port, so it fails here.
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
    source_catalog: Record<string, Record<string, unknown>[]>;
  };
  const ports = new Set(
    readdirSync("crates/portcove-core/catalog/ports").map((file) => file.replace(/\.json$/u, "")),
  );
  const strings = (value: unknown, into: string[] = []): string[] => {
    if (typeof value === "string") into.push(value);
    else if (Array.isArray(value)) for (const item of value) strings(item, into);
    else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        into.push(key);
        strings(item, into);
      }
    return into;
  };
  const undeclared: string[] = [];
  for (const [array, records] of Object.entries(catalog.source_catalog))
    for (const { id, port_id: owner, scope, ...rest } of records) {
      const { port_id: scopedOwner, ...scopeRest } = (scope ?? {}) as Record<string, unknown>;
      // Naming its own port again (such as a profile with the port's ID) is reached anyway.
      for (const value of strings([rest, scopeRest]))
        if (ports.has(value) && value !== owner && value !== scopedOwner)
          undeclared.push(`${array}:${String(id)}:${value}`);
    }
  assert.deepEqual(undeclared, []);
});

void test("a binding records its clock value only when it did not move during the read", () => {
  const subject = { key: "k", visibleUntil: 100, clock: [50, 100, 300] };
  assert.equal(boundVisible(subject, 299), 100);
  // A value became visible while Core read: the next run must read again.
  assert.equal(boundVisible(subject, 300), -1);
  assert.equal(boundVisible({ key: "k", visibleUntil: null, clock: [300] }, 300), -1);
  assert.equal(boundVisible({ key: "k", visibleUntil: null, clock: [] }, 300), null);
});

void test("the declared catalog shape matches the embedded data, so new structure is reviewed", () => {
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as Record<string, unknown>;
  const listings = JSON.parse(readFileSync(listingsPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(catalog).sort(), [...declaredCatalogKeys].sort());
  assert.deepEqual(
    Object.keys(catalog.source_catalog as object).sort(),
    [...declaredSourceCatalogArrays].sort(),
  );
  assert.deepEqual(Object.keys(listings).sort(), [...declaredListingsKeys].sort());
  // An undeclared field is still kept, as shared data.
  const ids = ["a"];
  const before = partitionData({ schema_version: 3, ports: [] }, { listings: [] }, ids);
  const after = partitionData({ schema_version: 3, ports: [], added: 1 }, { listings: [] }, ids);
  assert.deepEqual(after.undeclared, ["catalog.added"]);
  assert.notEqual(after.shared, before.shared);
});

// ---------------------------------------------------------------------------
// Equivalence: selective reassessment equals complete reassessment.
//
// The reference evaluator follows Core's documented access pattern for a
// fresh-library capability report, independently of the generic partition:
// whole-catalog validation; the port's own entry and listing; the identity
// named by its `source_profile`; contracts naming its port ID, with their
// evidence and validator; qualification scoped to it; a listing advisory that
// is valid only once its `observed_at` has passed; the compiled code it runs;
// and the policy. A selective run reuses a subject's previous output when its
// scoped key is unchanged and no clock value became visible since its read,
// and requires the catalog to load (the same binary's target inspection).
// ---------------------------------------------------------------------------

interface World {
  catalog: Record<string, unknown>;
  listings: Record<string, unknown>;
  ids: string[];
  code: Record<string, string>;
  compiled: string[];
  policy: ScopePolicy;
}

type Records = Record<string, Record<string, unknown>[]>;
const sources = (world: World) => (world.catalog.source_catalog as Records | undefined) ?? {};

function validCatalog(world: World) {
  const ports = (world.catalog.ports as { id: string }[]).map(({ id }) => id);
  const identities = new Set((sources(world).identities ?? []).map(({ id }) => id));
  return (
    new Set(ports).size === ports.length &&
    (world.catalog.ports as { source_profile?: string }[]).every(
      ({ source_profile }) => source_profile === undefined || identities.has(source_profile),
    )
  );
}

function evaluate(world: World, id: string, now: number) {
  if (!validCatalog(world)) return "load-failed";
  const source = sources(world);
  const port = (world.catalog.ports as { id: string; source_profile?: string }[]).find(
    (entry) => entry.id === id,
  );
  const listing = (
    world.listings.listings as { id: string; advisory?: { observed_at: number } }[]
  ).find((entry) => entry.id === id);
  const contracts = (source.contracts ?? []).filter((record) => record.port_id === id);
  const evidence = (source.evidence ?? []).filter((record) =>
    contracts.some((contract) => (contract.evidence_ids as string[]).includes(record.id as string)),
  );
  const validators = (source.validators ?? []).filter((record) =>
    contracts.some((contract) => contract.validator_contract_id === record.id),
  );
  return sha256(
    JSON.stringify({
      schema: world.catalog.schema_version,
      format: world.listings.format_version,
      port,
      listing: listing && {
        ...listing,
        advisory: listing.advisory && listing.advisory.observed_at <= now,
      },
      identity: (source.identities ?? []).find((record) => record.id === port?.source_profile),
      contracts,
      evidence,
      validators,
      qualification: (source.qualification ?? []).filter(
        (record) => (record.scope as { port_id?: string }).port_id === id,
      ),
      code: world.compiled.map((file) => world.code[file]),
      policy: world.policy,
    }),
  );
}

/** The mechanism digest `mechanismOf` would give: compiled files only. */
function mechanismFor(world: World): Mechanism {
  return {
    mode: "dep-info",
    digest: sha256(JSON.stringify(world.compiled.map((file) => [file, world.code[file]]))),
    files: world.compiled.length,
  };
}

function scopeOf(world: World, now: number) {
  return assessmentScope({
    mechanism: mechanismFor(world),
    catalog: world.catalog,
    listings: world.listings,
    ids: world.ids,
    policy: world.policy,
    nowSeconds: now,
  });
}

/** A seeded generator, so every change set is reproducible. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function generatedWorld(size: number, seed = 1): World {
  const next = random(seed);
  const pick = <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
  const ids = Array.from({ length: size }, (_, index) => `port-${index}`);
  const identities = Array.from({ length: Math.max(2, size >> 2) }, (_, index) => ({
    id: `identity-${index}`,
    label: `Game ${index}`,
  }));
  const evidence = Array.from({ length: Math.max(2, size >> 1) }, (_, index) => ({
    id: `evidence-${index}`,
    claim: `claim ${index}`,
  }));
  const validators = [
    { id: "validator-0", tool_id: "tool" },
    { id: "validator-1", tool_id: "tool" },
  ];
  const operational = ids.filter(() => next() < 0.4);
  const ports = operational.map((id) => ({
    id,
    adapter: pick(["native", "recomp"]),
    source_profile: pick(identities).id,
  }));
  const contracts = operational
    .filter(() => next() < 0.7)
    .map((id, index) => ({
      id: `contract-${index}`,
      port_id: id,
      profile_id: pick(identities).id,
      evidence_ids: [pick(evidence).id, pick(evidence).id],
      validator_contract_id: pick(validators).id,
    }));
  const qualification = operational
    .filter(() => next() < 0.3)
    .map((id) => ({ scope: { port_id: id }, outcome: "passed", observed_at: 1_000 }));
  const listings = ids.map((id) => ({
    id,
    name: id,
    ...(next() < 0.2 ? { advisory: { observed_at: 1_000 + Math.floor(next() * 1_000) } } : {}),
  }));
  return {
    catalog: {
      schema_version: 3,
      source_catalog: {
        evidence: [...evidence, { id: "evidence-orphan", claim: "unreferenced" }],
        identities,
        contracts,
        validators,
        qualification,
      },
      ports,
    },
    listings: { format_version: 15, listings },
    ids,
    code: { "core/service.rs": "v1", "core/adapter.rs": "v1", "core/adapter_tests.rs": "v1" },
    compiled: ["core/service.rs", "core/adapter.rs"],
    policy,
  };
}

type Change = (world: World, next: () => number) => void;
const clone = (world: World): World => structuredClone(world);
const changes: Record<string, Change> = {
  "one definition edited": (world, next) => {
    const ports = world.catalog.ports as Record<string, unknown>[];
    if (ports.length) ports[Math.floor(next() * ports.length)]!.adapter = `edited-${next()}`;
  },
  "one listing edited": (world, next) => {
    const listings = world.listings.listings as Record<string, unknown>[];
    listings[Math.floor(next() * listings.length)]!.name = `renamed-${next()}`;
  },
  "a shared source identity edited": (world, next) => {
    const identities = sources(world).identities!;
    identities[Math.floor(next() * identities.length)]!.label = `relabelled-${next()}`;
  },
  "shared evidence edited": (world, next) => {
    const evidence = sources(world).evidence!;
    evidence[Math.floor(next() * evidence.length)]!.claim = `revised-${next()}`;
  },
  "unreferenced record edited": (world) => {
    sources(world).evidence!.find((record) => record.id === "evidence-orphan")!.claim = "edited";
  },
  "a contract removed": (world, next) => {
    const contracts = sources(world).contracts!;
    if (contracts.length) contracts.splice(Math.floor(next() * contracts.length), 1);
  },
  "a port added": (world, next) => {
    const id = `port-new-${Math.floor(next() * 1e6)}`;
    world.ids.push(id);
    (world.listings.listings as unknown[]).push({ id, name: id });
  },
  "an undeclared field added": (world) => {
    world.catalog.reviewed_policy = { version: 2 };
  },
  "one adapter module edited": (world) => {
    world.code["core/adapter.rs"] = "v2";
  },
  "an unrelated module edited": (world) => {
    world.code["core/adapter_tests.rs"] = "v2";
  },
  "evaluator version bumped": (world) => {
    world.policy = { ...world.policy, projection: world.policy.projection + 1 };
  },
  "the catalog no longer loads": (world) => {
    const ports = world.catalog.ports as Record<string, unknown>[];
    if (ports.length) ports.push({ ...ports[0]! });
  },
};

/**
 * Complete versus selective reassessment of one change at `later`. Returns how
 * many subjects the selective run read.
 */
function compare(before: World, after: World, readAt: number, later: number) {
  const previous = new Map(before.ids.map((id) => [id, evaluate(before, id, readAt)]));
  const bound = scopeOf(before, readAt);
  const current = scopeOf(after, later);
  const complete = new Map(after.ids.map((id) => [id, evaluate(after, id, later)]));
  // A selective run requires the binary's catalog inspection to have succeeded.
  const selectiveAllowed = validCatalog(after);
  let read = 0;
  for (const id of after.ids) {
    const subject = current.subjects.get(id)!;
    const due =
      !selectiveAllowed ||
      !previous.has(id) ||
      bound.subjects.get(id)?.key !== subject.key ||
      (subject.visibleUntil !== null && subject.visibleUntil > readAt);
    if (due) read++;
    const selective = due ? evaluate(after, id, later) : previous.get(id)!;
    assert.equal(selective, complete.get(id), `${id} differs after selective reassessment`);
  }
  return read;
}

void test("selective reassessment equals complete reassessment over generated change sets", () => {
  const base = generatedWorld(120);
  const counts: Record<string, number> = {};
  for (const [name, change] of Object.entries(changes)) {
    const after = clone(base);
    change(after, random(7));
    counts[name] = compare(base, after, 1_500, 1_500);
  }
  // Data changes reassess only affected subjects; shared mechanisms reassess all.
  assert.ok(counts["one definition edited"]! <= 3, JSON.stringify(counts));
  assert.equal(counts["one listing edited"], 1);
  assert.equal(counts["an unrelated module edited"], 0);
  for (const all of [
    "one adapter module edited",
    "evaluator version bumped",
    "unreferenced record edited",
    "an undeclared field added",
    "the catalog no longer loads",
  ])
    assert.equal(counts[all], base.ids.length, all);
  assert.ok(counts["a shared source identity edited"]! < base.ids.length);
  // Time alone: an advisory becoming valid reassesses exactly its subjects.
  const crossing = base.ids.filter((id) => {
    const advisory = (
      base.listings.listings as { id: string; advisory?: { observed_at: number } }[]
    ).find((entry) => entry.id === id)?.advisory;
    return advisory !== undefined && advisory.observed_at > 1_500 && advisory.observed_at <= 1_900;
  }).length;
  assert.ok(crossing > 0, "the generated world needs an expiring observation");
  assert.equal(compare(base, clone(base), 1_500, 1_900), crossing);
  // Random combinations of several changes, each also crossing time.
  const next = random(42);
  const names = Object.keys(changes);
  for (let round = 0; round < 150; round++) {
    const after = clone(base);
    for (let count = 1 + Math.floor(next() * 4); count > 0; count--)
      changes[names[Math.floor(next() * names.length)]!]!(after, next);
    compare(base, after, 1_200 + Math.floor(next() * 400), 1_600 + Math.floor(next() * 400));
  }
});

void test("on the real embedded catalog a data-only change rekeys only its subject", () => {
  const ids = readdirSync("crates/portcove-core/catalog/ports")
    .map((file) => file.replace(/\.json$/u, ""))
    .sort();
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as Record<string, unknown>;
  const listings = JSON.parse(readFileSync(listingsPath, "utf8")) as Record<string, unknown>;
  const mechanism: Mechanism = { mode: "dep-info", digest: "m".repeat(64), files: 1 };
  const keys = (catalogDocument: unknown, listingsDocument: unknown, m = mechanism) =>
    assessmentScope({
      mechanism: m,
      catalog: catalogDocument as Record<string, unknown>,
      listings: listingsDocument as Record<string, unknown>,
      ids,
      policy,
      nowSeconds: 1_800_000_000,
    }).subjects;
  const before = keys(catalog, listings);
  const changed = (after: Map<string, { key: string }>) =>
    ids.filter((id) => after.get(id)!.key !== before.get(id)!.key);
  // One listing's summary.
  const editedListings = structuredClone(listings) as {
    listings: { id: string; summary?: string }[];
  };
  const target = editedListings.listings.find(({ id }) => id === "shipwright")!;
  target.summary = `${target.summary ?? ""} (edited)`;
  assert.deepEqual(changed(keys(catalog, editedListings)), ["shipwright"]);
  // One operational definition.
  const editedCatalog = structuredClone(catalog) as { ports: { id: string; name: string }[] };
  editedCatalog.ports.find(({ id }) => id === "shipwright")!.name += " (edited)";
  assert.deepEqual(changed(keys(editedCatalog, listings)), ["shipwright"]);
  // A shared source record reached by several ports rekeys exactly those ports.
  const shared = structuredClone(catalog) as {
    source_catalog: { evidence: { id: string; claim: string }[] };
  };
  const reached = partitionData(catalog, listings, ids);
  const evidence = shared.source_catalog.evidence[0]!;
  evidence.claim += " (edited)";
  const affected = changed(keys(shared, listings));
  assert.ok(affected.length > 0 && affected.length < ids.length, String(affected.length));
  assert.ok(reached.unassignedRecords < 10);
  // A mechanism change rekeys everything.
  assert.equal(
    changed(keys(catalog, listings, { ...mechanism, digest: "n".repeat(64) })).length,
    ids.length,
  );
});
