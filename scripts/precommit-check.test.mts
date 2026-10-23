import { errorCode } from "./runtime-values.mts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  unlinkSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configureHooks } from "./hooks-install.mts";
import { vitePlusCommand } from "./viteplus-cli.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const vp = vitePlusCommand(root);
const base = path.join(tmpdir(), "portcove-vite-hooks");
mkdirSync(base, { recursive: true });
const env = {
  ...process.env,
  VP_GIT_HOOKS: "1",
  CI: "false",
  PATH: `${path.join(root, "node_modules/.bin")}${path.delimiter}${process.env.PATH}`,
};
function run(cwd: string, executable: string, args: readonly string[], ok = true) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  if (ok) assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}
const git = (cwd: string, ...args: string[]) => run(cwd, "git", args).stdout;
function fixture() {
  const cwd = mkdtempSync(path.join(base, "staged-' space-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Portcove hook fixture");
  git(cwd, "config", "user.email", "hook-fixture@example.invalid");
  writeFileSync(path.join(cwd, "package.json"), '{"private":true,"type":"module"}\n');
  writeFileSync(
    path.join(cwd, "vite.config.ts"),
    'export default { fmt: {}, staged: { "*.js": "vp fmt --config vite.config.ts --ignore-path .gitignore" } };\n',
  );
  writeFileSync(path.join(cwd, "sample.js"), "export const value = 1;\n");
  writeFileSync(path.join(cwd, ".gitignore"), ".vite-hooks/_/\n/node_modules\n");
  writeFileSync(path.join(cwd, ".node-version"), process.versions.node);
  symlinkSync(path.join(root, "node_modules"), path.join(cwd, "node_modules"), "junction");
  mkdirSync(path.join(cwd, ".vite-hooks"));
  mkdirSync(path.join(cwd, "scripts"));
  for (const name of [
    "node-test-inventory.mts",
    "node-test-suites.mts",
    "qualification-coverage.mts",
    "runtime-values.mts",
    "catalog-staged-check.mts",
    "catalog-authoring.mts",
    "upstream-lineage.mts",
    "precommit.mts",
    "viteplus-cli.mts",
  ])
    writeFileSync(path.join(cwd, "scripts", name), readFileSync(path.join(root, "scripts", name)));
  writeFileSync(
    path.join(cwd, ".vite-hooks/pre-commit"),
    readFileSync(path.join(root, ".vite-hooks/pre-commit")),
  );
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "fixture baseline");
  assert.equal(git(cwd, "ls-files", "--", "node_modules").trim(), "");
  return cwd;
}

void test("standard staged autofix preserves partial staging and unrelated work", () => {
  const cwd = fixture();
  configureHooks(cwd, "enable", env);
  writeFileSync(path.join(cwd, "sample.js"), "export const value={x:1}\n");
  git(cwd, "add", "sample.js");
  writeFileSync(path.join(cwd, "sample.js"), "export const value={x:1}\n// unstaged work\n");
  writeFileSync(path.join(cwd, "untracked.txt"), "unrelated work\n");
  git(cwd, "commit", "-qm", "partial staged hook");
  assert.equal(git(cwd, "show", ":sample.js"), "export const value = { x: 1 };\n");
  assert.match(readFileSync(path.join(cwd, "sample.js"), "utf8"), /unstaged work/);
  assert.equal(readFileSync(path.join(cwd, "untracked.txt"), "utf8"), "unrelated work\n");
});

void test("a failed staged command restores the index and working changes", () => {
  const cwd = fixture();
  configureHooks(cwd, "enable", env);
  writeFileSync(
    path.join(cwd, "vite.config.ts"),
    'export default { staged: { "*.js": "node -e process.exit(7)" } };\n',
  );
  writeFileSync(path.join(cwd, "sample.js"), "export const value={x:1}\n");
  git(cwd, "add", "sample.js");
  writeFileSync(path.join(cwd, "sample.js"), "export const value={x:1}\n// unstaged work\n");
  const before = git(cwd, "diff");
  const index = git(cwd, "show", ":sample.js");
  const result = run(cwd, "git", ["commit", "-qm", "must fail"], false);
  assert.notEqual(result.status, 0);
  assert.equal(git(cwd, "diff"), before);
  assert.equal(git(cwd, "show", ":sample.js"), index);
});

void test("the real hook rejects an unstaged-only test registration without changing either tree", () => {
  const cwd = fixture();
  configureHooks(cwd, "enable", env);
  mkdirSync(path.join(cwd, ".github/workflows"), { recursive: true });
  writeFileSync(path.join(cwd, ".github/workflows/ci.yml"), "scripts/new.test.mts\n");
  writeFileSync(path.join(cwd, "justfile"), "scripts/new.test.mts\n");
  writeFileSync(path.join(cwd, "scripts/run-windows-qualification.ps1"), "");
  writeFileSync(path.join(cwd, "scripts/new.test.mts"), "// newly staged test\n");
  git(cwd, "add", "scripts/new.test.mts");
  const beforeIndex = git(cwd, "diff", "--cached");
  const beforeWorktree = git(cwd, "status", "--porcelain");
  const result = run(cwd, "git", ["commit", "-qm", "must fail"], false);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Cannot inspect staged Node inventory/);
  assert.equal(git(cwd, "diff", "--cached"), beforeIndex);
  assert.equal(git(cwd, "status", "--porcelain"), beforeWorktree);
  assert.equal(
    readFileSync(path.join(cwd, "scripts/new.test.mts"), "utf8"),
    "// newly staged test\n",
  );
});

void test("supported hooks work from a linked worktree and noninteractive Git client", () => {
  const cwd = fixture();
  git(cwd, "config", "extensions.worktreeConfig", "true");
  git(cwd, "config", "--worktree", "core.hooksPath", ".husky/_");
  const commonBefore = readFileSync(path.join(cwd, ".git/config"), "utf8");
  const sibling = `${cwd}-linked`;
  git(cwd, "worktree", "add", "-qb", "linked-fixture", sibling);
  symlinkSync(path.join(root, "node_modules"), path.join(sibling, "node_modules"), "junction");
  git(sibling, "config", "--worktree", "core.hooksPath", ".husky/_");
  configureHooks(sibling, "enable", env);
  assert.equal(readFileSync(path.join(cwd, ".git/config"), "utf8"), commonBefore);
  assert.equal(git(cwd, "config", "--get", "core.hooksPath").trim(), ".husky/_");
  writeFileSync(path.join(sibling, "sample.js"), "export const value={linked:true}\n");
  git(sibling, "add", "sample.js");
  git(sibling, "commit", "-qm", "noninteractive editor-style commit");
  assert.equal(git(sibling, "show", "HEAD:sample.js"), "export const value = { linked: true };\n");
  assert.match(configureHooks(sibling, "status", env), /\.vite-hooks/);
  configureHooks(sibling, "disable", env);
  assert.equal(git(sibling, "config", "--get", "core.hooksPath").trim(), "");
  assert.match(configureHooks(sibling, "install", env), /remain disabled/);
  configureHooks(sibling, "enable", env);
  assert.equal(git(cwd, "status", "--porcelain").trim(), "");
});

void test(
  "real Git hooks use the installed runtime without ambient Node and recover through setup refresh",
  { timeout: 180_000 },
  () => {
    const cwd = fixture();
    const runtimeDir = path.join(cwd, ".vite-hooks/_/runtime ' with spaces");
    mkdirSync(runtimeDir, { recursive: true });
    const runtime = path.join(runtimeDir, process.platform === "win32" ? "node.exe" : "node");
    copyFileSync(process.execPath, runtime);
    if (process.platform !== "win32") chmodSync(runtime, 0o755);
    const setup = spawnSync(
      runtime,
      [
        "--input-type=module",
        "-e",
        `import { configureHooks } from ${JSON.stringify(pathToFileURL(path.join(root, "scripts/hooks-install.mts")).href)}; configureHooks(${JSON.stringify(cwd)}, "enable");`,
      ],
      { env, encoding: "utf8", timeout: 30_000, windowsHide: true },
    );
    assert.equal(setup.status, 0, setup.stderr || setup.error?.message);
    const core = git(cwd, "--exec-path").trim();
    const gitPath =
      process.platform === "win32" ? path.resolve(core, "../../bin/git.exe") : "/usr/bin/git";
    const lean = {
      ...env,
      PATH:
        process.platform === "win32"
          ? `${path.dirname(gitPath)};${path.resolve(core, "../../../usr/bin")};${process.env.SystemRoot}/System32`
          : "/usr/bin:/bin",
    };
    const originalPath = process.env.PATH;
    writeFileSync(
      path.join(cwd, "vite.config.ts"),
      'export default { staged: { "*.js": "node --version" } };\n',
    );
    writeFileSync(path.join(cwd, "sample.js"), "export const staged = true;\n");
    git(cwd, "add", "vite.config.ts", "sample.js");
    const commit = (directory = cwd) =>
      spawnSync(gitPath, ["commit", "--allow-empty", "-qm", "runtime fixture"], {
        cwd: directory,
        env: lean,
        encoding: "utf8",
        timeout: 60_000,
        windowsHide: true,
      });
    const success = commit();
    assert.equal(success.status, 0, success.stderr || success.stdout || success.error?.message);
    git(cwd, "config", "extensions.worktreeConfig", "true");
    const sibling = `${cwd}-linked`;
    git(cwd, "worktree", "add", "-qb", "runtime-linked", sibling);
    symlinkSync(path.join(root, "node_modules"), path.join(sibling, "node_modules"), "junction");
    configureHooks(sibling, "enable", env);
    writeFileSync(path.join(sibling, "sample.js"), "export const linked = true;\n");
    git(sibling, "add", "sample.js");
    const linked = commit(sibling);
    assert.equal(linked.status, 0, linked.stderr || linked.stdout || linked.error?.message);
    writeFileSync(path.join(cwd, ".node-version"), "0.0.0\n");
    const stale = commit();
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /Hook runtime mismatch/);
    writeFileSync(path.join(cwd, ".node-version"), process.versions.node);
    unlinkSync(runtime);
    assert.match(commit().stderr, /Hook runtime unavailable/);
    const commonBefore = readFileSync(path.join(cwd, ".git/config"), "utf8");
    const siblingRuntime = path.join(sibling, ".vite-hooks/_/portcove-node");
    const siblingBefore = readFileSync(siblingRuntime, "utf8");
    const siblingPreferences = configureHooks(sibling, "status", env);
    configureHooks(cwd, "install", env);
    assert.equal(readFileSync(path.join(cwd, ".git/config"), "utf8"), commonBefore);
    assert.equal(readFileSync(siblingRuntime, "utf8"), siblingBefore);
    assert.equal(configureHooks(sibling, "status", env), siblingPreferences);
    writeFileSync(path.join(cwd, "sample.js"), "export const refreshed = true;\n");
    git(cwd, "add", "sample.js");
    const refreshed = commit();
    assert.equal(
      refreshed.status,
      0,
      refreshed.stderr || refreshed.stdout || refreshed.error?.message,
    );
    assert.equal(git(cwd, "show", "HEAD:sample.js"), "export const refreshed = true;\n");
    unlinkSync(path.join(cwd, ".vite-hooks/_/portcove-node"));
    assert.match(commit().stderr, /Hook runtime missing/);
    assert.equal(process.env.PATH, originalPath);
  },
);

void test("hook status, disabled preferences and foreign managers preserve runtime setup", () => {
  const cwd = fixture();
  git(cwd, "config", "extensions.worktreeConfig", "true");
  configureHooks(cwd, "enable", env);
  const launcher = path.join(cwd, ".vite-hooks/_/portcove-node");
  const before = readFileSync(launcher, "utf8");
  configureHooks(cwd, "status", env);
  configureHooks(cwd, "disable", env);
  assert.match(configureHooks(cwd, "install", env), /remain disabled/);
  git(cwd, "config", "--worktree", "core.hooksPath", "foreign-hooks");
  assert.match(configureHooks(cwd, "install", env), /Existing hook manager preserved/);
  assert.match(configureHooks(cwd, "enable", env), /Existing hook manager preserved/);
  assert.equal(readFileSync(launcher, "utf8"), before);
});

void test(
  "interrupted staged checks restore partial staging",
  { skip: process.platform === "win32" },
  async (t) => {
    const { spawn } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    const cwd = fixture();
    writeFileSync(
      path.join(cwd, "vite.config.ts"),
      'export default { fmt: {}, staged: { "*.js": ["vp fmt --config vite.config.ts --ignore-path .gitignore", "node slow.mjs"] } };\n',
    );
    writeFileSync(
      path.join(cwd, "slow.mjs"),
      'import {writeFileSync} from "node:fs";writeFileSync("waiting.marker", "ready");setInterval(()=>{},1000);\n',
    );
    writeFileSync(path.join(cwd, "sample.js"), "export const value={x:1}\n");
    git(cwd, "add", "sample.js");
    writeFileSync(path.join(cwd, "sample.js"), "export const value={x:1}\n// unstaged work\n");
    const before = git(cwd, "diff");
    const index = git(cwd, "show", ":sample.js");
    const child = spawn(vp.command, [...vp.args, "staged"], {
      cwd,
      env,
      detached: true,
      stdio: "ignore",
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    const pid = child.pid;
    assert.ok(pid !== undefined);
    t.after(() => {
      try {
        process.kill(-pid, "SIGTERM");
      } catch (error) {
        if (errorCode(error) !== "ESRCH") throw error;
      }
    });
    const deadline = Date.now() + 15_000;
    while (!existsSync(path.join(cwd, "waiting.marker"))) {
      assert(
        Date.now() < deadline,
        "staged fixture did not reach its controlled interruption point",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    process.kill(-pid, "SIGINT");
    const result = await closed;
    assert.notEqual(result.code, 0);
    assert.equal(git(cwd, "diff"), before);
    assert.equal(git(cwd, "show", ":sample.js"), index);
  },
);
