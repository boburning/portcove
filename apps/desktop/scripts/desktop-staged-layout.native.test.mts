import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { isRecord } from "../../../scripts/runtime-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
import { assertStagedActionPlacement, readStagedLayout } from "./desktop-staged-layout.mts";

function checkPlacement(value: unknown) {
  Reflect.apply(assertStagedActionPlacement, undefined, [value]);
}
const valid = {
  play: { left: 20, right: 95, top: 20, bottom: 60, enabled: true, visible: true },
  activate: { left: 20, right: 223, top: 200, bottom: 240, enabled: true, visible: true },
  header: { left: 20, right: 900, top: 10, bottom: 160 },
  panel: { left: 20, right: 900, top: 180, bottom: 600 },
  versionsSelected: true,
  state: "Ready to play",
  attention: "Update saved for later · 2.0.0-fixture",
  viewport: { width: 960, height: 640 },
  documentOverflow: false,
};
void test("staged actions retain direct header Play and activation in the selected Versions panel", () =>
  checkPlacement(valid));
for (const [name, value] of [
  ["inactive Versions", { ...valid, versionsSelected: false }],
  ["incorrect readiness", { ...valid, state: "Setup required" }],
  ["missing attention", { ...valid, attention: undefined }],
  ["missing action", { ...valid, activate: undefined }],
  ["hidden action", { ...valid, activate: { ...valid.activate, visible: false } }],
  ["disabled action", { ...valid, play: { ...valid.play, enabled: false } }],
  ["zero size", { ...valid, play: { ...valid.play, right: 20 } }],
  ["nonfinite bounds", { ...valid, activate: { ...valid.activate, left: NaN } }],
  ["outside owning panel", { ...valid, activate: { ...valid.activate, top: 160 } }],
  ["horizontal overflow", { ...valid, activate: { ...valid.activate, right: 970 } }],
  ["document overflow", { ...valid, documentOverflow: true }],
] as const)
  void test(`staged actions reject ${name}`, () => assert.throws(() => checkPlacement(value)));

// Exercise the actual imported callback through the production WebDriver adapter.
// This is a synthetic browser realm, not an installed/native observation.
function stagedDocument() {
  const documentElement = { scrollWidth: 960, clientWidth: 960 };
  const style = () => ({ visibility: "visible", display: "block", opacity: "1" });
  type Bounds = { left: number; right: number; top: number; bottom: number };
  interface Node {
    parentElement: Node | null;
    style: { visibility: string; display: string; opacity: string };
    hidden: boolean;
    inert: boolean;
    shown: boolean;
    disabled: boolean;
    ariaDisabled: string | null;
    textContent: string;
    bounds: Bounds;
    getBoundingClientRect(): Bounds;
    getClientRects(): Bounds[];
    getAttribute(name: string): string | null;
    closest(selector: string): Node | null;
  }
  function element(bounds: Bounds, parentElement: Node | null = null): Node {
    return {
      parentElement,
      style: style(),
      hidden: false,
      inert: false,
      shown: true,
      disabled: false,
      ariaDisabled: null as string | null,
      textContent: "",
      bounds,
      getBoundingClientRect() {
        return this.bounds;
      },
      getClientRects() {
        return this.shown ? [this.bounds] : [];
      },
      getAttribute(name: string) {
        return name === "aria-disabled" ? this.ariaDisabled : null;
      },
      closest(selector: string): Node | null {
        if (selector === "[hidden], [inert]" && (this.hidden || this.inert)) return this;
        if (selector === ".detail-hero" && this === header) return this;
        return this.parentElement?.closest(selector) ?? null;
      },
    };
  }
  const detail = element({ left: 0, right: 960, top: 0, bottom: 640 });
  const header = element(valid.header, detail);
  const panel = element(valid.panel, detail);
  const play = element(valid.play, header);
  play.textContent = "Play";
  const activate = element(valid.activate, panel);
  activate.textContent = "Use update · 2.0.0-fixture";
  const unrelated = element(valid.activate, panel);
  unrelated.textContent = "Use update · another-version";
  const controls = [unrelated, activate];
  const text = {
    state: "Ready to play",
    reason: "",
    attention: valid.attention,
    selectedTab: "Versions & updates",
  };
  const panelQueries = Object.assign(panel, {
    querySelectorAll: (selector: string) => (selector === "button" ? controls : []),
  });
  const detailQueries = {
    querySelector(selector: string) {
      switch (selector) {
        case ".detail-header-actions [data-confirmed-play]":
          return play;
        case "[role=tabpanel]:not([hidden]):not([inert])":
          return panel.hidden || panel.inert ? null : panelQueries;
        case "[role=tab][aria-selected=true]":
          return { textContent: text.selectedTab };
        case "[data-detail-readiness]":
          return { textContent: text.state };
        case "[data-detail-reason]":
          return { textContent: text.reason };
        case "[data-update-attention]":
          return { textContent: text.attention };
        default:
          throw new Error(`Unexpected observation selector: ${selector}`);
      }
    },
  };
  const realm = {
    document: {
      querySelector: (selector: string) =>
        selector === "[data-detail-workspace]" ? detailQueries : null,
      documentElement,
    },
    innerWidth: 960,
    innerHeight: 640,
    getComputedStyle: (element: Node) => element.style,
  };
  let executions = 0;
  async function observe(callback: unknown = readStagedLayout, version = "2.0.0-fixture") {
    const browser = {
      async executeScript(script: unknown, ...args: unknown[]) {
        assert.equal(script, callback, "The adapter must forward the actual callback");
        assert.equal(typeof script, "function");
        executions++;
        const result: unknown = runInNewContext(
          `(${Function.prototype.toString.call(script)})(...args)`,
          { ...realm, args },
          { timeout: 1000 },
        );
        // WebDriver transports JSON values, not foreign-realm prototypes.
        const transported: unknown = JSON.parse(JSON.stringify(result));
        return transported;
      },
    };
    const result: unknown = await Reflect.apply(executeBrowserScript, undefined, [
      browser,
      callback,
      version,
    ]);
    return result;
  }
  return {
    detail,
    header,
    panel,
    play,
    activate,
    controls,
    text,
    documentElement,
    observe,
    executions: () => executions,
  };
}

void test("serialized staged layout retains action identity, state and actual placement facts", async () => {
  const fixture = stagedDocument();
  const observed = await fixture.observe();
  assert.deepEqual(observed, { ...valid, reason: "" });
  checkPlacement(observed);
  fixture.controls.reverse();
  assert.deepEqual(
    await fixture.observe(),
    observed,
    "Unrelated button order is not the action identity",
  );
  assert.equal(fixture.executions(), 2);
  fixture.play.bounds = { left: 20, right: 128, top: 20, bottom: 60 };
  fixture.activate.bounds = { left: 136, right: 339, top: 200, bottom: 240 };
  fixture.header.bounds = { left: 20, right: 900, top: 10, bottom: 150 };
  fixture.panel.bounds = { left: 20, right: 900, top: 190, bottom: 600 };
  const moved = await fixture.observe();
  assert.partialDeepStrictEqual(moved, {
    play: fixture.play.bounds,
    activate: fixture.activate.bounds,
    header: fixture.header.bounds,
    panel: fixture.panel.bounds,
  });
  checkPlacement(moved);
  const missing = await fixture.observe(readStagedLayout, "missing-version");
  assert.ok(missing && typeof missing === "object");
  assert.equal(Reflect.get(missing, "activate"), undefined);
  assert.throws(() => checkPlacement(missing));
});

for (const [name, change, expected] of [
  [
    "transparent common ancestor",
    (f: ReturnType<typeof stagedDocument>) => {
      f.detail.style.opacity = "0";
    },
    { play: { visible: false }, activate: { visible: false } },
  ],
  [
    "transparent header",
    (f: ReturnType<typeof stagedDocument>) => {
      f.header.style.opacity = "0";
    },
    { play: { visible: false }, activate: { visible: true } },
  ],
  [
    "transparent panel",
    (f: ReturnType<typeof stagedDocument>) => {
      f.panel.style.opacity = "0";
    },
    { play: { visible: true }, activate: { visible: false } },
  ],
  [
    "display-none ancestor",
    (f: ReturnType<typeof stagedDocument>) => {
      f.detail.style.display = "none";
    },
    { play: { visible: false }, activate: { visible: false } },
  ],
  [
    "hidden ancestor",
    (f: ReturnType<typeof stagedDocument>) => {
      f.detail.hidden = true;
    },
    { play: { visible: false }, activate: { visible: false } },
  ],
  [
    "inert ancestor",
    (f: ReturnType<typeof stagedDocument>) => {
      f.detail.inert = true;
    },
    { play: { visible: false }, activate: { visible: false } },
  ],
  [
    "missing client rectangles",
    (f: ReturnType<typeof stagedDocument>) => {
      f.play.shown = false;
      f.activate.shown = false;
    },
    { play: { visible: false }, activate: { visible: false } },
  ],
  [
    "hidden computed visibility",
    (f: ReturnType<typeof stagedDocument>) => {
      f.play.style.visibility = "hidden";
      f.activate.style.visibility = "hidden";
    },
    { play: { visible: false }, activate: { visible: false } },
  ],
  [
    "aria-disabled actions",
    (f: ReturnType<typeof stagedDocument>) => {
      f.play.ariaDisabled = "true";
      f.activate.ariaDisabled = "true";
    },
    { play: { enabled: false }, activate: { enabled: false } },
  ],
  [
    "native-disabled actions",
    (f: ReturnType<typeof stagedDocument>) => {
      f.play.disabled = true;
      f.activate.disabled = true;
    },
    { play: { enabled: false }, activate: { enabled: false } },
  ],
  [
    "inactive Versions tab",
    (f: ReturnType<typeof stagedDocument>) => {
      f.text.selectedTab = "Summary";
    },
    { versionsSelected: false },
  ],
  [
    "document overflow",
    (f: ReturnType<typeof stagedDocument>) => {
      f.documentElement.scrollWidth = 962;
    },
    { documentOverflow: true },
  ],
] as const)
  void test(`serialized staged layout reports ${name}`, async () => {
    const fixture = stagedDocument();
    change(fixture);
    const observed = await fixture.observe();
    assert.partialDeepStrictEqual(observed, expected);
    assert.throws(() => checkPlacement(observed));
  });

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
