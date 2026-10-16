import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { checkDocumentLinks } from "./check-document-links.mjs";
test("new informational pages check local targets and anchors", () => {
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
