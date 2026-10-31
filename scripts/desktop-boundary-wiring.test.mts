import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import { readFixtureModuleClosure } from "./fixtures/module-closure.mts";
import { stripTypeScriptTypes } from "node:module";
import { parseAst } from "vite-plus";
import { isRecord } from "./runtime-values.mts";
import { runDesktopModuleFixture } from "./fixtures/desktop-module-fixture.mts";

function* nodes(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const child of value) yield* nodes(child);
  } else if (isRecord(value)) {
    if (typeof value.type === "string") yield value;
    for (const child of Object.values(value)) yield* nodes(child);
  }
}
const identifier = (value: unknown) =>
  isRecord(value) && value.type === "Identifier" && typeof value.name === "string"
    ? value.name
    : undefined;
const literal = (value: unknown) =>
  isRecord(value) && value.type === "Literal" ? value.value : undefined;
const awaited = (value: unknown) =>
  isRecord(value) &&
  value.type === "AwaitExpression" &&
  isRecord(value.argument) &&
  value.argument.type === "CallExpression"
    ? value.argument
    : undefined;
const args = (value: Record<string, unknown> | undefined): unknown[] =>
  value && Array.isArray(value.arguments) ? value.arguments : [];
function range(node: unknown) {
  assert.ok(isRecord(node));
  assert.ok(typeof node.start === "number" && Number.isInteger(node.start));
  assert.ok(typeof node.end === "number" && Number.isInteger(node.end));
  assert.ok(node.start >= 0 && node.end > node.start);
  return { start: node.start, end: node.end };
}
function edit(code: string, changes: { start: number; end: number; text: string }[]) {
  return changes
    .sort((left, right) => right.start - left.start)
    .reduce(
      (result, change) => result.slice(0, change.start) + change.text + result.slice(change.end),
      code,
    );
}

void test("native boundary entrypoint retains its imported parsed invocation route", async () => {
  const source = stripTypeScriptTypes(
    await readFile(
      new URL("../apps/desktop/scripts/desktop-webview-boundary.mts", import.meta.url),
      "utf8",
    ),
    { mode: "strip" },
  );
  // Normative wiring only; imported-module and serialized-callback tests own behavior.
  // Parse executable syntax with the already pinned frontend parser so comments,
  // aliases, declaration position and layout cannot masquerade as an owner gate.
  function route(code: string) {
    const syntax = [...nodes(parseAst(code))];
    const declarations = syntax.filter(
      (node) =>
        node.type === "ImportDeclaration" &&
        literal(node.source) === "./desktop-boundary-invoke.mts",
    );
    const declaration = declarations[0];
    assert.ok(declaration, "Native entrypoint must import the parsed invocation transport");
    const specifiers = declarations.flatMap((entry) => {
      assert.ok(Array.isArray(entry.specifiers));
      return entry.specifiers.filter(isRecord);
    });
    const binding = (name: string) => {
      const specifier = specifiers.find(
        (node) => (identifier(node.imported) ?? literal(node.imported)) === name,
      );
      assert.ok(specifier, "Native entrypoint must import " + name);
      const alias = identifier(specifier.local);
      assert.ok(alias);
      return { specifier, alias };
    };
    const invocation = binding("invokeBoundary"),
      owner = binding("armBoundaryOwner");
    const queues = syntax.filter((node) => {
      const queue = awaited(node);
      if (!identifier(queue?.callee) || args(queue).length !== 1) return false;
      const armed = awaited(args(queue)[0]);
      return identifier(armed?.callee) === owner.alias && args(armed).length === 1;
    });
    const creation = syntax.find((node) => {
      const call = awaited(node);
      return (
        identifier(call?.callee) === invocation.alias &&
        args(call).length === 2 &&
        literal(args(call)[1]) === "create_boundary_windows"
      );
    });
    return { syntax, declaration, declarations, specifiers, binding, queues, creation };
  }
  function assertRoute(code: string) {
    const observed = route(code);
    assert.ok(
      observed.queues.length >= 2,
      "Delivered and abandoned owner queues must both await the imported arming transport",
    );
    assert.ok(
      observed.creation,
      "Native boundary fixture creation must use the imported parsed transport",
    );
  }
  function renamed(code: string, exported: string, alias: string) {
    const observed = route(code),
      bound = observed.binding(exported);
    const references = observed.syntax.filter(
      (node) => node.type === "CallExpression" && identifier(node.callee) === bound.alias,
    );
    return edit(code, [
      { ...range(bound.specifier), text: exported + " as " + alias },
      ...references.map((node) => {
        assert.ok(isRecord(node.callee));
        return { ...range(node.callee), text: alias };
      }),
    ]);
  }
  assertRoute(source);
  const aliased = renamed(
    renamed(source, "armBoundaryOwner", "$renamedOwner"),
    "invokeBoundary",
    "$renamedInvoke",
  );
  assertRoute(aliased);
  const aliasedRoute = route(aliased);
  const splitImports =
    edit(
      aliased,
      aliasedRoute.declarations.map((node) => ({
        ...range(node),
        text: "/* named transport imports moved and split */",
      })),
    ) +
    "\n" +
    aliasedRoute.specifiers
      .map((node) => {
        const selected = range(node);
        return `import {${aliased.slice(selected.start, selected.end)}} from "./desktop-boundary-invoke.mts";`;
      })
      .reverse()
      .join("\n");
  assertRoute(splitImports);
  const declaration = range(route(aliased).declaration);
  assertRoute(
    edit(aliased, [{ ...declaration, text: "/* imported transport moved below declarations */" }]) +
      "\n" +
      aliased.slice(declaration.start, declaration.end),
  );
  const observed = route(source);
  const first = awaited(observed.queues[0]);
  assert.ok(first);
  const armedArgument = args(first)[0];
  assert.ok(isRecord(armedArgument));
  const arm = range(armedArgument);
  const missingArm = edit(source, [{ ...arm, text: "0" }]);
  assert.throws(() => assertRoute(missingArm), /both await/u);
  // The removed gate's exact source in a comment cannot satisfy executable wiring.
  assert.throws(
    () => assertRoute(missingArm + "\n/* " + source.slice(arm.start, arm.end) + " */"),
    /both await/u,
  );
  const importedSource = observed.declaration.source;
  assert.ok(isRecord(importedSource));
  assert.throws(
    () =>
      assertRoute(
        edit(source, [{ ...range(importedSource), text: JSON.stringify("./wrong-transport.mts") }]),
      ),
    /must import/u,
  );
  const creation = awaited(observed.creation);
  assert.ok(creation);
  const creationCallee = creation.callee;
  assert.ok(isRecord(creationCallee));
  assert.throws(
    () => assertRoute(edit(source, [{ ...range(creationCallee), text: "wrongTransport" }])),
    /must use/u,
  );
});

void test("native boundary behavior executes before optional package installation", (context) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = disposableDirectory(context, path.join(tmpdir(), "portcove-boundary-route-"));
  const entry = "apps/desktop/scripts/desktop-webview-boundary.native.test.mts";
  const closure = readFixtureModuleClosure(root, [entry]);
  assert.deepEqual(
    closure.external.filter((dependency) => !isBuiltin(dependency)),
    [],
  );
  for (const module of closure.modules) {
    const target = path.join(directory, module.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, module.bytes);
  }
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", entry], {
    cwd: directory,
    env: environment,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /^# tests 3$/mu);
  assert.match(result.stdout, /^# pass 3$/mu);
  assert.match(result.stdout, /^# skipped 0$/mu);
});

void test("native harness awaits imported phase observations before execution admission", async () => {
  const source = stripTypeScriptTypes(
    await readFile(new URL("../apps/desktop/scripts/desktop-test.mts", import.meta.url), "utf8"),
    { mode: "strip" },
  );
  function route(code: string) {
    const program: unknown = parseAst(code);
    assert.ok(isRecord(program) && Array.isArray(program.body));
    const syntax = [...nodes(program)];
    const declarations = syntax.filter(
      (node) =>
        node.type === "ImportDeclaration" &&
        literal(node.source) === "../../../scripts/native-helper-dependencies.mts",
    );
    const declaration = declarations[0];
    assert.ok(declaration, "Import the observation owner");
    const specifiers = declarations.flatMap((node) => {
      assert.ok(Array.isArray(node.specifiers));
      return node.specifiers.filter(isRecord);
    });
    const imported = specifiers.find(
      (node) =>
        (identifier(node.imported) ?? literal(node.imported)) === "observeDesktopHarnessInputs",
    );
    assert.ok(imported, "Import the observation owner");
    const alias = identifier(imported.local);
    assert.ok(alias);
    const observations = program.body.filter(isRecord).flatMap((statement) => {
      if (statement.type !== "VariableDeclaration" || !Array.isArray(statement.declarations))
        return [];
      return statement.declarations.filter(isRecord).filter((declaration) => {
        const call = awaited(declaration.init);
        return identifier(call?.callee) === alias;
      });
    });
    assert.equal(observations.length, 1, "Await the observation owner at initial top-level read");
    const observation = observations[0];
    assert.ok(observation && isRecord(observation.id) && observation.id.type === "ObjectPattern");
    const properties = observation.id.properties;
    assert.ok(Array.isArray(properties));
    for (const name of ["inputs", "runnerMetadata", "metadataPhases"]) {
      assert.ok(
        properties
          .filter(isRecord)
          .some((node) => identifier(node.key) === name && identifier(node.value)),
        "Consume observed " + name,
      );
    }
    const admissionImport = syntax
      .filter(
        (node) =>
          node.type === "ImportDeclaration" &&
          literal(node.source) === "../../../scripts/retained-evidence.mts",
      )
      .flatMap((node) => (Array.isArray(node.specifiers) ? node.specifiers.filter(isRecord) : []))
      .find(
        (node) => (identifier(node.imported) ?? literal(node.imported)) === "executionAdmission",
      );
    assert.ok(admissionImport, "Retain the existing execution admission owner");
    const admissionAlias = identifier(admissionImport.local);
    const admissions = program.body
      .filter(isRecord)
      .flatMap((statement) =>
        statement.type === "VariableDeclaration" && Array.isArray(statement.declarations)
          ? statement.declarations
              .filter(isRecord)
              .filter(
                (node) =>
                  isRecord(node.init) &&
                  node.init.type === "CallExpression" &&
                  identifier(node.init.callee) === admissionAlias,
              )
          : [],
      );
    assert.equal(admissions.length, 1, "Retain initial execution admission");
    const admission = admissions[0];
    assert.ok(admission);
    assert.ok(
      range(observation).end < range(admission).start,
      "Observe phases before execution admission",
    );
    return {
      imported,
      observation,
      admission,
      admissionImport,
      declaration,
      syntax,
      functions: program.body
        .filter(isRecord)
        .filter((node) => node.type === "FunctionDeclaration"),
    };
  }
  const actual = route(source);
  const call = awaited(actual.observation.init);
  assert.ok(call && isRecord(call.callee));
  route(
    edit(source, [
      { ...range(actual.imported), text: "observeDesktopHarnessInputs as $observePhases" },
      { ...range(call.callee), text: "$observePhases" },
    ]),
  );
  route(
    'import { nativeHelperDependencies as unusedRegistry } from "../../../scripts/native-helper-dependencies.mts";\n' +
      source,
  );
  route(
    edit(source, [
      { ...range(actual.imported), text: '"observeDesktopHarnessInputs" as $quotedObservation' },
      { ...range(call.callee), text: "$quotedObservation" },
    ]),
  );
  const declaration = range(actual.declaration);
  route(
    edit(source, [{ ...declaration, text: "/* import reordered */" }]) +
      "\n" +
      source.slice(declaration.start, declaration.end),
  );
  const observation = range(actual.observation);
  const missing = edit(source, [{ ...observation, text: "ignoredObservation = {}" }]);
  assert.throws(() => route(missing), /Await the observation owner/u);
  assert.throws(
    () => route(missing + "\n/* " + source.slice(observation.start, observation.end) + " */"),
    /Await the observation owner/u,
  );
  assert.ok(isRecord(actual.observation.init));
  assert.throws(
    () =>
      route(
        edit(source, [
          {
            ...range(actual.observation.init),
            text: source.slice(range(call).start, range(call).end),
          },
        ]),
      ),
    /Await the observation owner/u,
  );
  assert.throws(
    () => route(edit(source, [{ ...range(call.callee), text: "unreviewedObservation" }])),
    /Await the observation owner/u,
  );
  const admission = range(actual.admission);
  assert.throws(
    () =>
      route(
        "const " +
          source.slice(admission.start, admission.end) +
          ";\n" +
          edit(source, [{ ...admission, text: "unusedAdmission = undefined" }]),
      ),
    /before execution admission/u,
  );
  const admissionCall = actual.admission.init;
  assert.ok(isRecord(admissionCall) && isRecord(admissionCall.callee));
  route(
    edit(source, [
      { ...range(actual.admissionImport), text: "executionAdmission as $admitExecution" },
      { ...range(admissionCall.callee), text: "$admitExecution" },
    ]),
  );
  // Moving declarations does not execute their bodies earlier.
  const functions = actual.functions;
  const last = functions.at(-1);
  assert.ok(last);
  const moved = range(last);
  route(
    source.slice(moved.start, moved.end) +
      "\n" +
      edit(source, [{ ...moved, text: "/* declaration moved */" }]),
  );
  assert.ok(isRecord(actual.observation.id));
  assert.throws(
    () =>
      route(
        edit(source, [{ ...range(actual.observation.id), text: "{ inputs, runnerMetadata }" }]),
      ),
    /Consume observed metadataPhases/u,
  );
});

void test("installed update entrypoints consume their imported observation owners", async () => {
  const policies = [
    {
      file: "desktop-windows-update-test.mts",
      exports: [
        "readWindowsUpdateProcessMarker",
        "readWindowsUpdateProcessObservation",
        "cleanupWindowsUpdateMarkedProcess",
        "installWindowsUpdateRestartHook",
        "windowsUpdateWorkerRelativePath",
      ],
    },
    { file: "desktop-macos-installed-update-test.mts", exports: ["readMacInstalledProcessField"] },
  ];
  for (const policy of policies) {
    const source = stripTypeScriptTypes(
      await readFile(new URL("../apps/desktop/scripts/" + policy.file, import.meta.url), "utf8"),
      { mode: "strip" },
    );
    function route(code: string) {
      const syntax = [...nodes(parseAst(code))];
      const specifiers = syntax
        .filter(
          (node) =>
            node.type === "ImportDeclaration" &&
            literal(node.source) === "./desktop-installed-update-harness.mts",
        )
        .flatMap((node) => {
          assert.ok(Array.isArray(node.specifiers));
          return node.specifiers.filter(isRecord);
        });
      const parents = new WeakMap<object, Record<string, unknown>>();
      for (const node of syntax)
        for (const [key, value] of Object.entries(node))
          if (key !== "loc") {
            if (Array.isArray(value)) {
              for (const child of value) if (isRecord(child)) parents.set(child, node);
            } else if (isRecord(value)) parents.set(value, node);
          }
      const parent = (value: unknown) => (isRecord(value) ? parents.get(value) : undefined);
      const ancestor = (value: unknown, type: string) => {
        let cursor = parent(value);
        while (cursor) {
          if (cursor.type === type) return cursor;
          cursor = parent(cursor);
        }
        return undefined;
      };
      const owners = policy.exports.map((name) => {
        const matching = specifiers.filter(
          (node) => (identifier(node.imported) ?? literal(node.imported)) === name,
        );
        assert.ok(matching.length, "Import installed observation owner " + name);
        const aliases = new Set(matching.map((node) => identifier(node.local)));
        const calls = syntax.filter(
          (node) => node.type === "CallExpression" && aliases.has(identifier(node.callee)),
        );
        const imported =
          matching.find((node) =>
            calls.some((call) => identifier(call.callee) === identifier(node.local)),
          ) ?? matching[0];
        assert.ok(imported);
        assert.ok(calls.length > 0, "Consume imported installed observation owner " + name);
        return { name, imported, calls };
      });
      const cleanupOwner = owners.find(
        (entry) => entry.name === "cleanupWindowsUpdateMarkedProcess",
      );
      const cleanupOptions = cleanupOwner ? args(cleanupOwner.calls[0])[0] : undefined;
      const restartProperty =
        isRecord(cleanupOptions) && Array.isArray(cleanupOptions.properties)
          ? cleanupOptions.properties
              .filter(isRecord)
              .find((node) => identifier(node.key) === "restartStarted")
          : undefined;
      const restartName = identifier(restartProperty?.value);
      const restart = syntax.find(
        (node) =>
          node.type === "AssignmentExpression" &&
          identifier(node.left) === restartName &&
          isRecord(node.right) &&
          node.right.type === "CallExpression" &&
          isRecord(node.right.callee) &&
          identifier(node.right.callee.property) === "toISOString" &&
          isRecord(node.right.callee.object) &&
          node.right.callee.object.type === "NewExpression" &&
          identifier(node.right.callee.object.callee) === "Date",
      );
      if (cleanupOwner) assert.ok(restartName && restart, "Forward owned restartStarted");
      for (const owner of owners.filter((entry) =>
        ["cleanupWindowsUpdateMarkedProcess", "installWindowsUpdateRestartHook"].includes(
          entry.name,
        ),
      )) {
        assert.equal(owner.calls.length, 1, "One live installed operation");
        const call = owner.calls[0];
        assert.ok(call);
        assert.ok(
          syntax.some((node) => node.type === "AwaitExpression" && node.argument === call),
          "Await installed operation",
        );
        assert.ok(
          !syntax.some(
            (node) =>
              ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
                String(node.type),
              ) &&
              range(node).start < range(call).start &&
              range(node).end > range(call).end,
          ),
          "Installed operation cannot be a disconnected function",
        );
        assert.ok(
          !syntax.some(
            (node) =>
              node.type === "LogicalExpression" &&
              range(node).start < range(call).start &&
              range(node).end > range(call).end,
          ),
          "Installed operation cannot be conditionally disconnected",
        );
        let child: Record<string, unknown> = call;
        for (let node = parent(child); node; node = parent(child)) {
          if (node.type === "IfStatement")
            assert.ok(
              owner.name === "cleanupWindowsUpdateMarkedProcess" &&
                restartName &&
                identifier(node.test) === restartName &&
                node.consequent === child,
              "Installed operation cannot be conditionally disconnected",
            );
          assert.ok(
            ![
              "ConditionalExpression",
              "WhileStatement",
              "DoWhileStatement",
              "ForStatement",
              "CatchClause",
            ].includes(String(node.type)),
            "Installed operation cannot be conditionally disconnected",
          );
          if (
            ["BlockStatement", "Program"].includes(String(node.type)) &&
            Array.isArray(node.body)
          ) {
            const position = node.body.indexOf(child);
            assert.ok(position >= 0);
            assert.ok(
              !node.body
                .slice(0, position)
                .some(
                  (previous) =>
                    isRecord(previous) &&
                    [
                      "ThrowStatement",
                      "ReturnStatement",
                      "BreakStatement",
                      "ContinueStatement",
                    ].includes(String(previous.type)),
                ),
              "Installed operation cannot follow unconditional exit",
            );
          }
          child = node;
        }
        if (owner.name === "cleanupWindowsUpdateMarkedProcess") {
          assert.ok(
            syntax.some(
              (node) =>
                node.type === "TryStatement" &&
                isRecord(node.finalizer) &&
                range(node.finalizer).start < range(call).start &&
                range(node.finalizer).end > range(call).end,
            ),
            "Cleanup stays in actual finally",
          );
          const options = args(call)[0];
          assert.ok(isRecord(options) && Array.isArray(options.properties));
          const slots = new Map(
            options.properties
              .filter(isRecord)
              .map((property) => [
                identifier(property.key) ?? literal(property.key),
                property.value,
              ]),
          );
          for (const field of ["app", "staging", "output"]) {
            const binding = syntax.find(
              (node) =>
                node.type === "VariableDeclarator" &&
                isRecord(node.init) &&
                node.init.type === "CallExpression" &&
                literal(args(node.init)[0]) === field,
            );
            assert.ok(binding, "Owned option " + field);
            assert.equal(
              identifier(slots.get(field)),
              identifier(binding.id),
              "Forward owned " + field,
            );
          }
          const reads = specifiers.filter((node) => identifier(node.imported) === "readJson");
          assert.ok(
            identifier(slots.get("readJson")) &&
              reads.some((node) => identifier(node.local) === identifier(slots.get("readJson"))),
            "Forward imported marker reader",
          );
          const loop = ancestor(call, "ForOfStatement");
          assert.ok(loop && isRecord(loop.left) && Array.isArray(loop.left.declarations));
          const declaration: unknown = loop.left.declarations[0];
          assert.ok(
            isRecord(declaration) &&
              isRecord(declaration.id) &&
              declaration.id.type === "ArrayPattern" &&
              Array.isArray(declaration.id.elements),
          );
          assert.equal(
            identifier(slots.get("label")),
            identifier(declaration.id.elements[0]),
            "Forward owned label",
          );
          assert.equal(
            identifier(slots.get("markerPath")),
            identifier(declaration.id.elements[1]),
            "Forward owned markerPath",
          );
          assert.ok(restartName, "Original restart assignment");
          assert.equal(
            identifier(slots.get("restartStarted")),
            restartName,
            "Forward owned restartStarted",
          );
          assert.ok(
            isRecord(loop.right) &&
              loop.right.type === "ArrayExpression" &&
              Array.isArray(loop.right.elements),
          );
          assert.equal(loop.right.elements.length, 2, "Complete cleanup marker routes");
          for (const [label, option] of [
            ["candidate", "relaunch-process-marker"],
            ["helper", "helper-process-marker"],
          ]) {
            const entry: Record<string, unknown> | undefined = loop.right.elements
              .filter(isRecord)
              .find((node) => Array.isArray(node.elements) && literal(node.elements[0]) === label);
            assert.ok(entry && Array.isArray(entry.elements), "Complete cleanup marker routes");
            const binding = syntax.find(
              (node) =>
                node.type === "VariableDeclarator" &&
                isRecord(node.init) &&
                node.init.type === "CallExpression" &&
                literal(args(node.init)[0]) === option,
            );
            assert.ok(binding, "Owned marker option");
            assert.equal(
              identifier(entry.elements[1]),
              identifier(binding.id),
              "Complete cleanup marker routes",
            );
          }
          const provider = syntax.find(
            (node) =>
              (node.type === "FunctionDeclaration" ||
                (node.type === "VariableDeclarator" &&
                  isRecord(node.init) &&
                  ["ArrowFunctionExpression", "FunctionExpression"].includes(
                    String(node.init.type),
                  ))) &&
              identifier(node.id) === identifier(slots.get("command")),
          );
          assert.ok(provider, "Forward actual process provider");
          const observation = owners.find(
            (entry) => entry.name === "readWindowsUpdateProcessObservation",
          );
          assert.ok(observation);
          assert.ok(
            observation.calls.some(
              (node) =>
                range(node).start > range(provider).start && range(node).end < range(provider).end,
            ),
            "Actual provider consumes parsed process observation",
          );
        }
      }
      const hook = owners.find((entry) => entry.name === "installWindowsUpdateRestartHook");
      if (hook) {
        const connections = new Set(
          specifiers
            .filter((node) => identifier(node.imported) === "connectInstalledUpdateDriver")
            .map((node) => identifier(node.local)),
        );
        assert.ok(connections.size);
        const assignments = syntax.filter(
          (node) =>
            node.type === "AssignmentExpression" &&
            isRecord(node.right) &&
            connections.has(identifier(awaited(node.right)?.callee)),
        );
        assert.ok(assignments.length > 0, "Connected browser assignment");
        assert.equal(args(hook.calls[0]).length, 1, "Pass connected browser");
        assert.equal(
          identifier(args(hook.calls[0])[0]),
          identifier(assignments[0]?.left),
          "Pass connected browser",
        );
      }
      return owners;
    }
    for (const owner of route(source)) {
      const alias = "$observedInstalledInput";
      const aliased = edit(source, [
        { ...range(owner.imported), text: JSON.stringify(owner.name) + " as " + alias },
        ...owner.calls.map((node) => ({ ...range(node.callee), text: alias })),
      ]);
      route(aliased);
      route(
        "import {" +
          JSON.stringify(owner.name) +
          ' as $unusedOwner,readJson as $unusedMarkerReader,connectInstalledUpdateDriver as $unusedConnection} from "./desktop-installed-update-harness.mts";\n' +
          aliased,
      );
      route(
        'import {hashFile as unusedHash} from "./desktop-installed-update-harness.mts";\n' +
          aliased,
      );
      if (
        ["cleanupWindowsUpdateMarkedProcess", "installWindowsUpdateRestartHook"].includes(
          owner.name,
        )
      ) {
        const call = owner.calls[0];
        assert.ok(call);
        const original = source.slice(range(call).start, range(call).end);
        const all = [...nodes(parseAst(source))];
        const statement = all
          .filter(
            (node) =>
              ["ExpressionStatement", "VariableDeclaration"].includes(String(node.type)) &&
              range(node).start <= range(call).start &&
              range(node).end >= range(call).end,
          )
          .sort((a, b) => range(a).end - range(a).start - range(b).end + range(b).start)[0];
        assert.ok(statement);
        const statementText = source.slice(range(statement).start, range(statement).end);
        for (const text of [
          "if(false){" + statementText + "}",
          'throw new Error("unconditional fixture exit");' + statementText,
        ]) {
          const dead = edit(source, [{ ...range(statement), text }]);
          parseAst(dead);
          assert.throws(() => route(dead), /conditionally disconnected|follow unconditional exit/);
        }
        const disconnected = edit(source, [
          { ...range(call), text: "false && (" + original + ")" },
        ]);
        parseAst(disconnected);
        assert.throws(
          () => route(disconnected),
          /conditionally disconnected|Await installed operation/,
        );
        const decoy =
          edit(source, [{ ...range(call), text: "Promise.resolve()" }]) +
          "\nasync function unusedInstalledOperation(){await " +
          original +
          ";}\n";
        parseAst(decoy);
        assert.throws(() => route(decoy), /disconnected function/);
        if (owner.name === "installWindowsUpdateRestartHook") {
          const guarded = edit(source, [
            { ...range(statement), text: "if(restartStarted){" + statementText + "}" },
          ]);
          parseAst(guarded);
          assert.throws(() => route(guarded), /conditionally disconnected/);
          const bad = edit(source, [{ ...range(args(call)[0]), text: '"wrong-browser"' }]);
          parseAst(bad);
          assert.throws(() => route(bad), /Pass connected browser/);
        }
        if (owner.name === "cleanupWindowsUpdateMarkedProcess") {
          const options = args(call)[0];
          assert.ok(isRecord(options) && Array.isArray(options.properties));
          for (const field of [
            "app",
            "staging",
            "output",
            "readJson",
            "command",
            "markerPath",
            "label",
            "restartStarted",
          ]) {
            const property = options.properties
              .filter(isRecord)
              .find((node) => identifier(node.key) === field);
            assert.ok(property);
            const bad = edit(source, [
              { ...range(property), text: field + ': "wrong-owned-input"' },
            ]);
            parseAst(bad);
            assert.throws(
              () => route(bad),
              /Forward owned|Forward imported marker reader|Forward actual process provider/,
            );
          }
          route(
            edit(
              source,
              options.properties.filter(isRecord).map((property) => ({
                ...range(property),
                text: identifier(property.key) + ": " + identifier(property.value),
              })),
            ),
          );
          route(source.replaceAll("absoluteOption", "$ownedAbsoluteOption"));
          route(
            "let $unrelatedTimestamp; $unrelatedTimestamp = new Date().toISOString();\n" + source,
          );
          const provider = [...nodes(parseAst(source))].find(
            (node) =>
              node.type === "FunctionDeclaration" && identifier(node.id) === "markedProcessCommand",
          );
          assert.ok(provider && Array.isArray(provider.params) && isRecord(provider.body));
          route(
            edit(source, [
              {
                ...range(provider),
                text:
                  "const markedProcessCommand = (" +
                  provider.params
                    .map((parameter) => source.slice(range(parameter).start, range(parameter).end))
                    .join(",") +
                  ") => " +
                  source.slice(range(provider.body).start, range(provider.body).end) +
                  ";",
              },
            ]),
          );
        }
      }
      const bypass = edit(
        source,
        owner.calls.map((node) => ({ ...range(node.callee), text: "unreviewedObservation" })),
      );
      assert.throws(() => route(bypass), /Consume imported installed observation owner/u);
      assert.throws(
        () =>
          route(
            bypass +
              "\n/* " +
              source.slice(range(owner.calls[0]).start, range(owner.calls[0]).end) +
              " */",
          ),
        /Consume imported installed observation owner/u,
      );
      assert.throws(
        () =>
          route(
            edit(source, [
              { ...range(owner.imported), text: "hashFile as " + identifier(owner.imported.local) },
            ]),
          ),
        /Import installed observation owner/u,
      );
    }
  }
});

void test("preparation and artwork scenarios consume their tested owner seams", async () => {
  for (const policy of [
    {
      file: "desktop-preparation-test.mts",
      owner: "preparationScenarios",
      seam: "settleDirectPreparationRecovery",
      awaited: true,
      capture: false,
    },
    {
      file: "desktop-artwork-correction-test.mts",
      owner: "artworkCorrectionScenario",
      seam: "renderCorrectedArtwork",
      awaited: false,
      capture: false,
    },
    {
      file: "desktop-preparation-test.mts",
      owner: "preparationScenarios",
      seam: "captureLibraryAction",
      awaited: false,
      capture: true,
    },
  ]) {
    const source = stripTypeScriptTypes(
      await readFile(new URL("../apps/desktop/scripts/" + policy.file, import.meta.url), "utf8"),
      { mode: "strip" },
    );
    function route(code: string, seamName = policy.seam) {
      const syntax = [...nodes(parseAst(code))];
      let inventory: Record<string, unknown> | undefined;
      function exportedFunction(name: string) {
        const exports = syntax.filter((node) => node.type === "ExportNamedDeclaration");
        const direct = exports.find(
          (node) =>
            isRecord(node.declaration) &&
            node.declaration.type === "FunctionDeclaration" &&
            identifier(node.declaration.id) === name,
        );
        if (direct) return direct.declaration as Record<string, unknown>;
        const exported = exports
          .flatMap((node) =>
            Array.isArray(node.specifiers) ? node.specifiers.filter(isRecord) : [],
          )
          .find((node) => (identifier(node.exported) ?? literal(node.exported)) === name);
        return (
          exported &&
          syntax.find(
            (node) =>
              node.type === "FunctionDeclaration" &&
              identifier(node.id) === identifier(exported.local),
          )
        );
      }
      const owner = exportedFunction(policy.owner);
      const seam = exportedFunction(seamName);
      assert.ok(seam, "Retain tested exported seam " + seamName);
      const localSeam = identifier(seam.id);
      assert.ok(owner, "Retain scenario owner " + policy.owner);
      const body = [...nodes(owner.body)];
      const calls = body.filter(
        (node) => node.type === "CallExpression" && identifier(node.callee) === localSeam,
      );
      assert.equal(calls.length, 1, "Delegate to tested seam " + seamName);
      if (policy.capture) {
        assert.ok(
          body.some((node) => awaited(node) === calls[0]),
          "Await Library capture evidence",
        );
        assert.equal(args(calls[0]).length, 6, "Pass complete Library capture context");
        assert.ok(Array.isArray(owner.params) && isRecord(owner.params[0]));
        const properties = owner.params[0].properties;
        assert.ok(Array.isArray(properties));
        const artifacts = properties
          .filter(isRecord)
          .find((node) => identifier(node.key) === "artifacts");
        assert.ok(artifacts && identifier(artifacts.value));
        assert.equal(
          identifier(args(calls[0])[5]),
          identifier(artifacts.value),
          "Retain scenario artifact receiver",
        );
      } else if (policy.awaited) {
        assert.ok(
          body.some((node) => awaited(node) === calls[0]),
          "Await settled recovery before reading Activity",
        );
        const activityReader = body.find(
          (node) =>
            node.type === "FunctionDeclaration" &&
            [...nodes(node.body)].some(
              (child) =>
                child.type === "CallExpression" &&
                args(child).some((argument) => literal(argument) === "get_activities"),
            ),
        );
        assert.ok(activityReader, "Retain actual Activity inventory reader");
        const block = body
          .filter(
            (node) =>
              node.type === "BlockStatement" &&
              [...nodes(node)].some((child) => awaited(child) === calls[0]),
          )
          .sort(
            (left, right) =>
              range(left).end - range(left).start - (range(right).end - range(right).start),
          )[0];
        assert.ok(block && Array.isArray(block.body), "Locate recovery statement block");
        const statements = block.body.filter(isRecord);
        const settlement = statements.findIndex((statement) =>
          [...nodes(statement)].some((child) => awaited(child) === calls[0]),
        );
        const inventories = statements.flatMap((statement, index) =>
          statement.type === "VariableDeclaration" &&
          Array.isArray(statement.declarations) &&
          statement.declarations.some(
            (declaration) =>
              isRecord(declaration) &&
              identifier(awaited(declaration.init)?.callee) === identifier(activityReader.id),
          )
            ? [index]
            : [],
        );
        assert.ok(
          inventories.length > 0 && inventories.every((index) => index > settlement),
          "Settle recovery before Activity inventory reads",
        );
        const firstInventory = inventories[0];
        assert.ok(firstInventory !== undefined);
        inventory = statements[firstInventory];
      } else {
        const closure = body.find(
          (node) =>
            node.type === "VariableDeclarator" &&
            isRecord(node.init) &&
            node.init.type === "ArrowFunctionExpression" &&
            node.init.body === calls[0],
        );
        assert.ok(closure, "Return artwork observation to the scenario renderer");
        const renders = body.filter(
          (node) =>
            node.type === "CallExpression" && identifier(node.callee) === identifier(closure.id),
        );
        assert.ok(
          renders.length > 0 &&
            renders.every((call) => body.some((node) => awaited(node) === call)),
          "Await every artwork observation in the scenario",
        );
      }
      return { syntax, owner, seam, calls, inventory };
    }
    const actual = route(source);
    const ownerAlias = "$locallyRenamedScenario";
    const ownerExport = actual.syntax.find(
      (node) => node.type === "ExportNamedDeclaration" && node.declaration === actual.owner,
    );
    const exportedSpecifier = (name: string) =>
      actual.syntax.find(
        (node) =>
          node.type === "ExportSpecifier" &&
          (identifier(node.exported) ?? literal(node.exported)) === name,
      );
    const ownerSpecifier = exportedSpecifier(policy.owner);
    assert.ok(ownerExport || ownerSpecifier);
    route(
      edit(source, [
        { ...range(actual.owner.id), text: ownerAlias },
        ...(ownerSpecifier
          ? [{ ...range(ownerSpecifier.local), text: ownerAlias }]
          : [{ start: range(ownerExport).start, end: range(actual.owner).start, text: "" }]),
      ]) + (!ownerSpecifier ? "\nexport {" + ownerAlias + " as " + policy.owner + "};" : ""),
    );
    const seam = actual.seam;
    const alias = "$testedOwnerSeam";
    const seamExport = actual.syntax.find(
      (node) => node.type === "ExportNamedDeclaration" && node.declaration === seam,
    );
    const seamSpecifier = exportedSpecifier(policy.seam);
    assert.ok(seamExport || seamSpecifier);
    const renamed = edit(source, [
      { ...range(seam.id), text: alias },
      ...(seamSpecifier
        ? [{ ...range(seamSpecifier.local), text: alias }]
        : [{ start: range(seamExport).start, end: range(seam).start, text: "" }]),
      ...actual.calls.map((node) => ({ ...range(node.callee), text: alias })),
    ]);
    route(renamed + (!seamSpecifier ? "\nexport {" + alias + " as " + policy.seam + "};" : ""));
    // A moved declaration and formatting preserve the same executable binding.
    const exportedSeam = actual.syntax.find(
      (node) => node.type === "ExportNamedDeclaration" && node.declaration === seam,
    );
    const selected = range(exportedSeam ?? seam);
    route(
      edit(source, [{ ...selected, text: "/* declaration moved */" }]) +
        "\n" +
        source.slice(selected.start, selected.end),
    );
    const bypassed = edit(
      source,
      actual.calls.map((node) => ({ ...range(node.callee), text: "unreviewedObservation" })),
    );
    assert.throws(() => route(bypassed), /Delegate to tested seam/u);
    assert.throws(
      () => route(bypassed + "\n/* " + policy.seam + "() */"),
      /Delegate to tested seam/u,
    );
    if (!policy.awaited && !policy.capture) {
      const body = [...nodes(actual.owner.body)];
      const closure = body.find(
        (node) =>
          node.type === "VariableDeclarator" &&
          isRecord(node.init) &&
          node.init.type === "ArrowFunctionExpression" &&
          node.init.body === actual.calls[0],
      );
      assert.ok(closure);
      for (const wait of body.filter(
        (node) => identifier(awaited(node)?.callee) === identifier(closure.id),
      )) {
        const call = awaited(wait);
        assert.ok(call);
        assert.throws(
          () =>
            route(
              edit(source, [
                { ...range(wait), text: source.slice(range(call).start, range(call).end) },
              ]),
            ),
          /Await every artwork/u,
        );
      }
    }
    if (policy.capture) {
      const wait = actual.syntax.find((node) => awaited(node) === actual.calls[0]);
      assert.ok(wait);
      assert.throws(
        () =>
          route(
            edit(source, [
              {
                ...range(wait),
                text: source.slice(range(actual.calls[0]).start, range(actual.calls[0]).end),
              },
            ]),
          ),
        /Await Library capture/u,
      );
      assert.throws(
        () =>
          route(
            edit(source, [{ ...range(args(actual.calls[0])[5]), text: "unreviewedArtifacts" }]),
          ),
        /Retain scenario artifact receiver/u,
      );
    }
    if (policy.awaited) {
      const recoveryDeclaration = actual.syntax.find(
        (node) =>
          node.type === "VariableDeclaration" &&
          [...nodes(node)].some((child) => awaited(child) === actual.calls[0]),
      );
      assert.ok(recoveryDeclaration);
      const selected = range(recoveryDeclaration);
      assert.ok(actual.inventory);
      const endOfInventory = range(actual.inventory).end;
      assert.ok(endOfInventory > selected.end);
      assert.throws(
        () =>
          route(
            edit(source, [
              { ...selected, text: "" },
              {
                start: endOfInventory,
                end: endOfInventory,
                text: "\n" + source.slice(selected.start, selected.end) + "\n",
              },
            ]),
          ),
        /Settle recovery before Activity/u,
      );
      const wait = actual.syntax.find((node) => awaited(node) === actual.calls[0]);
      assert.ok(wait);
      assert.throws(
        () =>
          route(
            edit(source, [
              {
                ...range(wait),
                text: source.slice(range(actual.calls[0]).start, range(actual.calls[0]).end),
              },
            ]),
          ),
        /Await settled recovery/u,
      );
    }
  }
});

void test("publication scenario retains its exported path observation callers", async () => {
  const source = stripTypeScriptTypes(
    await readFile(
      new URL("../apps/desktop/scripts/desktop-host-publication-test.mts", import.meta.url),
      "utf8",
    ),
    { mode: "strip" },
  );
  function route(code: string) {
    const syntax = [...nodes(parseAst(code))];
    return ["recordRedirectedPublicationWrite", "assertPublicationImportReadback"].map((name) => {
      const exported = syntax.filter((node) => node.type === "ExportNamedDeclaration");
      const alias = exported
        .flatMap((node) => (Array.isArray(node.specifiers) ? node.specifiers.filter(isRecord) : []))
        .find((node) => (identifier(node.exported) ?? literal(node.exported)) === name);
      const declaration = exported.find(
        (node) => isRecord(node.declaration) && identifier(node.declaration.id) === name,
      );
      const local = alias ? identifier(alias.local) : declaration ? name : undefined;
      assert.ok(local, "Retain the publication observation owner " + name);
      const waiting = syntax.filter((node) => identifier(awaited(node)?.callee) === local);
      const calls = waiting.map((node) => {
        const call = awaited(node);
        assert.ok(call);
        return call;
      });
      assert.equal(calls.length, 1, "Consume the publication observation owner " + name);
      return { name, local, calls, waiting };
    });
  }
  for (const owner of route(source)) {
    const alias = "$publicationObservation";
    route(source.replaceAll(owner.name, alias) + "\nexport {" + alias + " as " + owner.name + "};");
    const bypass = edit(
      source,
      owner.calls.map((node) => ({ ...range(node.callee), text: "unreviewedObservation" })),
    );
    const unawaited = edit(
      source,
      owner.waiting.map((node, index) => {
        const call = range(owner.calls[index]);
        return { ...range(node), text: source.slice(call.start, call.end) };
      }),
    );
    assert.throws(() => route(unawaited), /Consume the publication observation owner/u);

    assert.throws(() => route(bypass), /Consume the publication observation owner/u);
    assert.throws(
      () =>
        route(
          bypass +
            "\n/* " +
            source.slice(range(owner.calls[0]).start, range(owner.calls[0]).end) +
            " */",
        ),
      /Consume the publication observation owner/u,
    );
  }
});

void test("selected setup awaits disabled review before unavailable-root observations", async () => {
  const source = stripTypeScriptTypes(
    await readFile(
      new URL("../apps/desktop/scripts/desktop-source-dialog-test.mts", import.meta.url),
      "utf8",
    ),
    { mode: "strip" },
  );
  function route(code: string) {
    const syntax = [...nodes(parseAst(code))];
    const exports = syntax.filter((node) => node.type === "ExportNamedDeclaration");
    function binding(name: string) {
      const direct = exports.find(
        (node) =>
          isRecord(node.declaration) &&
          node.declaration.type === "FunctionDeclaration" &&
          identifier(node.declaration.id) === name,
      );
      if (direct && isRecord(direct.declaration))
        return { declaration: direct.declaration, wrapper: direct, specifier: undefined };
      const alias = exports
        .flatMap((node) => (Array.isArray(node.specifiers) ? node.specifiers.filter(isRecord) : []))
        .find((node) => (identifier(node.exported) ?? literal(node.exported)) === name);
      const declaration =
        alias &&
        syntax.find(
          (node) =>
            node.type === "FunctionDeclaration" && identifier(node.id) === identifier(alias.local),
        );
      assert.ok(declaration, "Retain exported source review owner " + name);
      return {
        declaration,
        wrapper: exports.find((node) => node.declaration === declaration),
        specifier: alias,
      };
    }
    const helper = binding("waitForDisabledSourceReview"),
      owner = binding("selectedSetupScenario");
    const body = [...nodes(owner.declaration.body)];
    const block = body.find(
      (node) =>
        node.type === "BlockStatement" &&
        Array.isArray(node.body) &&
        node.body.some(
          (statement) =>
            isRecord(statement) &&
            identifier(awaited(statement.expression)?.callee) === identifier(helper.declaration.id),
        ),
    );
    assert.ok(
      block && Array.isArray(block.body),
      "Await the disabled-review owner in selected setup",
    );
    const statements = block.body.filter(isRecord);
    const waiting = statements.find(
      (statement) =>
        identifier(awaited(statement.expression)?.callee) === identifier(helper.declaration.id),
    );
    assert.ok(waiting);
    const checkpoint = (name: string) =>
      statements.find(
        (statement) =>
          isRecord(statement.expression) &&
          statement.expression.type === "AssignmentExpression" &&
          literal(statement.expression.right) === name &&
          isRecord(statement.expression.left) &&
          statement.expression.left.type === "MemberExpression" &&
          identifier(statement.expression.left.property) === "checkpoint",
      );
    const before = checkpoint("unavailable-root-disabled-review"),
      after = checkpoint("unavailable-root-observations");
    assert.ok(before && after, "Retain both source review observation checkpoints");
    assert.ok(
      range(before).end < range(waiting).start && range(waiting).end < range(after).start,
      "Settle disabled review before unavailable-root observations",
    );
    return { helper, owner, waiting };
  }
  const actual = route(source);
  const alias = "$disabledReviewObservation";
  const call = awaited(actual.waiting.expression);
  assert.ok(call && isRecord(call.callee));
  const helper = actual.helper;
  route(
    edit(source, [
      { ...range(helper.declaration.id), text: alias },
      { ...range(call.callee), text: alias },
      ...(helper.specifier && isRecord(helper.specifier.local)
        ? [{ ...range(helper.specifier.local), text: alias }]
        : helper.wrapper
          ? [{ start: range(helper.wrapper).start, end: range(helper.declaration).start, text: "" }]
          : []),
    ]) + (!helper.specifier ? "\nexport {" + alias + " as waitForDisabledSourceReview};" : ""),
  );
  const selected = range(helper.wrapper ?? helper.declaration);
  route(
    edit(source, [{ ...selected, text: "/* declaration moved */" }]) +
      "\n" +
      source.slice(selected.start, selected.end),
  );
  const bypass = edit(source, [{ ...range(call.callee), text: "unreviewedObservation" }]);
  assert.throws(() => route(bypass), /Await the disabled-review owner/u);
  assert.throws(
    () => route(bypass + "\n/* await waitForDisabledSourceReview() */"),
    /Await the disabled-review owner/u,
  );
  assert.throws(
    () =>
      route(
        edit(source, [
          {
            ...range(actual.waiting.expression),
            text: source.slice(range(call).start, range(call).end),
          },
        ]),
      ),
    /Await the disabled-review owner/u,
  );
});

void test("module fixtures preserve API aliases and opaque identities before optional packages", (context) => {
  const directory = disposableDirectory(context, path.join(tmpdir(), "pcv-module-alias-"));
  const entry = path.join(directory, "owned.mts");
  writeFileSync(path.join(directory, "transport-values.mts"), "export const unused = true;\n");
  for (const source of [
    'export const sentinel={tag:"owned"};export function publicDecision(){return sentinel}',
    'const sentinel={tag:"owned"};function localDecision(){return sentinel}export {sentinel,localDecision as publicDecision};',
    'export {sentinel,localDecision as "publicDecision"};function localDecision(){return sentinel}const sentinel={tag:"owned"};',
  ]) {
    writeFileSync(entry, source);
    const program = `
      assert.throws(()=>process.kill(process.pid,0),/Native process execution is forbidden/);
      const processes=await import('node:child_process');
      assert.throws(()=>processes.execFileSync(new URL('./missing-owned-executable',entry).pathname),/Native process execution is forbidden/);
      const transport=await import(new URL('./transport-values.mts',entry));
      assert.throws(()=>transport.transportValue('unowned-command',{}),/Native process execution is forbidden/);
      const subject=await import(entry);assert.deepEqual(subject.sentinel,{tag:"owned"});assert.equal(subject.publicDecision(),subject.sentinel);
    `;
    const target = pathToFileURL(entry);
    runDesktopModuleFixture(target, program);
    runDesktopModuleFixture(target, program, { exportName: "publicDecision", variant: "aliased" });
    assert.throws(() =>
      runDesktopModuleFixture(target, program, {
        exportName: "publicDecision",
        variant: "wrong-export",
      }),
    );
  }
});

void test("workspace scenarios retain their actual serialized callbacks, activity and restoration routes", async () => {
  const source = stripTypeScriptTypes(
    await readFile(
      new URL("../apps/desktop/scripts/desktop-workspace-refresh-test.mts", import.meta.url),
      "utf8",
    ),
    { mode: "strip" },
  );
  function* active(
    value: unknown,
    parents: { node: Record<string, unknown>; key: string }[] = [],
  ): Generator<{ node: Record<string, unknown>; parents: typeof parents }> {
    if (Array.isArray(value)) {
      for (const child of value) yield* active(child, parents);
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.type === "string") yield { node: value, parents };
    if (
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
        String(value.type),
      )
    )
      return;
    for (const [key, child] of Object.entries(value)) {
      if (value.type === "IfStatement" && literal(value.test) === false && key === "consequent")
        continue;
      if (
        value.type === "ConditionalExpression" &&
        literal(value.test) === false &&
        key === "consequent"
      )
        continue;
      if (
        value.type === "LogicalExpression" &&
        value.operator === "&&" &&
        literal(value.left) === false &&
        key === "right"
      )
        continue;
      yield* active(child, [...parents, { node: value, key }]);
    }
  }
  const member = (node: unknown, object: string | undefined, property: string) =>
    isRecord(node) &&
    node.type === "MemberExpression" &&
    identifier(node.object) === object &&
    identifier(node.property) === property;
  const verify = (code: string) => {
    const tree: unknown = parseAst(code);
    assert.ok(isRecord(tree) && Array.isArray(tree.body));
    const topLevel: unknown[] = tree.body;
    const declarations = new Map<string, Record<string, unknown>>();
    const exports = new Map<string, string>();
    const statements = new Map<string, Record<string, unknown>>();
    for (const statement of topLevel) {
      assert.ok(isRecord(statement));
      const declaration: unknown =
        statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
      if (isRecord(declaration)) {
        const name = identifier(declaration.id);
        if (name) {
          declarations.set(name, declaration);
          statements.set(name, statement);
        }
        if (declaration.type === "VariableDeclaration" && Array.isArray(declaration.declarations)) {
          for (const entry of declaration.declarations) {
            assert.ok(isRecord(entry));
            const name = identifier(entry.id);
            if (name && isRecord(entry.init)) {
              declarations.set(name, entry.init);
              statements.set(name, statement);
            }
            if (name && statement.type === "ExportNamedDeclaration") exports.set(name, name);
          }
        } else if (name && statement.type === "ExportNamedDeclaration") exports.set(name, name);
      }
      if (statement.type === "ExportNamedDeclaration" && Array.isArray(statement.specifiers)) {
        for (const specifier of statement.specifiers) {
          assert.ok(isRecord(specifier));
          const name = identifier(specifier.exported),
            local = identifier(specifier.local);
          if (name && local) exports.set(name, local);
        }
      }
    }
    const resolve = (
      name: string | undefined,
      seen = new Set<string>(),
    ): Record<string, unknown> | undefined => {
      if (!name || seen.has(name)) return undefined;
      seen.add(name);
      const declaration = declarations.get(name);
      return declaration?.type === "Identifier"
        ? resolve(identifier(declaration), seen)
        : declaration;
    };
    const exported = (name: string) => {
      const declaration = resolve(exports.get(name));
      assert.ok(
        declaration &&
          ["FunctionDeclaration", "ArrowFunctionExpression", "FunctionExpression"].includes(
            String(declaration.type),
          ),
        "Missing production export " + name,
      );
      return declaration;
    };
    const imported = (module: string, name: string) => {
      const bindings: Record<string, unknown>[] = [];
      for (const statement of topLevel) {
        if (
          !isRecord(statement) ||
          statement.type !== "ImportDeclaration" ||
          literal(statement.source) !== module ||
          !Array.isArray(statement.specifiers)
        )
          continue;
        const specifiers: unknown[] = statement.specifiers;
        for (const specifier of specifiers)
          if (
            isRecord(specifier) &&
            (name === "default"
              ? specifier.type === "ImportDefaultSpecifier"
              : identifier(specifier.imported) === name)
          )
            bindings.push(specifier);
      }
      assert.ok(bindings.length > 0, "Missing production dependency " + name);
      return new Set(
        bindings.map((binding) => {
          assert.ok(isRecord(binding));
          const alias = identifier(binding.local);
          assert.ok(alias);
          return alias;
        }),
      );
    };
    const adapter = imported("./browser-script.mts", "executeBrowserScript");
    const transport = imported("./transport-values.mts", "transportValue");
    const owner = exported("workspaceRefreshScenario");
    assert.ok(
      Array.isArray(owner.params) &&
        isRecord(owner.params[0]) &&
        Array.isArray(owner.params[0].properties),
    );
    const properties: unknown[] = owner.params[0].properties;
    const parameter = (key: string) => {
      const property = properties.find((value) => isRecord(value) && identifier(value.key) === key);
      assert.ok(isRecord(property));
      const name = identifier(property.value);
      assert.ok(name);
      return name;
    };
    const browser = parameter("browser"),
      scenario = parameter("scenario");
    const selected = (name: string) => {
      const registrations = [...active(owner.body)].filter(
        ({ node, parents }) =>
          node.type === "CallExpression" &&
          identifier(node.callee) === scenario &&
          literal(args(node)[0]) === name &&
          parents.some(({ node }) => node.type === "AwaitExpression"),
      );
      assert.equal(registrations.length, 1, "Actual selected scenario " + name);
      const callback = args(registrations[0]?.node)[1];
      assert.ok(isRecord(callback));
      return [...active(callback.body)];
    };
    const refresh = selected("native-workspace-refresh-recovery"),
      reconciliation = selected("native-external-cli-reconciliation");
    const routes = [
      ["installWorkspaceRefreshProbe", refresh, true, false],
      ["restoreWorkspaceRefreshProbe", refresh, false, true],
      ["installExternalReconciliationProbe", reconciliation, false, false],
      ["replayTerminalActivity", reconciliation, true, false],
      ["installReconciliationSupportGate", reconciliation, false, false],
      ["releaseReconciliationSupportGate", reconciliation, false, true],
      ["installSourceFormatProbe", reconciliation, false, false],
      ["restoreSourceFormatProbe", reconciliation, false, true],
      ["restoreExternalReconciliationProbe", reconciliation, false, true],
    ] as const;
    const calls = new Map<string, Record<string, unknown>>();
    for (const [name, scope, asynchronous, finalizer] of routes) {
      const dependency = exported(name);
      const matches = scope.filter(({ node, parents }) => {
        if (
          node.type !== "CallExpression" ||
          !parents.some(({ node }) => node.type === "AwaitExpression")
        )
          return false;
        const values = args(node),
          callback = asynchronous ? values[0] : values[1];
        return (
          resolve(identifier(callback)) === dependency &&
          (asynchronous
            ? member(node.callee, browser, "executeAsyncScript")
            : adapter.has(identifier(node.callee) ?? "") && identifier(values[0]) === browser)
        );
      });
      assert.equal(matches.length, 1, "Actual serialized route " + name);
      const matched = matches[0];
      assert.ok(matched);
      if (finalizer)
        assert.ok(
          matched.parents.some(({ key }) => key === "finalizer"),
          "Actual cleanup route " + name,
        );
      calls.set(name, matched.node);
    }
    const port = reconciliation.find(
      ({ node }) =>
        node.type === "VariableDeclarator" &&
        isRecord(node.init) &&
        node.init.type === "CallExpression" &&
        transport.has(identifier(node.init.callee) ?? "") &&
        literal(args(node.init)[0]) === "port",
    )?.node;
    const portName = identifier(port?.id);
    assert.ok(portName);
    assert.ok(
      member(args(calls.get("installSourceFormatProbe"))[2], portName, "id"),
      "Exact selected port",
    );
    const terminal = reconciliation.find(
      ({ node }) =>
        node.type === "VariableDeclarator" &&
        isRecord(node.init) &&
        node.init.type === "CallExpression" &&
        isRecord(node.init.callee) &&
        node.init.callee.type === "MemberExpression" &&
        identifier(node.init.callee.property) === "find" &&
        isRecord(node.init.callee.object) &&
        identifier(node.init.callee.object.property) === "records" &&
        [...nodes(args(node.init)[0])].some((value) => member(value, portName, "id")),
    )?.node;
    const terminalName = identifier(terminal?.id);
    assert.ok(
      terminalName &&
        terminal &&
        isRecord(terminal.init) &&
        isRecord(terminal.init.callee) &&
        isRecord(terminal.init.callee.object),
    );
    const observedName = identifier(terminal.init.callee.object.object);
    assert.ok(observedName);
    const observation = reconciliation.find(
      ({ node }) => node.type === "VariableDeclarator" && identifier(node.id) === observedName,
    )?.node;
    assert.ok(observation && isRecord(observation.init));
    const observedCall = awaited(args(observation.init)[0]);
    assert.ok(
      observedCall &&
        identifier(observedCall.callee) === parameter("invoke") &&
        literal(args(observedCall)[0]) === "get_activities",
      "Actual activity observation",
    );
    const predicate = args(terminal.init)[0];
    assert.ok(isRecord(predicate) && Array.isArray(predicate.params));
    const record = identifier(predicate.params[0]);
    assert.ok(record);
    const returned =
      isRecord(predicate.body) && predicate.body.type === "BlockStatement"
        ? [...active(predicate.body)].find(({ node }) => node.type === "ReturnStatement")?.node
            .argument
        : predicate.body;
    const conjuncts = (value: unknown): unknown[] =>
      isRecord(value) && value.type === "LogicalExpression" && value.operator === "&&"
        ? [...conjuncts(value.left), ...conjuncts(value.right)]
        : [value];
    const equal = (
      value: unknown,
      left: (node: unknown) => boolean,
      right: (node: unknown) => boolean,
    ) =>
      isRecord(value) &&
      value.type === "BinaryExpression" &&
      value.operator === "===" &&
      ((left(value.left) && right(value.right)) || (left(value.right) && right(value.left)));
    const terms = conjuncts(returned);
    assert.ok(
      terms.some((value) =>
        equal(
          value,
          (node) => member(node, record, "operation"),
          (node) => literal(node) === "adopt",
        ),
      ) &&
        terms.some((value) =>
          equal(
            value,
            (node) => member(node, record, "target_id"),
            (node) => member(node, portName, "id"),
          ),
        ),
      "Exact adopted activity predicate",
    );
    const assertion = imported("node:assert/strict", "default");
    const terminalStatus = reconciliation.find(
      ({ node }) =>
        node.type === "CallExpression" &&
        [...assertion].some((alias) => member(node.callee, alias, "equal")) &&
        member(args(node)[0], terminalName, "status") &&
        literal(args(node)[1]) === "succeeded",
    )?.node;
    assert.ok(terminalStatus, "Actual terminal activity status");
    assert.equal(
      identifier(args(calls.get("replayTerminalActivity"))[1]),
      terminalName,
      "Actual retained activity",
    );
    const position = (name: string) => range(calls.get(name)).start;
    assert.ok(
      position("installReconciliationSupportGate") < position("releaseReconciliationSupportGate"),
    );
    assert.ok(position("installSourceFormatProbe") < position("restoreSourceFormatProbe"));
    assert.ok(
      position("restoreSourceFormatProbe") < position("restoreExternalReconciliationProbe"),
    );
    return { calls, exports, declarations, statements, predicate, observedCall, terminalStatus };
  };
  const original = verify(source);
  const helpers = [...original.calls.keys()];
  const aliases = helpers.reduce(
    (code, name, index) =>
      code.replace(new RegExp("\\b" + name + "\\b", "gu"), "$workspace" + index),
    source,
  );
  const aliased =
    helpers.reduce(
      (code, name, index) =>
        code.replace("export const $workspace" + index, "const $workspace" + index),
      aliases,
    ) +
    "\nexport {" +
    helpers.map((name, index) => "$workspace" + index + " as " + name).join(",") +
    "};\n";
  verify(aliased);
  verify(`import {executeBrowserScript as $otherBrowserScript} from "./browser-script.mts";
import {transportValue as $otherTransport} from "./transport-values.mts";
import $otherAssert from "node:assert/strict";
${source}
function $otherUsedAliases(browser,value) {$otherAssert.ok(value);$otherBrowserScript(browser,()=>true);return $otherTransport("port",value);}
`);

  verify(source.replaceAll("\n", "\r\n"));
  const declarationRanges = helpers.map((name) => range(original.statements.get(name)));
  const spans = declarationRanges.map(({ start, end }) => source.slice(start, end));
  verify(
    edit(
      source,
      helpers.map((name) => {
        const declaration = original.declarations.get(name);
        assert.ok(declaration && Array.isArray(declaration.params));
        const parameters = declaration.params
          .map((value) => {
            const span = range(value);
            return source.slice(span.start, span.end);
          })
          .join(",");
        const body = range(declaration.body);
        return {
          ...range(original.statements.get(name)),
          text:
            "export function " +
            name +
            "(" +
            parameters +
            ") " +
            source.slice(body.start, body.end),
        };
      }),
    ),
  );

  verify(
    edit(
      source,
      declarationRanges.map((span, index) => ({
        ...span,
        text: spans[spans.length - index - 1] ?? "",
      })),
    ),
  );
  for (const [name, call] of original.calls) {
    const index =
      name === "installWorkspaceRefreshProbe" || name === "replayTerminalActivity" ? 0 : 1;
    const callback = args(call)[index];
    const changed = edit(source, [{ ...range(callback), text: "() => undefined" }]);
    const decoy =
      "\nasync function $unusedWorkspaceRoute(){await " +
      source.slice(range(call).start, range(call).end) +
      ";}\n";
    assert.throws(() => verify(changed + decoy), /Actual serialized route/u, name);
  }
  const format = original.calls.get("installSourceFormatProbe");
  assert.throws(
    () => verify(edit(source, [{ ...range(args(format)[2]), text: '"unrelated-port"' }])),
    /Exact selected port/u,
  );
  const replay = original.calls.get("replayTerminalActivity");
  assert.throws(
    () => verify(edit(source, [{ ...range(args(replay)[1]), text: "{}" }])),
    /Actual retained activity/u,
  );

  const operation = [...nodes(original.predicate)].find((node) => literal(node) === "adopt");
  assert.ok(operation);
  assert.throws(
    () => verify(edit(source, [{ ...range(operation), text: '"launch"' }])),
    /Exact adopted activity predicate/u,
  );
  assert.throws(
    () =>
      verify(
        edit(source, [
          { ...range(args(original.observedCall)[0]), text: '"get_workspace_snapshot"' },
        ]),
      ),
    /Actual activity observation/u,
  );
  assert.throws(
    () => verify(edit(source, [{ ...range(args(original.terminalStatus)[1]), text: '"failed"' }])),
    /Actual terminal activity status/u,
  );
  const gate = original.calls.get("installReconciliationSupportGate");
  assert.ok(gate);
  assert.throws(
    () =>
      verify(
        edit(source, [
          {
            ...range(gate),
            text: "(false && " + source.slice(range(gate).start, range(gate).end) + ")",
          },
        ]),
      ),
    /Actual serialized route/u,
  );
  assert.throws(
    () =>
      verify(source.replace('from "./browser-script.mts"', 'from "./wrong-browser-script.mts"')),
    /Missing production dependency/u,
  );
});

void test("macOS installed cleanup consumes its live owner and explicit process capabilities", async () => {
  const source = stripTypeScriptTypes(
    await readFile(
      new URL("../apps/desktop/scripts/desktop-macos-installed-update-test.mts", import.meta.url),
      "utf8",
    ),
    { mode: "strip" },
  );
  function* active(
    value: unknown,
    callbacks = new Set<string>(),
    executeCallback = false,
  ): Generator<Record<string, unknown>> {
    if (Array.isArray(value)) {
      for (const child of value) yield* active(child, callbacks);
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.type === "string") yield value;
    if (
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
        String(value.type),
      )
    ) {
      if (executeCallback) yield* active(value.body, callbacks);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (value.type === "IfStatement" && literal(value.test) === false && key === "consequent")
        continue;
      if (
        value.type === "CallExpression" &&
        key === "arguments" &&
        callbacks.has(identifier(value.callee) ?? "")
      ) {
        for (const [index, argument] of args(value).entries())
          yield* active(argument, callbacks, index === 0);
      } else yield* active(child, callbacks);
    }
  }
  const route = (code: string) => {
    const ast = parseAst(code);
    const syntax = [...nodes(ast)];
    const imported = (module: string, name: string) => {
      const matches = syntax
        .filter((node) => node.type === "ImportDeclaration" && literal(node.source) === module)
        .flatMap((node) => {
          assert.ok(Array.isArray(node.specifiers));
          const values: unknown[] = node.specifiers;
          return values.filter(isRecord);
        })
        .filter((node) => identifier(node.imported) === name);
      assert.ok(matches.length > 0, "Import actual Mac capability " + name);
      return {
        matches,
        aliases: new Set(
          matches.map((node) => {
            const alias = identifier(node.local);
            assert.ok(alias);
            return alias;
          }),
        ),
      };
    };
    const factory = imported(
      "./desktop-installed-update-harness.mts",
      "createMacInstalledProcessCleanup",
    );
    const waits = imported("./desktop-installed-update-harness.mts", "waitFor");
    const spawns = imported("node:child_process", "spawn");
    const live = [...active(ast, waits.aliases)];
    const calls = live.filter(
      (node) =>
        node.type === "VariableDeclarator" &&
        isRecord(node.id) &&
        node.id.type === "ObjectPattern" &&
        isRecord(node.init) &&
        node.init.type === "CallExpression" &&
        factory.aliases.has(identifier(node.init.callee) ?? ""),
    );
    assert.equal(calls.length, 1, "Live Mac cleanup owner");
    const owner = calls[0];
    assert.ok(
      owner && isRecord(owner.id) && Array.isArray(owner.id.properties) && isRecord(owner.init),
    );
    const invocation = owner.init;
    const values = args(invocation),
      configuration = values[1];
    assert.ok(isRecord(configuration) && Array.isArray(configuration.properties));
    const properties: unknown[] = configuration.properties,
      bindings: unknown[] = owner.id.properties;
    const dependency = (name: string) => {
      const property = properties.find(
        (value) => isRecord(value) && (identifier(value.key) ?? literal(value.key)) === name,
      );
      assert.ok(isRecord(property), "Mac capability " + name);
      return property.value;
    };
    const spawn = live.find(
      (node) => node.type === "CallExpression" && spawns.aliases.has(identifier(node.callee) ?? ""),
    );
    assert.ok(spawn);
    const application = identifier(args(spawn)[0]);
    assert.ok(application);
    assert.equal(identifier(values[0]), application, "Cleanup owns the launched application");
    assert.ok(
      waits.aliases.has(identifier(dependency("waitFor")) ?? ""),
      "Actual cleanup wait provider",
    );
    const functions = syntax.filter((node) => node.type === "FunctionDeclaration");
    const functionFor = (value: unknown) => {
      const name = identifier(value);
      const declaration = syntax.find(
        (node) =>
          ["FunctionDeclaration", "VariableDeclarator"].includes(String(node.type)) &&
          identifier(node.id) === name,
      );
      const fn =
        isRecord(value) &&
        ["ArrowFunctionExpression", "FunctionExpression"].includes(String(value.type))
          ? value
          : declaration?.type === "VariableDeclarator"
            ? declaration.init
            : declaration;
      assert.ok(
        isRecord(fn) &&
          ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
            String(fn.type),
          ) &&
          !fn.async,
        "Synchronous Mac capability",
      );
      return fn;
    };
    const identify = functionFor(dependency("processIdentity")),
      matching = functionFor(dependency("matchingChildIdentity")),
      children = functionFor(dependency("childPids"));
    const identityBinding = identifier(dependency("processIdentity"));
    assert.ok(identityBinding);
    assert.ok(
      [...active(matching.body)].some(
        (node) =>
          node.type === "ReturnStatement" &&
          isRecord(node.argument) &&
          node.argument.type === "CallExpression" &&
          identifier(node.argument.callee) === identityBinding,
      ),
      "Child identity reuses the live identity provider",
    );
    // Follow the consumed command/result chain, rather than any decoy call in
    // the provider body. Private bindings and declaration forms are incidental.
    const commands = imported("node:child_process", "execFileSync");
    const chain = (value: unknown) => {
      const result: Record<string, unknown>[] = [];
      while (isRecord(value)) {
        result.push(value);
        if (value.type === "CallExpression") value = value.callee;
        else if (value.type === "MemberExpression") value = value.object;
        else break;
      }
      return result;
    };
    const childNodes = [...active(children.body)];
    const output = childNodes.find(
      (node) =>
        node.type === "VariableDeclarator" &&
        chain(node.init).some(
          (part) =>
            part.type === "CallExpression" &&
            commands.aliases.has(identifier(part.callee) ?? "") &&
            literal(args(part)[0]) === "/usr/bin/pgrep",
        ),
    );
    assert.ok(output, "Child enumeration uses actual pgrep provider");
    const command = chain(output.init).find(
      (part) =>
        part.type === "CallExpression" && commands.aliases.has(identifier(part.callee) ?? ""),
    );
    const childArguments = args(command)[1];
    assert.ok(isRecord(childArguments) && Array.isArray(childArguments.elements));
    const childElements: unknown[] = childArguments.elements;
    assert.equal(literal(childElements[0]), "-P");
    const parentPid = childElements[1];
    assert.ok(isRecord(parentPid) && parentPid.type === "CallExpression");
    assert.equal(identifier(parentPid.callee), "String");
    assert.ok(Array.isArray(children.params));
    assert.equal(identifier(args(parentPid)[0]), identifier(children.params[0]));
    assert.ok(
      childNodes.some(
        (node) =>
          node.type === "ReturnStatement" &&
          identifier(chain(node.argument).at(-1)) === identifier(output.id),
      ),
      "Child enumeration consumes the actual pgrep result",
    );
    const signal = functionFor(dependency("signal"));
    assert.ok(Array.isArray(signal.params));
    const forwarded = [...active(signal.body)].find(
      (node) =>
        node.type === "CallExpression" &&
        isRecord(node.callee) &&
        node.callee.type === "MemberExpression" &&
        identifier(node.callee.object) === "process" &&
        identifier(node.callee.property) === "kill",
    );
    assert.ok(forwarded, "Actual native signal adapter");
    assert.equal(
      identifier(args(forwarded)[0]),
      identifier(signal.params[0]),
      "Forward exact signal PID",
    );
    assert.equal(
      identifier(args(forwarded)[1]),
      identifier(signal.params[1]),
      "Forward exact signal kind",
    );
    const methods = new Map<
      string,
      { property: Record<string, unknown>; alias: string; calls: Record<string, unknown>[] }
    >();
    for (const name of [
      "positivePid",
      "processMarker",
      "ownedMarker",
      "stopOwned",
      "freezeCaptureAndStop",
    ]) {
      const property = bindings.find(
        (value) => isRecord(value) && (identifier(value.key) ?? literal(value.key)) === name,
      );
      assert.ok(isRecord(property));
      const alias = identifier(property.value);
      assert.ok(alias);
      const calls = live.filter(
        (node) => node.type === "CallExpression" && identifier(node.callee) === alias,
      );
      assert.ok(calls.length > 0, "Consume live Mac method " + name);
      methods.set(name, { property, alias, calls });
    }
    return {
      factory,
      owner,
      invocation,
      configuration,
      dependency,
      methods,
      forwarded,
      functions,
      syntax,
      signal,
      providers: [
        { name: identityBinding, fn: identify },
        { name: identifier(dependency("matchingChildIdentity")), fn: matching },
        { name: identifier(dependency("childPids")), fn: children },
      ],
    };
  };
  const actual = route(source);
  const waitProperty = [...nodes(actual.configuration)].find(
    (node) => node.type === "Property" && (identifier(node.key) ?? literal(node.key)) === "waitFor",
  );
  assert.ok(waitProperty);
  route(source.replaceAll("\n", "\r\n"));
  const factoryAlias = "$ownedMacCleanup";
  route(
    edit(source, [
      ...actual.factory.matches.map((node) => ({
        ...range(node),
        text: "createMacInstalledProcessCleanup as " + factoryAlias,
      })),
      ...actual.syntax
        .filter(
          (node) =>
            node.type === "CallExpression" &&
            actual.factory.aliases.has(identifier(node.callee) ?? ""),
        )
        .map((node) => ({ ...range(node.callee), text: factoryAlias })),
    ]),
  );
  const changes: { start: number; end: number; text: string }[] = [];
  for (const [name, method] of actual.methods) {
    const alias = "$mac" + name;
    changes.push({ ...range(method.property), text: JSON.stringify(name) + ":" + alias });
    for (const call of actual.syntax.filter(
      (node) => node.type === "CallExpression" && identifier(node.callee) === method.alias,
    ))
      changes.push({ ...range(call.callee), text: alias });
  }
  route(edit(source, changes));
  const providerForms: { start: number; end: number; text: string }[] = [];
  let providerPrelude = "";
  for (const { name, fn } of actual.providers) {
    if (fn.type !== "FunctionDeclaration") continue;
    assert.ok(name && Array.isArray(fn.params));
    const parameters = fn.params
      .map((value) => {
        const span = range(value);
        return source.slice(span.start, span.end);
      })
      .join(",");
    const body = range(fn.body);
    providerPrelude +=
      "const " + name + " = (" + parameters + ") => " + source.slice(body.start, body.end) + ";\n";
    providerForms.push({ ...range(fn), text: "" });
  }
  const ownerStatement = actual.syntax.find(
    (node) =>
      node.type === "VariableDeclaration" &&
      Array.isArray(node.declarations) &&
      node.declarations.includes(actual.owner),
  );
  assert.ok(ownerStatement);
  const insertion = range(ownerStatement).start;
  if (providerForms.length)
    route(
      edit(source, [...providerForms, { start: insertion, end: insertion, text: providerPrelude }]),
    );
  const moved = actual.functions.at(-1);
  assert.ok(moved);
  const movedRange = range(moved);
  route(
    source.slice(movedRange.start, movedRange.end) +
      "\n" +
      edit(source, [{ ...movedRange, text: "/* declaration moved */" }]),
  );
  route(
    'import {createMacInstalledProcessCleanup as $otherMacCleanup} from "./desktop-installed-update-harness.mts";\n' +
      source +
      "\nfunction $unusedOtherMacAlias(){return $otherMacCleanup();}\n",
  );
  for (const [name, method] of actual.methods) {
    const broken = edit(
      source,
      method.calls.map((call) => ({ ...range(call.callee), text: "unreviewedMacCleanup" })),
    );
    const decoy =
      "\nasync function $unusedMacMethod(){" +
      source.slice(range(method.calls[0]).start, range(method.calls[0]).end) +
      ";}\n";
    assert.throws(() => route(broken + decoy), /Consume live Mac method/u, name);
  }
  assert.throws(
    () =>
      route(
        edit(source, [{ ...range(args(actual.invocation)[0]), text: '"foreign-application"' }]),
      ),
    /Cleanup owns the launched application/u,
  );
  assert.throws(
    () => route(edit(source, [{ ...range(args(actual.forwarded)[0]), text: '"wrong-pid"' }])),
    /Forward exact signal PID/u,
  );
  assert.throws(
    () => route(edit(source, [{ ...range(args(actual.forwarded)[1]), text: '"SIGCONT"' }])),
    /Forward exact signal kind/u,
  );
  const childProperty = [...nodes(actual.configuration)].find(
    (node) =>
      node.type === "Property" && (identifier(node.key) ?? literal(node.key)) === "childPids",
  );
  assert.ok(childProperty);
  assert.throws(
    () => route(edit(source, [{ ...range(childProperty), text: "childPids: () => []" }])),
    { code: "ERR_ASSERTION", message: /Child enumeration uses actual pgrep provider/u },
  );
  assert.throws(
    () =>
      route(
        edit(source, [
          {
            ...range(actual.signal.body),
            text:
              "{ if (false) { " +
              source.slice(range(actual.forwarded).start, range(actual.forwarded).end) +
              "; } }",
          },
        ]),
      ),
    { code: "ERR_ASSERTION", message: /Actual native signal adapter/u },
  );
  assert.throws(
    () => route(edit(source, [{ ...range(waitProperty), text: "waitFor:async()=>true" }])),
    /Actual cleanup wait provider/u,
  );
  assert.throws(
    () =>
      route(
        edit(source, [
          {
            ...range(actual.factory.matches[0]),
            text: "hashFile as " + identifier(actual.factory.matches[0]?.local),
          },
        ]),
      ),
    /Import actual Mac capability/u,
  );
});

void test("imported macOS cleanup retains birth custody and mandatory frozen-owner cleanup", async (t) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const entry = "apps/desktop/scripts/desktop-macos-installed-update.native.test.mts";
  const ownerPath = "apps/desktop/scripts/desktop-installed-update-harness.mts";
  const transportPath = "apps/desktop/scripts/transport-values.mts";
  const closure = readFixtureModuleClosure(root, [entry, ownerPath, transportPath]);
  const directory = disposableDirectory(t, path.join(tmpdir(), "portcove-mac-cleanup-module-"));
  writeFileSync(path.join(directory, "package.json"), '{"type":"module"}\n');
  for (const module of closure.modules) {
    const destination = path.join(directory, module.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, module.bytes);
  }
  const source = stripTypeScriptTypes(await readFile(path.join(root, ownerPath), "utf8"), {
    mode: "strip",
  });
  const program: unknown = parseAst(source);
  assert.ok(isRecord(program) && Array.isArray(program.body));
  const declarations = new Map<string, Record<string, unknown>>(),
    exports = new Map<string, string>();
  for (const item of program.body) {
    assert.ok(isRecord(item));
    const declaration: unknown = item.type === "ExportNamedDeclaration" ? item.declaration : item;
    if (isRecord(declaration)) {
      const name = identifier(declaration.id);
      if (name) {
        declarations.set(name, declaration);
        if (item.type === "ExportNamedDeclaration") exports.set(name, name);
      }
      if (declaration.type === "VariableDeclaration" && Array.isArray(declaration.declarations))
        for (const value of declaration.declarations) {
          assert.ok(isRecord(value));
          const name = identifier(value.id);
          if (name && isRecord(value.init)) {
            declarations.set(name, value.init);
            if (item.type === "ExportNamedDeclaration") exports.set(name, name);
          }
        }
    }
    if (item.type === "ExportNamedDeclaration" && Array.isArray(item.specifiers))
      for (const value of item.specifiers) {
        assert.ok(isRecord(value));
        const name = identifier(value.exported),
          local = identifier(value.local);
        if (name && local) exports.set(name, local);
      }
  }
  const factory = declarations.get(exports.get("createMacInstalledProcessCleanup") ?? "");
  assert.ok(factory && isRecord(factory.body));
  const returned = [...nodes(factory.body)].find(
    (node) =>
      node.type === "ReturnStatement" &&
      isRecord(node.argument) &&
      node.argument.type === "ObjectExpression" &&
      Array.isArray(node.argument.properties) &&
      node.argument.properties.some(
        (value: unknown) =>
          isRecord(value) &&
          (identifier(value.key) ?? literal(value.key)) === "freezeCaptureAndStop",
      ),
  );
  assert.ok(returned && isRecord(returned.argument) && Array.isArray(returned.argument.properties));
  const properties: unknown[] = returned.argument.properties;
  const method = (name: string) => {
    const property = properties.find(
      (value) => isRecord(value) && (identifier(value.key) ?? literal(value.key)) === name,
    );
    assert.ok(isRecord(property));
    const local = identifier(property.value);
    const fn =
      isRecord(property.value) &&
      ["FunctionExpression", "ArrowFunctionExpression"].includes(String(property.value.type))
        ? property.value
        : [...nodes(factory.body)].find(
            (node) =>
              (node.type === "FunctionDeclaration" && identifier(node.id) === local) ||
              (node.type === "VariableDeclarator" && identifier(node.id) === local),
          );
    assert.ok(fn);
    const implementation = fn.type === "VariableDeclarator" ? fn.init : fn;
    assert.ok(isRecord(implementation));
    const binding = local ? fn.id : undefined;
    const declaration =
      fn.type === "VariableDeclarator"
        ? [...nodes(factory.body)].find(
            (node) =>
              node.type === "VariableDeclaration" &&
              Array.isArray(node.declarations) &&
              node.declarations.includes(fn),
          )
        : fn.type === "FunctionDeclaration"
          ? fn
          : undefined;
    return { property, fn: implementation, binding, declaration };
  };
  const stop = method("stopOwned"),
    freeze = method("freezeCaptureAndStop");
  const kill = (node: Record<string, unknown>) =>
    [...nodes(node)].some(
      (value) => value.type === "CallExpression" && literal(args(value)[1]) === "SIGKILL",
    );
  const guard = [...nodes(stop.fn.body)].find(
    (node) => node.type === "IfStatement" && isRecord(node.consequent) && kill(node.consequent),
  );
  assert.ok(guard && isRecord(guard.consequent));
  const capture = [...nodes(freeze.fn.body)].find(
    (node) => node.type === "TryStatement" && isRecord(node.finalizer) && kill(node.finalizer),
  );
  assert.ok(capture && isRecord(capture.finalizer));
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const execute = (code: string) => {
    writeFileSync(path.join(directory, ownerPath), code);
    const result = spawnSync(
      process.execPath,
      ["--test", "--test-reporter=tap", path.join(directory, entry)],
      {
        cwd: directory,
        env: environment,
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.ifError(result.error);
    return result;
  };
  const accepted = (code: string) => {
    const result = execute(code);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /macOS frozen child capture retains exact first failure/u);
    assert.match(result.stdout, /# pass 4\b/u);
    assert.match(result.stdout, /# fail 0\b/u);
  };
  accepted(source);
  const transportFile = path.join(directory, transportPath);
  renameSync(transportFile, transportFile + ".retained-input");
  try {
    const missingInput = execute(source);
    assert.equal(missingInput.signal, null);
    assert.equal(missingInput.status, 1, "Missing required fixture input must refuse execution");
    assert.match(missingInput.stdout, /ERR_MODULE_NOT_FOUND/u);
    assert.ok(missingInput.stdout.includes("transport-values.mts"));
  } finally {
    renameSync(transportFile + ".retained-input", transportFile);
  }
  accepted(source.replaceAll("\n", "\r\n"));
  const renamed: { start: number; end: number; text: string }[] = [];
  for (const [name, implementation] of [
    ["stopOwned", stop],
    ["freezeCaptureAndStop", freeze],
  ] as const) {
    if (!isRecord(implementation.binding)) continue;
    const alias = "$owned" + name;
    renamed.push(
      { ...range(implementation.binding), text: alias },
      { ...range(implementation.property), text: JSON.stringify(name) + ":" + alias },
    );
  }
  accepted(edit(source, renamed));
  if (stop.declaration && freeze.declaration) {
    const first = range(stop.declaration),
      second = range(freeze.declaration);
    if (first.end <= second.start || second.end <= first.start)
      accepted(
        edit(source, [
          { ...first, text: source.slice(second.start, second.end) },
          { ...second, text: source.slice(first.start, first.end) },
        ]),
      );
  }
  const forms: { start: number; end: number; text: string }[] = [];
  for (const implementation of [stop, freeze]) {
    if (implementation.declaration?.type !== "FunctionDeclaration") continue;
    assert.ok(Array.isArray(implementation.fn.params));
    const parameters = implementation.fn.params
      .map((value) => {
        const span = range(value);
        return source.slice(span.start, span.end);
      })
      .join(",");
    const body = range(implementation.fn.body),
      name = identifier(implementation.binding);
    assert.ok(name);
    forms.push({
      ...range(implementation.declaration),
      text:
        "const " +
        name +
        " = " +
        (implementation.fn.async ? "async " : "") +
        "(" +
        parameters +
        ") => " +
        source.slice(body.start, body.end) +
        ";",
    });
  }
  if (forms.length) accepted(edit(source, forms));
  const rejected = (code: string, caseName: RegExp, assertion: string) => {
    const result = execute(code);
    assert.equal(result.signal, null, "A process signal cannot stand in for a guard failure");
    assert.equal(result.status, 1, "Removed custody guard must fail its actual unit case");
    assert.match(result.stdout, caseName);
    assert.match(result.stdout, /\bcode:\s*['"]?ERR_ASSERTION\b/u);
    assert.ok(
      result.stdout.includes("MAC_CONTRACT_ASSERTION " + assertion),
      "Require the inner behavioral assertion, not a fixture infrastructure failure",
    );
    assert.doesNotMatch(result.stdout + result.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/u);
  };
  rejected(
    edit(source, [
      {
        ...range(guard),
        text: source.slice(range(guard.consequent).start, range(guard.consequent).end),
      },
    ]),
    /not ok \d+ - macOS owned cleanup refuses foreign markers and never signals a changed start identity/u,
    "Mac changed-start custody rejects forced kill",
  );
  rejected(
    edit(source, [{ ...range(capture.finalizer), text: "{}" }]),
    /not ok \d+ - macOS frozen child capture retains exact first failure after mandatory process cleanup/u,
    "Mac capture must force stop in finally",
  );
});

void test("artwork scenarios serialize their live production browser observations", async (context) => {
  const production = "apps/desktop/scripts/desktop-artwork-test.mts";
  const native = "apps/desktop/scripts/desktop-artwork.native.test.mts";
  const source = stripTypeScriptTypes(
    await readFile(new URL("../" + production, import.meta.url), "utf8"),
    { mode: "strip" },
  );
  function route(code: string) {
    const syntax = [...nodes(parseAst(code))];
    const callable = (node: Record<string, unknown>) =>
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
        String(node.type),
      );
    function exported(name: string) {
      for (const entry of syntax.filter((node) => node.type === "ExportNamedDeclaration")) {
        let local: string | undefined;
        if (isRecord(entry.declaration)) {
          if (entry.declaration.type === "FunctionDeclaration")
            local = identifier(entry.declaration.id);
          else if (Array.isArray(entry.declaration.declarations)) {
            local = entry.declaration.declarations
              .filter(isRecord)
              .map((node) => identifier(node.id))
              .find((value) => value === name);
          }
          if (local !== name) local = undefined;
        }
        if (Array.isArray(entry.specifiers)) {
          const alias = entry.specifiers
            .filter(isRecord)
            .find((node) => (identifier(node.exported) ?? literal(node.exported)) === name);
          if (alias) local = identifier(alias.local);
        }
        if (!local) continue;
        const binding = syntax.find(
          (node) =>
            identifier(node.id) === local &&
            (node.type === "FunctionDeclaration" ||
              (node.type === "VariableDeclarator" && isRecord(node.init) && callable(node.init))),
        );
        assert.ok(binding, "Resolve actual artwork export " + name);
        const node = binding.type === "VariableDeclarator" ? binding.init : binding;
        assert.ok(isRecord(node));
        return { name, local, node, entry };
      }
      assert.fail("Retain exported artwork owner " + name);
    }
    const owner = exported("artworkScenario");
    assert.ok(Array.isArray(owner.node.params) && isRecord(owner.node.params[0]));
    const propertyValues: unknown = owner.node.params[0].properties;
    assert.ok(Array.isArray(propertyValues));
    const properties: Record<string, unknown>[] = propertyValues.filter(isRecord);
    function contextBinding(name: string): string {
      const property = properties.find((node) => identifier(node.key) === name);
      const binding = property && identifier(property.value);
      assert.ok(binding, "Retain artwork scenario context " + name);
      return binding;
    }
    const browser = contextBinding("browser"),
      scenario = contextBinding("scenario");
    // Collect every alias, including aliases imported from the wrong owner.
    // The consumed dependency, rather than the first import, determines wiring.
    const importedAdapters = syntax.flatMap((declaration) => {
      if (declaration.type !== "ImportDeclaration" || !Array.isArray(declaration.specifiers))
        return [];
      return declaration.specifiers.filter(isRecord).flatMap((specifier) => {
        const local = identifier(specifier.local);
        return local &&
          (identifier(specifier.imported) ?? literal(specifier.imported)) === "executeBrowserScript"
          ? [{ declaration, specifier, local }]
          : [];
      });
    });
    const blocks = syntax.filter(
      (node) => node.type === "BlockStatement" || node.type === "Program",
    );
    const bindings = syntax.flatMap((node) => {
      const fn =
        node.type === "FunctionDeclaration"
          ? node
          : node.type === "VariableDeclarator" && isRecord(node.init) && callable(node.init)
            ? node.init
            : undefined;
      const name = identifier(node.id);
      if (!fn || !name) return [];
      const scope = blocks
        .filter(
          (block) => range(block).start <= range(node).start && range(block).end >= range(node).end,
        )
        .sort((a, b) => range(a).end - range(a).start - (range(b).end - range(b).start))[0];
      assert.ok(scope);
      return [{ name, fn, scope }];
    });
    function constant(value: unknown): { value: unknown } | undefined {
      if (!isRecord(value)) return undefined;
      if (
        value.type === "Literal" &&
        (value.value === null || ["boolean", "string", "number"].includes(typeof value.value))
      )
        return { value: value.value };
      if (value.type === "UnaryExpression" && value.operator === "!") {
        const argument = constant(value.argument);
        if (argument) return { value: !argument.value };
      }
      return undefined;
    }
    function active(seed: unknown) {
      const live: Record<string, unknown>[] = [],
        seen = new Set<unknown>();
      const resolved = new Map<Record<string, unknown>, Record<string, unknown>>();
      function visit(value: unknown, enter = false) {
        if (Array.isArray(value)) {
          for (const item of value) visit(item);
          return;
        }
        if (!isRecord(value) || (callable(value) && !enter) || seen.has(value)) return;
        seen.add(value);
        live.push(value);
        if (value.type === "IfStatement" || value.type === "ConditionalExpression") {
          const test = constant(value.test);
          if (test) {
            visit(value.test);
            visit(test.value ? value.consequent : value.alternate);
            return;
          }
        }
        if (value.type === "LogicalExpression") {
          visit(value.left);
          const left = constant(value.left);
          if (
            left &&
            ((value.operator === "&&" && !left.value) ||
              (value.operator === "||" && left.value) ||
              (value.operator === "??" && left.value !== null && left.value !== undefined))
          )
            return;
          visit(value.right);
          return;
        }
        if (value.type === "CallExpression") {
          const name = identifier(value.callee);
          const called = bindings
            .filter(
              (binding) =>
                binding.name === name &&
                range(binding.scope).start <= range(value).start &&
                range(binding.scope).end >= range(value).end,
            )
            .sort(
              (a, b) =>
                range(a.scope).end -
                range(a.scope).start -
                (range(b.scope).end - range(b.scope).start),
            )[0];
          if (called) {
            resolved.set(value, called.fn);
            visit(called.fn, true);
          }
          if (
            name === scenario &&
            literal(args(value)[0]) === "native-local-artwork-picker-and-recovery"
          )
            visit(args(value)[1], true);
          if (
            isRecord(value.callee) &&
            value.callee.type === "MemberExpression" &&
            identifier(value.callee.object) === browser &&
            identifier(value.callee.property) === "wait"
          )
            visit(args(value)[0], true);
        }
        for (const child of Object.values(value)) visit(child);
      }
      visit(seed);
      return { live, resolved };
    }
    const { live, resolved } = active(owner.node.body);
    const scenarios = live.filter(
      (node) =>
        node.type === "CallExpression" &&
        identifier(node.callee) === scenario &&
        literal(args(node)[0]) === "native-local-artwork-picker-and-recovery",
    );
    assert.equal(scenarios.length, 1, "Retain the executed artwork scenario");
    assert.ok(
      live.some((node) => awaited(node) === scenarios[0]),
      "Await the actual artwork scenario",
    );
    const readers = ["readArtworkFallback", "readArtworkGeometry"].map(exported).map((reader) => {
      const calls = live.filter(
        (node) => node.type === "CallExpression" && resolved.get(node) === reader.node,
      );
      assert.ok(calls.length > 0, "Delegate actual artwork observation " + reader.name);
      for (const call of calls) {
        assert.equal(identifier(args(call)[0]), browser, "Use the scenario's actual browser");
        assert.ok(
          live.some((node) => awaited(node) === call),
          "Await actual artwork observation " + reader.name,
        );
      }
      const implementation = active(reader.node.body);
      const adapters = importedAdapters.filter((binding) =>
        implementation.live.some(
          (node) =>
            node.type === "CallExpression" &&
            identifier(node.callee) === binding.local &&
            !implementation.resolved.has(node),
        ),
      );
      assert.ok(
        adapters.length > 0,
        "Use production browser serialization adapter for " + reader.name,
      );
      assert.ok(
        adapters.every((binding) => literal(binding.declaration.source) === "./browser-script.mts"),
        "Use production browser serialization adapter for " + reader.name,
      );
      return { ...reader, calls, adapters };
    });
    const adapters = readers
      .flatMap((reader) => reader.adapters)
      .filter(
        (binding, index, all) =>
          all.findIndex((candidate) => candidate.specifier === binding.specifier) === index,
      );
    return { syntax, owner, readers, live, adapters };
  }
  const actual = route(source);
  const helperNames = new Map([
    ["fallbackVisual", "$fallbackObservation"],
    ["expectFallbackVisual", "$settledFallback"],
  ]);
  route(
    edit(
      source,
      actual.syntax
        .filter((node) => node.type === "Identifier" && helperNames.has(String(node.name)))
        .map((node) => ({ ...range(node), text: helperNames.get(String(node.name)) ?? "" })),
    ),
  );
  const entries = actual.readers.map((reader) => reader.entry);
  route(
    (
      edit(
        source,
        entries.map((entry) => ({ ...range(entry), text: "" })),
      ) +
      "\n" +
      entries.map((entry) => source.slice(range(entry).start, range(entry).end)).join("\n")
    ).replaceAll("\n", "\r\n"),
  );
  const arrowEdits: { start: number; end: number; text: string }[] = [];
  for (const [index, reader] of actual.readers.entries()) {
    assert.ok(Array.isArray(reader.node.params));
    const local = "$artworkReader" + index;
    arrowEdits.push({
      ...range(reader.entry),
      text:
        "const " +
        local +
        (reader.node.async ? "=async(" : "=(") +
        reader.node.params
          .map((param) => source.slice(range(param).start, range(param).end))
          .join(",") +
        ")=>" +
        source.slice(range(reader.node.body).start, range(reader.node.body).end) +
        ";export {" +
        local +
        " as " +
        reader.name +
        "};",
    });
    arrowEdits.push(...reader.calls.map((call) => ({ ...range(call.callee), text: local })));
  }
  route(edit(source, arrowEdits));
  const primary = actual.adapters[0];
  assert.ok(primary);
  const importSpan = range(primary.declaration);
  route(
    edit(source, [
      { ...range(primary.specifier), text: "executeBrowserScript as $serializedArtwork" },
      ...actual.syntax
        .filter(
          (node) =>
            node.type === "Identifier" &&
            node.name === primary.local &&
            (range(node).start < importSpan.start || range(node).end > importSpan.end),
        )
        .map((node) => ({ ...range(node), text: "$serializedArtwork" })),
    ]),
  );
  function rejectWrongImports(code: string) {
    const observed = route(code);
    const declarations = observed.adapters
      .map((binding) => binding.declaration)
      .filter((node, index, all) => all.indexOf(node) === index);
    for (const declaration of declarations)
      assert.throws(
        () =>
          route(
            edit(code, [{ ...range(declaration.source), text: '"./desktop-scenario-state.mts"' }]),
          ),
        /Use production browser serialization adapter/u,
      );
  }
  rejectWrongImports(source);
  const sibling = actual.live.find(
    (node) =>
      node.type === "CallExpression" &&
      identifier(node.callee) === primary.local &&
      typeof literal(args(node)[1]) === "string",
  );
  assert.ok(sibling, "Retain an independently consumed browser adapter alias control");
  const extraImports = edit(source, [
    { ...range(sibling.callee), text: "$otherArtworkAdapter" },
    {
      start: 0,
      end: 0,
      text: 'import "./browser-script.mts";import {executeBrowserScript as $otherArtworkAdapter} from "./browser-script.mts";\n',
    },
  ]);
  route(extraImports);
  rejectWrongImports(extraImports);
  for (const reader of actual.readers) {
    const bypassed = edit(source, [
      ...reader.calls.map((call) => ({
        ...range(call.callee),
        text: "$replacedArtworkObservation",
      })),
      {
        start: range(actual.owner.node.body).end - 1,
        end: range(actual.owner.node.body).end - 1,
        text: "\nfunction $unusedArtworkObservation(){return " + reader.local + "(browser); }\n",
      },
    ]);
    assert.throws(
      () => route(bypassed),
      (error) =>
        error instanceof assert.AssertionError &&
        error.message.includes("Delegate actual artwork observation " + reader.name),
    );
    assert.throws(
      () =>
        route(
          edit(
            source,
            reader.calls.map((call) => ({ ...range(args(call)[0]), text: "{}" })),
          ),
        ),
      /Use the scenario's actual browser/u,
    );
  }
  for (const reader of actual.readers) {
    const disabled = edit(
      source,
      reader.calls.map((call) => {
        const wait = actual.live.find((node) => awaited(node) === call);
        assert.ok(wait);
        return {
          ...range(wait),
          text: "(false && " + source.slice(range(wait).start, range(wait).end) + ")",
        };
      }),
    );
    assert.throws(
      () => route(disabled),
      (error) =>
        error instanceof assert.AssertionError &&
        error.message.includes("Delegate actual artwork observation " + reader.name),
    );
  }
  const fallback = actual.readers[0];
  assert.ok(fallback);

  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = disposableDirectory(context, path.join(tmpdir(), "portcove-artwork-owner-"));
  const transport = "apps/desktop/scripts/transport-values.mts";
  const closure = readFixtureModuleClosure(root, [native, production, transport]);
  for (const module of closure.modules) {
    const target = path.join(directory, module.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, module.bytes);
  }
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  function run() {
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", native], {
      cwd: directory,
      env: environment,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  }
  const baseline = run();
  assert.equal(baseline.status, 0, baseline.output);
  assert.match(baseline.output, /^# tests 2$/mu);
  assert.match(baseline.output, /^# pass 2$/mu);
  assert.match(baseline.output, /^# skipped 0$/mu);
  const fieldOrder = actual.readers.map((reader) => {
    const returned = [...nodes(reader.node.body)].find(
      (node) =>
        node.type === "ReturnStatement" &&
        isRecord(node.argument) &&
        node.argument.type === "ObjectExpression",
    );
    assert.ok(
      returned && isRecord(returned.argument) && Array.isArray(returned.argument.properties),
    );
    const properties: unknown[] = returned.argument.properties;
    return {
      ...range(returned.argument),
      text:
        "{" +
        properties
          .slice()
          .reverse()
          .map((property) => source.slice(range(property).start, range(property).end))
          .join(",") +
        "}",
    };
  });
  writeFileSync(path.join(directory, production), edit(source, fieldOrder));
  const reordered = run();
  assert.equal(reordered.status, 0, reordered.output);
  assert.match(reordered.output, /^# pass 2$/mu);
  writeFileSync(path.join(directory, production), source);
  const cleanup = [...nodes(fallback.node.body)].find(
    (node) => node.type === "TryStatement" && isRecord(node.finalizer),
  );
  assert.ok(cleanup && isRecord(cleanup.block) && isRecord(cleanup.finalizer));
  const geometry = actual.readers[1];
  assert.ok(geometry);
  const image = [...nodes(geometry.node.body)].find(
    (node) =>
      node.type === "CallExpression" &&
      isRecord(node.callee) &&
      identifier(node.callee.property) === "querySelector" &&
      literal(args(node)[0]) === "img",
  );
  assert.ok(image);
  for (const mutation of [
    {
      marker: "color probe cleanup must run when style observation fails",
      source: edit(source, [
        {
          ...range(cleanup),
          text:
            source.slice(range(cleanup.block).start, range(cleanup.block).end) +
            source.slice(range(cleanup.finalizer).start, range(cleanup.finalizer).end),
        },
      ]),
    },
    {
      marker: "Measured artwork geometry",
      source: edit(source, [{ ...range(args(image)[0]), text: '":scope > span"' }]),
    },
  ]) {
    writeFileSync(path.join(directory, production), mutation.source);
    const rejected = run();
    assert.notEqual(rejected.status, 0, rejected.output);
    assert.match(
      rejected.output,
      /^not ok \d+ - serialized local artwork fallback preserves generated identity and geometry$/mu,
    );
    assert.ok(
      rejected.output.split("\n").some((line) => {
        const message = line.trimStart();
        return (
          message.startsWith("ARTWORK_CONTRACT_ASSERTION ") && message.includes(mutation.marker)
        );
      }),
      rejected.output,
    );
  }
  writeFileSync(path.join(directory, production), source);
  const adapterPath = path.join(directory, "apps/desktop/scripts/browser-script.mts");
  const adapterBytes = await readFile(adapterPath);
  writeFileSync(adapterPath, "export async function executeBrowserScript(){return {}};\n");
  try {
    const changed = run();
    assert.notEqual(changed.status, 0, changed.output);
    assert.match(
      changed.output,
      /^not ok \d+ - serialized local artwork fallback preserves generated identity and geometry$/mu,
    );
    assert.ok(
      changed.output.includes("ARTWORK_CONTRACT_ASSERTION Generated artwork fallback observation"),
      changed.output,
    );
  } finally {
    writeFileSync(adapterPath, adapterBytes);
  }
  const input = path.join(directory, transport),
    retained = input + ".retained-input";
  renameSync(input, retained);
  try {
    const missing = run();
    assert.notEqual(missing.status, 0, missing.output);
    assert.ok(
      missing.output.includes("ERR_MODULE_NOT_FOUND") &&
        missing.output.includes("transport-values"),
      missing.output,
    );
    assert.doesNotMatch(missing.output, /ARTWORK_CONTRACT_ASSERTION/u);
  } finally {
    renameSync(retained, input);
  }
});

function activeNativeSyntax(seed: unknown) {
  const result: Record<string, unknown>[] = [];
  function visit(value: unknown) {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isRecord(value)) return;
    if (
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
        String(value.type),
      )
    )
      return;
    result.push(value);
    if (value.type === "IfStatement" || value.type === "ConditionalExpression") {
      const truth = literal(value.test);
      if (truth === true || truth === false) {
        visit(truth ? value.consequent : value.alternate);
        return;
      }
    }
    if (value.type === "LogicalExpression") {
      const left = literal(value.left);
      visit(value.left);
      if ((value.operator === "&&" && left === false) || (value.operator === "||" && left === true))
        return;
      visit(value.right);
      return;
    }
    if (value.type === "BlockStatement" && Array.isArray(value.body)) {
      for (const child of value.body) {
        visit(child);
        if (isRecord(child) && ["ReturnStatement", "ThrowStatement"].includes(String(child.type)))
          break;
      }
      return;
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(seed);
  return result;
}

void test("desktop runner retains unresolved native custody through its live imported owner", async () => {
  const source = stripTypeScriptTypes(
    await readFile(new URL("../apps/desktop/scripts/desktop-test.mts", import.meta.url), "utf8"),
    { mode: "strip" },
  );
  function route(code: string) {
    const program = parseAst(code);
    assert.ok(isRecord(program) && Array.isArray(program.body));
    const syntax = [...nodes(program)];
    const statements: unknown[] = program.body;
    const imports = (owner: string, name: string) =>
      syntax
        .filter((node) => node.type === "ImportDeclaration" && literal(node.source) === owner)
        .flatMap((node) => {
          assert.ok(Array.isArray(node.specifiers));
          return node.specifiers
            .filter(isRecord)
            .filter((item) => (identifier(item.imported) ?? literal(item.imported)) === name)
            .map((item) => ({ node: item, local: identifier(item.local) }));
        });
    const functions = (statements: unknown[]) =>
      statements.flatMap((statement) => {
        if (!isRecord(statement)) return [];
        if (statement.type === "FunctionDeclaration")
          return [
            { statement, fn: statement, name: identifier(statement.id), binding: statement.id },
          ];
        if (statement.type !== "VariableDeclaration" || !Array.isArray(statement.declarations))
          return [];
        return statement.declarations.filter(isRecord).flatMap((declaration) =>
          isRecord(declaration.init) &&
          ["FunctionExpression", "ArrowFunctionExpression"].includes(String(declaration.init.type))
            ? [
                {
                  statement,
                  fn: declaration.init,
                  name: identifier(declaration.id),
                  binding: declaration.id,
                },
              ]
            : [],
        );
      });
    const top = functions(statements);
    const sessionImports = imports("./desktop-owned-native-session.mts", "OwnedNativeSession");
    const instances = statements
      .filter(isRecord)
      .filter((node) => node.type === "VariableDeclaration" && Array.isArray(node.declarations))
      .flatMap((node) => {
        assert.ok(Array.isArray(node.declarations));
        return node.declarations
          .filter(isRecord)
          .filter((declaration) => {
            const init = declaration.init;
            return (
              isRecord(init) &&
              init.type === "NewExpression" &&
              sessionImports.some((binding) => binding.local === identifier(init.callee))
            );
          })
          .map((declaration) => identifier(declaration.id));
      });
    assert.equal(
      instances.length,
      1,
      "Runner must construct the actual imported native session owner",
    );
    const finalizers = statements
      .filter(isRecord)
      .filter((node) => node.type === "TryStatement")
      .map((node) => node.finalizer);
    const finalCalls = activeNativeSyntax(finalizers)
      .map(awaited)
      .filter((node) => node !== undefined);
    const release = top
      .filter((entry) => finalCalls.some((call) => identifier(call.callee) === entry.name))
      .flatMap((entry) =>
        activeNativeSyntax(entry.fn.body)
          .filter((node) => node.type === "TryStatement" && isRecord(node.handler))
          .filter((node) =>
            activeNativeSyntax(node.block)
              .map(awaited)
              .some(
                (call) =>
                  isRecord(call?.callee) &&
                  call.callee.type === "MemberExpression" &&
                  instances.includes(identifier(call.callee.object)) &&
                  (identifier(call.callee.property) ?? literal(call.callee.property)) ===
                    "releaseResources",
              ),
          )
          .map((guard) => ({ entry, guard })),
      );
    assert.equal(release.length, 1, "Runner finally must await its real native release wrapper");
    const selected = release[0];
    assert.ok(selected && isRecord(selected.guard.handler));
    const catchParameter = identifier(selected.guard.handler.param);
    const retained = activeNativeSyntax(selected.guard.handler.body)
      .map(awaited)
      .filter(
        (call) => call && args(call).length === 1 && identifier(args(call)[0]) === catchParameter,
      )
      .flatMap((call) => top.filter((entry) => entry.name === identifier(call?.callee)));
    assert.equal(
      retained.length,
      1,
      "Release failure must await its actual custody retainer with the caught error",
    );
    const wrapper = retained[0];
    assert.ok(wrapper && isRecord(wrapper.fn.body) && Array.isArray(wrapper.fn.body.body));
    const ownerImports = imports("./desktop-owned-native-session.mts", "retainNativeCustody");
    const returns = activeNativeSyntax(wrapper.fn.body)
      .filter((node) => node.type === "ReturnStatement")
      .map((node) =>
        isRecord(node.argument) && node.argument.type === "AwaitExpression"
          ? node.argument.argument
          : node.argument,
      )
      .filter(isRecord)
      .filter(
        (call) =>
          call.type === "CallExpression" &&
          ownerImports.some((binding) => binding.local === identifier(call.callee)),
      );
    assert.equal(
      returns.length,
      1,
      "Actual custody retainer must return its imported required-capability operation",
    );
    const call = returns[0];
    assert.ok(call && args(call).length === 1 && isRecord(args(call)[0]));
    const capabilities = args(call)[0];
    assert.ok(
      isRecord(capabilities) &&
        capabilities.type === "ObjectExpression" &&
        Array.isArray(capabilities.properties),
    );
    const locals = functions(wrapper.fn.body.body);
    const properties: unknown[] = capabilities.properties;
    const capability = (name: string) => {
      const entries = properties
        .filter(isRecord)
        .filter(
          (node) =>
            node.type === "Property" &&
            node.kind === "init" &&
            (identifier(node.key) ?? literal(node.key)) === name,
        );
      assert.equal(entries.length, 1, "One actual " + name + " custody capability");
      const property = entries[0];
      assert.ok(property && isRecord(property.value));
      const fn = ["FunctionExpression", "ArrowFunctionExpression"].includes(
        String(property.value.type),
      )
        ? property.value
        : [...locals, ...top].find((entry) => entry.name === identifier(property.value))?.fn;
      assert.ok(fn, "Custody capability resolves to its actual function");
      return { property, fn };
    };
    const publish = capability("publish"),
      hold = capability("hold");
    capability("reportPublicationFailure");
    capability("reportRetained");
    const writeBindings = imports("node:fs/promises", "writeFile");
    const publication = activeNativeSyntax(publish.fn.body);
    const writes = publication.filter(
      (node) =>
        node.type === "CallExpression" &&
        writeBindings.some((binding) => binding.local === identifier(node.callee)),
    );
    assert.equal(writes.length, 1, "Custody publication must invoke the real file writer");
    const write = writes[0];
    assert.ok(write);
    assert.ok(
      publish.fn.body === write ||
        publication.some(
          (node) =>
            (node.type === "AwaitExpression" || node.type === "ReturnStatement") &&
            node.argument === write,
        ),
      "Custody publication must join the real file writer promise",
    );
    const options = args(write)[2];
    assert.ok(
      isRecord(options) &&
        Array.isArray(options.properties) &&
        options.properties.some(
          (node) =>
            isRecord(node) &&
            (identifier(node.key) ?? literal(node.key)) === "flag" &&
            literal(node.value) === "wx",
        ),
      "Custody publication must retain exclusive evidence creation",
    );
    const held = activeNativeSyntax(hold.fn.body);
    const timer = held.find(
      (node) => node.type === "CallExpression" && identifier(node.callee) === "setInterval",
    );
    const unref = held.some(
      (node) =>
        node.type === "CallExpression" &&
        isRecord(node.callee) &&
        (identifier(node.callee.property) ?? literal(node.callee.property)) === "unref",
    );
    const pending = held.find(
      (node) =>
        node.type === "ReturnStatement" &&
        isRecord(node.argument) &&
        node.argument.type === "NewExpression" &&
        identifier(node.argument.callee) === "Promise",
    );
    assert.ok(
      timer && !unref && pending && isRecord(pending.argument),
      "Custody hold keeps a referenced timer and returns a never-settling promise",
    );
    const executor = args(pending.argument)[0];
    assert.ok(
      isRecord(executor) &&
        Array.isArray(executor.params) &&
        executor.params.every((parameter) => identifier(parameter) !== undefined) &&
        isRecord(executor.body) &&
        Array.isArray(executor.body.body) &&
        executor.body.body.length === 0,
      "Custody hold has no early settlement or parameter effects",
    );
    return { syntax, wrapper, call, ownerImports, hold, publish, write, pending, timer };
  }
  const observed = route(source);
  const owner = observed.ownerImports.find(
    (binding) => binding.local === identifier(observed.call.callee),
  );
  assert.ok(owner && isRecord(owner.node.local) && isRecord(observed.wrapper.binding));
  const rename = (name: string | undefined, alias: string, binding: unknown) => [
    { ...range(binding), text: alias },
    ...observed.syntax
      .filter((node) => node.type === "CallExpression" && identifier(node.callee) === name)
      .map((node) => ({ ...range(node.callee), text: alias })),
  ];
  const aliases = edit(source, [
    ...rename(owner.local, "$renamedRequiredRetainer", owner.node.local),
    ...rename(observed.wrapper.name, "$renamedCustodyWrapper", observed.wrapper.binding),
  ]);
  route(aliases);
  const aliased = route(aliases);
  route(
    edit(aliases, [
      { ...range(aliased.wrapper.statement), text: "/* hoisted custody declaration moved */" },
    ]) +
      "\n" +
      aliases.slice(range(aliased.wrapper.statement).start, range(aliased.wrapper.statement).end),
  );
  route(aliases.replaceAll("\n", "\r\n"));
  assert.ok(isRecord(observed.pending.argument));
  const pendingExecutor = args(observed.pending.argument)[0];
  assert.ok(isRecord(pendingExecutor));
  route(
    edit(source, [{ ...range(pendingExecutor), text: "(_unusedResolve, _unusedReject) => {}" }]),
  );
  const reject = (code: string, message: RegExp) =>
    assert.throws(() => route(code), { name: "AssertionError", message });
  assert.ok(isRecord(observed.wrapper.fn.body));
  const body = range(observed.wrapper.fn.body);
  reject(
    edit(source, [{ start: body.start + 1, end: body.start + 1, text: "return;" }]),
    /Actual custody retainer must return its imported/u,
  );
  const writer = source.slice(range(observed.write).start, range(observed.write).end);
  reject(
    edit(source, [
      {
        ...range(observed.publish.property.value),
        text: "() => { " + writer + "; return Promise.resolve(); }",
      },
    ]),
    /Custody publication must join the real file writer promise/u,
  );
  reject(
    edit(source, [{ ...range(observed.call.callee), text: "$wrongRetainer" }]) +
      "\nfunction $unusedRetainer(){return " +
      owner.local +
      "({});}\n",
    /Actual custody retainer must return its imported/u,
  );
  reject(
    edit(source, [{ ...range(observed.publish.property.value), text: "async () => {}" }]),
    /Custody publication must invoke the real file writer/u,
  );
  reject(
    edit(source, [
      {
        ...range(observed.timer),
        text: source.slice(range(observed.timer).start, range(observed.timer).end) + ".unref()",
      },
    ]),
    /Custody hold keeps a referenced timer/u,
  );
  reject(
    edit(source, [{ ...range(observed.pending.argument), text: "Promise.resolve()" }]),
    /Custody hold keeps a referenced timer/u,
  );
});

void test("recovery and rejected artwork intent use their actual serialized observation owners", async () => {
  const families = [
    {
      file: "desktop-bootstrap-recovery-test.mts",
      owner: "preferencesRecoveryScenario",
      operation: "observeTechnicalDetails",
    },
    {
      file: "desktop-artwork-correction-test.mts",
      owner: "artworkCorrectionScenario",
      operation: "repeatReviewedCatalogIntent",
    },
  ];
  for (const family of families) {
    const original = stripTypeScriptTypes(
      await readFile(new URL("../apps/desktop/scripts/" + family.file, import.meta.url), "utf8"),
      { mode: "strip" },
    );
    function inspect(code: string) {
      const syntax = [...nodes(parseAst(code))];
      function exported(name: string) {
        let local = name;
        const alias = syntax.find(
          (node) =>
            node.type === "ExportSpecifier" &&
            (identifier(node.exported) ?? literal(node.exported)) === name,
        );
        if (alias) local = requiredIdentifier(alias.local);
        const named = syntax.find(
          (node) => node.type === "FunctionDeclaration" && identifier(node.id) === local,
        );
        const variable = syntax.find(
          (node) =>
            node.type === "VariableDeclarator" &&
            identifier(node.id) === local &&
            isRecord(node.init) &&
            ["ArrowFunctionExpression", "FunctionExpression"].includes(String(node.init.type)),
        );
        const declaration = named ?? (isRecord(variable?.init) ? variable.init : undefined);
        assert.ok(declaration && isRecord(declaration.body));
        assert.ok(
          syntax.some(
            (node) =>
              node.type === "ExportNamedDeclaration" &&
              (node.declaration === named ||
                (isRecord(node.declaration) &&
                  node.declaration.type === "VariableDeclaration" &&
                  Array.isArray(node.declaration.declarations) &&
                  node.declaration.declarations.includes(variable)) ||
                (Array.isArray(node.specifiers) && node.specifiers.includes(alias))),
          ),
        );
        const form =
          named ??
          syntax.find(
            (node) =>
              node.type === "VariableDeclaration" &&
              Array.isArray(node.declarations) &&
              node.declarations.includes(variable),
          );
        assert.ok(form);
        const statement =
          syntax.find(
            (node) => node.type === "ExportNamedDeclaration" && node.declaration === form,
          ) ?? form;
        return { declaration, statement, local, body: declaration.body };
      }
      function requiredIdentifier(value: unknown): string {
        const name = identifier(value);
        assert.ok(name);
        return name;
      }
      const owner = exported(family.owner),
        operation = exported(family.operation);
      const parameters = owner.declaration.params;
      assert.ok(Array.isArray(parameters));
      const first: unknown = parameters[0];
      assert.ok(
        isRecord(first) && first.type === "ObjectPattern" && Array.isArray(first.properties),
      );
      const properties: unknown[] = first.properties;
      const browserProperty = properties.find(
        (value) => isRecord(value) && identifier(value.key) === "browser",
      );
      assert.ok(isRecord(browserProperty));
      const browser = requiredIdentifier(browserProperty.value);
      let body = owner.body;
      if (family.operation === "repeatReviewedCatalogIntent") {
        const journey = [...nodes(body)].find(
          (node) => literal(args(awaited(node))[0]) === "native-artwork-catalog-correction",
        );
        const callback = args(awaited(journey))[1];
        assert.ok(isRecord(callback) && isRecord(callback.body));
        body = callback.body;
      }
      assert.ok(Array.isArray(body.body));
      const live = body.body.filter(isRecord);
      const calls = [...nodes(body)].filter(
        (node) => identifier(awaited(node)?.callee) === operation.local,
      );
      assert.equal(calls.length, 1, "Actual caller must await its observation owner");
      const call = awaited(calls[0]);
      assert.ok(call);
      const statement = live.find((node) => [...nodes(node)].includes(call));
      assert.ok(
        statement &&
          statement.type === "VariableDeclaration" &&
          Array.isArray(statement.declarations),
        "Observation must initialize a live consumed value",
      );
      const declarations: unknown[] = statement.declarations;
      const consumed = declarations.find(
        (node) => isRecord(node) && [...nodes(node)].includes(call),
      );
      assert.ok(isRecord(consumed));
      let initializer = consumed.init;
      if (family.operation === "repeatReviewedCatalogIntent") {
        while (isRecord(initializer) && initializer.type === "CallExpression") {
          assert.ok(
            isRecord(initializer) &&
              initializer.type === "CallExpression" &&
              args(initializer).length === 1,
            "Observation must initialize a live consumed value",
          );
          initializer = args(initializer)[0];
        }
      }
      assert.equal(awaited(initializer), call, "Observation must initialize a live consumed value");
      assert.ok(
        !live.slice(0, live.indexOf(statement)).some((node) => node.type === "ReturnStatement"),
        "Observation must remain reachable",
      );
      assert.equal(identifier(args(call)[0]), browser, "Pass the current scenario browser");
      if (family.operation === "observeTechnicalDetails") {
        const failure = live
          .flatMap((node) => [...nodes(node)])
          .find(
            (node) =>
              node.type === "VariableDeclarator" &&
              isRecord(node.init) &&
              node.init.type === "AwaitExpression" &&
              isRecord(node.init.argument) &&
              isRecord(node.init.argument.callee) &&
              node.init.argument.callee.type === "MemberExpression" &&
              identifier(node.init.argument.callee.object) === browser &&
              identifier(node.init.argument.callee.property) === "wait",
          );
        assert.ok(failure);
        assert.equal(identifier(args(call)[1]), identifier(failure.id));
        assert.equal(args(call).length, 2);
      } else {
        const plan = [...nodes(body)].find(
          (node) =>
            node.type === "VariableDeclarator" &&
            isRecord(node.init) &&
            literal(args(node.init)[0]) === "catalog_update_plan",
        );
        assert.ok(plan);
        const planName = requiredIdentifier(plan.id);
        for (const [index, field] of ["source", "plan_sha256"].entries()) {
          const argument: unknown = args(call)[index + 1];
          assert.ok(isRecord(argument) && argument.type === "MemberExpression");
          assert.equal(identifier(argument.object), planName);
          assert.equal(identifier(argument.property), field, "Pass reviewed intent " + field);
        }
        assert.equal(args(call).length, 3);
      }
      const operationParameters = operation.declaration.params;
      assert.ok(Array.isArray(operationParameters));
      const receiver = requiredIdentifier(operationParameters[0]);
      const returned = [...nodes(operation.body)].find((node) => node.type === "ReturnStatement");
      assert.ok(
        returned && isRecord(returned.argument) && returned.argument.type === "CallExpression",
      );
      const transport = returned.argument;
      if (family.operation === "observeTechnicalDetails") {
        const specifiers = syntax
          .filter(
            (node) =>
              node.type === "ImportDeclaration" && literal(node.source) === "./browser-script.mts",
          )
          .flatMap((node) => {
            assert.ok(Array.isArray(node.specifiers));
            const entries: unknown[] = node.specifiers;
            return entries.filter(isRecord);
          });
        const binding = specifiers.find(
          (node) =>
            identifier(node.imported) === "executeBrowserScript" &&
            identifier(node.local) === identifier(transport.callee),
        );
        assert.ok(binding, "Use the actual imported serialization dependency");
        assert.equal(identifier(args(transport)[0]), receiver);
      } else {
        assert.ok(isRecord(transport.callee) && transport.callee.type === "MemberExpression");
        assert.equal(identifier(transport.callee.object), receiver);
        assert.equal(
          identifier(transport.callee.property),
          "executeAsyncScript",
          "Use actual async serialization dependency",
        );
      }
      return { operation, call, transport, statement, consumed, awaitNode: calls[0] };
    }
    const captured = inspect(original);
    const declarationRange = range(captured.operation.statement);
    const declaration = original.slice(declarationRange.start, declarationRange.end);
    inspect(
      original.slice(0, declarationRange.start) +
        original.slice(declarationRange.end) +
        "\n" +
        declaration,
    );
    const renamed =
      original
        .replaceAll(captured.operation.local, "$renamedObservation")
        .replace("export function $renamedObservation", "function $renamedObservation") +
      "\nexport {$renamedObservation as " +
      family.operation +
      "};\n";
    inspect(renamed.replaceAll("\n", "\r\n"));
    const wrongCaller = edit(original, [
      { ...range(captured.call.callee), text: "$unusedReplacement" },
    ]);
    assert.throws(
      () => inspect(wrongCaller + "\nasync function $unusedReplacement() {}"),
      /Actual caller must await/,
    );
    const fn = captured.operation.declaration;
    assert.ok(Array.isArray(fn.params));
    const parameterList = fn.params
      .map((value) => original.slice(range(value).start, range(value).end))
      .join(",");
    if (fn.type === "FunctionDeclaration")
      inspect(
        edit(original, [
          {
            ...range(fn),
            text:
              "const " +
              captured.operation.local +
              " = (" +
              parameterList +
              ") => " +
              original.slice(range(fn.body).start, range(fn.body).end) +
              ";",
          },
        ]),
      );
    if (family.operation === "repeatReviewedCatalogIntent") {
      const initRange = range(captured.consumed.init),
        awaitRange = range(captured.awaitNode);
      const decoder =
        original.slice(initRange.start, awaitRange.start) +
        "value" +
        original.slice(awaitRange.end, initRange.end);
      const factored = edit(original, [
        {
          ...initRange,
          text: "$decodeReviewedIntent(" + original.slice(awaitRange.start, awaitRange.end) + ")",
        },
      ]);
      inspect(factored + "\nfunction $decodeReviewedIntent(value) {return " + decoder + ";}\n");
    }
    const dead = edit(original, [
      {
        ...range(captured.awaitNode),
        text:
          "false && (" +
          original.slice(range(captured.awaitNode).start, range(captured.awaitNode).end) +
          ")",
      },
    ]);
    const nestedDecoy = edit(original, [
      { ...range(captured.call.callee), text: "$unusedReplacement" },
      {
        start: range(captured.statement).start,
        end: range(captured.statement).start,
        text:
          "async function $unusedObservation() {await " +
          original.slice(range(captured.call).start, range(captured.call).end) +
          ";}\n",
      },
    ]);
    assert.throws(() => inspect(nestedDecoy), /live consumed value/);
    assert.throws(() => inspect(dead), /live consumed value|Actual caller must await/);
    if (family.operation === "observeTechnicalDetails") {
      inspect(
        'import "./browser-script.mts";\nimport {executeBrowserScript as $unusedReader} from "./browser-script.mts";\n' +
          original,
      );
      assert.throws(
        () =>
          inspect(
            edit(original, [{ ...range(captured.transport.callee), text: "$wrongSerialization" }]),
          ),
        /actual imported serialization dependency/,
      );
    } else {
      const callee = captured.transport.callee;
      assert.ok(isRecord(callee));
      assert.throws(
        () => inspect(edit(original, [{ ...range(callee.property), text: "executeScript" }])),
        /actual async serialization dependency/,
      );
      const plan = args(captured.call)[2];
      assert.ok(isRecord(plan));
      assert.throws(
        () => inspect(edit(original, [{ ...range(plan.property), text: "unreviewed_sha256" }])),
        /Pass reviewed intent plan_sha256/,
      );
    }
  }
});

function indexDesktopCaller(code: string) {
  const ast = parseAst(code),
    all = [...nodes(ast)];
  const parents = new WeakMap<object, Record<string, unknown>>();
  for (const node of all)
    for (const [key, value] of Object.entries(node))
      if (key !== "loc") {
        if (Array.isArray(value)) {
          for (const child of value) if (isRecord(child)) parents.set(child, node);
        } else if (isRecord(value)) parents.set(value, node);
      }
  const parent = (child: unknown) => (isRecord(child) ? parents.get(child) : undefined);
  const functionNode = (node: Record<string, unknown>) =>
    ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
      String(node.type),
    );
  const functions = all.filter(functionNode);
  const owner = (node: unknown) =>
    functions
      .filter((fn) => range(fn).start < range(node).start && range(fn).end > range(node).end)
      .sort((a, b) => range(a).end - range(a).start - range(b).end + range(b).start)[0];
  const binding = (fn: Record<string, unknown>) =>
    fn.type === "FunctionDeclaration" ? identifier(fn.id) : identifier(parent(fn)?.id);
  const scope = (fn: Record<string, unknown>) =>
    all
      .filter(
        (node) =>
          ["Program", "BlockStatement"].includes(String(node.type)) &&
          range(node).start <= range(fn).start &&
          range(node).end >= range(fn).end,
      )
      .sort((a, b) => range(a).end - range(a).start - range(b).end + range(b).start)[0];
  const resolve = (name: string | undefined, at: unknown) =>
    functions
      .filter(
        (fn) =>
          binding(fn) === name &&
          scope(fn) &&
          range(scope(fn)).start <= range(at).start &&
          range(scope(fn)).end >= range(at).end,
      )
      .sort(
        (a, b) =>
          range(scope(a)).end - range(scope(a)).start - range(scope(b)).end + range(scope(b)).start,
      )[0];
  const imports = (module: string, symbol: string) =>
    new Set(
      all
        .filter((node) => node.type === "ImportDeclaration" && literal(node.source) === module)
        .flatMap((node) => (Array.isArray(node.specifiers) ? node.specifiers.filter(isRecord) : []))
        .filter((node) =>
          symbol === "default"
            ? node.type === "ImportDefaultSpecifier"
            : (identifier(node.imported) ?? literal(node.imported)) === symbol,
        )
        .map((node) => identifier(node.local)),
    );
  const direct = (call: Record<string, unknown>) => {
    const wrapper = parent(call),
      expression = wrapper?.type === "AwaitExpression" ? parent(wrapper) : wrapper;
    if (expression?.type !== "ExpressionStatement") return false;
    const block = parent(expression),
      fn = owner(call);
    if (!block) return false;
    if (
      !Array.isArray(block.body) ||
      block.body
        .slice(0, block.body.indexOf(expression))
        .some(
          (node) =>
            isRecord(node) && ["ReturnStatement", "ThrowStatement"].includes(String(node.type)),
        )
    )
      return false;
    if (block === (fn?.body ?? ast)) return true;
    const container = parent(block);
    return (
      !!container &&
      ((container.type === "TryStatement" && container.block === block) ||
        (container.type === "ForOfStatement" && container.body === block)) &&
      parent(container) === (fn?.body ?? ast)
    );
  };
  const calls = (fn: Record<string, unknown>) =>
    all.filter(
      (node) =>
        node.type === "CallExpression" &&
        identifier(node.callee) === binding(fn) &&
        resolve(identifier(node.callee), node) === fn &&
        direct(node),
    );
  const slots = (call: Record<string, unknown>) => {
    const input = args(call)[0];
    assert.ok(
      isRecord(input) && input.type === "ObjectExpression" && Array.isArray(input.properties),
      "Runtime caller options",
    );
    return new Map(
      input.properties
        .filter(isRecord)
        .map((node) => [identifier(node.key) ?? literal(node.key), node.value]),
    );
  };
  return { ast, all, parent, owner, binding, resolve, imports, direct, calls, slots };
}

void test("native runtime callers retain imported custody and ordinary-close wiring", async () => {
  // These are the two changed call boundaries. Startup policy and native
  // serialization retain their existing suites; whole-owner tests own behavior.
  const index = indexDesktopCaller;
  const property = (node: unknown, name: string) =>
    isRecord(node) &&
    node.type === "MemberExpression" &&
    (identifier(node.property) ?? literal(node.property)) === name;
  const same = (a: unknown, b: unknown, message: string) => {
    assert.ok(identifier(a) && identifier(b), message);
    assert.equal(identifier(a), identifier(b), message);
  };
  const driverSource = stripTypeScriptTypes(
    await readFile(new URL("../apps/desktop/scripts/desktop-test.mts", import.meta.url), "utf8"),
    { mode: "strip" },
  );
  const closeSource = stripTypeScriptTypes(
    await readFile(
      new URL("../apps/desktop/scripts/desktop-real-runtime-test.mts", import.meta.url),
      "utf8",
    ),
    { mode: "strip" },
  );
  function driver(code: string) {
    const m = index(code),
      classes = m.imports("./desktop-owned-native-session.mts", "OwnedNativeSession");
    const instances = m.all.filter(
      (node) =>
        node.type === "VariableDeclarator" &&
        isRecord(node.init) &&
        node.init.type === "NewExpression" &&
        classes.has(identifier(node.init.callee)) &&
        !m.owner(node),
    );
    assert.equal(instances.length, 1, "Construct actual native custody owner");
    const receiver = identifier(instances[0]!.id);
    assert.ok(receiver);
    const calls = m.all.filter(
      (node) =>
        node.type === "CallExpression" &&
        property(node.callee, "captureDriverLaunch") &&
        isRecord(node.callee) &&
        identifier(node.callee.object) === receiver &&
        m.direct(node),
    );
    assert.equal(calls.length, 1, "Consume actual driver capture boundary");
    const call = calls[0]!,
      fn = m.owner(call);
    assert.ok(fn && Array.isArray(fn.params));
    const callers = m.calls(fn);
    assert.equal(callers.length, 1, "Selected driver route consumes capture boundary");
    const selected = m.owner(callers[0]!);
    assert.ok(selected && Array.isArray(selected.params));
    same(args(callers[0])[0], selected.params[0], "Forward selected launch timestamp");
    const starts = m.calls(selected);
    assert.equal(starts.length, 1, "Startup consumes selected driver capture");
    const start = m.owner(starts[0]!);
    assert.ok(
      start && m.calls(start).some((node) => !m.owner(node)),
      "Actual entrypoint consumes driver startup",
    );
    const slots = m.slots(call),
      pid = slots.get("pid");
    assert.ok(
      property(pid, "pid") &&
        isRecord(pid) &&
        isRecord(pid.object) &&
        pid.object.type === "CallExpression",
      "Capture actual driver PID",
    );
    const child = identifier(args(pid.object)[0]);
    assert.ok(child, "Capture actual driver PID");
    const launches = m.all.filter(
      (node) =>
        node.type === "AssignmentExpression" &&
        identifier(node.left) === child &&
        isRecord(node.right) &&
        node.right.type === "CallExpression" &&
        property(node.right.callee, "startLaunch") &&
        isRecord(node.right.callee) &&
        identifier(node.right.callee.object) === receiver,
    );
    const spawned = launches.flatMap((node) => {
      assert.ok(isRecord(node.right));
      const value = m.slots(node.right).get("create");
      const factory =
        isRecord(value) &&
        ["FunctionExpression", "ArrowFunctionExpression"].includes(String(value.type))
          ? value
          : m.resolve(identifier(value), node.right);
      if (!factory || !isRecord(factory.body)) return [];
      const returned = activeNativeSyntax(factory.body).filter(
        (item) => item.type === "ReturnStatement" && m.parent(item) === factory.body,
      );
      const created =
        factory.body.type === "CallExpression"
          ? factory.body
          : returned.length === 1
            ? returned[0]!.argument
            : undefined;
      return isRecord(created) &&
        created.type === "CallExpression" &&
        m.imports("node:child_process", "spawn").has(identifier(created.callee))
        ? [created]
        : [];
    });
    assert.equal(spawned.length, 1, "Capture current spawned driver");
    same(slots.get("executable"), args(spawned[0])[0], "Capture selected executable");
    same(slots.get("launchStarted"), fn.params[0], "Forward original launch timestamp");
    const observer = m.resolve(identifier(slots.get("observe")), call);
    assert.ok(observer && Array.isArray(observer.params), "Consume native observer");
    const returns = [...nodes(observer.body)].filter(
      (node) =>
        node.type === "ReturnStatement" &&
        m.parent(node) === observer.body &&
        isRecord(node.argument) &&
        node.argument.type === "CallExpression" &&
        m
          .imports("./desktop-owned-native-session.mts", "readNativeSessionObservation")
          .has(identifier(node.argument.callee)),
    );
    assert.equal(returns.length, 1, "Consume parsed native observation");
    return { m, call, slots, fn, providerReturn: returns[0]!, provider: observer };
  }
  function close(code: string) {
    const m = index(code);
    const publicBinding = (symbol: string) => {
      for (const node of m.all.filter((node) => node.type === "ExportNamedDeclaration")) {
        if (isRecord(node.declaration)) {
          if (identifier(node.declaration.id) === symbol) return symbol;
          if (
            Array.isArray(node.declaration.declarations) &&
            node.declaration.declarations
              .filter(isRecord)
              .some((item) => identifier(item.id) === symbol)
          )
            return symbol;
        }
        if (Array.isArray(node.specifiers))
          for (const spec of node.specifiers.filter(isRecord))
            if ((identifier(spec.exported) ?? literal(spec.exported)) === symbol)
              return identifier(spec.local);
      }
      assert.fail("Public runtime operation " + symbol);
    };
    const helper = m.resolve(publicBinding("requestRealRuntimeClose"), m.ast);
    assert.ok(helper);
    const calls = m.calls(helper);
    assert.equal(calls.length, 1, "Live runtime consumes close boundary");
    const call = calls[0]!,
      fn = m.owner(call);
    assert.ok(fn && Array.isArray(fn.params));
    const callers = m.calls(fn);
    assert.equal(callers.length, 1, "Actual runtime routes consume launch boundary");
    const routeOwner = m.owner(callers[0]!);
    assert.ok(routeOwner);
    const publicOwner = m.resolve(publicBinding("realRuntimeScenario"), m.ast);
    assert.ok(
      publicOwner && m.calls(routeOwner).some((node) => m.owner(node) === publicOwner),
      "Public runtime scenario consumes routes",
    );
    const awaited = m.parent(call);
    assert.ok(awaited?.type === "AwaitExpression", "Await positive close completion");
    const statement = m.parent(awaited),
      block = statement && m.parent(statement);
    assert.ok(block && Array.isArray(block.body));
    const finalizer = m.parent(block);
    assert.ok(
      finalizer?.type === "TryStatement" &&
        isRecord(finalizer.finalizer) &&
        Array.isArray(finalizer.finalizer.body),
    );
    const gate = finalizer.finalizer.body
      .filter(isRecord)
      .find(
        (node) =>
          node.type === "IfStatement" &&
          isRecord(node.test) &&
          node.test.type === "LogicalExpression" &&
          isRecord(node.test.right) &&
          node.test.right.type === "UnaryExpression" &&
          node.test.right.operator === "!",
      );
    assert.ok(gate && isRecord(gate.test) && isRecord(gate.test.right));
    const exit = identifier(gate.test.right.argument);
    assert.ok(exit);
    const completions = block.body
      .filter(isRecord)
      .filter(
        (node) =>
          node.type === "ExpressionStatement" &&
          isRecord(node.expression) &&
          node.expression.type === "AssignmentExpression" &&
          identifier(node.expression.left) === exit &&
          literal(node.expression.right) === true &&
          range(node).start > range(call).end &&
          m.direct(node.expression),
      );
    assert.equal(completions.length, 1, "Record natural exit after joined close");
    const completed = completions[0]!.expression;
    assert.ok(isRecord(completed));
    const slots = m.slots(call);
    assert.ok(
      m.imports("node:fs/promises", "writeFile").has(identifier(slots.get("write"))),
      "Use actual exclusive evidence writer",
    );
    const observerIndex = fn.params.findIndex(
      (param) => identifier(param) === identifier(slots.get("native")),
    );
    assert.ok(observerIndex >= 0, "Forward actual native observer");
    const provider = m.resolve(identifier(args(callers[0])[observerIndex]), callers[0]!);
    assert.ok(provider, "Forward actual native observer");
    const returns = [...nodes(provider.body)].filter(
      (node) =>
        node.type === "ReturnStatement" &&
        m.parent(node) === provider.body &&
        isRecord(node.argument) &&
        node.argument.type === "CallExpression" &&
        m
          .imports("./desktop-owned-native-session.mts", "readNativeSessionObservation")
          .has(identifier(node.argument.callee)),
    );
    assert.equal(returns.length, 1, "Forward parsed native observations");
    const snapshots = m.all.filter(
      (node) =>
        node.type === "CallExpression" &&
        identifier(node.callee) === identifier(slots.get("native")) &&
        literal(args(node)[0]) === "Snapshot" &&
        m.owner(node) === fn,
    );
    assert.equal(snapshots.length, 1);
    same(slots.get("closeFile"), args(snapshots[0])[1], "Close current captured game identity");
    const snapshotArgs = args(snapshots[0])[2];
    assert.ok(isRecord(snapshotArgs) && Array.isArray(snapshotArgs.elements));
    const app = snapshotArgs.elements.findIndex((node) => literal(node) === "-ApplicationPath");
    assert.ok(app >= 0);
    same(
      slots.get("executable"),
      snapshotArgs.elements[app + 1],
      "Close current captured game executable",
    );
    const context = identifier(fn.params[0]),
      item = identifier(fn.params[1]);
    const local = (from: string | undefined, key: string) => {
      const declaration = m.all.find(
        (node) =>
          node.type === "VariableDeclarator" &&
          identifier(node.init) === from &&
          m.owner(node) === fn &&
          isRecord(node.id) &&
          node.id.type === "ObjectPattern" &&
          Array.isArray(node.id.properties) &&
          node.id.properties
            .filter(isRecord)
            .some((part) => (identifier(part.key) ?? literal(part.key)) === key),
      );
      assert.ok(
        declaration && isRecord(declaration.id) && Array.isArray(declaration.id.properties),
      );
      return declaration.id.properties
        .filter(isRecord)
        .find((part) => (identifier(part.key) ?? literal(part.key)) === key)?.value;
    };
    same(
      slots.get("artifacts"),
      local(context, "artifacts"),
      "Append to current runtime report artifacts",
    );
    const routeIndex = fn.params.findIndex(
      (param) => identifier(param) === identifier(slots.get("route")),
    );
    assert.ok(routeIndex >= 0, "Record in current runtime route");
    const incoming = identifier(args(callers[0])[routeIndex]),
      record = m.all.find(
        (node) =>
          node.type === "VariableDeclarator" &&
          identifier(node.id) === incoming &&
          m.owner(node) === routeOwner,
      );
    assert.ok(
      record &&
        isRecord(record.init) &&
        record.init.type === "ObjectExpression" &&
        Array.isArray(record.init.properties) &&
        record.init.properties
          .filter(isRecord)
          .some((part) => (identifier(part.key) ?? literal(part.key)) === "port_id"),
      "Record in current runtime route",
    );
    const file = slots.get("requestFile");
    assert.ok(
      isRecord(file) &&
        file.type === "CallExpression" &&
        property(file.callee, "join") &&
        isRecord(file.callee) &&
        m.imports("node:path", "default").has(identifier(file.callee.object)),
      "Port-derived close request receipt",
    );
    same(args(file)[0], local(context, "output"), "Port-derived close request receipt");
    const name = args(file)[1];
    assert.ok(
      isRecord(name) &&
        name.type === "TemplateLiteral" &&
        Array.isArray(name.quasis) &&
        Array.isArray(name.expressions),
      "Port-derived close request receipt",
    );
    assert.deepEqual(
      name.quasis
        .filter(isRecord)
        .map((part) => (isRecord(part.value) ? part.value.cooked : undefined)),
      ["", "-ordinary-close-request.json"],
      "Port-derived close request receipt",
    );
    const id: unknown = name.expressions[0];
    assert.ok(
      name.expressions.length === 1 && property(id, "id") && isRecord(id),
      "Port-derived close request receipt",
    );
    same(id.object, local(item, "port"), "Port-derived close request receipt");
    return { m, call, slots, fn, completed, providerReturn: returns[0]!, provider };
  }
  const d = driver(driverSource),
    c = close(closeSource);
  for (const [source, check, fn] of [
    [driverSource, driver, d.fn],
    [closeSource, close, c.fn],
  ] as const) {
    check(source.replaceAll("\n", "\r\n\n"));
    const name = (source === driverSource ? d.m : c.m).binding(fn);
    assert.ok(name);
    const changed = source.replaceAll(name, "$renamedRuntimeBoundary");
    check(changed);
    if (fn.type === "FunctionDeclaration") {
      assert.ok(Array.isArray(fn.params));
      const body = range(fn.body);
      check(
        edit(source, [
          {
            ...range(fn),
            text: `const ${name} = ${fn.async ? "async " : ""}(${fn.params.map((param) => source.slice(range(param).start, range(param).end)).join(",")}) => ${source.slice(body.start, body.end)};`,
          },
        ]),
      );
    }
    if (fn.type === "FunctionDeclaration")
      check(
        edit(source, [{ ...range(fn), text: "" }]) +
          "\n" +
          source.slice(range(fn).start, range(fn).end),
      );
  }
  driver(
    'import {OwnedNativeSession as $extraAlias} from "./desktop-owned-native-session.mts";\n' +
      driverSource,
  );
  close(
    edit(closeSource, [
      {
        start: range(c.completed).start,
        end: range(c.completed).start,
        text: "const $harmlessIntermediate = 1;\n",
      },
    ]),
  );
  const reject = (
    source: string,
    check: (code: string) => unknown,
    node: unknown,
    text: string,
    oracle: RegExp,
  ) => {
    const property = (source === driverSource ? d.m : c.m).parent(node);
    const change =
      property?.type === "Property" && property.shorthand === true && property.value === node
        ? {
            ...range(property),
            text: JSON.stringify(identifier(property.key) ?? literal(property.key)) + ": " + text,
          }
        : { ...range(node), text };
    const changed = edit(source, [change]);
    parseAst(changed);
    assert.throws(
      () => check(changed),
      (error) => error instanceof assert.AssertionError && oracle.test(error.message),
      "Expected wiring oracle " + oracle,
    );
  };
  assert.ok(isRecord(d.call.callee));
  reject(
    driverSource,
    driver,
    d.call.callee.object,
    "foreignSession",
    /Consume actual driver capture boundary/u,
  );
  reject(driverSource, driver, d.slots.get("pid"), "42", /Capture actual driver PID/u);
  reject(
    driverSource,
    driver,
    d.slots.get("executable"),
    "foreignExecutable",
    /Capture selected executable/u,
  );
  reject(
    driverSource,
    driver,
    d.slots.get("observe"),
    "foreignObserver",
    /Consume native observer/u,
  );
  reject(
    driverSource,
    driver,
    d.slots.get("launchStarted"),
    "Date.now()",
    /Forward original launch timestamp/u,
  );
  reject(
    driverSource,
    driver,
    d.call,
    `false && (${driverSource.slice(range(d.call).start, range(d.call).end)})`,
    /Consume actual driver capture boundary/u,
  );
  reject(
    closeSource,
    close,
    c.call.callee,
    "foreignClose",
    /Live runtime consumes close boundary/u,
  );
  for (const [key, oracle] of [
    ["write", /Use actual exclusive evidence writer/u],
    ["native", /Forward actual native observer/u],
    ["closeFile", /Close current captured game identity/u],
    ["executable", /Close current captured game executable/u],
    ["requestFile", /Port-derived close request receipt/u],
    ["route", /Record in current runtime route/u],
    ["artifacts", /Append to current runtime report artifacts/u],
  ] as const)
    reject(closeSource, close, c.slots.get(key), "foreignInput", oracle);
  const awaited = c.m.parent(c.call);
  assert.ok(awaited);
  reject(
    closeSource,
    close,
    awaited,
    closeSource.slice(range(c.call).start, range(c.call).end),
    /Await positive close completion/u,
  );
  reject(
    closeSource,
    close,
    c.completed,
    `false && (${closeSource.slice(range(c.completed).start, range(c.completed).end)})`,
    /Record natural exit after joined close/u,
  );
  reject(
    closeSource,
    close,
    c.completed.left,
    "unrelatedCompletionFlag",
    /Record natural exit after joined close/u,
  );
  for (const [source, check, result, oracle] of [
    [driverSource, driver, d.providerReturn, /Consume parsed native observation/u],
    [closeSource, close, c.providerReturn, /Forward parsed native observations/u],
  ] as const) {
    const original = source.slice(range(result).start, range(result).end);
    reject(source, check, result, `function unusedNativeReturn(){${original}} return {};`, oracle);
    const call = check === driver ? d.call : c.call,
      m = check === driver ? d.m : c.m;
    const expression =
      m.parent(call)?.type === "AwaitExpression" ? m.parent(m.parent(call)!) : m.parent(call);
    assert.ok(expression);
    for (const termination of ["return;", "throw new Error('controlled early exit');"])
      reject(
        source,
        check,
        expression,
        termination + source.slice(range(expression).start, range(expression).end),
        check === driver
          ? /Consume actual driver capture boundary/u
          : /Live runtime consumes close boundary/u,
      );
  }
  for (const [source, check, call] of [
    [driverSource, driver, d.call],
    [closeSource, close, c.call],
  ] as const) {
    const changed =
      edit(source, [{ ...range(call), text: "foreignOperation()" }]) +
      `\nasync function unusedBoundaryDecoy(){await ${source.slice(range(call).start, range(call).end)};}`;
    parseAst(changed);
    assert.throws(() => check(changed), {
      code: "ERR_ASSERTION",
      message:
        /Selected driver route consumes capture boundary|Actual runtime routes consume launch boundary/u,
    });
  }
});

void test("Linux entrypoint consumes the publication owner for launch, join and interrupted restart", async () => {
  const original = stripTypeScriptTypes(
    await readFile(new URL("../apps/desktop/scripts/desktop-test.mts", import.meta.url), "utf8"),
    { mode: "strip" },
  );
  function inspect(code: string) {
    const m = indexDesktopCaller(code),
      { ast, all } = m;
    const imported = (from: string, name: string) =>
      all
        .filter((node) => node.type === "ImportDeclaration" && literal(node.source) === from)
        .flatMap((node) => (Array.isArray(node.specifiers) ? node.specifiers.filter(isRecord) : []))
        .filter((node) => identifier(node.imported) === name)
        .map((node) => identifier(node.local));
    const classes = imported("./desktop-linux-native-session.mts", "LinuxLaunchPublication");
    const instances = all.filter(
      (node) =>
        node.type === "VariableDeclarator" &&
        isRecord(node.init) &&
        node.init.type === "NewExpression" &&
        classes.includes(identifier(node.init.callee)),
    );
    assert.equal(instances.length, 1, "Construct the imported Linux publication owner");
    const instance = instances[0]!;
    assert.ok(isRecord(instance.init));
    const receiver = identifier(instance.id);
    assert.ok(receiver);
    function slots(value: unknown) {
      assert.ok(
        isRecord(value) && value.type === "ObjectExpression" && Array.isArray(value.properties),
        "Explicit publication dependencies",
      );
      return new Map(
        value.properties
          .filter(isRecord)
          .map((node) => [identifier(node.key) ?? literal(node.key), node.value]),
      );
    }
    const dependencies = slots(args(instance.init)[0]);
    assert.ok(
      imported("node:fs/promises", "writeFile").includes(identifier(dependencies.get("write"))),
      "Actual exclusive writer",
    );
    assert.ok(
      identifier(dependencies.get("output")) && identifier(dependencies.get("artifacts")),
      "Actual output and artifact inventory",
    );
    const resolve = (name: unknown) => m.resolve(identifier(name), ast);
    const before = resolve(dependencies.get("beforeCommit")),
      after = resolve(dependencies.get("afterCommit"));
    assert.ok(before && after, "Retain both media publication phases");
    assert.ok(Array.isArray(before.params) && Array.isArray(after.params));
    const beforeParameters = before.params,
      afterParameters = after.params;
    const member = (value: unknown, objectName: string | undefined, property: string) =>
      isRecord(value) &&
      value.type === "MemberExpression" &&
      identifier(value.object) === objectName &&
      identifier(value.property) === property;
    assert.ok(
      [...nodes(before.body)].some((node) =>
        member(node, identifier(beforeParameters[0]), "quiesced"),
      ),
      "Publish actual cleanup before commit",
    );
    assert.ok(
      [...nodes(before.body)].some(
        (node) =>
          node.type === "Property" &&
          identifier(node.key) === "namespace_join" &&
          identifier(node.value) === identifier(beforeParameters[1]),
      ),
      "Publish actual join evidence",
    );
    assert.ok(
      [...nodes(after.body)].some((node) => member(node, identifier(afterParameters[0]), "events")),
      "Validate actual media after commit",
    );
    const observedInputs = all.find(
      (node) =>
        node.type === "CallExpression" &&
        imported(
          "../../../scripts/native-helper-dependencies.mts",
          "observeDesktopHarnessInputs",
        ).includes(identifier(node.callee)),
    );
    assert.ok(observedInputs);
    const capture = slots(slots(args(observedInputs)[0]).get("capture"));
    assert.equal(
      identifier(dependencies.get("output")),
      identifier(capture.get("output")),
      "Use admitted output root",
    );
    assert.ok(
      [...nodes(before.body)].some(
        (node) =>
          node.type === "MemberExpression" &&
          identifier(node.object) === identifier(dependencies.get("artifacts")) &&
          identifier(node.property) === "push",
      ),
      "Use shared artifact inventory",
    );
    const commit = dependencies.get("committed");
    const calls = (method: string) =>
      all.filter(
        (node) =>
          node.type === "CallExpression" &&
          isRecord(node.callee) &&
          node.callee.type === "MemberExpression" &&
          identifier(node.callee.object) === receiver &&
          identifier(node.callee.property) === method,
      );
    const enclosing = m.owner;
    const consumed = (call: Record<string, unknown>, kind: "return" | "await") => {
      let expression = m.parent(call);
      if (kind === "return")
        assert.ok(expression?.type === "ReturnStatement", "Return owner completion");
      else {
        assert.ok(expression?.type === "AwaitExpression", "Await owner completion");
        expression = m.parent(expression);
      }
      let current = expression;
      const fn = enclosing(call);
      while (current && current !== fn) {
        const parent = m.parent(current);
        if (parent?.type === "BlockStatement" && Array.isArray(parent.body)) {
          const position = parent.body.indexOf(current);
          assert.ok(
            position >= 0 &&
              !parent.body
                .slice(0, position)
                .filter(isRecord)
                .some((node) => ["ReturnStatement", "ThrowStatement"].includes(String(node.type))),
            "Reachable owner delegate",
          );
        }
        if (parent?.type === "IfStatement")
          assert.notEqual(literal(parent.test), false, "Reachable owner delegate");
        current = parent;
      }
      assert.equal(current, fn, "Consume delegate in its actual caller");
    };
    const joined = calls("stop"),
      started = calls("start"),
      interrupted = calls("interruptPreparation");
    assert.equal(joined.length, 1, "Consume actual join owner");
    assert.equal(started.length, 1, "Consume actual launch owner");
    assert.equal(interrupted.length, 1, "Consume actual interruption owner");
    const stop = enclosing(joined[0]!),
      start = enclosing(started[0]!),
      interruption = enclosing(interrupted[0]!);
    assert.ok(stop && start && interruption);
    consumed(joined[0]!, "return");
    consumed(started[0]!, "await");
    consumed(interrupted[0]!, "return");
    const launchBinding = m.parent(m.parent(started[0]!));
    assert.ok(launchBinding?.type === "VariableDeclarator", "Consume awaited launch result");
    const childAssignments = all.filter(
      (node) =>
        node.type === "AssignmentExpression" &&
        member(node.right, identifier(launchBinding.id), "child") &&
        enclosing(node) === start,
    );
    assert.equal(childAssignments.length, 1, "Bind actual launch child");
    const driverBinding = identifier(childAssignments[0]!.left);
    assert.ok(driverBinding);
    assert.ok(
      isRecord(commit) &&
        [...nodes(commit.body)].some(
          (node) =>
            node.type === "AssignmentExpression" &&
            identifier(node.left) === driverBinding &&
            identifier(node.right) === "undefined" &&
            m.direct(node),
        ),
      "Clear actual driver at publication commit",
    );
    const factory = args(started[0])[0];
    assert.ok(
      isRecord(factory) &&
        ["ArrowFunctionExpression", "FunctionExpression"].includes(String(factory.type)),
      "Explicit launch factory",
    );
    for (const provider of ["launchLinuxNativeSession", "launchIsolatedLinuxNativeSession"]) {
      const aliases = imported(
        provider === "launchLinuxNativeSession"
          ? "./desktop-linux-native-session.mts"
          : "./native-linux-isolated-session.mts",
        provider,
      );
      assert.ok(
        [...nodes(factory.body)].some((node) => {
          if (
            node.type !== "CallExpression" ||
            !aliases.includes(identifier(node.callee)) ||
            m.owner(node) !== factory
          )
            return false;
          if (factory.body === node) return true;
          const parent = m.parent(node);
          return (
            parent?.type === "ReturnStatement" ||
            (parent?.type === "AwaitExpression" && m.parent(parent)?.type === "ReturnStatement")
          );
        }),
        "Return actual launch provider " + provider,
      );
    }
    const options = slots(args(interrupted[0])[0]);
    const startup = options.get("start");
    assert.ok(isRecord(startup), "Explicit admitted startup callback");
    const startupCalls = [...nodes(startup)].filter((node) => node.type === "CallExpression");
    const startupTarget = startupCalls
      .map((call) => resolve(call.callee))
      .find((target) => target && m.calls(start).some((call) => m.owner(call) === target));
    assert.ok(
      startupTarget && m.calls(startupTarget).some((call) => !m.owner(call)),
      "Restart through live admitted startup",
    );
    assert.ok(m.calls(stop).length > 0, "Live cleanup consumes join delegate");
    assert.ok(Array.isArray(interruption.params));
    for (const [key, position] of [
      ["name", 0],
      ["preparationExecutable", 1],
      ["assertStillPreparing", 2],
    ] as const) {
      assert.ok(identifier(options.get(key)), "Forward actual interruption " + key);
      assert.equal(
        identifier(options.get(key)),
        identifier(interruption.params[position]),
        "Forward actual interruption " + key,
      );
    }
    const selected = options.get("selectedScenarios");
    assert.ok(
      isRecord(selected) &&
        selected.type === "MemberExpression" &&
        identifier(selected.property) === "selected_scenarios",
      "Forward actual selected scenarios",
    );
    const selections = imported(
      "../../../scripts/desktop-execution-plan.mts",
      "resolveDesktopHarnessSelection",
    );
    assert.ok(
      all.some(
        (node) =>
          node.type === "VariableDeclarator" &&
          identifier(node.id) === identifier(selected.object) &&
          isRecord(node.init) &&
          node.init.type === "CallExpression" &&
          selections.includes(identifier(node.init.callee)),
      ),
      "Consume admitted scenario selection",
    );
    const libraryBinding = identifier(options.get("library"));
    assert.ok(
      libraryBinding &&
        all.some(
          (node) =>
            node.type === "VariableDeclarator" &&
            identifier(node.id) === libraryBinding &&
            isRecord(node.init) &&
            node.init.type === "CallExpression" &&
            args(node.init).some((arg) => literal(arg) === "library"),
        ),
      "Forward actual staging library",
    );
    const connect = resolve(options.get("connect"));
    assert.ok(
      connect &&
        m.calls(connect).some((call) => !m.owner(call)) &&
        [...nodes(connect.body)].some(
          (node) =>
            node.type === "AwaitExpression" &&
            isRecord(node.argument) &&
            node.argument.type === "CallExpression",
        ),
      "Forward actual connection route",
    );
    const invalidate = options.get("invalidateBrowser");
    const accessor = resolve(options.get("browser"));
    assert.ok(accessor, "Actual browser accessor");
    assert.ok(
      isRecord(invalidate) &&
        [...nodes(invalidate)].some(
          (node) =>
            node.type === "AssignmentExpression" &&
            identifier(node.left) &&
            [...nodes(accessor.body)].some((use) => identifier(use) === identifier(node.left)) &&
            identifier(node.right) === "undefined" &&
            m.direct(node),
        ),
      "Invalidate browser without graceful deletion",
    );
    assert.ok(
      ![...nodes(invalidate)].some(
        (node) =>
          node.type === "CallExpression" &&
          isRecord(node.callee) &&
          node.callee.type === "MemberExpression" &&
          ["quit", "close"].includes(String(identifier(node.callee.property))),
      ),
      "Do not gracefully close during forced interruption",
    );
    assert.ok(
      all.some(
        (node) =>
          node.type === "Property" &&
          identifier(node.key) === "interruptApplication" &&
          [...nodes(node.value)].some((child) => identifier(child) === m.binding(interruption)),
      ),
      "Preparation scenario consumes interruption route",
    );
    return {
      m,
      instance,
      started: started[0]!,
      interrupted: interrupted[0]!,
      dependencies,
      options,
    };
  }
  const found = inspect(original);
  inspect(
    original
      .replaceAll("linuxPublication", "renamedPublication")
      .replaceAll("publishLinuxMediaEvidence", "renamedMediaPublication")
      .replaceAll("validateLinuxMediaEvidence", "renamedMediaValidation")
      .replaceAll("startDriver", "renamedStartup"),
  );
  const preparingProperty = found.m.parent(found.options.get("assertStillPreparing"));
  assert.ok(preparingProperty?.type === "Property");
  inspect(
    edit(original, [
      {
        ...range(preparingProperty),
        text: "assertStillPreparing: " + identifier(found.options.get("assertStillPreparing")),
      },
    ]),
  );
  const expanded = edit(original, [
    {
      ...range(preparingProperty),
      text: "assertStillPreparing: " + identifier(found.options.get("assertStillPreparing")),
    },
  ]);
  const expandedFound = inspect(expanded),
    expandedProperty = expandedFound.m.parent(expandedFound.options.get("assertStillPreparing"));
  assert.ok(expandedProperty?.type === "Property");
  const expandedNegative = edit(expanded, [
    { ...range(expandedProperty), text: "assertStillPreparing: async () => {}" },
  ]);
  parseAst(expandedNegative);
  assert.throws(() => inspect(expandedNegative), {
    code: "ERR_ASSERTION",
    message: /^Forward actual interruption assertStillPreparing/,
  });
  const factory = args(found.started)[0];
  assert.ok(isRecord(factory));
  const factorySource = original.slice(range(factory).start, range(factory).end);
  inspect(
    edit(original, [
      {
        ...range(factory),
        text: factorySource.replace(/^async\s+/, "").replaceAll("return await ", "return "),
      },
    ]),
  );
  for (const dependency of [
    found.dependencies.get("beforeCommit"),
    found.dependencies.get("afterCommit"),
  ]) {
    const fn = indexDesktopCaller(original).resolve(
      identifier(dependency),
      indexDesktopCaller(original).ast,
    );
    if (fn?.type === "FunctionDeclaration") {
      assert.ok(Array.isArray(fn.params));
      const statement = indexDesktopCaller(original).all.find(
        (node) =>
          node.type === "VariableDeclaration" &&
          range(node).start <= range(found.instance).start &&
          range(node).end >= range(found.instance).end,
      );
      assert.ok(statement);
      inspect(
        edit(original, [
          { ...range(fn), text: "" },
          {
            start: range(statement).start,
            end: range(statement).start,
            text:
              "const " +
              identifier(fn.id) +
              " = async (" +
              fn.params
                .map((param) => original.slice(range(param).start, range(param).end))
                .join(",") +
              ") => " +
              original.slice(range(fn.body).start, range(fn.body).end) +
              ";\n",
          },
        ]),
      );
    }
  }
  inspect("\n/* harmless declaration layout */\n" + original.replaceAll(";\n", ";\n\n"));
  const invalidation = found.options.get("invalidateBrowser"),
    commitCallback = found.dependencies.get("committed");
  assert.ok(isRecord(invalidation) && isRecord(commitCallback));
  const browserClear = [...nodes(invalidation)].find(
    (node) => node.type === "AssignmentExpression",
  );
  assert.ok(browserClear);
  for (const [change, message] of [
    [
      { ...range(found.m.parent(found.dependencies.get("output"))), text: "output: driverPath" },
      "Use admitted output root",
    ],
    [
      {
        ...range(found.m.parent(found.dependencies.get("artifacts"))),
        text: "artifacts: checks",
      },
      "Use shared artifact inventory",
    ],
    [
      {
        ...range(commitCallback),
        text:
          "() => { if (false) " +
          original.slice(range(commitCallback.body).start, range(commitCallback.body).end) +
          " }",
      },
      "Clear actual driver at publication commit",
    ],
    [
      {
        ...range(invalidation),
        text:
          "() => { if (false) " +
          original.slice(range(invalidation.body).start, range(invalidation.body).end) +
          " }",
      },
      "Invalidate browser without graceful deletion",
    ],
    [
      {
        ...range(invalidation),
        text:
          "() => { " +
          identifier(browserClear.left) +
          ".quit();" +
          original.slice(range(invalidation.body).start + 1, range(invalidation.body).end - 1) +
          " }",
      },
      "Do not gracefully close during forced interruption",
    ],
    [
      { ...range(found.started), text: "Promise.resolve(undefined)" },
      "Consume actual launch owner",
    ],
    [
      { ...range(found.interrupted), text: "Promise.resolve(undefined)" },
      "Consume actual interruption owner",
    ],
    [{ ...range(found.dependencies.get("write")), text: "undefined" }, "Actual exclusive writer"],
    [
      { ...range(found.dependencies.get("committed")), text: "() => {}" },
      "Clear actual driver at publication commit",
    ],
    [
      { ...range(found.options.get("invalidateBrowser")), text: "() => {}" },
      "Invalidate browser without graceful deletion",
    ],
    [
      {
        ...range(preparingProperty),
        text: "assertStillPreparing: async () => {}",
      },
      "Forward actual interruption assertStillPreparing",
    ],
    [
      { ...range(found.options.get("selectedScenarios")), text: "[]" },
      "Forward actual selected scenarios",
    ],
  ] as const) {
    const changed = edit(original, [change]);
    parseAst(changed); // A parser rejection cannot qualify as a causal failure.
    assert.throws(() => inspect(changed), {
      code: "ERR_ASSERTION",
      message: new RegExp("^" + message + "(?:\\n|$)"),
    });
  }
});

void test("actual driver startup and identity restart consume the imported native custody operations", async () => {
  const source = stripTypeScriptTypes(
    await readFile(new URL("../apps/desktop/scripts/desktop-test.mts", import.meta.url), "utf8"),
    { mode: "strip" },
  );
  const property = (node: unknown, name: string) =>
    isRecord(node) &&
    node.type === "MemberExpression" &&
    (identifier(node.property) ?? literal(node.property)) === name;
  function inspect(code: string) {
    const m = indexDesktopCaller(code);
    const callback = (value: unknown, at: unknown) => {
      const fn =
        isRecord(value) &&
        ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
          String(value.type),
        )
          ? value
          : m.resolve(identifier(value), at);
      assert.ok(fn, "LIVE_NATIVE_CALLBACK");
      return fn;
    };
    const returned = (fn: Record<string, unknown>, marker = "DIRECT_NATIVE_CALLBACK_RETURN") => {
      if (isRecord(fn.body) && fn.body.type === "CallExpression") return fn.body;
      const returns = activeNativeSyntax(fn.body).filter(
        (node) => node.type === "ReturnStatement" && m.parent(node) === fn.body,
      );
      assert.equal(returns.length, 1, marker);
      const result = returns[0]!.argument;
      assert.ok(isRecord(result) && result.type === "CallExpression", marker);
      return result;
    };
    const declarations = m.all.filter(
      (node) => node.type === "VariableDeclarator" && !m.owner(node),
    );
    const owner = declarations.find(
      (node) =>
        isRecord(node.init) &&
        node.init.type === "NewExpression" &&
        m
          .imports("./desktop-owned-native-session.mts", "OwnedNativeSession")
          .has(identifier(node.init.callee)),
    );
    assert.ok(owner, "NATIVE_OWNER_IMPORT");
    const receiver = identifier(owner.id);
    const admission = declarations.find(
      (node) =>
        isRecord(node.init) &&
        node.init.type === "CallExpression" &&
        m
          .imports("../../../scripts/retained-evidence.mts", "executionAdmission")
          .has(identifier(node.init.callee)),
    );
    assert.ok(admission, "ACTUAL_ADMISSION_OWNER");
    const reachable = (node: Record<string, unknown>) =>
      activeNativeSyntax(m.owner(node)?.body ?? m.ast).includes(node);
    const calls = (name: string) =>
      m.all.filter(
        (node) =>
          node.type === "CallExpression" &&
          property(node.callee, name) &&
          isRecord(node.callee) &&
          identifier(node.callee.object) === receiver &&
          reachable(node),
      );
    const launches = calls("startLaunch");
    assert.equal(launches.length, 2, "BOTH_NATIVE_LAUNCH_ROUTES");
    const launchOwner = m.owner(launches[0]);
    assert.ok(launchOwner);
    for (const call of launches) {
      assert.equal(m.owner(call), launchOwner, "SAME_ACTUAL_LAUNCH_ROUTE");
      assert.equal(m.parent(call)?.type, "AssignmentExpression", "CONSUME_CREATED_DRIVER");
      const options = m.slots(call),
        admit = callback(options.get("admit"), call),
        create = callback(options.get("create"), call);
      assert.ok(!admit.async && !create.async, "SYNCHRONOUS_LAUNCH_CAPABILITIES");
      const admitted =
        isRecord(admit.body) && admit.body.type === "CallExpression"
          ? admit.body
          : activeNativeSyntax(admit.body).find(
              (node) => node.type === "CallExpression" && m.direct(node),
            );
      assert.ok(
        admitted &&
          property(admitted.callee, "assertReady") &&
          isRecord(admitted.callee) &&
          identifier(admitted.callee.object) === identifier(admission.id),
        "ACTUAL_LAUNCH_ADMISSION",
      );
      const factory = returned(create, "REAL_LAUNCH_FACTORY");
      assert.ok(
        m.imports("node:child_process", "spawn").has(identifier(factory.callee)) ||
          property(factory.callee, "start"),
        "REAL_LAUNCH_FACTORY",
      );
    }
    const created = launches.map((call) =>
      returned(callback(m.slots(call).get("create"), call), "REAL_LAUNCH_FACTORY"),
    );
    const ordinary = created.find((node) =>
      m.imports("node:child_process", "spawn").has(identifier(node.callee)),
    );
    const account = created.find((node) => property(node.callee, "start"));
    assert.ok(ordinary && account && isRecord(account.callee), "BOTH_REAL_DRIVER_PROVIDERS");
    const nativeAccount = declarations.find(
      (node) =>
        isRecord(node.init) &&
        node.init.type === "ConditionalExpression" &&
        isRecord(node.init.consequent) &&
        node.init.consequent.type === "CallExpression" &&
        property(node.init.consequent.callee, "open") &&
        isRecord(node.init.consequent.callee) &&
        m
          .imports("./desktop-native-account-session.mts", "DesktopNativeAccountSession")
          .has(identifier(node.init.consequent.callee.object)),
    );
    assert.ok(
      nativeAccount &&
        (identifier(account.callee.object) === identifier(nativeAccount.id) ||
          (isRecord(account.callee.object) &&
            account.callee.object.type === "CallExpression" &&
            identifier(args(account.callee.object)[0]) === identifier(nativeAccount.id))),
      "ACTUAL_ACCOUNT_DRIVER_PROVIDER",
    );
    assert.equal(
      identifier(args(account)[0]),
      identifier(args(ordinary)[0]),
      "SAME_CURRENT_DRIVER_PATH",
    );
    assert.equal(
      identifier(args(account)[1]),
      identifier(args(ordinary)[1]),
      "SAME_CURRENT_DRIVER_ARGUMENTS",
    );
    const ordinaryOptions = args(ordinary)[2];
    assert.ok(isRecord(ordinaryOptions) && Array.isArray(ordinaryOptions.properties));
    const ordinarySlots = new Map(
      ordinaryOptions.properties
        .filter(isRecord)
        .map((node) => [identifier(node.key) ?? literal(node.key), node.value]),
    );
    const runtimeRoot = declarations.find(
      (node) =>
        isRecord(node.init) &&
        node.init.type === "ConditionalExpression" &&
        isRecord(node.init.consequent) &&
        node.init.consequent.type === "CallExpression" &&
        property(node.init.consequent.callee, "runtimeRoot") &&
        isRecord(node.init.consequent.callee) &&
        identifier(node.init.consequent.callee.object) === identifier(nativeAccount.id),
    );
    assert.ok(runtimeRoot, "ACTUAL_NATIVE_ACCOUNT_ROOT");
    assert.equal(
      identifier(args(account)[2]),
      identifier(runtimeRoot.id),
      "ACTUAL_NATIVE_ACCOUNT_ROOT",
    );
    const nativeEnvironment = args(account)[3],
      ordinaryEnvironment = ordinarySlots.get("env");
    assert.ok(
      isRecord(nativeEnvironment) &&
        nativeEnvironment.type === "CallExpression" &&
        isRecord(ordinaryEnvironment) &&
        ordinaryEnvironment.type === "CallExpression",
      "CURRENT_DRIVER_ENVIRONMENT",
    );
    assert.equal(
      identifier(nativeEnvironment.callee),
      identifier(ordinaryEnvironment.callee),
      "CURRENT_DRIVER_ENVIRONMENT",
    );
    assert.equal(
      identifier(args(nativeEnvironment)[0]),
      identifier(args(ordinaryEnvironment)[0]),
      "CURRENT_DRIVER_ENVIRONMENT",
    );
    const startupCalls = m.calls(launchOwner);
    assert.equal(startupCalls.length, 1, "STARTUP_CONSUMES_LAUNCH");
    const startup = m.owner(startupCalls[0]);
    assert.ok(startup);
    const verification = m.all.find(
      (node) =>
        node.type === "CallExpression" &&
        property(node.callee, "verify") &&
        isRecord(node.callee) &&
        identifier(node.callee.object) === identifier(admission.id) &&
        m.owner(node) === startup &&
        range(node).end < range(startupCalls[0]).start,
    );
    assert.ok(
      verification && m.parent(verification)?.type === "AwaitExpression",
      "AWAIT_ADMISSION_BEFORE_LAUNCH",
    );
    const restarts = calls("restart");
    assert.equal(restarts.length, 1, "ACTUAL_IDENTITY_RESTART");
    const call = restarts[0]!,
      fn = m.owner(call);
    assert.ok(fn);
    assert.equal(m.parent(call)?.type, "AwaitExpression", "AWAIT_IDENTITY_RESTART");
    assert.equal(m.parent(m.parent(call))?.type, "ReturnStatement", "RETURN_RECONNECTED_BROWSER");
    assert.ok(
      m.all.some(
        (node) =>
          node.type === "Property" &&
          (identifier(node.key) ?? literal(node.key)) === "restart" &&
          m.resolve(identifier(node.value), node) === fn,
      ),
      "SCENARIOS_CONSUME_IDENTITY_RESTART",
    );
    const options = m.slots(call),
      capture = callback(options.get("capture"), call),
      publish = callback(options.get("publish"), call),
      close = callback(options.get("close"), call);
    const captureCalls = activeNativeSyntax(capture.body).filter(
      (node) => node.type === "CallExpression",
    );
    const snapshot = captureCalls.find((node) =>
      m
        .imports("./desktop-owned-native-session.mts", "readNativeProcessSnapshot")
        .has(identifier(node.callee)),
    );
    assert.ok(snapshot, "PARSE_ACTUAL_RESTART_SNAPSHOT");
    const parsed = args(snapshot)[0];
    assert.ok(
      isRecord(parsed) && parsed.type === "CallExpression" && property(parsed.callee, "parse"),
      "READ_CAPTURED_RESTART_INVENTORY",
    );
    const read = awaited(args(parsed)[0]);
    assert.ok(
      read && m.imports("node:fs/promises", "readFile").has(identifier(read.callee)),
      "READ_CAPTURED_RESTART_INVENTORY",
    );
    const inventory = activeNativeSyntax(capture.body).find(
      (node) =>
        node.type === "VariableDeclarator" && identifier(node.id) === identifier(args(read)[0]),
    );
    assert.ok(
      inventory && isRecord(inventory.init) && inventory.init.type === "CallExpression",
      "READ_CAPTURED_RESTART_INVENTORY",
    );
    const captureOwner = m.resolve(identifier(inventory.init.callee), inventory.init);
    assert.ok(
      captureOwner &&
        activeNativeSyntax(captureOwner.body).some(
          (node) =>
            node.type === "AssignmentExpression" &&
            property(node.left, "inventory") &&
            isRecord(node.left) &&
            identifier(node.left.object) === receiver,
        ),
      "ACTUAL_RESTART_CAPTURE_OWNER",
    );
    const validation = captureCalls.find(
      (node) =>
        m.resolve(identifier(node.callee), node) &&
        range(node).start < range(snapshot).start &&
        range(node).end > range(snapshot).end,
    );
    assert.ok(validation, "VALIDATE_ACTUAL_RESTART_SNAPSHOT");
    const validator = m.resolve(identifier(validation.callee), validation);
    assert.ok(validator && Array.isArray(validator.params));
    assert.ok(
      activeNativeSyntax(validator.body).some(
        (node) =>
          node.type === "CallExpression" &&
          property(node.callee, "validateQualificationInventory") &&
          isRecord(node.callee) &&
          identifier(node.callee.object) === receiver &&
          m.direct(node),
      ),
      "RETAIN_RESTART_IDENTITY_VALIDATOR",
    );
    const writes = activeNativeSyntax(publish.body).filter(
      (node) =>
        node.type === "CallExpression" &&
        m.direct(node) &&
        m.imports("node:fs/promises", "writeFile").has(identifier(node.callee)),
    );
    assert.equal(writes.length, 1, "ACTUAL_RESTART_RECEIPT_WRITER");
    const write = writes[0]!,
      writeOptions = args(write)[2];
    assert.ok(
      isRecord(writeOptions) &&
        writeOptions.type === "ObjectExpression" &&
        Array.isArray(writeOptions.properties) &&
        writeOptions.properties
          .filter(isRecord)
          .some(
            (node) =>
              (identifier(node.key) ?? literal(node.key)) === "flag" &&
              literal(node.value) === "wx",
          ),
      "EXCLUSIVE_RESTART_RECEIPT",
    );
    assert.ok(
      activeNativeSyntax(publish.body).some(
        (node) =>
          node.type === "CallExpression" &&
          m.direct(node) &&
          property(node.callee, "push") &&
          range(node).start > range(write).end,
      ),
      "RETAIN_RESTART_RECEIPT_ARTIFACT",
    );
    const stop = m.resolve(identifier(options.get("stop")), call);
    assert.ok(stop, "ACTUAL_IDENTITY_STOP");
    assert.ok(
      activeNativeSyntax(stop.body).some(
        (node) =>
          node.type === "AssignmentExpression" &&
          property(node.left, "cleanup") &&
          isRecord(node.left) &&
          identifier(node.left.object) === receiver,
      ),
      "STOP_PUBLISHES_CURRENT_PROOF",
    );
    const start = returned(callback(options.get("start"), call));
    assert.ok(
      m.resolve(identifier(start.callee), start) === startup,
      "RESTART_REUSES_ADMITTED_STARTUP",
    );
    assert.ok(Array.isArray(fn.params));
    assert.equal(
      identifier(options.get("prepare")),
      identifier(fn.params[1]),
      "FORWARD_OPTIONAL_STOPPED_PREPARATION",
    );
    const browser = callback(options.get("browser"), call);
    const browserReturns = activeNativeSyntax(browser.body).filter(
      (node) => node.type === "ReturnStatement" && m.parent(node) === browser.body,
    );
    assert.equal(browserReturns.length, 1, "ACTUAL_CONNECTED_BROWSER");
    const browserIdentity = identifier(browserReturns[0]!.argument);
    assert.ok(browserIdentity, "ACTUAL_CONNECTED_BROWSER");
    const closeNodes = activeNativeSyntax(close.body);
    const quit = closeNodes.find(
      (node) =>
        node.type === "CallExpression" &&
        property(node.callee, "quit") &&
        isRecord(node.callee) &&
        isRecord(node.callee.object) &&
        node.callee.object.type === "CallExpression" &&
        identifier(args(node.callee.object)[0]) === browserIdentity,
    );
    assert.ok(
      quit && m.parent(quit)?.type === "AwaitExpression",
      "CLOSE_ACTUAL_BROWSER_BEFORE_STOP",
    );
    assert.ok(
      closeNodes.some(
        (node) =>
          node.type === "AssignmentExpression" &&
          identifier(node.left) === browserIdentity &&
          identifier(node.right) === "undefined" &&
          range(node).start > range(quit).end,
      ),
      "CLEAR_CLOSED_BROWSER_BEFORE_STOP",
    );
    const connect = callback(options.get("connect"), call);
    const connection = activeNativeSyntax(connect.body).find(
      (node) =>
        node.type === "CallExpression" &&
        m.parent(node)?.type === "AwaitExpression" &&
        m.resolve(identifier(node.callee), node),
    );
    assert.ok(connection, "ACTUAL_RESTART_CONNECTION");
    const connector = m.resolve(identifier(connection.callee), connection);
    assert.ok(
      connector &&
        activeNativeSyntax(connector.body).some(
          (node) =>
            node.type === "AssignmentExpression" && identifier(node.left) === browserIdentity,
        ),
      "CONNECT_CURRENT_BROWSER",
    );
    assert.ok(m.parent(write)?.type === "AwaitExpression", "AWAIT_RESTART_RECEIPT");
    assert.ok(Array.isArray(publish.params));
    const body = args(write)[1];
    const json: unknown =
      isRecord(body) && body.type === "TemplateLiteral" && Array.isArray(body.expressions)
        ? body.expressions[0]
        : isRecord(body) && body.type === "BinaryExpression" && body.operator === "+"
          ? body.left
          : undefined;
    assert.ok(
      isRecord(json) &&
        json.type === "CallExpression" &&
        property(json.callee, "stringify") &&
        isRecord(json.callee) &&
        identifier(json.callee.object) === "JSON" &&
        identifier(args(json)[0]) === identifier(publish.params[0]),
      "PUBLISH_ACTUAL_CLEANUP_PROOF",
    );
    const receipt = activeNativeSyntax(publish.body).find(
      (node) =>
        node.type === "VariableDeclarator" && identifier(node.id) === identifier(args(write)[0]),
    );
    assert.ok(
      receipt &&
        isRecord(receipt.init) &&
        receipt.init.type === "CallExpression" &&
        property(receipt.init.callee, "join"),
      "CURRENT_RESTART_RECEIPT_PATH",
    );
    const receiptName = args(receipt.init)[1];
    assert.ok(
      isRecord(receiptName) &&
        receiptName.type === "TemplateLiteral" &&
        Array.isArray(receiptName.expressions) &&
        Array.isArray(receiptName.quasis) &&
        identifier(receiptName.expressions[0]) ===
          identifier(Array.isArray(fn.params) ? fn.params[0] : undefined) &&
        isRecord(receiptName.quasis[1]) &&
        isRecord(receiptName.quasis[1].value) &&
        receiptName.quasis[1].value.cooked === "-restart.json",
      "CURRENT_RESTART_RECEIPT_PATH",
    );
    const capturePath = activeNativeSyntax(captureOwner.body).find(
      (node) => node.type === "CallExpression" && property(node.callee, "join"),
    );
    assert.ok(
      capturePath && identifier(args(receipt.init)[0]) === identifier(args(capturePath)[0]),
      "CURRENT_RESTART_RECEIPT_PATH",
    );
    const artifact = activeNativeSyntax(publish.body).find(
      (node) =>
        node.type === "CallExpression" &&
        m.direct(node) &&
        property(node.callee, "push") &&
        identifier(args(node)[0]) === identifier(args(write)[0]),
    );
    assert.ok(artifact, "RETAIN_CURRENT_RESTART_ARTIFACT");

    const releaseCalls = calls("releaseResources");
    assert.equal(releaseCalls.length, 1, "REAL_FINAL_RELEASE_CAPABILITIES");
    const release = releaseCalls[0]!,
      releaseOptions = m.slots(release),
      fixtures = callback(releaseOptions.get("closeFixtures"), release);
    const fixtureCloses = activeNativeSyntax(fixtures.body).filter(
      (node) => node.type === "CallExpression" && property(node.callee, "close"),
    );
    assert.equal(fixtureCloses.length, 2, "REAL_FIXTURE_CLOSES");
    const providers = activeNativeSyntax(m.ast);
    const fixtureIdentity = (module: string, symbol: string) => {
      const created = providers.filter(
        (node) =>
          node.type === "AssignmentExpression" &&
          isRecord(node.right) &&
          node.right.type === "AwaitExpression" &&
          isRecord(node.right.argument) &&
          node.right.argument.type === "CallExpression" &&
          m.imports(module, symbol).has(identifier(node.right.argument.callee)),
      );
      assert.equal(created.length, 1, "REAL_FIXTURE_PROVIDER");
      return identifier(created[0]!.left);
    };
    const expectedFixtures = [
      fixtureIdentity("./desktop-install-fixture.mts", "createInstallFixture"),
      fixtureIdentity("./desktop-main-webview-boundary.mts", "createOriginBoundaryFixture"),
    ];
    assert.deepEqual(
      fixtureCloses.map((node) =>
        isRecord(node.callee) ? identifier(node.callee.object) : undefined,
      ),
      expectedFixtures,
      "INSTALL_ORIGIN_CLOSE_ORDER",
    );
    for (const close of fixtureCloses) {
      assert.ok(m.parent(close)?.type === "AwaitExpression", "AWAIT_REAL_FIXTURE_CLOSE");
      const statement = m.parent(m.parent(close));
      let guard = m.parent(statement);
      if (guard?.type === "BlockStatement") guard = m.parent(guard);
      assert.ok(
        guard?.type === "IfStatement" &&
          isRecord(close.callee) &&
          identifier(guard.test) === identifier(close.callee.object),
        "CLOSE_ONLY_PRESENT_FIXTURE",
      );
    }
    const lock = declarations.find(
      (node) =>
        isRecord(node.init) &&
        node.init.type === "AwaitExpression" &&
        isRecord(node.init.argument) &&
        node.init.argument.type === "CallExpression" &&
        m
          .imports("../../../scripts/native-session-lock.mts", "acquireNativeSessionLock")
          .has(identifier(node.init.argument.callee)),
    );
    assert.ok(lock, "REAL_NATIVE_LEASE");
    const releaseLock = returned(callback(releaseOptions.get("releaseLock"), release));
    assert.ok(
      property(releaseLock.callee, "release") &&
        isRecord(releaseLock.callee) &&
        identifier(releaseLock.callee.object) === identifier(lock.id),
      "RELEASE_ACTUAL_NATIVE_LEASE",
    );
    return {
      m,
      launches,
      restart: call,
      options,
      verification,
      snapshot,
      write,
      fn,
      capture,
      publish,
      close,
      connect,
      browser,
      account,
      releaseOptions,
      fixtureCloses,
      inventory,
      read,
      receipt,
    };
  }
  const original = inspect(source);
  inspect(source.replaceAll("\n", "\r\n\n"));
  for (const name of [
    "ownedSession",
    "admission",
    "restartApplication",
    "launchDriverProcess",
    "validateBackupFocusInventory",
  ])
    inspect(source.replaceAll(name, "$renamed" + name));
  // Equivalent factories retain the actual provider binding, including hoisted
  // declarations after their caller and ordinary block returns.
  for (const launch of original.launches) {
    const create = original.m.slots(launch).get("create");
    assert.ok(isRecord(create) && isRecord(create.body));
    const expression = source.slice(range(create.body).start, range(create.body).end);
    inspect(edit(source, [{ ...range(create.body), text: `{ return ${expression}; }` }]));
    const owner = original.m.owner(launch);
    assert.ok(owner && isRecord(owner.body));
    const at = range(owner.body).end - 1;
    inspect(
      edit(source, [
        { ...range(create), text: "hoistedNativeFactory" },
        { start: at, end: at, text: `function hoistedNativeFactory(){ return ${expression}; }` },
      ]),
    );
  }
  assert.ok(isRecord(original.account.callee));
  const accountReceiver = original.account.callee.object;
  assert.ok(isRecord(accountReceiver) && accountReceiver.type === "CallExpression");
  inspect(
    edit(source, [
      {
        ...range(accountReceiver),
        text: source.slice(
          range(args(accountReceiver)[0]).start,
          range(args(accountReceiver)[0]).end,
        ),
      },
    ]),
  );
  const reject = (node: unknown, text: string, marker: string) => {
    const parent = original.m.parent(node);
    const change =
      parent?.type === "Property" && parent.shorthand
        ? { ...range(parent), text: `${identifier(parent.key)}: ${text}` }
        : { ...range(node), text };
    const changed = edit(source, [change]);
    parseAst(changed);
    assert.throws(
      () => inspect(changed),
      (error) => error instanceof assert.AssertionError && error.message.includes(marker),
      marker,
    );
  };
  const launch = original.launches[0]!;
  assert.ok(isRecord(launch.callee));
  reject(launch.callee.object, "foreignSession", "BOTH_NATIVE_LAUNCH_ROUTES");
  for (const [call, marker] of [
    ...original.launches.map((call) => [call, "BOTH_NATIVE_LAUNCH_ROUTES"] as const),
    [original.restart, "ACTUAL_IDENTITY_RESTART"] as const,
  ]) {
    let statement = original.m.parent(call);
    while (
      statement &&
      !["ExpressionStatement", "ReturnStatement"].includes(String(statement.type))
    )
      statement = original.m.parent(statement);
    assert.ok(statement);
    const text = source.slice(range(statement).start, range(statement).end);
    for (const replacement of [`if(false){${text}}`, `{return;${text}}`])
      reject(statement, replacement, marker);
  }
  for (const key of ["create", "admit"]) {
    const capability = original.m.slots(launch).get(key);
    const text = source.slice(range(capability).start, range(capability).end);
    reject(capability, "async " + text, "SYNCHRONOUS_LAUNCH_CAPABILITIES");
  }
  assert.ok(isRecord(original.inventory.init));
  reject(original.inventory.init, "foreignCapture()", "ACTUAL_RESTART_CAPTURE_OWNER");
  reject(args(original.read)[0], '"foreign-inventory.json"', "READ_CAPTURED_RESTART_INVENTORY");
  reject(
    original.receipt.init,
    'path.join(output, "foreign-receipt.json")',
    "CURRENT_RESTART_RECEIPT_PATH",
  );

  reject(original.m.slots(launch).get("admit"), "()=>{}", "ACTUAL_LAUNCH_ADMISSION");
  reject(original.m.slots(launch).get("create"), "()=>({})", "REAL_LAUNCH_FACTORY");
  reject(original.verification, "Promise.resolve()", "AWAIT_ADMISSION_BEFORE_LAUNCH");
  reject(original.snapshot.callee, "foreignSnapshot", "PARSE_ACTUAL_RESTART_SNAPSHOT");
  reject(original.options.get("stop"), "foreignStop", "ACTUAL_IDENTITY_STOP");
  reject(original.options.get("start"), "()=>Promise.resolve()", "RESTART_REUSES_ADMITTED_STARTUP");
  reject(original.options.get("close"), "async()=>{}", "CLOSE_ACTUAL_BROWSER_BEFORE_STOP");
  reject(original.options.get("prepare"), "undefined", "FORWARD_OPTIONAL_STOPPED_PREPARATION");
  reject(original.options.get("connect"), "async()=>{}", "ACTUAL_RESTART_CONNECTION");
  reject(original.options.get("browser"), "()=>({})", "ACTUAL_CONNECTED_BROWSER");
  for (const [fn, marker] of [
    [original.capture, "PARSE_ACTUAL_RESTART_SNAPSHOT"],
    [original.publish, "ACTUAL_RESTART_RECEIPT_WRITER"],
  ] as const) {
    assert.ok(isRecord(fn.body) && Array.isArray(fn.body.body));
    const text = source.slice(range(fn.body).start, range(fn.body).end);
    for (const wrapped of [
      `{if(false)${text}}`,
      `{return;${text.slice(1, -1)}}`,
      `{const unused=async()=>${text};}`,
    ])
      reject(fn.body, wrapped, marker);
  }

  reject(original.write, "Promise.resolve()", "ACTUAL_RESTART_RECEIPT_WRITER");
  reject(original.releaseOptions.get("closeFixtures"), "async()=>{}", "REAL_FIXTURE_CLOSES");
  reject(
    original.releaseOptions.get("releaseLock"),
    "()=>Promise.resolve()",
    "RELEASE_ACTUAL_NATIVE_LEASE",
  );
  reject(original.fixtureCloses[0], "Promise.resolve()", "REAL_FIXTURE_CLOSES");
});
