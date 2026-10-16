import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryRoot = mkdtempSync(join(tmpdir(), "portcove-i18n-negative-"));
for (const locale of ["en", "ar-XB"]) {
  const localeRoot = join(temporaryRoot, locale);
  mkdirSync(localeRoot, { recursive: true });
  copyFileSync(join("src", "locales", locale, "settings.json"), join(localeRoot, "settings.json"));
}
const environment = { ...process.env, PORTCOVE_I18N_NEGATIVE_ROOT: temporaryRoot };
const run = (command) =>
  spawnSync(
    process.execPath,
    [
      "node_modules/i18next-cli/dist/esm/cli.js",
      command,
      ...(command === "extract" ? ["--ci"] : []),
      "--config",
      "i18next.invalid.config.ts",
    ],
    { cwd: process.cwd(), encoding: "utf8", env: environment },
  );
const extraction = run("extract");
const lint = run("lint");
const output = `${extraction.stdout ?? ""}\n${extraction.stderr ?? ""}\n${lint.stdout ?? ""}\n${lint.stderr ?? ""}`;
rmSync(temporaryRoot, { recursive: true, force: true });

if (extraction.status === 0 || lint.status === 0) {
  console.error("Invalid localization fixture unexpectedly passed i18next-cli lint.");
  process.exit(1);
}
if (!output.includes("notInTheCatalog") || !output.includes('Interpolation parameter "language"')) {
  console.error(
    "i18next-cli did not report both the invalid key and missing interpolation argument.",
  );
  console.error(output);
  process.exit(1);
}

console.log("i18next-cli rejects invalid keys and missing interpolation arguments.");
