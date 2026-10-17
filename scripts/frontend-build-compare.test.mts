import type { ComparisonRunner } from "./frontend-build-compare.mts";
import { isRecord } from "./runtime-values.mts";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { comparisonInputs, compareBuilds } from "./frontend-build-compare.mts";
const git = (cwd: string, args: readonly string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe", windowsHide: true });
function fixture() {
  const parent = mkdtempSync(path.join(os.tmpdir(), "frontend-compare-"));
  const roots = ["base", "head"].map((name: string, index) => {
    const root = path.join(parent, name);
    mkdirSync(path.join(root, "apps/desktop"), { recursive: true });
    git(root, ["init"]);
    git(root, ["config", "user.email", "fixture@example.invalid"]);
    git(root, ["config", "user.name", "Fixture"]);
    writeFileSync(path.join(root, ".gitignore"), "node_modules/\napps/desktop/dist/\n");
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ packageManager: "pnpm@12.11.2" }),
    );
    writeFileSync(
      path.join(root, "apps/desktop/package.json"),
      JSON.stringify({
        dependencies: { "lucide-react": `^1.${49 + index}.0` },
        scripts: { build: "node build.mjs" },
      }),
    );
    writeFileSync(
      path.join(root, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'\npackages:\n  lucide-react@1.${49 + index}.0:\n    resolution: {integrity: sha512-YQ==}\n`,
    );
    writeFileSync(path.join(root, "source.ts"), "identical source");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "fixture"]);
    return root;
  });
  const base = roots[0],
    head = roots[1];
  assert.ok(base && head);
  return { parent, roots: [base, head] as const };
}
void test("comparison rejects dirty, nested, archived and mismatched source/configuration inputs", () => {
  const { parent, roots } = fixture();
  try {
    assert.equal(comparisonInputs(...roots, "lucide-react").length, 2);
    assert.throws(() => comparisonInputs(roots[0], roots[0], "lucide-react"), /distinct/);
    assert.throws(() => comparisonInputs(parent, roots[0], "lucide-react"), /nonnested/);
    const archive = path.join(parent, "archive");
    mkdirSync(archive);
    assert.throws(() => comparisonInputs(archive, roots[0], "lucide-react"));
    writeFileSync(path.join(roots[1], "source.ts"), "changed");
    assert.throws(() => comparisonInputs(...roots, "lucide-react"), /Dirty/);
    git(roots[1], ["add", "source.ts"]);
    git(roots[1], ["commit", "-m", "different source"]);
    assert.throws(() => comparisonInputs(...roots, "lucide-react"), /configuration differs/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
void test("comparison retains command logs and separates JS/CSS bytes with unique failure evidence", () => {
  const { parent, roots } = fixture();
  try {
    const runner: ComparisonRunner = (command, args, { cwd }) => {
      assert.equal(command, "pnpm");
      if (args.includes("build")) {
        const dir = path.join(String(cwd), "apps/desktop/dist/assets");
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "main.js"), "const value = 42;");
        writeFileSync(path.join(dir, "main.css"), "body { color: red }");
      }
      return { status: 0, stdout: args.includes("--version") ? "12.11.2\n" : "built", stderr: "" };
    };
    const { report, reference } = compareBuilds({
      baseline: roots[0],
      candidate: roots[1],
      dependency: "lucide-react",
      evidenceRoot: path.join(parent, "evidence"),
      runner,
    });
    assert.equal(report.state, "complete");
    assert(report.totals.every((t) => t.js.raw > 0 && t.css.gzip > 0));
    assert.equal(reportState(reference), "complete");
    assert(report.builds.every((b) => b.commands.length === 3));
    assert.throws(() => comparisonInputs(...roots, "lucide-react"), /contaminated|Preexisting/);
    // A separate fresh pair proves failures retain a report and both streams.
    const second = fixture();
    try {
      const evidenceRoot = path.join(second.parent, "evidence");
      assert.throws(
        () =>
          compareBuilds({
            baseline: second.roots[0],
            candidate: second.roots[1],
            dependency: "lucide-react",
            evidenceRoot,
            runner: () => ({ status: 7, stdout: "partial", stderr: "failed" }),
          }),
        /failed/,
      );
      const child = readdirSync(evidenceRoot)[0];
      assert.ok(child);
      const attempt = path.join(evidenceRoot, child);
      assert.equal(reportState(path.join(attempt, "report.json")), "failed");
      assert(readdirSync(attempt).some((name: string) => name.endsWith(".stderr.log")));
    } finally {
      rmSync(second.parent, { recursive: true, force: true });
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

function reportState(file: string): unknown {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(isRecord(value));
  return value.state;
}
