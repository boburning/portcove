import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";
import { n64GameTablePath, parseN64GameTable } from "./upstream-n64-game-entry.mts";

interface GitLabRead {
  body: unknown;
  status: number;
  next: string | null;
  page?: string | null;
  per_page?: string | null;
  observed_at: string;
}

const gitObject = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);

export async function gitLabN64SourceDeclaration(
  projectId: number,
  tag: string,
  commit: unknown,
  read: (url: string) => Promise<GitLabRead>,
) {
  if (
    !Number.isSafeInteger(projectId) ||
    projectId < 1 ||
    !gitObject(commit) ||
    !tag ||
    tag.length > 255 ||
    /^[.]{1,2}$/u.test(tag) ||
    /[\u0000-\u0020\u007f\\]/u.test(tag)
  ) {
    throw new Error("GitLab release has no exact tag and commit identity");
  }
  const base = `https://gitlab.com/api/v4/projects/${projectId}/repository`;
  const requireOk = async (url: string) => {
    const result = await read(url);
    if (result.status !== 200) throw new Error("GitLab source endpoint did not return HTTP 200");
    return result;
  };
  const readTag = async () => {
    const result = await requireOk(`${base}/tags/${encodeURIComponent(tag)}`);
    const row = result.body;
    if (
      !isRecord(row) ||
      row.name !== tag ||
      !isRecord(row.commit) ||
      row.commit.id !== commit ||
      !gitObject(row.target)
    ) {
      throw new Error("GitLab tag no longer identifies the exact release commit");
    }
    return { target: row.target, observed_at: result.observed_at };
  };
  const initialTag = await readTag();
  const tree = await requireOk(`${base}/tree?ref=${commit}&path=src%2Fmain&page=1&per_page=100`);
  if (
    tree.next !== "" ||
    tree.page !== "1" ||
    tree.per_page !== "100" ||
    !Array.isArray(tree.body) ||
    tree.body.length >= 100 ||
    tree.body.some((row) => !isRecord(row) || typeof row.path !== "string")
  ) {
    throw new Error("GitLab source directory inventory is incomplete");
  }
  const rows: unknown[] = tree.body;
  const matches = rows.filter(
    (row): row is Record<string, unknown> =>
      isRecord(row) &&
      typeof row.path === "string" &&
      row.path.toLowerCase() === n64GameTablePath.toLowerCase(),
  );
  const entry = matches[0];
  if (
    matches.length !== 1 ||
    !entry ||
    entry.path !== n64GameTablePath ||
    entry.type !== "blob" ||
    (entry.mode !== "100644" && entry.mode !== "100755") ||
    !gitObject(entry.id)
  ) {
    throw new Error("GitLab source directory has no unique exact GameEntry blob");
  }

  const blob = (await requireOk(`${base}/blobs/${entry.id}`)).body;
  const maximum = 256 * 1024;
  if (
    !isRecord(blob) ||
    blob.sha !== entry.id ||
    blob.encoding !== "base64" ||
    typeof blob.size !== "number" ||
    !Number.isSafeInteger(blob.size) ||
    blob.size < 1 ||
    blob.size > maximum ||
    typeof blob.content !== "string" ||
    blob.content.length > Math.ceil(maximum / 3) * 4 + 8192
  ) {
    throw new Error("GitLab source blob identity or size is invalid");
  }
  const encoded = blob.content.replace(/[\r\n]/gu, "");
  const bytes = Buffer.from(encoded, "base64");
  const object = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (bytes.length !== blob.size || bytes.toString("base64") !== encoded || object !== entry.id) {
    throw new Error("GitLab source blob bytes differ from the exact tree object");
  }
  const entries = parseN64GameTable(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (entries.length === 0) throw new Error("GitLab source declares no recognized N64 GameEntry");

  const finalTag = await readTag();
  if (finalTag.target !== initialTag.target)
    throw new Error("GitLab tag changed during source read");
  return {
    authority: "source-declaration-only",
    project_id: projectId,
    tag,
    commit_sha: commit,
    tag_target_sha: finalTag.target,
    path: n64GameTablePath,
    blob_sha: entry.id,
    source_sha256: createHash("sha256").update(bytes).digest("hex"),
    observed_at: finalTag.observed_at,
    entries,
  };
}
