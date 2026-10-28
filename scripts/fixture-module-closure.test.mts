import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isBuiltin } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { readFixtureModuleClosure } from "./fixtures/module-closure.mts";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";

function fixture(context: TestContext, sharedLinks: string[] = []) {
  const root = disposableDirectory(context, path.join(tmpdir(), "portcove-module-closure-"), {
    sharedLinks,
  });
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  return root;
}

function write(root: string, name: string, contents: string | Buffer) {
  mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  writeFileSync(path.join(root, name), contents);
}

void test("fixture closure follows multiline imports, reexports, literals and cycles without executing input", (context) => {
  const root = fixture(context);
  write(
    root,
    "entry.mts",
    `
    import type { Missing } from './not-a-runtime-input.mts';
    import {
      value
    } from './nested/value.mts';
    export { value } from './nested/value.mts';
    import './side-effect.mjs';
    import('node:fs');
    import('./lazy.mjs');
    // import './not-a-dependency.mjs';
    const example = "import './also-not-a-dependency.mjs'";
    const metadata = import.meta.url;
    throw new Error('enumeration must never execute this');
  `,
  );
  write(root, "nested/value.mts", "import '../entry.mts'; export const value: number = 7;\n");
  write(root, "side-effect.mjs", "throw new Error('not executed');\n");
  write(root, "lazy.mjs", "export const lazy = true;\n");
  const inventory = readFixtureModuleClosure(root, ["entry.mts"]);
  assert.deepEqual(
    inventory.modules.map((module) => module.path),
    ["entry.mts", "lazy.mjs", "nested/value.mts", "side-effect.mjs"],
  );
  assert.deepEqual(inventory.external, ["node:fs"]);
});

void test("escaped fixture specifiers decode with string code generation disabled", (context) => {
  const root = fixture(context);
  write(
    root,
    "entry.mjs",
    String.raw`import './\x76alue.mjs'; import('./\u006cazy.mjs'); throw new Error('must not execute');`,
  );
  write(root, "value.mjs", "throw new Error('must not execute');\n");
  write(root, "lazy.mjs", "throw new Error('must not execute');\n");
  const helper = new URL("./fixtures/module-closure.mts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--disallow-code-generation-from-strings",
      "--input-type=module",
      "--eval",
      `import { readFixtureModuleClosure } from ${JSON.stringify(helper)}; console.log(JSON.stringify(readFixtureModuleClosure(${JSON.stringify(root)}, ['entry.mjs']).modules.map(module => module.path)));`,
    ],
    { encoding: "utf8", timeout: 10000, windowsHide: true },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["entry.mjs", "lazy.mjs", "value.mjs"]);
});

void test("new imports are copied from retained bytes and change identity without rewriting policy expectations", (context) => {
  const root = fixture(context);
  write(root, "entry.mjs", "import { value } from './value.mjs'; console.log(value);\n");
  write(root, "value.mjs", "export const value = 'before';\n");
  // Independent reviewed expectation; never regenerate it from the candidate.
  const expected = ["entry.mjs", "value.mjs"];
  const before = readFixtureModuleClosure(root, ["entry.mjs"]);
  assert.deepEqual(
    before.modules.map((module) => module.path),
    expected,
  );
  write(root, "value.mjs", "export { value } from './added.mjs';\n");
  write(root, "added.mjs", "export const value = 'after';\n");
  const after = readFixtureModuleClosure(root, ["entry.mjs"]);
  assert.throws(() =>
    assert.deepEqual(
      after.modules.map((module) => module.path),
      expected,
    ),
  );
  assert.notEqual(
    after.modules.find((module) => module.path === "value.mjs")!.sha256,
    before.modules.find((module) => module.path === "value.mjs")!.sha256,
  );
  for (const [index, inventory, output] of [
    [0, before, "before\n"],
    [1, after, "after\n"],
  ] as const) {
    const copied = fixture(context);
    for (const module of inventory.modules) write(copied, module.path, module.bytes);
    const result = spawnSync(process.execPath, ["entry.mjs"], {
      cwd: copied,
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `copied closure ${index}: ${result.stderr}`);
    assert.equal(result.stdout, output);
  }
});

void test("fixture closure records external packages separately and includes JSON inputs", (context) => {
  const root = fixture(context);
  write(
    root,
    "entry.mjs",
    "import 'yaml'; import data from './data.json' with { type: 'json' };\n",
  );
  write(root, "data.json", '{"value":7}\n');
  const result = readFixtureModuleClosure(root, ["entry.mjs"]);
  assert.deepEqual(
    result.modules.map((module) => module.path),
    ["data.json", "entry.mjs"],
  );
  assert.deepEqual(result.external, ["yaml"]);
});

void test("explicit static bootstrap scope keeps later runtime imports separate", (context) => {
  const root = fixture(context);
  write(
    root,
    "entry.mjs",
    "import './static.mjs'; const later = './not-bootstrap.mjs'; import(later); import(`./${later}.mjs`);\n",
  );
  write(root, "static.mjs", "export const value = 1;\n");
  assert.deepEqual(
    readFixtureModuleClosure(root, ["entry.mjs"], { includeDynamicImports: false }).modules.map(
      (module) => module.path,
    ),
    ["entry.mjs", "static.mjs"],
  );
  assert.throws(() => readFixtureModuleClosure(root, ["entry.mjs"]), /computed import/u);
});

void test("literal import stars and substitution-free templates remain exact inputs", (context) => {
  const root = fixture(context);
  write(root, "entry.mjs", "import('external*literal'); import(`./plain.mjs`);\n");
  write(root, "plain.mjs", "throw new Error('closure enumeration must not execute inputs');\n");
  const inventory = readFixtureModuleClosure(root, ["entry.mjs"]);
  assert.deepEqual(
    inventory.modules.map((module) => module.path),
    ["entry.mjs", "plain.mjs"],
  );
  assert.deepEqual(inventory.external, ["external*literal"]);
});

void test("encoded URL aliases are refused instead of retaining a different file from Node", (context) => {
  const root = fixture(context);
  write(root, "entry.mjs", "import { value } from './%76alue.mjs'; console.log(value);\n");
  write(root, "value.mjs", "export const value = 'actual Node input';\n");
  write(root, "%76alue.mjs", "export const value = 'incorrect literal input';\n");
  const result = spawnSync(process.execPath, ["entry.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "actual Node input\n");
  assert.throws(() => readFixtureModuleClosure(root, ["entry.mjs"]), /plain relative import/u);
});

void test("dot-prefixed package names remain external inputs", (context) => {
  const root = fixture(context);
  write(root, "entry.mjs", "import '.hidden-package';\n");
  const result = readFixtureModuleClosure(root, ["entry.mjs"]);
  assert.deepEqual(
    result.modules.map((module) => module.path),
    ["entry.mjs"],
  );
  assert.deepEqual(result.external, [".hidden-package"]);
});

void test(
  "Windows case aliases terminate and retain one canonical module",
  {
    skip:
      process.platform !== "win32" &&
      "Windows case-insensitive filesystem route; executed by development-tools on Windows",
  },
  (context) => {
    const root = fixture(context);
    write(root, "entry.mjs", "export const value = 1;\n");
    const helper = new URL("./fixtures/module-closure.mts", import.meta.url).href;
    write(
      root,
      "probe.mjs",
      `
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import { readFixtureModuleClosure } from ${JSON.stringify(helper)};
    const root = process.argv[2];
    const alias = '../' + path.basename(root).toUpperCase() + '/entry.mjs';
    const result = readFixtureModuleClosure(root, ['entry.mjs', alias]);
    assert.deepEqual(result.modules.map(module => module.path), ['entry.mjs']);
    console.log('canonical entry retained');
  `,
    );
    const result = spawnSync(process.execPath, ["probe.mjs", root], {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "canonical entry retained\n");
  },
);

void test(
  "the filtered Windows discovery route executes from a copy without installed packages",
  {
    skip:
      process.platform !== "win32" &&
      "Windows reader-sharing route; executed by development-tools on Windows",
  },
  (context) => {
    const root = fixture(context);
    const inventory = readFixtureModuleClosure(
      fileURLToPath(new URL("../", import.meta.url)),
      ["scripts/daily-discovery.test.mts"],
      { includeDynamicImports: false },
    );
    assert.ok(inventory.external.every(isBuiltin), inventory.external.join(", "));
    for (const module of inventory.modules) write(root, module.path, module.bytes);
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-timeout=15000",
        "--test-reporter=tap",
        "--test-name-pattern=Windows reader sharing",
        "scripts/daily-discovery.test.mts",
      ],
      { cwd: root, env: environment, encoding: "utf8", timeout: 20000, windowsHide: true },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# pass 1\b/u);
    assert.match(result.stdout, /# fail 0\b/u);
  },
);

for (const [name, source, error] of [
  ["computed imports", "const name = './value.mjs'; import(name);", /computed import/u],
  ["template globs", "const name = 'value'; import(`./${name}.mjs`);", /computed import/u],
  ["package aliases", "import '#local';", /package import alias/u],
  ["absolute URLs", "import 'file:///outside.mjs';", /absolute import/u],
  ["data URLs", "import 'data:text/javascript,export default 1';", /absolute import/u],
  ["escaping relative inputs", "import '../outside.mjs';", /escapes its root/u],
  ["query aliases", "import './value.mjs?other';", /plain relative import/u],
  ["encoded root escapes", "import './%2e%2e/outside.mjs';", /plain relative import/u],
] as const) {
  void test(`fixture closure refuses ${name}`, (context) => {
    const root = fixture(context);
    write(root, "entry.mjs", source);
    assert.throws(() => readFixtureModuleClosure(root, ["entry.mjs"]), error);
  });
}

void test("fixture closure refuses missing or unsupported modules and invalid UTF-8", (context) => {
  const root = fixture(context);
  write(root, "entry.mjs", "import './missing.mjs';\n");
  assert.throws(() => readFixtureModuleClosure(root, ["entry.mjs"]), /ENOENT/u);
  write(root, "entry.cjs", "require('./missing.cjs');\n");
  assert.throws(() => readFixtureModuleClosure(root, ["entry.cjs"]), /explicit ESM/u);
  write(root, "invalid.mjs", Buffer.from([0xff]));
  assert.throws(() => readFixtureModuleClosure(root, ["invalid.mjs"]), /encoded data/u);
});

void test("fixture closure refuses linked dependencies without changing the external target", (context) => {
  const root = fixture(context, ["linked"]);
  const outside = fixture(context);
  write(outside, "value.mjs", "export const value = 'external';\n");
  symlinkSync(outside, path.join(root, "linked"), "junction");
  write(root, "entry.mjs", "import './linked/value.mjs';\n");
  assert.throws(() => readFixtureModuleClosure(root, ["entry.mjs"]), /refuses a link/u);
  assert.equal(
    readFileSync(path.join(outside, "value.mjs"), "utf8"),
    "export const value = 'external';\n",
  );
});

void test("fixture closure requires entries and enforces finite module and byte bounds", (context) => {
  const root = fixture(context);
  assert.throws(() => readFixtureModuleClosure(root, []), /entry point/u);
  assert.throws(
    () => readFixtureModuleClosure(root, [path.join(root, "entry.mjs")]),
    /must be relative/u,
  );
  write(root, "large.mjs", " ".repeat(1024 * 1024 + 1));
  assert.throws(() => readFixtureModuleClosure(root, ["large.mjs"]), /exceeds 1 MiB/u);
  for (let index = 0; index < 257; index++)
    write(root, `${index}.mjs`, index < 256 ? `import './${index + 1}.mjs';\n` : "");
  assert.throws(() => readFixtureModuleClosure(root, ["0.mjs"]), /exceeds 256 files/u);
  for (let index = 0; index < 9; index++)
    write(root, `bytes-${index}.mjs`, " ".repeat(1024 * 1024));
  write(
    root,
    "bytes.mjs",
    Array.from({ length: 9 }, (_, index) => `import './bytes-${index}.mjs';`).join("\n"),
  );
  assert.throws(() => readFixtureModuleClosure(root, ["bytes.mjs"]), /exceeds 8 MiB/u);
});

void test("cover and catalog Native contracts execute without optional package installation", (t) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = fixture(t);
  const prefix = "apps/desktop/scripts/";
  const entries = [
    "desktop-default-cover.native.test.mts",
    "desktop-catalog-update.native.test.mts",
  ].map((name) => prefix + name);
  const production = ["desktop-default-cover-test.mts", "desktop-catalog-update-test.mts"].map(
    (name) => prefix + name,
  );
  const closure = readFixtureModuleClosure(root, [...entries, ...production]);
  // The real production graph is copied. The fixture replaces WebDriver/axe
  // package shapes and the native transport boundary before their evaluation.
  const optionalPackages = ["ajv/dist/2020.js", "axe-core", "selenium-webdriver"];
  assert.deepEqual(
    closure.external.filter((dependency) => !isBuiltin(dependency)),
    optionalPackages,
  );
  for (const module of closure.modules) write(directory, module.path, module.bytes);
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", ...entries], {
    env: environment,
    cwd: directory,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // Two catalog cases and six cover cases, including selection and surface controls.
  assert.match(result.stdout, /pass 8/u);
  assert.match(result.stdout, /fail 0/u);
});
