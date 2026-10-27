import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileIdentity, readBoundedEvidenceFile } from "./development-evidence.mts";

import { isRecord } from "./runtime-values.mts";
import type { FileIdentity } from "./development-evidence.mts";
interface PacketIdentity extends FileIdentity {
  role?: string;
}
type ContentIdentity = Pick<FileIdentity, "bytes" | "sha256"> & { role?: string };
interface PacketRequirement {
  id: string;
  required_scenarios: string[];
}
interface PacketCriterion {
  id?: string;
  scenarios?: string[];
  required_images?: string[];
}
interface ExecutionQualification {
  runtime_conditions: Record<string, unknown>;
  fixture_identities: PacketIdentity[];
  initial_state: Record<string, unknown>;
  requirements: PacketRequirement[];
  scenarios: string[];
  acceptance_criteria: PacketCriterion[];
}
interface PacketBindings {
  source_head: string;
  current_target: string;
  composed_tree: string;
  product_artifacts: PacketIdentity[];
  harness_inputs: PacketIdentity[];
  // Additional build-owner metadata is retained and hashed without interpreting it.
  build_inputs: { build_input_fingerprint: string; [key: string]: unknown };
  execution_qualification: ExecutionQualification;
}
interface PacketSourceReview {
  reviewer?: string;
  reference?: string;
  source_head?: string;
  outcome?: string;
}
interface ReusableEvidence {
  evidence: FileIdentity;
  packet: FileIdentity;
}
interface PacketGap {
  id?: string;
  required?: boolean;
}
export interface AcceptancePreflightContext {
  root: string;
  bindings: PacketBindings;
  prerequisites: readonly object[];
  reusable_evidence?: readonly ReusableEvidence[];
  known_gaps?: readonly PacketGap[];
  source_review: PacketSourceReview;
  author: string;
}
type PacketOutcomeKind = "passed" | "failed" | "skipped" | "unsupported" | "not-run";
interface PacketOutcome {
  scenario: string;
  outcome: PacketOutcomeKind;
}
interface PacketReview {
  reviewer: string;
  reference: string;
  source_head: string;
  outcome: PacketOutcomeKind;
}
interface PacketDelivery {
  source_head: string;
  current_target: string;
  composed_tree: string;
  review_reference: string;
}
export interface AcceptanceCompletionContext {
  evidence_identity: FileIdentity;
  outcomes: readonly PacketOutcome[];
  retained_artifacts: readonly FileIdentity[];
  process_closure: {
    outcome: PacketOutcomeKind;
    positive_exit?: boolean;
    artifacts: readonly FileIdentity[];
  };
  image_inspections: readonly (FileIdentity & {
    inspected_at: string;
    reviewer: string;
    findings: unknown;
  })[];
  outcome_review: PacketReview;
  final_delivery: PacketDelivery;
  composition_decision?: {
    reviewer: string;
    evidence: unknown;
    outcome: "unchanged-effective-dependencies" | "affected-scenarios-requalified";
  };
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
const outcomes = new Set(["passed", "failed", "skipped", "unsupported", "not-run"]);
const contentIdentities = (inputs: readonly ContentIdentity[]) =>
  inputs.map(({ role, sha256, bytes }) => ({ role, sha256, bytes }));
const harnessIdentity = (bindings: PacketBindings) =>
  hash(contentIdentities(bindings.harness_inputs));
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}
function requireIdentities(inputs: unknown): asserts inputs is PacketIdentity[] {
  if (
    !Array.isArray(inputs) ||
    !inputs.length ||
    inputs.some((value: unknown) => {
      if (!isRecord(value)) return true;
      return (
        typeof value.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.sha256) ||
        typeof value.bytes !== "number" ||
        !Number.isSafeInteger(value.bytes) ||
        value.bytes < 0 ||
        typeof value.path !== "string" ||
        !path.isAbsolute(value.path) ||
        (value.role !== undefined && typeof value.role !== "string")
      );
    })
  )
    throw new Error("Packet requires explicit retained/content identities");
}
function validateBindings(bindings: unknown): asserts bindings is PacketBindings {
  if (
    !isRecord(bindings) ||
    !sha(bindings.source_head) ||
    !sha(bindings.current_target) ||
    !sha(bindings.composed_tree)
  )
    throw new Error("Packet source/target/composed-tree bindings are incomplete");
  requireIdentities(bindings.product_artifacts);
  requireIdentities(bindings.harness_inputs);
  const execution = bindings.execution_qualification;
  if (
    !isRecord(bindings.build_inputs) ||
    typeof bindings.build_inputs.build_input_fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(bindings.build_inputs.build_input_fingerprint) ||
    !isRecord(execution) ||
    !isRecord(execution.runtime_conditions) ||
    !Array.isArray(execution.fixture_identities) ||
    !isRecord(execution.initial_state) ||
    !Array.isArray(execution.requirements) ||
    !execution.requirements.length ||
    !strings(execution.scenarios) ||
    !execution.scenarios.length ||
    new Set(execution.scenarios).size !== execution.scenarios.length ||
    !Array.isArray(execution.acceptance_criteria) ||
    !execution.acceptance_criteria.length
  )
    throw new Error("Packet qualification dependencies/requirements are incomplete");
  const scenarios = execution.scenarios;
  if (
    execution.requirements.some(
      (item: unknown) =>
        !isRecord(item) ||
        typeof item.id !== "string" ||
        !item.id ||
        !strings(item.required_scenarios) ||
        !item.required_scenarios.length ||
        item.required_scenarios.some((id) => !scenarios.includes(id)),
    ) ||
    execution.acceptance_criteria.some(
      (item: unknown) =>
        !isRecord(item) ||
        (item.id !== undefined && typeof item.id !== "string") ||
        (item.scenarios !== undefined && !strings(item.scenarios)) ||
        (item.required_images !== undefined && !strings(item.required_images)),
    )
  )
    throw new Error("Packet qualification dependencies/requirements are incomplete");
  if (execution.fixture_identities.length) requireIdentities(execution.fixture_identities);
}
function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Packet context must be an object");
  return value;
}

export function observePacketDeliveryBindings(root: string, expectedHead: string) {
  const git = (args: readonly string[]) => {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        "Packet source/target observation failed; refresh through the existing delivery route",
      );
    return result.stdout.trim();
  };
  if (git(["rev-parse", "HEAD"]) !== expectedHead) throw new Error("Packet source head changed");
  const remote = git(["ls-remote", "origin", "refs/heads/main"]).split(/\s+/u);
  if (remote.length !== 2 || !sha(remote[0]) || remote[1] !== "refs/heads/main")
    throw new Error("Packet current target unavailable");
  const tree = git(["merge-tree", "--write-tree", remote[0], expectedHead]);
  if (!sha(tree) || git(["rev-parse", "HEAD"]) !== expectedHead)
    throw new Error("Packet composed tree/source changed");
  return { source_head: expectedHead, current_target: remote[0], composed_tree: tree };
}

function sourceReview(value: unknown): PacketSourceReview {
  const record = object(value);
  const review: PacketSourceReview = { ...record };
  for (const key of ["reviewer", "reference", "source_head", "outcome"] as const) {
    if (record[key] !== undefined) review[key] = text(record[key]);
  }
  return review;
}
function knownGaps(value: unknown): PacketGap[] {
  return records(value).map((record) => {
    const gap: PacketGap = { ...record };
    if (record.id !== undefined) gap.id = text(record.id);
    if (record.required !== undefined) {
      if (typeof record.required !== "boolean")
        throw new Error("Packet gap requirement must be boolean");
      gap.required = record.required;
    }
    return gap;
  });
}
/** Narrow metadata once at its external boundary, using the same packet validator. */
export function parseAcceptancePreflightContext(value: unknown): AcceptancePreflightContext {
  const {
    root,
    bindings,
    prerequisites,
    reusable_evidence = [],
    known_gaps = [],
    source_review,
    author,
  } = object(value);
  if (typeof root !== "string") throw new Error("Packet source root must be a string");
  validateBindings(bindings);
  if (
    !Array.isArray(prerequisites) ||
    !Array.isArray(reusable_evidence) ||
    !Array.isArray(known_gaps) ||
    !source_review ||
    typeof author !== "string" ||
    !author
  )
    throw new Error("Packet preflight context is incomplete");
  return {
    root,
    bindings,
    author,
    prerequisites: records(prerequisites),
    reusable_evidence: records(reusable_evidence).map((record) => ({
      ...record,
      evidence: identity(record.evidence),
      packet: identity(record.packet),
    })),
    known_gaps: knownGaps(known_gaps),
    source_review: sourceReview(source_review),
  };
}
export async function writeAcceptancePreflight(
  directory: string,
  context: AcceptancePreflightContext,
) {
  const { root, bindings, prerequisites, reusable_evidence, known_gaps, source_review, author } =
    parseAcceptancePreflightContext(context);
  const relative = path.relative(path.resolve(root), path.resolve(directory));
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  )
    throw new Error("Runtime packets must live outside the source checkout");
  const packet = {
    format_version: 1,
    stage: "preflight",
    created_at: new Date().toISOString(),
    author,
    bindings: structuredClone(bindings),
    prerequisites,
    reusable_evidence: reusable_evidence ?? [],
    known_gaps: known_gaps ?? [],
    source_review,
    interpretation:
      "Evidence record only; no acceptance, merge authority or permission to change its verifier",
    harness_identity: harnessIdentity(bindings),
    execution_qualification_identity: hash(bindings.execution_qualification),
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "preflight.json");
  await writeFile(file, JSON.stringify(packet, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { packet, identity: await fileIdentity(file) };
}

// Compare effective dependencies and declared requirements, never filenames or
// source-head equality. Ambiguous/missing declarations require requalification.
function assessAcceptanceScenarios(
  previousValue: unknown,
  nextValue: unknown,
  requirePassed: boolean,
) {
  const previous = isRecord(previousValue) ? previousValue : {};
  const next = isRecord(nextValue) ? nextValue : {};
  const previousBindings = previous.bindings;
  const nextBindings = next.bindings;
  try {
    validateBindings(previousBindings);
    validateBindings(nextBindings);
  } catch {
    return {
      reusable: [],
      rerun:
        isRecord(nextBindings) &&
        isRecord(nextBindings.execution_qualification) &&
        strings(nextBindings.execution_qualification.scenarios)
          ? nextBindings.execution_qualification.scenarios
          : [],
      reason: "ambiguous-bindings",
    };
  }
  const previousExecution = previousBindings.execution_qualification,
    nextExecution = nextBindings.execution_qualification;
  const products = contentIdentities;
  const productChanged =
    hash(products(previousBindings.product_artifacts)) !==
    hash(products(nextBindings.product_artifacts));
  const harnessChanged =
    harnessIdentity(previousBindings) !== harnessIdentity(nextBindings) ||
    previous.harness_identity !== harnessIdentity(previousBindings) ||
    next.harness_identity !== harnessIdentity(nextBindings);
  const commonChanged =
    (["runtime_conditions", "initial_state"] as const).some(
      (key) => hash(previousExecution[key]) !== hash(nextExecution[key]),
    ) ||
    hash(products(previousExecution.fixture_identities)) !==
      hash(products(nextExecution.fixture_identities));
  const reusable = [],
    rerun = [];
  for (const scenario of nextExecution.scenarios) {
    const relevant = (execution: ExecutionQualification) => ({
      requirements: execution.requirements.filter((item) =>
        item.required_scenarios.includes(scenario),
      ),
      criteria: execution.acceptance_criteria.filter(
        (item) => !item.scenarios || item.scenarios.includes(scenario),
      ),
    });
    if (
      productChanged ||
      harnessChanged ||
      commonChanged ||
      hash(relevant(previousExecution)) !== hash(relevant(nextExecution)) ||
      (requirePassed &&
        (previous.stage !== "completed" ||
          !Array.isArray(previous.outcomes) ||
          !previous.outcomes.some(
            (item: unknown) =>
              isRecord(item) && item.scenario === scenario && item.outcome === "passed",
          ))) ||
      !previousExecution.scenarios.includes(scenario)
    )
      rerun.push(scenario);
    else reusable.push(scenario);
  }
  return { reusable, rerun, reason: "effective-dependencies-and-requirements" };
}

export function reusableAcceptanceScenarios(previousValue: unknown, nextValue: unknown) {
  return assessAcceptanceScenarios(previousValue, nextValue, true);
}

// Compatibility locates failed observations too; it never grants their reuse.
export function compatibleAcceptanceScenarios(previousValue: unknown, nextValue: unknown) {
  const {
    reusable: compatible,
    rerun: incompatible,
    reason,
  } = assessAcceptanceScenarios(previousValue, nextValue, false);
  return { compatible, incompatible, reason };
}

/** Inspect frozen dependencies without inventing the capture's source-root path. */
export function inspectAcceptancePreflight(value: unknown) {
  const packet = acceptanceRecord(value);
  if (
    packet.format_version !== 1 ||
    packet.stage !== "preflight" ||
    packet.harness_identity !== harnessIdentity(packet.bindings) ||
    packet.execution_qualification_identity !== hash(packet.bindings.execution_qualification)
  )
    throw new Error("Expected a self-consistent preflight packet");
  return {
    bindings: packet.bindings,
    source_review: packet.source_review,
    known_gaps: packet.known_gaps,
    prerequisites: object(value).prerequisites ?? null,
  };
}

async function verifyIdentity(identity: FileIdentity) {
  const actual = await fileIdentity(identity.path, { maxBytes: identity.bytes });
  if (actual.sha256 !== identity.sha256 || actual.bytes !== identity.bytes)
    throw new Error("Packet retained artifact bytes changed");
}

interface ClosureProcess {
  pid: number;
  path: string;
  started_filetime: string | number;
}
function validProcess(value: unknown): value is ClosureProcess {
  return (
    isRecord(value) &&
    typeof value.pid === "number" &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.path === "string" &&
    path.isAbsolute(value.path) &&
    (typeof value.started_filetime === "string" || typeof value.started_filetime === "number") &&
    /^\d+$/u.test(String(value.started_filetime))
  );
}
function equivalentPath(left: unknown, right: unknown) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left.replaceAll("\\", "/").toLowerCase() === right.replaceAll("\\", "/").toLowerCase()
  );
}
function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Packet records must be an array");
  return value.map((item: unknown) => object(item));
}
async function closureProof(
  identity: FileIdentity,
  retained: readonly FileIdentity[],
  evidence: unknown,
): Promise<boolean> {
  const record = object(JSON.parse(await readFile(identity.path, "utf8")));
  if (record.method === "private-pid-namespace-init-normal-unshare-join") {
    // A normal PID-1 join proves kernel teardown of descendants. Driver exit
    // remains optional when closing the control pipe initiates teardown.
    const exit = record.exit,
      ready = record.ready;
    return (
      record.quiesced === true &&
      !record.protocol_error &&
      isRecord(exit) &&
      exit.code === 0 &&
      exit.signal === null &&
      typeof exit.observed_at === "string" &&
      Number.isFinite(Date.parse(exit.observed_at)) &&
      isRecord(ready) &&
      ready.kind === "namespace-ready" &&
      ready.pid === 1 &&
      typeof record.nonce === "string" &&
      /^[a-f0-9-]{36}$/u.test(record.nonce) &&
      Array.isArray(record.events) &&
      record.events.some(
        (event: unknown) =>
          isRecord(event) &&
          event.kind === "driver-started" &&
          event.nonce === record.nonce &&
          typeof event.pid === "number" &&
          Number.isInteger(event.pid) &&
          event.pid > 1,
      ) &&
      ["unshare_sha256", "init_sha256", "node_sha256"].every((key) => {
        const value = record[key];
        return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
      })
    );
  }
  if (
    typeof record.snapshot === "string" &&
    isRecord(record.exited) &&
    !record.session_quit_error
  ) {
    const snapshotIdentity = retained.find((item) => item.path === record.snapshot);
    if (!snapshotIdentity) return false;
    const snapshot = object(JSON.parse(await readFile(snapshotIdentity.path, "utf8")));
    const binding = object(object(evidence).execution_binding);
    const app = records(binding.product_artifacts).find((input) => input.role === "app");
    const driver =
      binding.runtime_tools === undefined
        ? undefined
        : records(binding.runtime_tools).find((input) => input.role === "driver");
    const driverPath =
      driver?.binding === "retained-artifact" ? object(driver.retained).path : driver?.path;
    const root = snapshot.driver;
    const processes: unknown = snapshot.processes;
    const exited = record.exited;
    return (
      validProcess(root) &&
      equivalentPath(root.path, driverPath) &&
      (app?.binding === "retained-artifact" || app?.binding === "live-path-checked-cooperative") &&
      Array.isArray(processes) &&
      processes.length > 1 &&
      processes.every(validProcess) &&
      processes.some(
        (item) =>
          item.pid === root.pid &&
          item.started_filetime === root.started_filetime &&
          item.path === root.path,
      ) &&
      processes.some((item) => equivalentPath(item.path, app.consumed_path)) &&
      exited.observed_processes === processes.length &&
      typeof exited.exited_at === "string" &&
      Number.isFinite(Date.parse(exited.exited_at)) &&
      typeof snapshot.captured_at === "string" &&
      Date.parse(exited.exited_at) >= Date.parse(snapshot.captured_at) &&
      typeof exited.wait_ms === "number" &&
      Number.isFinite(exited.wait_ms) &&
      exited.wait_ms >= 0 &&
      exited.wait_ms <= 5000
    );
  }
  return false;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Packet text field required");
  return value;
}
function identity(value: unknown): PacketIdentity {
  const identities = [value];
  requireIdentities(identities);
  const first = identities[0];
  if (!first) throw new Error("Packet identity missing");
  return first;
}
function checkedIdentities(value: unknown): PacketIdentity[] {
  requireIdentities(value);
  return value;
}
function checkedContentIdentities(value: unknown): ContentIdentity[] {
  return records(value).map((item) => {
    if (
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.sha256) ||
      typeof item.bytes !== "number" ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 0 ||
      (item.role !== undefined && typeof item.role !== "string")
    )
      throw new Error("Canonical execution content identity is invalid");
    return {
      ...item,
      sha256: item.sha256,
      bytes: item.bytes,
      ...(typeof item.role === "string" ? { role: item.role } : {}),
    };
  });
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
function acceptanceRecord(value: unknown) {
  const record = object(value);
  const bindings = record.bindings;
  validateBindings(bindings);
  return {
    ...record,
    bindings,
    format_version: record.format_version,
    stage: record.stage,
    execution_observation_source_head: record.execution_observation_source_head,
    qualification_complete: record.qualification_complete,
    harness_identity: record.harness_identity,
    execution_qualification_identity: record.execution_qualification_identity,
    author: text(record.author),
    source_review: sourceReview(record.source_review),
    reusable_evidence: records(record.reusable_evidence),
    known_gaps: knownGaps(record.known_gaps),
    interpretation: text(record.interpretation),
    ...(record.evidence === undefined ? {} : { evidence: identity(record.evidence) }),
    ...(record.preflight === undefined ? {} : { preflight: identity(record.preflight) }),
    ...(record.execution_preflight === undefined
      ? {}
      : { execution_preflight: identity(record.execution_preflight) }),
  };
}

async function evaluateAcceptancePacket(
  preflightIdentity: FileIdentity,
  context: AcceptanceCompletionContext,
) {
  const {
    evidence_identity: evidenceValue,
    outcomes: outcomeValues,
    retained_artifacts: retainedValue,
    process_closure: closureValue,
    image_inspections: inspectionValues,
    outcome_review: reviewValue,
    final_delivery: deliveryValue,
    composition_decision: decisionValue,
  } = object(context);
  const evidence_identity = identity(evidenceValue);
  const retained_artifacts = retainedValue;
  const actualOutcomes = records(outcomeValues);
  const process_closure = object(closureValue);
  const image_inspections = records(inspectionValues);
  const outcome_review = object(reviewValue);
  const final_delivery = object(deliveryValue);
  const composition_decision =
    decisionValue === undefined || decisionValue === null ? undefined : object(decisionValue);
  await verifyIdentity(preflightIdentity);
  const preflight = acceptanceRecord(JSON.parse(await readFile(preflightIdentity.path, "utf8")));
  if (preflight.format_version !== 1 || preflight.stage !== "preflight")
    throw new Error("Completion requires an actual preflight packet");
  validateBindings(preflight.bindings);
  if (
    !preflight.source_review.reviewer ||
    !preflight.source_review.reference ||
    preflight.source_review.source_head !== preflight.bindings.source_head ||
    typeof preflight.source_review.outcome !== "string" ||
    !["passed", "failed", "unsupported"].includes(preflight.source_review.outcome)
  )
    throw new Error("Completed packet cannot retain a placeholder source review");
  await verifyIdentity(evidence_identity);
  const evidence = object(JSON.parse(await readFile(evidence_identity.path, "utf8")));
  const selected = preflight.bindings.execution_qualification.scenarios;
  let observedPreflight = preflight,
    observedPreflightIdentity = preflightIdentity;
  if (evidence.revision !== preflight.bindings.source_head) {
    const reusable = preflight.reusable_evidence.find(
      (item) =>
        optionalObject(item.evidence)?.path === evidence_identity.path &&
        optionalObject(item.evidence)?.sha256 === evidence_identity.sha256,
    );
    if (!reusable?.packet)
      throw new Error("Different source-head observations require bound reusable evidence");
    const reusablePacket = identity(reusable.packet);
    await verifyIdentity(reusablePacket);
    const prior = acceptanceRecord(JSON.parse(await readFile(reusablePacket.path, "utf8")));
    if (
      prior.evidence?.sha256 !== evidence_identity.sha256 ||
      (prior.execution_observation_source_head ?? prior.bindings.source_head) !==
        evidence.revision ||
      prior.qualification_complete !== true ||
      !selected.every((id) => reusableAcceptanceScenarios(prior, preflight).reusable.includes(id))
    )
      throw new Error("Effective dependencies require requalification");
    observedPreflightIdentity = identity(prior.execution_preflight ?? prior.preflight);
    await verifyIdentity(observedPreflightIdentity);
    observedPreflight = acceptanceRecord(
      JSON.parse(await readFile(observedPreflightIdentity.path, "utf8")),
    );
  }
  const observed = optionalObject(evidence.execution_binding);
  const evidencePreflight = optionalObject(evidence.acceptance_preflight);
  if (
    evidence.format_version !== 3 ||
    !observed ||
    evidencePreflight?.path !== observedPreflightIdentity.path ||
    evidencePreflight?.sha256 !== observedPreflightIdentity.sha256 ||
    evidencePreflight?.bytes !== observedPreflightIdentity.bytes ||
    !Array.isArray(evidence.setup_checks) ||
    !Array.isArray(evidence.selected_scenarios) ||
    hash(evidence.selected_scenarios) !==
      hash(observedPreflight.bindings.execution_qualification.scenarios) ||
    !Array.isArray(observed.product_artifacts) ||
    !Array.isArray(observed.harness_inputs) ||
    hash(contentIdentities(checkedContentIdentities(observed.product_artifacts))) !==
      hash(contentIdentities(observedPreflight.bindings.product_artifacts)) ||
    hash(contentIdentities(checkedContentIdentities(observed.harness_inputs))) !==
      hash(contentIdentities(observedPreflight.bindings.harness_inputs)) ||
    hash(observed.build_inputs) !== hash(observedPreflight.bindings.build_inputs) ||
    hash(observed.execution_qualification) !==
      hash(observedPreflight.bindings.execution_qualification)
  )
    throw new Error("Canonical execution evidence does not bind the frozen preflight dependencies");
  if (
    !Array.isArray(actualOutcomes) ||
    actualOutcomes.length !== selected.length ||
    new Set(actualOutcomes.map((item) => item.scenario)).size !== selected.length ||
    actualOutcomes.some(
      (item) =>
        typeof item.scenario !== "string" ||
        !selected.includes(item.scenario) ||
        typeof item.outcome !== "string" ||
        !outcomes.has(item.outcome) ||
        !Array.isArray(evidence.checks) ||
        !evidence.checks.some(
          (check: unknown) =>
            isRecord(check) && check.scenario === item.scenario && check.outcome === item.outcome,
        ),
    )
  )
    throw new Error("Actual packet outcomes do not bind selected execution");
  requireIdentities(retained_artifacts);
  for (const identity of retained_artifacts) {
    await verifyIdentity(identity);
    if (
      !Array.isArray(evidence.artifacts) ||
      !evidence.artifacts.some(
        (item: unknown) =>
          isRecord(item) &&
          item.path === identity.path &&
          item.sha256 === identity.sha256 &&
          item.bytes === identity.bytes,
      )
    )
      throw new Error("Packet artifact was not retained by this run");
  }
  if (
    !process_closure ||
    typeof process_closure.outcome !== "string" ||
    !outcomes.has(process_closure.outcome) ||
    (process_closure.positive_exit !== undefined &&
      typeof process_closure.positive_exit !== "boolean") ||
    !Array.isArray(process_closure.artifacts) ||
    !process_closure.artifacts.length
  )
    throw new Error("Actual process closure is required");
  const closureArtifacts = checkedIdentities(process_closure.artifacts);
  for (const identity of closureArtifacts) {
    if (
      !retained_artifacts.some(
        (item) => item.path === identity.path && item.sha256 === identity.sha256,
      )
    )
      throw new Error("Process closure is not bound to retained run evidence");
  }
  const positiveClosure = (
    await Promise.all(
      closureArtifacts.map((identity) =>
        closureProof(identity, retained_artifacts, evidence).catch(() => false),
      ),
    )
  ).some(Boolean);
  const requiredNames = preflight.bindings.execution_qualification.acceptance_criteria.flatMap(
    (item) => item.required_images ?? [],
  );
  if (
    new Set(requiredNames).size !== requiredNames.length ||
    requiredNames.some((name) => !/^[a-z0-9-]+\.png$/u.test(name))
  )
    throw new Error("Required image declarations are ambiguous");
  const images = retained_artifacts.filter(
    (item) =>
      path.extname(item.path).toLowerCase() === ".png" &&
      requiredNames.includes(path.basename(item.path)),
  );
  const missingImages = requiredNames.filter(
    (name) => !images.some((image) => path.basename(image.path) === name),
  );
  for (const image of images) {
    const receiptPath = image.path.replace(/\.png$/u, "-capture.json");
    const receiptIdentity = retained_artifacts.find((item) => item.path === receiptPath);
    if (!receiptIdentity) throw new Error("Required image has no settled capture receipt");
    const capture = object(JSON.parse(await readFile(receiptPath, "utf8")));
    const capturedImage = optionalObject(capture.image);
    const observation = optionalObject(capture.observation);
    const semantic = optionalObject(observation?.semantic);
    const state = optionalObject(observation?.state);
    const applicationState = optionalObject(state?.application_state);
    if (
      capture.outcome !== "captured" ||
      typeof capture.scenario !== "string" ||
      !selected.includes(capture.scenario) ||
      !preflight.bindings.execution_qualification.acceptance_criteria.some(
        (criterion) =>
          criterion.required_images?.includes(path.basename(image.path)) &&
          typeof capture.scenario === "string" &&
          criterion.scenarios?.includes(capture.scenario),
      ) ||
      capturedImage?.sha256 !== image.sha256 ||
      capturedImage?.bytes !== image.bytes ||
      semantic?.ready !== true ||
      state?.visible !== true ||
      applicationState?.loading !== 0
    )
      throw new Error("Required image is diagnostic or bound to another scenario/state");
  }
  if (
    !Array.isArray(image_inspections) ||
    image_inspections.length !== images.length ||
    new Set(image_inspections.map((item) => item.path)).size !== images.length ||
    image_inspections.some(
      (item) =>
        typeof item.inspected_at !== "string" ||
        !Number.isFinite(Date.parse(item.inspected_at)) ||
        typeof item.reviewer !== "string" ||
        !item.reviewer ||
        !item.findings ||
        !images.some(
          (image) =>
            image.path === item.path && image.sha256 === item.sha256 && image.bytes === item.bytes,
        ),
    )
  )
    throw new Error("Completion requires actual inspection bound to every exact retained image");
  if (
    typeof outcome_review.reviewer !== "string" ||
    !outcome_review.reviewer ||
    outcome_review.reviewer === preflight.author ||
    typeof outcome_review.reference !== "string" ||
    !outcome_review.reference ||
    outcome_review.source_head !== preflight.bindings.source_head ||
    typeof outcome_review.outcome !== "string" ||
    !outcomes.has(outcome_review.outcome)
  )
    throw new Error("Independent actual outcome review is required");
  if (
    !["source_head", "current_target", "composed_tree"].every((key) =>
      sha(final_delivery?.[key]),
    ) ||
    final_delivery.source_head !== preflight.bindings.source_head ||
    typeof final_delivery.review_reference !== "string" ||
    !final_delivery.review_reference
  )
    throw new Error("Final delivery binding/source review is incomplete");
  if (
    composition_decision !== undefined ||
    final_delivery.current_target !== preflight.bindings.current_target ||
    final_delivery.composed_tree !== preflight.bindings.composed_tree
  ) {
    if (
      typeof composition_decision?.reviewer !== "string" ||
      !composition_decision.reviewer ||
      !composition_decision.evidence ||
      typeof composition_decision.outcome !== "string" ||
      !["unchanged-effective-dependencies", "affected-scenarios-requalified"].includes(
        composition_decision.outcome,
      )
    )
      throw new Error("Changed target/composition requires reviewed qualification decision");
  }
  const complete =
    !missingImages.length &&
    evidence.outcome === "passed" &&
    evidence.setup_checks.every(
      (check: unknown) => isRecord(check) && check.outcome === "passed",
    ) &&
    actualOutcomes.every((item) => item.outcome === "passed") &&
    process_closure.outcome === "passed" &&
    process_closure.positive_exit === true &&
    positiveClosure &&
    outcome_review.outcome === "passed" &&
    preflight.source_review.outcome === "passed" &&
    preflight.source_review.source_head === preflight.bindings.source_head &&
    !preflight.known_gaps.some((item) => item.required === true);
  const packet = {
    ...preflight,
    stage: "completed",
    completed_at: new Date().toISOString(),
    preflight: preflightIdentity,
    evidence: evidence_identity,
    execution_observation_source_head: evidence.revision,
    execution_preflight: observedPreflightIdentity,
    outcomes: context.outcomes,
    retained_artifacts: context.retained_artifacts,
    process_closure: context.process_closure,
    verified_positive_closure: positiveClosure,
    image_inspections: context.image_inspections,
    outcome_review: context.outcome_review,
    final_delivery: context.final_delivery,
    composition_decision: context.composition_decision ?? null,
    missing_required_images: missingImages,
    qualification_complete: complete,
  };
  return packet;
}

export async function completeAcceptancePacket(
  preflightIdentity: FileIdentity,
  context: AcceptanceCompletionContext,
) {
  const packet = await evaluateAcceptancePacket(preflightIdentity, context);
  const file = path.join(path.dirname(preflightIdentity.path), "completed.json");
  await writeFile(file, JSON.stringify(packet, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { packet, identity: await fileIdentity(file) };
}

// Re-run the owning verifier; a nearby JSON success flag is not a receipt.
export async function revalidateAcceptancePacket(receipt: FileIdentity) {
  if (!Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1 || receipt.bytes > 4 * 1024 * 1024)
    throw new Error("Acceptance receipt must be bounded");
  const { bytes } = await readBoundedEvidenceFile(receipt.path, receipt.bytes);
  if (
    bytes.byteLength !== receipt.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== receipt.sha256
  )
    throw new Error("Acceptance receipt changed during reading");
  const record = object(JSON.parse(bytes.toString("utf8")));
  if (
    record.format_version !== 1 ||
    record.stage !== "completed" ||
    typeof record.completed_at !== "string" ||
    !Number.isFinite(Date.parse(record.completed_at))
  )
    throw new Error("Expected a dated completed acceptance packet");
  const packet = await evaluateAcceptancePacket(identity(record.preflight), {
    ...record,
    evidence_identity: record.evidence,
  } as unknown as AcceptanceCompletionContext);
  const { completed_at: _oldDate, ...previous } = record;
  const { completed_at: _newDate, ...verified } = packet;
  if (!isDeepStrictEqual(previous, JSON.parse(JSON.stringify(verified))))
    throw new Error("Completed receipt differs from revalidated evidence");
  const execution = await readBoundedEvidenceFile(packet.evidence.path, packet.evidence.bytes);
  if (
    execution.identity.sha256 !== packet.evidence.sha256 ||
    execution.identity.bytes !== packet.evidence.bytes
  )
    throw new Error("Packet retained execution bytes changed");
  const observation = object(JSON.parse(execution.bytes.toString("utf8")));
  const observedAt =
    typeof observation.captured_at === "string" &&
    Number.isFinite(Date.parse(observation.captured_at))
      ? observation.captured_at
      : null;
  return { ...packet, completed_at: record.completed_at, observation_captured_at: observedAt };
}
