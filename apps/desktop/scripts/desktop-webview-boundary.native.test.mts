import {
  parseBoundaryReply,
  invokeBoundary,
  armBoundaryOwner,
} from "./desktop-boundary-invoke.mts";
import type { WebDriver } from "selenium-webdriver";
import assert from "node:assert/strict";
import test from "node:test";
import { parseAst } from "vite-plus";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { isRecord } from "../../../scripts/runtime-values.mts";

void test("erased boundary reply parser checks every declared optional scalar", () => {
  const parse = parseBoundaryReply;
  for (const value of [
    { unavailable: true, ok: 42 },
    { unavailable: true, error: {} },
    { ok: true, error: {} },
    { ok: true, unavailable: 42 },
    { ok: false, error: null },
  ]) {
    assert.throws(() => parse(value));
  }
  for (const value of [
    { unavailable: true },
    { ok: true, value: { retained: true }, metadata: 42 },
    { ok: false, error: "refused" },
  ]) {
    assert.equal(JSON.stringify(parse(value)), JSON.stringify(value));
  }
});

void test("erased boundary owner hook preserves real fetch arguments and releases queued replies", async () => {
  for (const kind of ["string", "URL", "Request"] as const) {
    const url = "https://ipc.localhost/queue";
    const input = kind === "string" ? url : kind === "URL" ? new URL(url) : new Request(url);
    const calls: { input: RequestInfo | URL; options?: RequestInit | undefined }[] = [];
    const delivery: { callback?: (value: unknown) => void } = {};
    const original: typeof fetch = async (input, options) => {
      calls.push({ input, options });
      return new Response("owned native fetch");
    };
    const host = {
      fetch: original,
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (value: unknown) => void) => {
          delivery.callback = callback;
          return 7;
        },
      },
    };
    const switched: string[] = [];
    const browser = {
      switchTo: () => ({
        window: async (label: string) => {
          switched.push(label);
        },
      }),
      executeScript: async (script: unknown, ...values: unknown[]) => {
        assert.ok(typeof script === "function");
        assert.deepEqual(switched, ["boundary-secondary"]);
        const result: unknown = runInNewContext(
          `(${script.toString()})(...values)`,
          { window: host, Headers, URL, values },
          { timeout: 1000 },
        );
        return result;
      },
    } as unknown as WebDriver;
    assert.equal(await armBoundaryOwner(browser), 7);
    const options = { headers: { "Tauri-Channel-Id": "12" } };
    const queued = host.fetch(input, options);
    assert.equal(calls.length, 0);
    const held: unknown = Reflect.get(host, "__boundaryHeld");
    assert.ok(isRecord(held));
    assert.equal(held.id, "12");
    assert.equal(held.input, url);
    assert.equal(
      await (
        await host.fetch("https://ipc.localhost/foreign", { headers: { "Tauri-Channel-Id": "13" } })
      ).text(),
      "owned native fetch",
    );
    assert.equal(calls.length, 1, "A held owner request must not intercept another channel");
    const release: unknown = Reflect.get(host, "__boundaryRelease");
    assert.ok(typeof release === "function");
    Reflect.apply(release, undefined, []);
    assert.equal(await (await queued).text(), "owned native fetch");
    assert.equal(calls.at(-1)?.input, input);
    assert.equal(calls.at(-1)?.options, options);
    assert.equal(host.fetch, original);
    assert.ok(delivery.callback);
    delivery.callback({ message: "PORTCOVE_SYNTHETIC_QUEUE:owned" });
    assert.equal(Reflect.get(host, "__boundaryDelivery"), "PORTCOVE_SYNTHETIC_QUEUE:owned");
  }
});

void test(
  "actual boundary invocation serializes native arguments and parses the returned reply",
  { timeout: 10_000 },
  async () => {
    for (const outcome of ["success", "failure", "unavailable"] as const) {
      const calls: unknown[][] = [];
      const payload = { retained: true };
      const args = { selected: "owned" };
      const options = { marker: "unchanged" };
      const native =
        outcome === "unavailable"
          ? undefined
          : {
              invoke(...values: unknown[]) {
                calls.push(values);
                return outcome === "success"
                  ? Promise.resolve(payload)
                  : Promise.reject("owned refusal");
              },
            };
      const browser = {
        executeAsyncScript(callback: unknown, ...values: unknown[]) {
          assert.ok(typeof callback === "function");
          // Execute the actual serialized browser callback; host orchestration is imported.
          return new Promise((done) => {
            runInNewContext(
              `(${callback.toString()})(...values, done)`,
              { window: { __TAURI_INTERNALS__: native }, values, done },
              { timeout: 1000 },
            );
          });
        },
      } as unknown as WebDriver;
      const result = await invokeBoundary(browser, "owned-command", args, options);
      if (outcome === "unavailable") {
        assert.deepEqual(result, { unavailable: true });
        assert.deepEqual(calls, []);
      } else {
        assert.deepEqual(calls, [["owned-command", args, options]]);
        assert.deepEqual(
          result,
          outcome === "success"
            ? { ok: true, value: payload }
            : { ok: false, error: "owned refusal" },
        );
      }
    }
    const malformed = {
      executeAsyncScript: () => Promise.resolve({ ok: 17 }),
    } as unknown as WebDriver;
    await assert.rejects(invokeBoundary(malformed, "owned-command"));
  },
);

void test("native boundary entrypoint retains its imported parsed invocation route", async () => {
  const source = stripTypeScriptTypes(
    await readFile(new URL("./desktop-webview-boundary.mts", import.meta.url), "utf8"),
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
