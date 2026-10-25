import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isRecord } from "./runtime-values.mts";
import baseline from "./fixtures/nextest-inventory-baseline.json" with { type: "json" };
import { runnableWorkspaceImpactTests } from "./rust-test-impact.mts";
import {
  runnableWindowsRustTests,
  windowsPartitionOutcomeSelection,
} from "./windows-rust-tests.mts";
import {
  nextestOutcomeSelection,
  parseNextestOutcomes,
  runNextestWithOutcomes,
  runnableNextestTests,
} from "./nextest-outcomes.mts";

for (const control of baseline.cases)
  void test(`shared nextest inventory preserves old parser observations: ${control.id}`, () => {
    for (const [name, parse] of [
      ["workspace", runnableWorkspaceImpactTests],
      ["windows", runnableWindowsRustTests],
    ] as const)
      for (const allowSkipped of [false, true]) {
        const expected = Reflect.get(control.expected, `${name}-${allowSkipped}`) as unknown;
        let actual: unknown;
        try {
          actual = {
            outcome: "success",
            selected: [...parse(control.input, { allowSkipped })].sort(),
          };
        } catch (error) {
          assert.ok(error instanceof Error);
          actual = { outcome: "failure", message: error.message };
        }
        assert.deepEqual(actual, expected);
      }
  });

void test("shared parser retains explicit default-skip permission separately from ordinary skipped suites", () => {
  const control = baseline.cases.find((item) => item.id === "skipped-default-filter-empty");
  assert.ok(control);
  assert.throws(() => runnableNextestTests(control.input, { allowSkipped: true }));
  assert.throws(() => runnableNextestTests(control.input, { allowDefaultSkipped: true }));
  assert.equal(
    runnableNextestTests(control.input, { allowSkipped: true, allowDefaultSkipped: true }).size,
    0,
  );
});

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/nextest-outcomes/${name}`, import.meta.url), "utf8");
interface FixtureSuite {
  "package-name": string;
  "binary-id": string;
  "binary-name": string;
  kind: string;
  status: string;
  testcases: Record<string, { ignored: boolean; "filter-match": { status: string } }>;
}
function inventory() {
  const input: unknown = JSON.parse(fixture("inventory.json"));
  assert.ok(
    isRecord(input) && typeof input["test-count"] === "number" && isRecord(input["rust-suites"]),
  );
  const suites: Record<string, FixtureSuite> = {};
  for (const [id, entry] of Object.entries(input["rust-suites"])) {
    assert.ok(
      isRecord(entry) &&
        typeof entry["package-name"] === "string" &&
        typeof entry["binary-id"] === "string" &&
        typeof entry["binary-name"] === "string" &&
        typeof entry.kind === "string" &&
        typeof entry.status === "string" &&
        isRecord(entry.testcases),
    );
    const testcases: FixtureSuite["testcases"] = {};
    for (const [name, detail] of Object.entries(entry.testcases)) {
      assert.ok(
        isRecord(detail) &&
          typeof detail.ignored === "boolean" &&
          isRecord(detail["filter-match"]) &&
          typeof detail["filter-match"].status === "string",
      );
      testcases[name] = {
        ignored: detail.ignored,
        "filter-match": { status: detail["filter-match"].status },
      };
    }
    suites[id] = {
      "package-name": entry["package-name"],
      "binary-id": entry["binary-id"],
      "binary-name": entry["binary-name"],
      kind: entry.kind,
      status: entry.status,
      testcases,
    };
  }
  return { "test-count": input["test-count"], "rust-suites": suites };
}
const packageName = "portcove-nextest-protocol";
const identity = (name: string, binary = packageName) =>
  JSON.stringify([packageName, binary, name]);
const selected = (name = "passed") =>
  nextestOutcomeSelection(inventory(), new Set([identity(name)]));
const records = (name = "passed") =>
  fixture(name + ".jsonl")
    .trimEnd()
    .split("\n")
    .map((line) => {
      const value: unknown = JSON.parse(line);
      assert.ok(isRecord(value));
      return value;
    });
const encode = (events: unknown[]) =>
  events.map((event) => JSON.stringify(event)).join("\n") + "\n";

void test("captured pinned nextest chunks count one terminal pass separately from an ignored start", () => {
  const result = parseNextestOutcomes(fixture("passed.jsonl"), selected());
  assert.equal(result.complete, true, result.errors.join("; "));
  assert.equal(result.listed_cases, 3);
  assert.match(result.discovery_scope, /selected nextest listing/u);
  assert.deepEqual(result.selected, [identity("passed")]);
  assert.equal(result.executed.length, 1);
  assert.equal(result.executed[0]!.identity, identity("passed"));
  assert.equal(result.executed[0]!.outcome, "passed");
  assert.ok(result.executed[0]!.duration_ms > 0);
  assert.deepEqual(result.ignored, [identity("ignored")]);
  assert.deepEqual(result.missing, []);
  assert.match(result.ignored_reason, /declaration text unavailable/u);
});

function splitIgnoredChunks() {
  const original = records(),
    start = original[0]!,
    summary = original.at(-1)!;
  const ignoredStart = original[1]!,
    passedStart = original[4]!,
    passed = original[5]!;
  const failingStart = {
    ...passedStart,
    name: String(passedStart.name).replace(/\$passed$/u, "$failing"),
  };
  const failing = { ...passed, name: String(passed.name).replace(/\$passed$/u, "$failing") };
  return [
    { ...start, test_count: 3 },
    ignoredStart,
    passedStart,
    failingStart,
    { ...ignoredStart, event: "ignored" },
    passed,
    summary,
    { ...start, test_count: 3 },
    failing,
    summary,
  ];
}

void test("pinned ignored outcomes and repeated binary chunks join local counts without double-counting ignores", () => {
  const selection = nextestOutcomeSelection(
    inventory(),
    new Set([identity("passed"), identity("failing")]),
  );
  const result = parseNextestOutcomes(encode(splitIgnoredChunks()), selection);
  assert.equal(result.complete, true, result.errors.join("; "));
  assert.equal(result.executed.length, 2);
  assert.deepEqual(result.ignored, [identity("ignored")]);
  assert.deepEqual(result.missing, []);
  // A pair of wrong chunk counts must not cancel into a plausible grand total.
  const contradictory = splitIgnoredChunks();
  contradictory[6] = { ...contradictory[6], passed: 0 };
  contradictory[9] = { ...contradictory[9], passed: 2 };
  const refused = parseNextestOutcomes(encode(contradictory), selection);
  assert.equal(refused.complete, false);
  assert.ok(refused.errors.some((error) => error.includes("chunk outcomes")));
});

void test("ignored terminals remain classifications and cannot invent or duplicate execution", () => {
  for (const alter of [
    (events: Record<string, unknown>[]) => events.splice(4, 0, events[4]!),
    (events: Record<string, unknown>[]) => events.splice(1, 0, events[1]!),
    (events: Record<string, unknown>[]) => {
      events[4] = { ...events[4], name: `${packageName}::portcove_nextest_protocol$passed` };
    },
    (events: Record<string, unknown>[]) => events.splice(1, 1),
  ]) {
    const events = splitIgnoredChunks();
    alter(events);
    const result = parseNextestOutcomes(
      encode(events),
      nextestOutcomeSelection(inventory(), new Set([identity("passed"), identity("failing")])),
    );
    assert.equal(result.complete, false);
    assert.equal(result.executed.length, 2);
  }
});

void test("captured failed nextest outcomes retain identity, duration and original panic output", () => {
  const result = parseNextestOutcomes(fixture("failing.jsonl"), selected("failing"));
  assert.equal(result.complete, true, result.errors.join("; "));
  assert.equal(result.executed.length, 1);
  assert.equal(result.executed[0]!.outcome, "failed");
  assert.equal(result.executed[0]!.identity, identity("failing"));
  assert.match(result.executed[0]!.failure!, /protocol-primary-failure/u);
  assert.equal(result.executed[0]!.failure_truncated, false);
});

void test("pinned timeout-shaped failures retain a bounded native reason without inventing panic output", () => {
  const events = records("failing");
  const timeout = events.find((event) => event.type === "test" && event.event === "failed")!;
  delete timeout.stdout;
  timeout.reason = "time limit exceeded";
  const parsed = parseNextestOutcomes(encode(events), selected("failing"));
  assert.equal(parsed.complete, true, parsed.errors.join("; "));
  assert.equal(parsed.executed[0]!.outcome, "failed");
  assert.equal(parsed.executed[0]!.failure, "time limit exceeded");
  assert.equal(parsed.executed[0]!.failure_raw_source, "original nextest JSON stdout");
  timeout.reason = "x".repeat(20_000);
  const bounded = parseNextestOutcomes(encode(events), selected("failing"));
  assert.equal(bounded.executed[0]!.failure!.length, 16_384);
  assert.equal(bounded.executed[0]!.failure_truncated, true);
  timeout.reason = { unexpected: true };
  assert.equal(parseNextestOutcomes(encode(events), selected("failing")).complete, false);
});

void test("ignored-only native records cannot establish execution of the selected active case", () => {
  const result = parseNextestOutcomes(fixture("ignored.jsonl"), selected());
  assert.equal(result.complete, false);
  assert.equal(result.executed.length, 0);
  assert.deepEqual(result.ignored, [identity("ignored")]);
  assert.deepEqual(result.missing, [identity("passed")]);
});

void test("the Windows partition consumer retains excluded binaries while its complete inventory stays strict", () => {
  const input = inventory();
  input["rust-suites"][packageName]!.testcases.failing!["filter-match"].status = "mismatch";
  input["rust-suites"]["excluded-integration"] = {
    "package-name": packageName,
    "binary-id": "excluded-integration",
    "binary-name": "excluded_contracts",
    kind: "test",
    status: "skipped-default-filter",
    testcases: {},
  };
  assert.throws(() => runnableWindowsRustTests(input), /coverage/u);
  const selection = windowsPartitionOutcomeSelection(input, [identity("passed")]);
  const result = parseNextestOutcomes(fixture("passed.jsonl"), selection);
  assert.equal(result.complete, true, result.errors.join("; "));
  assert.equal(result.executed.length, 1);
  assert.throws(
    () => windowsPartitionOutcomeSelection(input, [identity("passed"), identity("failing")]),
    /expected inventory/u,
  );
});

void test("discovered binary metadata keeps identical case names in distinct binaries separate", () => {
  const input = inventory();
  input["rust-suites"]["integration:test-edge"] = {
    ...structuredClone(input["rust-suites"][packageName]!),
    "binary-id": "integration:test-edge",
    "binary-name": "edge_cases",
    kind: "test",
  };
  input["test-count"] = 6;
  const second = records().map((event) => ({
    ...event,
    ...(typeof event.name === "string"
      ? { name: event.name.replace("::portcove_nextest_protocol$", "::edge_cases$") }
      : {}),
    ...(event.type === "suite"
      ? { nextest: { crate: packageName, test_binary: "edge_cases", kind: "test" } }
      : {}),
  }));
  const result = parseNextestOutcomes(
    fixture("passed.jsonl") + encode(second),
    nextestOutcomeSelection(
      input,
      new Set([identity("passed"), identity("passed", "integration:test-edge")]),
    ),
  );
  assert.equal(result.complete, true, result.errors.join("; "));
  assert.deepEqual(
    result.executed.map((entry) => entry.identity).sort(),
    [identity("passed"), identity("passed", "integration:test-edge")].sort(),
  );
  assert.equal(result.ignored.length, 2);
});

void test("a lost terminal case fails the independent selected identity and native-count joins", () => {
  const altered = records().filter((event) => !(event.type === "test" && event.event === "ok"));
  const result = parseNextestOutcomes(encode(altered), selected());
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, [identity("passed")]);
  assert.ok(result.errors.some((error) => error.includes("terminal counts differ")));
});

void test("a missing final nextest summary cannot reuse the earlier cumulative ignored summary", () => {
  const result = parseNextestOutcomes(encode(records().slice(0, -1)), selected());
  assert.equal(result.executed.length, 1);
  assert.equal(result.complete, false);
  assert.ok(result.errors.some((error) => error.includes("ended before a terminal")));
});

for (const eventName of ["started", "ok"]) {
  void test(`duplicate nextest ${eventName} records cannot inflate execution`, () => {
    const events = records();
    const index = events.findIndex(
      (event) =>
        event.type === "test" &&
        event.event === eventName &&
        String(event.name).endsWith("$passed"),
    );
    assert.ok(index >= 0);
    events.splice(index, 0, events[index]!);
    const result = parseNextestOutcomes(encode(events), selected());
    assert.equal(result.complete, false);
    assert.equal(result.executed.length, 1);
    assert.ok(result.errors.some((error) => error.includes("Duplicate nextest")));
  });
}

void test("unselected native execution and contradictory final counts remain failures", () => {
  const extra = records().map((event) =>
    typeof event.name === "string" && event.name.endsWith("$passed")
      ? { ...event, name: event.name.replace(/\$passed$/u, "$failing") }
      : event,
  );
  const unselected = parseNextestOutcomes(encode(extra), selected());
  assert.equal(unselected.complete, false);
  assert.ok(unselected.errors.some((error) => error.includes("Unselected nextest")));
  const wrongCounts = records();
  wrongCounts.at(-1)!.passed = 0;
  assert.equal(parseNextestOutcomes(encode(wrongCounts), selected()).complete, false);
  const wrongStart = records().map((event) =>
    event.type === "suite" && event.event === "started" ? { ...event, test_count: 3 } : event,
  );
  assert.equal(parseNextestOutcomes(encode(wrongStart), selected()).complete, false);
});

void test("malformed or unsupported events and measurements cannot become complete reports", () => {
  for (const text of [
    "not JSON\n",
    "[]\n",
    '{"type":"unknown"}\n',
    encode(
      records().map((event) =>
        event.type === "test" && event.event === "ok" ? { ...event, exec_time: null } : event,
      ),
    ),
    encode(
      records().map((event) => (event.type === "suite" ? { ...event, nextest: null } : event)),
    ),
  ]) {
    assert.equal(parseNextestOutcomes(text, selected()).complete, false);
  }
});

void test("nextest outcome selection refuses empty, foreign, ignored and ambiguous identities", () => {
  assert.throws(() => nextestOutcomeSelection(inventory(), new Set()), /one to/u);
  assert.throws(
    () => nextestOutcomeSelection(inventory(), new Set([identity("absent")])),
    /escaped/u,
  );
  assert.throws(() => selected("ignored"), /not runnable/u);
  const ambiguous = inventory();
  ambiguous["rust-suites"].other = {
    ...ambiguous["rust-suites"][packageName]!,
    "binary-id": "other",
  };
  assert.throws(
    () => nextestOutcomeSelection(ambiguous, new Set([identity("passed")])),
    /Ambiguous/u,
  );
  const incomplete = inventory();
  incomplete["rust-suites"][packageName]!["binary-name"] = "";
  assert.throws(
    () => nextestOutcomeSelection(incomplete, new Set([identity("passed")])),
    /binary identity/u,
  );
});

void test("the nextest consumer retains profile, human stderr, raw JSON and original failure status", () => {
  const output: string[] = [];
  const status = runNextestWithOutcomes(
    ["--locked", "--profile", "hosted-windows"],
    selected("failing"),
    {
      environment: { TEST_MARKER: "retained" },
      report: (value) => output.push(value),
      spawnSync(command, args, options) {
        assert.equal(command, "cargo-nextest");
        assert.deepEqual(args.slice(0, 5), [
          "nextest",
          "run",
          "--locked",
          "--profile",
          "hosted-windows",
        ]);
        assert.deepEqual(args.slice(-4), [
          "--message-format",
          "libtest-json-plus",
          "--message-format-version",
          "0.1",
        ]);
        assert.deepEqual(options.stdio, ["inherit", "pipe", "inherit"]);
        assert.equal(options.env!.NEXTEST_EXPERIMENTAL_LIBTEST_JSON, "1");
        assert.equal(options.env!.TEST_MARKER, "retained");
        return { status: 100, stdout: fixture("failing.jsonl") };
      },
    },
  );
  assert.equal(status, 100);
  assert.equal(output[0], fixture("failing.jsonl"));
  assert.ok(
    output.some(
      (line) =>
        line.startsWith("Rust test case observation: ") &&
        line.includes("protocol-primary-failure"),
    ),
  );
  assert.ok(output.at(-1)!.includes('"native_status":100'));
});

void test("reporting incompleteness preserves native failures and original process errors", () => {
  const output: string[] = [];
  assert.equal(
    runNextestWithOutcomes([], selected(), {
      report: (value) => output.push(value),
      spawnSync: () => ({ status: 100, stdout: "native partial result\n" }),
    }),
    100,
  );
  assert.match(output[0]!, /native partial result/u);
  assert.ok(output.at(-1)!.includes('"complete":false'));
  const original = new Error("original native spawn failure");
  assert.throws(
    () =>
      runNextestWithOutcomes([], selected(), {
        report() {},
        spawnSync: () => ({ error: original, stdout: "partial" }),
      }),
    (error) => error === original,
  );
});

void test("a throwing result writer preserves native failure and process error but refuses native success", () => {
  let writes = 0;
  const report = () => {
    writes++;
    throw new Error("controlled result writer failure");
  };
  assert.equal(
    runNextestWithOutcomes([], selected("failing"), {
      report,
      spawnSync: () => ({ status: 100, stdout: fixture("failing.jsonl") }),
    }),
    100,
  );
  const original = new Error("primary spawn error with unavailable writer");
  assert.throws(
    () =>
      runNextestWithOutcomes([], selected(), {
        report,
        spawnSync: () => ({ error: original, stdout: "partial" }),
      }),
    (error) => error === original,
  );
  assert.equal(
    runNextestWithOutcomes([], selected(), {
      report,
      spawnSync: () => ({ status: 0, stdout: fixture("passed.jsonl") }),
    }),
    1,
  );
  assert.equal(writes, 3, "each unavailable sink is attempted once");
});

void test("native success cannot bless a missing or failed selected outcome", () => {
  for (const stdout of ["", fixture("ignored.jsonl")])
    assert.equal(
      runNextestWithOutcomes([], selected(), {
        report() {},
        spawnSync: () => ({ status: 0, stdout }),
      }),
      1,
    );
  const output: string[] = [];
  assert.equal(
    runNextestWithOutcomes([], selected("failing"), {
      report: (value) => output.push(value),
      spawnSync: () => ({ status: 0, stdout: fixture("failing.jsonl") }),
    }),
    1,
  );
  assert.match(output.at(-1)!, /contradicts failed nextest/u);
});

void test("bounded nextest failure details retain an explicit raw-output reference", () => {
  const events = records("failing");
  const failure = events.find((event) => event.type === "test" && event.event === "failed")!;
  failure.stdout = "primary failure ".repeat(2000);
  const result = parseNextestOutcomes(encode(events), selected("failing"));
  assert.equal(result.complete, true);
  assert.equal(result.executed[0]!.failure_truncated, true);
  assert.equal(result.executed[0]!.failure!.length, 16_384);
  assert.equal(result.executed[0]!.failure_raw_source, "original nextest JSON stdout");
});
