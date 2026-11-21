import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  describeCatalogPublication,
  verifyCatalogPublicationLive,
  type HistoryReadback,
} from "./catalog-publication-receipt.mts";
import { isRecord } from "./runtime-values.mts";

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

async function historyIdentities(
  site: string,
  pagesCommit: string,
  parent: string,
  readCatalog: ReadCatalog,
  pointer: { target: string; sha256: string },
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
  if (!isRecord(parsed) || parsed.checkpoint_schema !== 1)
    throw new Error("Pinned Pages history pointer has an unknown schema");
  const active: unknown = JSON.parse((await visit(parsed.active, 2 * mib)).toString("utf8"));
  if (!isRecord(active) || active.checkpoint_schema !== 1)
    throw new Error("Pinned Pages active history has an unknown schema");
  await visit(active.tip, mib);
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

export async function observePinnedCatalog(site: string, observer: Observer, fetcher = fetch) {
  if (!/^[1-9][0-9]{0,19}$/u.test(observer.run) || !/^[1-9][0-9]{0,9}$/u.test(observer.attempt))
    throw new Error("Catalog recovery requires a valid observing run and attempt");
  const tip = checkoutTip(site);
  const publication = identity(site, tip);
  if (!publication) return null;
  const { pagesCommit, parent, source, catalogTree, hasHistory } = publication;
  const priorTree = git(site, ["ls-tree", parent, "--", "catalog/metadata/timestamp.json"]);
  const next = pinnedCatalog(site, pagesCommit);
  const description = await describeCatalogPublication(
    priorTree?.length ? pinnedCatalog(site, parent) : null,
    next,
  );
  const browse = await browseIdentities(next);
  if (hasHistory !== !!description.historyPointer)
    throw new Error("Pinned Pages catalog history store and policy pointer disagree");
  const history = description.historyPointer
    ? await historyIdentities(site, pagesCommit, parent, next, description.historyPointer)
    : [];
  const bytes = await verifyCatalogPublicationLive(
    description,
    `late-${observer.run}-${observer.attempt}-${pagesCommit.slice(0, 12)}`,
    fetcher,
    browse,
    history,
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
      timestamp_rechecked: true,
    },
  };
}

async function main() {
  const {
    values: { site, output },
  } = parseArgs({
    options: { site: { type: "string" }, output: { type: "string" } },
  });
  if (!site || !output) throw new Error("Supply a pinned Pages worktree and an output file");
  const receipt = await observePinnedCatalog(site, {
    run: process.env.GITHUB_RUN_ID ?? "",
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
  });
  if (!receipt) return;
  const body = JSON.stringify(receipt, null, 2) + "\n";
  if (Buffer.byteLength(body) > mib)
    throw new Error("Catalog recovery receipt exceeds its byte bound");
  await writeFile(output, body, { flag: "wx", mode: 0o600 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
