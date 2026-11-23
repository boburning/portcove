import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  symlinkSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { checkDocumentLinks } from "./check-document-links.mts";
void test("new informational pages check local targets and anchors", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-links-"));
  try {
    writeFileSync(path.join(root, "target.md"), "# Working target\n");
    writeFileSync(path.join(root, "new.md"), "[valid](target.md#working-target)\n");
    checkDocumentLinks(root, ["new.md"]);
    for (const target of ["missing.md", "target.md#missing", "../outside.md"]) {
      writeFileSync(path.join(root, "new.md"), `[link](${target})\n`);
      assert.throws(() => checkDocumentLinks(root, ["new.md"]));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("checks real source lines and allocated GitHub heading IDs", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-anchors-"));
  try {
    writeFileSync(
      path.join(root, "guide.md"),
      "# Intro\n## Intro\n## Intro-1\n```sh\n# Example\n```\n<span id='legacy'></span>\n## _Managed_ modes and `route_id`\n",
    );
    writeFileSync(path.join(root, "code.ts"), "one\ntwo\n");
    for (const ref of [
      "guide.md#intro-1",
      "guide.md#intro-1-1",
      "guide.md#legacy",
      "guide.md#L2",
      "guide.md#managed-modes-and-route_id",
      "guide.md?plain=1#L2-L3",
      "code.ts#L1-L2",
    ]) {
      writeFileSync(path.join(root, "new.md"), `[link](${ref})\n`);
      checkDocumentLinks(root, ["new.md"]);
    }
    for (const ref of [
      "guide.md#intro-9",
      "guide.md#example",
      "guide.md#L9",
      "code.ts#L0",
      "code.ts#L3",
      "code.ts#L2-L1",
    ]) {
      writeFileSync(path.join(root, "new.md"), `[link](${ref})\n`);
      assert.throws(() => checkDocumentLinks(root, ["new.md"]));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("line references only read regular files inside the repository", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "portcove-line-files-"));
  try {
    const root = path.join(base, "repo");
    mkdirSync(root);
    mkdirSync(path.join(base, "outside"));
    writeFileSync(path.join(base, "outside", "notes.txt"), "one\n");
    symlinkSync(path.join(base, "outside"), path.join(root, "linked"), "junction");
    for (const ref of ["linked/notes.txt#L1", ".#L1"]) {
      writeFileSync(path.join(root, "new.md"), `[lines](${ref})\n`);
      assert.throws(() => checkDocumentLinks(root, ["new.md"]), /regular repository file/u);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// The restriction register cites limits by file and name, so a renamed or removed
// limit fails here instead of leaving a stale row. Every production bound constant
// (a name with a MAX, LIMIT, BOUND, CAP or BUDGET segment) must be named in the
// register or in the reviewed exclusions below.
const registerExclusions: Record<string, string> = {};

const boundSegments = new Set([
  "MAX",
  "MAXIMUM",
  "LIMIT",
  "LIMITS",
  "BOUND",
  "BOUNDS",
  "CAP",
  "BUDGET",
]);
const boundDeclaration =
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:const|static)\s+([A-Z][A-Z0-9_]*)\b/u;
const testSource = /(?:^|\/)tests?\/|_tests?\.rs$|\.test\.|test_support|test_http/u;

function* registerSources(root: string, relative: string): Generator<string> {
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") yield* registerSources(root, child);
    } else if (/\.(?:rs|ts|tsx|mts)$/u.test(entry.name) && !testSource.test(child)) yield child;
  }
}

function productionBoundConstants(root: string) {
  const roots = readdirSync(path.join(root, "crates"))
    .map((crate) => `crates/${crate}/src`)
    .concat(["apps/desktop/src-tauri/src", "apps/desktop/src"]);
  const files = roots
    .filter((directory) => existsSync(path.join(root, directory)))
    .flatMap((directory) => [...registerSources(root, directory)])
    .concat(
      readdirSync(path.join(root, "scripts"))
        .filter((name) => name.endsWith(".mts") && !name.includes(".test."))
        .map((name) => `scripts/${name}`),
    );
  const found: string[] = [];
  for (const file of files) {
    let inTests = false;
    for (const line of readFileSync(path.join(root, file), "utf8").split(/\r?\n/u)) {
      // Constants after a Rust test module belong to tests.
      if (file.endsWith(".rs") && /^\s*#\[cfg\(test\)\]/u.test(line)) inTests = true;
      const name = inTests ? undefined : boundDeclaration.exec(line)?.[1];
      if (name && name.split("_").some((segment) => boundSegments.has(segment)))
        found.push(`${file} ${name}`);
    }
  }
  return found;
}

function registerCitations(register: string) {
  const cited = new Set<string>();
  const problems: string[] = [];
  const cite = (file: string, names: string[]) => {
    if (!/^(?:crates|apps|scripts)\/[\w./-]+$/u.test(file)) problems.push(`not a path: ${file}`);
    for (const name of names) cited.add(`${file} ${name}`);
  };
  let section = "";
  for (const line of register.split(/\r?\n/u)) {
    section = /^## ([A-Z])\. /u.exec(line)?.[1] ?? (line.startsWith("## ") ? "" : section);
    const cells = line.split(/(?<!\\)\|/u).map((cell) => cell.trim());
    // Section B rows: | Id | `path` `name`, `name`; `path` `name` | ...
    if (section === "B" && /^[A-Z]{2}-\d{2}$/u.test(cells[1] ?? ""))
      for (const segment of (cells[2] ?? "").split(";")) {
        const [file, ...names] = [...segment.matchAll(/`([^`]+)`/gu)].map((match) => match[1]!);
        if (file) cite(file, names);
        else problems.push(`row ${cells[1]} has no cited file`);
      }
    // Appendix F rows: | `NAME` | `path` | ...
    if (section === "F" && /^`[A-Z]/u.test(cells[1] ?? "")) {
      const file = /^`([^`]+)`$/u.exec(cells[2] ?? "")?.[1];
      if (file)
        cite(
          file,
          [...cells[1]!.matchAll(/`([^`]+)`/gu)].map((match) => match[1]!),
        );
      else problems.push(`named bound ${cells[1]} has no single cited file`);
    }
  }
  return { cited, problems };
}

void test("restriction register citations resolve and name every production bound constant", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const register = readFileSync(path.join(root, "docs/RESTRICTION-REGISTER.md"), "utf8");
  const { cited, problems } = registerCitations(register);
  assert.ok(cited.size > 200, "the register cites its limits");
  const sources = new Map<string, string>();
  for (const citation of cited) {
    const [file, name] = citation.split(/ (.*)/su) as [string, string];
    if (!sources.has(file))
      sources.set(
        file,
        existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), "utf8") : "",
      );
    const source = sources.get(file)!;
    if (!source) problems.push(`missing file: ${file}`);
    else if (!source.includes(name)) problems.push(`${file} no longer contains \`${name}\``);
  }
  const named = new Set(cited);
  for (const constant of productionBoundConstants(root))
    if (!named.has(constant) && !(constant in registerExclusions))
      problems.push(`unregistered bound: ${constant}`);
  for (const excluded of Object.keys(registerExclusions))
    if (named.has(excluded)) problems.push(`excluded bound is also registered: ${excluded}`);
  assert.deepEqual(problems, []);
});

void test("restriction register parsing reads row locations and named bounds", () => {
  const { cited, problems } = registerCitations(
    [
      "## A. Summary",
      "| LC-02 | 3 | not a location |",
      "## B. Register",
      "| LC-01 | `crates/a/src/x.rs` `MAX_A`, `b_fn`; `scripts/y.mts` `limitB` | 3 |",
      "| Class | Meaning |",
      "## E. Retained limits",
      "| LC-01 | 3 | reason |",
      "## F. Other named bounds",
      "| `MAX_C` / `MAX_D` | `crates/a/src/z.rs` | 64 |",
    ].join("\n"),
  );
  assert.deepEqual(problems, []);
  assert.deepEqual([...cited].sort(), [
    "crates/a/src/x.rs MAX_A",
    "crates/a/src/x.rs b_fn",
    "crates/a/src/z.rs MAX_C",
    "crates/a/src/z.rs MAX_D",
    "scripts/y.mts limitB",
  ]);
});
