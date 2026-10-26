import assert from "node:assert/strict";
import test from "node:test";
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
