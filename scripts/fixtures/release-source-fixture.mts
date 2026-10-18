import { createHash } from "node:crypto";
import type { IncludedResponse } from "../github-api.mts";

const gitOid = (kind: string, bytes: Buffer) =>
  createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");
export function sourceFixtureCommit(tree: string, parents: string[], message: string) {
  const actor = { name: "Fixture", email: "fixture@example.invalid", date: "2026-10-18T00:00:00Z" };
  const raw = Buffer.from(
    `tree ${tree}\n${parents.map((id) => `parent ${id}\n`).join("")}author Fixture <fixture@example.invalid> 1792281600 +0000\ncommitter Fixture <fixture@example.invalid> 1792281600 +0000\n\n${message}`,
  );
  return {
    sha: gitOid("commit", raw),
    tree: { sha: tree },
    parents: parents.map((sha) => ({ sha })),
    message,
    author: actor,
    committer: actor,
  };
}

/** Independently constructed Git bytes/provider fixture, never a production
 * observation. The expected net frame is spelled out for the one changed file.
 */
export function releaseSourceFixture(count = 1) {
  const readme = gitOid("blob", Buffer.from("readme\n"));
  const oldBlob = gitOid("blob", Buffer.from("base\n"));
  const newBlob = gitOid("blob", Buffer.from("source\n"));
  const rows = (blob: string) => [
    { path: "README.md", mode: "100644", type: "blob", sha: readme },
    { path: "app.rs", mode: "100644", type: "blob", sha: blob },
  ];
  const treeId = (blob: string) =>
    gitOid(
      "tree",
      Buffer.concat([
        Buffer.from("100644 README.md\0"),
        Buffer.from(readme, "hex"),
        Buffer.from("100644 app.rs\0"),
        Buffer.from(blob, "hex"),
      ]),
    );
  const baseTree = treeId(oldBlob);
  const sourceTree = treeId(newBlob);
  const base = sourceFixtureCommit(baseTree, [], "fixture base\n");
  const chain: ReturnType<typeof sourceFixtureCommit>[] = [];
  for (let index = 0; index < count; index++)
    chain.push(
      sourceFixtureCommit(
        index === count - 1 ? sourceTree : baseTree,
        [chain.at(-1)?.sha ?? base.sha],
        `fixture source ${index + 1}\n`,
      ),
    );
  const original = chain.at(-1)!;
  const expectedDelta = {
    schema_version: 1,
    scope: "portcove-release-net-tree-delta-v1",
    base_commit: base.sha,
    base_tree: baseTree,
    source_commit: original.sha,
    source_tree: sourceTree,
    changes: [
      {
        path: "app.rs",
        before: { mode: "100644", type: "blob", oid: oldBlob },
        after: { mode: "100644", type: "blob", oid: newBlob },
      },
    ],
  };
  const expectedHash = createHash("sha256").update(JSON.stringify(expectedDelta)).digest("hex");
  const faults = { value: "" };
  const calls: string[] = [];
  const response = (body: unknown, link?: string): IncludedResponse => ({
    status: 200,
    body,
    headers: new Map(link ? [["link", link]] : []),
  });
  const api = {
    request(method: string, endpoint: string) {
      if (method !== "GET") throw new Error("fixture write forbidden");
      calls.push(endpoint);
      const url = new URL(
        endpoint.startsWith("https:") ? endpoint : `https://api.github.com/${endpoint}`,
      );
      const route = url.pathname.replace("/repos/boburning/portcove", "");
      if (route === `/git/commits/${base.sha}`) return response(structuredClone(base));
      if (route === `/git/commits/${original.sha}`) return response(structuredClone(original));
      if (route === `/git/trees/${baseTree}` || route === `/git/trees/${sourceTree}`) {
        const entries = rows(route.endsWith(baseTree) ? oldBlob : newBlob);
        if (faults.value === "tree-forgery") entries[0]!.sha = "f".repeat(40);
        if (faults.value === "tree-omission") entries.pop();
        return response({
          sha: route.split("/").at(-1),
          truncated: faults.value === "tree-truncated",
          tree: entries,
        });
      }
      if (route === `/compare/${base.sha}...${original.sha}`) {
        const page = Number(url.searchParams.get("page") ?? 1);
        const commits = chain
          .slice((page - 1) * 100, page * 100)
          .map((commit) => ({ sha: commit.sha, commit: { ...commit }, parents: commit.parents }));
        if (faults.value === "duplicate" && page > 1 && commits[0])
          commits[0] = { sha: chain[0]!.sha, commit: { ...chain[0]! }, parents: chain[0]!.parents };
        const next =
          faults.value === "escape"
            ? "https://api.github.com/repos/boburning/portcove/releases?per_page=100&page=2"
            : page * 100 < count
              ? `https://api.github.com${route.replace("/compare/", "/repos/boburning/portcove/compare/")}?per_page=100&page=${page + 1}`
              : null;
        return response(
          {
            status: faults.value === "diverged" ? "diverged" : "ahead",
            ahead_by: faults.value === "truncated" ? count + 1 : count,
            behind_by: 0,
            total_commits: faults.value === "truncated" ? count + 1 : count,
            base_commit: { sha: base.sha },
            merge_base_commit: { sha: base.sha },
            commits,
            files: [{ filename: "deliberately incomplete first-page file list; must not be used" }],
          },
          next ? `<${next}>; rel="next"` : undefined,
        );
      }
      throw new Error(`unexpected source fixture route ${route}`);
    },
  };
  return {
    base,
    original,
    baseTree,
    sourceTree,
    oldBlob,
    newBlob,
    chain,
    api,
    calls,
    faults,
    expectedDelta,
    expectedHash,
    opportunity: { base_commit: base.sha, source_commit: original.sha, source_tree: sourceTree },
  };
}
