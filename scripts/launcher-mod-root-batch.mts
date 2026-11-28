import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";

interface Repository {
  id: number;
  slug: string;
}

export const launcherRootBatchSize = 6;
const oid = /^[a-f0-9]{40}$/u;
const repositorySlug = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/u;
const blobModes = new Set([0o100644, 0o100755, 0o120000]);

export function launcherRootQuery(repositories: readonly Repository[]) {
  if (repositories.length < 2 || repositories.length > launcherRootBatchSize)
    throw new Error("Launcher root query must contain two to six repositories");
  const aliases = repositories.map(({ id, slug }, index) => {
    if (!Number.isSafeInteger(id) || id <= 0 || !repositorySlug.test(slug))
      throw new Error("Invalid launcher root repository binding");
    const [owner, name] = slug.split("/");
    return `project${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      databaseId nameWithOwner isPrivate
      defaultBranchRef { target { ... on Commit { oid tree { oid entries { nameRaw mode oid } } } } }
    }`;
  });
  return `query PortcoveLauncherRoots { ${aliases.join("\n")} rateLimit { cost } }`;
}

function verifiedTree(tree: unknown) {
  if (
    !isRecord(tree) ||
    typeof tree.oid !== "string" ||
    !oid.test(tree.oid) ||
    !Array.isArray(tree.entries) ||
    tree.entries.length > 1024
  )
    return null;
  const entries = [];
  const names = new Set<string>();
  for (const entry of tree.entries as unknown[]) {
    if (
      !isRecord(entry) ||
      typeof entry.nameRaw !== "string" ||
      entry.nameRaw.length > 344 ||
      typeof entry.oid !== "string" ||
      !oid.test(entry.oid) ||
      typeof entry.mode !== "number"
    )
      return null;
    const type =
      entry.mode === 0o40000
        ? "tree"
        : entry.mode === 0o160000
          ? "commit"
          : blobModes.has(entry.mode)
            ? "blob"
            : null;
    if (!type || names.has(entry.nameRaw)) return null;
    const bytes = Buffer.from(entry.nameRaw, "base64");
    if (
      !bytes.length ||
      bytes.length > 255 ||
      bytes.includes(0) ||
      bytes.includes(47) ||
      bytes.toString("base64") !== entry.nameRaw
    )
      return null;
    // The REST manifest classifier consumes names as strings. Preserve its
    // interpretation by falling back if a raw Git name cannot round-trip.
    const name = bytes.toString("utf8");
    if (!Buffer.from(name).equals(bytes)) return null;
    names.add(entry.nameRaw);
    entries.push({
      path: name,
      mode: entry.mode,
      type,
      sha: entry.oid,
      bytes,
      order: Buffer.concat([bytes, Buffer.from([type === "tree" ? 47 : 0])]),
    });
  }
  entries.sort((left, right) => left.order.compare(right.order));
  const content = Buffer.concat(
    entries.flatMap(({ mode, bytes, sha }) => [
      Buffer.from(`${mode.toString(8)} `),
      bytes,
      Buffer.from([0]),
      Buffer.from(sha, "hex"),
    ]),
  );
  const hash = createHash("sha1").update(`tree ${content.length}\0`).update(content).digest("hex");
  if (hash !== tree.oid) return null;
  return {
    sha: hash,
    truncated: false,
    tree: entries.map(({ path, mode, type, sha }) => ({
      path,
      mode: mode.toString(8).padStart(6, "0"),
      type,
      sha,
    })),
  };
}

/** Supply only the exact REST-equivalent reads proved by this batch. */
export function verifiedLauncherRootReads(repositories: readonly Repository[], data: unknown) {
  const reads = new Map<string, unknown>();
  if (!isRecord(data)) return reads;
  for (const [{ id, slug }, index] of repositories.map((repo, index) => [repo, index] as const)) {
    const project = data[`project${index}`];
    if (
      !isRecord(project) ||
      project.databaseId !== id ||
      project.isPrivate !== false ||
      typeof project.nameWithOwner !== "string" ||
      project.nameWithOwner.toLowerCase() !== slug.toLowerCase() ||
      !isRecord(project.defaultBranchRef) ||
      !isRecord(project.defaultBranchRef.target)
    )
      continue;
    const head = project.defaultBranchRef.target;
    if (typeof head.oid !== "string" || !oid.test(head.oid)) continue;
    const tree = verifiedTree(head.tree);
    if (!tree) continue;
    const endpoint = `repositories/${id}`;
    reads.set(endpoint, { id, full_name: project.nameWithOwner, private: false });
    reads.set(`${endpoint}/commits?per_page=1`, [
      { sha: head.oid, commit: { tree: { sha: tree.sha } } },
    ]);
    reads.set(`${endpoint}/git/trees/${tree.sha}`, tree);
  }
  return reads;
}
