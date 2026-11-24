// Pinned last-good catalog publications (#1422; design 6.2). The body window
// never prunes a listing body that a pinned publication's signed policy
// metadata names, and the restore runbook (docs/RELEASING.md) restores from a
// pin's `gh-pages` commit. Adding or removing a pin is an ordinary reviewed PR.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "./runtime-values.mts";

export const publicationPinsFile = "release/catalog-publication-pins.json";
/** One per activation kind (cutover, window, manifest, schema 2), last-good,
 * a restore and two spare (design 3.9). */
export const maximumPins = 8;
const commitPattern = /^[0-9a-f]{40}$/u;
const namePattern = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const publisherSubject = /^Publish the official catalog from [0-9a-f]{40}$/u;
const listingTargets = [
  "policy/official/catalog.listings.json",
  "policy/official/catalog.listings.compact.json",
];

export type PublicationPin = {
  name: string;
  pages_commit: string;
  policy_version: number;
  reason: string;
};

export function parsePublicationPins(text: string): PublicationPin[] {
  const document: unknown = JSON.parse(text);
  if (
    !isRecord(document) ||
    Object.keys(document).sort().join() !== "pins,schema_version" ||
    document.schema_version !== 1 ||
    !Array.isArray(document.pins) ||
    document.pins.length > maximumPins
  )
    throw new Error(`catalog publication pins must be schema 1 with at most ${maximumPins} pins`);
  const names = new Set<string>();
  const commits = new Set<string>();
  return document.pins.map((pin: unknown) => {
    if (
      !isRecord(pin) ||
      Object.keys(pin).sort().join() !== "name,pages_commit,policy_version,reason" ||
      typeof pin.name !== "string" ||
      !namePattern.test(pin.name) ||
      typeof pin.pages_commit !== "string" ||
      !commitPattern.test(pin.pages_commit) ||
      typeof pin.policy_version !== "number" ||
      !Number.isSafeInteger(pin.policy_version) ||
      pin.policy_version < 1 ||
      typeof pin.reason !== "string" ||
      !pin.reason.trim() ||
      pin.reason.length > 512 ||
      names.has(pin.name) ||
      commits.has(pin.pages_commit)
    )
      throw new Error("catalog publication pin is malformed or repeated");
    names.add(pin.name);
    commits.add(pin.pages_commit);
    return pin as PublicationPin;
  });
}

export function readPublicationPins(file: string) {
  return parsePublicationPins(readFileSync(file, "utf8"));
}

function show(repository: string, object: string, maximum: number) {
  const bytes = execFileSync("git", ["-C", repository, "cat-file", "blob", object], {
    maxBuffer: maximum,
  });
  if (bytes.length > maximum) throw new Error(`pinned object exceeds its bound: ${object}`);
  return bytes;
}

export type PinEvidence = {
  name: string;
  pages_commit: string;
  policy_version: number;
  bodies: { path: string; sha256: string; bytes: number }[];
};

/**
 * Confirm a pin against `gh-pages` history: its commit is an ordinary catalog
 * publication whose timestamp and snapshot name exactly the pinned policy
 * version, and every listing body that version names is present, byte-exact,
 * at that commit. Needs the pinned commit locally (a full or deepened fetch).
 */
export function verifyPublicationPin(repository: string, pin: PublicationPin): PinEvidence {
  const subject = execFileSync(
    "git",
    ["-C", repository, "log", "-1", "--format=%s", `${pin.pages_commit}^{commit}`],
    { encoding: "utf8" },
  ).trim();
  if (!publisherSubject.test(subject))
    throw new Error(`pin ${pin.name} is not an ordinary catalog publication commit`);
  const read = (file: string, maximum = 4 * 1024 ** 2): unknown =>
    JSON.parse(
      show(repository, `${pin.pages_commit}:catalog/metadata/${file}`, maximum).toString("utf8"),
    );
  const timestamp = read("timestamp.json");
  const snapshotVersion =
    isRecord(timestamp) &&
    isRecord(timestamp.signed) &&
    isRecord(timestamp.signed.meta) &&
    isRecord(timestamp.signed.meta["snapshot.json"])
      ? timestamp.signed.meta["snapshot.json"].version
      : undefined;
  const snapshot = read(`${String(snapshotVersion)}.snapshot.json`);
  const policyVersion =
    isRecord(snapshot) &&
    isRecord(snapshot.signed) &&
    isRecord(snapshot.signed.meta) &&
    isRecord(snapshot.signed.meta["official-policy.json"])
      ? snapshot.signed.meta["official-policy.json"].version
      : undefined;
  if (policyVersion !== pin.policy_version)
    throw new Error(
      `pin ${pin.name} serves policy ${String(policyVersion)}, not ${pin.policy_version}`,
    );
  const policy = read(`${pin.policy_version}.official-policy.json`);
  if (!isRecord(policy) || !isRecord(policy.signed) || !isRecord(policy.signed.targets))
    throw new Error(`pin ${pin.name} policy metadata is malformed`);
  const bodies = [];
  for (const target of listingTargets) {
    const entry = policy.signed.targets[target];
    if (entry === undefined) continue;
    const digest = isRecord(entry) && isRecord(entry.hashes) ? entry.hashes.sha256 : undefined;
    const length = isRecord(entry) ? entry.length : undefined;
    if (typeof digest !== "string" || typeof length !== "number")
      throw new Error(`pin ${pin.name} listing descriptor is malformed`);
    const file = `targets/${digest}.${target}`;
    const bytes = show(repository, `${pin.pages_commit}:catalog/${file}`, 8 * 1024 ** 2);
    if (bytes.length !== length || createHash("sha256").update(bytes).digest("hex") !== digest)
      throw new Error(`pin ${pin.name} listing body differs from its signed descriptor`);
    bodies.push({ path: file, sha256: digest, bytes: length });
  }
  return {
    name: pin.name,
    pages_commit: pin.pages_commit,
    policy_version: pin.policy_version,
    bodies,
  };
}

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { pins: { type: "string" }, repository: { type: "string" } },
  });
  const pins = readPublicationPins(values.pins ?? publicationPinsFile);
  if (positionals[0] === "check") {
    console.log(`${pins.length} catalog publication pins are well formed.`);
  } else if (positionals[0] === "verify" && values.repository) {
    for (const pin of pins)
      console.log(JSON.stringify(verifyPublicationPin(path.resolve(values.repository), pin)));
  } else {
    throw new Error(
      "usage: catalog-publication-pins.mts check|verify --repository <gh-pages clone> [--pins <file>]",
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
