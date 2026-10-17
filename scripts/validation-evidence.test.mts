import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fingerprintStage, validationRuntime } from "./validation-evidence.mts";

test("selected runtime observes exactly the fields used by the existing domain fingerprint", () => {
  const observe = (domains) => {
    const calls = [];
    const runtime = validationRuntime(undefined, {
      domains,
      commandVersion(command, args) {
        calls.push([command, ...args].join(" "));
        return `version:${command}:${args.join(" ")}`;
      },
    });
    return { calls, runtime };
  };
  const full = observe(undefined);
  for (const domain of [
    "repository",
    "development",
    "roadmap",
    "format",
    "ui",
    "rust",
    "rscheck",
    "lint",
    "release",
  ]) {
    const selected = observe([domain]);
    const stage = { id: "control", recipe: "unchanged", domain };
    const inventory = { objectFormat: "sha1", files: [] };
    assert.equal(
      fingerprintStage(stage, inventory, selected.runtime),
      fingerprintStage(stage, inventory, full.runtime),
    );
    if (!["rust", "rscheck"].includes(domain))
      assert(!selected.calls.some((call) => /^(?:cargo|rustc|rscheck) /u.test(call)));
    if (domain !== "lint") assert(!selected.calls.some((call) => /^(?:aqua|pwsh) /u.test(call)));
  }
  assert.deepEqual(observe(["repository"]).calls, ["git --version", "just --version"]);
  assert.equal(full.calls.length, 10);
});

test("ordinary hosted planning imports and executes without loading audit or receipt orchestration", () => {
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { registerHooks } from 'node:module';
    import assert from 'node:assert/strict';
    registerHooks({ resolve(specifier, context, next) {
      if (/(?:audit|validation-evidence|local-validation)\\.mts$/u.test(specifier))
        throw new Error('ordinary route loaded orchestration: '+specifier);
      return next(specifier, context);
    }});
    const { classifyChanges, buildPlan } = await import('./scripts/ordinary-validation.mts');
    await import('./scripts/ci-baseline.mts');
    const selection = classifyChanges([{status:'M',path:'README.md'}]);
    const plan = buildPlan(selection, {doctestPackages:new Set()});
    assert(plan.some(entry=>entry.id==='diff-check'));
    assert(!plan.some(entry=>entry.id.startsWith('rust-')));
  `,
    ],
    { cwd: new URL("../", import.meta.url), windowsHide: true, timeout: 10_000 },
  );
});
