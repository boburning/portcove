import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";

assert.equal(process.platform, "linux", "GTK qualification requires actual Linux");
const root = process.cwd();
const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: root });
if (process.env.PORTCOVE_SOURCE_COMMIT) assert.equal(source, process.env.PORTCOVE_SOURCE_COMMIT);
const outputRoot = path.join(root, "work", "dialog-gtk");
mkdirSync(outputRoot, { recursive: true });
const output = mkdtempSync(path.join(outputRoot, "run-"));
const identity = {
  source,
  run: process.env.GITHUB_RUN_ID ?? null,
  attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  directory: path.relative(root, output),
};
writeFileSync(path.join(output, "intent.json"), JSON.stringify(identity) + "\n", { flag: "wx" });
console.log(JSON.stringify({ ...identity, status: "started" }));
const control = mkdtempSync(path.join(output, "unpatched-"));
const provenance: unknown = JSON.parse(
  readFileSync(path.join(root, "vendor/rfd-provenance.json"), "utf8"),
);
assert.ok(
  isRecord(provenance) &&
    isRecord(provenance.original_files) &&
    isRecord(provenance.modified_files),
);
const entries = Object.entries(provenance.original_files);
assert.ok(entries.length > 0 && entries.length <= 100);
execFileSync(
  "git",
  [
    "ls-files",
    "--error-unmatch",
    "scripts/qualify-dialog-gtk.mts",
    "vendor/rfd-provenance.json",
    ...entries.map(([name]) => `vendor/rfd/${name}`),
  ],
  { cwd: root, stdio: "pipe" },
);
let bytes = 0;
for (const [name, original] of entries) {
  assert.ok(
    !name.includes("\\") &&
      !path.isAbsolute(name) &&
      path.posix.normalize(name) === name &&
      !name.startsWith("../"),
  );
  const expected: unknown = provenance.modified_files[name] ?? original;
  assert.ok(typeof expected === "string" && /^[a-f0-9]{64}$/u.test(expected));
  let directory = path.join(root, "vendor");
  for (const part of ["", "rfd", ...name.split("/").slice(0, -1)]) {
    directory = path.join(directory, part);
    const info = lstatSync(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
  }
  const sourceFile = path.join(root, "vendor/rfd", name);
  const info = lstatSync(sourceFile);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 1024 ** 2);
  const data = readFileSync(sourceFile);
  bytes += data.length;
  assert.ok(bytes <= 3 * 1024 ** 2);
  assert.equal(createHash("sha256").update(data).digest("hex"), expected, name);
  const destination = path.join(control, name);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, data, { flag: "wx" });
}
const filename = path.join(control, "src/backend/gtk3/message_dialog.rs");
const fixed = `            gtk_sys::gtk_message_dialog_format_secondary_text(
                ptr as *mut _,
                b"%s\\0".as_ptr() as *const _,
                description.as_ptr(),
            );`;
const text = readFileSync(filename, "utf8");
assert.equal(text.split(fixed).length, 2, "exact reviewed backport must be present");
writeFileSync(
  filename,
  text.replace(
    fixed,
    "            gtk_sys::gtk_message_dialog_format_secondary_text(ptr as *mut _, description.as_ptr());",
  ),
);
// The disposable control is its own workspace; its published lock is unchanged.
writeFileSync(
  path.join(control, "Cargo.toml"),
  readFileSync(path.join(control, "Cargo.toml"), "utf8") + "\n[workspace]\n",
);
const observations = [];
for (const [label, directory] of [
  ["patched", path.join(root, "vendor/rfd")],
  ["unpatched", control],
] as const) {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/run-rust-tests.mts",
      "--guard-command",
      "cargo",
      "test",
      "--manifest-path",
      path.join(directory, "Cargo.toml"),
      "--locked",
      "--lib",
      "--no-default-features",
      "--features",
      "gtk3",
      "backend::gtk3::message_dialog::portcove_tests::secondary_text_preserves_percent_sequences",
      "--",
      "--exact",
      "--test-threads=1",
      "--nocapture",
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 600000,
      maxBuffer: 16 * 1024 ** 2,
      env: { ...process.env, CARGO_TARGET_DIR: path.join(root, "target"), CARGO_BUILD_JOBS: "2" },
    },
  );
  writeFileSync(path.join(output, `${label}.stdout.txt`), result.stdout ?? "");
  writeFileSync(path.join(output, `${label}.stderr.txt`), result.stderr ?? "");
  const combined = (result.stdout ?? "") + (result.stderr ?? "");
  assert.equal(result.error, undefined, `${label} execution failed`);
  assert.match(combined, /PORTCOVE_RFD_TEXT_PROBE/u, "actual constructor must execute");
  if (label === "patched") {
    assert.equal(result.status, 0, combined);
    assert.match(combined, /expected="%s %n %% café";actual="%s %n %% café"/u);
  } else {
    assert.notEqual(result.status, 0, "unpatched constructor must fail the same regression");
    assert.match(combined, /expected="literal 100%%";actual="literal 100%"/u);
    assert.match(combined, /test result: FAILED\. 0 passed; 1 failed/u);
  }
  observations.push({ label, status: result.status, actual_constructor: true });
}
writeFileSync(
  path.join(output, "result.json"),
  JSON.stringify(
    {
      ...identity,
      status: "passed",
      observations,
      scope: "actual GTK constructor under Xvfb; no installed-product acceptance",
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
rmSync(control, { recursive: true });
console.log(JSON.stringify({ source, status: "passed", observations }));
