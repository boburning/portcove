import { isRecord } from "./runtime-values.mts";

export type NativeQualificationStage = "payload-signing" | "release-publication";
export const nativePrepublicationProfile = "signed-package-compatibility-v1" as const;
export const nativePrepublicationScenarios = Object.freeze([
  "install-over-prior",
  "candidate-launch",
  "retained-state",
  "package-rollback",
] as const);
export const nativePrepublicationPending = Object.freeze([
  "ordinary-public-discovery-and-download",
  "ordinary-updater-journal-and-recovery",
  "ordinary-public-manifest-journey",
] as const);
export const nativeQualificationScenarios = Object.freeze({
  "payload-signing": Object.freeze([
    "exact-package-bytes",
    "install",
    "launch",
    "minimum-platform",
    "runtime-protocol",
    "persistent-state",
  ] as const),
  "release-publication": Object.freeze([
    "compatible-update",
    "rollback",
    "journal-recovery",
    "persistent-state",
  ] as const),
});
export const nativeQualificationCheckName = "Portcove isolated native release qualification";
const sha = /^[a-f0-9]{64}$/u;
const git = /^[a-f0-9]{40}$/u;
function exact(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== keys)
    throw new Error("native qualification exact schema differs");
}
function text(value: unknown, maximum = 256): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maximum ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("native qualification text is invalid");
  return value;
}
function hex(value: unknown, pattern = sha): string {
  if (typeof value !== "string" || !pattern.test(value))
    throw new Error("native qualification identity is invalid");
  return value;
}
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("native qualification positive integer required");
  return value;
}
function numericId(value: unknown): string {
  const result = text(value, 20);
  if (!/^[1-9][0-9]{0,19}$/u.test(result)) throw new Error("native provider ID is invalid");
  return result;
}
function instant(value: unknown): string {
  const result = text(value, 32);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result) ||
    !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString() !== result
  )
    throw new Error("native qualification timestamp is invalid");
  return result;
}
function range(raw: unknown) {
  exact(raw, "max,min");
  const min = positive(raw.min),
    max = positive(raw.max);
  if (min > max) throw new Error("native compatibility range is reversed");
  return { min, max };
}
function unique<T>(raw: unknown, inspect: (value: unknown) => T, maximum = 32, minimum = 1): T[] {
  if (!Array.isArray(raw) || raw.length < minimum || raw.length > maximum)
    throw new Error("native qualification inventory exceeds bound");
  const values = raw.map(inspect);
  if (new Set(values).size !== values.length)
    throw new Error("native qualification inventory repeats");
  return values;
}
function account(raw: unknown) {
  exact(raw, "broker,kind,qualification");
  if (raw.kind !== "windows-sid" && raw.kind !== "linux-uid")
    throw new Error("native account identity kind differs");
  const broker = text(raw.broker, 184),
    qualification = text(raw.qualification, 184);
  const pattern =
    raw.kind === "windows-sid" ? /^S-1-[0-9]+(?:-[0-9]+)+$/u : /^(0|[1-9][0-9]{0,9})$/u;
  if (
    !pattern.test(broker) ||
    !pattern.test(qualification) ||
    broker === qualification ||
    (raw.kind === "linux-uid" && qualification === "0")
  )
    throw new Error("candidate account is not independently isolated");
  return { kind: raw.kind, broker, qualification };
}
function candidateIdentity(raw: unknown) {
  exact(raw, "artifact_id,package,run_attempt,run_id,source_commit,source_tree");
  exact(raw.package, "bytes,filename,sha256");
  const filename = text(raw.package.filename, 192);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(filename))
    throw new Error("native package filename is unsafe");
  return {
    source_commit: hex(raw.source_commit, git),
    source_tree: hex(raw.source_tree, git),
    run_id: numericId(raw.run_id),
    run_attempt: positive(raw.run_attempt),
    artifact_id: positive(raw.artifact_id),
    package: { filename, bytes: positive(raw.package.bytes), sha256: hex(raw.package.sha256) },
  };
}
export { candidateIdentity as inspectNativeQualificationCandidate };

/** A bounded wire contract only. Passing this inspector cannot authenticate the
 * native host, its observations, a producer, or an admission decision. The
 * actual consumer separately authenticates its independently configured issuer
 * and exact expected capture before minting a private runtime receipt. */
export function inspectNativeReleaseQualification(raw: unknown) {
  const temporal = isRecord(raw) && raw.schema_version === 2;
  exact(
    raw,
    temporal
      ? "candidate,compatibility,host,journey,native_prepublication_profile,pending_obligations,platform_label,producer,runtime,scenarios,schema_version,stage"
      : "candidate,compatibility,host,journey,platform_label,producer,runtime,scenarios,schema_version,stage",
  );
  if (
    (raw.schema_version !== 1 && raw.schema_version !== 2) ||
    (raw.stage !== "payload-signing" && raw.stage !== "release-publication") ||
    (raw.platform_label !== "windows-x86_64" && raw.platform_label !== "linux-x86_64")
  )
    throw new Error("native qualification stage/platform is unsupported");
  if (
    temporal &&
    (raw.stage !== "release-publication" ||
      raw.native_prepublication_profile !== nativePrepublicationProfile ||
      !Array.isArray(raw.pending_obligations) ||
      raw.pending_obligations.length !== nativePrepublicationPending.length ||
      raw.pending_obligations.some(
        (value: unknown, index: number) => value !== nativePrepublicationPending[index],
      ))
  )
    throw new Error("native prepublication profile/pending public proof differs");
  const stage: NativeQualificationStage = raw.stage;
  const platform: "windows-x86_64" | "linux-x86_64" = raw.platform_label;
  const candidate = candidateIdentity(raw.candidate);
  let journey: null | {
    predecessor: ReturnType<typeof candidateIdentity>;
    signed_context_sha256: string;
    signatures_sha256: string;
  } = null;
  if (stage === "payload-signing") {
    if (raw.journey !== null)
      throw new Error("pre-sign native capture cannot assert a signed update journey");
  } else {
    exact(raw.journey, "predecessor,signatures_sha256,signed_context_sha256");
    journey = {
      predecessor: candidateIdentity(raw.journey.predecessor),
      signed_context_sha256: hex(raw.journey.signed_context_sha256),
      signatures_sha256: hex(raw.journey.signatures_sha256),
    };
    if (journey.predecessor.package.sha256 === candidate.package.sha256)
      throw new Error("post-sign native journey requires a distinct predecessor");
  }
  exact(raw.producer, "harness,invocation_id,source_commit,source_tree,started_at");
  exact(raw.producer.harness, "path,sha256");
  const harnessPath = text(raw.producer.harness.path, 192);
  if (!/^scripts\/[A-Za-z0-9][A-Za-z0-9._-]*\.ps1$/u.test(harnessPath))
    throw new Error("native harness path is unsafe");
  const producer = {
    invocation_id: hex(raw.producer.invocation_id),
    source_commit: hex(raw.producer.source_commit, git),
    source_tree: hex(raw.producer.source_tree, git),
    harness: { path: harnessPath, sha256: hex(raw.producer.harness.sha256) },
    started_at: instant(raw.producer.started_at),
  };
  exact(
    raw.host,
    "account,architecture,execution_context,loaded_engine,machine_id_sha256,minimum_platform,os_version,qualification_profile",
  );
  exact(raw.host.loaded_engine, "name,sha256,version");
  if (raw.host.architecture !== "x86_64") throw new Error("native host architecture differs");
  const isolatedAccount = account(raw.host.account);
  if (isolatedAccount.kind !== (platform === "windows-x86_64" ? "windows-sid" : "linux-uid"))
    throw new Error("native platform/account identity differs");
  const host = {
    machine_id_sha256: hex(raw.host.machine_id_sha256),
    architecture: "x86_64" as const,
    qualification_profile: text(raw.host.qualification_profile, 128),
    os_version: text(raw.host.os_version, 128),
    minimum_platform: text(raw.host.minimum_platform, 128),
    execution_context: text(raw.host.execution_context, 512),
    account: isolatedAccount,
    loaded_engine: {
      name: text(raw.host.loaded_engine.name, 64),
      version: text(raw.host.loaded_engine.version, 64),
      sha256: hex(raw.host.loaded_engine.sha256),
    },
  };
  exact(raw.runtime, "capture_sha256,completed_at,root_creation,root_pid,started_at,teardown");
  exact(raw.runtime.root_creation, "kind,value");
  if (
    raw.runtime.root_creation.kind !==
    (platform === "windows-x86_64" ? "windows-filetime" : "linux-starttime-ticks")
  )
    throw new Error("native process creation identity kind differs");
  const rootCreation = {
    kind: raw.runtime.root_creation.kind,
    value: numericId(raw.runtime.root_creation.value),
  };
  exact(raw.runtime.teardown, "capture_sha256,completed_at,remaining_pids,root_exited,tree_empty");
  if (
    raw.runtime.teardown.root_exited !== true ||
    raw.runtime.teardown.tree_empty !== true ||
    !Array.isArray(raw.runtime.teardown.remaining_pids) ||
    raw.runtime.teardown.remaining_pids.length !== 0
  )
    throw new Error("native process-tree settlement is not positively established");
  const started = instant(raw.runtime.started_at),
    completed = instant(raw.runtime.completed_at);
  const settled = instant(raw.runtime.teardown.completed_at);
  if (
    Date.parse(producer.started_at) > Date.parse(started) ||
    Date.parse(started) > Date.parse(completed) ||
    Date.parse(completed) > Date.parse(settled)
  )
    throw new Error("native runtime/teardown chronology differs");
  const runtime = {
    root_pid: positive(raw.runtime.root_pid),
    // The earliest actual candidate root supplies this creation identity.
    // capture_sha256 binds the complete stage root/group inventory; completed_at
    // is the complete stage interval end, not that first root's exit timestamp.
    // Teardown covers every owned stage group, not arbitrary account processes.
    root_creation: rootCreation,
    started_at: started,
    completed_at: completed,
    capture_sha256: hex(raw.runtime.capture_sha256),
    teardown: {
      root_exited: true as const,
      tree_empty: true as const,
      remaining_pids: [] as number[],
      completed_at: settled,
      capture_sha256: hex(raw.runtime.teardown.capture_sha256),
    },
  };
  exact(
    raw.compatibility,
    "catalog_formats,cli_protocol,library,minimum_os_version,required_capabilities",
  );
  exact(raw.compatibility.library, "lock_protocol,read,write_schema");
  const compatibility = {
    minimum_os_version: text(raw.compatibility.minimum_os_version, 128),
    required_capabilities: unique(
      raw.compatibility.required_capabilities,
      (v) => text(v, 128),
      32,
      0,
    ),
    cli_protocol: range(raw.compatibility.cli_protocol),
    catalog_formats: unique(raw.compatibility.catalog_formats, positive),
    library: {
      read: range(raw.compatibility.library.read),
      write_schema: positive(raw.compatibility.library.write_schema),
      lock_protocol: text(raw.compatibility.library.lock_protocol, 128),
    },
  };
  const requiredScenarios = temporal
    ? nativePrepublicationScenarios
    : nativeQualificationScenarios[stage];
  if (!Array.isArray(raw.scenarios) || raw.scenarios.length !== requiredScenarios.length)
    throw new Error("native stage scenario coverage is incomplete");
  const scenarios = raw.scenarios.map((value: unknown, index) => {
    exact(value, "capture_sha256,completed_at,name,outcome,started_at");
    if (value.name !== requiredScenarios[index] || value.outcome !== "passed")
      throw new Error("native stage scenario is missing, failed or reordered");
    const scenarioStart = instant(value.started_at),
      scenarioEnd = instant(value.completed_at);
    if (
      Date.parse(scenarioStart) < Date.parse(started) ||
      Date.parse(scenarioStart) > Date.parse(scenarioEnd) ||
      Date.parse(scenarioEnd) > Date.parse(completed)
    )
      throw new Error("native scenario chronology is outside actual runtime");
    return {
      name: value.name,
      outcome: "passed" as const,
      started_at: scenarioStart,
      completed_at: scenarioEnd,
      capture_sha256: hex(value.capture_sha256),
    };
  });
  return {
    schema_version: raw.schema_version,
    ...(temporal
      ? {
          native_prepublication_profile: nativePrepublicationProfile,
          pending_obligations: [...nativePrepublicationPending],
        }
      : {}),
    stage,
    platform_label: platform,
    candidate,
    journey,
    producer,
    host,
    runtime,
    compatibility,
    scenarios,
  };
}
export type NativeReleaseQualification = ReturnType<typeof inspectNativeReleaseQualification>;
