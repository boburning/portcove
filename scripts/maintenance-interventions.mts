import { createHash } from "node:crypto";
import { channels, platforms } from "../apps/desktop/src/catalog-values.generated.ts";
import { isRecord } from "./runtime-values.mts";

export const managedInterventionEvidenceLimit = 64 * 1024;
const format = "portcove-managed-intervention-evidence";
const maximumSequences = 96;
const sha256 = /^[0-9a-f]{64}$/u;
const observerRevision =
  /^upstream-observer-run:[1-9]\d*-[1-9]\d*@[a-f0-9]{40}#sha256:[a-f0-9]{64}$/u;
const reviewReference =
  /^https:\/\/github\.com\/boburning\/portcove\/(?:issues\/[1-9]\d*#issuecomment-|pull\/[1-9]\d*#pullrequestreview-)[1-9]\d*$/u;
const isDigest = (value: unknown): value is string =>
  typeof value === "string" && sha256.test(value);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function utc(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value))
    return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function within(value: string, start: string, end: string) {
  const time = Date.parse(value);
  return time >= Date.parse(start) && time <= Date.parse(end);
}

function sequenceFrom(value: unknown) {
  if (!isRecord(value)) throw new Error("Expected a reviewed intervention sequence");
  const {
    candidate_key,
    port_key,
    platform,
    channel,
    observer_revision,
    definition_sha256,
    client_sha256,
    review_ref,
    start,
    end,
    coverage,
    actions,
  } = value;
  if (
    !isDigest(candidate_key) ||
    typeof port_key !== "string" ||
    !/^port:[a-z0-9][a-z0-9-]{0,127}$/u.test(port_key) ||
    !platforms.some((name) => name === platform) ||
    !channels.some((name) => name === channel) ||
    typeof observer_revision !== "string" ||
    !observerRevision.test(observer_revision) ||
    !isDigest(definition_sha256) ||
    !isDigest(client_sha256) ||
    typeof review_ref !== "string" ||
    !reviewReference.test(review_ref) ||
    !utc(start) ||
    !utc(end) ||
    start >= end ||
    (coverage !== "complete" && coverage !== "partial") ||
    !Array.isArray(actions) ||
    actions.length > 32
  )
    throw new Error("Invalid reviewed intervention sequence binding or scope");
  const evidence = (actions as unknown[]).map((action) => {
    if (
      !isRecord(action) ||
      !isDigest(action.id) ||
      !isDigest(action.evidence_sha256) ||
      !utc(action.witnessed_at) ||
      !within(action.witnessed_at, start, end)
    )
      throw new Error("Invalid witnessed intervention action");
    return {
      id: action.id,
      evidence_sha256: action.evidence_sha256,
      witnessed_at: action.witnessed_at,
    };
  });
  return {
    candidate_key,
    port_key,
    platform,
    channel,
    observer_revision,
    definition_sha256,
    client_sha256,
    review_ref,
    start,
    end,
    coverage,
    actions: [...new Map(evidence.map((action) => [JSON.stringify(action), action])).values()].sort(
      (a, b) =>
        a.id.localeCompare(b.id) ||
        a.evidence_sha256.localeCompare(b.evidence_sha256) ||
        a.witnessed_at.localeCompare(b.witnessed_at),
    ),
  };
}

type Sequence = ReturnType<typeof sequenceFrom>;

/** Canonical bytes for the existing acceptance owner to review and retain. */
export function encodeManagedInterventionEvidence(sequences: readonly unknown[]) {
  if (sequences.length > maximumSequences)
    throw new Error("Too many reviewed intervention sequences");
  const bytes = Buffer.from(
    `${JSON.stringify({ format, format_version: 1, sequences: sequences.map(sequenceFrom) })}\n`,
  );
  const digest = hash(bytes);
  readManagedInterventionEvidence(bytes, digest);
  return { bytes, sha256: digest };
}

/** The supplied digest binds the operator's exact input bytes. */
export function readManagedInterventionEvidence(bytes: Uint8Array, expectedSha256: string) {
  if (bytes.byteLength > managedInterventionEvidenceLimit || hash(bytes) !== expectedSha256)
    throw new Error("Intervention evidence does not match the bounded reviewed input");
  const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    !isRecord(input) ||
    input.format !== format ||
    input.format_version !== 1 ||
    !Array.isArray(input.sequences) ||
    input.sequences.length > maximumSequences
  )
    throw new Error("Invalid reviewed intervention evidence document");
  return { sha256: expectedSha256, sequences: input.sequences.map(sequenceFrom) };
}

export type ManagedInterventionEvidence = ReturnType<typeof readManagedInterventionEvidence>;

const actionEvidenceKey = ({ evidence_sha256, witnessed_at }: Sequence["actions"][number]) =>
  hash(Buffer.from(JSON.stringify([evidence_sha256, witnessed_at])));

function scopeClaim({ actions, ...scope }: Sequence) {
  return JSON.stringify([scope, [...new Set(actions.map(actionEvidenceKey))].sort()]);
}

/** Associates operator assertions with exact retained observer facts. */
export function scopedManagedInterventions(
  evidence: ManagedInterventionEvidence,
  observations: readonly unknown[],
  from: string,
  through: string,
) {
  const scopes = new Map<string, Sequence>();
  const candidateScopes = new Map<string, Set<string>>();
  const conflicts = new Set<string>();
  for (const sequence of evidence.sequences) {
    if (sequence.start < from || sequence.end > through) continue;
    const { candidate_key, client_sha256, start, end } = sequence;
    const key = JSON.stringify([candidate_key, client_sha256, start, end]);
    const prior = scopes.get(key);
    if (!prior) scopes.set(key, sequence);
    else if (scopeClaim(prior) !== scopeClaim(sequence)) conflicts.add(key);
    else scopes.set(key, { ...prior, actions: [...prior.actions, ...sequence.actions] });
    const keys = candidateScopes.get(candidate_key) ?? new Set<string>();
    keys.add(key);
    candidateScopes.set(candidate_key, keys);
  }

  const bound = new Map<string, Set<"eligible" | "pending">>();
  for (const row of observations) {
    if (
      !isRecord(row) ||
      typeof row.candidate_key !== "string" ||
      (row.state !== "eligible" && row.state !== "pending") ||
      typeof row.recorded_at !== "string"
    )
      continue;
    for (const key of candidateScopes.get(row.candidate_key) ?? []) {
      const sequence = scopes.get(key)!;
      if (
        row.port_key !== sequence.port_key ||
        row.platform !== sequence.platform ||
        row.channel !== sequence.channel ||
        row.observer_revision !== sequence.observer_revision ||
        row.definition_sha256 !== sequence.definition_sha256 ||
        !within(row.recorded_at, sequence.start, sequence.end)
      )
        continue;
      const states = bound.get(key) ?? new Set<"eligible" | "pending">();
      states.add(row.state);
      bound.set(key, states);
    }
  }

  const actionIds = new Map<string, { proofs: Set<string>; scopes: Set<string> }>();
  for (const [key, sequence] of scopes) {
    if (!bound.has(key) || conflicts.has(key)) continue;
    for (const action of sequence.actions) {
      const prior = actionIds.get(action.id) ?? {
        proofs: new Set<string>(),
        scopes: new Set<string>(),
      };
      prior.proofs.add(actionEvidenceKey(action));
      prior.scopes.add(key);
      actionIds.set(action.id, prior);
    }
  }
  for (const action of actionIds.values())
    if (action.proofs.size > 1) for (const key of action.scopes) conflicts.add(key);

  // Compare a fixed set so a conflict found for one interval cannot hide
  // another contradiction later in the input.
  const comparable = new Set([...bound.keys()].filter((key) => !conflicts.has(key)));
  for (const zeroKey of comparable) {
    const zero = scopes.get(zeroKey)!;
    if (zero.coverage !== "complete" || zero.actions.length !== 0) continue;
    for (const actionKey of candidateScopes.get(zero.candidate_key) ?? []) {
      if (!comparable.has(actionKey)) continue;
      const claimed = scopes.get(actionKey)!;
      if (
        claimed.client_sha256 === zero.client_sha256 &&
        claimed.definition_sha256 === zero.definition_sha256 &&
        claimed.actions.some(({ witnessed_at }) => within(witnessed_at, zero.start, zero.end))
      ) {
        conflicts.add(zeroKey);
        conflicts.add(actionKey);
      }
    }
  }

  let zeroReported = 0;
  const reportedActions = new Set<string>();
  const rows = [...scopes]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, sequence]) => {
      const { candidate_key, client_sha256, start, end } = sequence;
      if (conflicts.has(key))
        return { candidate_key, client_sha256, start, end, state: "conflicting-evidence" as const };
      const { actions: sequenceActions, ...scope } = sequence;
      const states = bound.get(key);
      if (!states) return { ...scope, state: "scope-unverified" as const };
      const matched_observation_states = [...states].sort();
      const action_evidence_keys = [...new Set(sequenceActions.map(actionEvidenceKey))].sort();
      if (action_evidence_keys.length) {
        for (const action of action_evidence_keys) reportedActions.add(action);
        return {
          ...scope,
          matched_observation_states,
          state: "action-reported" as const,
          action_evidence_keys,
        };
      }
      if (scope.coverage === "partial")
        return { ...scope, matched_observation_states, state: "partial" as const };
      zeroReported++;
      return { ...scope, matched_observation_states, state: "zero-reported" as const };
    });
  return {
    provenance: "operator-supplied-unverified",
    evidence_sha256: evidence.sha256,
    distinct_reported_actions:
      reportedActions.size || (rows.length > 0 && zeroReported === rows.length ? 0 : null),
    reported_zero_sequences: zeroReported,
    submitted_distinct_candidates: candidateScopes.size,
    verified_human_interventions: null,
    sequences: rows,
  };
}
