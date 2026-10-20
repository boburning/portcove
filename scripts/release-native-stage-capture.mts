/** Integrity-only native request/capture contracts. No execution, issuer access,
 * acceptance receipt or imported report authority is created by this module. */
import { inspectReleaseAuthorityConfiguration } from "./release-authority-configuration.mts";
import {
  inspectNativeQualificationCandidate,
  nativeQualificationScenarios,
} from "./release-native-qualification-contract.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";

function exact(raw: unknown, names: string): asserts raw is Record<string, unknown> {
  if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== names)
    throw new Error("native capture exact schema differs");
}
function text(raw: unknown, bound = 256) {
  if (typeof raw !== "string" || !raw || raw.length > bound || Array.from(raw).some(character=>character.charCodeAt(0)<32 || character.charCodeAt(0)===127))
    throw new Error("native capture text differs");
  return raw;
}
function sha(raw: unknown) {
  const value = text(raw, 64);
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("native capture digest differs");
  return value;
}
function integer(raw: unknown, minimum = 1, maximum = 2147483647) {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < minimum || raw > maximum)
    throw new Error("native capture integer differs");
  return raw;
}
function instant(raw: unknown) {
  const value = text(raw, 24);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("native capture instant differs");
  return value;
}
function frozen<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function pids(raw: unknown) {
  if (!Array.isArray(raw) || raw.length > 64) throw new Error("native PID inventory exceeds bound");
  const values = raw.map((value) => integer(value));
  if (new Set(values).size !== values.length) throw new Error("native PID inventory repeats");
  return values;
}
function bool(raw: unknown) {
  if (typeof raw !== "boolean") throw new Error("native observation boolean is absent");
  return raw;
}
function creation(raw: unknown, platform: string) {
  exact(raw, "kind,value");
  if (
    raw.kind !== (platform === "windows-x86_64" ? "windows-filetime" : "linux-starttime-ticks") ||
    typeof raw.value !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(raw.value)
  )
    throw new Error("native root creation identity differs");
  return { kind: raw.kind, value: raw.value };
}
function stream(raw: unknown, id: string, name: string) {
  exact(raw, "bytes,path,sha256");
  if (raw.path !== `${id}.${name}.bin`) throw new Error("native retained stream path differs");
  return { path: raw.path, bytes: integer(raw.bytes, 0, 4 * 1024 * 1024), sha256: sha(raw.sha256) };
}

export function prepareNativeStageRequest(raw: unknown, rawAuthorities: unknown) {
  exact(
    raw,
    "candidate,invocation_id,journey,platform_label,schema_version,setup_descriptor_sha256,stage",
  );
  if (
    raw.schema_version !== 1 ||
    (raw.stage !== "payload-signing" && raw.stage !== "release-publication") ||
    (raw.platform_label !== "windows-x86_64" && raw.platform_label !== "linux-x86_64")
  )
    throw new Error("native request stage/platform differs");
  const authorities = inspectReleaseAuthorityConfiguration(structuredClone(rawAuthorities));
  const candidate = inspectNativeQualificationCandidate(structuredClone(raw.candidate));
  let journey = null;
  if (raw.stage === "payload-signing") {
    if (raw.journey !== null) throw new Error("pre-sign native request has a signed journey");
  } else {
    exact(raw.journey, "predecessor,signatures_sha256,signed_context_sha256");
    const predecessor = inspectNativeQualificationCandidate(raw.journey.predecessor);
    if (predecessor.package.sha256 === candidate.package.sha256)
      throw new Error("native journey predecessor is unchanged");
    journey = {
      predecessor,
      signed_context_sha256: sha(raw.journey.signed_context_sha256),
      signatures_sha256: sha(raw.journey.signatures_sha256),
    };
  }
  const fixed = authorities.native[raw.platform_label];
  const request = {
    schema_version: 1 as const,
    repository_id: 1354613114 as const,
    namespace: authorities.namespace,
    stage: raw.stage,
    platform_label: raw.platform_label,
    invocation_id: sha(raw.invocation_id),
    setup_descriptor_sha256: sha(raw.setup_descriptor_sha256),
    authority_configuration_sha256: digest(authorities),
    candidate,
    journey,
    expected: structuredClone(fixed),
    required_scenarios: [...nativeQualificationScenarios[raw.stage]],
  };
  return frozen({
    request,
    request_sha256: digest(request),
    scope: "integrity-only" as const,
    authority: "none" as const,
  });
}
export type NativeStageRequest = ReturnType<typeof prepareNativeStageRequest>;

/** A detached retained observation. Even a structurally complete capture is not
 * a trusted parent capture: the future protected local factory must establish
 * its real invocation/host/files and private provenance before Check issuance. */
export function serializeNativeStageCapture(
  rawRequest: unknown,
  rawAuthorities: unknown,
  raw: unknown,
) {
  const prepared = prepareNativeStageRequest(rawRequest, rawAuthorities),
    request = prepared.request;
  exact(
    raw,
    "completed_at,failure,group,harness,outcome,request_sha256,roots,scenarios,schema_version,started_at",
  );
  if (
    raw.schema_version !== 1 ||
    raw.request_sha256 !== prepared.request_sha256 ||
    (raw.outcome !== "completed" && raw.outcome !== "failed" && raw.outcome !== "ambiguous")
  )
    throw new Error("native capture request/outcome differs");
  const started = instant(raw.started_at),
    completed = instant(raw.completed_at);
  if (
    Date.parse(completed) < Date.parse(started) ||
    Date.parse(completed) - Date.parse(started) > 1900 * 1000
  )
    throw new Error("native stage duration exceeds bound");
  const during = (time: unknown) => {
    const value = instant(time);
    if (value < started || value > completed)
      throw new Error("native observation is outside stage interval");
    return value;
  };
  if (!Array.isArray(raw.roots) || raw.roots.length > 64)
    throw new Error("native root inventory exceeds bound");
  const rootIds = new Set<string>(),
    rootIdentities = new Set<string>();
  const roots = raw.roots.map((value: unknown) => {
    exact(value, "creation,id,image,role,started_at,stderr,stdout,teardown");
    const id = text(value.id, 64);
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(id) || rootIds.has(id))
      throw new Error("native root ID invalid or repeated");
    rootIds.add(id);
    if (
      ![
        "profile-keeper",
        "candidate-package",
        "predecessor-package",
        "application",
        "driver",
        "runtime-helper",
        "cli",
      ].includes(String(value.role))
    )
      throw new Error("native root role differs");
    exact(value.image, "path,pid,sha256");
    const imagePath = text(value.image.path, 1024);
    if (
      request.platform_label === "windows-x86_64"
        ? !/^[A-Za-z]:\\/u.test(imagePath) || imagePath.slice(2).includes(":")
        : !imagePath.startsWith("/")
    )
      throw new Error("native image path is not local absolute");
    if (imagePath.split(/[\\/]/u).some((part) => part === ".." || part === "."))
      throw new Error("native image path traverses");
    const pid = integer(value.image.pid),
      created = creation(value.creation, request.platform_label),
      key = `${pid}:${created.value}`;
    if (rootIdentities.has(key)) throw new Error("native retained root identity repeats");
    rootIdentities.add(key);
    let teardown = null;
    if (value.teardown !== null) {
      exact(
        value.teardown,
        "exit_code,job_empty,observed_at,remaining_pids,root_creation,root_exited,root_pid",
      );
      const observedCreation = creation(value.teardown.root_creation, request.platform_label);
      if (value.teardown.root_pid !== pid || digest(observedCreation) !== digest(created))
        throw new Error("native teardown belongs to another root");
      const rootExited = bool(value.teardown.root_exited),
        remaining = pids(value.teardown.remaining_pids),
        empty = bool(value.teardown.job_empty);
      if (empty && remaining.length)
        throw new Error("native job empty claim conflicts with inventory");
      const exit =
        value.teardown.exit_code === null ? null : integer(value.teardown.exit_code, -2147483648);
      if (rootExited && exit === null) throw new Error("native exited root lacks exit code");
      teardown = {
        root_pid: pid,
        root_creation: observedCreation,
        root_exited: rootExited,
        job_empty: empty,
        remaining_pids: remaining,
        exit_code: exit,
        observed_at: during(value.teardown.observed_at),
      };
    }
    return {
      id,
      role: value.role,
      image: { pid, path: imagePath, sha256: sha(value.image.sha256) },
      creation: created,
      started_at: during(value.started_at),
      stdout: stream(value.stdout, id, "stdout"),
      stderr: stream(value.stderr, id, "stderr"),
      teardown,
    };
  });
  let group = null;
  if (raw.group !== null) {
    exact(raw.group, "empty,observed_at,remaining_pids");
    const empty = bool(raw.group.empty),
      remaining = pids(raw.group.remaining_pids);
    if (empty && remaining.length) throw new Error("native shared group contradicts inventory");
    group = { empty, remaining_pids: remaining, observed_at: during(raw.group.observed_at) };
  }
  exact(raw.harness, "exit_code,path,sha256,stderr,stdout");
  if (
    raw.harness.path !== request.expected.producer.harness.path ||
    raw.harness.sha256 !== request.expected.producer.harness.sha256
  )
    throw new Error("native fixed harness identity differs");
  const harness = {
    path: raw.harness.path,
    sha256: sha(raw.harness.sha256),
    exit_code: raw.harness.exit_code === null ? null : integer(raw.harness.exit_code, -2147483648),
    stdout: stream(raw.harness.stdout, "harness", "stdout"),
    stderr: stream(raw.harness.stderr, "harness", "stderr"),
  };
  if (!Array.isArray(raw.scenarios) || raw.scenarios.length > request.required_scenarios.length)
    throw new Error("native scenario inventory exceeds bound");
  const seen = new Set<string>();
  const scenarios = raw.scenarios.map((value: unknown) => {
    exact(value, "capture_sha256,completed_at,name,outcome,started_at");
    const name = text(value.name, 64);
    if (
      !request.required_scenarios.some((item) => item === name) ||
      seen.has(name) ||
      !["passed", "failed", "unknown"].includes(String(value.outcome))
    )
      throw new Error("native stage scenario differs or repeats");
    seen.add(name);
    const begin = during(value.started_at),
      end = during(value.completed_at);
    if (end < begin) throw new Error("native scenario chronology differs");
    return {
      name,
      outcome: value.outcome,
      started_at: begin,
      completed_at: end,
      capture_sha256: sha(value.capture_sha256),
    };
  });
  let failure = null;
  if (raw.failure !== null) {
    exact(raw.failure, "code,message,phase");
    failure = {
      phase: text(raw.failure.phase, 128),
      code: text(raw.failure.code, 128),
      message: text(raw.failure.message, 2048),
    };
  }
  if (raw.outcome === "completed") {
    if (
      failure ||
      harness.exit_code !== 0 ||
      !group?.empty ||
      !roots.some((root) => root.role !== "profile-keeper") ||
      roots.some((root) => !root.teardown?.root_exited || !root.teardown.job_empty) ||
      scenarios.length !== request.required_scenarios.length ||
      scenarios.some((item) => item.outcome !== "passed") ||
      scenarios.some((item, index) => item.name !== request.required_scenarios[index])
    )
      throw new Error("native capture lacks complete stage/positive owned teardown");
  } else if (!failure)
    throw new Error("failed or ambiguous native capture must retain its failure");
  const capture = {
    schema_version: 1 as const,
    request_sha256: prepared.request_sha256,
    outcome: raw.outcome,
    started_at: started,
    completed_at: completed,
    harness,
    roots,
    group,
    scenarios,
    failure,
    scope: "integrity-only" as const,
    authority: "none" as const,
  };
  const json = JSON.stringify(capture);
  if (Buffer.byteLength(json) > 128 * 1024)
    throw new Error("native retained capture exceeds serialization bound");
  return frozen({
    capture,
    capture_sha256: digest(capture),
    bytes: json + "\n",
    authority: "none" as const,
  });
}
