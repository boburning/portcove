import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { init, parse } from "es-module-lexer";

// A module whose top-level await is still pending cannot finish another import
// graph that contains it. If code reached during that await dynamically imports
// a module that (statically) leads back to it, Node empties the event loop and
// exits 13 with "unsettled top-level await" (#8417). Executable scripts are the
// modules with top-level await; derive them from the source, never by hand.

const root = fileURLToPath(new URL("../", import.meta.url));

/** Pre-existing candidates outside #8417. Remove an entry when its cycle is gone; never add one. */
const knownCandidates = new Set([
  "scripts/resource-host-bridge.mts: scripts/resource-capacity.mts -> import(scripts/resource-host-bridge.mts)",
  "scripts/run-rust-tests.mts: scripts/resource-capacity.mts -> import(scripts/run-rust-tests.mts)",
]);

interface ModuleEdges {
  static: Set<string>;
  dynamic: Set<string>;
}

function scriptModules(directory = "scripts"): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : scriptModules(relative);
    return /\.mts$/u.test(entry.name) && !/\.test\.mts$/u.test(entry.name) ? [relative] : [];
  });
}

/** Value imports only: stripping erases `import type`, and an emptied import still evaluates. */
async function moduleGraph(files: readonly string[]) {
  await init();
  const known = new Set(files);
  const sources = new Map<string, string>();
  const graph = new Map<string, ModuleEdges>();
  for (const file of files) {
    const javascript = stripTypeScriptTypes(readFileSync(path.join(root, file), "utf8"), {
      mode: "strip",
    });
    sources.set(file, javascript);
    const edges: ModuleEdges = { static: new Set(), dynamic: new Set() };
    for (const entry of parse(javascript)[0]) {
      if (entry.type === "import-meta" || typeof entry.specifier !== "string") continue;
      if (!entry.specifier.startsWith(".")) continue;
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), entry.specifier),
      );
      if (known.has(target)) (entry.type === "dynamic" ? edges.dynamic : edges.static).add(target);
    }
    graph.set(file, edges);
  }
  return { graph, sources };
}

/** Exact V8 module parse without linking or evaluation. */
function topLevelAwaitModules(sources: Map<string, string>): string[] {
  const probe = `const vm = await import("node:vm");
    const sources = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    process.stdout.write(JSON.stringify(Object.keys(sources).filter((file) =>
      new vm.SourceTextModule(sources[file], { identifier: file }).hasTopLevelAwait())));`;
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-vm-modules",
      "--no-warnings",
      "--input-type=commonjs",
      "-e",
      `(async () => { ${probe} })().catch((error) => { console.error(error); process.exitCode = 1; });`,
    ],
    {
      input: JSON.stringify(Object.fromEntries(sources)),
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as string[];
}

function closure(graph: Map<string, ModuleEdges>, start: string, dynamic: boolean) {
  const seen = new Set([start]);
  const queue = [start];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    const edges = graph.get(file)!;
    for (const next of dynamic ? [...edges.static, ...edges.dynamic] : edges.static)
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
  }
  return seen;
}

/** Each dynamic import reachable from a top-level-await module whose static graph re-enters it. */
function deadlockCandidates(graph: Map<string, ModuleEdges>, awaiting: readonly string[]) {
  const candidates = new Set<string>();
  for (const entry of awaiting)
    for (const importer of closure(graph, entry, true))
      for (const target of graph.get(importer)!.dynamic)
        if (closure(graph, target, false).has(entry))
          candidates.add(`${entry}: ${importer} -> import(${target})`);
  return candidates;
}

void test("the deadlock rule reports a dynamic import that re-enters an awaiting entry", () => {
  const edges = (s: string[], d: string[] = []) => ({ static: new Set(s), dynamic: new Set(d) });
  const graph = new Map<string, ModuleEdges>([
    ["runner", edges(["shared"], ["status"])],
    ["status", edges(["runner"])],
    ["shared", edges([])],
  ]);
  assert.deepEqual(
    [...deadlockCandidates(graph, ["runner"])],
    ["runner: runner -> import(status)"],
  );
  graph.set("status", edges(["shared"]));
  assert.deepEqual([...deadlockCandidates(graph, ["runner"])], []);
});

void test("no script dynamically re-enters a module whose top-level await is pending", async () => {
  const files = scriptModules();
  const { graph, sources } = await moduleGraph(files);
  const awaiting = topLevelAwaitModules(sources);
  assert.ok(awaiting.includes("scripts/hosted-discovery-intake-runner.mts"));
  assert.ok(awaiting.includes("scripts/hosted-discovery-intake.mts"));
  const candidates = deadlockCandidates(graph, awaiting);
  assert.deepEqual(
    [...candidates].filter((candidate) => !knownCandidates.has(candidate)),
    [],
    "move bindings shared with an executable script into a non-entry module",
  );
  assert.deepEqual(
    [...knownCandidates].filter((candidate) => !candidates.has(candidate)),
    [],
    "remove resolved candidates from the known list",
  );
  // The #8417 scheduled runner is an executable entry only; nothing imports it.
  const importers = files.filter((file) => {
    const edges = graph.get(file)!;
    const runner = "scripts/hosted-discovery-intake-runner.mts";
    return edges.static.has(runner) || edges.dynamic.has(runner);
  });
  assert.deepEqual(importers, []);
});
