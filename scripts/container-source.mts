import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Generated ignored dependencies/caches are permitted; source inputs must remain
// the selected committed tree, including no untracked discoverable test files.
export function assertCommittedWorkspace(root, commit, tree) {
  const git = (...args) => {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: args[0] === "status" ? 60_000 : 10_000,
    });
    if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
    return result.stdout.trimEnd();
  };
  if (git("rev-parse", "HEAD") !== commit || git("rev-parse", "HEAD^{tree}") !== tree)
    throw new Error("Prepared source identity differs from selected commit/tree");
  const changes = git("status", "--porcelain=v1", "--untracked-files=all");
  if (changes) throw new Error(`Prepared source differs from committed bytes:\n${changes}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  assertCommittedWorkspace(process.cwd(), process.argv[2], process.argv[3]);
