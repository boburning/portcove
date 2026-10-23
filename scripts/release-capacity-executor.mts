import { inspectReleaseEffectExpectation } from "./release-effect-contract.mts";
import { inspectAggregateUploadExpectation } from "./release-aggregate-contract.mts";
import {
  inspectCatalogPublicationDescriptor,
  inspectCatalogSitePublicationExpectation,
  assertCatalogSitePublicationBinding,
} from "./release-catalog-publication-contract.mts";
import { performance } from "node:perf_hooks";
import {
  inspectAssemblerIdentityExpectation,
  requestAssemblerToken,
  verifyCapacityExecutorJobIdentity,
} from "./assembler-job-identity.mts";
import type { CapacityExecutorRole } from "./assembler-job-identity.mts";
import {
  capacityDigest,
  inspectCapacityExecutorIdentity,
  inspectSitePublicationExpectation,
  inspectCapacityOperation,
} from "./release-capacity.mts";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import { publishCoordinatorCheckpoint } from "./release-coordinator-remote.mts";
import {
  recoverReleaseOpportunity,
  exportCoordinatorCheckpoint,
} from "./release-coordinator-state.mts";
import {
  recordCapacityReadback,
  runBoundedCapacityOperation,
  runBoundedMetadataRenewalOperation,
  runBoundedMetadataBootstrapOperation,
  runBoundedCatalogPublicationOperation,
  recordPublishedApplicationSiteMetadata,
  recordPublishedCatalogMetadata,
} from "./release-capacity-operation.mts";
import {
  inspectPublishedMetadata,
  inspectMetadataRenewalDescriptor,
  inspectMetadataBootstrapDescriptor,
} from "./release-metadata-contract.mts";
import { isRecord } from "./runtime-values.mts";
import {
  createCoordinatorJournalApi,
  createCheckpointJobTokenApi,
  createCheckpointHistoryReader,
} from "./release-coordinator-journal-api.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import { inspectControllerExecutionPurpose } from "./release-control-phases.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-namespace.mts";
import { withReadOnlyReleaseChildren } from "./release-readonly-child-environment.mts";
import type { CapacityBoundaryReader } from "./release-capacity-operation.mts";
import type { CapacityOperationOptions } from "./release-capacity-operation.mts";
import {
  inspectPublishedCatalogMetadata,
  inspectPublishedSite,
} from "./release-catalog-metadata-contract.mts";

export interface CapacityExecutorIdentity {
  controller_revision: string;
  execution_ref: string;
  workflow: string;
  run_id: string;
  run_attempt: number;
  job_id: number;
  check_run_id: string;
  actor_id: string;
  role: CapacityExecutorRole;
}
interface ExecutorSession {
  readonly kind: "authenticated-capacity-executor";
}
interface PrivateSession {
  role: CapacityExecutorRole;
  expected: ReturnType<typeof inspectAssemblerIdentityExpectation>;
  directory: string;
  identity: CapacityExecutorIdentity;
  observed: number;
  deadline?: number;
  requiresSignedJournal: boolean;
  journalBinding?: "binding" | "bound" | "stopped";
  journal?: {
    configuration: Awaited<
      ReturnType<
        typeof import("./release-authority-configuration.mts").requireControllerFixedJobJournalAuthorities
      >
    >;
    checkpoint: string;
    busy: boolean;
    stopped: boolean;
  };
}
/** Refusal-only discriminator, never source admission or authority. Freeze a
 * selected-profile requirement before authentication awaits, so removing its
 * live record cannot enable a lingering legacy App credential. The actual
 * selected getter/history/OIDC checks still establish the usable binding. */
function selectedJournalRequired() {
  const environment = { ...process.env };
  const purpose = inspectControllerExecutionPurpose(environment.PORTCOVE_EXECUTION_PURPOSE);
  const raw =
    purpose === "application"
      ? environment.PORTCOVE_RELEASE_AUTHORITIES
      : environment.PORTCOVE_CATALOG_AUTHORITIES;
  if (raw === undefined) return false;
  if (Buffer.byteLength(raw) > 32768)
    throw new Error("protected journal configuration exceeds bounds");
  const record: unknown = JSON.parse(raw);
  if (!isRecord(record)) throw new Error("protected journal configuration schema differs");
  if (record.schema_version === 3 || record.kind === "two-app-fixed-jobs-v1") return true;
  if (
    purpose === "application" &&
    (record.schema_version === 1 || record.schema_version === 2) &&
    !Object.hasOwn(record, "kind")
  )
    return false;
  if (
    purpose === "catalog-publication" &&
    record.schema_version === 1 &&
    record.kind === "catalog-publication-authorities"
  )
    return false;
  throw new Error("protected journal configuration schema differs");
}
const sessions = new WeakMap<ExecutorSession, PrivateSession>();
const audience = "portcove-capacity-executor";
const effectStates = new WeakMap<ExecutorSession, { busy: boolean; failed: boolean }>();
interface OwnedPendingBoundary {
  readonly kind: "owned-capacity-pending-boundary";
}
const pendingBoundaries = new WeakMap<
  object,
  {
    session: ExecutorSession;
    checkpoint: string;
    operation: NonNullable<ReturnType<typeof inspectCapacityOperation>>;
  }
>();
/** Usable only during this actual executor's awaited pre-effect boundary. An
 * imported record or a receipt retained beyond that callback cannot enter. */
export function requireOwnedCapacityPendingBoundary(session: ExecutorSession, receipt: object) {
  const executor = sessions.get(session),
    pending = pendingBoundaries.get(receipt);
  if (!executor || !pending || pending.session !== session || !effectStates.get(session)?.busy)
    throw new Error("actual current executor pending boundary custody required");
  if (executor.deadline !== undefined && performance.now() >= executor.deadline)
    throw new Error("executor pending boundary original deadline exhausted");
  return structuredClone({ checkpoint: pending.checkpoint, operation: pending.operation });
}

async function observe(
  role: CapacityExecutorRole,
  expected: ReturnType<typeof inspectAssemblerIdentityExpectation>,
  directory: string,
  deadline?: number,
): Promise<CapacityExecutorIdentity> {
  if (expected.audience !== audience)
    throw new Error("capacity executor audience differs from its fixed role");
  const token = await requestAssemblerToken(audience, process.env, fetch, deadline);
  const actual = await verifyCapacityExecutorJobIdentity(role, token, expected, {
    transport: { cwd: directory, ...(deadline === undefined ? {} : { deadline }) },
  });
  if (actual.evidence_scope !== "github.com")
    throw new Error("capacity executor requires actual provider identity");
  return {
    controller_revision: actual.workflow_revision,
    execution_ref: actual.execution_ref,
    workflow: actual.workflow,
    run_id: actual.run_id,
    run_attempt: actual.run_attempt,
    job_id: actual.job_id,
    check_run_id: actual.check_run_id,
    actor_id: actual.actor_id,
    role: actual.role,
  };
}

/** Direct current-job authentication. No imported report, token, test transport
 * or caller-supplied identity can create a session. This does not prove fresh
 * admission/protections or grant permission to execute a provider effect. */
export async function authenticateCapacityExecutor(
  role: CapacityExecutorRole,
  rawExpected: unknown,
  directory: string,
  deadline?: number,
): Promise<ExecutorSession> {
  const requiresSignedJournal = selectedJournalRequired();
  const expected = inspectAssemblerIdentityExpectation(structuredClone(rawExpected));
  const identity = await observe(role, expected, directory, deadline);
  const session: ExecutorSession = Object.freeze({ kind: "authenticated-capacity-executor" });
  sessions.set(session, {
    role,
    expected,
    directory,
    identity,
    observed: performance.now(),
    requiresSignedJournal,
    ...(deadline === undefined ? {} : { deadline }),
  });
  return session;
}

export function capacityExecutorIdentity(session: ExecutorSession): CapacityExecutorIdentity {
  const value = sessions.get(session);
  if (
    !value ||
    performance.now() - value.observed > 60_000 ||
    (value.deadline !== undefined && performance.now() >= value.deadline)
  )
    throw new Error("actual fresh executor session unavailable");
  return structuredClone(value.identity);
}

/** Reauthenticate the same exact job before effect/readback; a completed,
 * changed or replaced job cannot inherit the public nonce or checkpoint. */
export async function refreshCapacityExecutor(session: ExecutorSession) {
  const value = sessions.get(session);
  if (!value) throw new Error("imported executor sessions cannot execute or recover");
  const actual = await observe(value.role, value.expected, value.directory, value.deadline);
  if (capacityDigest(actual) !== capacityDigest(value.identity))
    throw new Error("capacity executor identity changed during the attempt");
  value.observed = performance.now();
  return structuredClone(value.identity);
}

/** Prepared transport join, not profile activation or a publication grant.
 * Imported identities cannot select a job credential. The owning selected
 * controller must still authenticate setup/history/current controls and feed
 * this API only to the existing signing exchange, never the legacy publisher. */
export async function createOwnedCheckpointSigningApi(
  session: ExecutorSession,
  repository: string,
  expected: string,
  configuration: unknown,
) {
  const value = sessions.get(session);
  if (!value || value.deadline === undefined)
    throw new Error("actual executor with original bounded deadline required for job journal");
  capacityExecutorIdentity(session);
  const remaining = value.deadline - performance.now();
  if (remaining <= 0 || remaining > 120000)
    throw new Error("job journal requires the original bounded executor phase");
  const frozenConfiguration = structuredClone(configuration);
  inspectCoordinatorRemoteNamespace(frozenConfiguration);
  await refreshCapacityExecutor(session);
  const checkpoint = await withCoordinatorDeadline(value.deadline, () =>
    exportCoordinatorCheckpoint(repository, expected),
  );
  capacityExecutorIdentity(session);
  return createCheckpointJobTokenApi(
    value.directory,
    checkpoint,
    frozenConfiguration,
    value.deadline,
  );
}

/** First join for the selected profile. This reads actual protected source
 * configuration and the fixed historical verifier; it accepts no supplied
 * source, API, credential, accepted report or setup appointment. No effect or
 * legacy fallback occurs. The owning publisher still must refresh controls and
 * use the existing signer/verifier exchange before any authoritative advance. */
export async function authenticateOwnedCheckpointJournalHistory(
  session: ExecutorSession,
  repository: string,
  expected: string,
) {
  const value = sessions.get(session);
  if (!value || value.deadline === undefined)
    throw new Error("actual bounded executor session required for selected journal history");
  if (value.journalBinding !== undefined)
    throw new Error(
      "journal history is already binding/bound or stopped; explicit recovery required",
    );
  value.journalBinding = "binding";
  try {
    const result = await withCoordinatorDeadline(value.deadline, () =>
      withReadOnlyReleaseChildren(value.directory, () =>
        authenticateOwnedCheckpointJournalHistoryWithinScope(session, repository, expected),
      ),
    );
    value.journalBinding = "bound";
    return result;
  } catch (error) {
    value.journalBinding = "stopped";
    throw error;
  }
}
async function authenticateOwnedCheckpointJournalHistoryWithinScope(
  session: ExecutorSession,
  repository: string,
  expected: string,
) {
  // Load the selected composition only when this admitted path is invoked.
  // Eager initialization would create a cycle through existing signing-context
  // adapters in isolated controller bundles, even for a credential-free refusal.
  const { requireControllerFixedJobJournalAuthorities } =
    await import("./release-authority-configuration.mts");
  const { authenticateFixedJobCoordinatorHistory } =
    await import("./release-coordinator-checkpoint-authentication.mts");
  const value = sessions.get(session)!;
  const deadline = value.deadline!;
  capacityExecutorIdentity(session);
  const selected = await requireControllerFixedJobJournalAuthorities(value.role);
  const identity = await refreshCapacityExecutor(session);
  const source = selected.source;
  if (
    identity.controller_revision !== source.revision ||
    identity.execution_ref !== source.execution_ref ||
    identity.workflow !== source.workflow ||
    identity.actor_id !== source.actor_id ||
    identity.run_id !== source.run_id ||
    identity.run_attempt !== source.run_attempt
  )
    throw new Error("selected journal source differs from actual executor");
  const configuration = { schema_version: 1, namespace: selected.configuration.namespace };
  const checkpoint = await exportCoordinatorCheckpoint(repository, expected);
  const reader = createCheckpointHistoryReader(value.directory, expected, configuration, deadline);
  reader.assertCurrentUnclaimedHead();
  const history = await authenticateFixedJobCoordinatorHistory(
    value.directory,
    checkpoint,
    selected.configuration,
    source,
    deadline,
    reader.api,
  );
  await exportCoordinatorCheckpoint(repository, expected);
  reader.assertCurrentUnclaimedHead();
  const current = await requireControllerFixedJobJournalAuthorities(value.role);
  capacityExecutorIdentity(session);
  if (capacityDigest(current) !== capacityDigest(selected))
    throw new Error("selected journal configuration/source changed during authentication");
  value.journal = { configuration: selected, checkpoint: expected, busy: false, stopped: false };
  return {
    checkpoint: expected,
    history: history.kind,
    configuration_sha256: selected.configuration_sha256,
    authority: "none" as const,
  };
}

/** Selected private-session composition. A caller supplies current controls as
 * trusted controller code, never a report/accepted Boolean or signing API. The
 * existing exchange keeps durable intent, actual signer/verifier, original
 * deadline and exact remote readback. Failure stops this journal session. */
export async function publishOwnedSignedCoordinatorCheckpoint(
  session: ExecutorSession,
  repository: string,
  expected: string,
  currentControls: () => Promise<void>,
) {
  const value = sessions.get(session),
    journal = value?.journal;
  if (
    !value ||
    !journal ||
    value.deadline === undefined ||
    value.journalBinding !== "bound" ||
    journal.busy ||
    journal.stopped
  )
    throw new Error(
      "actual authenticated journal history unavailable or stopped; explicit recovery required",
    );
  journal.busy = true;
  const configuration = {
    schema_version: 1,
    namespace: journal.configuration.configuration.namespace,
  };
  try {
    return await withReadOnlyReleaseChildren(value.directory, async () => {
      const { requireControllerFixedJobJournalAuthorities } =
        await import("./release-authority-configuration.mts");
      const { signAndPublishCoordinatorCheckpoint } =
        await import("./release-coordinator-signing-exchange.mts");
      const refresh = async () => {
        const identity = await refreshCapacityExecutor(session);
        const current = await requireControllerFixedJobJournalAuthorities(value.role);
        if (capacityDigest(current) !== capacityDigest(journal.configuration))
          throw new Error("selected journal source/configuration changed before signing");
        await currentControls();
        capacityExecutorIdentity(session);
        return identity;
      };
      const identity = await refresh();
      if (expected === journal.checkpoint) {
        const reader = createCheckpointHistoryReader(
          value.directory,
          expected,
          configuration,
          value.deadline!,
        );
        reader.assertCurrentUnclaimedHead();
        return { checkpoint: expected, changed: false, authority: "none" as const };
      }
      const checkpoint = await withCoordinatorDeadline(value.deadline!, () =>
        exportCoordinatorCheckpoint(repository, expected),
      );
      if (checkpoint.previous !== journal.checkpoint)
        throw new Error("selected checkpoint does not extend the authenticated owned head");
      const api = await createOwnedCheckpointSigningApi(
        session,
        repository,
        expected,
        configuration,
      );
      const source = journal.configuration.source;
      const result = await signAndPublishCoordinatorCheckpoint(
        value.directory,
        repository,
        expected,
        configuration,
        {
          role: value.role,
          producer: {
            controller_revision: identity.controller_revision,
            controller_ref: identity.execution_ref,
            actor_id: identity.actor_id,
            run_id: identity.run_id,
            run_attempt: identity.run_attempt,
            job_id: String(identity.job_id),
            check_run_id: identity.check_run_id,
            workflow_sha256: source.workflow_sha256,
            configuration_sha256: journal.configuration.configuration_sha256,
            setup_sha256: journal.configuration.configuration.setup_plan_sha256,
          },
        },
        value.deadline!,
        {
          api,
          async refresh() {
            await refresh();
          },
        },
      );
      journal.checkpoint = result.checkpoint;
      return result;
    });
  } catch (error) {
    journal.stopped = true;
    value.journalBinding = "stopped";
    throw error;
  } finally {
    journal.busy = false;
  }
}

interface OwnedEffectRequest {
  kind: "dispatch" | "upload" | "retention";
  destination: string;
  site_expectation?: unknown;
  release_expectation?: unknown;
  aggregate_expectation?: unknown;
  catalog_site_expectation?: unknown;
}

/** Scope validation only. A matching destination cannot mint an executor session
 * or authorize the existing reservation/pending/effect/readback sequence. */
export function assertCapacityExecutorEffectScope(
  role: CapacityExecutorRole,
  request: OwnedEffectRequest,
) {
  if (
    Object.keys(request).sort().join(",") !==
    [
      "destination",
      "kind",
      ...(request.release_expectation === undefined ? [] : ["release_expectation"]),
      ...(request.site_expectation === undefined ? [] : ["site_expectation"]),
      ...(request.aggregate_expectation === undefined ? [] : ["aggregate_expectation"]),
      ...(request.catalog_site_expectation === undefined ? [] : ["catalog_site_expectation"]),
    ]
      .sort()
      .join(",")
  )
    throw new Error("executor effect request contains unsupported fields");
  if (request.release_expectation !== undefined) {
    const expected = inspectReleaseEffectExpectation(request.release_expectation);
    if (
      role !== "release-publication" ||
      request.kind !== "upload" ||
      expected.effect.destination !== request.destination ||
      request.aggregate_expectation !== undefined ||
      request.site_expectation !== undefined ||
      request.catalog_site_expectation !== undefined
    )
      throw new Error("Release expectation outside fixed publisher scope");
  }
  if (
    role === "release-publication" &&
    request.destination.startsWith("github-release:") &&
    request.release_expectation === undefined
  )
    throw new Error("Release preimage required");
  if (request.aggregate_expectation !== undefined) {
    inspectAggregateUploadExpectation(request.aggregate_expectation);
    if (
      role !== "aggregate-assembly" ||
      request.site_expectation !== undefined ||
      request.catalog_site_expectation !== undefined ||
      request.kind !== "upload" ||
      request.destination !== "github-actions:boburning/portcove:admitted-aggregate"
    )
      throw new Error("aggregate expectation is outside admitted assembler scope");
  }
  if (request.site_expectation !== undefined) {
    if (request.catalog_site_expectation !== undefined)
      throw new Error("site effect requires exactly one application or catalog expectation");
    inspectSitePublicationExpectation(request.site_expectation);
    if (
      role !== "site-publication" ||
      request.kind !== "upload" ||
      request.destination !== "github-pages:boburning/portcove:complete-site"
    )
      throw new Error("site expectation is outside the authenticated executor's fixed scope");
  }
  if (request.catalog_site_expectation !== undefined) {
    inspectCatalogSitePublicationExpectation(request.catalog_site_expectation);
    if (
      role !== "site-publication" ||
      request.kind !== "upload" ||
      request.destination !== "github-pages:boburning/portcove:complete-site"
    )
      throw new Error("catalog site expectation outside sole Pages executor scope");
  }
  // Destinations describe a stable logical effect within the candidate or
  // metadata lifecycle. Regenerated artifact/run/descriptor IDs cannot reset
  // retry accounting; actual provider IDs belong in completed-effect receipts.
  const allowed =
    role === "aggregate-assembly"
      ? request.kind === "upload" &&
        request.destination === "github-actions:boburning/portcove:admitted-aggregate" &&
        request.aggregate_expectation !== undefined
      : role === "site-publication"
        ? request.kind === "upload" &&
          [
            "github-pages:boburning/portcove:complete-site",
            "github-actions:boburning/portcove:complete-site-artifact",
          ].includes(request.destination)
        : role === "coordinator"
          ? (request.kind === "dispatch" &&
              /^github-actions:boburning\/portcove:release\.yml:dispatch(?::report-repair-[1-2]-[0-3]:[a-f0-9]{64})?$/u.test(
                request.destination,
              )) ||
            (request.kind === "upload" &&
              [
                "github-actions:boburning/portcove:metadata-renewal-context",
                "github-actions:boburning/portcove:metadata-bootstrap-context",
                "github-actions:boburning/portcove:catalog-publication-context",
              ].includes(request.destination))
          : [
                "catalog-definitions",
                "catalog-policy",
                "catalog-snapshot",
                "catalog-timestamp",
              ].includes(role)
            ? request.kind === "upload" &&
              request.destination ===
                `github-actions:boburning/portcove:catalog-tuf-role-${role.slice("catalog-".length)}`
            : role === "payload-signing"
              ? request.kind === "upload" &&
                /^github-actions:boburning\/portcove:[A-Za-z0-9._-]{1,128}:(?:payload-signatures|payload-signing-context)$/u.test(
                  request.destination,
                )
              : role.startsWith("tuf-") &&
                  [
                    "tuf-releases",
                    "tuf-preview",
                    "tuf-stable",
                    "tuf-snapshot",
                    "tuf-timestamp",
                  ].includes(role)
                ? request.kind === "upload" &&
                  new RegExp(
                    `^github-actions:boburning/portcove:[A-Za-z0-9._-]{1,128}:${role}-envelope$`,
                    "u",
                  ).test(request.destination)
                : role === "release-publication" &&
                  request.kind === "upload" &&
                  (/^github-release:boburning\/portcove:[A-Za-z0-9._-]{1,128}:(?:create-draft|publish|upload:[A-Za-z0-9._+-]{1,200})$/u.test(
                    request.destination,
                  ) ||
                    /^github-actions:boburning\/portcove:[A-Za-z0-9._-]{1,128}:immutable-release-result(?::recovery-(?:[1-2]-[0-3]|0-[1-3]))?$/u.test(
                      request.destination,
                    ));
  if (!allowed) throw new Error("effect is outside the authenticated executor's fixed scope");
}

/** Subject routing only; no descriptor/JSON can mint an executor session. The
 * existing operation implementations independently check the current journal,
 * exact descriptor, pending/nonce, counters, provider readback and settlement. */
export function inspectCapacityExecutorSubject(
  role: CapacityExecutorRole,
  raw: {
    request: OwnedEffectRequest;
    metadata_renewal?: unknown;
    metadata_bootstrap?: unknown;
    catalog_publication?: unknown;
  },
) {
  const value = structuredClone(raw);
  const renewal = value.metadata_renewal !== undefined,
    bootstrap = value.metadata_bootstrap !== undefined;
  if (value.catalog_publication !== undefined) {
    if (
      renewal ||
      bootstrap ||
      value.request.site_expectation !== undefined ||
      value.request.release_expectation !== undefined ||
      value.request.aggregate_expectation !== undefined
    )
      throw new Error("catalog subject cannot reuse application/metadata authority");
    const descriptor = inspectCatalogPublicationDescriptor(value.catalog_publication);
    if (
      ![
        "coordinator",
        "site-publication",
        "catalog-definitions",
        "catalog-policy",
        "catalog-snapshot",
        "catalog-timestamp",
      ].includes(role)
    )
      throw new Error(
        "catalog subject requires explicitly appointed catalog or sole site executor",
      );
    if (
      role === "coordinator" &&
      (value.request.kind !== "upload" ||
        value.request.destination !==
          "github-actions:boburning/portcove:catalog-publication-context")
    )
      throw new Error("catalog coordinator requires exact context upload");
    if (
      role === "site-publication" &&
      (value.request.destination === "github-pages:boburning/portcove:complete-site") !==
        (value.request.catalog_site_expectation !== undefined)
    )
      throw new Error("catalog Pages requires exact catalog site expectation");
    if (value.request.catalog_site_expectation !== undefined)
      assertCatalogSitePublicationBinding(descriptor, value.request.catalog_site_expectation);
    assertCapacityExecutorEffectScope(role, value.request);
    return { kind: "catalog-publication" as const, descriptor };
  }
  if (
    role.startsWith("catalog-") ||
    value.request.catalog_site_expectation !== undefined ||
    value.request.destination === "github-actions:boburning/portcove:catalog-publication-context"
  )
    throw new Error("catalog effect requires explicit catalog subject");
  if (renewal && bootstrap) throw new Error("exactly one metadata subject required");
  if (renewal || bootstrap) {
    if (
      ![
        "coordinator",
        "site-publication",
        "tuf-releases",
        "tuf-preview",
        "tuf-stable",
        "tuf-snapshot",
        "tuf-timestamp",
      ].includes(role)
    )
      throw new Error("metadata subject requires a fixed coordinator/site/online role");
    const kind = renewal ? "metadata-renewal" : "metadata-bootstrap";
    if (
      role === "coordinator" &&
      (value.request.kind !== "upload" ||
        value.request.destination !== `github-actions:boburning/portcove:${kind}-context`)
    )
      throw new Error("coordinator metadata subject requires its own exact context upload");
    return renewal
      ? {
          kind: "metadata-renewal" as const,
          descriptor: inspectMetadataRenewalDescriptor(value.metadata_renewal),
        }
      : {
          kind: "metadata-bootstrap" as const,
          descriptor: inspectMetadataBootstrapDescriptor(value.metadata_bootstrap),
        };
  }
  if (role === "coordinator" && value.request.kind === "upload")
    throw new Error("coordinator context upload requires its explicit metadata subject");
  return { kind: "candidate" as const };
}

/** One transport choice for effects and explicit recovery. The selected source
 * cannot borrow a legacy credential or guard in place of authenticated history. */
function ownedCheckpointTransport(
  session: ExecutorSession,
  input: { repository: string; checkpoint: string; remote_configuration: unknown },
  beforeCheckpointMutation?: () => Promise<void>,
  beforeLegacyMutation?: () => void,
  purpose?: "application" | "catalog-publication",
) {
  const value = sessions.get(session)!;
  let remote: NonNullable<CapacityOperationOptions["remote"]>;
  value.requiresSignedJournal ||= selectedJournalRequired();
  if (value.requiresSignedJournal || value.journalBinding !== undefined) {
    if (
      value.journalBinding !== "bound" ||
      !value.journal ||
      value.journal.busy ||
      value.journal.stopped ||
      value.journal.checkpoint !== input.checkpoint ||
      typeof beforeCheckpointMutation !== "function" ||
      beforeLegacyMutation !== undefined ||
      inspectCoordinatorRemoteNamespace(input.remote_configuration) !==
        value.journal.configuration.configuration.namespace
    )
      throw new Error("selected effect requires its exact bound journal and fresh control reader");
    if (purpose !== undefined) assertOwnedPublicationPurpose(value, purpose);
    const fullScope = value.journal.configuration.authority_configuration_sha256;
    if (
      typeof fullScope !== "string" ||
      !/^[a-f0-9]{64}$/.test(fullScope) ||
      fullScope !== value.journal.configuration.source.authority_configuration_sha256
    )
      throw new Error("full selected publication scope required before effects or recovery");
    const controls = beforeCheckpointMutation;
    remote = {
      publish: (checkpoint) =>
        publishOwnedSignedCoordinatorCheckpoint(session, input.repository, checkpoint, controls),
    };
  } else {
    if (beforeCheckpointMutation !== undefined)
      throw new Error(
        "selected checkpoint controls cannot substitute authenticated journal history",
      );
    remote = {
      configuration: input.remote_configuration,
      api: recoveryJournalApi(value, beforeLegacyMutation),
    };
  }
  return {
    remote,
    async publish(this: void, checkpoint: string) {
      if ("publish" in remote) await remote.publish(checkpoint);
      else
        await publishCoordinatorCheckpoint(input.repository, checkpoint, remote.configuration, {
          api: remote.api,
        });
    },
  };
}

function assertOwnedPublicationPurpose(
  value: PrivateSession,
  purpose: "application" | "catalog-publication",
) {
  if (value.journal && value.journal.configuration.purpose !== purpose)
    throw new Error("selected publication purpose differs from authenticated journal source");
}

function stopOwnedJournal(value: PrivateSession) {
  if (value.requiresSignedJournal || value.journalBinding !== undefined) {
    value.journalBinding = "stopped";
    if (value.journal) value.journal.stopped = true;
  }
}

/** Actual current-job/exact-checkpoint integration of the existing bounded
 * operation journal. This grants no semantic/custody/control acceptance: the
 * fixed controller must obtain those through their actual phase consumers
 * before invoking its one provider effect and independent result readback.
 * Failure stops this session. An unresolved intent cannot be retried here. */
export async function executeOwnedCapacityEffect(
  ...args: Parameters<typeof executeOwnedCapacityEffectWithinScope>
) {
  const value = sessions.get(args[0]);
  if (!value) throw new Error("an actual authenticated executor session is required");
  const work = () => executeOwnedCapacityEffectWithinScope(...args);
  return value.deadline === undefined ? work() : withCoordinatorDeadline(value.deadline, work);
}
async function executeOwnedCapacityEffectWithinScope(
  session: ExecutorSession,
  raw: {
    repository: string;
    checkpoint: string;
    remote_configuration: unknown;
    request: OwnedEffectRequest;
    metadata_renewal?: unknown;
    metadata_bootstrap?: unknown;
    catalog_publication?: unknown;
    recovery?: "transient" | "substantive-repair";
  },
  readBoundary: (pending?: OwnedPendingBoundary) => Promise<unknown>,
  effect: (pending: {
    checkpoint: string;
    operation_id: string;
  }) => Promise<{ remote_identity: string; evidence_sha256: string }>,
  /** Selected private journal only: existing live controls without a stale
   * reservation-head assertion. Pending ownership is checked separately below. */
  beforeCheckpointMutation?: () => Promise<void>,
) {
  const value = sessions.get(session);
  if (!value) throw new Error("an actual authenticated executor session is required");
  const input = structuredClone(raw);
  const subject = inspectCapacityExecutorSubject(value.role, input);
  if (!/^[a-f0-9]{40}$/u.test(input.checkpoint))
    throw new Error("exact coordinator checkpoint required");
  assertCapacityExecutorEffectScope(value.role, input.request);
  let state = effectStates.get(session);
  if (!state) {
    state = { busy: false, failed: false };
    effectStates.set(session, state);
  }
  if (state.busy || state.failed)
    throw new Error("executor is busy or stopped; explicit readback/recovery required");
  state.busy = true;
  let ownedId: string | null = null;
  const captured: { completed?: { remote_identity: string; evidence_sha256: string } } = {};
  try {
    const { remote, publish } = ownedCheckpointTransport(
      session,
      input,
      beforeCheckpointMutation,
      undefined,
      subject.kind === "catalog-publication" ? "catalog-publication" : "application",
    );
    const executorIdentity = await refreshCapacityExecutor(session);
    const readOwnedBoundary: CapacityBoundaryReader = async (pending) => {
      if (!pending) return readBoundary();
      const operation = inspectCapacityOperation(pending.operation);
      if (
        !operation ||
        !/^[a-f0-9]{40}$/u.test(pending.checkpoint) ||
        capacityDigest(operation.executor_identity) !== capacityDigest(executorIdentity)
      )
        throw new Error("pending boundary differs from actual current executor");
      const receipt: OwnedPendingBoundary = Object.freeze({
        kind: "owned-capacity-pending-boundary",
      });
      pendingBoundaries.set(receipt, {
        session,
        checkpoint: pending.checkpoint,
        operation: structuredClone(operation),
      });
      try {
        return await readBoundary(receipt);
      } finally {
        pendingBoundaries.delete(receipt);
      }
    };
    // Existing transport checks every remote ref and returns only exact public
    // readback; no local checkpoint or public nonce can appoint this executor.
    await publish(input.checkpoint);
    const perform: Parameters<typeof runBoundedCapacityOperation>[4] = async (
      recordCompleted,
      pending,
    ) => {
      if (capacityDigest(pending.operation.executor_identity) !== capacityDigest(executorIdentity))
        throw new Error("durable operation belongs to another executor");
      if (typeof pending.operation.id !== "string" || !/^[a-f0-9]{64}$/u.test(pending.operation.id))
        throw new Error("actual capacity operation identity unavailable");
      ownedId = pending.operation.id;
      await refreshCapacityExecutor(session);
      await publish(pending.checkpoint);
      const receipt = await effect({ checkpoint: pending.checkpoint, operation_id: ownedId });
      if (
        Object.keys(receipt).sort().join(",") !== "evidence_sha256,remote_identity" ||
        typeof receipt.remote_identity !== "string" ||
        !receipt.remote_identity ||
        !/^[a-f0-9]{64}$/u.test(receipt.evidence_sha256)
      )
        throw new Error("exact provider/readback evidence unavailable");
      captured.completed = structuredClone(receipt);
      await recordCompleted(receipt.remote_identity, receipt.evidence_sha256);
    };
    const options = { remote, executorIdentity, maximumReceipts: 1 };
    if (subject.kind === "candidate" && input.recovery !== undefined)
      throw new Error("candidate retries require their existing reservation recovery");
    const result =
      subject.kind === "candidate"
        ? await runBoundedCapacityOperation(
            input.repository,
            input.checkpoint,
            input.request,
            readOwnedBoundary,
            perform,
            options,
          )
        : await (
            subject.kind === "catalog-publication"
              ? runBoundedCatalogPublicationOperation
              : subject.kind === "metadata-renewal"
                ? runBoundedMetadataRenewalOperation
                : runBoundedMetadataBootstrapOperation
          )(
            input.repository,
            input.checkpoint,
            subject.descriptor,
            input.request,
            readOwnedBoundary,
            perform,
            { ...options, ...(input.recovery === undefined ? {} : { recovery: input.recovery }) },
          );
    const completed = captured.completed;
    if (
      !ownedId ||
      !completed ||
      result.durable_checkpoint !== result.checkpoint ||
      result.completion !== "readback-required"
    )
      throw new Error("durable provider handoff is unresolved");
    await refreshCapacityExecutor(session);
    await publish(result.checkpoint);
    const actual = await recoverReleaseOpportunity(input.repository, result.checkpoint);
    const controller = actual.input.controller;
    const capacity =
      isRecord(controller) && isRecord(controller.capacity_attempt)
        ? controller.capacity_attempt
        : null;
    const operation = capacity && isRecord(capacity.operation) ? capacity.operation : null;
    if (
      !operation ||
      operation.id !== ownedId ||
      operation.outcome !== "pending" ||
      capacityDigest(operation.executor_identity) !== capacityDigest(executorIdentity) ||
      capacityDigest(operation.completed_effects) !== capacityDigest([completed])
    )
      throw new Error("exact owned provider receipt changed before settlement");
    const settled = await recordCapacityReadback(
      input.repository,
      result.checkpoint,
      "effect-completed",
      completed.evidence_sha256,
      { remote, executorIdentity },
    );
    if (!("durable_checkpoint" in settled) || settled.durable_checkpoint !== settled.checkpoint)
      throw new Error("remote settlement is unresolved");
    return {
      checkpoint: settled.checkpoint,
      operation_id: ownedId,
      evidence_sha256: completed.evidence_sha256,
    };
  } catch (error) {
    state.failed = true;
    // The existing operation has already retained its best-effort failure
    // checkpoint. Do not let the same failed executor keep signing through the
    // direct journal publisher; recovery belongs to a new authenticated job.
    stopOwnedJournal(value);
    throw error;
  } finally {
    state.busy = false;
  }
}

/** Automatic bounded recovery is a different authenticated job. It may observe
 * and resolve an old intent only after the original exact executor is terminal;
 * it never inherits permission to re-POST the effect. Readback callbacks in the
 * immutable controller must positively establish the requested resolution. */
/** Provider reads share the actual executor's original phase clock. This
 * transport carries no executor authority and never extends a retained session. */
function capacityRecoveryProviderApi(value: Pick<PrivateSession, "directory" | "deadline">) {
  const remaining = () => {
    if (value.deadline !== undefined && !Number.isFinite(value.deadline))
      throw new Error("capacity recovery phase deadline invalid");
    const timeout =
      value.deadline === undefined
        ? 15000
        : Math.floor(Math.min(15000, value.deadline - performance.now()));
    if (timeout < 1) throw new Error("capacity recovery phase deadline exhausted");
    return timeout;
  };
  return new GitHubApiClient((args, body) => {
    const result = createGitHubRunner({
      cwd: value.directory,
      timeoutMs: remaining(),
      maxBuffer: 2 * 1024 * 1024,
    })([...args, "--hostname", "github.com"], body);
    remaining();
    return result;
  });
}

/** The actual caller supplies a synchronous recheck of its current authenticated
 * controls. GET-only recovery is separate from every journal mutation. */
function recoveryJournalApi(value: PrivateSession, beforeMutation?: () => void) {
  const journal = createCoordinatorJournalApi(value.directory, value.deadline);
  const guard = () => {
    if (beforeMutation && beforeMutation() !== undefined)
      throw new Error("recovery mutation guard must complete synchronously");
  };
  return {
    request: (...args: Parameters<typeof journal.request>) => {
      if (args[0] !== "GET") guard();
      return journal.request(...args);
    },
    graphql: (...args: Parameters<typeof journal.graphql>) => {
      if (/^\s*mutation\b/u.test(args[0])) guard();
      return journal.graphql(...args);
    },
  };
}
export async function recoverOwnedCapacityEffect(
  ...args: [
    Parameters<typeof recoverOwnedCapacityEffectWithinScope>[0],
    Parameters<typeof recoverOwnedCapacityEffectWithinScope>[1],
    Parameters<typeof recoverOwnedCapacityEffectWithinScope>[2],
    beforeMutation?: () => void,
    /** Selected signed journal: actual live controls; fourth guard is legacy only. */
    beforeCheckpointMutation?: () => Promise<void>,
  ]
) {
  const value = sessions.get(args[0]);
  if (!value) throw new Error("an actual authenticated executor session is required");
  const work = () =>
    recoverOwnedCapacityEffectWithinScope(args[0], args[1], args[2], false, args[3], args[4]);
  return value.deadline === undefined ? work() : withCoordinatorDeadline(value.deadline, work);
}
/** The same protected admitted-aggregate role may settle a previous terminal
 * job's one exact upload. This route cannot resolve other roles or re-upload. */
export async function recoverOwnedAdmittedAggregateEffect(
  ...args: Parameters<typeof recoverOwnedCapacityEffect>
) {
  const value = sessions.get(args[0]);
  if (!value || value.role !== "aggregate-assembly")
    throw new Error("actual admitted aggregate recovery job required");
  const work = () =>
    recoverOwnedCapacityEffectWithinScope(args[0], args[1], args[2], true, args[3], args[4]);
  return value.deadline === undefined ? work() : withCoordinatorDeadline(value.deadline, work);
}
async function recoverOwnedCapacityEffectWithinScope(
  session: ExecutorSession,
  raw: { repository: string; checkpoint: string; remote_configuration: unknown },
  readback: (operation: Readonly<Record<string, unknown>>) => Promise<{
    resolution: "effect-completed" | "effect-not-applied" | "partial-effects-retained";
    evidence_sha256: string;
    completed_effect?: { remote_identity: string; evidence_sha256: string };
  }>,
  admittedAggregate = false,
  beforeMutation?: () => void,
  beforeCheckpointMutation?: () => Promise<void>,
) {
  const value = sessions.get(session);
  if (
    !value ||
    (admittedAggregate ? value.role !== "aggregate-assembly" : value.role !== "coordinator")
  )
    throw new Error("actual fixed coordinator recovery identity required");
  const input = structuredClone(raw);
  if (!/^[a-f0-9]{40}$/u.test(input.checkpoint))
    throw new Error("exact recovery checkpoint required");
  let state = effectStates.get(session);
  if (!state) {
    state = { busy: false, failed: false };
    effectStates.set(session, state);
  }
  if (state.busy || state.failed)
    throw new Error("executor is busy or stopped; retain original recovery evidence");
  state.busy = true;
  try {
    const api = capacityRecoveryProviderApi(value);
    const { remote, publish } = ownedCheckpointTransport(
      session,
      input,
      beforeCheckpointMutation,
      beforeMutation,
    );
    const executorIdentity = await refreshCapacityExecutor(session);
    await publish(input.checkpoint);
    const actual = await recoverReleaseOpportunity(input.repository, input.checkpoint);
    const controller = actual.input.controller;
    const capacity =
      isRecord(controller) && isRecord(controller.capacity_attempt)
        ? controller.capacity_attempt
        : null;
    const operation = capacity && isRecord(capacity.operation) ? capacity.operation : null;
    if (
      !operation ||
      !["pending", "ambiguous", "capacity-refused"].includes(String(operation.outcome)) ||
      !isRecord(operation.executor_identity)
    )
      throw new Error("an unresolved identity-bound capacity operation is required");
    const original = inspectCapacityExecutorIdentity(operation.executor_identity);
    assertOwnedPublicationPurpose(
      value,
      operation.catalog_publication === undefined ? "application" : "catalog-publication",
    );
    if (
      admittedAggregate &&
      (original.role !== "aggregate-assembly" ||
        operation.destination !== "github-actions:boburning/portcove:admitted-aggregate" ||
        operation.kind !== "upload" ||
        operation.receipt_limit !== 1 ||
        !operation.aggregate_expectation)
    )
      throw new Error("admitted aggregate recovery cannot resolve another effect");
    if (original.job_id === executorIdentity.job_id && original.run_id === executorIdentity.run_id)
      throw new Error("live executor cannot appoint itself as terminal-job recovery");
    const terminal = () => {
      const response = api.request(
        "GET",
        `repos/boburning/portcove/actions/jobs/${String(original.job_id)}`,
      );
      const job = response.body;
      if (
        response.status !== 200 ||
        !isRecord(job) ||
        job.id !== original.job_id ||
        String(job.run_id) !== original.run_id ||
        job.run_attempt !== original.run_attempt ||
        job.head_sha !== original.controller_revision ||
        job.status !== "completed" ||
        typeof job.conclusion !== "string" ||
        !job.conclusion ||
        job.check_run_url !==
          `https://api.github.com/repos/boburning/portcove/check-runs/${String(original.check_run_id)}`
      )
        throw new Error("original exact executor is not observed terminal; recovery remains held");
    };
    terminal();
    const resolution = structuredClone(await readback(structuredClone(operation)));
    if (
      !["evidence_sha256,resolution", "completed_effect,evidence_sha256,resolution"].includes(
        Object.keys(resolution).sort().join(","),
      ) ||
      !["effect-completed", "effect-not-applied", "partial-effects-retained"].includes(
        resolution.resolution,
      ) ||
      !/^[a-f0-9]{64}$/u.test(resolution.evidence_sha256) ||
      (resolution.completed_effect !== undefined &&
        (resolution.resolution !== "effect-completed" ||
          !isRecord(resolution.completed_effect) ||
          Object.keys(resolution.completed_effect).sort().join(",") !==
            "evidence_sha256,remote_identity" ||
          typeof resolution.completed_effect.remote_identity !== "string" ||
          !resolution.completed_effect.remote_identity ||
          !/^[a-f0-9]{64}$/u.test(resolution.completed_effect.evidence_sha256)))
    )
      throw new Error("actual recovery readback is incomplete");
    await refreshCapacityExecutor(session);
    terminal();
    await publish(input.checkpoint);
    const settled = await recordCapacityReadback(
      input.repository,
      input.checkpoint,
      resolution.resolution,
      resolution.evidence_sha256,
      {
        remote,
        executorIdentity,
        ...(resolution.completed_effect ? { completedEffect: resolution.completed_effect } : {}),
      },
    );
    if (!("durable_checkpoint" in settled) || settled.durable_checkpoint !== settled.checkpoint)
      throw new Error("recovery remote settlement unresolved");
    return { checkpoint: settled.checkpoint, operation_id: operation.id, ...resolution };
  } catch (error) {
    state.failed = true;
    stopOwnedJournal(value);
    throw error;
  } finally {
    state.busy = false;
  }
}

/** Complete a lost post-publication journal handoff without another provider
 * mutation. The separately authenticated coordinator must re-read the exact
 * public result after the original publisher has become terminal. */
export async function recoverOwnedPublishedMetadata(
  session: ExecutorSession,
  raw: { repository: string; checkpoint: string; remote_configuration: unknown },
  readback: (operation: Readonly<Record<string, unknown>>) => Promise<unknown>,
  beforeMutation?: () => void,
  beforeCheckpointMutation?: () => Promise<void>,
) {
  const value = sessions.get(session);
  if (!value) throw new Error("an actual authenticated executor session is required");
  const work = () =>
    recoverOwnedPublishedMetadataWithinScope(
      session,
      raw,
      readback,
      "application",
      beforeMutation,
      beforeCheckpointMutation,
    );
  return value.deadline === undefined ? work() : withCoordinatorDeadline(value.deadline, work);
}
/** Separate catalog-purpose handoff. The shared coordinator/terminal publisher
 * gates remain identical; application metadata is never parsed as catalog. */
export async function recoverOwnedPublishedCatalogMetadata(
  session: ExecutorSession,
  raw: { repository: string; checkpoint: string; remote_configuration: unknown },
  readback: (operation: Readonly<Record<string, unknown>>) => Promise<unknown>,
  beforeMutation?: () => void,
  beforeCheckpointMutation?: () => Promise<void>,
) {
  const value = sessions.get(session);
  if (!value) throw new Error("an actual authenticated executor session is required");
  const work = () =>
    recoverOwnedPublishedMetadataWithinScope(
      session,
      raw,
      readback,
      "catalog",
      beforeMutation,
      beforeCheckpointMutation,
    );
  return value.deadline === undefined ? work() : withCoordinatorDeadline(value.deadline, work);
}
async function recoverOwnedPublishedMetadataWithinScope(
  session: ExecutorSession,
  raw: { repository: string; checkpoint: string; remote_configuration: unknown },
  readback: (operation: Readonly<Record<string, unknown>>) => Promise<unknown>,
  component: "application" | "catalog" = "application",
  beforeMutation?: () => void,
  beforeCheckpointMutation?: () => Promise<void>,
) {
  const value = sessions.get(session);
  if (!value || value.role !== "coordinator")
    throw new Error("actual coordinator required for published-state recovery");
  const input = structuredClone(raw);
  let state = effectStates.get(session);
  if (!state) {
    state = { busy: false, failed: false };
    effectStates.set(session, state);
  }
  if (state.busy || state.failed) throw new Error("recovery executor is busy or stopped");
  state.busy = true;
  try {
    const api = capacityRecoveryProviderApi(value);
    const { remote, publish } = ownedCheckpointTransport(
      session,
      input,
      beforeCheckpointMutation,
      beforeMutation,
      component === "catalog" ? "catalog-publication" : "application",
    );
    const current = await refreshCapacityExecutor(session);
    await publish(input.checkpoint);
    const actual = await recoverReleaseOpportunity(input.repository, input.checkpoint);
    const controller = actual.input.controller;
    const capacity =
      isRecord(controller) && isRecord(controller.capacity_attempt)
        ? controller.capacity_attempt
        : null;
    const operation = capacity && isRecord(capacity.operation) ? capacity.operation : null;
    if (
      !operation ||
      operation.destination !== "github-pages:boburning/portcove:complete-site" ||
      operation.kind !== "upload" ||
      !["succeeded", "recovered"].includes(String(operation.outcome)) ||
      (operation.outcome === "recovered" &&
        (!isRecord(operation.recovery) || operation.recovery.resolution !== "effect-completed")) ||
      !Array.isArray(operation.completed_effects) ||
      operation.completed_effects.length !== 1
    )
      throw new Error("exact settled site operation required for published-state recovery");
    if (
      component === "catalog"
        ? !isRecord(operation.catalog_publication) || operation.site_expectation !== undefined
        : operation.catalog_publication !== undefined ||
          operation.catalog_site_expectation !== undefined
    )
      throw new Error("settled site operation belongs to a different component purpose");
    const original = inspectCapacityExecutorIdentity(operation.executor_identity);
    if (
      original.role !== "site-publication" ||
      (original.run_id === current.run_id && original.job_id === current.job_id)
    )
      throw new Error("separate terminal site publisher required");
    const terminal = () => {
      const result = api.request(
        "GET",
        `repos/boburning/portcove/actions/jobs/${String(original.job_id)}`,
      );
      const job = result.body;
      if (
        result.status !== 200 ||
        !isRecord(job) ||
        job.id !== original.job_id ||
        String(job.run_id) !== original.run_id ||
        job.run_attempt !== original.run_attempt ||
        job.head_sha !== original.controller_revision ||
        job.status !== "completed" ||
        typeof job.conclusion !== "string" ||
        !job.conclusion ||
        job.check_run_url !==
          `https://api.github.com/repos/boburning/portcove/check-runs/${String(original.check_run_id)}`
      )
        throw new Error("original exact publisher is not observed terminal");
    };
    terminal();
    const observed = await readback(structuredClone(operation));
    if (
      component === "catalog" &&
      (!isRecord(observed) || Object.keys(observed).sort().join(",") !== "metadata,site")
    )
      throw new Error("catalog metadata and whole-site cursor readback required");
    const published =
      component === "catalog"
        ? inspectPublishedCatalogMetadata((observed as Record<string, unknown>).metadata)
        : inspectPublishedMetadata(observed);
    const site =
      component === "catalog"
        ? inspectPublishedSite((observed as Record<string, unknown>).site)
        : null;
    if (
      component === "catalog" &&
      (!published ||
        !site ||
        site.operation_id !== operation.id ||
        site.generation_sha256 !== published.publication.site_generation_sha256 ||
        capacityDigest(site.publication) !==
          capacityDigest({
            evidence_sha256: published.publication.evidence_sha256,
            remote_identity: published.publication.remote_identity,
          }))
    )
      throw new Error("catalog cursor differs from exact settled publication");
    const effect: unknown = operation.completed_effects[0];
    if (
      !published ||
      !isRecord(effect) ||
      published.operation_id !== operation.id ||
      published.publication.remote_identity !== effect.remote_identity ||
      published.publication.evidence_sha256 !== effect.evidence_sha256
    )
      throw new Error("public readback differs from exact settled effect");
    await refreshCapacityExecutor(session);
    terminal();
    await publish(input.checkpoint);
    const recovered =
      component === "catalog"
        ? await recordPublishedCatalogMetadata(
            input.repository,
            input.checkpoint,
            published,
            site,
            { remote },
          )
        : await recordPublishedApplicationSiteMetadata(
            input.repository,
            input.checkpoint,
            published,
            {
              remote,
            },
          );
    if (
      !("durable_checkpoint" in recovered) ||
      recovered.durable_checkpoint !== recovered.checkpoint
    )
      throw new Error("published-state recovery handoff unresolved");
    return {
      checkpoint: recovered.checkpoint,
      operation_id: operation.id,
      site_generation_sha256: published.publication.site_generation_sha256,
    };
  } catch (error) {
    state.failed = true;
    stopOwnedJournal(value);
    throw error;
  } finally {
    state.busy = false;
  }
}
