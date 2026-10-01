import test from "node:test";
import assert from "node:assert/strict";
import { probeTool, selectedPrerequisites, collectSelectedPrerequisites } from "./dev-doctor.mjs";

test("selected frontend prerequisites do not invoke Rust, native provisioning or bootstrap", async () => {
  const calls = [];
  const report = await collectSelectedPrerequisites([{ id: "oxfmt" }], {
    run: (command, args) => {
      calls.push([command, args]);
      return { status: 0, stdout: command === "corepack" ? "12.7.0" : "v24.21.0" };
    },
  });
  assert.deepEqual(
    report.map((entry) => entry.id),
    ["node", "pnpm", "frontend-dependencies"],
  );
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([command]) => command !== "cargo" && command !== "rustc"));
});

test("selected native compilation reports missing Linux libraries without installing them", async () => {
  const calls = [];
  const report = await collectSelectedPrerequisites([{ id: "rust-clippy:portcove-desktop" }], {
    platform: "linux",
    run: (command, args) => {
      calls.push([command, args]);
      return {
        status: command === "pkg-config" ? 1 : 0,
        stdout: command === "rustc" ? "1.98.1" : "24.21.0",
      };
    },
  });
  assert.equal(report.find((item) => item.id === "native-desktop-build").status, "unavailable");
  assert.deepEqual(calls.find(([command]) => command === "pkg-config")[1], [
    "--exists",
    "gtk+-3.0",
    "webkit2gtk-4.1",
    "libsoup-3.0",
  ]);
  assert.ok(!calls.some(([command]) => command === "apt-get"));
});

test("stale Windows Aqua state is an actionable prerequisite failure", async () => {
  const report = await collectSelectedPrerequisites([{ id: "actionlint" }], {
    platform: "win32",
    readToolState: () => null,
    run: () => ({ status: 0, stdout: "24.21.0" }),
  });
  assert.deepEqual(
    report.find((item) => item.id === "aqua-state"),
    {
      id: "aqua-state",
      status: "unavailable",
      remediation: "./scripts/bootstrap-quality-tools.ps1",
    },
  );
  assert.ok(
    selectedPrerequisites({ id: "conservative-audit" }).includes("complete-audit-prerequisites"),
  );
  assert.ok(selectedPrerequisites({ id: "playnite-contract" }).includes("dotnet"));
});

const definition = {
  id: "example",
  command: ["example", "--version"],
  version: "1.2.3",
};
test("doctor distinguishes exact, mismatched, failed and absent tools without raw output", () => {
  const run = (stdout) => () => ({ status: 0, stdout });
  assert.equal(probeTool(definition, run("example 1.2.3")).status, "ok");
  assert.equal(probeTool(definition, run("v1.2.3")).status, "ok");
  assert.equal(probeTool(definition, run("example 1.2.30")).status, "mismatch");
  assert.equal(probeTool(definition, () => ({ status: 1, stdout: "1.2.3" })).status, "unavailable");
  const missing = probeTool(definition, () => {
    throw Object.assign(new Error("SECRET"), { code: "ENOENT" });
  });
  assert.equal(missing.status, "unavailable");
  assert.ok(!JSON.stringify(missing).includes("SECRET"));
});
test("doctor reports a timeout rather than a version pass", () => {
  assert.equal(
    probeTool(definition, () => ({
      status: null,
      error: { code: "ETIMEDOUT" },
      stdout: "1.2.3",
    })).status,
    "timeout",
  );
});
