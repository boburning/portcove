import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { isRecord } from "./runtime-values.mts";
import { OwnedNativeSession } from "../apps/desktop/scripts/desktop-owned-native-session.mts";
import type {
  NativeProcessSnapshot,
  NativeQualificationInventoryOptions,
} from "../apps/desktop/scripts/desktop-owned-native-session.mts";

function nativeQualificationSnapshot(
  processes?: NativeProcessSnapshot["processes"],
): NativeProcessSnapshot {
  const application = { pid: 10, path: "/owned/app.exe", started_filetime: "100" };
  const driver = { pid: 20, path: "/owned/driver.exe", started_filetime: "200" };
  const webview = { pid: 30, path: "/owned/msedgewebview2.exe", started_filetime: "300" };
  return {
    captured_at: "2026-10-28T00:00:00Z",
    driver,
    application_pid: application.pid,
    processes: processes ?? [application, driver, webview],
  };
}

function nativeQualificationOptions(
  overrides: Partial<NativeQualificationInventoryOptions> = {},
): NativeQualificationInventoryOptions {
  return {
    savedLibraryRecoverySession: false,
    checks: [],
    application: "/owned/app.exe",
    nativeDriverPath: "/owned/driver.exe",
    acquisitionJourney: false,
    acquisitionLaunchSessions: () => assert.fail("Nonacquisition must not observe launch sessions"),
    ...overrides,
  };
}

void test("qualified reviews and a running setup restart reject missing or foreign native identities", () => {
  // Retain the original nine-scenario oracle, now against the imported owner.
  for (const { scenario, outcome = "passed", requireQualified = false } of [
    { scenario: "native-host-publication-recovery" },
    { scenario: "native-real-prepared-runtime" },
    { scenario: "native-reviewed-backup-restore-and-delete" },
    { scenario: "native-reviewed-source-reference-removal" },
    { scenario: "native-reviewed-steam-batch-add" },
    { scenario: "native-preliminary-source-review" },
    { scenario: "native-late-listener-disposal" },
    { scenario: "native-rejected-listener-registration" },
    { scenario: "native-selected-setup-completion", outcome: "running", requireQualified: true },
  ]) {
    const session = new OwnedNativeSession();
    const validate = (captured: NativeProcessSnapshot, qualified = false) =>
      session.validateQualificationInventory(
        captured,
        nativeQualificationOptions({
          requireQualified: qualified,
          checks: [{ scenario, outcome }],
        }),
      );
    const captured = nativeQualificationSnapshot();
    const entries = captured.processes;
    const application = entries[0],
      driver = entries[1],
      webview = entries[2];
    assert.ok(application && driver && webview);
    validate(captured, requireQualified);
    for (let missing = 0; missing < entries.length; missing++) {
      assert.throws(() =>
        validate(
          nativeQualificationSnapshot(entries.filter((_, i) => i !== missing)),
          requireQualified,
        ),
      );
    }
    assert.throws(() =>
      validate(
        nativeQualificationSnapshot([
          { ...application, path: "/foreign/app.exe" },
          ...entries.slice(1),
        ]),
        requireQualified,
      ),
    );
    if (
      scenario === "native-reviewed-source-reference-removal" ||
      scenario === "native-reviewed-steam-batch-add"
    ) {
      assert.throws(() =>
        validate(
          nativeQualificationSnapshot([
            application,
            { ...driver, path: "/foreign/driver.exe" },
            webview,
          ]),
        ),
      );
      assert.throws(() => validate(nativeQualificationSnapshot([...entries, application])));
      assert.throws(() => validate(nativeQualificationSnapshot([...entries, driver])));
    }
  }
});

void test("qualified native inventory retains every marker and leaves nonqualifying observations inert", () => {
  // Independent before-source oracle: do not import the production marker list.
  const scenarios = [
    "native-real-prepared-runtime",
    "native-reviewed-backup-restore-and-delete",
    "native-reviewed-source-reference-removal",
    "native-reviewed-steam-batch-add",
    "native-host-publication-recovery",
    "native-game-update-review",
    "native-update-acquisition-lifecycle",
    "native-selected-setup-completion",
    "native-preliminary-source-review",
    "native-retained-contract-repair-state",
    "native-backup-delete-focus",
    "native-host-interrupted-preparation",
    "native-closed-preparation-recovery",
    "native-minimized-preparation-continuity",
    "native-normal-package-webview-boundary",
    "native-startup-library-recovery",
    "native-library-switch-recovery",
    "native-late-listener-disposal",
    "native-rejected-listener-registration",
  ];
  const session = new OwnedNativeSession();
  const absent = nativeQualificationSnapshot([]);
  for (const scenario of scenarios) {
    const options = nativeQualificationOptions({ checks: [{ scenario, outcome: "passed" }] });
    assert.doesNotThrow(() =>
      session.validateQualificationInventory(nativeQualificationSnapshot(), options),
    );
    assert.throws(
      () => session.validateQualificationInventory(absent, options),
      /one captured application/,
    );
    for (const outcome of ["failed", "running", "not-run"])
      assert.doesNotThrow(() =>
        session.validateQualificationInventory(
          absent,
          nativeQualificationOptions({ acquisitionJourney: true, checks: [{ scenario, outcome }] }),
        ),
      );
  }
  assert.doesNotThrow(() =>
    session.validateQualificationInventory(
      absent,
      nativeQualificationOptions({ checks: [{ scenario: "empty-library", outcome: "passed" }] }),
    ),
  );
  for (const flags of [{ requireQualified: true }, { savedLibraryRecoverySession: true }])
    assert.throws(
      () => session.validateQualificationInventory(absent, nativeQualificationOptions(flags)),
      /one captured application/,
    );
  const captured = nativeQualificationSnapshot();
  const webview = captured.processes[2];
  assert.ok(webview);
  // Existing nonacquisition semantics require presence, not uniqueness, of WebViews.
  assert.doesNotThrow(() =>
    session.validateQualificationInventory(
      nativeQualificationSnapshot([...captured.processes, { ...webview, pid: 31 }]),
      nativeQualificationOptions({ requireQualified: true }),
    ),
  );
  // Preserve its literal path.resolve comparison rather than extended-prefix normalization.
  assert.throws(
    () =>
      session.validateQualificationInventory(
        captured,
        nativeQualificationOptions({
          requireQualified: true,
          application: "\\\\?\\/owned/app.exe",
        }),
      ),
    /one captured application/,
  );
});

void test("qualified acquisition inventory requires the connected owner before lazy session observations", () => {
  const session = new OwnedNativeSession();
  const captured = nativeQualificationSnapshot();
  session.driver = captured.driver;
  session.bindApplication(captured, "/owned/app.exe");
  const calls: string[] = [];
  const requireApplication = session.requireApplication.bind(session);
  session.requireApplication = (value) => {
    calls.push("connected");
    return requireApplication(value);
  };
  const options = nativeQualificationOptions({
    requireQualified: true,
    acquisitionJourney: true,
    acquisitionLaunchSessions: () => {
      calls.push("sessions");
      return [];
    },
  });
  session.validateQualificationInventory(captured, options);
  assert.deepEqual(calls, ["connected", "sessions"]);
  calls.length = 0;
  const changed = { ...captured, driver: { ...captured.driver, started_filetime: "foreign" } };
  assert.throws(
    () => session.validateQualificationInventory(changed, options),
    /driver identity changed/,
  );
  assert.deepEqual(calls, ["connected"]);
  calls.length = 0;
  session.validateQualificationInventory(nativeQualificationSnapshot([]), {
    ...options,
    requireQualified: false,
  });
  assert.deepEqual(calls, []);
  for (const failure of [
    new Error("owned session observation failed"),
    undefined,
    null,
    false,
    0,
    "",
  ]) {
    assert.throws(
      () =>
        session.validateQualificationInventory(captured, {
          ...options,
          acquisitionLaunchSessions: () => {
            throw ({ cause: failure } as { cause: unknown }).cause;
          },
        }),
      (error: unknown) => error === failure,
    );
  }
});

function* inventorySyntaxNodes(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) yield* inventorySyntaxNodes(item);
  } else if (isRecord(value)) {
    if (typeof value.type === "string") yield value;
    for (const [key, child] of Object.entries(value))
      if (key !== "loc") yield* inventorySyntaxNodes(child);
  }
}
function inventorySyntaxName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "Identifier" && typeof value.name === "string") return value.name;
  return typeof value.value === "string" ? value.value : undefined;
}
function inventorySyntaxSpan(value: unknown) {
  assert.ok(isRecord(value) && typeof value.start === "number" && typeof value.end === "number");
  return { start: value.start, end: value.end };
}
async function inspectInventoryCaller(source: string) {
  const { parseAst } = await import("vite-plus");
  const tree: unknown = parseAst(stripTypeScriptTypes(source, { mode: "strip" }));
  assert.ok(isRecord(tree) && Array.isArray(tree.body));
  const nodes = [...inventorySyntaxNodes(tree)];
  const imports = (from: string, name: string) => {
    const result: { local: string; source: unknown }[] = [];
    for (const declaration of nodes) {
      if (
        declaration.type !== "ImportDeclaration" ||
        inventorySyntaxName(declaration.source) !== from
      )
        continue;
      assert.ok(Array.isArray(declaration.specifiers));
      const specifiers: unknown[] = declaration.specifiers;
      for (const value of specifiers) {
        if (!isRecord(value) || inventorySyntaxName(value.imported) !== name) continue;
        const local = inventorySyntaxName(value.local);
        assert.ok(local);
        result.push({ local, source: declaration.source });
      }
    }
    assert.ok(result.length > 0, `Required imported owner: ${from}/${name}`);
    return result;
  };
  const identifierName = (value: unknown) =>
    isRecord(value) && value.type === "Identifier" ? inventorySyntaxName(value) : undefined;
  const locals = (bindings: { local: string }[]) =>
    new Set(bindings.map((binding) => binding.local));
  const isCall = (node: Record<string, unknown>, names: ReadonlySet<string>) =>
    node.type === "CallExpression" && names.has(identifierName(node.callee) ?? "");
  const statements: unknown[] = tree.body;
  const declarations = statements
    .filter(isRecord)
    .filter((node) => node.type === "VariableDeclaration")
    .flatMap((node) => {
      assert.ok(Array.isArray(node.declarations));
      return node.declarations as unknown[];
    })
    .filter(isRecord);
  const named = new Map(
    declarations.flatMap((node) => {
      const name = inventorySyntaxName(node.id);
      return name ? [[name, node] as const] : [];
    }),
  );
  const globalName = (value: unknown) => {
    let name = identifierName(value);
    const seen = new Set<string>();
    while (name && !seen.has(name)) {
      seen.add(name);
      const init = named.get(name)?.init;
      if (!isRecord(init) || init.type !== "Identifier") return name;
      name = inventorySyntaxName(init);
    }
    return undefined;
  };
  const globalInit = (value: unknown) => named.get(globalName(value) ?? "")?.init;
  const property = (value: unknown, key: string) => {
    assert.ok(isRecord(value) && Array.isArray(value.properties));
    const entries: unknown[] = value.properties;
    const found = entries.find((part) => isRecord(part) && inventorySyntaxName(part.key) === key);
    assert.ok(isRecord(found), `Required inventory property: ${key}`);
    return found;
  };
  const ownerBindings = imports("./desktop-owned-native-session.mts", "OwnedNativeSession");
  const ownerNames = locals(ownerBindings);
  const instances = declarations.filter(
    (node) =>
      isRecord(node.init) &&
      node.init.type === "NewExpression" &&
      ownerNames.has(inventorySyntaxName(node.init.callee) ?? ""),
  );
  assert.equal(instances.length, 1, "The actual session owner must be unique");
  const instance = instances[0];
  assert.ok(instance && isRecord(instance.init));
  const receiver = inventorySyntaxName(instance.id);
  const initialization = instance.init;
  const owner = ownerBindings.find(
    (binding) => binding.local === identifierName(initialization.callee),
  );
  assert.ok(receiver && owner);
  const calls = nodes.filter(
    (node) =>
      node.type === "CallExpression" &&
      isRecord(node.callee) &&
      node.callee.type === "MemberExpression" &&
      inventorySyntaxName(node.callee.object) === receiver &&
      inventorySyntaxName(node.callee.property) === "validateQualificationInventory",
  );
  assert.equal(calls.length, 1, "The actual session receiver must consume qualification inventory");
  const call = calls[0];
  assert.ok(call && isRecord(call.callee) && Array.isArray(call.arguments));
  const wrapper = nodes.find(
    (node) => node.type === "FunctionDeclaration" && [...inventorySyntaxNodes(node)].includes(call),
  );
  assert.ok(wrapper && isRecord(wrapper.body) && Array.isArray(wrapper.body.body));
  const wrapperName = inventorySyntaxName(wrapper.id);
  assert.ok(wrapperName);
  assert.equal(wrapper.body.body.length, 1, "The actual caller must unconditionally delegate");
  const statement: unknown = wrapper.body.body[0];
  assert.ok(isRecord(statement));
  assert.equal(
    statement.expression ?? statement.argument,
    call,
    "The actual caller must delegate directly",
  );
  assert.ok(Array.isArray(wrapper.params) && wrapper.params.length === 3);
  const parameters: unknown[] = wrapper.params;
  const [captured, required, deadline] = parameters;
  assert.ok(
    isRecord(required) &&
      required.type === "AssignmentPattern" &&
      isRecord(required.right) &&
      required.right.value === false,
  );
  assert.ok(
    isRecord(deadline) &&
      deadline.type === "AssignmentPattern" &&
      isRecord(deadline.right) &&
      deadline.right.type === "BinaryExpression" &&
      deadline.right.operator === "+" &&
      isRecord(deadline.right.right) &&
      deadline.right.right.value === 10000 &&
      isRecord(deadline.right.left) &&
      deadline.right.left.type === "CallExpression" &&
      isRecord(deadline.right.left.callee) &&
      inventorySyntaxName(deadline.right.left.callee.object) === "performance" &&
      inventorySyntaxName(deadline.right.left.callee.property) === "now",
    "The caller must retain its monotonic ten-second default",
  );
  assert.equal(identifierName(call.arguments[0]), identifierName(captured));
  const options: unknown = call.arguments[1];
  assert.ok(
    isRecord(options) && options.type === "ObjectExpression" && Array.isArray(options.properties),
  );
  const rawProperties: unknown[] = options.properties;
  const properties = new Map(
    rawProperties.map((value) => {
      assert.ok(isRecord(value) && value.type === "Property");
      return [inventorySyntaxName(value.key), value] as const;
    }),
  );
  assert.equal(
    properties.size,
    rawProperties.length,
    "Caller options must not override one another",
  );
  const input = (name: string) => {
    const found = properties.get(name);
    assert.ok(found, `Caller must retain ${name} input`);
    return found.value;
  };
  assert.equal(identifierName(input("requireQualified")), identifierName(required.left));

  // Resolve real CLI and selected-plan declarations, including private aliases.
  const planModule = "../../../scripts/desktop-execution-plan.mts";
  const optionReaders = locals(imports(planModule, "parseDesktopHarnessOptions"));
  const parsed = declarations.find(
    (node) => isRecord(node.init) && isCall(node.init, optionReaders),
  );
  assert.ok(parsed && isRecord(parsed.id));
  const values = inventorySyntaxName(property(parsed.id, "values").value);
  assert.ok(values);
  for (const [name, option] of [
    ["application", "app"],
    ["nativeDriverPath", "native-driver"],
  ] as const) {
    const init = globalInit(input(name));
    assert.ok(isRecord(init) && init.type === "CallExpression" && Array.isArray(init.arguments));
    const argument: unknown = init.arguments[0];
    assert.ok(
      isRecord(argument) &&
        argument.type === "MemberExpression" &&
        identifierName(argument.object) === values &&
        inventorySyntaxName(argument.property) === option,
      `Caller must use the actual CLI ${option} input`,
    );
  }
  const planFactories = locals(imports(planModule, "planDesktopExecution"));
  const planned = declarations.find(
    (node) => isRecord(node.init) && isCall(node.init, planFactories),
  );
  const planName = inventorySyntaxName(planned?.id);
  assert.ok(planName);
  const sessions = declarations.find(
    (node) =>
      isRecord(node.id) &&
      node.id.type === "ObjectPattern" &&
      isRecord(node.init) &&
      node.init.type === "MemberExpression" &&
      inventorySyntaxName(node.init.object) === planName &&
      inventorySyntaxName(node.init.property) === "session",
  );
  assert.ok(sessions && isRecord(sessions.id));
  const savedOrigins = [
    "bootstrapRecoverySession",
    "librarySwitchRecoverySession",
    "preferencesRecoverySession",
  ].map((name) => inventorySyntaxName(property(sessions.id, name).value));
  const savedLeaves = (value: unknown): (string | undefined)[] => {
    if (isRecord(value) && value.type === "LogicalExpression" && value.operator === "||")
      return [...savedLeaves(value.left), ...savedLeaves(value.right)];
    return [globalName(value)];
  };
  assert.deepEqual(
    new Set(savedLeaves(globalInit(input("savedLibraryRecoverySession")))),
    new Set(savedOrigins),
    "Caller must retain the actual selected saved-recovery flags",
  );
  const acquisition = input("acquisitionJourney");
  assert.ok(
    isRecord(acquisition) &&
      acquisition.type === "MemberExpression" &&
      inventorySyntaxName(acquisition.property) === "acquisitionJourney" &&
      isRecord(acquisition.object) &&
      inventorySyntaxName(acquisition.object.property) === "fixtures" &&
      inventorySyntaxName(acquisition.object.object) === planName,
    "Caller must retain the selected acquisition branch",
  );

  // The same live snapshot producer must call this wrapper and record failures
  // through the actual checks array, rather than an unused lookalike wrapper.
  const snapshotFunctions = nodes.filter(
    (node) =>
      node.type === "FunctionDeclaration" &&
      [...inventorySyntaxNodes(node.body)].some(
        (part) => part.value === "native-backup-process-inventory",
      ) &&
      [...inventorySyntaxNodes(node.body)].some(
        (part) =>
          part.type === "CallExpression" &&
          Array.isArray(part.arguments) &&
          inventorySyntaxName(part.arguments[0]) === "SnapshotDriverTree",
      ),
  );
  assert.equal(snapshotFunctions.length, 1, "The actual native snapshot producer must be unique");
  const producer = snapshotFunctions[0];
  assert.ok(producer && isRecord(producer.body) && Array.isArray(producer.body.body));
  const producerNodes = [...inventorySyntaxNodes(producer.body)];
  const snapshot = producerNodes.find(
    (node) =>
      node.type === "VariableDeclarator" &&
      isRecord(node.init) &&
      node.init.type === "CallExpression" &&
      Array.isArray(node.init.arguments) &&
      inventorySyntaxName(node.init.arguments[0]) === "SnapshotDriverTree",
  );
  assert.ok(snapshot);
  const invoked = producerNodes.find(
    (node) =>
      node.type === "CallExpression" &&
      inventorySyntaxName(node.callee) === wrapperName &&
      Array.isArray(node.arguments) &&
      inventorySyntaxName(node.arguments[0]) === inventorySyntaxName(snapshot.id),
  );
  const producerStatements: unknown[] = producer.body.body;
  assert.ok(
    invoked &&
      producerStatements.some(
        (node) =>
          isRecord(node) &&
          node.type === "TryStatement" &&
          isRecord(node.block) &&
          Array.isArray(node.block.body) &&
          node.block.body.some(
            (part: unknown) =>
              isRecord(part) && part.type === "ExpressionStatement" && part.expression === invoked,
          ),
      ),
    "The real native snapshot producer must invoke the delegated wrapper",
  );
  const producerName = inventorySyntaxName(producer.id);
  const producerSpan = inventorySyntaxSpan(producer);
  assert.ok(
    nodes.some(
      (node) =>
        node.type === "CallExpression" &&
        inventorySyntaxName(node.callee) === producerName &&
        (inventorySyntaxSpan(node).start < producerSpan.start ||
          inventorySyntaxSpan(node).start >= producerSpan.end),
    ),
    "The real native snapshot producer must remain consumed",
  );
  const failureRecord = producerNodes.find(
    (node) =>
      node.type === "CallExpression" &&
      Array.isArray(node.arguments) &&
      isRecord(node.arguments[0]) &&
      node.arguments[0].type === "ObjectExpression" &&
      [...inventorySyntaxNodes(node.arguments[0])].some(
        (part) => part.value === "native-backup-process-inventory",
      ),
  );
  assert.ok(failureRecord);
  const recorder = nodes.find(
    (node) =>
      node.type === "FunctionDeclaration" &&
      inventorySyntaxName(node.id) === inventorySyntaxName(failureRecord.callee),
  );
  assert.ok(recorder);
  const recordNames = locals(imports("./desktop-scenario-outcomes.mts", "recordDesktopCheck"));
  const records = [...inventorySyntaxNodes(recorder.body)].find((node) =>
    isCall(node, recordNames),
  );
  assert.ok(records && Array.isArray(records.arguments));
  const checksName = globalName(records.arguments[0]);
  const checksInitializer = checksName ? named.get(checksName)?.init : undefined;
  assert.ok(
    checksName &&
      globalName(input("checks")) === checksName &&
      isRecord(checksInitializer) &&
      checksInitializer.type === "ArrayExpression",
    "Caller must retain the actual recorded checks array",
  );
  const otherChecks = nodes.find(
    (node) =>
      isCall(node, recordNames) &&
      Array.isArray(node.arguments) &&
      globalName(node.arguments[0]) !== undefined &&
      globalName(node.arguments[0]) !== checksName,
  );
  assert.ok(otherChecks && Array.isArray(otherChecks.arguments));
  const otherChecksName = globalName(otherChecks.arguments[0]);
  assert.ok(otherChecksName);

  const databases = locals(imports("node:sqlite", "DatabaseSync"));
  const commands = locals(imports("./desktop-scenario-state.mts", "ownedFixtureCommand"));
  const providers = nodes.filter(
    (node) =>
      node.type === "FunctionDeclaration" &&
      [...inventorySyntaxNodes(node.body)].some(
        (part) =>
          part.type === "NewExpression" && databases.has(inventorySyntaxName(part.callee) ?? ""),
      ) &&
      [...inventorySyntaxNodes(node.body)].some((part) => isCall(part, commands)),
  );
  assert.equal(
    providers.length,
    1,
    "The actual acquisition observation provider must remain bound",
  );
  const provider = providers[0];
  assert.ok(provider);
  const lazy = input("acquisitionLaunchSessions");
  assert.ok(
    isRecord(lazy) &&
      lazy.type === "ArrowFunctionExpression" &&
      Array.isArray(lazy.params) &&
      lazy.params.length === 0 &&
      isRecord(lazy.body) &&
      lazy.body.type === "CallExpression" &&
      inventorySyntaxName(lazy.body.callee) === inventorySyntaxName(provider.id) &&
      Array.isArray(lazy.body.arguments) &&
      lazy.body.arguments.length === 1 &&
      inventorySyntaxName(lazy.body.arguments[0]) === inventorySyntaxName(deadline.left),
    "The owned acquisition provider must remain lazy and use the caller deadline",
  );
  return {
    receiver,
    wrapper,
    call,
    ownerSource: owner.source,
    lazy,
    required,
    deadline,
    acquisition,
    saved: properties.get("savedLibraryRecoverySession"),
    receiverNode: call.callee.object,
    inputProperties: properties,
    applicationName: globalName(input("application")),
    nativeDriverName: globalName(input("nativeDriverPath")),
    requiredName: inventorySyntaxName(required.left),
    otherChecksName,
  };
}
function editInventorySource(source: string, node: unknown, replacement: string) {
  const { start, end } = inventorySyntaxSpan(node);
  return source.slice(0, start) + replacement + source.slice(end);
}

void test(
  "actual inventory caller tolerates private names and declaration layout but rejects missing ownership inputs",
  { timeout: 60_000 },
  async (t) => {
    const source = await readFile(
      new URL("../apps/desktop/scripts/desktop-test.mts", import.meta.url),
      "utf8",
    );
    const actual = await inspectInventoryCaller(source);
    const wrapper = inventorySyntaxSpan(actual.wrapper);
    const moved =
      source.slice(0, wrapper.start) +
      source.slice(wrapper.end) +
      "\n" +
      source.slice(wrapper.start, wrapper.end);
    const reorderedImports = [
      'import { nativeSessionScript as $unrelatedNativeScript } from "./desktop-owned-native-session.mts";',
      'import { constants as $unrelatedSqliteConstants } from "node:sqlite";',
      'import { fixtureObject as $unrelatedFixtureObject } from "./desktop-scenario-state.mts";',
      'import { nativeTransportReceiptSources as $unrelatedReceiptSources } from "../../../scripts/desktop-execution-plan.mts";',
      'import { observeDesktopScenario as $unrelatedScenarioObserver } from "./desktop-scenario-outcomes.mts";',
      "void [$unrelatedNativeScript, $unrelatedSqliteConstants, $unrelatedFixtureObject, $unrelatedReceiptSources, $unrelatedScenarioObserver];",
      source,
    ].join("\n");
    for (const [name, text] of [
      ["original", source],
      ["same-module-import-order", reorderedImports],
      [
        "private-instance-name",
        source.replace(new RegExp(`\\b${actual.receiver}\\b`, "gu"), "$nativeInventoryOwner"),
      ],
      ["declaration-order", moved],
      [
        "formatting",
        editInventorySource(
          source,
          actual.call,
          `/* inventory delegation */\n${source.slice(inventorySyntaxSpan(actual.call).start, inventorySyntaxSpan(actual.call).end)}`,
        ),
      ],
    ] as const) {
      await inspectInventoryCaller(text);
      t.diagnostic(
        JSON.stringify({ name, outcome: "passed", oracle: "actual inventory caller wiring" }),
      );
    }
    const wrapperId = inventorySyntaxSpan(actual.wrapper.id);
    const wrapperBody = isRecord(actual.wrapper.body) ? actual.wrapper.body : undefined;
    assert.ok(wrapperBody);
    const originalWrapper = source.slice(wrapper.start, wrapper.end);
    const decoy =
      originalWrapper.slice(0, wrapperId.start - wrapper.start) +
      "$unusedInventoryWrapper" +
      originalWrapper.slice(wrapperId.end - wrapper.start);
    const bypassed = editInventorySource(source, wrapperBody, "{}") + "\n" + decoy;
    await assert.rejects(inspectInventoryCaller(bypassed), { code: "ERR_ASSERTION" });
    t.diagnostic(
      JSON.stringify({
        name: "bypassed-caller-with-unused-wrapper",
        outcome: "rejected",
        oracle: "actual inventory caller wiring",
      }),
    );
    const controls = [
      [
        "wrong-saved-binding",
        actual.inputProperties.get("savedLibraryRecoverySession"),
        `savedLibraryRecoverySession: ${actual.requiredName}`,
      ],
      [
        "wrong-checks-binding",
        actual.inputProperties.get("checks"),
        `checks: ${actual.otherChecksName}`,
      ],
      [
        "swapped-application-binding",
        actual.inputProperties.get("application"),
        `application: ${actual.nativeDriverName}`,
      ],
      [
        "swapped-driver-binding",
        actual.inputProperties.get("nativeDriverPath"),
        `nativeDriverPath: ${actual.applicationName}`,
      ],
      ["removed-caller", actual.call, "undefined"],
      ["wrong-receiver", actual.receiverNode, "$foreignSession"],
      ["wrong-imported-owner", actual.ownerSource, '"./foreign-session.mts"'],
      ["dropped-saved-recovery", actual.saved, "savedLibraryRecoverySession: false"],
      ["dropped-acquisition", actual.acquisition, "false"],
      ["replaced-provider", actual.lazy, "() => []"],
      ["eager-provider", actual.lazy, "acquisitionLaunchSessions(0)"],
      ["changed-deadline", isRecord(actual.deadline) ? actual.deadline.right : undefined, "0"],
    ] as const;
    for (const [name, node, replacement] of controls) {
      await assert.rejects(inspectInventoryCaller(editInventorySource(source, node, replacement)), {
        code: "ERR_ASSERTION",
      });
      t.diagnostic(
        JSON.stringify({ name, outcome: "rejected", oracle: "actual inventory caller wiring" }),
      );
    }
  },
);

function assertNativeInventoryIdentityOracle(
  validate: (captured: NativeProcessSnapshot, options: NativeQualificationInventoryOptions) => void,
) {
  const options = nativeQualificationOptions({ requireQualified: true });
  const captured = nativeQualificationSnapshot();
  validate(captured, options);
  for (const [index, name] of [
    [0, "application"],
    [1, "driver"],
    [2, "WebView"],
  ] as const)
    assert.throws(
      () =>
        validate(
          nativeQualificationSnapshot(
            captured.processes.filter((_, position) => position !== index),
          ),
          options,
        ),
      { code: "ERR_ASSERTION" },
      `native inventory behavior rejects missing ${name}`,
    );
}

void test("actual inventory owner preserves declaration layout and rejects removed identity guards", async (t) => {
  const source = await readFile(
    new URL("../apps/desktop/scripts/desktop-owned-native-session.mts", import.meta.url),
    "utf8",
  );
  const { parseAst } = await import("vite-plus");
  const tree: unknown = parseAst(stripTypeScriptTypes(source, { mode: "strip" }));
  const nodes = [...inventorySyntaxNodes(tree)];
  const owner = nodes.find(
    (node) =>
      node.type === "ClassDeclaration" && inventorySyntaxName(node.id) === "OwnedNativeSession",
  );
  const method = nodes.find(
    (node) =>
      node.type === "MethodDefinition" &&
      inventorySyntaxName(node.key) === "validateQualificationInventory",
  );
  assert.ok(
    owner &&
      isRecord(owner.body) &&
      method &&
      isRecord(method.value) &&
      isRecord(method.value.body),
  );
  assert.ok(Array.isArray(method.value.params));
  const parameters: unknown[] = method.value.params;
  const pattern = parameters[1];
  assert.ok(
    isRecord(pattern) && pattern.type === "ObjectPattern" && Array.isArray(pattern.properties),
  );
  const bindings: unknown[] = pattern.properties;
  const optionBinding = (name: string) => {
    const property = bindings.find(
      (value) => isRecord(value) && inventorySyntaxName(value.key) === name,
    );
    assert.ok(isRecord(property));
    const local = inventorySyntaxName(property.value);
    assert.ok(local);
    return { local, property };
  };
  const assertLocals = new Set<string>();
  for (const declaration of nodes) {
    if (
      declaration.type !== "ImportDeclaration" ||
      inventorySyntaxName(declaration.source) !== "node:assert/strict"
    )
      continue;
    assert.ok(Array.isArray(declaration.specifiers));
    const specifiers: unknown[] = declaration.specifiers;
    for (const value of specifiers) {
      if (!isRecord(value) || value.type !== "ImportDefaultSpecifier") continue;
      const local = inventorySyntaxName(value.local);
      assert.ok(local);
      assertLocals.add(local);
    }
  }
  assert.ok(assertLocals.size > 0);
  const calls = [...inventorySyntaxNodes(method.value.body)].filter(
    (node) =>
      node.type === "CallExpression" &&
      isRecord(node.callee) &&
      assertLocals.has(inventorySyntaxName(node.callee.object) ?? ""),
  );
  const guard = (input: string) => {
    const found = calls.filter((node) =>
      [...inventorySyntaxNodes(node)].some((part) =>
        input === "WebView"
          ? part.value === "msedgewebview2.exe"
          : part.type === "Identifier" && inventorySyntaxName(part) === optionBinding(input).local,
      ),
    );
    assert.equal(found.length, 1, `Identify the actual ${input} guard`);
    return found[0];
  };
  const range = inventorySyntaxSpan(method);
  const body = inventorySyntaxSpan(owner.body);
  const without = source.slice(0, range.start) + source.slice(range.end);
  const insertion = body.end - 1 - (range.end - range.start);
  const reordered =
    without.slice(0, insertion) +
    "\n" +
    source.slice(range.start, range.end) +
    "\n" +
    without.slice(insertion);
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-native-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let sequence = 0;
  const load = async (text: string) => {
    const file = path.join(root, `owner-${++sequence}.mts`);
    await writeFile(file, text, { flag: "wx" });
    const loaded: unknown = await import(pathToFileURL(file).href);
    assert.ok(isRecord(loaded) && typeof loaded.OwnedNativeSession === "function");
    const instance: unknown = Reflect.construct(loaded.OwnedNativeSession, []);
    assert.ok(isRecord(instance));
    const validate = instance.validateQualificationInventory;
    assert.ok(typeof validate === "function");
    return (captured: NativeProcessSnapshot, options: NativeQualificationInventoryOptions) => {
      Reflect.apply(validate, instance, [captured, options]);
    };
  };
  for (const [name, text] of [
    ["original", source],
    ["private-name", source.replaceAll(/\bconnectedApplication\b/gu, "validatedConnection")],
    ["method-order", reordered],
    [
      "formatting",
      editInventorySource(
        source,
        method,
        `\n/* same owned inventory behavior */\n${source.slice(range.start, range.end)}\n`,
      ),
    ],
  ] as const) {
    assertNativeInventoryIdentityOracle(await load(text));
    t.diagnostic(
      JSON.stringify({ name, outcome: "passed", oracle: "imported native inventory behavior" }),
    );
  }
  for (const [name, node, replacement] of [
    ["removed-application-guard", guard("application"), "undefined"],
    ["removed-driver-guard", guard("nativeDriverPath"), "undefined"],
    ["removed-WebView-guard", guard("WebView"), "undefined"],
    ["no-op-owner", method.value.body, "{}"],
  ] as const) {
    await assert.rejects(
      async () =>
        assertNativeInventoryIdentityOracle(
          await load(editInventorySource(source, node, replacement)),
        ),
      (error: unknown) =>
        isRecord(error) &&
        error.code === "ERR_ASSERTION" &&
        typeof error.message === "string" &&
        error.message.includes("native inventory behavior rejects missing"),
    );
    t.diagnostic(
      JSON.stringify({ name, outcome: "rejected", oracle: "imported native inventory behavior" }),
    );
  }
});
