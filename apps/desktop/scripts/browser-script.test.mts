import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { Capabilities, Session, WebDriver, WebElement } from "selenium-webdriver";
import type { Command } from "selenium-webdriver/lib/command.js";
import { it } from "vite-plus/test";
import { isRecord } from "../../../scripts/runtime-values.mts";
import { executeBrowserScript } from "./browser-script.mts";

it("checks the DOM value delivered for a serialized WebDriver element handle", async () => {
  const driver = new WebDriver(new Session("fixture", new Capabilities()), {
    async execute(command: Command): Promise<unknown> {
      const script: unknown = command.getParameter("script");
      const args: unknown = command.getParameter("args");
      assert(typeof script === "string" && Array.isArray(args));
      const decoded = args.map((argument: unknown) => {
        assert(isRecord(argument));
        assert.equal(argument["element-6066-11e4-a52e-4f735466cecf"], "owned-element");
        return { id: "owned-dom-id" };
      });
      const result: unknown = runInNewContext(`(function(){${script}}).apply(null, args)`, {
        args: decoded,
      });
      return result === decoded[0]
        ? { "element-6066-11e4-a52e-4f735466cecf": "owned-element" }
        : result;
    },
  });
  const id: string = await executeBrowserScript(
    driver,
    (element) => element.id,
    new WebElement(driver, "owned-element"),
  );
  assert.equal(id, "owned-dom-id");
  const returned: WebElement = await executeBrowserScript(
    driver,
    (element) => element,
    new WebElement(driver, "owned-element"),
  );
  assert.equal(await returned.getId(), "owned-element");
});

it("native Node erases callback annotations before Selenium serializes executable JavaScript", async () => {
  const parent = fileURLToPath(new URL("../../../work/browser-script-fixtures/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "native-"));
  try {
    const fixture = path.join(directory, "callback.mts");
    const selenium = pathToFileURL(createRequire(import.meta.url).resolve("selenium-webdriver"));
    const helper = new URL("./browser-script.mts", import.meta.url);
    // This generated syntax fixture deliberately contains an annotation: only
    // the real native Node loader, not Vitest's transform, may erase it.
    await writeFile(
      fixture,
      `
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import webdriver from ${JSON.stringify(selenium.href)};
import { executeBrowserScript } from ${JSON.stringify(helper.href)};
let serialized = "";
const driver = new webdriver.WebDriver(new webdriver.Session("fixture", new webdriver.Capabilities()), {
  async execute(command) {
    serialized = command.getParameter("script");
    return runInNewContext("(function(){" + serialized + "}).apply(null,args)", {args: command.getParameter("args")});
  }
});


const value = await executeBrowserScript(driver, (value: number): number => value + 1, 41);
assert.equal(value, 42);
console.log(JSON.stringify({ value, serialized, node: process.version }));
`,
    );
    const child = spawnSync(process.execPath, [fixture], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    const result: unknown = JSON.parse(child.stdout);
    assert(isRecord(result) && typeof result.serialized === "string");
    assert.equal(result.value, 42);
    assert.equal(result.node, process.version);
    assert.doesNotMatch(result.serialized, /:\s*number/u);
  } finally {
    assert.equal(path.dirname(directory), parent.replace(/[\\/]$/u, ""));
    await rm(directory, { recursive: true, force: true });
  }
});

it("maps nested element arguments/results and propagates executor rejection", async () => {
  const elements = new WeakSet<object>();
  const decode = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(decode);
    if (!isRecord(value)) return value;
    if (value["element-6066-11e4-a52e-4f735466cecf"] === "nested") {
      const element = { id: "nested-dom" };
      elements.add(element);
      return element;
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  };
  const encode = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(encode);
    if (!isRecord(value)) return value;
    if (elements.has(value)) return { "element-6066-11e4-a52e-4f735466cecf": "nested" };
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  };
  const failure = new Error("owned executor failure");
  let reject = false;
  const driver = new WebDriver(new Session("nested-fixture", new Capabilities()), {
    async execute(command: Command): Promise<unknown> {
      if (reject) throw failure;
      const script: unknown = command.getParameter("script");
      assert(typeof script === "string");
      const args = decode(command.getParameter("args"));
      const value: unknown = runInNewContext(`(function(){${script}}).apply(null,args)`, { args });
      return encode(value);
    },
  });
  const result = await executeBrowserScript(
    driver,
    (input) => ({
      id: input.rows[0].element.id,
      rows: [input.rows[0].element],
    }),
    { rows: [{ element: new WebElement(driver, "nested") }] as const },
  );
  assert.equal(result.id, "nested-dom");
  const returned = result.rows[0];
  assert(returned instanceof WebElement);
  assert.equal(await returned.getId(), "nested");
  reject = true;
  await assert.rejects(
    executeBrowserScript(driver, () => "unreached"),
    (error) => error === failure,
  );
});
