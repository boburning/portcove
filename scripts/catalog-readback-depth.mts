// Late catalog readback needs the last catalog publisher commit and its parent
// in a shallow `gh-pages` fetch. Application-only Pages commits may follow the
// publisher commit, and the branch may advance between the depth-1 fetch and
// the readback, so a fixed depth can blame the wrong commit: in a shallow
// history the boundary commit looks as if it added every file. Deepen in
// bounded steps until the publisher commit's parent is present (#1422).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const readbackDeepenStep = 8;
export const readbackDepthLimit = 64;
const timestamp = "catalog/metadata/timestamp.json";
const gitOid = /^[0-9a-f]{40}$/u;

function git(site: string, args: string[], timeout = 5000) {
  const result = spawnSync("git", args, {
    cwd: site,
    timeout,
    maxBuffer: 64 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" },
  });
  if (result.error || result.status === null) throw new Error("Pages Git command did not finish");
  return { status: result.status, stdout: result.stdout.toString("utf8").trim() };
}

function ok(site: string, args: string[]) {
  const result = git(site, args);
  if (result.status !== 0) throw new Error(`Pages Git read failed: git ${args[0]}`);
  return result.stdout;
}

/** Whether the checked-out history already holds the last catalog publisher
 * commit with its parent (or proves there is no earlier history). */
export function publisherHistoryPresent(site: string) {
  const shallow = ok(site, ["rev-parse", "--is-shallow-repository"]) === "true";
  const found = ok(site, [
    "log",
    "--first-parent",
    "-1",
    "--format=%H %P",
    "HEAD",
    "--",
    timestamp,
  ]);
  if (!found) return !shallow;
  const [commit, parent] = found.split(" ");
  if (!gitOid.test(commit ?? "")) throw new Error("Pages Git identity is invalid");
  // A shallow boundary has no parents here; it only looks like the publisher.
  if (!parent) return !shallow;
  if (!gitOid.test(parent)) throw new Error("Pages Git identity is invalid");
  return git(site, ["cat-file", "-e", `${parent}^{commit}`]).status === 0;
}

export type Deepen = (step: number) => void;

export const fetchDeeper =
  (site: string): Deepen =>
  (step) => {
    const result = git(
      site,
      [
        "fetch",
        "--quiet",
        `--deepen=${step}`,
        "origin",
        "refs/heads/gh-pages:refs/remotes/origin/gh-pages",
      ],
      60_000,
    );
    if (result.status !== 0) throw new Error("Could not deepen the gh-pages fetch");
  };

/** Deepen from depth 1 in `step` commits until the publisher commit and its
 * parent are present; refuse beyond `limit` commits. Returns the depth. */
export function deepenToPublisher(
  site: string,
  deepen: Deepen = fetchDeeper(site),
  step = readbackDeepenStep,
  limit = readbackDepthLimit,
) {
  let depth = 1;
  while (!publisherHistoryPresent(site)) {
    if (depth >= limit)
      throw new Error(
        `The last catalog publication is more than ${limit} gh-pages commits deep; readback skipped`,
      );
    deepen(step);
    depth += step;
  }
  return depth;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { site: { type: "string" } } });
  if (!values.site) throw new Error("usage: catalog-readback-depth.mts --site <gh-pages worktree>");
  console.log(`gh-pages history read to depth ${deepenToPublisher(values.site)}.`);
}
