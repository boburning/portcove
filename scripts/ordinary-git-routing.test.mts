import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseRawDiff } from "./select-ci-plan.mts";
import { baselineLintPlan } from "./ci-baseline.mts";
import { buildValidationPlan, validateValidationPlan } from "./validation-plan.mts";

void test("Git metadata routes executable edit, lifecycle, chmod, both rename sides and rejects nonregular entries", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-routing-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  try {
    git("init");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Fixture");
    git("config", "core.autocrlf", "false");
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, "apps/desktop/src"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts/test-linux-package-ownership.sh"),
      "#!/bin/sh\necho first\n",
    );
    git("add", ".");
    git("update-index", "--chmod=+x", "scripts/test-linux-package-ownership.sh");
    git("commit", "-m", "fixture");
    const base = git("rev-parse", "HEAD").trim();
    const selected = () => {
      const changes = parseRawDiff(
        Buffer.from(git("diff", "--cached", "--raw", "-z", "--find-renames", base)),
      );
      const p = buildValidationPlan({
        changes,
        eventName: "pull_request",
        base,
        mergeBase: base,
        head: base,
        checkout: base,
      });
      validateValidationPlan(p);
      return p;
    };
    writeFileSync(
      path.join(root, "scripts/test-linux-package-ownership.sh"),
      "#!/bin/sh\necho second\n",
    );
    git("add", ".");
    git("update-index", "--chmod=+x", "scripts/test-linux-package-ownership.sh");
    assert.equal(required(selected().changes[0]).oldMode, "100755");
    assert.equal(selected().mode, "fast");
    assert.ok(
      baselineLintPlan(selected()).some(
        (c) => c.id === "shell-lint" && c.args.includes("scripts/test-linux-package-ownership.sh"),
      ),
    );
    git("update-index", "--chmod=-x", "scripts/test-linux-package-ownership.sh");
    assert.equal(selected().mode, "fast");
    git("update-index", "--chmod=+x", "scripts/test-linux-package-ownership.sh");
    git("mv", "scripts/test-linux-package-ownership.sh", "apps/desktop/src/renamed.sh");
    // Restore identical bytes for Git's rename detection.
    writeFileSync(path.join(root, "apps/desktop/src/renamed.sh"), "#!/bin/sh\necho first\n");
    git("add", ".");
    git("update-index", "--chmod=+x", "apps/desktop/src/renamed.sh");
    const renamed = selected();
    assert.equal(required(renamed.changes[0]).status, "R");
    assert.ok(renamed.groups.includes("frontend"));
    assert.ok(renamed.changed_files.includes("scripts/test-linux-package-ownership.sh"));
    git("rm", "-f", "apps/desktop/src/renamed.sh");
    assert.equal(selected().mode, "fast");
    assert.equal(required(selected().changes[0]).newMode, "000000");
    writeFileSync(path.join(root, "scripts/new.sh"), "#!/bin/sh\nexit 0\n");
    git("add", ".");
    git("update-index", "--chmod=+x", "scripts/new.sh");
    assert.ok(selected().changes.some((c) => c.status === "A" && c.newMode === "100755"));
    const blob = git("hash-object", "-w", "--stdin").trim();
    git("update-index", "--add", "--cacheinfo", `120000,${blob},scripts/link`);
    assert.equal(selected().mode, "blocked");
    git("update-index", "--force-remove", "scripts/link");
    git("update-index", "--add", "--cacheinfo", `160000,${base},scripts/submodule`);
    assert.equal(selected().mode, "blocked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function required<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}
