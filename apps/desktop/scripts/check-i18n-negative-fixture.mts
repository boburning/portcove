import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../../../scripts/runtime-values.mts";

const temporaryRoot = mkdtempSync(join(tmpdir(), "portcove-i18n-negative-"));
for (const locale of ["en", "ar-XB"]) {
  const localeRoot = join(temporaryRoot, locale);
  mkdirSync(localeRoot, { recursive: true });
  copyFileSync(join("src", "locales", locale, "settings.json"), join(localeRoot, "settings.json"));
}
const environment = { ...process.env, PORTCOVE_I18N_NEGATIVE_ROOT: temporaryRoot };
type FixtureScope = "invalid" | "placeholders" | "nested-missing" | "nested-provided";
const run = (command: "extract" | "lint", scope: FixtureScope = "invalid") =>
  spawnSync(
    process.execPath,
    [
      "node_modules/i18next-cli/dist/esm/cli.js",
      command,
      ...(command === "extract" ? ["--ci"] : []),
      "--config",
      "i18next.invalid.config.ts",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...environment, PORTCOVE_I18N_NEGATIVE_SCOPE: scope },
      timeout: 30_000,
    },
  );
const outputOf = (result: ReturnType<typeof run>) =>
  `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

try {
  const extraction = run("extract");
  const lint = run("lint");
  const output = `${outputOf(extraction)}\n${outputOf(lint)}`;
  assert.equal(extraction.status, 1, output);
  assert.equal(lint.status, 1, output);
  assert.ok(
    output.includes("notInTheCatalog") && output.includes('Interpolation parameter "language"'),
    output,
  );

  // Exercise nested resource lookup independently of the inline-default failure above.
  const nestedMissing = run("lint", "nested-missing");
  const nestedOutput = outputOf(nestedMissing);
  assert.equal(nestedMissing.status, 1, nestedOutput);
  assert.ok(
    nestedOutput.includes("MissingNestedInterpolation.tsx") &&
      nestedOutput.includes('Interpolation parameter "language"'),
    nestedOutput,
  );
  const nestedProvided = run("lint", "nested-provided");
  assert.equal(nestedProvided.status, 0, outputOf(nestedProvided));

  const translated = join(temporaryRoot, "ar-XB", "settings.json");
  const original = readFileSync(translated, "utf8");
  assert.ok(original.includes("{{language}}"));
  for (const replacement of ["", "{{unrecorded}}"] as const) {
    writeFileSync(translated, original.replaceAll("{{language}}", replacement));
    const result = run("lint", "placeholders");
    const output = outputOf(result);
    assert.equal(result.status, 1, output);
    assert.ok(
      output.includes("language.current") && output.includes("missing {{language}}"),
      output,
    );
    if (replacement) assert.ok(output.includes("unexpected {{unrecorded}}"), output);
  }
  writeFileSync(translated, original);
  const restored = run("lint", "placeholders");
  assert.equal(restored.status, 0, outputOf(restored));

  const globSecurity = spawnSync(
    process.execPath,
    ["scripts/fixtures/dependency-glob-security.mts", "--consumer", "localization-cli"],
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    },
  );
  assert.equal(globSecurity.status, 0, outputOf(globSecurity));
  const report: unknown = JSON.parse(globSecurity.stdout);
  assert.ok(isRecord(report) && Array.isArray(report.observations));
  assert.equal(report.observations.length, 1);
  const observation: unknown = report.observations[0];
  assert.ok(isRecord(observation));
  assert.equal(observation.consumer, "localization-cli");
  console.log(`Development glob security observation: ${globSecurity.stdout.trim()}`);

  console.log(
    "i18next-cli rejects invalid keys, missing inline and nested resource arguments and missing/unexpected translated placeholders; restored translations pass.",
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
