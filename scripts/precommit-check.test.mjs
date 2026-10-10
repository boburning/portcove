import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const base = path.join(root, "work/precommit-fixtures");
mkdirSync(base, { recursive: true });
const files = [
  ".husky/pre-commit",
  "lint-staged.config.mjs",
  "scripts/precommit-check.mjs",
  "scripts/hooks-install.mjs",
  "scripts/checked-git.mjs",
  "scripts/report-summary.mjs",
  "scripts/oxfmt-ownership.mjs",
  "scripts/run-oxfmt.mjs",
  "apps/desktop/scripts/check-copy.mjs",
  "apps/desktop/scripts/copy-source-ownership.mjs",
  "apps/desktop/package.json",
  ".node-version",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".oxfmtrc.json",
  ".editorconfig",
  ".gitattributes",
];

function command(cwd, exe, args, options = {}) {
  return spawnSync(exe, args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    env: {
      ...process.env,
      HUSKY: "1",
      GITHUB_ACTIONS: "",
      GIT_CONFIG: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_CONFIG_COUNT: undefined,
    },
    ...options,
  });
}
function git(cwd, ...args) {
  const result = command(cwd, "git", args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function write(cwd, file, content) {
  mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  writeFileSync(path.join(cwd, file), content);
}
function fixture(initial = false, install = true, dependencies = true, desktopDependencies = true) {
  const cwd = mkdtempSync(path.join(base, "space ü "));
  for (const file of files) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    copyFileSync(path.join(root, file), path.join(cwd, file));
  }
  write(cwd, ".gitignore", "node_modules/\napps/desktop/node_modules/\nwork/\n");
  if (dependencies)
    symlinkSync(
      path.join(root, "node_modules"),
      path.join(cwd, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
  if (desktopDependencies)
    symlinkSync(
      path.join(root, "apps/desktop/node_modules"),
      path.join(cwd, "apps/desktop/node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "fixture@example.invalid");
  git(cwd, "config", "user.name", "Fixture");
  git(cwd, "add", "--", ...files, ".gitignore");
  if (!initial) git(cwd, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "initial fixture");
  if (install) {
    const installed = command(cwd, process.execPath, ["scripts/hooks-install.mjs"]);
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  }
  return cwd;
}
const check = (cwd) => command(cwd, process.execPath, ["scripts/precommit-check.mjs"]);
function state(cwd) {
  return {
    index: git(cwd, "ls-files", "--stage", "-z"),
    status: git(cwd, "status", "--porcelain=v1", "-z"),
    unstaged: git(cwd, "diff", "--binary"),
    staged: git(cwd, "diff", "--cached", "--binary"),
    stashes: git(cwd, "stash", "list"),
  };
}

test("real manual path and Git commits use staged content and preserve unrelated work", () => {
  const cwd = fixture();
  write(cwd, "note.md", "# Clear instructions\n");
  git(cwd, "add", "--", "note.md");
  write(cwd, "untracked.txt", "keep me\n");
  const before = state(cwd);
  assert.equal(check(cwd).status, 0);
  assert.deepEqual(state(cwd), before);
  const committed = command(cwd, "git", ["commit", "-qm", "docs: staged fixture"], {
    env: { ...process.env, HUSKY: "1", CI: "true" },
  });
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(readFileSync(path.join(cwd, "untracked.txt"), "utf8"), "keep me\n");
  assert.equal(
    command(cwd, "git", ["commit", "--allow-empty", "-qm", "chore: empty"], {
      env: { ...process.env, HUSKY: "1" },
    }).status,
    0,
  );
});

for (const [title, filename, invalid, valid] of [
  ["format", "bad.mjs", "const x=1;\n", "const x = 1;\n"],
  ["syntax", "bad.mjs", "const x = ;\n", "const x = 1;\n"],
  [
    "copy",
    "apps/desktop/src/Copy.tsx",
    'const label = "Source profile";\n',
    'const label = "Game files";\n',
  ],
  ["whitespace", "text.txt", "bad \n", "fine\n"],
  ["conflict", "text.txt", "<<<<<<< ours\n=======\n>>>>>>> theirs\n", "fine\n"],
]) {
  test(`${title}: staged error with unstaged repair fails and restores exact state`, () => {
    const cwd = fixture();
    write(cwd, filename, "// baseline\n");
    git(cwd, "add", "--", filename);
    git(cwd, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture baseline");
    write(cwd, filename, invalid);
    git(cwd, "add", "--", filename);
    write(cwd, filename, valid);
    const before = state(cwd);
    const result = check(cwd);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(state(cwd), before);
  });
}

test("clean staged source passes despite unstaged error, without restaging or losing existing stashes", () => {
  const cwd = fixture();
  write(cwd, "file.mjs", "const x = 1;\n");
  git(cwd, "add", "--", "file.mjs");
  git(cwd, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "baseline");
  write(cwd, "file.mjs", "const x = 2;\n");
  git(cwd, "stash", "push", "-qm", "existing stash");
  write(cwd, "file.mjs", "const x = 3;\n");
  git(cwd, "add", "--", "file.mjs");
  write(cwd, "file.mjs", "const x = ;\n");
  const before = state(cwd);
  const result = check(cwd);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(state(cwd), before);
});

test("unstaged checker/config inputs refuse before temporary changes", () => {
  for (const file of [
    ".oxfmtrc.json",
    "scripts/run-oxfmt.mjs",
    "lint-staged.config.mjs",
    "scripts/precommit-check.mjs",
  ]) {
    const cwd = fixture();
    write(cwd, "note.md", "# Text\n");
    git(cwd, "add", "--", "note.md");
    writeFileSync(path.join(cwd, file), readFileSync(path.join(cwd, file), "utf8") + "\n");
    const before = state(cwd);
    const result = check(cwd);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Stage or restore consumed/);
    assert.deepEqual(state(cwd), before);
  }
});

test("unstaged deleted ancestor inputs cannot change formatting or Node syntax", () => {
  for (const [input, content, source] of [
    ["nested/.oxfmtrc.jsonc", '{"semi": false}\n', "nested/source.mjs"],
    ["nested/package.json", '{"type":"commonjs"}\n', "nested/source.js"],
  ]) {
    const cwd = fixture();
    write(cwd, input, content);
    git(cwd, "add", "--", input);
    git(cwd, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "indexed ancestor input");
    write(cwd, source, "export const value = 1;\n");
    git(cwd, "add", "--", source);
    unlinkSync(path.join(cwd, input));
    const before = state(cwd);
    const failed = check(cwd);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Stage or restore consumed/);
    assert.doesNotMatch(failed.stdout, /Backing up|Hiding unstaged/);
    assert.deepEqual(state(cwd), before);
  }
});

test("unstaged nearest package manifest cannot change Node syntax goal", () => {
  const cwd = fixture();
  write(cwd, "apps/desktop/scripts/source.js", "export const value = 1;\n");
  git(cwd, "add", "--", "apps/desktop/scripts/source.js");
  const manifest = JSON.parse(readFileSync(path.join(cwd, "apps/desktop/package.json"), "utf8"));
  manifest.type = "commonjs";
  write(cwd, "apps/desktop/package.json", JSON.stringify(manifest, null, 2) + "\n");
  const before = state(cwd);
  const failed = check(cwd);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Stage or restore consumed.*apps\/desktop\/package.json/);
  assert.doesNotMatch(failed.stdout, /Backing up|Hiding unstaged/);
  assert.deepEqual(state(cwd), before);
});

test("formatter ignores and nested configuration cannot qualify different staged content", () => {
  for (const [filename, content, ignored] of [
    [".prettierignore", "bad.mjs\n", false],
    [".prettierignore", "bad.mjs\n", true],
    ["nested/.oxfmtrc.jsonc", '{"semi": false}\n', false],
    ["nested/oxfmt.config.ts", "export default {};\n", false],
  ]) {
    const cwd = fixture();
    write(cwd, "nested/bad.mjs", "const x=1;\n");
    git(cwd, "add", "--", "nested/bad.mjs");
    if (ignored) {
      writeFileSync(
        path.join(cwd, ".gitignore"),
        readFileSync(path.join(cwd, ".gitignore"), "utf8") + ".prettierignore\n",
      );
      git(cwd, "add", "--", ".gitignore");
    }
    write(cwd, filename, content);
    const before = state(cwd);
    const failed = check(cwd);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /prettierignore|oxfmtrc|formatter configuration/);
    assert.doesNotMatch(failed.stdout, /Backing up|Hiding unstaged/);
    assert.deepEqual(state(cwd), before);
  }
});

test("copy parser native readiness is checked before lint-staged changes state", () => {
  const cwd = fixture(false, true, true, false);
  write(
    cwd,
    "apps/desktop/node_modules/oxc-parser/package.json",
    '{"type":"module","exports":"./index.js"}\n',
  );
  write(
    cwd,
    "apps/desktop/node_modules/oxc-parser/index.js",
    'throw new Error("optional native binding unavailable");\n',
  );
  write(cwd, "apps/desktop/src/Copy.tsx", 'const label = "Game files";\n');
  git(cwd, "add", "--", "apps/desktop/src/Copy.tsx");
  write(cwd, "apps/desktop/src/Copy.tsx", 'const label = "Source profile";\n');
  const before = state(cwd);
  const failed = check(cwd);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /oxc-parser\/native binding unavailable/);
  assert.doesNotMatch(failed.stdout, /Backing up|Hiding unstaged/);
  assert.deepEqual(state(cwd), before);
});

test("initial commit, renames, deletions, modes and unusual literal paths", () => {
  const cwd = fixture(true);
  const names = ["space ü.mjs", "-leading.mjs", "shell$&;'.mjs"];
  for (const filename of names) {
    write(cwd, filename, "const x = 1;\n");
    git(cwd, "add", "--", filename);
  }
  git(cwd, "update-index", "--chmod=+x", "--", names[0]);
  const before = state(cwd);
  const result = check(cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(state(cwd), before);
  git(cwd, "commit", "-qm", "initial real hooked commit");
  git(cwd, "mv", "--", names[0], "renamed ü.mjs");
  git(cwd, "rm", "--", names[1], names[2]);
  assert.equal(check(cwd).status, 0);
  git(cwd, "commit", "-qm", "rename and delete");
  git(cwd, "rm", "--", "renamed ü.mjs");
  assert.equal(check(cwd).status, 0);
});

test("frozen/generated content and empty applicable sets do not invoke whole-repository tools", () => {
  const cwd = fixture();
  for (const file of [
    "docs/archive/invalid.md",
    "crates/portcove-core/tests/fixtures/invalid.mjs",
    "skip.generated.mjs",
    "tiny.rs",
  ])
    write(cwd, file, "not formatted or compilable but deliberately outside hook ownership\n");
  git(cwd, "add", ".");
  const before = state(cwd);
  const result = check(cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(state(cwd), before);
});

test("missing selected dependency fails before state changes", () => {
  const cwd = fixture();
  const manifest = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
  manifest.devDependencies.oxfmt = "0.0.0";
  write(cwd, "package.json", JSON.stringify(manifest, null, 2) + "\n");
  git(cwd, "add", "package.json");
  const before = state(cwd);
  const result = check(cwd);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Installed oxfmt must be/);
  assert.deepEqual(state(cwd), before);
  const missing = fixture(false, false, false);
  write(missing, "note.md", "# Text\n");
  git(missing, "add", "note.md");
  const original = state(missing);
  const failed = check(missing);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Missing installed lint-staged/);
  assert.deepEqual(state(missing), original);
});

test("default copy scan stays complete, explicit scan and syntax checks never execute source", () => {
  const cwd = fixture();
  write(cwd, "apps/desktop/src/Valid.tsx", 'const label = "Game files";\n');
  write(cwd, "apps/desktop/src/Bad.tsx", 'const label = "Source profile";\n');
  write(
    cwd,
    "scripts/inert.mjs",
    'throw new Error("Do not execute implementation syntax targets");\n',
  );
  git(cwd, "add", "--", "apps/desktop/src/Valid.tsx", "scripts/inert.mjs");
  assert.equal(check(cwd).status, 0);
  assert.notEqual(
    command(cwd, process.execPath, ["apps/desktop/scripts/check-copy.mjs"]).status,
    0,
  );
  assert.equal(
    command(cwd, process.execPath, [
      "apps/desktop/scripts/check-copy.mjs",
      "--files",
      "apps/desktop/src/Valid.tsx",
    ]).status,
    0,
  );
  assert.notEqual(
    command(cwd, process.execPath, ["apps/desktop/scripts/check-copy.mjs", "--files"]).status,
    0,
  );
});

test("bounded small-commit hook timing samples", (t) => {
  const cwd = fixture();
  for (const [kind, file, text] of [
    ["documentation", "timing.md", "# Instructions\n"],
    ["frontend", "apps/desktop/src/Timing.tsx", 'const label = "Game files";\n'],
    ["rust", "timing.rs", "fn main() {}\n"],
  ]) {
    write(cwd, file, text);
    git(cwd, "add", "--", file);
    const samples = [];
    for (let i = 0; i < 4; i++) {
      const started = performance.now();
      const result = check(cwd);
      samples.push(Math.round(performance.now() - started));
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    const warm = samples.slice(1).sort((a, b) => a - b);
    t.diagnostic(
      JSON.stringify({
        host: process.platform,
        kind,
        count: samples.length,
        firstInvocationMs: samples[0],
        warmCount: 3,
        warmMedianMs: warm[1],
        slowestMs: Math.max(...samples),
        cache: "prepared dependencies; first process invocation is not a cold install",
      }),
    );
    git(cwd, "-c", "core.hooksPath=/dev/null", "commit", "-qm", `timing ${kind}`);
  }
});

test(
  "symlink source targets are refused without reading outside checkout",
  { skip: process.platform === "win32" },
  () => {
    const cwd = fixture();
    symlinkSync(path.join(root, "package.json"), path.join(cwd, "outside.mjs"));
    git(cwd, "add", "outside.mjs");
    const before = state(cwd);
    assert.notEqual(check(cwd).status, 0);
    assert.deepEqual(state(cwd), before);
  },
);

test("idempotent linked-worktree setup preserves sibling hook settings and rejects foreign managers", () => {
  const cwd = fixture(false, false);
  const sibling = path.join(base, `sibling-${path.basename(cwd)}`);
  git(cwd, "worktree", "add", "-qb", `fixture-${path.basename(cwd).slice(-6)}`, sibling);
  assert.equal(command(cwd, process.execPath, ["scripts/hooks-install.mjs"]).status, 0);
  assert.equal(command(sibling, "git", ["config", "--get", "core.hooksPath"]).status, 1);
  symlinkSync(
    path.join(root, "node_modules"),
    path.join(sibling, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const before = state(cwd);
  for (let i = 0; i < 2; i++)
    assert.equal(command(sibling, process.execPath, ["scripts/hooks-install.mjs"]).status, 0);
  assert.deepEqual(state(cwd), before);
  write(sibling, "new.md", "# Linked worktree\n");
  git(sibling, "add", "new.md");
  git(sibling, "commit", "-qm", "linked hooked commit");
  git(sibling, "config", "--worktree", "core.hooksPath", "foreign-hooks");
  const refused = command(sibling, process.execPath, ["scripts/hooks-install.mjs"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Existing hook manager/);
  assert.equal(git(sibling, "config", "--get", "core.hooksPath").trim(), "foreign-hooks");
});

test(
  "supported SIGINT restoration retains partial state",
  { skip: process.platform === "win32" },
  async () => {
    const cwd = fixture();
    write(
      cwd,
      "scripts/run-oxfmt.mjs",
      'import {writeFileSync} from "node:fs"; writeFileSync("work/task-started", "yes"); setTimeout(() => {}, 10000);\n',
    );
    git(cwd, "add", "scripts/run-oxfmt.mjs");
    git(cwd, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "slow fixture checker");
    write(cwd, "note.md", "# Original\n");
    git(cwd, "add", "note.md");
    git(cwd, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "base note");
    write(cwd, "note.md", "# Staged\n");
    git(cwd, "add", "note.md");
    write(cwd, "note.md", "# Unstaged\n");
    mkdirSync(path.join(cwd, "work"), { recursive: true });
    const before = state(cwd);
    const child = spawn(process.execPath, ["scripts/precommit-check.mjs"], {
      cwd,
      stdio: "ignore",
      env: { ...process.env, HUSKY: "1" },
    });
    const ended = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    const deadline = Date.now() + 15000;
    while (!existsSync(path.join(cwd, "work/task-started")) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(path.join(cwd, "work/task-started")));
    child.kill("SIGINT");
    assert.notEqual(await ended, 0);
    assert.deepEqual(state(cwd), before);
  },
);
