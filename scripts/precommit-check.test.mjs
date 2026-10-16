import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { configureHooks } from "./hooks-install.mjs";
import { vitePlusCommand } from "./viteplus-cli.mjs";

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
function run(cwd, executable, args, ok = true) {
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
const git = (cwd, ...args) => run(cwd, "git", args).stdout;
const cli = (cwd, ...args) => run(cwd, vp.command, [...vp.args, ...args]);
function fixture() {
  const cwd = mkdtempSync(path.join(base, "staged-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Portcove hook fixture");
  git(cwd, "config", "user.email", "hook-fixture@example.invalid");
  writeFileSync(path.join(cwd, "package.json"), '{"private":true,"type":"module"}\n');
  writeFileSync(
    path.join(cwd, "vite.config.ts"),
    'export default { staged: { "*.js": "vp fmt" } };\n',
  );
  writeFileSync(path.join(cwd, "sample.js"), "export const value = 1;\n");
  writeFileSync(path.join(cwd, ".gitignore"), ".vite-hooks/_/\n");
  mkdirSync(path.join(cwd, ".vite-hooks"));
  writeFileSync(
    path.join(cwd, ".vite-hooks/pre-commit"),
    readFileSync(path.join(root, ".vite-hooks/pre-commit")),
  );
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "fixture baseline");
  return cwd;
}

test("standard staged autofix preserves partial staging and unrelated work", () => {
  const cwd = fixture();
  writeFileSync(path.join(cwd, "sample.js"), "export const value={x:1}\n");
  git(cwd, "add", "sample.js");
  writeFileSync(path.join(cwd, "sample.js"), "export const value={x:1}\n// unstaged work\n");
  writeFileSync(path.join(cwd, "untracked.txt"), "unrelated work\n");
  cli(cwd, "staged");
  assert.equal(git(cwd, "show", ":sample.js"), "export const value = { x: 1 };\n");
  assert.match(readFileSync(path.join(cwd, "sample.js"), "utf8"), /unstaged work/);
  assert.equal(readFileSync(path.join(cwd, "untracked.txt"), "utf8"), "unrelated work\n");
});

test("a failed staged command restores the index and working changes", () => {
  const cwd = fixture();
  writeFileSync(
    path.join(cwd, "vite.config.ts"),
    'export default { staged: { "*.js": "node -e process.exit(7)" } };\n',
  );
  writeFileSync(path.join(cwd, "sample.js"), "export const value={x:1}\n");
  git(cwd, "add", "sample.js");
  writeFileSync(path.join(cwd, "sample.js"), "export const value={x:1}\n// unstaged work\n");
  const before = git(cwd, "diff");
  const index = git(cwd, "show", ":sample.js");
  const result = run(cwd, vp.command, [...vp.args, "staged"], false);
  assert.notEqual(result.status, 0);
  assert.equal(git(cwd, "diff"), before);
  assert.equal(git(cwd, "show", ":sample.js"), index);
});

test("supported hooks work from a linked worktree and noninteractive Git client", () => {
  const cwd = fixture();
  git(cwd, "config", "extensions.worktreeConfig", "true");
  git(cwd, "config", "--worktree", "core.hooksPath", ".husky/_");
  const commonBefore = readFileSync(path.join(cwd, ".git/config"), "utf8");
  const sibling = `${cwd}-linked`;
  git(cwd, "worktree", "add", "-qb", "linked-fixture", sibling);
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

test(
  "interrupted staged checks restore partial staging",
  { skip: process.platform === "win32" },
  async (t) => {
    const { spawn } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    const cwd = fixture();
    writeFileSync(
      path.join(cwd, "vite.config.ts"),
      'export default { staged: { "*.js": ["vp fmt", "node slow.mjs"] } };\n',
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
    const closed = new Promise((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    t.after(() => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
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
    process.kill(-child.pid, "SIGINT");
    const result = await closed;
    assert.notEqual(result.code, 0);
    assert.equal(git(cwd, "diff"), before);
    assert.equal(git(cwd, "show", ":sample.js"), index);
  },
);
