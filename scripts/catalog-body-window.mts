// Catalog listing-body window (#1422; design CATALOG-DISTRIBUTION-SCALING.md
// 6.1-6.2). The served catalog keeps every signed metadata version, but only
// the listing bodies a client or the publisher can still need: the current
// body, the previous body, the newest body of each listing target, and every
// pinned publication's bodies. Older bodies stay in `gh-pages` Git history and
// are verified from the listing-floor ledger that `portcove-release-tools`
// derives from the bodies before any of them can be pruned.
//
// Retention is OFF by default (`all`): nothing here changes a publication
// until the lead activates `ledger` and then `window` in a reviewed change.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  compactListingDeliveryTarget,
  listingDeliveryTarget,
} from "./listing-directory-carrier.mts";
import { isRecord } from "./runtime-values.mts";
import { type PublicationPin, readPublicationPins } from "./catalog-publication-pins.mts";

export const retainBodyModes = ["all", "ledger", "window"] as const;
export type RetainBodies = (typeof retainBodyModes)[number];
/** Catalog-relative path of the served ledger, beside the TUF repository. */
export const listingFloorLedgerPath = "history-ledger/listing-floors.json";
export const listingFloorLedgerMaximumBytes = 8 * 1024 ** 2;
/** Existing workflow bounds: the retained repository and the whole Pages tree. */
export const retainedRepositoryBound = 768 * 1024 ** 2;
export const pagesTreeBound = 900_000_000;

const listingTargets = [listingDeliveryTarget, compactListingDeliveryTarget] as const;
const hex = /^[0-9a-f]{64}$/u;
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export function retainBodies(value: string | undefined): RetainBodies {
  const mode = value ?? "all";
  if (!(retainBodyModes as readonly string[]).includes(mode))
    throw new Error(`catalog body retention must be one of ${retainBodyModes.join(", ")}`);
  return mode as RetainBodies;
}

export type LedgerEntry = {
  policy_version: number;
  target: string;
  sha256: string;
  length: number;
  revision: number;
  decoded_sha256: string;
  withdrawn_ids_count: number;
  withdrawn_ids_sha256: string;
};

const entryKeys = [
  "decoded_sha256",
  "length",
  "policy_version",
  "revision",
  "sha256",
  "target",
  "withdrawn_ids_count",
  "withdrawn_ids_sha256",
];

/** Shape checks only: `portcove-release-tools` derived and verified the ledger. */
export function parseLedger(bytes: Buffer): LedgerEntry[] {
  if (bytes.length > listingFloorLedgerMaximumBytes)
    throw new Error("catalog listing-floor ledger exceeds its byte bound");
  const document: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !isRecord(document) ||
    document.ledger_schema !== 1 ||
    document.kind !== "catalog-listing-floor-ledger" ||
    !Array.isArray(document.entries)
  )
    throw new Error("catalog listing-floor ledger schema differs");
  const seen = new Set<string>();
  return document.entries.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join() !== entryKeys.join() ||
      !(listingTargets as readonly unknown[]).includes(entry.target) ||
      ![entry.sha256, entry.decoded_sha256, entry.withdrawn_ids_sha256].every(
        (value) => typeof value === "string" && hex.test(value),
      ) ||
      ![entry.policy_version, entry.length, entry.revision].every(
        (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0,
      ) ||
      typeof entry.withdrawn_ids_count !== "number" ||
      !Number.isSafeInteger(entry.withdrawn_ids_count) ||
      entry.withdrawn_ids_count < 0 ||
      seen.has(`${String(entry.target)} ${String(entry.sha256)}`)
    )
      throw new Error("catalog listing-floor ledger entry is malformed");
    const valid = entry as LedgerEntry;
    seen.add(`${valid.target} ${valid.sha256}`);
    return valid;
  });
}

export function ledgerExtends(next: readonly LedgerEntry[], prior: readonly LedgerEntry[]) {
  return (
    next.length >= prior.length &&
    prior.every((entry, index) => JSON.stringify(entry) === JSON.stringify(next[index]))
  );
}

export type PolicyListings = Map<string, { sha256: string; length: number }>;

/** Listing bodies named by one signed `official-policy` metadata version. */
export function policyListings(metadata: unknown): PolicyListings {
  if (!isRecord(metadata) || !isRecord(metadata.signed) || !isRecord(metadata.signed.targets))
    throw new Error("catalog official-policy metadata is malformed");
  const listings: PolicyListings = new Map();
  for (const target of listingTargets) {
    const entry = metadata.signed.targets[target];
    if (entry === undefined) continue;
    const digest = isRecord(entry) && isRecord(entry.hashes) ? entry.hashes.sha256 : undefined;
    const length = isRecord(entry) ? entry.length : undefined;
    if (
      typeof digest !== "string" ||
      !hex.test(digest) ||
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 1
    )
      throw new Error("catalog official-policy listing descriptor is malformed");
    listings.set(target, { sha256: digest, length });
  }
  return listings;
}

/** Every retained `official-policy` version of a catalog directory. */
export function readPolicyHistory(catalog: string) {
  const versions = new Map<number, PolicyListings>();
  const metadata = path.join(catalog, "metadata");
  for (const name of existsSync(metadata) ? readdirSync(metadata) : []) {
    const match = /^([1-9][0-9]*)\.official-policy\.json$/u.exec(name);
    if (!match) continue;
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version)) throw new Error("catalog policy version is too large");
    versions.set(
      version,
      policyListings(JSON.parse(readFileSync(path.join(metadata, name), "utf8"))),
    );
  }
  return versions;
}

/** The policy version a served catalog's timestamp and snapshot name. */
export function servedPolicyVersion(read: (file: string) => unknown) {
  const timestamp = read("timestamp.json");
  const snapshotMeta =
    isRecord(timestamp) && isRecord(timestamp.signed) && isRecord(timestamp.signed.meta)
      ? timestamp.signed.meta["snapshot.json"]
      : undefined;
  const snapshotVersion = isRecord(snapshotMeta) ? snapshotMeta.version : undefined;
  if (typeof snapshotVersion !== "number" || !Number.isSafeInteger(snapshotVersion))
    throw new Error("catalog timestamp names no snapshot");
  const snapshot = read(`${snapshotVersion}.snapshot.json`);
  const policy =
    isRecord(snapshot) && isRecord(snapshot.signed) && isRecord(snapshot.signed.meta)
      ? snapshot.signed.meta["official-policy.json"]
      : undefined;
  const version = isRecord(policy) ? policy.version : undefined;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1)
    throw new Error("catalog snapshot names no official-policy version");
  return version;
}

export const bodyPath = (target: string, digest: string) => `targets/${digest}.${target}`;
export const isListingBody = (name: string) =>
  name.startsWith("targets/") && listingTargets.some((target) => name.endsWith(`.${target}`));

export type WindowInput = {
  /** Every retained policy version after this publication is assembled. */
  policies: Map<number, PolicyListings>;
  /** The policy version the previously served publication named. */
  previous: number | null;
  pins: readonly PublicationPin[];
  /** The ledger already published before this run, if any. */
  publishedLedger: readonly LedgerEntry[] | null;
  /** The ledger this run's verified assembly derived. */
  nextLedger: readonly LedgerEntry[];
  /** Served catalog files before this run: path to identity. */
  served: ReadonlyMap<string, { sha256: string; bytes: number }>;
  /** Checkpointed history keeps its own archive inventory; never prune beside it. */
  historyMode: boolean;
};

export type WindowPlan = {
  keep: Map<string, string[]>;
  prune: { path: string; bytes: number }[];
  held: { path: string; reason: string }[];
  /** Set when nothing may be pruned this run, with the reason. */
  refused: string | null;
};

/** Decide which served listing bodies leave the served tree. Fail closed: any
 * doubt keeps the body, and any doubt about the inputs keeps every body. */
export function planBodyWindow(input: WindowInput): WindowPlan {
  const keep = new Map<string, string[]>();
  const plan: WindowPlan = { keep, prune: [], held: [], refused: null };
  const reason = (target: string, digest: string, why: string) => {
    const name = bodyPath(target, digest);
    keep.set(name, [...(keep.get(name) ?? []), why]);
  };
  const versions = [...input.policies.keys()].sort((a, b) => b - a);
  const current = versions[0];
  if (current === undefined) return { ...plan, refused: "no signed policy history" };
  for (const [target, body] of input.policies.get(current)!)
    reason(target, body.sha256, "current publication");
  if (input.previous !== null) {
    const previous = input.policies.get(input.previous);
    if (!previous) return { ...plan, refused: "the previous publication's policy is not retained" };
    for (const [target, body] of previous) reason(target, body.sha256, "previous publication");
  }
  // Clients may hold metadata naming the previous body for Pages' 600 s cache.
  // A carrier the current publication no longer names (legacy after the
  // compact cutover) keeps only its newest body, below.
  for (const target of input.policies.get(current)!.keys()) {
    const distinct: string[] = [];
    for (const version of versions) {
      const body = input.policies.get(version)!.get(target);
      if (body && !distinct.includes(body.sha256)) distinct.push(body.sha256);
      if (distinct.length === 2) break;
    }
    distinct.forEach((digest, index) =>
      reason(target, digest, index ? "previous body" : "current body"),
    );
  }
  for (const pin of input.pins) {
    const pinned = input.policies.get(pin.policy_version);
    if (!pinned) return { ...plan, refused: `pin ${pin.name} names an unretained policy version` };
    for (const [target, body] of pinned) reason(target, body.sha256, `pin ${pin.name}`);
  }
  if (input.historyMode)
    return { ...plan, refused: "checkpointed history is active; its archive keeps every body" };
  if (!input.publishedLedger)
    return { ...plan, refused: "no listing-floor ledger was published before this run" };
  if (!ledgerExtends(input.nextLedger, input.publishedLedger))
    return { ...plan, refused: "the verified ledger does not extend the published ledger" };
  // The verifier checks every successor against each target's newest body.
  for (const target of listingTargets) {
    let newest: LedgerEntry | undefined;
    for (const entry of input.nextLedger)
      if (entry.target === target && (!newest || entry.revision > newest.revision)) newest = entry;
    if (newest) reason(target, newest.sha256, "newest revision");
  }
  const published = new Map(input.publishedLedger.map((e) => [bodyPath(e.target, e.sha256), e]));
  for (const [name, file] of input.served) {
    if (!isListingBody(name) || keep.has(name)) continue;
    const entry = published.get(name);
    if (!entry) plan.held.push({ path: name, reason: "no published ledger entry" });
    else if (
      bodyPath(entry.target, entry.sha256) !== name ||
      entry.length !== file.bytes ||
      entry.sha256 !== file.sha256
    )
      plan.held.push({ path: name, reason: "served bytes differ from the ledger entry" });
    else plan.prune.push({ path: name, bytes: file.bytes });
  }
  return plan;
}

/** Bytes the 768 MiB repository bound counts: everything except visitor pages
 * and the ledger itself. */
export function retainedRepositoryBytes(served: ReadonlyMap<string, { bytes: number }>) {
  let bytes = 0;
  for (const [name, file] of served)
    if (name.startsWith("metadata/") || name.startsWith("targets/")) bytes += file.bytes;
  return bytes;
}

export type WindowReport = {
  mode: RetainBodies;
  ledger: { entries: number; bytes: number; sha256: string } | null;
  kept: { bodies: number; bytes: number };
  pruned: { bodies: number; bytes: number };
  held: { path: string; reason: string }[];
  refused: string | null;
  retained_repository_bytes: number;
  retained_repository_bound: number;
};

export function formatWindowReport(report: WindowReport) {
  const lines = [
    `Catalog body retention: ${report.mode}.`,
    report.ledger
      ? `Listing-floor ledger: ${report.ledger.entries} entries, ${report.ledger.bytes} bytes (${report.ledger.sha256}).`
      : "Listing-floor ledger: not maintained.",
    `Listing bodies kept: ${report.kept.bodies} (${report.kept.bytes} bytes); pruned: ${report.pruned.bodies} (${report.pruned.bytes} bytes freed).`,
    `Retained repository: ${report.retained_repository_bytes} of ${report.retained_repository_bound} bytes.`,
  ];
  if (report.refused) lines.push(`Nothing pruned: ${report.refused}.`);
  for (const held of report.held) lines.push(`Kept ${held.path}: ${held.reason}.`);
  return lines;
}

/** Offline planning against a scratch catalog tree (rehearsal and runbook). */
async function main(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      catalog: { type: "string" },
      ledger: { type: "string" },
      pins: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  if (!values.catalog || !values.ledger || !values.pins)
    throw new Error(
      "usage: catalog-body-window.mts --catalog <dir> --ledger <file> --pins <file> [--apply]",
    );
  const catalog = path.resolve(values.catalog);
  const ledger = parseLedger(readFileSync(values.ledger));
  const served = new Map<string, { sha256: string; bytes: number }>();
  for (const directory of ["metadata", "targets"]) {
    const root = path.join(catalog, directory);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      const bytes = readFileSync(file);
      const name = path.relative(catalog, file).split(path.sep).join("/");
      served.set(name, { sha256: sha256(bytes), bytes: bytes.length });
    }
  }
  const plan = planBodyWindow({
    policies: readPolicyHistory(catalog),
    previous: null,
    pins: readPublicationPins(values.pins),
    publishedLedger: ledger,
    nextLedger: ledger,
    served,
    historyMode: false,
  });
  const pruned = plan.refused ? [] : plan.prune;
  const prunedPaths = new Set(pruned.map((body) => body.path));
  if (values.apply) for (const body of pruned) rmSync(path.join(catalog, body.path));
  const kept = [...served].filter(([name]) => isListingBody(name) && !prunedPaths.has(name));
  const remaining = new Map([...served].filter(([name]) => !prunedPaths.has(name)));
  const bytes = readFileSync(values.ledger);
  const report: WindowReport = {
    mode: "window",
    ledger: { entries: ledger.length, bytes: bytes.length, sha256: sha256(bytes) },
    kept: { bodies: kept.length, bytes: kept.reduce((sum, [, file]) => sum + file.bytes, 0) },
    pruned: {
      bodies: pruned.length,
      bytes: pruned.reduce((sum, body) => sum + body.bytes, 0),
    },
    held: plan.held,
    refused: plan.refused,
    retained_repository_bytes: retainedRepositoryBytes(remaining),
    retained_repository_bound: retainedRepositoryBound,
  };
  for (const line of formatWindowReport(report)) console.log(line);
  for (const [name, reasons] of [...plan.keep].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    if (served.has(name)) console.log(`keep ${name}: ${reasons.join(", ")}`);
  console.log(JSON.stringify(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
