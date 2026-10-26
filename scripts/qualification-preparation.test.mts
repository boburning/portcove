import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { qualifyPreparation } from "./qualification-report.mts";
import type { QualificationTransport } from "./qualification-report.mts";
import { isRecord } from "./runtime-values.mts";

function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

async function readReport(directory: string) {
  const parsed: unknown = JSON.parse(await readFile(path.join(directory, "sequence.json"), "utf8"));
  return object(parsed);
}

function steps(report: Record<string, unknown>) {
  assert.ok(Array.isArray(report.steps));
  const values: unknown[] = report.steps;
  return values.map(object);
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "preparation-reuse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.join(root, "verified-cli");
  const library = path.join(root, "library");
  const output = path.join(root, "report");
  const caseFile = path.join(root, "case.json");
  const bytes = "synthetic CLI; transport injected for focused contract checks";
  await writeFile(cli, bytes);
  await mkdir(library);
  await writeFile(path.join(library, "portcove.sqlite3"), "unopened synthetic library");
  const install = {
    id: "before",
    port_id: "fixture",
    artifact: { sha256: "a".repeat(64) },
    runtime: null,
  };
  const plan = {
    format_version: 1,
    port_id: "fixture",
    plan_sha256: "f".repeat(64),
    copy: { entries: [] },
    inputs: {
      install,
      definition_sha256: "d".repeat(64),
      source: { profile_id: "original", sha256: "b".repeat(64), observed_identity: null },
      source_inspection: { schema_version: 1, state_code: "not_checked" },
      host: "fixture-platform",
      options: { target: "fixture-platform", mode: "default" },
      setup_tool: { path: "/before/setup", sha256: "c".repeat(64), size: 4 },
      conversion_tool: null,
    },
  };
  const prepared = { ...install, id: "after" };
  const after = structuredClone(plan);
  after.inputs.install = prepared;
  after.inputs.setup_tool.path = "/after/setup";
  const item = {
    format_version: 1,
    evidence_kind: "synthetic",
    cli_sha256: createHash("sha256").update(bytes).digest("hex"),
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    plan,
  };
  const calls: string[] = [];
  const responses: unknown[] = [
    plan,
    { install_id: "before", valid: true },
    prepared,
    { install_id: "after", valid: true },
    after,
  ];
  let index = 0;
  const transport: QualificationTransport = async (_cli, args) => {
    const command = args[4] === "preparation" ? `${args[4]}.${args[5]}` : args[4];
    assert.ok(command);
    calls.push(command);
    const result = { schema_version: 80, command, ok: true, data: responses[index++] };
    return { stdout: JSON.stringify(result) + "\n" };
  };
  const save = () => writeFile(caseFile, JSON.stringify(item));
  await save();
  return {
    root,
    cli,
    library,
    output,
    caseFile,
    item,
    plan,
    after,
    prepared,
    responses,
    calls,
    transport,
    save,
    run: (execute: QualificationTransport = transport) =>
      qualifyPreparation({ cli, library, output, caseFile }, execute),
  };
}

void test("one preparation sequence retains Core before/after inventories and unknown source validation", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run()).result, "passed");
  assert.deepEqual(f.calls, [
    "preparation.plan",
    "verify",
    "preparation.run",
    "verify",
    "preparation.plan",
  ]);
  const report = await readReport(f.output);
  const inputs = object(report.operation_inputs);
  assert.equal(object(inputs.source).observed_identity, null);
  assert.equal(object(inputs.source_inspection).state_code, "not_checked");
  assert.equal(object(report.manual_observations).gameplay, null);
  assert.equal(report.evidence_kind, "synthetic");
  assert.deepEqual(object(object(steps(report)[0]?.response).data).copy, f.plan.copy);
  assert.deepEqual(object(object(steps(report)[4]?.response).data).copy, f.after.copy);
  await assert.rejects(f.run(), /EEXIST/);
});

void test("reviewed scope changes refuse before mutation and preserve failed receipt", async (t) => {
  for (const field of [
    "artifact",
    "definition",
    "source",
    "platform",
    "check",
    "environment",
    "cli",
  ] as const) {
    const f = await fixture(t);
    switch (field) {
      case "artifact":
        f.plan.inputs.install.artifact.sha256 = "changed";
        break;
      case "definition":
        f.plan.inputs.definition_sha256 = "changed";
        break;
      case "source":
        f.plan.inputs.source.sha256 = "changed";
        break;
      case "platform":
        f.plan.inputs.options.target = "changed";
        break;
      case "check":
        f.plan.inputs.setup_tool.sha256 = "changed";
        break;
      case "environment":
        f.item.environment.arch = process.arch === "x64" ? "arm64" : "x64";
        await f.save();
        break;
      case "cli":
        await writeFile(f.cli, "changed CLI");
        break;
    }
    await assert.rejects(f.run());
    assert.ok(!f.calls.includes("preparation.run"));
    if (!["environment", "cli"].includes(field)) {
      const report = await readReport(f.output);
      assert.equal(report.result, "failed");
    }
  }
});

void test("post-operation artifact, source, tool, definition and install joins cannot manufacture success", async (t) => {
  for (const field of ["artifact", "source", "tool", "definition", "install"] as const) {
    const f = await fixture(t);
    switch (field) {
      case "artifact":
        f.responses[2] = { ...f.prepared, artifact: { sha256: "other" } };
        break;
      case "source":
        f.after.inputs.source.profile_id = "other";
        break;
      case "tool":
        f.after.inputs.setup_tool.sha256 = "other";
        break;
      case "definition":
        f.after.inputs.definition_sha256 = "other";
        break;
      case "install":
        f.responses[3] = { install_id: "other", valid: true };
        break;
    }
    await assert.rejects(f.run());
    const report = await readReport(f.output);
    assert.equal(report.result, "failed");
    assert.ok(steps(report).length >= 3);
  }
});

void test("failed or interrupted supervised setup is retained without replay or later management", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run(async (file, args, options) => {
      if (args[5] === "run")
        throw Object.assign(new Error("supervisor interrupted"), { stdout: '{"ok":false}\n' });
      return f.transport(file, args, options);
    }),
    /supervisor interrupted/,
  );
  assert.deepEqual(f.calls, ["preparation.plan", "verify"]);
  const report = await readReport(f.output);
  assert.equal(report.result, "failed");
  assert.equal(object(steps(report)[2]?.response).stdout, '{"ok":false}\n');
});

void test("an external-only runtime has no managed preparation qualification sequence", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run(async () => ({
      stdout: JSON.stringify({
        schema_version: 80,
        command: "preparation.plan",
        ok: false,
        error: { message: "no managed preparation" },
      }),
    })),
    /did not succeed/,
  );
  assert.equal(f.calls.length, 0);
});

void test("source-only qualification preserves absent setup tools and refuses crossed formats", async (t) => {
  const f = await fixture(t);
  for (const plan of [f.plan, f.after]) {
    plan.format_version = 3;
    plan.inputs.options.mode = "source_only";
    Reflect.deleteProperty(plan.inputs, "setup_tool");
  }
  await f.save();
  assert.equal((await f.run()).result, "passed");
  assert.equal(
    Object.hasOwn(object((await readReport(f.output)).operation_inputs), "setup_tool"),
    false,
  );
  for (const [format, mode, tool] of [
    [1, "default", undefined],
    [2, "ghostship200_legacy", undefined],
    [3, "default", undefined],
    [1, "source_only", undefined],
    [3, "source_only", {}],
    [4, "source_only", undefined],
  ] as const) {
    const invalid = await fixture(t);
    invalid.plan.format_version = format;
    invalid.plan.inputs.options.mode = mode;
    Reflect.deleteProperty(invalid.plan.inputs, "setup_tool");
    if (tool) Object.assign(invalid.plan.inputs, { setup_tool: tool });
    await invalid.save();
    await assert.rejects(invalid.run(), /incomplete operation inputs/);
    assert.deepEqual(invalid.calls, []);
  }
});
