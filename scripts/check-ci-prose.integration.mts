import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  realpathSync,
  renameSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnCommand } from "./dev-storage.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = mkdtempSync(path.join(os.tmpdir(), "portcove-prose-ci-"));
const evidence = path.join(root, "work", "prose-ci-integration", randomUUID());
mkdirSync(evidence, { recursive: true });
const steps = [];
const source = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const env = { ...process.env, CI: "true", VP_GIT_HOOKS: "0" };
const inheritedPath = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
// Deliberately exercise Windows' usual Path-only environment, including when a
// prepared parent shell happens to expose the uppercase spelling instead.
env[process.platform === "win32" ? "Path" : "PATH"] = inheritedPath;
delete env.NODE_PATH;
delete env.PORTCOVE_CI_METRICS_DIR;
// The source's job store is not the fixture's installation or evidence owner.
for (const key of Object.keys(env))
  if (key.toLowerCase() === "pnpm_config_store_dir") delete env[key];
const git = (...args) =>
  execFileSync("git", args, { cwd: fixture, env, encoding: "utf8", windowsHide: true }).trim();
const commit = () => {
  git("add", "docs/GUI-COMPETITIVE-REVIEW.md");
  git(
    "-c",
    "core.hooksPath=",
    "-c",
    "user.name=Portcove prose fixture",
    "-c",
    "user.email=prose-fixture@example.invalid",
    "commit",
    "-m",
    "docs: isolated prose control",
  );
  env.PORTCOVE_HEAD_SHA = git("rev-parse", "HEAD");
};
function run(name, command, args, environment = env, timeout = 60_000) {
  const started = Date.now();
  const result = spawnCommand(command, args, {
    cwd: fixture,
    env: environment,
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  writeFileSync(path.join(evidence, `${name}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`);
  steps.push({ name, command, args, status: result.status, duration_ms: Date.now() - started });
  return result;
}
const check = (name, extra = {}, args = []) =>
  run(name, process.execPath, ["scripts/check-ci-prose.mts", ...args], { ...env, ...extra });
const output = (result) => `${result.stdout ?? ""}${result.stderr ?? ""}`;
let passed = false;
let overlays = [];
try {
  execFileSync("git", ["clone", "--shared", "--no-checkout", root, fixture], {
    encoding: "utf8",
    windowsHide: true,
  });
  git("checkout", "--detach", source);
  // Local feedback exercises the candidate's tracked edits, without borrowing
  // node_modules. Hosted clean source has no overlay; retain hashes either way.
  overlays = execFileSync("git", ["diff", "HEAD", "--name-only", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .map((file: string) => {
      assert(!path.isAbsolute(file) && !file.split("/").includes(".."));
      const from = path.join(root, file);
      const to = path.join(fixture, file);
      if (existsSync(from)) {
        mkdirSync(path.dirname(to), { recursive: true });
        copyFileSync(from, to);
        return { file, sha256: createHash("sha256").update(readFileSync(from)).digest("hex") };
      }
      rmSync(to);
      return { file, deleted: true };
    });
  assert(!existsSync(path.join(fixture, "node_modules")));
  assert(!existsSync(path.join(fixture, "apps/desktop/node_modules")));
  env.PORTCOVE_MERGE_BASE = source;
  env.PORTCOVE_HEAD_SHA = source;
  env.PORTCOVE_PROSE_FILES = JSON.stringify(["docs/GUI-COMPETITIVE-REVIEW.md"]);
  const document = path.join(fixture, "docs/GUI-COMPETITIVE-REVIEW.md");
  const original = readFileSync(document, "utf8");
  rmSync(document);
  commit();
  assert.equal(
    output(check("deleted-prerequisites", {}, ["--prerequisites"])).trim(),
    "frontend_dependencies=false",
  );
  assert.equal(check("deleted-only").status, 0);
  assert(!existsSync(path.join(fixture, "node_modules")));
  writeFileSync(document, original + "\nClean prose prerequisite control.\n");
  commit();
  assert.equal(
    output(check("existing-prerequisites", {}, ["--prerequisites"])).trim(),
    "frontend_dependencies=true",
  );
  const missing = check("missing-dependencies");
  assert.notEqual(missing.status, 0);
  assert.match(output(missing), /Prose formatting requires the pinned workspace dependencies/);
  for (const [name, plan] of [
    ["empty", "[]"],
    ["invalid-json", "{"],
    ["outside", '["package.json"]'],
    ["wrong-type", "[1]"],
  ]) {
    const rejected = check(`plan-${name}`, { PORTCOVE_PROSE_FILES: plan }, ["--prerequisites"]);
    assert.notEqual(rejected.status, 0);
    assert.match(output(rejected), /prose file plan|PORTCOVE_PROSE_FILES/);
  }
  assert.notEqual(
    check("invalid-head", { PORTCOVE_HEAD_SHA: "HEAD" }, ["--prerequisites"]).status,
    0,
  );
  const pin = JSON.parse(readFileSync(path.join(fixture, "package.json"), "utf8")).packageManager;
  const version = run("pnpm-version", "pnpm", ["--version"]);
  assert.equal(version.status, 0);
  assert.equal(`pnpm@${version.stdout.trim()}`, pin);
  // Same frozen root-workspace operation requested by setup-vp/run-install.
  assert.equal(
    run(
      "frozen-install",
      "pnpm",
      ["install", "--filter", "portcove-repository", "--frozen-lockfile", "--ignore-scripts"],
      env,
      300_000,
    ).status,
    0,
  );
  assert(existsSync(path.join(fixture, "node_modules/vite-plus/package.json")));
  // Prove the consumer follows the package declaration, not the historical bin
  // filename or the package manager's pre-generated shim. Preserve bin-relative
  // imports and replace the manifest atomically rather than modifying hardlinks.
  const packageFile = realpathSync(path.join(fixture, "node_modules/vite-plus/package.json"));
  const packageRelative = path.relative(fixture, packageFile);
  assert(!path.isAbsolute(packageRelative) && !packageRelative.startsWith(".."));
  const manifest = JSON.parse(readFileSync(packageFile, "utf8"));
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin.vp;
  const relocated = path.posix.join(
    path.posix.dirname(bin),
    `declared-prose-vp${path.extname(bin)}`,
  );
  renameSync(
    path.resolve(path.dirname(packageFile), bin),
    path.resolve(path.dirname(packageFile), relocated),
  );
  if (typeof manifest.bin === "string") manifest.bin = relocated;
  else manifest.bin.vp = relocated;
  writeFileSync(`${packageFile}.probe`, JSON.stringify(manifest));
  renameSync(`${packageFile}.probe`, packageFile);
  assert(
    !existsSync(path.join(fixture, "work/browser-cache")),
    "Prose must not provision Chromium",
  );
  const canaries = path.join(fixture, "work", "path-canaries");
  mkdirSync(canaries, { recursive: true });
  for (const name of ["vp", "corepack"])
    writeFileSync(
      path.join(canaries, name + (process.platform === "win32" ? ".cmd" : "")),
      process.platform === "win32" ? "@exit /b 97\r\n" : "#!/bin/sh\nexit 97\n",
      { mode: 0o755 },
    );
  const runtime = { ...env };
  const runtimePath =
    Object.entries(runtime).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  for (const key of Object.keys(runtime)) if (key.toLowerCase() === "path") delete runtime[key];
  runtime.PATH = `${canaries}${path.delimiter}${runtimePath}`;
  assert.equal(
    run(
      "repository-contracts",
      process.execPath,
      [
        "--test",
        "--test-timeout=30000",
        "scripts/repository-settings.test.mts",
        "scripts/repository-skills.test.mts",
      ],
      runtime,
    ).status,
    0,
  );
  assert.equal(
    run("valid-prose", process.execPath, ["scripts/check-ci-prose.mts"], runtime).status,
    0,
  );
  // Exercise the formatter-only normal quality route with its real planner/adapter.
  assert.equal(
    run(
      "formatter-only-quality",
      process.execPath,
      ["scripts/run-viteplus.mts", "fmt", "--check", "docs/QUALITY.md"],
      runtime,
    ).status,
    0,
  );
  writeFileSync(document, "# Prose control\n\n|name|value|\n|---|---|\n|one|two|\n");
  commit();
  const malformed = run("misformatted-prose", process.execPath, ["scripts/check-ci-prose.mts"], {
    ...runtime,
    PORTCOVE_HEAD_SHA: env.PORTCOVE_HEAD_SHA,
  });
  assert.notEqual(malformed.status, 0);
  assert.match(output(malformed), /Formatting|formatting|Code style|Check failed/);
  assert.notEqual(malformed.status, 97, "A global executable cannot supply the failure");
  passed = true;
  console.log(`Clean prose execution passed ${steps.length} controls; retained logs: ${evidence}`);
} finally {
  writeFileSync(
    path.join(evidence, "result.json"),
    JSON.stringify(
      {
        source,
        fixture,
        overlays,
        input_path_keys: Object.keys(env).filter((key: string) => key.toLowerCase() === "path"),
        passed,
        steps,
      },
      null,
      2,
    ) + "\n",
  );
  if (passed) {
    assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
    assert(path.basename(fixture).startsWith("portcove-prose-ci-"));
    rmSync(fixture, { recursive: true });
  } else {
    console.error(`Failed clean prose source and logs retained: ${fixture}; ${evidence}`);
  }
}
