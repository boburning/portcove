import { Writable } from "node:stream";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { probeVitePlusRules } from "./viteplus-renovate-probe.mts";
import {
  normalizeExtraction,
  validateGlobalConfig,
  validatePresetResult,
  validateLookupResult,
  validateCommandRecords,
  validateEngine,
  freezeProbeClock,
  validateArtifactResult,
  probeFailureSummary,
  retainProbeEvidence,
} from "./renovate-engine-probe.mts";
void test("probe failures bound oversized Unicode assertions and expose the retained raw report", () => {
  const error = Object.assign(new Error("different lock: " + "未知😀".repeat(10000)), {
    reportReference: "work/probe/failed/report.json",
  });
  const text = probeFailureSummary(error) + "\n";
  assert(Buffer.byteLength(text) <= 16 * 1024);
  assert.match(text, /Raw evidence: work\/probe\/failed\/report.json/);
  assert.match(text, /different lock/);
  assert(error.message.length > 30000);
});
void test("artifact contents normalize real Buffer results and reject ambiguous shapes", () => {
  assert.equal(
    validateArtifactResult([
      { file: { type: "addition", path: "Cargo.lock", contents: Buffer.from("lock") } },
    ]),
    "lock",
  );
  assert.throws(
    () =>
      validateArtifactResult([{ file: { type: "addition", path: "Cargo.lock", contents: {} } }]),
    /content shape/,
  );
  assert.throws(() => validateArtifactResult([{ artifactError: {} }]), /Artifact failure/);
});
void test("probe freezes both new Date and Date.now and restores the real clock", () => {
  const OriginalDate = Date,
    observedAt = "2026-10-14T15:07:26.355Z",
    restore = freezeProbeClock(observedAt);
  try {
    assert.equal(new Date().toISOString(), observedAt);
    assert.equal(Date.now(), Date.parse(observedAt));
    assert.equal(new Date("2020-01-01").getUTCFullYear(), 2020);
  } finally {
    restore();
  }
  assert.equal(Date, OriginalDate);
});
void test("probe rejects incorrect extraction, preset and Result assumptions before artifacts", () => {
  assert.throws(() => normalizeExtraction({ dependencies: [] }), /deps/);
  const deps = ["serde_json", "semver"].map((depName) => ({
    depName,
    datasource: "crate",
    currentValue: "1.0.152",
    lockedVersion: "1.0.152",
  }));
  assert.deepEqual(
    normalizeExtraction({ deps }).map((dep) => dep.packageName),
    ["serde_json", "semver"],
  );
  assert.throws(() => normalizeExtraction({ deps: [deps[0], deps[0]] }), /Duplicate/);
  assert.throws(() => validatePresetResult({ rangeStrategy: "bump" }), /config/);
  assert.deepEqual(validatePresetResult({ config: {}, visitedPresets: {} }), {});
  assert.throws(() => validateLookupResult({ updates: [] }), /Result/);
  assert.throws(() => validateLookupResult({ res: { ok: false, val: { updates: [] } } }), /Result/);
  assert.deepEqual(validateLookupResult({ res: { ok: true, val: { updates: [] } } }), []);
});
void test("command evidence cannot silently omit or accept empty records", () => {
  assert.throws(() => validateCommandRecords([]), /missing/);
  assert.throws(() => validateCommandRecords([{ msg: "Executing command", cmd: "" }]), /Empty/);
  assert.deepEqual(
    validateCommandRecords([
      { msg: "Executing command", command: "cargo update" },
      { msg: "Executing command", cmd: "cargo update --workspace" },
    ]),
    ["cargo update", "cargo update --workspace"],
  );
});
void test("engine version mismatch requires new capture instead of reusing a fixture", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "engine-version-"));
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "99.0.0" }));
    assert.throws(
      () => validateEngine(root, { engine: { version: "44.156.3" } }),
      /fresh.*capture/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
import { errorMessage, isRecord } from "./runtime-values.mts";

void test("frozen probe clock retains callable Date, native constructors and subclassing", () => {
  const OriginalDate = Date;
  const observedAt = "2026-10-14T15:07:26.355Z";
  const restore = freezeProbeClock(observedAt);
  try {
    assert.equal(Date(), new OriginalDate(observedAt).toString());
    assert.equal(new Date().toISOString(), observedAt);
    assert.equal(Date.now(), OriginalDate.parse(observedAt));
    assert.equal(Date.parse("2020-01-01"), OriginalDate.parse("2020-01-01"));
    assert.equal(Date.UTC(2020, 3, 4), OriginalDate.UTC(2020, 3, 4));
    assert.equal(
      new Date(2020, 3, 4, 5, 6, 7, 8).getTime(),
      new OriginalDate(2020, 3, 4, 5, 6, 7, 8).getTime(),
    );
    assert.equal(new Date(new OriginalDate(12345)).getTime(), 12345);
    assert.ok(Number.isNaN(new Date(NaN).getTime()));
    class DerivedDate extends Date {}
    const derived = new DerivedDate(12345);
    assert.equal(derived.getTime(), 12345);
    assert.ok(derived instanceof DerivedDate && derived instanceof OriginalDate);
    assert.equal(Object.getPrototypeOf(derived), DerivedDate.prototype);
  } finally {
    restore();
  }
  assert.equal(Date, OriginalDate);
});

async function assertProbeFailureRetention(
  retain: typeof retainProbeEvidence,
  freeze: typeof freezeProbeClock,
  root: string,
) {
  const readOnly = Object.defineProperty(
    new Error("read-only report reference"),
    "reportReference",
    { value: "original-evidence.json" },
  );
  const inheritedReadOnly = new Error("inherited read-only report reference");
  const inheritedPrototype: unknown = Object.create(Error.prototype, {
    reportReference: { get: () => "original-evidence.json" },
  });
  assert.ok(isRecord(inheritedPrototype));
  Object.setPrototypeOf(inheritedReadOnly, inheritedPrototype);
  const failures: unknown[] = [
    readOnly,
    inheritedReadOnly,
    Object.freeze(new Error("frozen engine failure")),
    null,
    undefined,
    false,
    0,
    "",
    Symbol("engine-failure"),
    new Error("mutable engine failure"),
  ];
  for (const [index, primary] of failures.entries()) {
    for (const withLogger of [false, true]) {
      const report: { state: "running" | "failed" | "complete"; failure?: string } = {
        state: "running",
      };
      const originalDate = Date;
      const restore = freeze("2026-10-14T15:07:26.355Z");
      const reference = path.join(
        root,
        `failure-${index}-${withLogger ? "logger" : "absent"}.json`,
      );
      const events: string[] = [];
      const stream = withLogger
        ? new Writable({
            final(done) {
              events.push("stream-end");
              done();
            },
          })
        : undefined;
      try {
        await assert.rejects(
          retain(
            report,
            reference,
            async () => {
              throw primary;
            },
            {
              restoreClock: () => {
                events.push("restore-clock");
                restore();
              },
              save: () => {
                events.push("save-report");
                writeFileSync(reference, JSON.stringify(report));
              },
              loggerStream: () => stream,
            },
          ),
          (error: unknown) => error === primary,
        );
        assert.equal(report.state, "failed", "probe report state must retain failure");
        assert.equal(report.failure, errorMessage(primary));
        assert.deepEqual(JSON.parse(readFileSync(reference, "utf8")), report);
        assert.deepEqual(
          events,
          ["restore-clock", "save-report", ...(withLogger ? ["stream-end"] : [])],
          "probe finalizers must restore, save and finish in order",
        );
        assert.equal(Date, originalDate);
        if (stream) assert.equal(stream.writableFinished, true);
        if (index === failures.length - 1) {
          assert.ok(isRecord(primary));
          assert.equal(primary.reportReference, reference);
        }
      } finally {
        restore();
        if (stream && !stream.writableEnded) stream.end();
      }
    }
  }
}

void test("probe failure recording preserves frozen and primitive primary failures", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "probe-failure-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assertProbeFailureRetention(retainProbeEvidence, freezeProbeClock, root);
});

void test("successful probe evidence restores the clock, saves before closing and drains its logger", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "probe-complete-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report: { state: "running" | "complete" | "failed" } = { state: "running" };
  const reference = path.join(root, "report.json"),
    events: string[] = [];
  const stream = new Writable({
    final(done) {
      events.push("stream-end");
      done();
    },
  });
  await retainProbeEvidence(
    report,
    reference,
    async () => {
      events.push("observe");
      report.state = "complete";
    },
    {
      restoreClock: () => events.push("restore-clock"),
      save: () => {
        events.push("save-report");
        writeFileSync(reference, JSON.stringify(report));
      },
      loggerStream: () => stream,
    },
  );
  assert.deepEqual(JSON.parse(readFileSync(reference, "utf8")), { state: "complete" });
  assert.deepEqual(events, ["observe", "restore-clock", "save-report", "stream-end"]);
  assert.equal(stream.writableFinished, true);
});

function* probeSyntaxNodes(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) yield* probeSyntaxNodes(item);
  } else if (isRecord(value)) {
    if (typeof value.type === "string") yield value;
    for (const child of Object.values(value)) yield* probeSyntaxNodes(child);
  }
}
function probeIdentifier(value: unknown) {
  return isRecord(value) && value.type === "Identifier" && typeof value.name === "string"
    ? value.name
    : undefined;
}
function probeProperty(value: unknown, name: string) {
  assert.ok(
    isRecord(value) && value.type === "ObjectExpression" && Array.isArray(value.properties),
  );
  const property: unknown = value.properties.find(
    (item: unknown) =>
      isRecord(item) &&
      item.type === "Property" &&
      !item.computed &&
      (probeIdentifier(item.key) === name || (isRecord(item.key) && item.key.value === name)),
  );
  assert.ok(isRecord(property), `missing ${name} property`);
  return property.value;
}
function probeArrowValue(value: unknown) {
  assert.ok(isRecord(value) && value.type === "ArrowFunctionExpression");
  const body = value.body;
  if (isRecord(body) && body.type === "BlockStatement") {
    assert.ok(Array.isArray(body.body) && body.body.length === 1);
    const statement: unknown = body.body[0];
    assert.ok(isRecord(statement) && statement.type === "ReturnStatement");
    return statement.argument;
  }
  return body;
}
function probeSourceRange(value: Record<string, unknown>) {
  assert.ok(typeof value.start === "number" && typeof value.end === "number");
  assert.ok(value.start >= 0 && value.end > value.start);
  return { start: value.start, end: value.end };
}
function editProbeSource(source: string, changes: { start: number; end: number; text: string }[]) {
  return changes
    .sort((a, b) => b.start - a.start)
    .reduce(
      (text, change) => text.slice(0, change.start) + change.text + text.slice(change.end),
      source,
    );
}
async function inspectProbeEvidenceWiring(source: string) {
  const { stripTypeScriptTypes } = await import("node:module");
  const { parseAst } = await import("vite-plus");
  const tree: unknown = parseAst(stripTypeScriptTypes(source, { mode: "strip" }));
  const nodes = [...probeSyntaxNodes(tree)];
  const syntaxName = (value: unknown) =>
    probeIdentifier(value) ??
    (isRecord(value) && typeof value.value === "string" ? value.value : undefined);
  const exportedBinding = (name: string) => {
    for (const node of nodes) {
      if (node.type !== "ExportNamedDeclaration") continue;
      if (
        isRecord(node.declaration) &&
        node.declaration.type === "FunctionDeclaration" &&
        probeIdentifier(node.declaration.id) === name
      )
        return { name, declaration: node.declaration, statement: node, specifier: undefined };
      if (!Array.isArray(node.specifiers)) continue;
      for (const item of node.specifiers) {
        if (!isRecord(item) || syntaxName(item.exported) !== name) continue;
        const local = probeIdentifier(item.local);
        const declaration = nodes.find(
          (candidate) =>
            candidate.type === "FunctionDeclaration" && probeIdentifier(candidate.id) === local,
        );
        assert.ok(local && declaration);
        return { name: local, declaration, statement: declaration, specifier: item };
      }
    }
    assert.fail(`missing exported ${name} binding`);
  };
  const helper = exportedBinding("retainProbeEvidence"),
    clock = exportedBinding("freezeProbeClock");
  const awaits = nodes.filter(
    (node) =>
      node.type === "AwaitExpression" &&
      isRecord(node.argument) &&
      node.argument.type === "CallExpression" &&
      probeIdentifier(node.argument.callee) === helper.name,
  );
  assert.equal(awaits.length, 1, "the actual driver must await its evidence owner exactly once");
  const awaited = awaits[0]!;
  assert.ok(isRecord(awaited.argument) && Array.isArray(awaited.argument.arguments));
  const call = awaited.argument;
  assert.ok(Array.isArray(call.arguments));
  const args: unknown[] = call.arguments;
  assert.equal(args.length, 4);
  const callers = nodes.filter(
    (node) =>
      node.type === "FunctionDeclaration" && [...probeSyntaxNodes(node.body)].includes(awaited),
  );
  assert.equal(callers.length, 1);
  const caller = callers[0]!;
  assert.ok(isRecord(caller.body) && Array.isArray(caller.body.body));
  const callerName = probeIdentifier(caller.id);
  assert.ok(callerName);
  assert.ok(
    caller.body.body.some(
      (statement: unknown) =>
        isRecord(statement) &&
        statement.type === "ExpressionStatement" &&
        statement.expression === awaited,
    ),
    "the driver must execute the helper await as a top-level statement",
  );
  const returned: unknown = caller.body.body.at(-1);
  assert.ok(isRecord(returned) && returned.type === "ReturnStatement");
  const report = probeIdentifier(probeProperty(returned.argument, "report"));
  const reference = probeIdentifier(probeProperty(returned.argument, "reference"));
  assert.ok(report && reference);
  assert.equal(probeIdentifier(args[0]), report, "driver must retain its returned report");
  assert.equal(
    probeIdentifier(args[1]),
    reference,
    "driver must retain its returned evidence path",
  );
  const observe = args[2];
  assert.ok(
    isRecord(observe) && observe.type === "ArrowFunctionExpression" && observe.async === true,
  );
  const restore = probeArrowValue(probeProperty(args[3], "restoreClock"));
  assert.ok(isRecord(restore) && restore.type === "CallExpression");
  const clockVariable = probeIdentifier(restore.callee);
  const stream = probeArrowValue(probeProperty(args[3], "loggerStream"));
  const streamVariable = probeIdentifier(stream);
  const saveVariable = probeIdentifier(probeProperty(args[3], "save"));
  assert.ok(clockVariable && streamVariable && saveVariable);
  const importBinding = (module: string, imported: string) => {
    const matches = nodes
      .filter(
        (node) =>
          node.type === "ImportDeclaration" &&
          isRecord(node.source) &&
          node.source.value === module,
      )
      .flatMap((node) => (Array.isArray(node.specifiers) ? (node.specifiers as unknown[]) : []))
      .filter((item) => isRecord(item) && syntaxName(item.imported) === imported);
    assert.equal(matches.length, 1, `one ${module}/${imported} binding`);
    const specifier = matches[0];
    assert.ok(isRecord(specifier));
    const local = probeIdentifier(specifier.local);
    assert.ok(local);
    return local;
  };
  const member = (value: unknown, name: string) =>
    isRecord(value) && value.type === "MemberExpression" && syntaxName(value.property) === name;
  assert.ok(isRecord(tree) && Array.isArray(tree.body));
  const moduleStatements: unknown[] = tree.body;
  const mainGuard = moduleStatements.filter(isRecord).find((node) => {
    if (
      node.type !== "IfStatement" ||
      !isRecord(node.test) ||
      node.test.type !== "BinaryExpression" ||
      node.test.operator !== "==="
    )
      return false;
    return [
      [node.test.left, node.test.right],
      [node.test.right, node.test.left],
    ].some(
      ([argument, executable]) =>
        isRecord(argument) &&
        argument.type === "MemberExpression" &&
        isRecord(argument.property) &&
        argument.property.value === 1 &&
        member(argument.object, "argv") &&
        isRecord(argument.object) &&
        probeIdentifier(argument.object.object) === "process" &&
        isRecord(executable) &&
        executable.type === "CallExpression" &&
        probeIdentifier(executable.callee) === importBinding("node:url", "fileURLToPath") &&
        Array.isArray(executable.arguments) &&
        executable.arguments.some(
          (value: unknown) =>
            member(value, "url") &&
            isRecord(value) &&
            isRecord(value.object) &&
            value.object.type === "MetaProperty" &&
            probeIdentifier(value.object.meta) === "import" &&
            probeIdentifier(value.object.property) === "meta",
        ),
    );
  });
  assert.ok(mainGuard, "the actual CLI guard must remain identifiable");
  assert.ok(
    isRecord(mainGuard.consequent) &&
      mainGuard.consequent.type === "BlockStatement" &&
      Array.isArray(mainGuard.consequent.body),
  );
  const mainStatements: unknown[] = mainGuard.consequent.body;
  const cliDeclarations = mainStatements
    .filter(isRecord)
    .filter(
      (node) =>
        node.type === "TryStatement" && isRecord(node.block) && Array.isArray(node.block.body),
    )
    .flatMap((node) => {
      assert.ok(isRecord(node.block) && Array.isArray(node.block.body));
      const statements: unknown[] = node.block.body;
      return statements
        .filter(isRecord)
        .filter(
          (statement) =>
            statement.type === "VariableDeclaration" && Array.isArray(statement.declarations),
        )
        .flatMap((statement) =>
          Array.isArray(statement.declarations) ? (statement.declarations as unknown[]) : [],
        );
    })
    .filter(
      (declaration) =>
        isRecord(declaration) &&
        isRecord(declaration.init) &&
        declaration.init.type === "AwaitExpression" &&
        isRecord(declaration.init.argument) &&
        declaration.init.argument.type === "CallExpression" &&
        probeIdentifier(declaration.init.argument.callee) === callerName,
    );
  assert.equal(cliDeclarations.length, 1, "the actual CLI must directly await the checked driver");
  const observeNodes = [...probeSyntaxNodes(observe.body)];
  assert.ok(
    observeNodes.some(
      (node) =>
        node.type === "AssignmentExpression" &&
        node.operator === "=" &&
        probeIdentifier(node.left) === clockVariable &&
        isRecord(node.right) &&
        node.right.type === "CallExpression" &&
        probeIdentifier(node.right.callee) === clock.name,
    ),
    "driver must supply the clock it actually freezes",
  );
  const writable = importBinding("node:stream", "Writable");
  assert.ok(
    observeNodes.some(
      (node) =>
        node.type === "AssignmentExpression" &&
        node.operator === "=" &&
        probeIdentifier(node.left) === streamVariable &&
        isRecord(node.right) &&
        node.right.type === "NewExpression" &&
        probeIdentifier(node.right.callee) === writable,
    ),
    "driver must drain its actual logger",
  );
  const saved = [...probeSyntaxNodes(caller.body)].find(
    (node) => node.type === "VariableDeclarator" && probeIdentifier(node.id) === saveVariable,
  );
  assert.ok(saved);
  const write = probeArrowValue(saved.init);
  assert.ok(isRecord(write) && write.type === "CallExpression" && Array.isArray(write.arguments));
  assert.equal(probeIdentifier(write.callee), importBinding("node:fs", "writeFileSync"));
  assert.equal(probeIdentifier(write.arguments[0]), reference);
  const stringify: unknown = write.arguments[1];
  assert.ok(
    isRecord(stringify) &&
      stringify.type === "CallExpression" &&
      Array.isArray(stringify.arguments),
  );
  assert.ok(isRecord(stringify.callee) && stringify.callee.type === "MemberExpression");
  assert.equal(probeIdentifier(stringify.callee.object), "JSON");
  assert.equal(probeIdentifier(stringify.callee.property), "stringify");
  assert.equal(probeIdentifier(stringify.arguments[0]), report);
  return { helper, call, awaited, args, finalizers: args[3], caller };
}

void test("the actual probe driver retains its evidence owner across naming, layout and declaration changes", async (t) => {
  const { fileURLToPath } = await import("node:url");
  const { isBuiltin } = await import("node:module");
  const { readFixtureModuleClosure } = await import("./fixtures/module-closure.mts");
  const root = mkdtempSync(path.join(os.tmpdir(), "probe-evidence-controls-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = readFileSync(new URL("./renovate-engine-probe.mts", import.meta.url), "utf8");
  const wiring = await inspectProbeEvidenceWiring(source);
  const range = probeSourceRange(wiring.helper.statement);
  const quoted = wiring.helper.specifier
    ? editProbeSource(source, [
        {
          ...probeSourceRange(wiring.helper.specifier.exported as Record<string, unknown>),
          text: '"retainProbeEvidence"',
        },
      ])
    : editProbeSource(source, [
        { start: range.start, end: probeSourceRange(wiring.helper.declaration).start, text: "" },
      ]) +
      `
export { ${wiring.helper.name} as "retainProbeEvidence" };
`;
  const variants = [
    ["quoted-api-export", quoted],
    [
      "unrelated-first-imports",
      `import { readFile as unusedProbeRead } from "node:fs";
import { PassThrough as UnusedProbePassThrough } from "node:stream";
` + source,
    ],
    [
      "declaration-order",
      editProbeSource(source, [{ ...range, text: "" }]) +
        "\n" +
        source.slice(range.start, range.end),
    ],
    [
      "private-names-layout",
      source
        .replace(/\brunEngineProbe\b/gu, "observedProbeOwner")
        .replace(/\breportPath\b/gu, "retainedEvidencePath")
        .replace(/\bfunction /gu, "function /* harmless layout */ "),
    ],
  ];
  const closure = readFixtureModuleClosure(
    fileURLToPath(new URL("../", import.meta.url)),
    ["scripts/renovate-engine-probe.mts"],
    { includeDynamicImports: false },
  );
  assert.deepEqual(
    closure.external.filter((name) => !isBuiltin(name)),
    [],
  );
  const loadVariant = async (name: string, candidate: string) => {
    const directory = path.join(root, name);
    mkdirSync(directory);
    for (const module of closure.modules) {
      const target = path.join(directory, module.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(
        target,
        module.path === "scripts/renovate-engine-probe.mts" ? candidate : module.bytes,
      );
    }
    const actual: unknown = await import(
      pathToFileURL(path.join(directory, "scripts/renovate-engine-probe.mts")).href
    );
    assert.ok(
      isRecord(actual) &&
        typeof actual.retainProbeEvidence === "function" &&
        typeof actual.freezeProbeClock === "function",
    );
    return {
      directory,
      retain: actual.retainProbeEvidence as typeof retainProbeEvidence,
      freeze: actual.freezeProbeClock as typeof freezeProbeClock,
    };
  };
  for (const [name, candidate] of variants) {
    assert.ok(name && candidate);
    await inspectProbeEvidenceWiring(candidate);
    const actual = await loadVariant(name, candidate);
    await assertProbeFailureRetention(actual.retain, actual.freeze, actual.directory);
    t.diagnostic(
      `${name}: real imported failure outcomes, clock restoration, evidence writes and stream drain pass`,
    );
  }
  const helperNodes = [...probeSyntaxNodes(wiring.helper.declaration.body)];
  const state = helperNodes.find(
    (node) =>
      node.type === "AssignmentExpression" &&
      isRecord(node.left) &&
      node.left.type === "MemberExpression" &&
      probeIdentifier(node.left.property) === "state" &&
      isRecord(node.right) &&
      node.right.value === "failed",
  );
  const clockCall = helperNodes.find(
    (node) =>
      node.type === "CallExpression" &&
      isRecord(node.callee) &&
      node.callee.type === "MemberExpression" &&
      probeIdentifier(node.callee.property) === "restoreClock",
  );
  const drain = helperNodes.find(
    (node) =>
      node.type === "AwaitExpression" &&
      isRecord(node.argument) &&
      node.argument.type === "NewExpression" &&
      probeIdentifier(node.argument.callee) === "Promise",
  );
  assert.ok(state && clockCall && drain);
  const behaviorNegatives = [
    ["lost-failure-state", state, /probe report state must retain failure/u],
    ["lost-clock-restore", clockCall, /probe finalizers must restore, save and finish in order/u],
    ["lost-logger-drain", drain, /probe finalizers must restore, save and finish in order/u],
  ] as const;
  for (const [name, removed, expected] of behaviorNegatives) {
    const candidate = editProbeSource(source, [
      { ...probeSourceRange(removed), text: "undefined" },
    ]);
    await inspectProbeEvidenceWiring(candidate);
    const actual = await loadVariant(name, candidate);
    await assert.rejects(
      assertProbeFailureRetention(actual.retain, actual.freeze, actual.directory),
      (error: unknown) => {
        assert.ok(error instanceof assert.AssertionError);
        assert.match(error.message, expected);
        t.diagnostic(
          `${name}: retained behavioral oracle refuses: ${error.message.slice(0, 2048)}`,
        );
        return true;
      },
    );
  }
  const save = probeProperty(wiring.finalizers, "save");
  assert.ok(isRecord(save));
  const getter = probeArrowValue(probeProperty(wiring.finalizers, "loggerStream"));
  assert.ok(isRecord(getter));
  const reportArgument = wiring.args[0];
  assert.ok(isRecord(reportArgument));
  const referenceArgument = wiring.args[1];
  assert.ok(isRecord(referenceArgument));
  const callerRange = probeSourceRange(wiring.caller);
  assert.ok(isRecord(wiring.caller.id));
  const callerId = probeSourceRange(wiring.caller.id);
  const decoy =
    source.slice(callerRange.start, callerId.start) +
    "unusedProbeEvidenceOwner" +
    source.slice(callerId.end, callerRange.end);
  const bypassWithDecoy =
    editProbeSource(source, [{ ...probeSourceRange(wiring.awaited), text: "undefined" }]) +
    "\n" +
    decoy;
  await assert.rejects(
    inspectProbeEvidenceWiring(bypassWithDecoy),
    { code: "ERR_ASSERTION" },
    "unused owner cannot replace actual CLI observation",
  );
  t.diagnostic("bypass-plus-unused-decoy: actual CLI binding refuses");
  const negatives = [
    [
      "unused-nested-observation",
      {
        ...probeSourceRange(wiring.awaited),
        text: `(async () => { ${source.slice(probeSourceRange(wiring.awaited).start, probeSourceRange(wiring.awaited).end)}; })`,
      },
    ],
    [
      "wrong-evidence-path",
      { ...probeSourceRange(referenceArgument), text: '"unowned-report.json"' },
    ],
    [
      "removed-await",
      {
        start: probeSourceRange(wiring.awaited).start,
        end: probeSourceRange(wiring.call).start,
        text: "",
      },
    ],
    [
      "wrong-report",
      {
        ...probeSourceRange(reportArgument),
        text: '{ state: "running" }',
      },
    ],
    ["omitted-save", { ...probeSourceRange(save), text: "() => {}" }],
    ["wrong-logger", { ...probeSourceRange(getter), text: "undefined" }],
  ] as const;
  for (const [name, change] of negatives) {
    await assert.rejects(
      inspectProbeEvidenceWiring(editProbeSource(source, [change])),
      { code: "ERR_ASSERTION" },
      name,
    );
    t.diagnostic(`${name}: actual driver wiring refuses`);
  }
});

import { pathToFileURL } from "node:url";

// Inert modules model the pinned engine's consumed export shapes, not Renovate
// extraction/rule correctness. Real deployed-engine qualification stays separate.
void test("Vite+ probe loads file-URL engine classes and retains source-bound local reports", async (t) => {
  for (const malformed of [false, true]) {
    const root = mkdtempSync(path.join(os.tmpdir(), "viteplus-engine-interop-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const engine = path.join(root, "engine"),
      repo = path.join(root, "repo"),
      output = path.join(root, "output");
    const write = (file: string, bytes: string) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    };
    const module = (file: string, bytes: string) => write(path.join(engine, "dist", file), bytes);
    write(path.join(engine, "package.json"), '{"version":"44.156.3","type":"module"}');
    module("logger/index.js", "export function init() {}");
    module(
      "config/global.js",
      `export class GlobalConfig {
      static value; static set(value) { if(this !== GlobalConfig) throw Error('lost receiver'); this.value=value; }
      static get() { return this.value; }
    }`,
    );
    module(
      "config/presets/index.js",
      "export async function resolveConfigPresets(config) { return {config,visitedPresets:{fixture:true}}; }",
    );
    const names = [
      "vite-plus",
      "@voidzero-dev/vite-plus-core",
      "vitest",
      "@vitest/browser-playwright",
      "playwright",
    ];
    module(
      "modules/manager/npm/extract/index.js",
      `export async function extractAllPackageFiles() { return [{packageFile:'package.json',deps:${JSON.stringify([...names.map((depName) => ({ depName, currentValue: malformed ? 42 : "1.2.0", fixtureRetained: "passed back" })), { depName: "unrelated", currentValue: null, skipReason: "unknown-version" }])}}]; }`,
    );
    const digest = `sha256:${"a".repeat(64)}`;
    module(
      "modules/manager/dockerfile/extract.js",
      `export function extractPackageFile(_text,file) { if(file.endsWith("build/Dockerfile")) return {deps:[{depName:"ghcr.io/voidzero-dev/vite-plus",currentValue:"1.2.0",currentDigest:"${digest}"},{depName:"rust",currentValue:"1.90.0-slim-bookworm",currentDigest:"${digest}"},{depName:"ubuntu",currentValue:"22.04",currentDigest:"${digest}"}]}; return {deps:[{depName:'ghcr.io/voidzero-dev/vite-plus',currentValue:'1.2.0',currentDigest:'${digest}'}]}; }`,
    );
    module(
      "util/package-rules/index.js",
      `export async function applyPackageRules(config) {
      if(config.manager === 'npm' && config.fixtureRetained !== 'passed back') throw Error('lost engine fields');
      const force=config.packageRules.at(-1)?.force;
      if(force) return force;
      const bundled=['@voidzero-dev/vite-plus-core','vitest','@vitest/browser-playwright'].includes(config.packageName);
      const vite=['vite-plus','ghcr.io/voidzero-dev/vite-plus'].includes(config.packageName);
      return {minimumReleaseAge:'1 day',minimumReleaseAgeBehaviour:'timestamp-required',internalChecksFilter:'strict',automerge:false,enabled:!bundled,groupName:vite?'vite-plus':config.packageName==='rust'?'rust-toolchain':null,schedule:['at any time'],pinDigests:true};
    }`,
    );
    module(
      "modules/manager/custom/regex/index.js",
      "export function extractPackageFile() { return {deps:[{depName:'PowerShell/PowerShell',currentValue:'7.5.0'}]}; }",
    );
    write(
      path.join(repo, "tools/containers/build/Dockerfile"),
      `ARG POWERSHELL_VERSION=7.5.0\nARG POWERSHELL_SHA256=${"b".repeat(64)}\n`,
    );
    write(path.join(repo, "rust-toolchain.toml"), 'channel = "1.90.0"\n');
    module("workers/repository/init/vulnerability.js", "// inert source-custody fixture\n");
    module("config/utils.js", "// inert source-custody fixture\n");
    write(
      path.join(repo, "renovate.json"),
      JSON.stringify({
        packageRules: [],
        customManagers: [{ depNameTemplate: "PowerShell/PowerShell" }],
        vulnerabilityAlerts: {
          enabled: true,
          minimumReleaseAge: null,
          automerge: false,
          groupName: null,
        },
      }),
    );
    for (const file of [
      "package.json",
      "apps/desktop/package.json",
      "pnpm-workspace.yaml",
      "tools/containers/browser/Dockerfile",
    ])
      write(path.join(repo, file), "fixture bytes");
    if (malformed) {
      await assert.rejects(
        probeVitePlusRules(engine, repo, output),
        /Expected engine dependency currentValue text/u,
      );
      assert.equal(existsSync(path.join(output, "report.json")), false);
    } else {
      const report = await probeVitePlusRules(engine, repo, output);
      assert.equal(report.effective.length, 10);
      assert.equal(report.hostedObservation, false);
      assert.equal(
        readFileSync(path.join(output, "report.json"), "utf8"),
        JSON.stringify(report, null, 2) + "\n",
      );
      assert.equal(Object.keys(report.engineSources).length, 6);
      assert.equal(Object.keys(report.declarationSha256).length, 6);
      assert.ok(Object.values(report.engineSources).every((hash) => /^[a-f0-9]{64}$/u.test(hash)));
    }
  }
});

void test("pinned engine class export retains static configuration method receivers", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "renovate-global-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modulePath = path.join(root, "global.mjs");
  writeFileSync(
    modulePath,
    `export class GlobalConfig {
    static config = {};
    static set(config) { if (this !== GlobalConfig) throw new Error("lost static receiver"); this.config = config; }
    static get() { if (this !== GlobalConfig) throw new Error("lost static receiver"); return this.config; }
  }`,
  );
  const loaded: unknown = await import(pathToFileURL(modulePath).href);
  assert.ok(isRecord(loaded));
  assert.equal(typeof loaded.GlobalConfig, "function");
  const config = validateGlobalConfig(loaded.GlobalConfig);
  config.set({ localDir: "owned-workspace", allowScripts: false });
  assert.deepEqual(config.get(), { localDir: "owned-workspace", allowScripts: false });
  config.set({ localDir: "owned-maintenance" });
  assert.deepEqual(config.get(), { localDir: "owned-maintenance" });
  for (const invalid of [null, {}, { set: () => {}, get: "not callable" }])
    assert.throws(() => validateGlobalConfig(invalid), /export required|callable/);
});
