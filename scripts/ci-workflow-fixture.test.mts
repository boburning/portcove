import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { parseDocument } from "yaml";
import { assertNoDuplicateRustSetup } from "./ci-workflow-fixture.mts";

void test("storage setup policy distinguishes executable setup from harmless test filenames and YAML layout", () => {
  for (const source of [
    "steps: [{run: 'node --test scripts/rust-toolchain-reader.test.mts scripts/cargo.test.mts'}]",
    "# cargo policy is checked on executable fields\nsteps:\n  - run: |\n      # rust-toolchain is a test filename\n      node --test scripts/rust-toolchain-reader.test.mts scripts/cargo.test.mts\n",
  ])
    assert.doesNotThrow(() => assertNoDuplicateRustSetup(parseDocument(source).toJS()));
  for (const step of [
    { uses: "dtolnay/rust-toolchain@fixed" },
    { uses: "Swatinem/rust-cache@fixed" },
    { run: "cargo test --workspace" },
    { run: "node scripts/dev-storage.mts run -- cargo.exe test --workspace" },
    { run: "& 'cargo' test --workspace" },
    { run: '& "cargo.exe" test --workspace' },
    { run: '& "C:\\Rust\\bin\\cargo.exe" test --workspace' },
    { run: "cargo.exe|Out-Null" },
    { run: "cargo; Write-Output done" },
    { run: '& "cargo.exe">out.txt' },
    { run: "$(cargo.exe)" },
  ])
    assert.throws(() => assertNoDuplicateRustSetup({ steps: [step] }));
});

void test(
  "actual workflow policies accept equivalent YAML and reject removed gates, tests, budgets and evidence",
  // Includes the toolchain reader's existing180s native harness plus policy controls.
  { timeout: 240_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "portcove-workflow-policies-"));
    const preload = join(directory, "workflow-inputs.mjs");
    try {
      await writeFile(
        preload,
        String.raw`
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { mock } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const { parseDocument, stringify } = createRequire(__REQUIRE_FROM__)("yaml");
const { default: originalDefault, ...originalNamed } = fs;
const isCiWorkflow = value => /[\\/]workflows[\\/]ci\.yml$/.test(value);
for (const separator of ["/", "\\"]) {
  assert.equal(isCiWorkflow(["checkout", ".github", "workflows", "ci.yml"].join(separator)), true);
  assert.equal(isCiWorkflow(["checkout", ".github", "actions", "ci.yml"].join(separator)), false);
}

async function readFile(...args) {
  const original = await fs.readFile(...args);
  const path = args[0] instanceof URL ? fileURLToPath(args[0]) : String(args[0]);
  if (!/\.github[\\/](?:workflows|actions)[\\/].*\.ya?ml$/.test(path)) return original;
  const document = parseDocument(original.toString(), { uniqueKeys: true });
  assert.equal(document.errors.length, 0);
  const settings = document.toJS();
  if (isCiWorkflow(path)) {
    const jobs = settings.jobs;
    switch (process.env.PORTCOVE_WORKFLOW_CONTRACT_MODE) {
      case "gate": delete jobs.rust; break;
      case "test": jobs.native_rust.steps = jobs.native_rust.steps.filter(step => step.name !== "Test the full Rust workspace natively"); break;
      case "budget": delete jobs.rust_docs.steps.find(step => step.run?.startsWith("./scripts/install-linux-desktop-prerequisites.sh"))["timeout-minutes"]; break;
      case "evidence": jobs.frontend_full.steps = jobs.frontend_full.steps.filter(step => step.name !== "Retain original Fallow reports"); break;
    }
  }
  const changed = stringify(settings, { collectionStyle: "flow", defaultStringType: "QUOTE_DOUBLE", lineWidth: 0, sortMapEntries: (a, b) => String(b.key).localeCompare(String(a.key)) });
  assert.deepEqual(parseDocument(changed).toJS(), settings, "reformatted YAML must preserve the intended values");
  assert.notEqual(changed, original.toString(), "control must actually change the input representation");
  return typeof original === "string" ? changed : Buffer.from(changed);
}
mock.module("node:fs/promises", { namedExports: { ...originalNamed, readFile }, defaultExport: { ...originalDefault, readFile } });
`.replace("__REQUIRE_FROM__", JSON.stringify(import.meta.url)),
      );
      const policies = [
        "ci-workflow",
        "ci-frontend-workflow",
        "ci-native-workflow",
        "ci-release-workflow",
        "ci-rust-workflow",
        "rust-validation-setup",
        "qualification-coverage",
        "select-ci-plan",
        "ci-baseline",
        "native-backup-evidence",
        "rust-toolchain-reader",
        "windows-rust-tests",
      ];
      const controls: [string, string[]][] = [
        ["equivalent", policies],
        ["gate", ["ci-workflow"]],
        ["test", ["ci-rust-workflow"]],
        ["budget", ["rust-validation-setup"]],
        ["evidence", ["ci-frontend-workflow"]],
      ];
      for (const [mode, names] of controls) {
        const env: Record<string, string | undefined> = {
          ...process.env,
          PORTCOVE_WORKFLOW_CONTRACT_MODE: mode,
        };
        delete env.NODE_TEST_CONTEXT;
        const child = spawnSync(
          process.execPath,
          [
            "--experimental-test-module-mocks",
            "--import",
            pathToFileURL(preload).href,
            "--test",
            "--test-reporter=tap",
            "--test-concurrency=1",
            ...names.map((name) => fileURLToPath(new URL(`./${name}.test.mts`, import.meta.url))),
          ],
          {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            env,
            encoding: "utf8",
            timeout: 200_000,
            maxBuffer: 4 * 1024 * 1024,
          },
        );
        const output = child.stdout + child.stderr;
        assert.ifError(child.error);
        if (mode === "equivalent") {
          assert.equal(child.status, 0, output);
          assert.match(output, /# fail 0/u);
          assert.ok(
            Number(output.match(/# tests (\d+)/u)?.[1]) > 40,
            "the actual policy cohort must execute",
          );
        } else {
          assert.equal(child.status, 1, output);
          assert.match(output, /ERR_ASSERTION/u, `${mode} must fail an actual policy assertion`);
          const expected: Record<string, string> = {
            gate: "required CI keeps its cancellation",
            test: "Linux Rust quality keeps its platform-specific",
            budget: "Linux desktop prerequisite installation",
            evidence: "selected full Fallow runs once",
          };
          assert.match(
            output,
            new RegExp(`not ok \\d+ - ${expected[mode] ?? "missing mutation owner"}`, "u"),
          );
        }
        t.diagnostic(
          `${mode}: child exit ${child.status}; ${output.match(/# tests (\d+)/u)?.[1] ?? "unknown"} actual policy cases`,
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
