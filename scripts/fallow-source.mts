import { errorCode } from "./runtime-values.mts";
import { createHash } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Include dirty and untracked inputs: HEAD alone does not identify a candidate.
export function fallowSource(root: string, base?: string, { includeAll = false }: {includeAll?: boolean} = {}) {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const head = git("rev-parse", "HEAD").trim();
  const target = base
    ? git("rev-parse", "--verify", "--end-of-options", `${base}^{commit}`).trim()
    : null;
  const mergeBase = target ? git("merge-base", head, target).trim() : null;
  const status = git("status", "--porcelain=v1", "-z", "--untracked-files=all");
  const hash = createHash("sha256").update(head).update(status);
  if (includeAll) hash.update(git("ls-files", "--stage", "-z"));
  const inputs = git("ls-files", "-z", "--cached", "--others", "--exclude-standard")
    .split("\0")
    .filter(
      (name) =>
        name.length > 0 &&
        (includeAll ||
          /\.(?:[cm]?[jt]sx?|css|scss|less|jsonc?|json5|toml|ya?ml|html|vue|svelte|astro)$|(?:^|\/)(?:justfile|pnpm-lock\.yaml)$/u.test(
            name,
          )),
    );
  for (const name of [...new Set(inputs)].sort()) {
    hash.update(name).update("\0");
    try {
      const file = path.join(root, name);
      const stat = lstatSync(file);
      if (!stat.isFile()) throw new Error(`Nonregular Fallow source: ${name}`);
      if (includeAll) hash.update(String(stat.mode & 0o111)).update("\0");
      hash.update(readFileSync(file));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      hash.update("<deleted>");
    }
    hash.update("\0");
  }
  return {
    head,
    dirty: status.length > 0,
    source_sha256: hash.digest("hex"),
    target,
    merge_base: mergeBase,
  };
}
