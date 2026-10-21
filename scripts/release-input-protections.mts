import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { GitHubRestReader } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { inspectReleaseControlPhase } from "./release-control-phases.mts";

/** Transport only, emitted after the fixed production-observer verifier.
 * Authentication comes from admitted same-workflow needs, not this JSON. */
export function prepareProductionProtectionHandoff(
  identity: unknown,
  observation: unknown,
  rawPhase: unknown = "admission",
) {
  const phase = inspectReleaseControlPhase(rawPhase);
  if (
    !isRecord(identity) ||
    identity.workflow !== productionControllerWorkflow ||
    identity.kind !== "oidc-job-identity-only" ||
    identity.repository_id !== 1354613114 ||
    typeof identity.expires_at !== "string" ||
    !Number.isFinite(Date.parse(identity.expires_at)) ||
    Date.now() >= Date.parse(identity.expires_at)
  )
    throw new Error("production protection producer identity differs or expired");
  return {
    schema_version: 1,
    phase,
    producer: {
      workflow: identity.workflow,
      controller_revision: identity.workflow_revision,
      controller_ref: identity.execution_ref,
      run_id: identity.run_id,
      run_attempt: identity.run_attempt,
      job_id: identity.job_id,
      check_run_id: identity.check_run_id,
    },
    observation: structuredClone(observation),
  };
}

const prefix = "repos/boburning/portcove";
const refs = ["portcove-release-inputs", "portcove-release-pause"] as const;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("incomplete protection response");
  return result;
}
function id(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("invalid protection identity");
}
/** GET-only collection. Its credential still has Administration WRITE because
 * that is GitHub's permission for complete ruleset/bypass visibility. Never
 * release that token to candidate/admission/assembly/classification/publication.
 * A digest match is a frozen observation, not an interpretation of enforcement.
 * Bootstrap protection and exact policy interpretation remain separate gates.
 */
export function observeReleaseInputProtections(
  api: GitHubRestReader,
  options: { releasePublication?: boolean } = {},
) {
  let requests = 0;
  const started = performance.now();
  const get = (suffix: string) => {
    if (++requests > 80 || performance.now() - started > 120_000)
      throw new Error("protection observation bound exhausted");
    const result = api.request("GET", `${prefix}${suffix}`);
    if (
      result.status !== 200 ||
      performance.now() - started > 120_000 ||
      Buffer.byteLength(JSON.stringify(result.body)) > 2 * 1024 * 1024
    )
      throw new Error("protection response unavailable, oversized or late");
    return result.body;
  };
  const identity = get("");
  if (
    !isRecord(identity) ||
    identity.id !== 1354613114 ||
    identity.full_name !== "boburning/portcove"
  )
    throw new Error("protection repository identity differs");
  const read = () => {
    const rulesets: Record<string, unknown>[] = [];
    let complete = false;
    for (let page = 1; page <= 8; page++) {
      const values = get(`/rulesets?includes_parents=true&per_page=100&page=${page}`);
      if (!Array.isArray(values) || values.length > 100)
        throw new Error("protection inventory is incomplete");
      for (const value of values) {
        if (!isRecord(value)) throw new Error("protection inventory item is malformed");
        id(value.id);
        // Organization/enterprise policies require their own authenticated detail
        // endpoint. Until that route is configured, never call coverage complete.
        if (value.source_type !== "Repository" || value.source !== "boburning/portcove")
          throw new Error("inherited protection detail requires separately scoped read access");
        const detail = get(`/rulesets/${value.id}?includes_parents=true`);
        if (
          !isRecord(detail) ||
          detail.id !== value.id ||
          detail.source_type !== value.source_type ||
          detail.source !== value.source ||
          !Array.isArray(detail.bypass_actors) ||
          !Array.isArray(detail.rules) ||
          !isRecord(detail.conditions) ||
          !["active", "disabled", "evaluate"].includes(String(detail.enforcement))
        )
          throw new Error("protection detail or bypass coverage unavailable");
        for (const actor of detail.bypass_actors) {
          if (
            !isRecord(actor) ||
            typeof actor.actor_type !== "string" ||
            !["always", "pull_request", "exempt"].includes(String(actor.bypass_mode))
          )
            throw new Error("protection bypass actor incomplete");
        }
        rulesets.push(detail);
      }
      if (values.length < 100) {
        complete = true;
        break;
      }
    }
    if (!complete || new Set(rulesets.map((rule) => rule.id)).size !== rulesets.length)
      throw new Error("protection inventory pages incomplete or duplicated");
    const branches = refs.map((branch) => {
      const ref = get(`/git/ref/heads/${branch}`);
      if (
        !isRecord(ref) ||
        ref.ref !== `refs/heads/${branch}` ||
        !isRecord(ref.object) ||
        ref.object.type !== "commit" ||
        typeof ref.object.sha !== "string" ||
        !/^[a-f0-9]{40}$/u.test(ref.object.sha)
      )
        throw new Error("protected input ref unavailable");
      const effective: unknown[] = [];
      let covered = false;
      for (let page = 1; page <= 8; page++) {
        const values = get(`/rules/branches/${branch}?per_page=100&page=${page}`);
        if (!Array.isArray(values) || values.length > 100)
          throw new Error("effective protection rules unavailable");
        for (const value of values as unknown[]) effective.push(value);
        if (values.length < 100) {
          covered = true;
          break;
        }
      }
      if (!covered) throw new Error("effective rules pagination incomplete");
      // Classic protection can add restrictions but cannot bypass a ruleset.
      // This assertion concerns exact writers/ref immutability in active rulesets;
      // it does not assert that a future operation will be available.
      return { branch, ref, effective_rules: effective };
    });
    const immutable = options.releasePublication ? get("/immutable-releases") : undefined;
    if (
      options.releasePublication &&
      (!isRecord(immutable) ||
        Object.keys(immutable).sort().join(",") !== "enabled,enforced_by_owner" ||
        typeof immutable.enabled !== "boolean" ||
        typeof immutable.enforced_by_owner !== "boolean")
    )
      throw new Error("provider release immutability setting unavailable");
    return {
      rulesets: rulesets.sort((a, b) => Number(a.id) - Number(b.id)),
      branches,
      ...(options.releasePublication ? { immutable_releases: immutable } : {}),
    };
  };
  const before = read();
  const after = read();
  if (canonical(before) !== canonical(after))
    throw new Error("protection or input refs changed during observation");
  return {
    schema_version: 1,
    repository_id: 1354613114,
    observed_at: new Date().toISOString(),
    api_requests: requests,
    inventory_sha256: createHash("sha256").update(canonical(after)).digest("hex"),
    inventory: after,
    coverage: options.releasePublication
      ? "current-repository-input-branches-and-release-immutability"
      : "current-repository-input-branches-only",
    enforcement: "uninterpreted",
    admission: "hold",
    authority: "none",
  };
}
/** Interpret only the selected narrow policy. Additional/unknown restrictions
 * may refuse availability; no fallback broadens the authorized writer. This
 * requires the isolated observer's result through trusted same-workflow needs,
 * never caller/dispatch JSON or a receipt from another run.
 */
export function requireReleaseInputWriterPolicy(
  raw: unknown,
  writerAppId: number,
  now = Date.now(),
) {
  if (
    !Number.isSafeInteger(writerAppId) ||
    writerAppId < 1 ||
    writerAppId === 15368 ||
    !isRecord(raw) ||
    raw.schema_version !== 1 ||
    raw.repository_id !== 1354613114 ||
    ![
      "current-repository-input-branches-only",
      "current-repository-input-branches-and-release-immutability",
    ].includes(String(raw.coverage)) ||
    typeof raw.observed_at !== "string" ||
    !Number.isFinite(Date.parse(raw.observed_at)) ||
    now - Date.parse(raw.observed_at) < 0 ||
    now - Date.parse(raw.observed_at) > 60_000 ||
    !isRecord(raw.inventory) ||
    !Array.isArray(raw.inventory.rulesets) ||
    !Array.isArray(raw.inventory.branches) ||
    raw.inventory_sha256 !== createHash("sha256").update(canonical(raw.inventory)).digest("hex")
  )
    throw new Error("fresh authenticated protection inventory unavailable");
  const rulesets = raw.inventory.rulesets;
  for (const branch of refs) {
    const rows = raw.inventory.branches.filter(
      (value) => isRecord(value) && value.branch === branch,
    );
    const row: unknown = rows[0];
    if (rows.length !== 1 || !isRecord(row) || !Array.isArray(row.effective_rules))
      throw new Error("protection branch coverage incomplete");
    const effective = row.effective_rules;
    const applicable = rulesets.filter((rule) => {
      if (
        !isRecord(rule) ||
        rule.enforcement !== "active" ||
        !isRecord(rule.conditions) ||
        !isRecord(rule.conditions.ref_name)
      )
        return false;
      const conditions = rule.conditions.ref_name;
      // Deliberately refuse unimplemented glob/exclusion semantics. The selected
      // proposal uses exact-ref rulesets; no glob evaluator or new trust system.
      return (
        Array.isArray(conditions.include) &&
        conditions.include.length === 1 &&
        conditions.include[0] === `refs/heads/${branch}` &&
        Array.isArray(conditions.exclude) &&
        conditions.exclude.length === 0
      );
    });
    const has = (type: string, writer: boolean) =>
      applicable.some((rule) => {
        if (
          !isRecord(rule) ||
          !Array.isArray(rule.rules) ||
          !Array.isArray(rule.bypass_actors) ||
          !effective.some(
            (value) => isRecord(value) && value.type === type && value.ruleset_id === rule.id,
          ) ||
          !rule.rules.some((value) => isRecord(value) && value.type === type)
        )
          return false;
        if (!writer) return rule.bypass_actors.length === 0;
        const actor: unknown = rule.bypass_actors[0];
        return (
          rule.bypass_actors.length === 1 &&
          isRecord(actor) &&
          actor.actor_type === (branch === "portcove-release-inputs" ? "Integration" : "User") &&
          actor.actor_id === (branch === "portcove-release-inputs" ? writerAppId : 43177418) &&
          actor.bypass_mode === "always"
        );
      });
    if (
      !has("update", true) ||
      !["creation", "deletion", "non_fast_forward"].every((type) => has(type, false))
    )
      throw new Error("exact writer or immutable ref protection is unproven");
  }
  return {
    observed_at: raw.observed_at,
    inventory_sha256: raw.inventory_sha256,
    authorization: "input-writer-policy-only",
  };
}

/** Interpret only an already authenticated isolated observer's fresh setting.
 * A publisher never receives the observer's Administration credential. */
export function requireReleaseImmutabilityPolicy(raw: unknown, now = Date.now()) {
  if (
    !isRecord(raw) ||
    raw.schema_version !== 1 ||
    raw.repository_id !== 1354613114 ||
    raw.coverage !== "current-repository-input-branches-and-release-immutability" ||
    typeof raw.observed_at !== "string" ||
    !Number.isFinite(Date.parse(raw.observed_at)) ||
    now - Date.parse(raw.observed_at) < 0 ||
    now - Date.parse(raw.observed_at) > 60_000 ||
    !isRecord(raw.inventory) ||
    !isRecord(raw.inventory.immutable_releases) ||
    Object.keys(raw.inventory.immutable_releases).sort().join(",") !==
      "enabled,enforced_by_owner" ||
    raw.inventory.immutable_releases.enabled !== true ||
    typeof raw.inventory.immutable_releases.enforced_by_owner !== "boolean" ||
    raw.inventory_sha256 !== createHash("sha256").update(canonical(raw.inventory)).digest("hex")
  )
    throw new Error("fresh authenticated provider release immutability is unproven");
  return {
    enabled: true as const,
    enforced_by_owner: raw.inventory.immutable_releases.enforced_by_owner,
    observed_at: raw.observed_at,
    inventory_sha256: raw.inventory_sha256,
    authorization: "provider-release-immutability-setting-only",
  };
}
