import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  type LedgerEntry,
  type RetainBodies,
  type WindowReport,
  formatWindowReport,
  isListingBody,
  ledgerExtends,
  listingFloorLedgerMaximumBytes,
  listingFloorLedgerPath,
  parseLedger,
  planBodyWindow,
  readPolicyHistory,
  retainBodies,
  retainedRepositoryBound,
  retainedRepositoryBytes,
  servedPolicyVersion,
} from "./catalog-body-window.mts";
import { type PublicationPin, readPublicationPins } from "./catalog-publication-pins.mts";
import { inventoryDigest, treeInventory } from "./catalog-publish.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { isRecord } from "./runtime-values.mts";

const digest = /^[0-9a-f]{64}$/u;
const versionedMetadata =
  /^metadata\/[1-9][0-9]*\.(?:root|targets|snapshot|official-definitions|official-policy)\.json$/u;
const targetPath =
  /^targets\/[0-9a-f]{64}\.(?:definitions\/index\.json|sha256\/[0-9a-f]{64}\.json|policy\/official\/[a-z0-9][a-z0-9.-]*\.json)$/u;
const timestamp = "metadata/timestamp.json";
const maximumRepositoryBytes = 768 * 1024 ** 2;
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

function assembledInventory(report: unknown) {
  if (
    !isRecord(report) ||
    report.schema_version !== 1 ||
    report.authority !== "none" ||
    !Array.isArray(report.files) ||
    report.files.length > 65_536
  )
    throw new Error("catalog assembly inventory exceeds its supported bounds");
  const identities = new Map<string, { target: string; bytes: number; sha256: string }>();
  let totalBytes = 0;
  for (const row of report.files as unknown[]) {
    if (
      !isRecord(row) ||
      typeof row.target !== "string" ||
      row.target.length > 512 ||
      (row.target !== timestamp &&
        !versionedMetadata.test(row.target) &&
        !targetPath.test(row.target)) ||
      typeof row.bytes !== "number" ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes <= 0 ||
      typeof row.sha256 !== "string" ||
      !digest.test(row.sha256) ||
      (row.target.startsWith("targets/") && row.target.slice(8, 72) !== row.sha256) ||
      identities.has(row.target)
    )
      throw new Error("catalog assembly inventory has an invalid or duplicate file");
    totalBytes += row.bytes;
    if (totalBytes > maximumRepositoryBytes)
      throw new Error("catalog assembly inventory exceeds its byte bound");
    identities.set(row.target, { target: row.target, bytes: row.bytes, sha256: row.sha256 });
  }
  if (
    identities.get(timestamp)?.sha256 !== report.timestamp_sha256 ||
    !identities.has(timestamp) ||
    sha256(JSON.stringify([...identities.values()])) !== report.repository_sha256
  )
    throw new Error("catalog assembly inventory differs from its verified receipt");
  return identities;
}

/** The assembled ledger, bound to the verified assembly receipt. */
async function assembledLedger(report: unknown, file: string | undefined) {
  const identity = isRecord(report) ? report.listing_floor_ledger : undefined;
  if (
    !file ||
    !isRecord(identity) ||
    typeof identity.sha256 !== "string" ||
    !digest.test(identity.sha256) ||
    typeof identity.bytes !== "number" ||
    !Number.isSafeInteger(identity.bytes) ||
    identity.bytes < 1 ||
    identity.bytes > listingFloorLedgerMaximumBytes
  )
    throw new Error("catalog assembly receipt carries no listing-floor ledger");
  const bytes = await readControllerToolFile(file, identity.bytes);
  if (bytes.length !== identity.bytes || sha256(bytes) !== identity.sha256)
    throw new Error("catalog listing-floor ledger differs from its verified receipt");
  return { bytes, entries: parseLedger(bytes) };
}

export type OverlayRetention = {
  mode: RetainBodies;
  /** The ledger written by this run's assembly (required unless `all`). */
  ledger?: string | undefined;
  pins?: readonly PublicationPin[];
  /** Checkpointed history is active for this run. */
  historyMode?: boolean;
};

/** Preserve immutable files from the exact guarded prior Pages tree. Every
 * added file is rebound to the locally assembled repository receipt. With
 * retention `ledger` the run's verified listing-floor ledger is served; with
 * `window` superseded listing bodies leave the served tree as well. */
export async function overlayCatalogPages(
  prior: string,
  priorDigest: string,
  repository: string,
  report: unknown,
  retention: OverlayRetention = { mode: "all" },
) {
  const assembled = assembledInventory(report);
  const baseline = treeInventory(prior);
  if (inventoryDigest(baseline) !== priorDigest)
    throw new Error("gh-pages catalog/ changed since this run read it");
  for (const name of baseline.keys()) {
    if (!name.startsWith("browse/") && name !== listingFloorLedgerPath && !assembled.has(name))
      throw new Error(`assembled catalog omits retained file: ${name}`);
  }
  const ledger = retention.mode === "all" ? null : await assembledLedger(report, retention.ledger);
  const publishedLedger =
    ledger && baseline.has(listingFloorLedgerPath)
      ? parseLedger(readFileSync(path.join(prior, listingFloorLedgerPath)))
      : null;
  if (ledger && publishedLedger && !ledgerExtends(ledger.entries, publishedLedger))
    throw new Error("catalog listing-floor ledger would not extend the published ledger");
  const changed: string[] = [];
  let retainedBytes = 0;
  let writtenBytes = 0;
  for (const [name, identity] of assembled) {
    const existing = baseline.get(name);
    if (existing?.sha256 === identity.sha256 && existing.bytes === identity.bytes) {
      retainedBytes += existing.bytes;
      continue;
    }
    if (existing && name !== timestamp)
      throw new Error(`assembled catalog replaces an immutable file: ${name}`);
    changed.push(name);
  }
  const browse = path.join(repository, "browse");
  if (!lstatSync(browse).isDirectory()) throw new Error("assembled catalog browse is unavailable");
  for (const name of changed) {
    const expected = assembled.get(name)!;
    const bytes = await readControllerToolFile(path.join(repository, name), expected.bytes);
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256)
      throw new Error(`assembled catalog file differs from receipt: ${name}`);
    const destination = path.join(prior, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, bytes, { flag: baseline.has(name) ? "w" : "wx" });
    writtenBytes += bytes.length;
  }
  const priorBrowse = path.join(prior, "browse");
  rmSync(priorBrowse, { recursive: true, force: true });
  cpSync(browse, priorBrowse, { recursive: true, errorOnExist: true, force: false });
  if (ledger && baseline.get(listingFloorLedgerPath)?.sha256 !== sha256(ledger.bytes)) {
    const destination = path.join(prior, listingFloorLedgerPath);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, ledger.bytes);
    changed.push(listingFloorLedgerPath);
  }
  const removed: string[] = [];
  const served = new Map(
    [...assembled].map(([name, file]) => [name, { sha256: file.sha256, bytes: file.bytes }]),
  );
  const retention_report = retentionReport(retention, ledger, served);
  if (ledger && retention.mode === "window") {
    const previous = baseline.has("metadata/timestamp.json")
      ? servedPolicyVersion((file) =>
          JSON.parse(readFileSync(path.join(prior, "metadata", file), "utf8")),
        )
      : null;
    const plan = planBodyWindow({
      policies: readPolicyHistory(repository),
      previous,
      pins: retention.pins ?? [],
      publishedLedger,
      nextLedger: ledger.entries,
      served: new Map([...served].filter(([name]) => baseline.has(name))),
      historyMode: retention.historyMode ?? false,
    });
    retention_report.refused = plan.refused;
    retention_report.held = plan.held;
    for (const body of plan.refused ? [] : plan.prune) {
      const file = path.join(prior, body.path);
      if (!existsSync(file) || lstatSync(file).size !== body.bytes)
        throw new Error(`catalog body to prune differs from the plan: ${body.path}`);
      rmSync(file);
      served.delete(body.path);
      removed.push(body.path);
      retention_report.pruned.bodies += 1;
      retention_report.pruned.bytes += body.bytes;
    }
    const kept = [...served].filter(([name]) => isListingBody(name));
    retention_report.kept = {
      bodies: kept.length,
      bytes: kept.reduce((sum, [, file]) => sum + file.bytes, 0),
    };
    retention_report.retained_repository_bytes = retainedRepositoryBytes(served);
  }
  return { changed, removed, retainedBytes, writtenBytes, retention: retention_report };
}

function retentionReport(
  retention: OverlayRetention,
  ledger: { bytes: Buffer; entries: LedgerEntry[] } | null,
  served: ReadonlyMap<string, { sha256: string; bytes: number }>,
): WindowReport {
  const kept = [...served].filter(([name]) => isListingBody(name));
  return {
    mode: retention.mode,
    ledger: ledger
      ? { entries: ledger.entries.length, bytes: ledger.bytes.length, sha256: sha256(ledger.bytes) }
      : null,
    kept: { bodies: kept.length, bytes: kept.reduce((sum, [, file]) => sum + file.bytes, 0) },
    pruned: { bodies: 0, bytes: 0 },
    held: [],
    refused: retention.mode === "window" ? null : "retention is not the body window",
    retained_repository_bytes: retainedRepositoryBytes(served),
    retained_repository_bound: retainedRepositoryBound,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      site: { type: "string" },
      prior: { type: "string" },
      repository: { type: "string" },
      receipt: { type: "string" },
      "retain-bodies": { type: "string" },
      ledger: { type: "string" },
      pins: { type: "string" },
      "history-mode": { type: "string" },
      report: { type: "string" },
    },
  });
  const { site, prior, repository, receipt } = values;
  const mode = retainBodies(values["retain-bodies"]);
  if (!site || !prior || !repository || !receipt || !digest.test(prior))
    throw new Error(
      "catalog Pages overlay requires the worktree, prior digest, and assembly inputs",
    );
  const report: unknown = JSON.parse(
    (await readControllerToolFile(receipt, 48 * 1024 ** 2)).toString("utf8"),
  );
  const { changed, removed, retainedBytes, writtenBytes, retention } = await overlayCatalogPages(
    path.join(site, "catalog"),
    prior,
    repository,
    report,
    {
      mode,
      ledger: values.ledger,
      pins: mode === "window" ? readPublicationPins(values.pins ?? "") : [],
      historyMode: !!values["history-mode"],
    },
  );
  execFileSync(
    "git",
    [
      "--literal-pathspecs",
      "-C",
      site,
      "add",
      "-A",
      "--pathspec-from-file=-",
      "--pathspec-file-nul",
    ],
    {
      input:
        [...changed, ...removed]
          .map((name) => `catalog/${name}`)
          .concat("catalog/browse")
          .join("\0") + "\0",
    },
  );
  console.log(
    `Catalog staged ${changed.length} repository files (${writtenBytes} bytes); retained ${retainedBytes} bytes.`,
  );
  for (const line of formatWindowReport(retention)) console.log(line);
  if (values.report) writeFileSync(values.report, `${JSON.stringify(retention, null, 2)}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary)
    appendFileSync(
      summary,
      `${formatWindowReport(retention)
        .map((line) => `- ${line}`)
        .join("\n")}\n`,
    );
}
