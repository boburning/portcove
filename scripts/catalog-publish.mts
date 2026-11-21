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
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
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
  history?: "bootstrap" | "segmented";
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
    ...(plan.history === "bootstrap" ? { bootstrap_history: true } : {}),
    ...(plan.history === "segmented" ? { history_store: "history" } : {}),
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

const historyTarget = "policy/official/catalog.history-checkpoint.json";
const hashPattern = /^[a-f0-9]{64}$/u;
const publicPath = /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/u;

function historyObject(identity: unknown, source: string, destination: string, limit: number) {
  if (
    !isRecord(identity) ||
    typeof identity.bytes !== "number" ||
    !Number.isSafeInteger(identity.bytes) ||
    identity.bytes < 1 ||
    identity.bytes > limit ||
    typeof identity.sha256 !== "string" ||
    !hashPattern.test(identity.sha256)
  )
    throw new Error("catalog history object identity is outside its bound");
  const name = `sha256/${identity.sha256}.json`;
  const file = path.join(source, name);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size !== identity.bytes || sha256(file) !== identity.sha256)
    throw new Error("catalog history object differs from its expected identity");
  mkdirSync(path.join(destination, "sha256"), { recursive: true });
  copyFileSync(file, path.join(destination, name));
  return readJson(file);
}

/** Thin transport for independent signers. Rust reauthenticates every copied
 * role/active target and checks the checkpoint before touching a role key. */
export function limitSignerHistory(work: string) {
  if (readPlan(work).history !== "segmented") return;
  const prior = path.join(work, "prior");
  const thin = path.join(work, "thin-prior");
  const history = path.join(work, "history");
  const thinHistory = path.join(work, "thin-history");
  const versions = priorVersions(prior);
  const root = readJson(path.join(work, "root.json"));
  const version = isRecord(root) && isRecord(root.signed) ? root.signed.version : undefined;
  if (!versions || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1)
    throw new Error("catalog thin prior requires exact current role versions");
  const snapshot = readJson(path.join(prior, "metadata", `${versions.snapshot}.snapshot.json`));
  const targetsMeta =
    isRecord(snapshot) && isRecord(snapshot.signed) && isRecord(snapshot.signed.meta)
      ? snapshot.signed.meta["targets.json"]
      : null;
  if (!isRecord(targetsMeta)) throw new Error("catalog thin prior is missing the top-level role");
  const targetsVersion = positive(targetsMeta.version, "targets");
  const files = [
    "metadata/timestamp.json",
    `metadata/${version}.root.json`,
    `metadata/${targetsVersion}.targets.json`,
    `metadata/${versions.snapshot}.snapshot.json`,
    `metadata/${versions.policy}.official-policy.json`,
    `metadata/${versions.definitions}.official-definitions.json`,
  ];
  const targets = publishedTargets(prior);
  const pointerHash = targets[historyTarget];
  if (!pointerHash || !hashPattern.test(pointerHash))
    throw new Error("checkpointed catalog is missing its signed history pointer");
  if (Object.keys(targets).length > 4096)
    throw new Error("catalog thin target count exceeds bound");
  for (const [name, digest] of Object.entries(targets)) {
    if (
      !hashPattern.test(digest) ||
      !publicPath.test(name) ||
      name.split("/").some((part) => part === "." || part === "..")
    )
      throw new Error("catalog thin target path is invalid");
    files.push(`targets/${digest}.${name}`);
  }
  const pointerPath = path.join(prior, `targets/${pointerHash}.${historyTarget}`);
  const pointerFile = lstatSync(pointerPath);
  if (!pointerFile.isFile() || pointerFile.size > 4096 || sha256(pointerPath) !== pointerHash)
    throw new Error("catalog history pointer differs from its policy target");
  const pointer = readJson(pointerPath);
  if (!isRecord(pointer)) throw new Error("catalog history pointer is unreadable");
  const active = historyObject(pointer.active, history, thinHistory, 2 * 1024 * 1024);
  if (!isRecord(active)) throw new Error("catalog history active checkpoint is unreadable");
  historyObject(active.tip, history, thinHistory, 1024 * 1024);
  let bytes = 0;
  for (const file of files) {
    const source = path.join(prior, file);
    const stat = lstatSync(source);
    bytes += stat.size;
    if (!stat.isFile() || bytes > 64 * 1024 * 1024)
      throw new Error("catalog thin prior exceeds its regular-file bound");
    const destination = path.join(thin, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  for (const [original, replacement] of [
    [prior, thin],
    [history, thinHistory],
  ] as const) {
    const full = `${original}-verified-full`;
    renameSync(original, full);
    renameSync(replacement, original);
    rmSync(full, { recursive: true });
  }
}

export function stageHistoryObjects(source: string, destination: string, priorDigest: string) {
  if (treeDigest(destination) !== priorDigest)
    throw new Error("gh-pages catalog-history/ changed since this run read it");
  if (!existsSync(source)) return [];
  const objects = treeInventory(source);
  for (const [name, object] of objects) {
    if (name !== `sha256/${object.sha256}.json` || object.bytes > 2 * 1024 * 1024)
      throw new Error("assembled catalog history object exceeds its immutable bounds");
  }
  const changed: string[] = [];
  for (const [name, object] of objects) {
    const output = path.join(destination, name);
    if (existsSync(output)) {
      if (!lstatSync(output).isFile() || sha256(output) !== object.sha256)
        throw new Error("published catalog history object cannot be replaced");
      continue;
    }
    mkdirSync(path.dirname(output), { recursive: true });
    copyFileSync(path.join(source, name), output);
    changed.push(name);
  }
  return changed;
}

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
export function treeInventory(directory: string) {
  const files = new Map<string, { sha256: string; bytes: number }>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = lstatSync(full);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile())
        files.set(path.relative(directory, full).split(path.sep).join("/"), {
          sha256: sha256(full),
          bytes: stat.size,
        });
      else throw new Error("catalog site inventory contains a nonregular file");
    }
  };
  if (existsSync(directory)) {
    if (!lstatSync(directory).isDirectory()) throw new Error("catalog site is not a directory");
    walk(directory);
  }
  return files;
}

export function inventoryDigest(files: ReturnType<typeof treeInventory>): string {
  const entries = [...files].map(([name, file]) => `${name} ${file.sha256}`);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

export function treeDigest(directory: string): string {
  return inventoryDigest(treeInventory(directory));
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
  delete previous[historyTarget];
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
    const history = site
      ? path.join(path.dirname(site), "catalog-history")
      : path.join(work, "absent");
    const checkpoint = site && versions && Object.hasOwn(publishedTargets(site), historyTarget);
    if (checkpoint) {
      if (!existsSync(history)) throw new Error("checkpointed catalog history archive is missing");
      cpSync(history, path.join(work, "history"), { recursive: true });
      plan.history = "segmented";
    } else if (site && versions && args.includes("--bootstrap-history")) {
      if (existsSync(history))
        throw new Error("catalog history has objects without an authenticated pointer");
      plan.history = "bootstrap";
    }
    write(path.join(work, "plan.json"), plan);
    console.log(`history_mode=${plan.history ?? "legacy"}`);
    console.log(`prior_history_digest=${treeDigest(history)}`);
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
    write(path.join(work, "assembly.json"), {
      ...assemblyConfig,
      ...(readPlan(work).history ? { history_output: "repository-history" } : {}),
    });
  } else if (command === "limit-signer-history") {
    limitSignerHistory(path.resolve(flag(args, "work")));
  } else if (command === "restore-history") {
    const work = path.resolve(flag(args, "work"));
    if (readPlan(work).history !== "segmented")
      throw new Error("catalog restore requires segmented signing inputs");
    const site = path.resolve(flag(args, "site"));
    const history = path.join(site, "catalog-history");
    if (
      treeDigest(path.join(site, "catalog")) !== flag(args, "prior") ||
      treeDigest(history) !== flag(args, "prior-history")
    )
      throw new Error("pinned catalog history differs from the guarded preparation");
    copyPriorRepository(path.join(site, "catalog"), path.join(work, "prior"));
    cpSync(history, path.join(work, "history"), { recursive: true });
  } else if (command === "stage-history") {
    const site = path.resolve(flag(args, "site"));
    const work = path.resolve(flag(args, "work"));
    const changed = stageHistoryObjects(
      path.join(work, "repository-history"),
      path.join(site, "catalog-history"),
      flag(args, "prior-history"),
    );
    if (changed.length)
      execFileSync("git", [
        "--literal-pathspecs",
        "-C",
        site,
        "add",
        "--",
        ...changed.map((file) => `catalog-history/${file}`),
      ]);
  } else if (command === "history-readback") {
    const work = path.resolve(flag(args, "work"));
    if (!readPlan(work).history) return;
    const repository = path.join(work, "repository");
    const pointer = publishedTargets(repository)[historyTarget];
    if (!pointer || !hashPattern.test(pointer))
      throw new Error("assembled catalog has no exact history pointer");
    console.log(`catalog/targets/${pointer}.${historyTarget} ${pointer} 4096`);
    const objects = treeInventory(path.join(work, "repository-history"));
    if (!objects.size || objects.size > 64)
      throw new Error("assembled catalog history is outside its live-readback bound");
    for (const [name, entry] of objects) {
      if (name !== `sha256/${entry.sha256}.json` || entry.bytes > 2 * 1024 * 1024)
        throw new Error("assembled catalog history object exceeds its immutable bounds");
      console.log(`catalog-history/${name} ${entry.sha256} ${entry.bytes}`);
    }
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
