/** Coordinator-owned unchanged-feed context. This cannot manufacture a release
 * candidate, native qualification, a prior repository or bootstrap absence. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  requireActualCoordinatorMetadataPreparation,
  requireActualCoordinatorBootstrapPreparation,
} from "./release-coordinator-driver.mts";
import { inspectPreparedMetadataBootstrap } from "./release-bootstrap-preparation.mts";
import {
  readConfiguredBootstrapSite,
  readConfiguredCatalogOnlyBootstrapSite,
} from "./release-bootstrap-public-inputs.mts";
import { inspectPreparedMetadataRenewal } from "./release-metadata-renewal.mts";
import { verifiedControllerToolPaths } from "./release-controller-tool-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import {
  requirePublishedCompleteSite,
  readPublicApplicationSiteMarker,
} from "./release-site-readback.mts";
import { readBoundedReleaseContextFiles } from "./release-signing-context.mts";
import { requireControllerPublicationAuthorities } from "./release-authority-configuration.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { readRemoteCoordinatorSnapshot } from "./release-coordinator-recovery.mts";
import { inspectCapacityOperation } from "./release-capacity.mts";
import { capacityExecutorIdentity, refreshCapacityExecutor } from "./release-capacity-executor.mts";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import { releaseControlRefQuery } from "./release-control-inputs.mts";
import { isRecord } from "./runtime-values.mts";
import {
  inspectMetadataSigningBinding,
  inspectMetadataSigningReservation,
} from "./release-metadata-signing-contract.mts";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const inventory = (files: ReadonlyMap<string, Buffer>) =>
  [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) }));
type Session =
  | Awaited<ReturnType<typeof requireActualCoordinatorMetadataPreparation>>
  | Awaited<ReturnType<typeof requireActualCoordinatorBootstrapPreparation>>;
type Executor = Parameters<typeof capacityExecutorIdentity>[0];
type Controls = Awaited<ReturnType<Session["next_controls"]>>;
type Owned = {
  session: Session;
  directory: string;
  work: string;
  deadline: number;
  files: ReturnType<typeof inventory>;
  descriptor:
    | Awaited<ReturnType<typeof inspectPreparedMetadataRenewal>>["descriptor"]
    | Awaited<ReturnType<typeof inspectPreparedMetadataBootstrap>>["descriptor"];
  control_facts: { pause: unknown; capacity: unknown };
  facts: Record<string, unknown>;
  binding: Record<string, unknown>;
  observed: number;
  bootstrap_observed: number;
  source?: Controls;
  pending?: { executor: Executor; checkpoint: string; operation_id: string };
};
const contexts = new WeakMap<object, Owned>();
function remaining(owned: { deadline: number }, max = 15000) {
  const left = Math.floor(owned.deadline - performance.now());
  if (!Number.isFinite(left) || left < 1) throw new Error("coordinator context deadline exhausted");
  return Math.min(max, left);
}
function apiFor(owned: Pick<Owned, "directory" | "work" | "deadline">) {
  let reads = 0;
  const environment = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: owned.work,
    USERPROFILE: owned.work,
    GH_CONFIG_DIR: path.join(owned.work, "gh-config"),
    GH_TOKEN: process.env.GH_TOKEN,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
  };
  return new GitHubApiClient((args, input) => {
    if (++reads > 32) throw new Error("metadata context control read limit exhausted");
    const response = createGitHubRunner({
      cwd: owned.directory,
      maxBuffer: 512 * 1024,
      timeoutMs: remaining(owned),
      spawn: (command, args, settings) =>
        spawnSync(command, args, { ...settings, env: environment }),
    })([...args, "--hostname", "github.com"], input);
    remaining(owned);
    return response;
  });
}
async function controls(owned: Owned) {
  remaining(owned);
  if (!owned.source || performance.now() - owned.observed >= 45000) {
    owned.source = await owned.session.next_controls(owned.deadline);
    owned.observed = performance.now();
  }
  if (owned.source.evidence_scope !== "github.com")
    throw new Error("actual coordinator metadata controls required");
  const api = apiFor(owned),
    current = owned.source.readMaintenance({
      request(method, endpoint, body) {
        if (
          method !== "GET" ||
          body !== undefined ||
          !endpoint.startsWith("repos/boburning/portcove/")
        )
          throw new Error("metadata context permits fixed GET only");
        return api.request(method, endpoint);
      },
      graphql(query, variables) {
        if (query !== releaseControlRefQuery)
          throw new Error("metadata context control query differs");
        return api.graphql(query, variables);
      },
    });
  if (
    current.pause.publication_paused ||
    !current.resource_policy_matches_controller ||
    !isDeepStrictEqual(current.pause, owned.control_facts.pause) ||
    !isDeepStrictEqual(current.capacity, owned.control_facts.capacity)
  )
    throw new Error("coordinator metadata controls changed");
  return current;
}
async function snapshot(owned: Owned) {
  return readRemoteCoordinatorSnapshot(
    owned.directory,
    { schema_version: 1, namespace: owned.session.namespace },
    { transport: { cwd: owned.directory, deadline: owned.deadline } },
  );
}
async function verifyState(owned: Owned, state: Awaited<ReturnType<typeof snapshot>>) {
  if (owned.session.mode === "renewal")
    await requirePublishedCompleteSite(owned.session.complete_site);
  inspectMetadataSigningReservation(
    owned.facts,
    owned.binding,
    owned.facts.previous_site_pins,
    state,
  );
  if (!owned.pending) {
    if (state.checkpoint !== owned.session.checkpoint)
      throw new Error("metadata context initial checkpoint changed");
    return;
  }
  const actual = await refreshCapacityExecutor(owned.pending.executor),
    controller = state.input.controller;
  const operation = inspectCapacityOperation(
    isRecord(controller) && isRecord(controller.capacity_attempt)
      ? controller.capacity_attempt.operation
      : null,
  );
  if (
    !operation ||
    operation.id !== owned.pending.operation_id ||
    (owned.session.mode === "renewal"
      ? operation.metadata_renewal?.descriptor_sha256
      : operation.metadata_bootstrap?.descriptor_sha256) !== digest(owned.descriptor) ||
    operation.kind !== "upload" ||
    operation.destination !==
      `github-actions:boburning/portcove:metadata-${owned.session.mode}-context` ||
    digest(operation.executor_identity) !== digest(actual) ||
    !["pending", "succeeded", "recovered"].includes(String(operation.outcome))
  )
    throw new Error("metadata context is not the exact owned coordinator upload");
}
export async function prepareCoordinatorSigningContext(
  actualPreparation: object,
  parent: string,
  phaseDeadline = Infinity,
) {
  if (phaseDeadline !== Infinity) remaining({ deadline: phaseDeadline });
  const getter =
    isRecord(actualPreparation) && actualPreparation.decision === "metadata-bootstrap-prepared"
      ? requireActualCoordinatorBootstrapPreparation
      : requireActualCoordinatorMetadataPreparation;
  const session = await getter(
      actualPreparation,
      phaseDeadline === Infinity ? undefined : phaseDeadline,
    ),
    deadline = Math.min(session.deadline, phaseDeadline);
  remaining({ deadline });
  const tools = await verifiedControllerToolPaths(session.tools),
    prepared =
      session.mode === "renewal"
        ? await inspectPreparedMetadataRenewal(session.preparation)
        : await inspectPreparedMetadataBootstrap(session.preparation),
    site =
      session.mode === "renewal" ? await requirePublishedCompleteSite(session.complete_site) : null,
    authorities = await requireControllerPublicationAuthorities("coordinator");
  if (
    session.namespace !== authorities.namespace ||
    prepared.verifier_sha256 !== hash(await readControllerToolFile(tools.rust)) ||
    prepared.descriptor.root_sha256 !== authorities.publication.public_source.root.sha256 ||
    (site !== null &&
      (prepared.descriptor.kind !== "application-tuf-metadata-renewal" ||
        prepared.descriptor.prior_repository_sha256 !== site.pins.repository_sha256)) ||
    (session.mode === "bootstrap" &&
      (prepared.descriptor.kind !== "application-tuf-initial-bootstrap" ||
        prepared.descriptor.setup_plan_sha256 !== authorities.publication.setup_plan_sha256))
  )
    throw new Error("coordinator context requires actual unchanged-feed preparation");
  const source = await readBoundedReleaseContextFiles(prepared.prepared_root),
    pins = authorities.publication.public_source;
  if (digest(inventory(source)) !== digest(prepared.files))
    throw new Error("actual metadata preparation inventory changed");
  for (const [name, pin] of [
    ["trusted-root.json", pins.root],
    ["offline-targets.json", pins.offline_targets],
    ["payload.json", pins.payload_key_registry],
  ] as const) {
    const bytes = source.get(name);
    if (!bytes || bytes.length !== pin.bytes || hash(bytes) !== pin.sha256)
      throw new Error("metadata context public anchor differs from ratified setup");
  }
  const work = await mkdtemp(path.join(parent, "metadata-signing-context-")),
    directory = path.join(work, "context");
  await mkdir(directory, { mode: 0o700 });
  const current = session.controls.readMaintenance(apiFor({ directory, work, deadline }));
  if (current.pause.publication_paused || !current.resource_policy_matches_controller)
    throw new Error("metadata preparation controls unavailable");
  const facts = {
    mode: session.mode,
    descriptor: prepared.descriptor,
    namespace: session.namespace,
    checkpoint: session.checkpoint,
    previous_site_pins: site?.pins ?? (session.mode === "bootstrap" ? session.catalog_pins : null),
    ...(session.mode === "bootstrap" && session.catalog_pins
      ? {
          initial_site_preimage: session.initial_site_preimage,
          catalog_readback_sha256: digest(session.fresh_configured_site),
        }
      : {}),
    setup_plan_sha256: authorities.publication.setup_plan_sha256,
    public_source_commit: pins.commit,
  };
  const binding = {
    kind: `metadata-${session.mode}`,
    descriptor_sha256: digest(prepared.descriptor),
    records_sha256:
      prepared.descriptor.kind === "application-tuf-metadata-renewal"
        ? prepared.descriptor.unchanged_records_sha256
        : prepared.descriptor.initial_records_sha256,
  };
  inspectMetadataSigningBinding(facts, binding, facts.previous_site_pins);
  const owned: Owned = {
    session,
    directory,
    work,
    deadline,
    files: inventory(source),
    descriptor: prepared.descriptor,
    control_facts: {
      pause: structuredClone(current.pause),
      capacity: structuredClone(current.capacity),
    },
    facts,
    binding,
    observed: -Infinity,
    bootstrap_observed: -Infinity,
  };
  try {
    for (const [name, bytes] of source) {
      remaining(owned);
      const file = await assertOwnedUnlinkedPath(
        directory,
        path.join(directory, name),
        "metadata public context",
      );
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    }
    const receipt = Object.freeze({
      kind: "actual-coordinator-metadata-signing-context",
      mode: session.mode,
      authority: "none",
    });
    contexts.set(receipt, owned);
    await requireCoordinatorSigningContext(receipt);
    return receipt;
  } catch {
    await writeFile(
      path.join(work, "refusal.json"),
      JSON.stringify({ phase: "metadata-context-preparation", authority: "none" }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error("actual metadata context refused; retain public inputs");
  }
}
/** Only an actual executor and its independently observed existing durable
 * metadata pending can advance this private context across its original CP. */
export async function bindCoordinatorSigningContextPending(
  receipt: object,
  executor: Executor,
  pending: { checkpoint: string; operation_id: string },
) {
  const owned = contexts.get(receipt);
  if (!owned) throw new Error("actual coordinator metadata context required");
  remaining(owned);
  const expected = structuredClone(pending);
  if (
    Object.keys(expected).sort().join(",") !== "checkpoint,operation_id" ||
    !/^[a-f0-9]{40}$/u.test(expected.checkpoint) ||
    !/^[a-f0-9]{64}$/u.test(expected.operation_id) ||
    owned.pending
  )
    throw new Error("one exact coordinator metadata pending required");
  const identity = await refreshCapacityExecutor(executor),
    tools = await verifiedControllerToolPaths(owned.session.tools);
  if (
    identity.role !== "coordinator" ||
    identity.controller_revision !== tools.identity.controller_revision ||
    identity.execution_ref !== tools.identity.controller_ref ||
    identity.run_id !== tools.identity.run_id ||
    identity.run_attempt !== tools.identity.run_attempt
  )
    throw new Error("metadata context executor differs from actual preparing coordinator");
  const state = await snapshot(owned);
  if (state.checkpoint !== expected.checkpoint)
    throw new Error("metadata pending checkpoint changed");
  owned.pending = { executor, ...expected };
  await verifyState(owned, state);
  await requireCoordinatorSigningContext(receipt);
}
export async function requireCoordinatorSigningContext(receipt: object, phaseDeadline?: number) {
  const owned = contexts.get(receipt);
  if (!owned) throw new Error("actual coordinator metadata context required");
  if (phaseDeadline !== undefined) {
    remaining({ deadline: phaseDeadline });
    owned.deadline = Math.min(owned.deadline, phaseDeadline);
  }
  remaining(owned);
  const tools = await verifiedControllerToolPaths(owned.session.tools),
    prepared =
      owned.session.mode === "renewal"
        ? await inspectPreparedMetadataRenewal(owned.session.preparation)
        : await inspectPreparedMetadataBootstrap(owned.session.preparation),
    site =
      owned.session.mode === "renewal"
        ? await requirePublishedCompleteSite(owned.session.complete_site)
        : null;
  if (
    digest(prepared.descriptor) !== digest(owned.descriptor) ||
    digest(inventory(await readBoundedReleaseContextFiles(owned.directory))) !== digest(owned.files)
  )
    throw new Error("actual metadata context retained bytes changed");
  const current = await controls(owned);
  await verifyState(owned, await snapshot(owned));
  if (site) await readPublicApplicationSiteMarker(site.generation, owned.deadline);
  else if (performance.now() - owned.bootstrap_observed >= 45000) {
    if (owned.session.mode === "bootstrap" && owned.session.catalog_site) {
      const readback = await readConfiguredCatalogOnlyBootstrapSite(
        apiFor(owned),
        owned.session.catalog_pins,
        owned.session.catalog_site,
        owned.deadline,
      );
      if (digest(readback) !== owned.facts.catalog_readback_sha256)
        throw new Error("metadata catalog baseline readback changed");
    } else await readConfiguredBootstrapSite(apiFor(owned), owned.deadline);
    owned.bootstrap_observed = performance.now();
  }
  remaining(owned);
  return Object.freeze({
    mode: owned.session.mode,
    directory: owned.directory,
    context: path.join(owned.directory, "context.json"),
    binding: structuredClone(owned.binding),
    facts: structuredClone(owned.facts),
    control_facts: {
      pause: structuredClone(current.pause),
      capacity: structuredClone(current.capacity),
    },
    tools,
    capacity_source: current.capacity_source,
    deadline: owned.deadline,
    tools_receipt: owned.session.tools,
    previous_site: site,
    namespace: owned.session.namespace,
    coordinator_repository: owned.session.repository,
    checkpoint: owned.pending?.checkpoint ?? owned.session.checkpoint,
    descriptor: structuredClone(owned.descriptor),
    authority: "none" as const,
  });
}
export async function readCoordinatorSigningContextFiles(receipt: object) {
  const current = await requireCoordinatorSigningContext(receipt);
  const files = await readBoundedReleaseContextFiles(current.directory);
  const owned = contexts.get(receipt);
  if (!owned || digest(inventory(files)) !== digest(owned.files))
    throw new Error("metadata public context changed during final readback");
  remaining(owned);
  return files;
}
