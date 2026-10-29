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
      exports: ["readWindowsUpdateProcessMarker", "readWindowsUpdateProcessObservation"],
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
      return policy.exports.map((name) => {
        const imported = specifiers.find(
          (node) => (identifier(node.imported) ?? literal(node.imported)) === name,
        );
        assert.ok(imported, "Import installed observation owner " + name);
        const alias = identifier(imported.local);
        assert.ok(alias);
        const calls = syntax.filter(
          (node) => node.type === "CallExpression" && identifier(node.callee) === alias,
        );
        assert.ok(calls.length > 0, "Consume imported installed observation owner " + name);
        return { name, imported, calls };
      });
    }
    for (const owner of route(source)) {
      const alias = "$observedInstalledInput";
      const aliased = edit(source, [
        { ...range(owner.imported), text: JSON.stringify(owner.name) + " as " + alias },
        ...owner.calls.map((node) => ({ ...range(node.callee), text: alias })),
      ]);
      route(aliased);
      route(
        'import {hashFile as unusedHash} from "./desktop-installed-update-harness.mts";\n' +
          aliased,
      );
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
      rejected.output.includes("ARTWORK_CONTRACT_ASSERTION " + mutation.marker),
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
