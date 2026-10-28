import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryRoot = mkdtempSync(join(tmpdir(), "portcove-i18n-negative-"));
for (const locale of ["en", "ar-XB"]) {
  const localeRoot = join(temporaryRoot, locale);
  mkdirSync(localeRoot, { recursive: true });
  copyFileSync(join("src", "locales", locale, "settings.json"), join(localeRoot, "settings.json"));
}
const environment = { ...process.env, PORTCOVE_I18N_NEGATIVE_ROOT: temporaryRoot };
const run = (command: "extract" | "lint", placeholdersOnly = false) =>
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
      env: { ...environment, PORTCOVE_I18N_PLACEHOLDER_ONLY: placeholdersOnly ? "1" : "0" },
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

  const translated = join(temporaryRoot, "ar-XB", "settings.json");
  const original = readFileSync(translated, "utf8");
  assert.ok(original.includes("{{language}}"));
  for (const replacement of ["", "{{unrecorded}}"] as const) {
    writeFileSync(translated, original.replaceAll("{{language}}", replacement));
    const result = run("lint", true);
    const output = outputOf(result);
    assert.equal(result.status, 1, output);
    assert.ok(
      output.includes("language.current") && output.includes("missing {{language}}"),
      output,
    );
    if (replacement) assert.ok(output.includes("unexpected {{unrecorded}}"), output);
  }
  writeFileSync(translated, original);
  const restored = run("lint", true);
  assert.equal(restored.status, 0, outputOf(restored));

  console.log(
    "i18next-cli rejects invalid keys, missing source arguments and missing/unexpected translated placeholders; restored translations pass.",
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
