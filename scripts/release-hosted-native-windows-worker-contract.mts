/** Closed data ABI only; none of these fields admit an invocation or a receipt. */
import assert from "node:assert/strict";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";

export const hostedWindowsWorkerAbi = "hosted-windows-worker-v1";
// Temporary branch-only qualification scope; data, never a production grant.
export const hostedWindowsDiagnosticWorkflowRef =
  "boburning/portcove/.github/workflows/hosted-native-continuity.yml@refs/heads/feature/534-connected-custody-canary-20261029";
export function hostedWindowsOwnerDeadline(
  sampleTicks: string,
  frequency: number,
  originalDeadline: number,
  receivedAt: number,
) {
  assert.ok(
    /^[1-9][0-9]{0,19}$/u.test(sampleTicks) &&
      Number.isSafeInteger(frequency) &&
      frequency > 0 &&
      frequency <= 1_000_000_000,
  );
  const remaining = originalDeadline - receivedAt;
  assert.ok(
    Number.isFinite(remaining) && remaining > 0 && remaining <= 570000,
    "original hosted owner budget exhausted or unsupported",
  );
  // The sample precedes receipt, so this conversion can only shorten the parent budget.
  const deadline =
    BigInt(sampleTicks) + (BigInt(Math.floor(remaining)) * BigInt(frequency)) / 1000n;
  assert.ok(deadline <= 9223372036854775807n, "owner QPC deadline exceeds signed64 range");
  return deadline.toString();
}
function local(raw: unknown): asserts raw is string {
  assert.ok(
    typeof raw === "string" &&
      raw.length <= 4096 &&
      /^[A-Za-z]:\\/u.test(raw) &&
      !raw.slice(2).includes(":") &&
      path.win32.normalize(raw) === raw &&
      raw
        .slice(3)
        .split("\\")
        .every(
          (name) =>
            name.length > 0 &&
            !/[<>"|?*]/u.test(name) &&
            Array.from(name).every((character) => character.charCodeAt(0) >= 32) &&
            !/[. ]$/u.test(name) &&
            !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(name),
        ),
    "canonical local hosted worker path required",
  );
}
export function inspectHostedWindowsHarnessBinding(
  raw: unknown,
  controllerRoot: string,
  workRoot: string,
) {
  assert.ok(
    isRecord(raw) && Object.keys(raw).sort().join(",") === "harness_root,profile,registry_sha256",
  );
  assert.equal(raw.profile, hostedWindowsWorkerAbi);
  local(raw.harness_root);
  local(controllerRoot);
  local(workRoot);
  assert.notEqual(
    raw.harness_root.toLowerCase(),
    controllerRoot.toLowerCase(),
    "separate held B harness and A helper roots required",
  );
  assert.equal(path.win32.basename(workRoot), "work");
  assert.ok(typeof raw.registry_sha256 === "string" && /^[a-f0-9]{64}$/u.test(raw.registry_sha256));
  return Object.freeze({
    profile: hostedWindowsWorkerAbi,
    harness_root: raw.harness_root,
    registry: Object.freeze({
      path: path.win32.join(
        path.win32.dirname(workRoot),
        "readonly",
        "native-qualification-account-registry.ps1",
      ),
      sha256: raw.registry_sha256,
    }),
  });
}

export function inspectHostedWindowsWorkerRequest(raw: unknown) {
  assert.ok(
    isRecord(raw) &&
      Object.keys(raw).sort().join(",") ===
        "abi,binding,capture_root,package,predecessor,remaining_milliseconds,schema_version,stage,tools,work_root,worker_sha256",
  );
  assert.equal(raw.schema_version, 1);
  assert.equal(raw.abi, hostedWindowsWorkerAbi);
  assert.ok(raw.stage === "payload-signing" || raw.stage === "release-publication");
  local(raw.capture_root);
  local(raw.work_root);
  assert.equal(path.win32.basename(raw.work_root), "work");
  assert.ok(
    Number.isSafeInteger(raw.remaining_milliseconds) &&
      Number(raw.remaining_milliseconds) > 0 &&
      Number(raw.remaining_milliseconds) <= 570000,
  );
  assert.ok(typeof raw.worker_sha256 === "string" && /^[a-f0-9]{64}$/u.test(raw.worker_sha256));
  function file(value: unknown) {
    assert.ok(isRecord(value) && Object.keys(value).sort().join(",") === "path,sha256");
    local(value.path);
    assert.ok(typeof value.sha256 === "string" && /^[a-f0-9]{64}$/u.test(value.sha256));
    return Object.freeze({ path: value.path, sha256: value.sha256 });
  }
  function pkg(value: unknown) {
    assert.ok(
      isRecord(value) && Object.keys(value).sort().join(",") === "bytes,path,sha256,version",
    );
    local(value.path);
    assert.ok(typeof value.sha256 === "string" && /^[a-f0-9]{64}$/u.test(value.sha256));
    assert.ok(
      Number.isSafeInteger(value.bytes) &&
        Number(value.bytes) > 0 &&
        Number(value.bytes) <= 512 * 1024 ** 2,
    );
    assert.ok(
      typeof value.version === "string" &&
        value.version.length > 0 &&
        value.version.length <= 128 &&
        !value.version.includes("\0"),
    );
    return Object.freeze({
      path: value.path,
      bytes: Number(value.bytes),
      sha256: value.sha256,
      version: value.version,
    });
  }
  assert.ok(
    isRecord(raw.tools) && Object.keys(raw.tools).sort().join(",") === "git,node,powershell",
  );
  const candidate = pkg(raw.package),
    predecessor = raw.predecessor === null ? null : pkg(raw.predecessor);
  assert.ok(
    raw.stage === "release-publication" || predecessor === null,
    "pre-sign worker cannot adopt a predecessor",
  );
  const readonly = path.win32.join(path.win32.dirname(raw.work_root), "readonly");
  assert.equal(
    candidate.path.toLowerCase(),
    path.win32.join(readonly, "candidate.exe").toLowerCase(),
  );
  if (predecessor)
    assert.equal(
      predecessor.path.toLowerCase(),
      path.win32.join(readonly, "predecessor.exe").toLowerCase(),
    );
  assert.ok(
    raw.capture_root.toLowerCase() !== raw.work_root.toLowerCase() &&
      !raw.capture_root.toLowerCase().startsWith(raw.work_root.toLowerCase() + "\\"),
    "capture must remain outside candidate work",
  );
  const binding = file(raw.binding);
  assert.equal(path.win32.dirname(binding.path).toLowerCase(), raw.capture_root.toLowerCase());
  return Object.freeze({
    schema_version: 1 as const,
    abi: hostedWindowsWorkerAbi,
    stage: raw.stage,
    package: candidate,
    predecessor,
    binding,
    capture_root: raw.capture_root,
    work_root: raw.work_root,
    remaining_milliseconds: Number(raw.remaining_milliseconds),
    worker_sha256: raw.worker_sha256,
    tools: Object.freeze({
      git: file(raw.tools.git),
      node: file(raw.tools.node),
      powershell: file(raw.tools.powershell),
    }),
  });
}

/** Acknowledgment data never grants authority; B checks its own original generation. */
export function inspectHostedWindowsWorkerAcknowledgment(
  raw: unknown,
  expected: {
    pid: number;
    created_filetime: string;
    request_sha256: string;
    binding_sha256: string;
  },
) {
  assert.ok(
    isRecord(raw) &&
      Object.keys(raw).sort().join(",") ===
        "binding_sha256,created_filetime,pid,request_sha256,schema_version",
  );
  assert.equal(raw.schema_version, 1);
  assert.ok(Number.isSafeInteger(expected.pid) && expected.pid > 0 && expected.pid <= 2147483647);
  assert.match(expected.created_filetime, /^[1-9][0-9]{0,18}$/u);
  for (const key of ["request_sha256", "binding_sha256"] as const)
    assert.match(expected[key], /^[a-f0-9]{64}$/u);
  for (const key of ["pid", "created_filetime", "request_sha256", "binding_sha256"] as const)
    assert.equal(raw[key], expected[key]);
  return Object.freeze({ ...expected, schema_version: 1 as const });
}
