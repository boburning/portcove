import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import { readFixtureModuleClosure } from "./fixtures/module-closure.mts";
import { stripTypeScriptTypes } from "node:module";
import { parseAst } from "vite-plus";
import { isRecord } from "./runtime-values.mts";

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
  function range(node: Record<string, unknown>) {
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
