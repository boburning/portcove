import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { isBuiltin } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isRecord } from "./runtime-values.mts";
import { readFixtureModuleClosure } from "./fixtures/module-closure.mts";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import { fixtureModulePolicySource } from "./fixtures/desktop-module-fixture.mts";
import { readStagedLayout } from "../apps/desktop/scripts/desktop-staged-layout.mts";
import {
  stagedDocument,
  validStagedLayout as valid,
} from "../apps/desktop/scripts/desktop-staged-layout-fixture.mts";

type LayoutMutation = "rename-locals" | "reverse-helpers" | "visible" | "enabled" | "bounds";
function* syntaxNodes(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const child of value) yield* syntaxNodes(child);
  } else if (isRecord(value)) {
    if (typeof value.type === "string") yield value;
    for (const [key, child] of Object.entries(value)) if (key !== "loc") yield* syntaxNodes(child);
  }
}
async function callbackVariant(kind: LayoutMutation): Promise<unknown> {
  const { parseAst } = await import("vite-plus");
  const source = `(${readStagedLayout.toString()})`;
  const tree: unknown = parseAst(source);
  const nodes = [...syntaxNodes(tree)];
  const edits: { start: number; end: number; text: string }[] = [];
  const span = (node: unknown) => {
    assert.ok(isRecord(node) && typeof node.start === "number" && typeof node.end === "number");
    return { start: node.start, end: node.end };
  };
  const edit = (node: unknown, text: string) => edits.push({ ...span(node), text });
  const name = (node: unknown) =>
    isRecord(node) && node.type === "Identifier" && typeof node.name === "string"
      ? node.name
      : undefined;
  if (kind === "rename-locals") {
    const bindings = new Map<string, string>();
    const bind = (pattern: unknown) => {
      for (const node of syntaxNodes(pattern)) {
        const id = name(node);
        if (id) bindings.set(id, `renamed_${id}`);
      }
    };
    for (const node of nodes) {
      if (node.type === "VariableDeclarator") bind(node.id);
      if (Array.isArray(node.params)) for (const param of node.params) bind(param);
    }
    const visit = (value: unknown, parent?: Record<string, unknown>, key?: string) => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item, parent, key);
        return;
      }
      if (!isRecord(value)) return;
      const id = name(value);
      if (value.type === "Property" && value.shorthand === true && isRecord(value.value)) {
        const local = name(value.value);
        if (local && bindings.has(local)) {
          edit(value, `${local}: ${bindings.get(local)!}`);
          return;
        }
      }
      if (
        id &&
        bindings.has(id) &&
        !(key === "property" && parent?.type === "MemberExpression" && !parent.computed) &&
        !(key === "key" && parent?.type === "Property" && !parent.computed)
      ) {
        edit(value, bindings.get(id)!);
        return;
      }
      for (const [childKey, child] of Object.entries(value))
        if (childKey !== "loc") visit(child, value, childKey);
    };
    visit(tree);
  } else if (kind === "reverse-helpers") {
    const callback = nodes.find((node) => node.type === "FunctionExpression");
    assert.ok(callback && isRecord(callback.body) && Array.isArray(callback.body.body));
    const helpers = callback.body.body.filter(
      (statement: unknown) =>
        isRecord(statement) &&
        statement.type === "VariableDeclaration" &&
        Array.isArray(statement.declarations) &&
        statement.declarations.every(
          (declaration: unknown) =>
            isRecord(declaration) &&
            isRecord(declaration.init) &&
            declaration.init.type === "ArrowFunctionExpression",
        ),
    );
    assert.ok(helpers.length >= 2, "The control must reorder independent callback helpers");
    helpers.forEach((helper: unknown, index: number) => {
      const replacement = span(helpers[helpers.length - index - 1]);
      edit(helper, source.slice(replacement.start, replacement.end));
    });
  } else
    for (const node of nodes) {
      if (
        kind === "bounds" &&
        node.type === "CallExpression" &&
        isRecord(node.callee) &&
        node.callee.type === "MemberExpression" &&
        name(node.callee.property) === "getBoundingClientRect"
      )
        edit(node, "({ left: 0, right: 0, top: 0, bottom: 0 })");
      if (
        (kind === "visible" || kind === "enabled") &&
        node.type === "Property" &&
        name(node.key) === kind
      )
        edit(node.value, "true");
    }
  assert.ok(edits.length > 0, `Control must change the actual callback: ${kind}`);
  let changed = source;
  let boundary = source.length;
  for (const part of edits.sort((left, right) => right.start - left.start)) {
    assert.ok(part.end <= boundary, "Control edits must not overlap");
    changed = changed.slice(0, part.start) + part.text + changed.slice(part.end);
    boundary = part.start;
  }
  return runInNewContext(changed.replace(/\r?\n/gu, "\r\n"), {}, { timeout: 1000 });
}
for (const kind of ["rename-locals", "reverse-helpers"] as const)
  void test(`serialized staged layout tolerates ${kind} and formatting changes`, async () => {
    const fixture = stagedDocument();
    assert.deepEqual(await fixture.observe(await callbackVariant(kind)), { ...valid, reason: "" });
    console.log(
      "Staged layout causal control observation:",
      JSON.stringify({ id: kind, kind: "harmless", outcome: "passed" }),
    );
  });
for (const kind of ["visible", "enabled", "bounds"] as const)
  void test(`serialized staged layout detects a removed ${kind === "bounds" ? "bounds input" : `${kind} gate`}`, async () => {
    const fixture = stagedDocument();
    fixture.detail.style.opacity = "0";
    fixture.play.disabled = true;
    const actual = await fixture.observe();
    const expected =
      kind === "visible"
        ? { play: { visible: false }, activate: { visible: false } }
        : kind === "enabled"
          ? { play: { enabled: false } }
          : { play: { right: valid.play.right }, activate: { left: valid.activate.left } };
    assert.partialDeepStrictEqual(actual, expected);
    const mutated = await fixture.observe(await callbackVariant(kind));
    assert.throws(() => assert.partialDeepStrictEqual(mutated, expected));
    console.log(
      "Staged layout causal control observation:",
      JSON.stringify({ id: kind, kind: "negative", outcome: "passed" }),
    );
  });

void test(
  "staged-layout native contracts execute without frontend packages and reject a leaked dependency",
  { timeout: 60_000 },
  (t) => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const entry = "apps/desktop/scripts/desktop-staged-layout.native.test.mts";
    const closure = readFixtureModuleClosure(root, [entry]);
    assert.ok(closure.external.every(isBuiltin), JSON.stringify(closure.external));
    const isolated = disposableDirectory(t, path.join(tmpdir(), "portcove-staged-layout-minimal-"));
    writeFileSync(path.join(isolated, "package.json"), '{"type":"module"}\n');
    for (const module of closure.modules) {
      const destination = path.join(isolated, module.path);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, module.bytes);
    }
    // Storage-owned scratch can sit below the checkout's installed packages.
    // Enforce the no-package contract at resolution, regardless of that ancestry.
    const policy = path.join(isolated, "no-package-imports.mjs");
    writeFileSync(policy, fixtureModulePolicySource(isolated));
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const execute = () =>
      spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(policy).href,
          "--test",
          "--test-reporter=tap",
          path.join(isolated, entry),
        ],
        {
          cwd: isolated,
          env: environment,
          encoding: "utf8",
          timeout: 20_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
    const result = execute();
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(
      result.stdout,
      /serialized staged layout retains action identity, state and actual placement facts/u,
    );
    const observedFixture = path.join(
      isolated,
      "apps/desktop/scripts/desktop-staged-layout-fixture.mts",
    );
    const originalFixture = readFileSync(observedFixture);
    for (const specifier of ["vite-plus", "portcove-unknown-fixture-package"]) {
      writeFileSync(observedFixture, originalFixture);
      writeFileSync(observedFixture, `\nimport ${JSON.stringify(specifier)};\n`, { flag: "a" });
      const broken = execute();
      assert.ifError(broken.error);
      assert.notEqual(broken.status, 0, broken.stdout + broken.stderr);
      assert.match(broken.stdout + broken.stderr, /Unexpected package import:/u);
      assert.ok((broken.stdout + broken.stderr).includes(specifier));
    }
    const outside = new URL("./runtime-values.mts", import.meta.url).href;
    writeFileSync(observedFixture, originalFixture);
    writeFileSync(observedFixture, `\nimport ${JSON.stringify(outside)};\n`, { flag: "a" });
    const escaped = execute();
    assert.ifError(escaped.error);
    assert.notEqual(escaped.status, 0, escaped.stdout + escaped.stderr);
    assert.match(escaped.stdout + escaped.stderr, /Fixture import escapes owned closure:/u);
    assert.ok((escaped.stdout + escaped.stderr).includes(outside));
  },
);
