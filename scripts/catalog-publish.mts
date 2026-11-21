// Catalog publication (#246, owner decision 2026-11-15 on #534). Prepares the
// keyless inputs for `portcove-release-tools` so that `catalog-publish.yml` can
// sign each online catalog role in its own environment, assemble the complete
// repository without keys and publish it under `gh-pages/catalog/`.
//
// The compiled root (`crates/portcove-core/catalog/official-definition-root.json`)
// and the owner's offline Targets stay authoritative; this script only writes
// configuration. Every signer and the assembler re-verify all inputs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";
import { decodeTufRoleKey } from "./tuf-role-key.mts";
import {
  compactListingDeliveryTarget,
  listingDeliveryTarget,
} from "./listing-directory-carrier.mts";

export const onlineRoles = [
  "official-definitions",
  "official-policy",
  "snapshot",
  "timestamp",
] as const;
export type OnlineRole = (typeof onlineRoles)[number];
type Four<T> = { definitions: T; policy: T; snapshot: T; timestamp: T };

/** Role lifetimes stay below the release tool's ceilings (7 days, 1 day for timestamp). */
const margin = 10 * 60 * 1000;
const day = 24 * 60 * 60 * 1000;

export type Plan = {
  schema_version: 1;
  planned_at: string;
  versions: Four<number>;
  expires: Four<string>;
  prior: boolean;
};

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function positive(value: unknown, what: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`prior catalog ${what} version is not a positive integer`);
  return value;
}

/** Current online role versions of a published catalog site, or null when none exists. */
export function priorVersions(site: string | null): Four<number> | null {
  if (!site || !existsSync(path.join(site, "metadata", "timestamp.json"))) return null;
  const timestamp = readJson(path.join(site, "metadata", "timestamp.json"));
  if (!isRecord(timestamp) || !isRecord(timestamp.signed) || !isRecord(timestamp.signed.meta))
    throw new Error("prior catalog timestamp is malformed");
  const snapshotMeta = timestamp.signed.meta["snapshot.json"];
  if (!isRecord(snapshotMeta)) throw new Error("prior catalog timestamp names no snapshot");
  const snapshotVersion = positive(snapshotMeta.version, "snapshot");
  const snapshot = readJson(path.join(site, "metadata", `${snapshotVersion}.snapshot.json`));
  if (!isRecord(snapshot) || !isRecord(snapshot.signed) || !isRecord(snapshot.signed.meta))
    throw new Error("prior catalog snapshot is malformed");
  const meta = snapshot.signed.meta;
  const role = (name: string) => {
    const entry = meta[`${name}.json`];
    if (!isRecord(entry)) throw new Error(`prior catalog snapshot names no ${name}`);
    return positive(entry.version, name);
  };
  return {
    definitions: role("official-definitions"),
    policy: role("official-policy"),
    snapshot: snapshotVersion,
    timestamp: positive(timestamp.signed.version, "timestamp"),
  };
}

/**
 * Every run re-signs all four online roles at the next version: equal-version
 * changed content is refused by the tool, and the daily renewal needs fresh
 * expiries anyway. A first publication starts every role at version one.
 */
export function planPublication(prior: Four<number> | null, now: Date): Plan {
  const at = now.getTime();
  const next = (value: number | undefined) => (value === undefined ? 1 : value + 1);
  const week = new Date(at + 7 * day - margin).toISOString();
  return {
    schema_version: 1,
    planned_at: now.toISOString(),
    versions: {
      definitions: next(prior?.definitions),
      policy: next(prior?.policy),
      snapshot: next(prior?.snapshot),
      timestamp: next(prior?.timestamp),
    },
    expires: {
      definitions: week,
      policy: week,
      snapshot: week,
      timestamp: new Date(at + day - margin).toISOString(),
    },
    prior: prior !== null,
  };
}

function readPlan(work: string): Plan {
  const plan = readJson(path.join(work, "plan.json"));
  if (!isRecord(plan) || plan.schema_version !== 1) throw new Error("catalog plan is malformed");
  return plan as Plan;
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Core's machine envelope for `catalog inspect-definition-publication`, reduced to its report. */
export function inspectionReport(stdout: string): string {
  const envelope: unknown = JSON.parse(stdout);
  if (
    !isRecord(envelope) ||
    envelope.ok !== true ||
    envelope.error !== null ||
    envelope.command !== "catalog.inspect-definition-publication" ||
    !isRecord(envelope.data)
  )
    throw new Error("catalog inspection did not succeed");
  return `${JSON.stringify(envelope.data)}\n`;
}

/**
 * The shared signing context, written fresh by every job: the tool requires its
 * generation time within five minutes of now, while versions and expiries come
 * from the one plan so every role signs the same repository.
 */
export function contextConfig(work: string, now: Date) {
  const plan = readPlan(work);
  return {
    schema_version: 1,
    initial_root_profile: "single-owner-one-of-one-v1",
    generated_at: now.toISOString(),
    trusted_root: "root.json",
    trusted_root_sha256: sha256(path.join(work, "root.json")),
    offline_targets: "offline-targets.json",
    offline_targets_sha256: sha256(path.join(work, "offline-targets.json")),
    prepared_bundle: "bundle",
    inspection: "inspection.json",
    inspection_sha256: sha256(path.join(work, "inspection.json")),
    previous_repository: plan.prior ? "prior" : null,
    versions: plan.versions,
    expires: plan.expires,
  };
}

export function signConfig(role: OnlineRole, keyFile: string) {
  return {
    schema_version: 1,
    context: "context.json",
    signing_key: keyFile,
    ...(role === "snapshot" || role === "timestamp" ? { signed_roles: "roles" } : {}),
    output: `roles/${role}.json`,
  };
}

export const assemblyConfig = {
  schema_version: 1,
  context: "context.json",
  signed_roles: "roles",
  output: "repository",
};

/** Visitor pages are not TUF repository inputs. Preserve the existing prior
 * repository files while keeping the whole site's digest as the write guard. */
export function copyPriorRepository(site: string, output: string) {
  mkdirSync(output, { recursive: true });
  for (const name of readdirSync(site)) {
    if (name === "browse") continue;
    cpSync(path.join(site, name), path.join(output, name), { recursive: true });
  }
}

function write(file: string, value: unknown) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Sorted relative file list with digests, used to detect a concurrent catalog change. */
export function treeDigest(directory: string): string {
  const entries: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else
        entries.push(`${path.relative(directory, full).split(path.sep).join("/")} ${sha256(full)}`);
    }
  };
  walk(directory);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

/** Bundle files as `{target: sha256}`. */
export function bundleTargets(bundle: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files[path.relative(bundle, full).split(path.sep).join("/")] = sha256(full);
    }
  };
  walk(bundle);
  return files;
}

/** Targets the published site currently serves through its delegated roles. */
export function publishedTargets(site: string): Record<string, string> {
  const versions = priorVersions(site);
  if (!versions) return {};
  const files: Record<string, string> = {};
  for (const [role, version] of [
    ["official-definitions", versions.definitions],
    ["official-policy", versions.policy],
  ] as const) {
    const signed = readJson(path.join(site, "metadata", `${version}.${role}.json`));
    if (!isRecord(signed) || !isRecord(signed.signed) || !isRecord(signed.signed.targets))
      throw new Error(`prior catalog ${role} is malformed`);
    for (const [name, entry] of Object.entries(signed.signed.targets)) {
      const digest = isRecord(entry) && isRecord(entry.hashes) ? entry.hashes.sha256 : undefined;
      if (typeof digest !== "string") throw new Error(`prior catalog ${role} target is malformed`);
      files[name] = digest;
    }
  }
  return files;
}

export function sameTargets(a: Record<string, string>, b: Record<string, string>) {
  const keys = Object.keys(a).sort();
  return keys.join("\n") === Object.keys(b).sort().join("\n") && keys.every((k) => a[k] === b[k]);
}

/** The sole dynamic descriptive target is derived after the conditional build.
 * Scheduled/manual publications refresh its existing observer input; canonical
 * input changes are also detected by the public-catalog source fingerprint. */
export function sameStaticPublicationTargets(
  bundle: Record<string, string>,
  published: Record<string, string>,
) {
  const previous = { ...published };
  for (const target of [listingDeliveryTarget, compactListingDeliveryTarget])
    if (!Object.hasOwn(bundle, target)) delete previous[target];
  return sameTargets(bundle, previous);
}

/** True when the published timestamp is absent or expires within `hours`. */
export function renewalDue(site: string | null, now: Date, hours: number) {
  if (!site || !existsSync(path.join(site, "metadata", "timestamp.json"))) return true;
  const timestamp = readJson(path.join(site, "metadata", "timestamp.json"));
  const expires =
    isRecord(timestamp) && isRecord(timestamp.signed) ? timestamp.signed.expires : undefined;
  const at = typeof expires === "string" ? Date.parse(expires) : Number.NaN;
  if (!Number.isFinite(at)) throw new Error("prior catalog timestamp expiry is malformed");
  return at - now.getTime() < hours * 60 * 60 * 1000;
}

/** The newest first-parent `main` commit whose newest `CI` push run succeeded. */
export function newestGreen(history: readonly string[], conclusion: (sha: string) => string) {
  return history.find((sha) => conclusion(sha) === "success") ?? null;
}

function flag(args: string[], name: string) {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

async function main(argv: string[]) {
  const [command, ...args] = argv;
  if (command === "green-main") {
    // Scheduled and manual runs publish the newest CI-green main commit.
    const token = process.env.GH_TOKEN;
    if (!token) throw new Error("GH_TOKEN is required");
    const { mainCiConclusion, mainCiConclusions } = await import("./app-release.mts");
    const history = execFileSync(
      "git",
      ["rev-list", "--first-parent", "-n", "100", "origin/main"],
      {
        encoding: "utf8",
      },
    )
      .split("\n")
      .filter(Boolean);
    const conclusions = await mainCiConclusions(token);
    const commit = newestGreen(history, (sha) => mainCiConclusion(conclusions, sha));
    if (!commit) throw new Error("no CI-green commit among the latest 100 main commits");
    console.log(`commit=${commit}`);
  } else if (command === "prepare") {
    // Copies the compiled root, offline Targets, bundle, inspection and prior site
    // into one work directory and plans the next versions.
    const work = path.resolve(flag(args, "work"));
    const prior = flag(args, "prior");
    mkdirSync(path.join(work, "roles"), { recursive: true });
    cpSync(flag(args, "root"), path.join(work, "root.json"));
    cpSync(flag(args, "offline-targets"), path.join(work, "offline-targets.json"));
    cpSync(flag(args, "bundle"), path.join(work, "bundle"), { recursive: true });
    writeFileSync(
      path.join(work, "inspection.json"),
      inspectionReport(readFileSync(flag(args, "inspection-stdout"), "utf8")),
    );
    const site = prior === "none" || !existsSync(prior) ? null : prior;
    const versions = priorVersions(site);
    if (versions) copyPriorRepository(site!, path.join(work, "prior"));
    if (versions && existsSync(path.join(site!, "browse")))
      cpSync(path.join(site!, "browse"), path.join(work, "prior-browse"), { recursive: true });
    const plan = planPublication(versions, new Date());
    write(path.join(work, "plan.json"), plan);
    write(path.join(work, "context.json"), contextConfig(work, new Date()));
    console.log(`prior_digest=${treeDigest(site ?? path.join(work, "absent"))}`);
    console.error(`Catalog plan: ${JSON.stringify(plan.versions)} (prior site: ${plan.prior})`);
  } else if (command === "sign-config") {
    const work = path.resolve(flag(args, "work"));
    const role = flag(args, "role") as OnlineRole;
    if (!onlineRoles.includes(role)) throw new Error(`unknown catalog role ${role}`);
    // Artifacts drop empty directories, so the first signers recreate roles/.
    mkdirSync(path.join(work, "roles"), { recursive: true });
    write(path.join(work, "context.json"), contextConfig(work, new Date()));
    write(path.join(work, `sign-${role}.json`), signConfig(role, path.resolve(flag(args, "key"))));
  } else if (command === "assembly-config") {
    const work = path.resolve(flag(args, "work"));
    write(path.join(work, "context.json"), contextConfig(work, new Date()));
    write(path.join(work, "assembly.json"), assemblyConfig);
  } else if (command === "unchanged") {
    // Compare fixed reviewed inputs; the sole derived listing target refreshes on the existing cadence.
    const site = flag(args, "prior");
    const published = site === "none" || !existsSync(site) ? {} : publishedTargets(site);
    console.log(
      String(sameStaticPublicationTargets(bundleTargets(flag(args, "bundle")), published)),
    );
  } else if (command === "renewal-due") {
    const site = flag(args, "prior");
    console.log(
      String(renewalDue(site === "none" ? null : site, new Date(), Number(flag(args, "hours")))),
    );
  } else if (command === "write-key") {
    // The role secret becomes a private key file readable only by this job's user.
    const raw = process.env[flag(args, "env")];
    if (!raw) throw new Error("catalog role key is unavailable in this job");
    const key = decodeTufRoleKey(raw);
    writeFileSync(flag(args, "out"), key, { flag: "wx", mode: 0o600 });
    key.fill(0);
  } else if (command === "tree-digest") {
    console.log(treeDigest(path.resolve(flag(args, "dir"))));
  } else {
    throw new Error(
      "usage: catalog-publish.mts green-main|prepare|unchanged|renewal-due|sign-config|write-key|assembly-config|tree-digest",
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
