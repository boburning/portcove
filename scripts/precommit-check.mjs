import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCheckedGit } from "./checked-git.mjs";
import { isExcludedOxfmtPath, isOwnedOxfmtPath } from "./oxfmt-ownership.mjs";
import { isProductionCopyPath as copyPath } from "../apps/desktop/scripts/copy-source-ownership.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const setup = "Run the pinned frozen dependency install, then pnpm run hooks:install.";
let interruption;
const inputs = [
  ".husky/pre-commit",
  "lint-staged.config.mjs",
  "scripts/precommit-check.mjs",
  "scripts/checked-git.mjs",
  "scripts/oxfmt-ownership.mjs",
  "scripts/run-oxfmt.mjs",
  "scripts/report-summary.mjs",
  "apps/desktop/scripts/copy-source-ownership.mjs",
  ".node-version",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".oxfmtrc.json",
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".prettierignore",
];
const syntaxPath = (file) => /\.(?:mjs|cjs|js)$/u.test(file) && !isExcludedOxfmtPath(file);
const git = (args) => runCheckedGit(args, { cwd: root });
const nul = (value) => value.split("\0").filter(Boolean);

function relativeFile(file) {
  const relative = path.relative(root, path.resolve(root, file)).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative))
    throw new Error(`Unsafe hook path: ${file}`);
  return relative;
}

function regularSource(file) {
  let current = root;
  for (const component of file.split("/")) {
    current = path.join(current, component);
    if (lstatSync(current).isSymbolicLink()) return false;
  }
  return lstatSync(current).isFile();
}

function requirePackage(directory, name, version) {
  const filename = path.join(directory, "node_modules", name, "package.json");
  if (!existsSync(filename)) throw new Error(`Missing installed ${name}. ${setup}`);
  const installed = JSON.parse(readFileSync(filename, "utf8"));
  if (installed.version !== version)
    throw new Error(`Installed ${name} must be ${version}. ${setup}`);
}

export function preflight() {
  git(["diff", "--cached", "--check"]);
  const files = nul(git(["diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z"]));
  if (!files.length) return [];
  const consumed = [...inputs];
  // Inspect ancestor directories directly: ignored/untracked configuration can
  // still affect Oxfmt and must not disappear from Git's ordinary inventory.
  for (const target of files.filter(isOwnedOxfmtPath)) {
    let directory = path.posix.dirname(target);
    while (true) {
      for (const name of [
        ".editorconfig",
        ".gitignore",
        ".gitattributes",
        ".prettierignore",
        ".oxfmtrc.json",
        ".oxfmtrc.jsonc",
        "oxfmt.config.ts",
        "oxfmt.config.mts",
      ]) {
        const file = directory === "." ? name : `${directory}/${name}`;
        if (!existsSync(path.join(root, file))) continue;
        if (/oxfmt\.config\.(?:ts|mts)$/u.test(name))
          throw new Error(
            `Executable formatter configuration needs independently checked transitive inputs; use selected validation: ${file}`,
          );
        consumed.push(file);
      }
      if (directory === ".") break;
      directory = path.posix.dirname(directory);
    }
  }
  if (files.some(copyPath))
    consumed.push("apps/desktop/scripts/check-copy.mjs", "apps/desktop/package.json");
  const unstaged = nul(git(["diff", "--name-only", "-z", "--", ...consumed]));
  if (unstaged.length)
    throw new Error(
      `Stage or restore consumed hook inputs before checking: ${unstaged.join(", ")}`,
    );
  for (const file of consumed) {
    if (!existsSync(path.join(root, file))) continue;
    if (!regularSource(file) || !git(["ls-files", "--error-unmatch", "--", file]).trim())
      throw new Error(`Consumed hook input must be a tracked regular file: ${file}`);
  }
  const pinnedNode = readFileSync(path.join(root, ".node-version"), "utf8").trim();
  if (process.versions.node !== pinnedNode)
    throw new Error(`Hook requires Node ${pinnedNode}; found ${process.versions.node}. ${setup}`);
  const dependencies = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  ).devDependencies;
  requirePackage(root, "lint-staged", dependencies["lint-staged"]);
  if (files.some(isOwnedOxfmtPath)) {
    requirePackage(root, "oxfmt", dependencies.oxfmt);
    const ready = spawnSync(
      process.execPath,
      [path.join(root, "node_modules/oxfmt/bin/oxfmt"), "--version"],
      { cwd: root, encoding: "utf8", windowsHide: true },
    );
    if (ready.error || ready.status !== 0)
      throw new Error(`Installed Oxfmt executable unavailable. ${setup}`);
  }
  if (files.some(copyPath)) {
    try {
      const parser = createRequire(path.join(root, "apps/desktop/package.json")).resolve(
        "oxc-parser",
      );
      const ready = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "const {parseSync}=await import(process.argv[1]); parseSync('ready.ts', 'const ready = true;');",
          pathToFileURL(parser).href,
        ],
        { cwd: root, encoding: "utf8", windowsHide: true },
      );
      if (ready.error || ready.status !== 0) throw new Error("Parser native binding unavailable");
    } catch {
      throw new Error(`Installed desktop oxc-parser/native binding unavailable. ${setup}`);
    }
  }
  // Reject indexed links before any checker or lint-staged can follow their target.
  const entries = nul(git(["ls-files", "--stage", "-z", "--", ...files]));
  const links = entries
    .filter((entry) => entry.startsWith("120000 "))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1));
  for (const file of files) {
    if (
      (isOwnedOxfmtPath(file) || copyPath(file) || /\.(?:mjs|cjs|js)$/u.test(file)) &&
      (links.includes(file) || !regularSource(file))
    )
      throw new Error(`Source checks refuse staged symlink/nonregular path: ${file}`);
  }
  return files;
}

function run(args) {
  return new Promise((resolve, reject) => {
    if (interruption?.signal.aborted) {
      reject(
        new Error(
          "Staged checks interrupted; lint-staged will restore or retain recovery evidence.",
        ),
      );
      return;
    }
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
      signal: interruption?.signal,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`Check failed (${code ?? signal}): ${args[0]}`)),
    );
  });
}

export async function checkStagedFiles(absoluteFiles) {
  const files = absoluteFiles.map(relativeFile);
  const formatting = files.filter(isOwnedOxfmtPath);
  if (formatting.length)
    await run([
      "scripts/run-oxfmt.mjs",
      "--check",
      ...formatting.map((file) => path.join(root, file)),
    ]);
  for (const file of files.filter(syntaxPath)) await run(["--check", path.join(root, file)]);
  const copy = files.filter(copyPath);
  if (copy.length) await run(["apps/desktop/scripts/check-copy.mjs", "--files", ...copy]);
}

export async function main() {
  const files = preflight();
  if (!files.length) {
    console.log("No applicable staged sources; staged whitespace checked.");
    return;
  }
  const { default: lintStaged } = await import("lint-staged");
  interruption = new AbortController();
  const interrupt = () => interruption.abort();
  process.on("SIGINT", interrupt);
  let passed;
  try {
    passed = await lintStaged({
      cwd: root,
      configPath: path.join(root, "lint-staged.config.mjs"),
      concurrent: false,
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
  if (!passed)
    throw new Error(
      "Staged checks failed. Fix with the existing formatter/copy diagnostics, then stage explicitly. Preserve any lint-staged recovery stash.",
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
