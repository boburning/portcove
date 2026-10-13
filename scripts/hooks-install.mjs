import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCheckedGit } from "./checked-git.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
function observe(args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error || ![0, 1].includes(result.status))
    throw result.error ?? new Error(result.stderr);
  return result.status === 0 ? result.stdout.trim() : null;
}

export async function installHooks() {
  if (!existsSync(path.join(root, ".git"))) {
    console.log("Source archive: no Git hooks to install.");
    return;
  }
  if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_RUN_ID) {
    console.log("Hosted Actions: canonical validation runs directly; hook installation skipped.");
    return;
  }
  const current = observe(["config", "--get", "core.hooksPath"]);
  if (current && current !== ".husky/_")
    throw new Error(
      `Existing hook manager (${current}) preserved; integrate explicitly before installing Portcove hooks.`,
    );
  const defaults = path.resolve(
    root,
    runCheckedGit(["rev-parse", "--git-path", "hooks"], { cwd: root }).trim(),
  );
  if (!current && existsSync(defaults)) {
    const active = readdirSync(defaults).filter((file) => !file.endsWith(".sample"));
    if (active.length)
      throw new Error(`Existing default Git hooks preserved: ${active.join(", ")}`);
  }
  if (
    observe(["config", "--local", "--get", "core.worktree"]) ||
    observe(["config", "--local", "--get", "core.bare"]) === "true"
  )
    throw new Error("Custom core.worktree/bare configuration requires explicit hook integration.");
  const expected = [
    "if ! command -v node >/dev/null 2>&1; then",
    '  echo "Portcove pre-commit requires the pinned Node runtime; prepare dependencies and run pnpm run hooks:install." >&2',
    "  exit 1",
    "fi",
    "node scripts/precommit-check.mjs",
  ].join("\n");
  if (readFileSync(path.join(root, ".husky/pre-commit"), "utf8").trim() !== expected)
    throw new Error(
      "Maintained pre-commit entrypoint unavailable; restore it before reinstalling.",
    );
  const { default: husky } = await import("husky");
  const pins = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).devDependencies;
  for (const name of ["husky", "lint-staged"]) {
    const installed = JSON.parse(
      readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8"),
    );
    if (installed.version !== pins[name])
      throw new Error(`Install pinned ${name} before hook setup.`);
  }
  runCheckedGit(["config", "--local", "extensions.worktreeConfig", "true"], { cwd: root });
  const config = path.resolve(
    root,
    runCheckedGit(["rev-parse", "--git-path", "config.worktree"], { cwd: root }).trim(),
  );
  const previous = process.env.GIT_CONFIG;
  const previousCwd = process.cwd();
  try {
    process.env.GIT_CONFIG = config;
    process.chdir(root);
    const error = husky();
    if (error) throw new Error(error);
  } finally {
    process.chdir(previousCwd);
    if (previous === undefined) delete process.env.GIT_CONFIG;
    else process.env.GIT_CONFIG = previous;
  }
  if (
    observe(["config", "--worktree", "--get", "core.hooksPath"]) !== ".husky/_" ||
    !existsSync(path.join(root, ".husky/_/pre-commit")) ||
    !existsSync(path.join(root, ".husky/_/h"))
  )
    throw new Error("Husky entrypoint setup did not complete; reinstall before committing.");
  console.log(
    "Portcove staged checks installed for this worktree. Reinstall: pnpm run hooks:install",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  installHooks().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
