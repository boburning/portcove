/** Shared bounded data inspection only. Expected context remains caller-owned;
 * an imported runtime receipt creates no source, execution or native authority. */
import assert from "node:assert/strict";
import { isRecord } from "./runtime-values.mts";
import { assertMinimumVersion } from "./release-authority-configuration-contract.mts";
import path from "node:path";
import { lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";

/** Shared byte/identity fence only; callers retain workflow/admission authority. */
export async function captureSupportedHostedWindowsRuntimeInput(
  sourceRoot: string,
  context: {
    source: string | undefined;
    workflow: string | undefined;
    run_id: string | undefined;
    attempt: string | undefined;
  },
  sourceRecheck: () => void,
) {
  const read = async (relative: string) => {
    sourceRecheck();
    const filename = await assertOwnedUnlinkedPath(
        sourceRoot,
        path.join(sourceRoot, relative),
        "Supported Windows runtime input",
      ),
      before = await lstat(filename, { bigint: true });
    assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n);
    const bytes = await readControllerToolFile(filename, 65536),
      after = await lstat(filename, { bigint: true });
    for (const key of ["dev", "ino", "mode", "size", "nlink", "mtimeNs", "ctimeNs"] as const)
      assert.equal(after[key], before[key], "Runtime input changed during read");
    await assertOwnedUnlinkedPath(sourceRoot, filename, "Supported Windows runtime input");
    sourceRecheck();
    return { relative, bytes, identity: before };
  };
  const floor = await read("apps/desktop/src-tauri/src/runtime_support.rs"),
    input = await read("work/hosted-continuity-evidence/windows-runtime.json"),
    facts = inspectSupportedHostedWindowsRuntimeInput(floor.bytes, input.bytes, context),
    hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const identity = (value: typeof input) => ({
    path: value.relative,
    bytes: value.bytes.length,
    sha256: hash(value.bytes),
  });
  let stopped = false;
  const recheck = async () => {
    assert.ok(!stopped, "Original supported runtime input stopped");
    try {
      for (const old of [floor, input]) {
        const current = await read(old.relative);
        assert.ok(old.bytes.equals(current.bytes), "Original runtime bytes changed");
        for (const key of ["dev", "ino", "mode", "size", "nlink", "mtimeNs", "ctimeNs"] as const)
          assert.equal(
            current.identity[key],
            old.identity[key],
            "Original runtime identity changed",
          );
      }
    } catch (error) {
      stopped = true;
      throw error;
    }
  };
  await recheck();
  return {
    facts,
    report: {
      source: context.source,
      workflow: context.workflow,
      run_id: context.run_id,
      attempt: context.attempt,
      input: identity(input),
      floor: identity(floor),
      runtime_version: facts.observed,
      minimum: facts.minimum,
      scope:
        "Source-bootstrap supported runtime prerequisite; no loaded engine or native acceptance",
      authority: "none",
    },
    receipt: Buffer.from(input.bytes),
    recheck,
  };
}
export function inspectSupportedHostedWindowsRuntimeInput(
  floorBytes: Buffer,
  runtimeBytes: Buffer,
  context: {
    source: string | undefined;
    workflow: string | undefined;
    run_id: string | undefined;
    attempt: string | undefined;
  },
) {
  assert.ok(Buffer.isBuffer(floorBytes) && floorBytes.length > 0 && floorBytes.length <= 65536);
  assert.ok(
    Buffer.isBuffer(runtimeBytes) && runtimeBytes.length > 0 && runtimeBytes.length <= 65536,
  );
  const floors = [
    ...floorBytes
      .toString("utf8")
      .matchAll(
        /#\[cfg\(windows\)\]\s*const ENGINE_FLOOR: &\[u32\] = &\[(\d{1,10}), (\d{1,10}), (\d{1,10}), (\d{1,10})\];/gu,
      ),
  ];
  assert.equal(floors.length, 1, "unambiguous shipping Windows engine floor required");
  const parts = floors[0]!.slice(1);
  assert.ok(parts.every((part) => BigInt(part) <= 0xffff_ffffn));
  const minimum = parts.join("."),
    text = runtimeBytes.toString("utf8");
  assert.ok(Buffer.from(text).equals(runtimeBytes), "Windows runtime input must be UTF-8");
  const raw: unknown = JSON.parse(text);
  assert.ok(isRecord(raw));
  assert.equal(raw.source, context.source);
  assert.equal(raw.workflow, context.workflow);
  assert.equal(raw.run_id, context.run_id);
  assert.equal(raw.attempt, context.attempt);
  assert.equal(raw.scope, "hosted runtime prerequisite only; not native acceptance");
  assert.equal(raw.minimum, minimum);
  assert.equal(raw.automatic_retry, false);
  assert.ok(!Object.hasOwn(raw, "failure"), "failed Windows runtime input cannot qualify tools");
  const version = (value: unknown): string => {
    assert.ok(typeof value === "string" && /^[0-9]{1,10}(?:\.[0-9]{1,10}){3}$/u.test(value));
    assert.ok(value.split(".").every((part) => BigInt(part) <= 0xffff_ffffn));
    return value;
  };
  assert.ok(Array.isArray(raw.before) && raw.before.length <= 1);
  const before = raw.before.map((value: unknown) => {
    assert.ok(
      typeof value === "string" &&
        value.length <= 64 &&
        !Array.from(value).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    );
    return value;
  });
  assert.ok(Array.isArray(raw.after) && raw.after.length === 1);
  const observed = version(raw.after[0]);
  assertMinimumVersion(observed, minimum, "Windows fixture runtime");
  const installed = raw.stage === "ready-installed";
  if (installed) {
    assert.equal(raw.installed, true);
    assert.equal(raw.exit_code, 0);
    assert.ok(
      typeof raw.installer_sha256 === "string" && /^[a-f0-9]{64}$/u.test(raw.installer_sha256),
    );
    assert.ok(
      typeof raw.signer_thumbprint === "string" && /^[A-F0-9]{40}$/u.test(raw.signer_thumbprint),
    );
    if (before.length) {
      assert.throws(() => assertMinimumVersion(before[0], minimum, "pre-install runtime"));
    }
  } else {
    assert.equal(raw.stage, "ready-existing");
    assert.equal(raw.installed, false);
    assert.deepEqual(before, [observed]);
    assert.ok(!Object.hasOwn(raw, "exit_code"));
  }
  const observation = raw.runtime_preparation_observation;
  assert.ok(isRecord(observation));
  assert.equal(
    observation.scope,
    "reviewed diagnostic after workflow gate through terminal readback/disposal; cold setup and final receipt write excluded",
  );
  assert.ok(
    Number.isSafeInteger(observation.elapsed_milliseconds) &&
      Number(observation.elapsed_milliseconds) >= 0 &&
      Number(observation.elapsed_milliseconds) <= 15 * 60 * 1000,
  );
  assert.ok(Array.isArray(observation.phases));
  const names = installed
    ? [
        "entry",
        "initial-runtime-readback",
        "download-starting",
        "download-disposed",
        "signature-hash-verified",
        "installer-starting",
        "installer-process-disposed",
        "post-install-runtime-readback",
        "terminal-receipt-ready",
      ]
    : ["entry", "initial-runtime-readback", "existing-runtime-eligible", "terminal-receipt-ready"];
  let last = -1;
  const phases = observation.phases.map((value: unknown, index: number) => {
    assert.ok(isRecord(value));
    assert.equal(value.phase, names[index]);
    assert.ok(
      Number.isSafeInteger(value.elapsed_milliseconds) &&
        Number(value.elapsed_milliseconds) >= 0 &&
        Number(value.elapsed_milliseconds) >= last &&
        Number(value.elapsed_milliseconds) <= Number(observation.elapsed_milliseconds),
    );
    last = Number(value.elapsed_milliseconds);
    return { phase: names[index]!, elapsed_milliseconds: last };
  });
  assert.equal(phases.length, names.length);
  assert.equal(last, observation.elapsed_milliseconds);
  return { raw, minimum, observed, before, installed, observation, phases };
}
