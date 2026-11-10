// Advisory report for the "ordinary catalog changes are data-only" outcome (#4782).
// It reads the validation plan's complete changed-file list and names Rust files
// that changed together with catalog port data. It never fails the check and never
// decides validation scope; the heuristic is path-based, so inline test modules in
// a production file count as production.
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { errorMessage } from "./runtime-values.mts";

const scriptPath = fileURLToPath(import.meta.url);
const defaultPlanPath = "work/ci-plan/validation-plan.json";
const catalogDataPrefix = "crates/portcove-core/catalog/ports/";
const catalogDocument = "crates/portcove-core/catalog/catalog.json";
const listedFileLimit = 20;

export interface CatalogRustEditReport {
  catalogFiles: string[];
  productionRust: string[];
  testRust: string[];
}

export function isCatalogDataPath(file: string) {
  return file === catalogDocument || file.startsWith(catalogDataPrefix);
}

export function isRustSourcePath(file: string) {
  return file.endsWith(".rs") && file.startsWith("crates/");
}

export function isRustTestPath(file: string) {
  const name = file.slice(file.lastIndexOf("/") + 1);
  return (
    name === "tests.rs" ||
    name.endsWith("_tests.rs") ||
    name.endsWith("_test.rs") ||
    /(^|\/)tests\//u.test(file) ||
    /(^|\/)testdata\//u.test(file)
  );
}

/** Returns null unless catalog port data and Rust source changed together. */
export function classifyCatalogRustEdits(files: readonly string[]): CatalogRustEditReport | null {
  const catalogFiles = files.filter(isCatalogDataPath).sort();
  if (!catalogFiles.length) return null;
  const rust = files.filter(isRustSourcePath).sort();
  if (!rust.length) return null;
  return {
    catalogFiles,
    productionRust: rust.filter((file) => !isRustTestPath(file)),
    testRust: rust.filter(isRustTestPath),
  };
}

// Changed paths come from the pull request. Keep every listed name on one line
// and out of markdown/workflow-command syntax.
export function displayPath(file: string) {
  return `\`${file.replace(/[\p{Cc}\u2028\u2029`|<>[\]]/gu, "?")}\``;
}

function listed(files: readonly string[]) {
  const shown = files.slice(0, listedFileLimit).map(displayPath);
  const hidden = files.length - shown.length;
  return hidden > 0 ? [...shown, `and ${hidden} more`].join(", ") : shown.join(", ");
}

export function renderCatalogRustEditReport(report: CatalogRustEditReport | null) {
  if (!report) return null;
  const parts = [];
  if (report.productionRust.length) {
    parts.push(
      `${report.productionRust.length} production Rust file${report.productionRust.length === 1 ? "" : "s"}: ${listed(report.productionRust)}`,
    );
  }
  if (report.testRust.length) {
    parts.push(
      `${report.testRust.length} Rust test file${report.testRust.length === 1 ? "" : "s"}: ${listed(report.testRust)}`,
    );
  }
  return [
    `This change updates ${report.catalogFiles.length} catalog data file${report.catalogFiles.length === 1 ? "" : "s"} and also edits ${parts.join("; ")}.`,
    "Ordinary catalog changes are meant to be data-only. This is expected when the change adds a new route shape or contract; otherwise it points at a test or code path that names a specific port.",
  ].join(" ");
}

function changedFilesFromPlan(plan: unknown) {
  const files =
    typeof plan === "object" && plan !== null && "changed_files" in plan
      ? plan.changed_files
      : undefined;
  if (!Array.isArray(files) || !files.every((file) => typeof file === "string")) {
    throw new Error("validation plan changed_files must be a string array");
  }
  return files;
}

async function main(argv: string[]) {
  if (argv.length > 1) throw new Error("usage: node scripts/catalog-rust-edit-report.mts [plan]");
  const plan: unknown = JSON.parse(await readFile(argv[0] ?? defaultPlanPath, "utf8"));
  const message = renderCatalogRustEditReport(classifyCatalogRustEdits(changedFilesFromPlan(plan)));
  if (!message) {
    console.log("No catalog data change was accompanied by Rust source edits.");
    return;
  }
  console.log(message);
  if (process.env.GITHUB_ACTIONS === "true") {
    const escaped = message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
    console.log(`::notice title=Catalog change needed Rust edits::${escaped}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## Catalog change needed Rust edits (advisory)\n\n${message}\n`,
      "utf8",
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    // Advisory only: a missing or malformed plan must not fail the required plan job.
    console.error(`catalog-rust-edit-report: ${errorMessage(error)}`);
  }
}
