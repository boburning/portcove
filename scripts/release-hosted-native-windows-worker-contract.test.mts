import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectHostedWindowsHarnessBinding,
  hostedWindowsWorkerAbi,
  hostedWindowsOwnerDeadline,
  inspectHostedWindowsWorkerRequest,
  inspectHostedWindowsWorkerAcknowledgment,
} from "./release-hosted-native-windows-worker-contract.mts";
import {
  runHostedWindowsWorkerStage,
  readHostedWindowsWorkerAbi,
} from "./release-hosted-native-windows-worker.mts";

void test("hosted B harness binding preserves separate A helper roots and derives only the fixed staged registry leaf", () => {
  const hosted = {
      profile: hostedWindowsWorkerAbi,
      harness_root: "C:\\held-source",
      registry_sha256: "a".repeat(64),
    },
    value = inspectHostedWindowsHarnessBinding(
      hosted,
      "C:\\admitted-tools",
      "C:\\attempt\\payload-signing\\work",
    );
  assert.equal(value.harness_root, hosted.harness_root);
  assert.deepEqual(value.registry, {
    path: "C:\\attempt\\payload-signing\\readonly\\native-qualification-account-registry.ps1",
    sha256: "a".repeat(64),
  });
  for (const bad of [
    null,
    {},
    { ...hosted, profile: "installed" },
    { ...hosted, harness_root: "C:\\admitted-tools" },
    { ...hosted, extra: true },
    { ...hosted, registry_sha256: "bad" },
  ])
    assert.throws(() =>
      inspectHostedWindowsHarnessBinding(bad, "C:\\admitted-tools", "C:\\attempt\\work"),
    );
  for (const root of [
    "\\\\server\\source",
    "C:\\source:stream",
    "C:\\source\\..\\other",
    "C:\\NUL",
    "C:\\source. ",
    "C:\\source/child",
  ])
    assert.throws(() =>
      inspectHostedWindowsHarnessBinding(
        { ...hosted, harness_root: root },
        "C:\\admitted-tools",
        "C:\\attempt\\work",
      ),
    );
  assert.throws(() =>
    inspectHostedWindowsHarnessBinding(
      hosted,
      "C:\\admitted-tools",
      "C:\\attempt\\candidate-writable",
    ),
  );
});

void test("held B stage ABI fixes package leaves and rejects imported execution controls", async () => {
  const sha = "a".repeat(64),
    file = (path: string) => ({ path, sha256: sha }),
    raw = {
      schema_version: 1,
      abi: hostedWindowsWorkerAbi,
      stage: "payload-signing",
      binding: file("C:\\attempt\\payload-signing\\capture\\binding.json"),
      capture_root: "C:\\attempt\\payload-signing\\capture",
      work_root: "C:\\attempt\\payload-signing\\work",
      package: {
        ...file("C:\\attempt\\payload-signing\\readonly\\candidate.exe"),
        bytes: 10,
        version: "1.0.0-rc.2",
      },
      predecessor: null,
      tools: {
        git: file("C:\\Program Files\\Git\\cmd\\git.exe"),
        node: file("C:\\tools\\bin\\node.exe"),
        powershell: file("C:\\Program Files\\PowerShell\\7\\pwsh.exe"),
      },
      remaining_milliseconds: 120000,
      worker_sha256: sha,
    };
  const selected = inspectHostedWindowsWorkerRequest(raw);
  assert.equal(selected.stage, "payload-signing");
  assert.equal(selected.predecessor, null);
  const publication = {
    ...raw,
    stage: "release-publication",
    predecessor: {
      ...raw.package,
      path: "C:\\attempt\\payload-signing\\readonly\\predecessor.exe",
    },
  };
  assert.ok(inspectHostedWindowsWorkerRequest(publication).predecessor);
  for (const bad of [
    { ...raw, callback: "caller" },
    { ...raw, remaining_milliseconds: 570001 },
    { ...raw, remaining_milliseconds: 0 },
    { ...raw, package: { ...raw.package, path: "C:\\other\\candidate.exe" } },
    { ...raw, predecessor: publication.predecessor },
    { ...raw, binding: file("C:\\writable\\binding.json") },
    { ...raw, abi: "imported-success" },
  ])
    assert.throws(() => inspectHostedWindowsWorkerRequest(bad));
  await assert.rejects(
    runHostedWindowsWorkerStage("never-read", "invalid"),
    /awaits separate authority/u,
  );
  assert.equal(readHostedWindowsWorkerAbi().abi, hostedWindowsWorkerAbi);
  assert.equal(readHostedWindowsWorkerAbi().authority, "none");
});
void test("owner QPC deadline consumes the original parent budget and cannot renew at a later stage", () => {
  const fixed = hostedWindowsOwnerDeadline("10000000000000000", 10_000_000, 570000, 2500);
  assert.equal(fixed, "10000005675000000");
  assert.ok(
    BigInt(hostedWindowsOwnerDeadline("10000000000000000", 10_000_000, 570000, 3500)) <
      BigInt(fixed),
  );
  for (const args of [
    ["0", 10_000_000, 570000, 0],
    ["1", 0, 570000, 0],
    ["1", 10_000_000, 570001, 0],
    ["1", 10_000_000, 570000, 570000],
    ["1", 10_000_000, Infinity, 0],
  ] as const)
    assert.throws(() => hostedWindowsOwnerDeadline(args[0], args[1], args[2], args[3]));
});

void test("worker acknowledgment binds the original PID generation and immutable stage request", () => {
  const expected = {
    pid: 42,
    created_filetime: "134375479131028853",
    request_sha256: "a".repeat(64),
    binding_sha256: "b".repeat(64),
  };
  const valid = { ...expected, schema_version: 1 };
  assert.deepEqual(inspectHostedWindowsWorkerAcknowledgment(valid, expected), valid);
  for (const bad of [
    { ...valid, pid: 43 },
    { ...valid, created_filetime: "134375479131028854" },
    { ...valid, request_sha256: "c".repeat(64) },
    { ...valid, binding_sha256: "c".repeat(64) },
    { ...valid, schema_version: 2 },
    { ...valid, callback: "caller" },
  ])
    assert.throws(() => inspectHostedWindowsWorkerAcknowledgment(bad, expected));
  for (const bad of [
    { ...expected, pid: 0 },
    { ...expected, created_filetime: "0" },
    { ...expected, request_sha256: "bad" },
  ])
    assert.throws(() => inspectHostedWindowsWorkerAcknowledgment(valid, bad));
});
