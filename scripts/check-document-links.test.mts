import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync } from "node:fs";
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
