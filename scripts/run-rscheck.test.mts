import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pins from "../.github/quality-tools.json" with { type: "json" };
import portabilityBaseline from "./fixtures/rscheck-portability-baseline.json" with { type: "json" };

import { assessRscheckReport, parseRscheckReport } from "./run-rscheck.mts";

void test("reviewed portability literals apply only to exact files and exact values", async (t) => {
  const command = process.platform === "win32" ? "rscheck.exe" : "rscheck";
  const version = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 5_000 });
  if (version.error && "code" in version.error && version.error.code === "ENOENT") {
    t.skip("Pinned rscheck is not installed; run the maintained rscheck route for this control");
    return;
  }
  assert.equal(version.status, 0, version.stderr);
  assert.equal(
    version.stdout.trim(),
    `rscheck ${pins.tools.find((tool) => tool.id === "rscheck-cli")?.version}`,
  );
  assert.equal(portabilityBaseline.source, "fe45fb8f73308e5ef40e218faa5a756ded598175");
  assert.equal(portabilityBaseline.raw_findings, 88);
  assert.equal(portabilityBaseline.scopes.length, 16);
  const created = await mkdtemp(path.join(os.tmpdir(), "pcv-rscheck-literals-"));
  t.after(() => rm(created, { recursive: true, force: true }));
  const directory = await realpath(created);
  await copyFile(
    fileURLToPath(new URL("../.rscheck.toml", import.meta.url)),
    path.join(directory, ".rscheck.toml"),
  );
  await mkdir(path.join(directory, "src"));
  await writeFile(
    path.join(directory, "Cargo.toml"),
    '[package]\nname="rscheck-literal-controls"\nversion="0.0.0"\nedition="2024"\n',
  );
  await writeFile(path.join(directory, "src/lib.rs"), "");
  const rustString = (value: string) =>
    JSON.stringify(value).replace(/\\u([a-f0-9]{4})/gu, "\\u{$1}");
  const expected: { file: string; value: string }[] = [];
  const allowed: { file: string; value: string }[] = [];
  for (const [index, scope] of portabilityBaseline.scopes.entries()) {
    const deniedValue = `/portcove-unreviewed-${index}`;
    const neighbor = scope.file.replace(/\.rs$/u, "_unreviewed.rs");
    const inherited = "inherited_global_values" in scope ? scope.inherited_global_values : [];
    for (const [file, values] of [
      [scope.file, [...scope.values, ...inherited, deniedValue]],
      [neighbor, [...scope.values, ...inherited]],
    ] as const) {
      const filename = path.join(directory, file);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(
        filename,
        `fn fixture() { let _ = [${values.map(rustString).join(",")}]; }\n`,
      );
    }
    expected.push(
      { file: scope.file, value: deniedValue },
      ...scope.values.map((value) => ({ file: neighbor, value })),
    );
    allowed.push(...scope.values.map((value) => ({ file: scope.file, value })));
    allowed.push(
      ...inherited.flatMap((value) => [scope.file, neighbor].map((file) => ({ file, value }))),
    );
  }
  const result = spawnSync(command, ["check", "--format", "json"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 2, result.stderr);
  const denies = assessRscheckReport(parseRscheckReport(result)).denies;
  assert.equal(denies.length, expected.length);
  for (const { file, value } of expected)
    assert.ok(
      denies.some(
        (finding) =>
          finding.rule_id === "portability.absolute_literal_paths" &&
          finding.primary?.file === path.join(directory, file) &&
          finding.message?.endsWith(": " + value),
      ),
      `Missing exact denial for ${file}: ${JSON.stringify(value)}`,
    );
  for (const { file, value } of allowed)
    assert.ok(
      !denies.some(
        (finding) =>
          finding.primary?.file === path.join(directory, file) &&
          finding.message?.endsWith(": " + value),
      ),
      `Reviewed literal was denied in ${file}: ${JSON.stringify(value)}`,
    );
});

void test("scanner collection preserves a denial after a report larger than the default buffer", () => {
  const producer = `
    process.stdout.write(JSON.stringify({
      metadata: "x".repeat(2 * 1024 * 1024),
      findings: [{ severity: "deny", rule_id: "fixture.tail", message: "tail denial retained" }]
    }));
    process.exitCode = 2;
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        const { main } = await import(${JSON.stringify(new URL("./run-rscheck.mts", import.meta.url).href)});
        main(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(producer)}]);
      `,
    ],
    { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /rscheck failure \[fixture\.tail\].*tail denial retained/u);
  assert.match(result.stdout, /0 advisory finding\(s\), 1 blocking finding\(s\)/u);
});

void test("TFE hostile-path exception applies only to the exact dedicated test fixture", async (t) => {
  const command = process.platform === "win32" ? "rscheck.exe" : "rscheck";
  const version = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 5_000 });
  if (version.error && "code" in version.error && version.error.code === "ENOENT") {
    t.skip("Pinned rscheck is not installed; run the maintained rscheck route for this control");
    return;
  }
  assert.equal(version.status, 0, version.stderr);
  const pin = pins.tools.find((tool) => tool.id === "rscheck-cli");
  assert.ok(pin);
  assert.equal(version.stdout.trim(), `rscheck ${pin.version}`);

  const created = await mkdtemp(path.join(os.tmpdir(), "pcv-rscheck-policy-"));
  t.after(() => rm(created, { recursive: true, force: true }));
  const directory = await realpath(created);
  await copyFile(
    fileURLToPath(new URL("../.rscheck.toml", import.meta.url)),
    path.join(directory, ".rscheck.toml"),
  );
  const production = "crates/portcove-core/src/external_runtime/tfe_settings.rs";
  const fixture = "crates/portcove-core/src/external_runtime/tfe_settings_tests.rs";
  const neighbor = "crates/portcove-core/src/external_runtime/other_tests.rs";
  const otherCrate = "crates/other/src/external_runtime/tfe_settings_tests.rs";
  await writeFile(
    path.join(directory, "Cargo.toml"),
    `[package]\nname="rscheck-policy-control"\nversion="0.0.0"\nedition="2024"\n[lib]\npath="${production}"\n`,
  );
  for (const [file, values] of [
    [production, ["C:/Games/"]],
    [fixture, ["C:/Games/", "C:/Games/Other/", "D:/Games/"]],
    [neighbor, ["C:/Games/"]],
    [otherCrate, ["C:/Games/"]],
  ] as const) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(
      path.join(directory, file),
      `fn fixture() { let _ = [${values.map((value) => JSON.stringify(value)).join(",")}]; }\n`,
    );
  }
  const result = spawnSync(command, ["check", "--format", "json"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 2, `${result.stderr}\n${result.stdout}`);
  const denies = assessRscheckReport(parseRscheckReport(result)).denies;
  assert.equal(denies.length, 5);
  for (const [file, value] of [
    [production, "C:/Games/"],
    [fixture, "C:/Games/Other/"],
    [fixture, "D:/Games/"],
    [neighbor, "C:/Games/"],
    [otherCrate, "C:/Games/"],
  ] as const)
    assert.ok(
      denies.some(
        (finding) =>
          finding.rule_id === "portability.absolute_literal_paths" &&
          finding.primary?.file === path.join(directory, file) &&
          finding.message === `absolute filesystem path (windows-drive): ${value}`,
      ),
      `Missing denial for ${file}: ${value}`,
    );
});

void test("separates advisory findings from hard policy failures", () => {
  const assessment = assessRscheckReport({
    findings: [
      { severity: "warn", rule_id: "shape.file_complexity" },
      { severity: "deny", rule_id: "portability.absolute_literal_paths" },
    ],
  });
  assert.equal(assessment.warnings.length, 1);
  assert.equal(assessment.denies.length, 1);
});

void test("retains a structured findings report when rscheck exits two", () => {
  const report = parseRscheckReport({
    status: 2,
    stdout: JSON.stringify({
      findings: [{ severity: "deny", rule_id: "portability.absolute_literal_paths" }],
    }),
  });
  assert.equal(report.findings.length, 1);
});

void test("distinguishes an rscheck tool failure without a findings report", () => {
  assert.throws(
    () => parseRscheckReport({ status: 2, stdout: "not-json" }),
    /could not analyze the workspace \(exit 2\)/,
  );
});

void test("rejects malformed scanner finding boundaries without string coercion", () => {
  for (const value of [
    null,
    { severity: ["deny"] },
    { severity: "warn", rule_id: [] },
    { severity: "deny", message: {} },
    { severity: "deny", primary: [] },
    { severity: "deny", primary: { file: [] } },
    { severity: "warn", primary: { start: { line: {} } } },
  ]) {
    assert.throws(
      () => parseRscheckReport({ status: 1, stdout: JSON.stringify({ findings: [value] }) }),
      TypeError,
    );
  }
});
void test("retains scanner categories, optional locations, and report metadata", () => {
  const report = {
    scanner_version: "fixture",
    findings: [
      {
        severity: "warn",
        rule_id: "known",
        message: "advisory",
        primary: {
          file: "src/lib.rs",
          start: { line: 12, column: 3 },
          end: { line: 15 },
          span_kind: "source",
        },
      },
      { severity: "deny", primary: null },
      { severity: "future_category", primary: { start: null } },
    ],
  };
  const result = parseRscheckReport({ status: 2, stdout: JSON.stringify(report) });
  assert.deepEqual(result, report);
  assert.equal(assessRscheckReport(result).denies.length, 1);
  assert.equal(assessRscheckReport(result).warnings.length, 1);
});
