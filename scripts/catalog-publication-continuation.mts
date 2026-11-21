import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  describeCatalogPublication,
  LateReadbackFailure,
  verifyCatalogPublicationLive,
  type HistoryReadback,
} from "./catalog-publication-receipt.mts";
import { errorMessage, isRecord } from "./runtime-values.mts";

const gitOid = /^[a-f0-9]{40}$/u;
const digest = /^[a-f0-9]{64}$/u;
const bot = "41898282+github-actions[bot]@users.noreply.github.com";
const mib = 1024 ** 2;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

type Observer = { run: string; attempt: string };
type ReadCatalog = (relative: string, maximum: number) => Promise<Buffer>;

function git(site: string, args: string[], maximum = 4096, allowMissing = false) {
  const result = spawnSync("git", args, {
    cwd: site,
    timeout: 5000,
    maxBuffer: maximum,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" },
  });
  if (!result.error && allowMissing && result.status === 1) return null;
  if (result.status !== 0 || result.error || result.stdout.length > maximum)
    throw new Error("Pinned Pages Git read was unavailable or exceeded its bound");
  return result.stdout;
}

function oid(value: string | undefined) {
  if (!gitOid.test(value ?? "")) throw new Error("Pinned Pages Git identity is invalid");
  return value!;
}

function checkoutTip(site: string) {
  return oid(git(site, ["rev-parse", "--verify", "HEAD"])!.toString("utf8").trim());
}

function identity(site: string, tip: string) {
  const result = git(site, [
    "log",
    "--first-parent",
    "-1",
    "--format=%H%n%P%n%ae%n%ce%n%s",
    tip,
    "--",
    "catalog/metadata/timestamp.json",
  ])!
    .toString("utf8")
    .trim();
  if (!result) return null;
  const [commit, previous, author, committer, subject, extra] = result.split("\n");
  const source = /^Publish the official catalog from ([a-f0-9]{40})$/u.exec(subject ?? "")?.[1];
  if (extra || !source || author !== bot || committer !== bot)
    throw new Error("Latest catalog timestamp did not come from the ordinary Pages publisher");
  const pagesCommit = oid(commit);
  const parent = oid(previous);
  // An application-only Pages commit may follow the catalog commit. Its catalog
  // tree must still be byte-identical to the earlier publisher's complete tree.
  const tree = (revision: string) =>
    oid(
      git(site, ["rev-parse", "--verify", `${revision}:catalog`])!
        .toString("utf8")
        .trim(),
    );
  const catalogTree = tree(pagesCommit);
  const history = (revision: string) =>
    git(site, ["ls-tree", revision, "--", "catalog-history"])!.toString("utf8");
  const historyTree = history(pagesCommit);
  if (tree(tip) !== catalogTree || history(tip) !== historyTree)
    throw new Error("Pages catalog changed outside the timestamp publication");
  if (
    git(site, ["merge-base", "--is-ancestor", source, "refs/remotes/origin/main"], 4096, true) ===
    null
  )
    throw new Error("Pages source is outside the maintained main history");
  return { pagesCommit, parent, source, catalogTree, hasHistory: historyTree.length > 0 };
}

function pinnedCatalog(site: string, commit: string, prefix = "catalog"): ReadCatalog {
  let calls = 0;
  let remaining = 128 * mib;
  return (relative, maximum) => {
    if (++calls > 1024 || maximum < 1 || remaining < 1)
      throw new Error("Pinned Pages catalog read exceeded its bound");
    const limit = Math.min(remaining, maximum);
    const body = git(site, ["cat-file", "blob", `${commit}:${prefix}/${relative}`], limit)!;
    remaining -= body.length;
    return Promise.resolve(body);
  };
}

async function browseIdentities(read: ReadCatalog) {
  const search: unknown = JSON.parse(
    (await read("browse/search-index.json", 16 * mib)).toString("utf8"),
  );
  if (!Array.isArray(search) || search.length > 20_000)
    throw new Error("Pinned Pages browse search inventory exceeds its bound");
  const rows: unknown[] = search;
  const row =
    rows.find(
      (entry) =>
        isRecord(entry) &&
        entry.reviewed_game &&
        Array.isArray(entry.projects) &&
        entry.projects.length > 1,
    ) ?? rows[0];
  const sample = isRecord(row) ? row.url : undefined;
  if (
    search.length &&
    (typeof sample !== "string" ||
      !/^(?:games|projects)\/[a-z0-9][a-z0-9-]{0,127}\/index\.html$/u.test(sample))
  )
    throw new Error("Pinned Pages browse sample path is invalid");
  const files = [
    ["browse/index.html", 64 * mib],
    ["browse/inputs.json", 8192],
    ...(typeof sample === "string" ? [[`browse/${sample}`, 64 * mib] as const] : []),
  ] as const;
  return Promise.all(
    files.map(async ([relative, bound]) => ({
      path: relative,
      sha256: sha(await read(relative, bound)),
    })),
  );
}

function signed(bytes: Buffer) {
  const data: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isRecord(data) || !isRecord(data.signed))
    throw new Error("Pinned Pages metadata envelope is malformed");
  return data.signed;
}

function roleVersion(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("Pinned Pages metadata role version is malformed");
  return value;
}

async function metadataIdentities(site: string, source: string, read: ReadCatalog) {
  const evidence: HistoryReadback[] = [];
  const readVersionedRole = async (role: string, descriptor: unknown) => {
    if (
      !isRecord(descriptor) ||
      !isRecord(descriptor.hashes) ||
      typeof descriptor.hashes.sha256 !== "string" ||
      !digest.test(descriptor.hashes.sha256) ||
      typeof descriptor.length !== "number" ||
      !Number.isSafeInteger(descriptor.length) ||
      descriptor.length < 1 ||
      descriptor.length > 8 * mib
    )
      throw new Error("Pinned Pages signed metadata descriptor is malformed");
    const version = roleVersion(descriptor.version);
    const path = `metadata/${version}.${role}.json`;
    const body = await read(path, descriptor.length);
    if (body.length !== descriptor.length || sha(body) !== descriptor.hashes.sha256)
      throw new Error("Pinned Pages signed metadata binding differs");
    const roleBody = signed(body);
    if (roleVersion(roleBody.version) !== version)
      throw new Error("Pinned Pages signed metadata role version differs");
    evidence.push({ path, bytes: body.length, sha256: descriptor.hashes.sha256 });
    return roleBody;
  };

  const timestamp = signed(await read("metadata/timestamp.json", mib));
  const snapshot = await readVersionedRole(
    "snapshot",
    isRecord(timestamp.meta) ? timestamp.meta["snapshot.json"] : null,
  );
  for (const role of ["targets", "official-definitions", "official-policy"])
    await readVersionedRole(role, isRecord(snapshot.meta) ? snapshot.meta[`${role}.json`] : null);

  const sourceRoot = git(
    site,
    ["cat-file", "blob", `${source}:crates/portcove-core/catalog/official-definition-root.json`],
    8 * mib,
  )!;
  const rootPath = `metadata/${roleVersion(signed(sourceRoot).version)}.root.json`;
  const publishedRoot = await read(rootPath, sourceRoot.length);
  if (!publishedRoot.equals(sourceRoot))
    throw new Error("Pinned Pages root differs from its source");
  evidence.push({ path: rootPath, bytes: sourceRoot.length, sha256: sha(sourceRoot) });
  return evidence;
}

async function historyIdentities(
  site: string,
  pagesCommit: string,
  parent: string,
  readCatalog: ReadCatalog,
  pointer: { target: string; sha256: string },
  description: Awaited<ReturnType<typeof describeCatalogPublication>>,
) {
  const additions = git(
    site,
    [
      "diff-tree",
      "--no-commit-id",
      "--name-status",
      "--no-renames",
      "-r",
      parent,
      pagesCommit,
      "--",
      "catalog-history",
    ],
    8192,
  )!
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  if (additions.length > 64) throw new Error("Pinned Pages history exceeds its object bound");

  const readHistory = pinnedCatalog(site, pagesCommit, "catalog-history");
  const evidence = new Map<string, HistoryReadback>();
  const add = (path: string, expected: string, raw: Buffer, size = raw.length) => {
    if (raw.length !== size || sha(raw) !== expected)
      throw new Error("Pinned Pages history differs from its immutable identity");
    evidence.set(path, { path, sha256: expected, bytes: size });
  };
  const pointerPath = `targets/${pointer.sha256}.${pointer.target}`;
  const rawPointer = await readCatalog(pointerPath, 4096);
  add(`catalog/${pointerPath}`, pointer.sha256, rawPointer);
  const visit = async (identity: unknown, maximum: number) => {
    if (
      !isRecord(identity) ||
      typeof identity.sha256 !== "string" ||
      !digest.test(identity.sha256) ||
      typeof identity.bytes !== "number" ||
      !Number.isSafeInteger(identity.bytes) ||
      identity.bytes < 1 ||
      identity.bytes > maximum
    )
      throw new Error("Pinned Pages history reference is outside its bound");
    const relative = `sha256/${identity.sha256}.json`;
    const bytes = await readHistory(relative, identity.bytes);
    add(`catalog-history/${relative}`, identity.sha256, bytes, identity.bytes);
    return bytes;
  };
  const parsed: unknown = JSON.parse(rawPointer.toString("utf8"));
  if (
    !isRecord(parsed) ||
    parsed.checkpoint_schema !== 1 ||
    parsed.policy_revision !== description.published.versions?.policy
  )
    throw new Error("Pinned Pages history pointer does not bind the published policy revision");
  const predecessor = description.prior;
  if (
    !predecessor.versions ||
    !predecessor.timestamp_sha256 ||
    predecessor.versions.timestamp + 1 !== description.published.versions?.timestamp
  )
    throw new Error("Pinned Pages checkpoint has no exact predecessor generation");
  const active: unknown = JSON.parse((await visit(parsed.active, 2 * mib)).toString("utf8"));
  if (
    !isRecord(active) ||
    active.checkpoint_schema !== 1 ||
    active.covered_timestamp_version !== predecessor.versions.timestamp ||
    active.covered_timestamp_sha256 !== predecessor.timestamp_sha256
  )
    throw new Error("Pinned Pages active history does not bind the predecessor timestamp");
  const tip: unknown = JSON.parse((await visit(active.tip, mib)).toString("utf8"));
  if (
    !isRecord(tip) ||
    tip.checkpoint_schema !== 1 ||
    tip.through_timestamp_version !== predecessor.versions.timestamp ||
    tip.through_timestamp_sha256 !== predecessor.timestamp_sha256
  )
    throw new Error("Pinned Pages history tip does not bind the predecessor timestamp");
  for (const line of additions) {
    const object = /^A\tcatalog-history\/(sha256\/([a-f0-9]{64})\.json)$/u.exec(line);
    const relative = object?.[1];
    const expected = object?.[2];
    if (!relative || !expected)
      throw new Error("Pinned Pages history did not preserve its immutable files");
    const publicPath = `catalog-history/${relative}`;
    if (!evidence.has(publicPath)) {
      add(publicPath, expected, await readHistory(relative, 2 * mib));
    }
  }
  if (evidence.size > 65) throw new Error("Pinned Pages history exceeds its readback file bound");
  return [...evidence.values()];
}

export async function observePinnedCatalog(
  site: string,
  observer: Observer,
  fetcher = fetch,
  reportPin?: (pin: { pages_commit: string; source_commit: string; catalog_tree: string }) => void,
) {
  if (!/^[1-9][0-9]{0,19}$/u.test(observer.run) || !/^[1-9][0-9]{0,9}$/u.test(observer.attempt))
    throw new Error("Catalog recovery requires a valid observing run and attempt");
  const tip = checkoutTip(site);
  const publication = identity(site, tip);
  if (!publication) return null;
  const { pagesCommit, parent, source, catalogTree, hasHistory } = publication;
  reportPin?.({ pages_commit: pagesCommit, source_commit: source, catalog_tree: catalogTree });
  const priorTree = git(site, ["ls-tree", parent, "--", "catalog/metadata/timestamp.json"]);
  const next = pinnedCatalog(site, pagesCommit);
  const description = await describeCatalogPublication(
    priorTree?.length ? pinnedCatalog(site, parent) : null,
    next,
  );
  const metadata = await metadataIdentities(site, source, next);
  const browse = await browseIdentities(next);
  if (hasHistory !== !!description.historyPointer)
    throw new Error("Pinned Pages catalog history store and policy pointer disagree");
  const history = description.historyPointer
    ? await historyIdentities(
        site,
        pagesCommit,
        parent,
        next,
        description.historyPointer,
        description,
      )
    : [];
  const bytes = await verifyCatalogPublicationLive(
    description,
    `late-${observer.run}-${observer.attempt}-${pagesCommit.slice(0, 12)}`,
    fetcher,
    browse,
    history,
    { metadata },
  );
  return {
    schema_version: 1,
    kind: "catalog-publication-late-readback",
    authority: "none",
    observed_at: new Date().toISOString(),
    source_commit: source,
    pages_commit: pagesCommit,
    pages_parent_commit: parent,
    catalog_tree: catalogTree,
    pinned_pages_tip: tip,
    // Historical catalog commits do not encode the producing Actions run.
    // Keep the later observation separate from that original publication.
    observing_run: observer.run,
    observing_attempt: observer.attempt,
    prior: description.prior,
    published: description.published,
    changes: description.changes,
    descriptive_target_changed: description.listingChanged,
    browse,
    readback: {
      immutable_targets: description.targets,
      immutable_target_bytes: bytes,
      history_objects: history,
      role_metadata: metadata,
      timestamp_rechecked: true,
    },
  };
}

async function main() {
  const {
    values: { site, output, status },
  } = parseArgs({
    options: { site: { type: "string" }, output: { type: "string" }, status: { type: "string" } },
  });
  if (!site || !output || !status)
    throw new Error("Supply a pinned Pages worktree, receipt and status file");
  const observer = {
    run: process.env.GITHUB_RUN_ID ?? "",
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
  };
  let observation: Record<string, unknown>;
  let pinned: Record<string, unknown> = {};
  try {
    const receipt = await observePinnedCatalog(site, observer, fetch, (pin) => {
      pinned = pin;
    });
    if (receipt) {
      const body = JSON.stringify(receipt, null, 2) + "\n";
      if (Buffer.byteLength(body) > mib)
        throw new Error("Catalog recovery receipt exceeds its byte bound");
      await writeFile(output, body, { flag: "wx", mode: 0o600 });
    }
    observation = {
      outcome: receipt ? "complete" : "no-publication",
      pages_commit: receipt?.pages_commit,
    };
  } catch (error) {
    observation = {
      outcome: error instanceof LateReadbackFailure ? error.outcome : "incomplete",
      observed_timestamp_sha256:
        error instanceof LateReadbackFailure ? error.observedTimestampSha256 : undefined,
      detail: errorMessage(error).slice(0, 256),
    };
  }
  await writeFile(
    status,
    JSON.stringify({
      schema_version: 1,
      kind: "catalog-publication-late-observation",
      authority: "none",
      observing_run: observer.run,
      observing_attempt: observer.attempt,
      ...pinned,
      ...observation,
    }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
