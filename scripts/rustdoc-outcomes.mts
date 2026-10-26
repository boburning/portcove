import { isRecord } from "./runtime-values.mts";

export const rustdocMaximumBytes = 32 * 1024 * 1024;
const maximumCases = 16_384;
const maximumSuites = 1024;
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximumCases;
const seconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value * 1000) && value >= 0;

interface Case {
  identity: string;
  outcome: "passed" | "failed" | "skipped";
  duration_ms: number | null;
  skip_reason: string | null;
  failure: string | null;
}
interface Suite {
  count: number;
  started: Set<string>;
  terminals: Map<string, Case>;
}
interface State {
  active: Suite | null;
  suites: number;
  selected: number;
  filtered: number;
  cases: Case[];
  identities: Set<string>;
  phases: { total_seconds: number; compilation_seconds: number }[];
}

function startSuite(event: Record<string, unknown>, state: State) {
  if (state.active || !count(event.test_count) || ++state.suites > maximumSuites)
    throw new Error("Invalid or overlapping rustdoc suite");
  state.selected += event.test_count;
  if (state.selected > maximumCases) throw new Error("Rustdoc selection exceeds case limit");
  state.active = { count: event.test_count, started: new Set(), terminals: new Map() };
}

function observeTest(event: Record<string, unknown>, state: State) {
  const suite = state.active;
  const name = event.name;
  if (
    !suite ||
    typeof name !== "string" ||
    name.length > 4096 ||
    !/^.+ - .*\(line [1-9][0-9]*\)$/u.test(name)
  )
    throw new Error("Rustdoc test has no bounded identity or active suite");
  if (event.event === "started") {
    if (state.identities.has(name) || suite.started.size >= suite.count)
      throw new Error("Duplicate or excessive rustdoc identity");
    state.identities.add(name);
    suite.started.add(name);
    return;
  }
  if (!suite.started.has(name) || suite.terminals.has(name))
    throw new Error("Rustdoc terminal has no unique start");
  if (!["ok", "failed", "ignored"].includes(String(event.event)))
    throw new Error("Unknown rustdoc test outcome");
  const skipped = event.event === "ignored";
  if (!skipped && !seconds(event.exec_time))
    throw new Error("Rustdoc executed case has no finite native duration");
  if (
    (event.stdout !== undefined && typeof event.stdout !== "string") ||
    (event.message !== undefined && typeof event.message !== "string")
  )
    throw new Error("Invalid rustdoc failure or skip detail");
  const entry: Case = {
    identity: name,
    outcome: skipped ? "skipped" : event.event === "ok" ? "passed" : "failed",
    duration_ms: seconds(event.exec_time) && !skipped ? event.exec_time * 1000 : null,
    skip_reason: skipped && typeof event.message === "string" ? event.message : null,
    failure: event.event === "failed" && typeof event.stdout === "string" ? event.stdout : null,
  };
  suite.terminals.set(name, entry);
  state.cases.push(entry);
}

function finishSuite(event: Record<string, unknown>, state: State) {
  const suite = state.active;
  if (!suite || suite.started.size !== suite.count || suite.terminals.size !== suite.count)
    throw new Error("Rustdoc suite ended without every selected terminal");
  for (const field of ["passed", "failed", "ignored", "measured", "filtered_out"])
    if (!count(event[field])) throw new Error("Invalid rustdoc summary count");
  const cases = [...suite.terminals.values()];
  if (
    event.passed !== cases.filter((entry) => entry.outcome === "passed").length ||
    event.failed !== cases.filter((entry) => entry.outcome === "failed").length ||
    event.ignored !== cases.filter((entry) => entry.outcome === "skipped").length ||
    event.measured !== 0 ||
    !seconds(event.exec_time) ||
    (event.event === "failed") !== Number(event.failed) > 0
  )
    throw new Error("Rustdoc native summary contradicts case outcomes");
  state.filtered += Number(event.filtered_out);
  if (state.selected + state.filtered > maximumCases)
    throw new Error("Rustdoc discovery exceeds case limit");
  state.active = null;
}

function observe(event: unknown, state: State) {
  if (!isRecord(event)) throw new Error("Rustdoc record is not an object");
  if (event.type === "test") return observeTest(event, state);
  if (event.type === "suite") {
    if (event.event === "started") return startSuite(event, state);
    if (event.event === "ok" || event.event === "failed") return finishSuite(event, state);
  }
  if (
    event.type === "report" &&
    !state.active &&
    seconds(event.total_time) &&
    seconds(event.compilation_time) &&
    event.compilation_time <= event.total_time &&
    state.phases.length < maximumSuites
  ) {
    state.phases.push({
      total_seconds: event.total_time,
      compilation_seconds: event.compilation_time,
    });
    return;
  }
  throw new Error("Unknown or misplaced rustdoc protocol record");
}

/** Only rustdoc path-qualified names are identities; ordinary libtest binaries are unsupported. */
export function parseRustdocOutcomes(raw: string) {
  const state: State = {
    active: null,
    suites: 0,
    selected: 0,
    filtered: 0,
    cases: [],
    identities: new Set(),
    phases: [],
  };
  let failure: string | null = null;
  try {
    if (Buffer.byteLength(raw) > rustdocMaximumBytes)
      throw new Error("Rustdoc output exceeds byte limit");
    for (const line of raw.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > 1024 * 1024)
        throw new Error("Rustdoc record exceeds line limit");
      observe(JSON.parse(line), state);
    }
    if (state.active || !state.suites) throw new Error("Rustdoc has no complete native suite");
    if (!state.selected && state.filtered)
      throw new Error("Rustdoc selected no cases from nonempty discovery");
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  return {
    complete: failure === null,
    failure,
    discovered: failure === null ? state.selected + state.filtered : null,
    selected: failure === null ? state.selected : null,
    executed: state.cases.filter((entry) => entry.outcome !== "skipped").length,
    skipped: state.cases.filter((entry) => entry.outcome === "skipped").length,
    failed: state.cases.filter((entry) => entry.outcome === "failed").length,
    filtered: failure === null ? state.filtered : null,
    observed_suites: state.suites,
    cases: state.cases,
    phases: state.phases,
  };
}
