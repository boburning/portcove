import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCalendarDate } from "./catalog-authoring.mts";

/**
 * Backfills `listing.listed_at` into authored port files from the commit that
 * first added each file. Authoring stamps new listings itself; this exists for
 * the existing directory and for re-running after a merge. It only edits files
 * whose listing has no date, and only inserts one line, so formatting and key
 * order are untouched.
 */

/** UTC calendar date for a Unix timestamp in seconds. */
export function utcDate(seconds: number) {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/**
 * Earliest add-commit time per file from `git log --format=%at --name-only` output
 * (commits newest first, each followed by its added paths).
 */
export function firstAddedSeconds(log: string) {
  const earliest = new Map<string, number>();
  let current: number | undefined;
  for (const line of log.split("\n")) {
    if (!line) continue;
    if (/^[0-9]+$/u.test(line)) {
      current = Number(line);
      continue;
    }
    if (current === undefined) continue;
    const known = earliest.get(line);
    if (known === undefined || current < known) earliest.set(line, current);
  }
  return earliest;
}

/**
 * Inserts the date after `issue_number` when the listing has one, otherwise after
 * `project_url`, using the listing's own four-space indentation. Returns the text
 * unchanged when it already has a date.
 */
export function insertListedAt(text: string, date: string) {
  if (!isCalendarDate(date)) throw new Error(`Not a calendar date: ${String(date)}`);
  if (/^ {4}"listed_at":/mu.test(text)) return text;
  for (const key of ["issue_number", "project_url"]) {
    const pattern = new RegExp(`^( {4}"${key}": [^\\n]*?)(,?)$`, "mu");
    const match = pattern.exec(text);
    if (!match) continue;
    const [line, body, comma] = match as unknown as [string, string, string];
    // The key being the last in the listing has no comma; only append after a comma line.
    if (!comma) continue;
    return text.replace(line, `${body},\n    "listed_at": "${date}",`);
  }
  throw new Error("Listing has no issue_number or project_url line to anchor the date.");
}

function main() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const portsDirectory = join(root, "crates", "portcove-core", "catalog", "ports");
  const write = process.argv.includes("--write");
  // CI carries the changed-file plan in one bounded environment string, so a very
  // large mechanical change is landed in batches: --limit N dates at most N files.
  const limitIndex = process.argv.indexOf("--limit");
  const limit = limitIndex < 0 ? Infinity : Number(process.argv[limitIndex + 1]);
  if (!(limit > 0)) throw new Error("--limit requires a positive number of files.");
  const log = execFileSync(
    "git",
    [
      "log",
      "--diff-filter=A",
      "--format=%at",
      "--name-only",
      "--",
      "crates/portcove-core/catalog/ports",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const added = firstAddedSeconds(log);
  let changed = 0;
  let missing = 0;
  for (const name of readdirSync(portsDirectory)
    .filter((file) => file.endsWith(".json"))
    .sort()) {
    if (changed >= limit) break;
    const file = join(portsDirectory, name);
    const text = readFileSync(file, "utf8");
    if (/^ {4}"listed_at":/mu.test(text)) continue;
    const seconds = added.get(`crates/portcove-core/catalog/ports/${name}`);
    if (seconds === undefined) {
      missing++;
      console.error(`No add commit found for ${name}`);
      continue;
    }
    const next = insertListedAt(text, utcDate(seconds));
    if (next !== text) {
      changed++;
      if (write) writeFileSync(file, next);
    }
  }
  console.log(
    `${write ? "Updated" : "Would update"} ${changed} port files; ${missing} had no add commit.`,
  );
  if (missing) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
