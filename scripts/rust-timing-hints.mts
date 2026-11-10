// Derives `.config/rust-test-timing-hints.json` from hosted nextest JUnit reports and
// reports tests that are close to their timeout. Hints are scheduling estimates only.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface JunitCase {
  binary: string;
  name: string;
  seconds: number;
}

export interface TimingHintsFile {
  format_version: 1;
  source: string;
  purpose: string;
  default_seconds: number;
  families: [string, string, number][];
  tests: [string, string, number][];
}

const purpose =
  "Scheduling estimates only. Current nextest inventory owns membership; missing and new identities always receive a fallback weight.";
const minimumSeconds = 0.001;
const round = (value: number) => Math.round(value * 1000) / 1000;

function attribute(tag: string, key: string) {
  const match = new RegExp(`\\s${key}="([^"]*)"`, "u").exec(tag);
  return match?.[1]
    ?.replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/** Reads passing and failing cases; skipped cases carry no useful duration. */
export function parseJunitCases(xml: string): JunitCase[] {
  const cases: JunitCase[] = [];
  for (const [tag] of xml.matchAll(/<testcase\b[^>]*>/gu)) {
    const name = attribute(tag, "name");
    const binary = attribute(tag, "classname");
    const seconds = Number(attribute(tag, "time"));
    if (name && binary && Number.isFinite(seconds) && seconds >= 0)
      cases.push({ binary, name, seconds });
  }
  return cases;
}

/**
 * Slow tests (at least `exactSeconds`) get exact hints. Everything else is averaged by its
 * module prefix so new tests in a known module inherit a realistic weight.
 */
export function buildTimingHints(
  cases: readonly JunitCase[],
  source: string,
  exactSeconds = 10,
): TimingHintsFile {
  if (cases.length === 0) throw new Error("No JUnit test cases to derive timing hints from");
  const longest = new Map<string, JunitCase>();
  for (const entry of cases) {
    const key = JSON.stringify([entry.binary, entry.name]);
    const prior = longest.get(key);
    if (!prior || entry.seconds > prior.seconds) longest.set(key, entry);
  }
  const tests: [string, string, number][] = [];
  const groups = new Map<
    string,
    { binary: string; prefix: string; total: number; count: number }
  >();
  for (const entry of longest.values()) {
    if (entry.seconds >= exactSeconds) {
      tests.push([entry.binary, entry.name, round(entry.seconds)]);
      continue;
    }
    const separator = entry.name.lastIndexOf("::");
    if (separator < 0) continue;
    const prefix = entry.name.slice(0, separator + 2);
    const key = JSON.stringify([entry.binary, prefix]);
    const group = groups.get(key) ?? { binary: entry.binary, prefix, total: 0, count: 0 };
    group.total += entry.seconds;
    group.count += 1;
    groups.set(key, group);
  }
  const families = [...groups.values()]
    .map((group): [string, string, number] => [
      group.binary,
      group.prefix,
      round(Math.max(minimumSeconds, group.total / group.count)),
    ])
    .sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
  tests.sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
  return {
    format_version: 1,
    source,
    purpose,
    default_seconds: 0.5,
    families,
    tests,
  };
}

/** Tests above `thresholdSeconds`, slowest first, for the CI summary. */
export function slowTests(cases: readonly JunitCase[], thresholdSeconds: number) {
  return cases
    .filter((entry) => entry.seconds >= thresholdSeconds)
    .sort((a, b) => b.seconds - a.seconds);
}

export function slowTestSummary(
  cases: readonly JunitCase[],
  timeoutSeconds: number,
  fraction = 0.5,
): string {
  const slow = slowTests(cases, timeoutSeconds * fraction);
  if (slow.length === 0)
    return `No Rust test used more than ${Math.round(fraction * 100)}% of its ${timeoutSeconds}s timeout.\n`;
  const rows = slow
    .slice(0, 20)
    .map(
      (entry) =>
        `| ${entry.binary} | ${entry.name} | ${entry.seconds.toFixed(1)} | ${Math.round((entry.seconds / timeoutSeconds) * 100)}% |`,
    );
  return [
    `### Rust tests near their ${timeoutSeconds}s timeout`,
    "",
    "| Binary | Test | Seconds | Of timeout |",
    "| --- | --- | ---: | ---: |",
    ...rows,
    "",
  ].join("\n");
}

function main(argv: string[]) {
  const [command, ...rest] = argv;
  const options = new Map<string, string>();
  const files: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] ?? "";
    if (argument.startsWith("--")) options.set(argument, rest[(index += 1)] ?? "");
    else files.push(argument);
  }
  if ((command !== "generate" && command !== "summary") || files.length === 0)
    throw new Error(
      "Usage: rust-timing-hints.mts generate|summary [--source URL] [--out FILE] [--timeout SECONDS] <junit.xml>...",
    );
  const cases = files.flatMap((file) => parseJunitCases(readFileSync(file, "utf8")));
  if (command === "generate") {
    const hints = buildTimingHints(cases, options.get("--source") ?? "hosted nextest JUnit");
    const rows = (entries: [string, string, number][]) =>
      `[\n${entries.map((entry) => `    ${JSON.stringify(entry)}`).join(",\n")}\n  ]`;
    const output = `{
  "format_version": 1,
  "source": ${JSON.stringify(hints.source)},
  "purpose": ${JSON.stringify(hints.purpose)},
  "default_seconds": ${hints.default_seconds},
  "families": ${rows(hints.families)},
  "tests": ${rows(hints.tests)}
}
`;
    writeFileSync(options.get("--out") ?? ".config/rust-test-timing-hints.json", output);
    return;
  }
  const timeout = Number(options.get("--timeout") ?? "180");
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("--timeout must be positive");
  const summary = slowTestSummary(cases, timeout);
  if (process.env.GITHUB_STEP_SUMMARY)
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: "a" });
  else process.stdout.write(summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2));
