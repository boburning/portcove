import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { coordinatorCommandDeadline } from "./release-coordinator-deadline.mts";
import { isRecord } from "./runtime-values.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import {
  inspectReleaseControlPhase,
  releaseControlPhaseProfile,
} from "./release-control-phases.mts";
import { requireFixedClassificationPrincipal } from "./release-classification-principal.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-namespace.mts";
import type { GitHubRequestPolicy } from "./github-client.mts";

type StorageJournalPolicy = { namespace: string; writer_app_id: number };
type ProtectionReader = (
  endpoint: string,
  deadline: number,
) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;
type ProtectionObservationOptions = {
  releasePublication?: boolean;
  applicationCoordinator?: true;
  journalNamespace?: string | undefined;
  onRefusal?: (evidence: {
    snapshot: number;
    stage: string;
    api_requests: number;
    elapsed_ms: number;
  }) => void;
};

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
/** Derive the catalog-only environment boundary from the existing phase owner. */
export const catalogProtectionEnvironments = Object.freeze(
  [
    ...new Set(
      [
        "coordinator",
        "catalog-definitions",
        "catalog-policy",
        "catalog-snapshot",
        "catalog-timestamp",
        "site-publication",
      ].flatMap((phase) => {
        const profile = releaseControlPhaseProfile(inspectReleaseControlPhase(phase));
        return [profile.reader_environment, profile.observer_environment].map((name) => {
          if (typeof name !== "string" || !name)
            throw new Error("catalog environment profile unavailable");
          return name;
        });
      }),
    ),
  ].sort(),
);
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
/** Fixed protection reads share the observer's existing credential and deadline. */
export async function createProtectionObservationReader(options: {
  token: string;
  deadline: number;
  maxBytes: number;
  requestTimeoutMs?: number;
  guard: () => void;
}): Promise<ProtectionReader> {
  const { token, maxBytes, requestTimeoutMs, guard } = options;
  const deadline = Math.min(options.deadline, coordinatorCommandDeadline() ?? Infinity);
  const expected = new AsyncLocalStorage<string>();
  const { createGitHubClient } = await import("./github-client.mts");
  const client = await createGitHubClient({
    credential: { kind: "explicit", token },
    deadline,
    maxBytes,
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    allowRequest(method, url) {
      if (method !== "GET" || url.href !== expected.getStore()) return false;
      guard();
      return true;
    },
  });
  return async (endpoint, observationDeadline) => {
    if (!/^repos\/boburning\/portcove(?:\/|$)/u.test(endpoint))
      throw new Error("fixed protection reader refused an unscoped route");
    return expected.run(`https://api.github.com/${endpoint}`, async () => {
      const policy: GitHubRequestPolicy = {
        replay: "once",
        attempts: 0,
        deadline: observationDeadline,
      };
      try {
        const response = await client.request(`GET /${endpoint}`, {
          request: { portcove: policy },
        });
        guard();
        return { status: response.status, body: response.data as unknown };
      } finally {
        await policy.admissionSettled;
      }
    });
  };
}

/** Route only the two fixed application refs through the existing Contents reader. */
export async function createApplicationProtectionObservationReader(
  options: Parameters<typeof createProtectionObservationReader>[0] & { refToken: string },
): Promise<ProtectionReader> {
  const { refToken, ...scope } = options;
  const [protection, ref] = await Promise.all([
    createProtectionObservationReader(scope),
    createProtectionObservationReader({ ...scope, token: refToken }),
  ]);
  return (endpoint, deadline) =>
    (refs.some((branch) => endpoint === `${prefix}/git/ref/heads/${branch}`) ? ref : protection)(
      endpoint,
      deadline,
    );
}

/** GET-only collection. Its credential still has Administration WRITE because
 * that is GitHub's permission for complete ruleset/bypass visibility. Never
 * release that token to candidate/admission/assembly/classification/publication.
 * A digest match is a frozen observation, not an interpretation of enforcement.
 * Bootstrap protection and exact policy interpretation remain separate gates.
 */
export function observeReleaseInputProtections(
  request: ProtectionReader,
  options: ProtectionObservationOptions = {},
) {
  return observeProtections(request, options, "application");
}
export function observeCatalogMaintenanceProtections(
  request: ProtectionReader,
  options: ProtectionObservationOptions = {},
) {
  return observeProtections(request, options, "catalog-publication");
}
async function observeProtections(
  request: ProtectionReader,
  options: ProtectionObservationOptions,
  purpose: "application" | "catalog-publication",
) {
  const { journalNamespace, releasePublication } = options;
  const journalBranch =
    journalNamespace === undefined
      ? undefined
      : `${inspectCoordinatorRemoteNamespace({ schema_version: 1, namespace: journalNamespace })}-coordinator-state`;
  const selectedBranches = [
    ...(purpose === "catalog-publication" ? ["portcove-release-pause"] : refs),
    ...(journalBranch === undefined ? [] : [journalBranch]),
  ];
  let requests = 0;
  let snapshot = 0;
  let stage = "repository-identity";
  const started = performance.now();
  // Both purposes read the complete retained ruleset inventory twice.
  const requestLimit = 224;
  const deadline = started + 120_000;
  const get = async (suffix: string) => {
    if (requests >= requestLimit || performance.now() >= deadline)
      throw new Error("protection observation bound exhausted");
    requests++;
    const result = await request(`${prefix}${suffix}`, deadline);
    if (
      result.status !== 200 ||
      performance.now() >= deadline ||
      Buffer.byteLength(JSON.stringify(result.body)) > 2 * 1024 * 1024
    )
      throw new Error("protection response unavailable, oversized or late");
    return structuredClone(result.body);
  };
  const read = async () => {
    const rulesets: Record<string, unknown>[] = [];
    const seen = new Set<number>();
    // The fixed application coordinator shares its original phase deadline
    // with multiple complete observations. Keep both snapshots, but allow
    // eight in-flight detail reads there while retaining the other profiles.
    const detailBatch = purpose === "application" && options.applicationCoordinator ? 8 : 4;
    let complete = false;
    for (let page = 1; page <= 8; page++) {
      stage = "ruleset-inventory";
      const values = await get(`/rulesets?includes_parents=true&per_page=100&page=${page}`);
      if (!Array.isArray(values) || values.length > 100)
        throw new Error("protection inventory is incomplete");
      const inventory = values.map((value: unknown) => {
        if (!isRecord(value)) throw new Error("protection inventory item is malformed");
        id(value.id);
        // Organization/enterprise policies require their own authenticated detail
        // endpoint. Until that route is configured, never call coverage complete.
        if (value.source_type !== "Repository" || value.source !== "boburning/portcove")
          throw new Error("inherited protection detail requires separately scoped read access");
        if (seen.has(value.id))
          throw new Error("protection inventory pages incomplete or duplicated");
        seen.add(value.id);
        return { id: value.id, source_type: value.source_type, source: value.source };
      });
      stage = "ruleset-details";
      for (let start = 0; start < inventory.length; start += detailBatch) {
        const batch = await Promise.allSettled(
          inventory.slice(start, start + detailBatch).map(async (value) => {
            const detail = await get(`/rulesets/${value.id}?includes_parents=true`);
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
            return detail;
          }),
        );
        for (const result of batch) {
          if (result.status === "rejected") throw result.reason;
          rulesets.push(result.value);
        }
      }
      if (values.length < 100) {
        complete = true;
        break;
      }
    }
    if (!complete) throw new Error("protection inventory pages incomplete or duplicated");
    stage = "protected-branches";
    const branches = [];
    for (const branch of selectedBranches) {
      const ref = await get(`/git/ref/heads/${branch}`);
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
        const values = await get(`/rules/branches/${branch}?per_page=100&page=${page}`);
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
      branches.push({ branch, ref, effective_rules: effective });
    }
    let environments:
      | {
          name: string;
          environment: Record<string, unknown>;
          policies: Record<string, unknown>[];
        }[]
      | undefined;
    if (purpose === "catalog-publication") {
      stage = "catalog-environments";
      environments = [];
      for (const name of catalogProtectionEnvironments) {
        const environment = await get(`/environments/${encodeURIComponent(name)}`);
        if (!isRecord(environment) || environment.name !== name) {
          throw new Error("catalog environment identity unavailable");
        }
        id(environment.id);
        const policies: Record<string, unknown>[] = [];
        let total: number | undefined;
        let complete = false;
        for (let page = 1; page <= 8; page++) {
          const response = await get(
            `/environments/${encodeURIComponent(name)}/deployment-branch-policies?per_page=100&page=${page}`,
          );
          if (
            !isRecord(response) ||
            !Number.isSafeInteger(response.total_count) ||
            Number(response.total_count) < 0 ||
            Number(response.total_count) > 800 ||
            !Array.isArray(response.branch_policies) ||
            response.branch_policies.length > 100 ||
            (total !== undefined && total !== response.total_count)
          ) {
            throw new Error("catalog deployment policy pagination unavailable or changed");
          }
          total = Number(response.total_count);
          for (const policy of response.branch_policies) {
            if (
              !isRecord(policy) ||
              typeof policy.name !== "string" ||
              !["branch", "tag"].includes(String(policy.type))
            ) {
              throw new Error("catalog deployment policy identity incomplete");
            }
            id(policy.id);
            policies.push(policy);
          }
          if (response.branch_policies.length < 100) {
            complete = policies.length === total;
            break;
          }
        }
        if (!complete || new Set(policies.map((policy) => policy.id)).size !== policies.length) {
          throw new Error("catalog deployment policy inventory incomplete or duplicated");
        }
        environments.push({
          name,
          environment,
          policies: policies.sort((a, b) => Number(a.id) - Number(b.id)),
        });
      }
    }
    if (
      environments &&
      new Set(environments.map((row) => row.environment.id)).size !== environments.length
    ) {
      throw new Error("catalog environment identities duplicated");
    }
    stage = "release-immutability";
    const immutable = releasePublication ? await get("/immutable-releases") : undefined;
    if (
      releasePublication &&
      (!isRecord(immutable) ||
        Object.keys(immutable).sort().join(",") !== "enabled,enforced_by_owner" ||
        typeof immutable.enabled !== "boolean" ||
        typeof immutable.enforced_by_owner !== "boolean")
    )
      throw new Error("provider release immutability setting unavailable");
    return {
      rulesets: rulesets.sort((a, b) => Number(a.id) - Number(b.id)),
      branches,
      ...(environments ? { environments } : {}),
      ...(releasePublication ? { immutable_releases: immutable } : {}),
    };
  };
  try {
    const identity = await get("");
    if (
      !isRecord(identity) ||
      identity.id !== 1354613114 ||
      identity.full_name !== "boburning/portcove"
    )
      throw new Error("protection repository identity differs");
    snapshot = 1;
    const before = await read();
    snapshot = 2;
    const after = await read();
    stage = "snapshot-comparison";
    if (canonical(before) !== canonical(after))
      throw new Error("protection or input refs changed during observation");
    return {
      schema_version: 1,
      repository_id: 1354613114,
      observed_at: new Date().toISOString(),
      api_requests: requests,
      inventory_sha256: createHash("sha256").update(canonical(after)).digest("hex"),
      inventory: after,
      coverage:
        purpose === "catalog-publication"
          ? "current-repository-catalog-maintenance-only"
          : releasePublication
            ? "current-repository-input-branches-and-release-immutability"
            : "current-repository-input-branches-only",
      enforcement: "uninterpreted",
      admission: "hold",
      authority: "none",
    };
  } catch (error) {
    options.onRefusal?.({
      snapshot,
      stage,
      api_requests: requests,
      elapsed_ms: Math.floor(performance.now() - started),
    });
    throw error;
  }
}
export const inputProtectionFreshnessMilliseconds = 60_000;

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
  return requireInputPolicy(raw, writerAppId, now, "application");
}
export function requireCatalogMaintenancePolicy(
  raw: unknown,
  controllerRef: string,
  now = Date.now(),
  journal?: StorageJournalPolicy,
) {
  const policy = requireInputPolicy(raw, 43177418, now, "catalog-publication", false, journal);
  // The caller supplies its already authenticated original controller ref, not
  // a tag selected by the observation or a candidate/dispatch body.
  if (
    typeof controllerRef !== "string" ||
    !/^refs\/tags\/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(
      controllerRef,
    ) ||
    !isRecord(raw) ||
    !isRecord(raw.inventory) ||
    !Array.isArray(raw.inventory.environments) ||
    raw.inventory.environments.length !== catalogProtectionEnvironments.length
  ) {
    throw new Error("catalog environment protection inventory unavailable");
  }
  const tag = controllerRef.slice("refs/tags/".length);
  // Shared environments can retain other exact appointments. They must remain
  // immutable so a disjoint selector cannot admit newly substituted source.
  const immutableTags = new Set<string>();
  const rulesets: unknown = raw.inventory.rulesets;
  if (!Array.isArray(rulesets)) throw new Error("catalog tag protection inventory unavailable");
  for (const rule of rulesets as unknown[]) {
    if (
      !isRecord(rule) ||
      rule.target !== "tag" ||
      rule.enforcement !== "active" ||
      !Array.isArray(rule.bypass_actors) ||
      rule.bypass_actors.length !== 0 ||
      !Array.isArray(rule.rules) ||
      !isRecord(rule.conditions) ||
      !isRecord(rule.conditions.ref_name)
    )
      continue;
    const { include, exclude } = rule.conditions.ref_name;
    const rules: unknown[] = rule.rules;
    if (
      Array.isArray(include) &&
      include.length === 1 &&
      typeof include[0] === "string" &&
      Array.isArray(exclude) &&
      exclude.length === 0 &&
      ["creation", "update", "deletion"].every((type) =>
        rules.some((entry) => isRecord(entry) && entry.type === type),
      )
    )
      immutableTags.add(include[0]);
  }
  const identities = new Set<number>();
  for (const [index, name] of catalogProtectionEnvironments.entries()) {
    const row: unknown = raw.inventory.environments[index];
    if (
      !isRecord(row) ||
      row.name !== name ||
      !isRecord(row.environment) ||
      row.environment.name !== name ||
      !Array.isArray(row.policies)
    ) {
      throw new Error("catalog environment protection coverage differs");
    }
    const environment = row.environment;
    id(environment.id);
    if (identities.has(environment.id)) throw new Error("catalog environment identity duplicated");
    identities.add(environment.id);
    if (
      environment.can_admins_bypass !== false ||
      !isRecord(environment.deployment_branch_policy) ||
      environment.deployment_branch_policy.protected_branches !== false ||
      environment.deployment_branch_policy.custom_branch_policies !== true ||
      !Array.isArray(environment.protection_rules) ||
      environment.protection_rules.length !== 1 ||
      !isRecord(environment.protection_rules[0]) ||
      environment.protection_rules[0].type !== "branch_policy"
    ) {
      throw new Error(
        "catalog environment bypass, manual approval or deployment restriction differs",
      );
    }
    id(environment.protection_rules[0].id);
    const names = new Set<string>();
    const selectorIds = new Set<number>();
    for (const selector of row.policies as unknown[]) {
      if (
        !isRecord(selector) ||
        selector.type !== "tag" ||
        typeof selector.name !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(selector.name) ||
        names.has(selector.name)
      ) {
        throw new Error("catalog environment requires distinct exact tag selectors");
      }
      id(selector.id);
      if (selectorIds.has(selector.id))
        throw new Error("catalog environment selector identity duplicated");
      names.add(selector.name);
      selectorIds.add(selector.id);
      if (selector.name !== tag) {
        const retained =
          selector.name === "portcove-production-controller-catalog-20261028r2" ||
          (selector.name === "portcove-production-controller-windows-20261105r10" &&
            [
              "github-pages",
              "production-release-coordinator",
              "production-release-protection-observer",
            ].includes(name)) ||
          ([
            "portcove-production-controller-windows-20261105r30",
            "portcove-production-controller-windows-20261108r55",
            "portcove-production-controller-windows-20261109r56",
            "portcove-production-controller-windows-20261109r57",
            "portcove-production-controller-windows-20261109r58",
          ].includes(selector.name) &&
            (name === "github-pages" || name === "production-release-protection-observer")) ||
          (selector.name === "portcove-upstream-rehearsal-20261104r3" && name === "github-pages");
        if (!retained)
          throw new Error("catalog environment additional tag is outside retained appointments");
        if (!immutableTags.has(`refs/tags/${selector.name}`))
          throw new Error("catalog environment additional tag lacks exact immutable protection");
      }
    }
    if (!names.has(tag))
      throw new Error("catalog environment requires the authenticated exact controller tag");
  }
  return {
    ...policy,
    execution_ref: controllerRef,
    environment_policy_sha256: createHash("sha256")
      .update(canonical(raw.inventory.environments))
      .digest("hex"),
  };
}
/** Actions is a storage principal, not semantic review authority. Only an
 * actual retained selected source/job join may interpret this named policy. */
export function requireFixedClassificationStoragePolicy(
  raw: unknown,
  principal: unknown,
  now = Date.now(),
) {
  const saved = requireFixedClassificationPrincipal(principal, now);
  const app = saved.storage_writer;
  return {
    ...requireInputPolicy(
      raw,
      app?.app_id ?? 15368,
      now,
      "application",
      true,
      app === null
        ? undefined
        : { namespace: saved.producer.writer.namespace, writer_app_id: app.app_id },
    ),
    authorization: "fixed-job-input-storage-policy-only",
    provider_writer:
      app === null
        ? "github-actions-integration-not-workflow-specific"
        : "dedicated-storage-app-not-workflow-specific",
    semantic_authority: "none",
  };
}
function requireInputPolicy(
  raw: unknown,
  writerAppId: number,
  now: number,
  purpose: "application" | "catalog-publication",
  selected = false,
  journal?: StorageJournalPolicy,
) {
  const journalBranch =
    journal === undefined
      ? undefined
      : `${inspectCoordinatorRemoteNamespace({ schema_version: 1, namespace: journal.namespace })}-coordinator-state`;
  if (
    journal &&
    (!Number.isSafeInteger(journal.writer_app_id) ||
      journal.writer_app_id < 1 ||
      journal.writer_app_id === 15368)
  )
    throw new Error("dedicated journal writer identity required");
  if (
    !Number.isSafeInteger(writerAppId) ||
    writerAppId < 1 ||
    (writerAppId === 15368 && !selected) ||
    !isRecord(raw) ||
    raw.schema_version !== 1 ||
    raw.repository_id !== 1354613114 ||
    !(
      purpose === "catalog-publication"
        ? ["current-repository-catalog-maintenance-only"]
        : [
            "current-repository-input-branches-only",
            "current-repository-input-branches-and-release-immutability",
          ]
    ).includes(String(raw.coverage)) ||
    typeof raw.observed_at !== "string" ||
    !Number.isFinite(Date.parse(raw.observed_at)) ||
    now - Date.parse(raw.observed_at) < 0 ||
    now - Date.parse(raw.observed_at) > inputProtectionFreshnessMilliseconds ||
    !isRecord(raw.inventory) ||
    !Array.isArray(raw.inventory.rulesets) ||
    !Array.isArray(raw.inventory.branches) ||
    raw.inventory_sha256 !== createHash("sha256").update(canonical(raw.inventory)).digest("hex")
  )
    throw new Error("fresh authenticated protection inventory unavailable");
  const rulesets = raw.inventory.rulesets;
  for (const branch of [
    ...(purpose === "catalog-publication" ? ["portcove-release-pause"] : refs),
    ...(journalBranch === undefined ? [] : [journalBranch]),
  ]) {
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
          actor.actor_type === (branch === "portcove-release-pause" ? "User" : "Integration") &&
          actor.actor_id ===
            (branch === journalBranch
              ? journal!.writer_app_id
              : branch === "portcove-release-inputs"
                ? writerAppId
                : 43177418) &&
          actor.bypass_mode === "always"
        );
      });
    if (
      !has("update", true) ||
      !["creation", "deletion", "non_fast_forward"].every((type) => has(type, false))
    )
      throw new Error("exact writer or immutable ref protection is unproven");
  }
  const policyBranches = raw.inventory.branches.map((entry: unknown) => {
    const row = structuredClone(entry);
    if (journalBranch !== undefined && isRecord(row) && row.branch === journalBranch) {
      if (
        !isRecord(row.ref) ||
        row.ref.ref !== `refs/heads/${journalBranch}` ||
        !isRecord(row.ref.object) ||
        row.ref.object.type !== "commit" ||
        typeof row.ref.object.sha !== "string" ||
        !/^[a-f0-9]{40}$/u.test(row.ref.object.sha)
      )
        throw new Error("observed journal ref identity unavailable");
      // The original complete inventory digest is retained separately. Journal
      // head progression is authenticated by the owned checkpoint protocol;
      // it is not a change to writer/retention policy between fresh rounds.
      if (row.ref.object.url !== undefined) {
        if (
          row.ref.object.url !==
          `https://api.github.com/repos/boburning/portcove/git/commits/${row.ref.object.sha}`
        )
          throw new Error("observed journal commit URL differs from its exact identity");
        delete row.ref.object.url;
      }
      delete row.ref.object.sha;
    }
    return row;
  });
  return {
    observed_at: raw.observed_at,
    inventory_sha256: raw.inventory_sha256,
    ...(journalBranch === undefined
      ? {}
      : {
          journal_policy_sha256: createHash("sha256")
            .update(canonical({ ...raw.inventory, branches: policyBranches }))
            .digest("hex"),
        }),
    authorization: "input-writer-policy-only",
  };
}

/** Interpret only an already authenticated isolated observer's fresh setting.
 * A publisher never receives the observer's Administration credential. */
export function requireReleaseImmutabilityPolicy(raw: unknown, now = Date.now()) {
  return requireObservedImmutabilityPolicy(raw, now, inputProtectionFreshnessMilliseconds);
}

function requireObservedImmutabilityPolicy(raw: unknown, now: number, maximumAge: number) {
  if (
    !isRecord(raw) ||
    raw.schema_version !== 1 ||
    raw.repository_id !== 1354613114 ||
    raw.coverage !== "current-repository-input-branches-and-release-immutability" ||
    typeof raw.observed_at !== "string" ||
    !Number.isFinite(Date.parse(raw.observed_at)) ||
    now - Date.parse(raw.observed_at) < 0 ||
    now - Date.parse(raw.observed_at) > maximumAge ||
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

export function requireApplicationReleaseProtectionDigest(
  raw: unknown,
  bootstrap: boolean,
  now = Date.now(),
  handoff: "standard" | "hosted-write" | "application-payload" = "standard",
) {
  // Hosted writes include environment admission, artifact upload, and attested tool setup.
  // Payload signing also transfers and verifies the unsigned package and native evidence.
  if (handoff !== "standard" && bootstrap) throw new Error("bootstrap protection handoff differs");
  const maximumAge =
    handoff === "application-payload"
      ? 240_000
      : handoff === "hosted-write"
        ? 150_000
        : inputProtectionFreshnessMilliseconds;
  const policy = requireObservedImmutabilityPolicy(raw, now, maximumAge);
  if (!bootstrap) return policy.inventory_sha256;
  return protectionFingerprint(bootstrapProtectionInventory(raw));
}

function protectionFingerprint(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function canonicalRulesetTimestamp(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(
      value,
    )
  )
    throw new Error("bootstrap ruleset timestamp is malformed");
  const wallTime = value.slice(0, 19);
  const asUtc = new Date(`${wallTime}Z`);
  if (!Number.isFinite(asUtc.getTime()) || asUtc.toISOString().slice(0, 19) !== wallTime)
    throw new Error("bootstrap ruleset timestamp is malformed");
  return new Date(value).toISOString();
}

function bootstrapProtectionInventory(raw: unknown) {
  if (
    !isRecord(raw) ||
    !isRecord(raw.inventory) ||
    !Array.isArray(raw.inventory.rulesets) ||
    !Array.isArray(raw.inventory.branches)
  )
    throw new Error("bootstrap protection inventory is incomplete");
  const rulesets = raw.inventory.rulesets.map((ruleset: unknown) => {
    if (!isRecord(ruleset)) throw new Error("bootstrap ruleset detail is malformed");
    // GitHub reports this field for the authenticated viewer. Configured bypass
    // actors, rules and the exact observed refs remain in the appointment digest.
    const detail = { ...ruleset };
    delete detail.current_user_can_bypass;
    // GitHub renders these same instants with different offsets for the owner
    // and the App. Bind the instants in UTC without dropping their precision.
    for (const field of ["created_at", "updated_at"])
      if (Object.hasOwn(detail, field)) detail[field] = canonicalRulesetTimestamp(detail[field]);
    return detail;
  });
  return { ...raw.inventory, rulesets, branches: raw.inventory.branches };
}

/** Digests only. These distinguish provider projections without exposing the
 * inventory or changing the appointed protection equality. */
export function bootstrapProtectionFingerprints(raw: unknown) {
  const { rulesets, branches, ...settings } = bootstrapProtectionInventory(raw);
  return {
    rulesets: protectionFingerprint(rulesets),
    ruleset_count: rulesets.length,
    refs: protectionFingerprint(branches.map((row: unknown) => isRecord(row) && row.ref)),
    effective: protectionFingerprint(
      branches.map((row: unknown) => isRecord(row) && row.effective_rules),
    ),
    settings: protectionFingerprint(settings),
  };
}

/** Fixed diagnostic field names. Preserve absent versus present and rule order. */
export function bootstrapProtectionRulesetFieldFingerprints(raw: unknown) {
  const { rulesets } = bootstrapProtectionInventory(raw);
  const fields = [
    "_links",
    "bypass_actors",
    "conditions",
    "created_at",
    "enforcement",
    "id",
    "name",
    "node_id",
    "rules",
    "source",
    "source_type",
    "target",
    "updated_at",
  ];
  const known = new Set(fields);
  return {
    fields: Object.fromEntries(
      fields.map((field) => [
        field,
        protectionFingerprint(
          rulesets.map((row) => (Object.hasOwn(row, field) ? [row[field]] : [])),
        ),
      ]),
    ),
    other: protectionFingerprint(
      rulesets.map((row) =>
        Object.fromEntries(Object.entries(row).filter(([key]) => !known.has(key))),
      ),
    ),
  };
}
