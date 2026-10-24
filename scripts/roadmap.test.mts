import type { RoadmapIssueItem } from "./roadmap.mts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  roadmapHelp,
  roadmapCommandHelp,
  analyzeReleaseReadiness,
  materializeViews,
  parseArguments,
  selectNextItems,
  validateConfig,
} from "./roadmap.mts";

import { fixtureValue, fixtureFind, config } from "./fixtures/roadmap-fixtures.mts";

void test("checked-in configuration contains schema rather than volatile item state", () => {
  assert.doesNotThrow(() => validateConfig(config));
  const invalid = structuredClone(config);
  Object.assign(invalid.project, { items: [{ title: "mutable backlog" }] });
  assert.throws(() => validateConfig(invalid), /volatile planning data/);
});

void test("argument parsing keeps positional item references and named values distinct", () => {
  assert.deepEqual(parseArguments(["set", "#42", "--status", "In progress", "--release=Alpha 1"]), {
    command: "set",
    positionals: ["#42"],
    options: { "--status": "In progress", "--release": "Alpha 1" },
  });
  assert.deepEqual(parseArguments(["set-many", "--spec-file", "plan.json", "--apply", "--json"]), {
    command: "set-many",
    positionals: [],
    options: { "--spec-file": "plan.json", "--apply": true, "--json": true },
  });
  assert.throws(() => parseArguments(["move", "PVTI_1", "--before"]), /requires a value/);
});

void test("display outcome markers and release views cannot change gate or execution membership", () => {
  const fields = {
    Status: "Ready",
    Horizon: "Next",
    Priority: "High",
    "Work type": "Product feature",
    "Target release": "Public beta",
    "Release commitment": "Planned",
  };
  const item = {
    id: "PVTI_demo",
    content: { number: 99, state: "OPEN", title: "Demo", body: "" },
    fieldValues: Object.entries(fields).map(([name, value]) => ({ name: value, field: { name } })),
  };
  const marked = { ...item, labels: [config.outcome_label] };
  const summarize = (record: RoadmapIssueItem) => {
    const analysis = analyzeReleaseReadiness([record], "Public beta");
    return {
      ready: analysis.ready,
      required: analysis.effectiveRequired.map((entry) => entry.id),
      unfinished: analysis.unfinishedRequired.map((entry) => entry.id),
      planned: analysis.planned.map((entry) => entry.id),
    };
  };
  assert.deepEqual(summarize(item), summarize(marked));
  assert.equal(selectNextItems([marked])[0], marked);
  const byName = new Map(materializeViews(config).map((view) => [view.name, view]));
  assert.match(fixtureValue(byName.get("Product Outcomes")).filter, /label:roadmap-outcome/);
  assert.doesNotMatch(fixtureValue(byName.get("Product Outcomes")).filter, /-status:Done/);
  assert.match(fixtureValue(byName.get("In Progress")).filter, /status:/);
  assert.doesNotMatch(fixtureValue(byName.get("In Progress")).filter, /horizon:/);
  assert.equal(fixtureValue(byName.get("Port Pipeline")).filter, "work-type:Port");
  assert.match(fixtureValue(byName.get("Required for Beta")).filter, /release-commitment:Required/);
  assert.match(fixtureValue(byName.get("Planned Additions")).filter, /release-commitment:Planned/);
});

void test("set help renders every configured field option without live access", async () => {
  const config = validateConfig(
    JSON.parse(await readFile(new URL("../.github/roadmap.json", import.meta.url), "utf8")),
  );
  const help = roadmapCommandHelp("set", config);
  assert.match(help, /--type:/);
  assert.match(help, /--status: Inbox/);
  for (const name of ["Status", "Work type", "Effort"])
    for (const value of fixtureValue(
      fixtureFind(config.fields, (field) => field.name === name).options,
    ))
      assert(help.includes(value));
  assert.match(roadmapCommandHelp("doctor", config), /--summary/);
  assert.throws(() => roadmapCommandHelp("unknown", config), /unknown/);
});

void test("the finite Roadmap command inventory has purpose, Usage and examples", () => {
  assert.match(roadmapHelp, /^Read and reconcile/u);
  assert.match(roadmapHelp, /\nUsage:\n/u);
  assert.match(roadmapHelp, /incomplete reads fail/u);
  const commands = [...roadmapHelp.matchAll(/^  node scripts\/roadmap\.mts ([a-z-]+)(?: |$)/gmu)]
    .map((match) => fixtureValue(match[1]))
    .filter((command) => command !== "--help");
  for (const command of new Set(commands)) {
    const help = roadmapCommandHelp(command, config);
    assert.match(help, /^Usage: node scripts\/roadmap\.mts /u);
    assert.match(help, /--help prints help without contacting GitHub/u);
    assert.match(help, /Example:\n  node scripts\/roadmap\.mts /u);
  }
  assert.match(roadmapCommandHelp("set", config), /--status 'In progress'/u);
  assert.match(roadmapCommandHelp("bootstrap"), /changes require the Project UI/u);
});

void test("offline Roadmap success separates configuration from the absence of a repository backlog", () => {
  const result = spawnSync(process.execPath, ["scripts/roadmap.mts", "check"], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, PATH: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Roadmap configuration is valid[^\n]+\.\nNo mutable roadmap items are stored in the repository\.\n/u,
  );
  assert.doesNotMatch(result.stdout, /Project.*verified|Grouping.*read back/iu);
});

void test("Roadmap command help is available without the GitHub executable or operation lock", () => {
  for (const command of ["set", "capture-feature", "doctor", "context"]) {
    const result = spawnSync(process.execPath, ["scripts/roadmap.mts", command, "--help"], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, PATH: "" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage:/u);
    assert.match(result.stdout, /Example:/u);
    assert.match(result.stdout, new RegExp(command));
    assert.equal(result.stderr, "");
  }
  const result = spawnSync(
    process.execPath,
    ["scripts/roadmap.mts", "doctor", "--summary", "--json"],
    { encoding: "utf8", timeout: 5000, env: { ...process.env, PATH: "" } },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /mutually exclusive/);
});

void test("configuration validation retains the original Project definitions and rejects malformed view arrays", () => {
  const candidate = structuredClone(config);
  const before = structuredClone(candidate);
  const checked = validateConfig(candidate);
  assert.equal(checked, candidate);
  assert.deepEqual(checked, before);
  for (const views of [undefined, null, {}])
    assert.throws(() => validateConfig({ ...candidate, views }), /views must be an array/);
  assert.throws(
    () => validateConfig({ ...candidate, views: [{ ...candidate.views[0], fields: [42] }] }),
    /visible fields/,
  );
});
