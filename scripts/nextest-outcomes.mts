import type { SpawnSyncOptions } from "node:child_process";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { errorMessage, isRecord } from "./runtime-values.mts";

const maximumBytes = 32 * 1024 * 1024;
const maximumCases = 16_384;
const root = fileURLToPath(new URL("../", import.meta.url));
const boundedString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 4096;
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximumCases;
const duration = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value * 1000) && value >= 0;

interface BinarySelection {
  prefix: string;
  cases: Map<string, { identity: string; selected: boolean; ignored: boolean }>;
}

/** Validate discovery identities without treating ignored or filtered cases as executed. */
export function runnableNextestTests(
  inventory: unknown,
  { allowSkipped = false, allowDefaultSkipped = false } = {},
) {
  if (
    !isRecord(inventory) ||
    typeof inventory["test-count"] !== "number" ||
    !Number.isSafeInteger(inventory["test-count"]) ||
    inventory["test-count"] < 0 ||
    !isRecord(inventory["rust-suites"])
  )
    throw new Error("Incomplete nextest workspace inventory");
  let total = 0;
  const matched = new Set<string>();
  for (const [binaryId, suite] of Object.entries(inventory["rust-suites"])) {
    const skipped =
      isRecord(suite) &&
      (suite.status === "skipped" ||
        (allowDefaultSkipped && suite.status === "skipped-default-filter"));
    if (
      !isRecord(suite) ||
      typeof suite["package-name"] !== "string" ||
      !/^[a-z0-9][a-z0-9-]*$/u.test(suite["package-name"]) ||
      suite["binary-id"] !== binaryId ||
      (suite.status !== "listed" && !(allowSkipped && skipped)) ||
      !isRecord(suite.testcases)
    )
      throw new Error("Unexpected nextest workspace suite identity or coverage");
    if (skipped && Object.keys(suite.testcases).length)
      throw new Error("Skipped nextest suite contained test records");
    for (const [name, detail] of Object.entries(suite.testcases)) {
      total++;
      const status =
        isRecord(detail) && isRecord(detail["filter-match"])
          ? detail["filter-match"].status
          : undefined;
      if (
        !name ||
        !isRecord(detail) ||
        typeof detail.ignored !== "boolean" ||
        (status !== "matches" && status !== "mismatch")
      )
        throw new Error("Invalid nextest workspace test record");
      if (status === "matches" && !detail.ignored)
        matched.add(JSON.stringify([suite["package-name"], binaryId, name]));
    }
  }
  if (total !== inventory["test-count"]) throw new Error("Truncated nextest workspace inventory");
  return matched;
}

/** Bind the result dialect to discovery metadata, never infer a binary ID from its display name. */
export function nextestOutcomeSelection(inventory: unknown, selected: ReadonlySet<string>) {
  if (!selected.size || selected.size > maximumCases)
    throw new Error("Nextest outcome selection must contain one to 16384 test identities");
  if (!isRecord(inventory) || !isRecord(inventory["rust-suites"]))
    throw new Error("Nextest outcomes need a complete discovered binary inventory");
  const binaries = new Map<string, BinarySelection>();
  const discovered = new Set<string>();
  for (const [binaryId, suite] of Object.entries(inventory["rust-suites"])) {
    if (
      !isRecord(suite) ||
      !boundedString(suite["package-name"]) ||
      suite["binary-id"] !== binaryId ||
      !boundedString(suite["binary-name"]) ||
      !boundedString(suite.kind) ||
      !isRecord(suite.testcases)
    )
      throw new Error("Nextest outcomes lack an unambiguous discovered binary identity");
    const packageName = suite["package-name"];
    const key = JSON.stringify([packageName, suite["binary-name"], suite.kind]);
    if (binaries.has(key)) throw new Error("Ambiguous nextest result binary identity");
    const binary: BinarySelection = {
      prefix: `${packageName}::${suite["binary-name"]}$`,
      cases: new Map(),
    };
    binaries.set(key, binary);
    for (const [name, detail] of Object.entries(suite.testcases)) {
      if (!boundedString(name) || !isRecord(detail) || typeof detail.ignored !== "boolean")
        throw new Error("Invalid nextest outcome discovery record");
      const identity = JSON.stringify([packageName, binaryId, name]);
      if (
        selected.has(identity) &&
        (detail.ignored ||
          !isRecord(detail["filter-match"]) ||
          detail["filter-match"].status !== "matches")
      )
        throw new Error("Selected nextest outcome is not runnable in its inventory");
      discovered.add(identity);
      binary.cases.set(binary.prefix + name, {
        identity,
        selected: selected.has(identity),
        ignored: detail.ignored,
      });
    }
  }
  if (discovered.size > maximumCases || [...selected].some((id) => !discovered.has(id)))
    throw new Error("Nextest selected outcomes escaped their discovered inventory");
  return { binaries, selected: new Set(selected), discovered: discovered.size };
}

export function parseNextestOutcomes(
  text: string,
  selection: ReturnType<typeof nextestOutcomeSelection>,
) {
  const errors = new Set<string>();
  const error = (message: string) => {
    if (errors.size < 32) errors.add(message);
  };
  const outcomes = new Map<
    string,
    {
      identity: string;
      outcome: "passed" | "failed";
      duration_ms: number;
      failure: string | null;
      failure_truncated: boolean;
      failure_raw_source: string | null;
    }
  >();
  const started = new Set<string>();
  const ignored = new Set<string>();
  const ignoredTerminals = new Set<string>();
  const summaries = new Map<
    string,
    { passed: number; failed: number; ignored: number; measured: number }
  >();
  const startCounts = new Map<string, number>();
  const owners = new Map<string, string>();
  let active: { key: string; binary: BinarySelection; passed: number; failed: number } | null =
    null;
  if (Buffer.byteLength(text) > maximumBytes) error("Nextest result stream exceeds 32 MiB");
  else
    for (const line of text.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        error("Malformed nextest result JSON");
        continue;
      }
      if (!isRecord(event)) {
        error("Invalid nextest result event");
        continue;
      }
      if (event.type === "suite") {
        const metadata = event.nextest;
        if (!isRecord(metadata)) {
          error("Nextest suite result has no binary metadata");
          continue;
        }
        const key = JSON.stringify([metadata.crate, metadata.test_binary, metadata.kind]);
        const binary = selection.binaries.get(key);
        if (!binary) {
          error("Unexpected nextest result binary");
          continue;
        }
        if (event.event === "started") {
          if (active || !count(event.test_count)) error("Malformed nextest suite start");
          else {
            if (startCounts.has(key) && startCounts.get(key) !== event.test_count)
              error("Nextest suite start count changed between chunks");
            startCounts.set(key, event.test_count);
          }
          active = { key, binary, passed: 0, failed: 0 };
        } else if (event.event === "ok" || event.event === "failed") {
          if (
            active?.key !== key ||
            !count(event.passed) ||
            !count(event.failed) ||
            !count(event.ignored) ||
            !count(event.measured) ||
            !count(event.filtered_out) ||
            !duration(event.exec_time)
          )
            error("Malformed nextest terminal suite summary");
          else {
            const previous = summaries.get(key);
            // Pinned 0.9.100 can finalize and recreate one binary's reporter while
            // ignored cases are arriving. Passed/failed are local to each block;
            // ignored and the start count describe the entire selected binary.
            if (
              event.passed !== active.passed ||
              event.failed !== active.failed ||
              event.measured !== 0 ||
              (previous && previous.ignored !== event.ignored)
            )
              error("Nextest terminal counts differ from their chunk outcomes");
            summaries.set(key, {
              passed: (previous?.passed ?? 0) + event.passed,
              failed: (previous?.failed ?? 0) + event.failed,
              ignored: event.ignored,
              measured: event.measured,
            });
          }
          active = null;
        } else error("Unknown nextest suite event");
        continue;
      }
      if (event.type !== "test" || !active || !boundedString(event.name)) {
        error("Nextest case result has no active discovered binary");
        continue;
      }
      const entry = active.binary.cases.get(event.name);
      if (!entry) {
        error("Unexpected nextest test identity");
        continue;
      }
      owners.set(entry.identity, active.key);
      if (event.event === "started") {
        if (entry.ignored && !entry.selected) {
          if (ignored.has(entry.identity)) error("Duplicate nextest ignored start");
          ignored.add(entry.identity);
        } else if (!entry.selected) error("Unselected nextest test started");
        else {
          if (started.has(entry.identity)) error("Duplicate nextest test start");
          started.add(entry.identity);
        }
        continue;
      }
      if (event.event === "ignored") {
        if (!entry.ignored || entry.selected || !ignored.has(entry.identity))
          error("Nextest ignored outcome lacks its discovered ignored start");
        else if (ignoredTerminals.has(entry.identity)) error("Duplicate nextest ignored outcome");
        else ignoredTerminals.add(entry.identity);
        continue;
      }
      if (event.event !== "ok" && event.event !== "failed") {
        error("Unknown nextest case outcome");
        continue;
      }
      if (!entry.selected || !started.has(entry.identity) || !duration(event.exec_time)) {
        error("Nextest terminal outcome lacks its selected start or duration");
        continue;
      }
      if (outcomes.has(entry.identity)) {
        error("Duplicate nextest terminal outcome");
        continue;
      }
      if (
        (event.stdout !== undefined && typeof event.stdout !== "string") ||
        (event.reason !== undefined && typeof event.reason !== "string")
      ) {
        error("Malformed nextest failure output");
        continue;
      }
      const failure =
        event.event !== "failed"
          ? null
          : typeof event.reason === "string"
            ? event.reason + (typeof event.stdout === "string" ? "\n" + event.stdout : "")
            : typeof event.stdout === "string"
              ? event.stdout
              : null;
      outcomes.set(entry.identity, {
        identity: entry.identity,
        outcome: event.event === "ok" ? "passed" : "failed",
        duration_ms: event.exec_time * 1000,
        failure: failure?.slice(0, 16_384) ?? null,
        failure_truncated: (failure?.length ?? 0) > 16_384,
        failure_raw_source: failure === null ? null : "original nextest JSON stdout",
      });
      if (event.event === "ok") active.passed++;
      else active.failed++;
    }
  if (active) error("Nextest result stream ended before a terminal suite summary");
  const missing = [...selection.selected].filter((id) => !outcomes.has(id));
  if (missing.length) error("Selected nextest tests have no terminal outcome");
  for (const [key, binary] of selection.binaries) {
    const cases = [...outcomes.values()].filter((entry) => owners.get(entry.identity) === key);
    const skipped = [...ignored].filter((id) => owners.get(id) === key).length;
    const discoveredIgnored = [...binary.cases.values()].filter((entry) => entry.ignored).length;
    const selectedCount = [...binary.cases.values()].filter((entry) => entry.selected).length;
    const expected = [...binary.cases.values()].some((entry) => entry.selected);
    const summary = summaries.get(key);
    if (!summary) {
      if (expected || cases.length || skipped) error("Nextest binary has no terminal summary");
      continue;
    }
    if (
      summary.passed !== cases.filter((entry) => entry.outcome === "passed").length ||
      summary.failed !== cases.filter((entry) => entry.outcome === "failed").length ||
      summary.ignored !== skipped ||
      summary.ignored !== discoveredIgnored
    )
      error("Nextest terminal counts differ from observed case identities");
    if (
      startCounts.get(key) !==
        summary.passed + summary.failed + summary.ignored + summary.measured ||
      startCounts.get(key) !== selectedCount + discoveredIgnored
    )
      error("Nextest final suite count differs from its start count");
  }
  return {
    format_version: 1,
    runner: "nextest-libtest-json-plus-0.1",
    listed_cases: selection.discovered,
    discovery_scope:
      "selected nextest listing; complete workspace discovery remains with the caller",
    selected: [...selection.selected].sort(),
    executed: [...outcomes.values()],
    ignored: [...ignored].sort(),
    ignored_reason: "native ignored classification; declaration text unavailable",
    missing,
    complete: errors.size === 0,
    errors: [...errors],
  };
}

type OutcomeRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptions,
) => {
  status?: number | null;
  error?: Error;
  stdout?: string | Buffer | null;
};

/** Run under the caller's existing process-tree reservation and original nextest profile. */
export function runNextestWithOutcomes(
  args: string[],
  selection: ReturnType<typeof nextestOutcomeSelection>,
  dependencies: {
    spawnSync?: OutcomeRunner;
    report?: (value: string) => void;
    environment?: NodeJS.ProcessEnv;
    cwd?: string;
  } = {},
) {
  const run = dependencies.spawnSync ?? spawnSync;
  const report = dependencies.report ?? ((value: string) => process.stdout.write(value + "\n"));
  const reporting: { failure: string | null } = { failure: null };
  const publish = (value: string) => {
    if (reporting.failure !== null) return;
    try {
      report(value);
    } catch (failure) {
      try {
        reporting.failure = errorMessage(failure).slice(0, 4096);
      } catch {
        reporting.failure = "unavailable diagnostic writer failure";
      }
    }
  };
  const environment = dependencies.environment ?? process.env;
  const result = run(
    "cargo-nextest",
    [
      "nextest",
      "run",
      ...args,
      "--message-format",
      "libtest-json-plus",
      "--message-format-version",
      "0.1",
    ],
    {
      cwd: dependencies.cwd ?? root,
      encoding: "utf8",
      maxBuffer: maximumBytes,
      stdio: ["inherit", "pipe", "inherit"],
      windowsHide: true,
      env: { ...environment, NEXTEST_EXPERIMENTAL_LIBTEST_JSON: "1" },
    },
  );
  const raw = String(result.stdout ?? "");
  if (raw) publish(raw);
  const observation = parseNextestOutcomes(raw, selection);
  if (result.status === 0 && observation.executed.some((entry) => entry.outcome === "failed")) {
    observation.complete = false;
    observation.errors.push("Native success contradicts failed nextest outcomes");
  }
  const label = (name: string) => {
    const value = environment[name];
    return typeof value === "string" && value.length <= 4096 ? value : null;
  };
  const context = {
    invocation_id: randomUUID(),
    source: label("PORTCOVE_HEAD_SHA"),
    checkout: label("PORTCOVE_CHECKOUT_SHA") ?? label("GITHUB_SHA"),
    run: label("GITHUB_RUN_ID"),
    attempt: label("GITHUB_RUN_ATTEMPT"),
    job: label("GITHUB_JOB"),
    platform: process.platform,
    arch: process.arch,
  };
  for (const entry of observation.executed)
    publish(
      `Rust test case observation: ${JSON.stringify({ format_version: 1, ...context, ...entry })}`,
    );
  publish(
    `Rust test execution inventory: ${JSON.stringify({ ...context, ...observation, executed: observation.executed.map((entry) => entry.identity), native_status: result.status ?? null, process_error: result.error ? errorMessage(result.error) : null })}`,
  );
  if (reporting.failure !== null) {
    try {
      process.stderr.write(`[rust-outcomes] reporting incomplete: ${reporting.failure}\n`);
    } catch {
      /* The original native failure remains primary when both sinks are unavailable. */
    }
  }
  if (result.error) throw result.error;
  if (result.status !== 0) return result.status ?? 1;
  return observation.complete && reporting.failure === null ? 0 : 1;
}
