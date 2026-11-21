import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
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

/** Preserve immutable files from the exact guarded prior Pages tree. Every
 * added file is rebound to the locally assembled repository receipt. */
export async function overlayCatalogPages(
  prior: string,
  priorDigest: string,
  repository: string,
  report: unknown,
) {
  const assembled = assembledInventory(report);
  const baseline = treeInventory(prior);
  if (inventoryDigest(baseline) !== priorDigest)
    throw new Error("gh-pages catalog/ changed since this run read it");
  for (const name of baseline.keys()) {
    if (!name.startsWith("browse/") && !assembled.has(name))
      throw new Error(`assembled catalog omits retained file: ${name}`);
  }
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
  return { changed, retainedBytes, writtenBytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      site: { type: "string" },
      prior: { type: "string" },
      repository: { type: "string" },
      receipt: { type: "string" },
    },
  });
  const { site, prior, repository, receipt } = values;
  if (!site || !prior || !repository || !receipt || !digest.test(prior))
    throw new Error(
      "catalog Pages overlay requires the worktree, prior digest, and assembly inputs",
    );
  const report: unknown = JSON.parse(
    (await readControllerToolFile(receipt, 48 * 1024 ** 2)).toString("utf8"),
  );
  const { changed, retainedBytes, writtenBytes } = await overlayCatalogPages(
    path.join(site, "catalog"),
    prior,
    repository,
    report,
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
    { input: [...changed.map((name) => `catalog/${name}`), "catalog/browse"].join("\0") + "\0" },
  );
  console.log(
    `Catalog staged ${changed.length} repository files (${writtenBytes} bytes); retained ${retainedBytes} bytes.`,
  );
}
