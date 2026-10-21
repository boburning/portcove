/** Catalog context custody. Only the actual coordinator preparation can enter
 * this map; a manifest or a copied inspection is never a capability. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
import {
  requireActualCoordinatorCatalogPreparation,
  catalogCoordinatorMaintenanceIdentity,
} from "./release-coordinator-driver.mts";
import {
  requireControllerCatalogPublicationAuthorities,
  assertControllerCatalogPublisherScope,
} from "./release-authority-configuration.mts";
import {
  requireActualCatalogInspection,
  readCatalogPublicationBundle,
} from "./release-catalog-inspection.mts";
import { verifiedControllerToolPaths } from "./release-controller-tool-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { readBoundedReleaseContextFiles } from "./release-signing-context.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import {
  readRemoteCoordinatorSnapshot,
  inspectRemoteCommitObject,
  inspectRemoteGitObject,
} from "./release-coordinator-recovery.mts";
import { inspectReleaseSourceTree } from "./release-source-changes.mts";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import {
  materializePublishedCatalogCompleteSite,
  requirePublishedCatalogCompleteSite,
  materializePublishedCompleteSite,
  requirePublishedCompleteSite,
} from "./release-site-readback.mts";
import {
  assertCatalogPublicationBaseline,
  inspectPublishedCatalogMetadata,
} from "./release-catalog-metadata-contract.mts";
import { inspectCapacityOperation } from "./release-capacity.mts";
import {
  refreshCapacityExecutor,
  capacityExecutorIdentity,
  authenticateCapacityExecutor,
  executeOwnedCapacityEffect,
} from "./release-capacity-executor.mts";
import {
  prepareCatalogSigningContextArtifact,
  handoffSigningContextArtifact,
  signingContextPredicateType,
} from "./release-signing-context-artifact.mts";
import { controllerOidcSubject } from "./assembler-job-identity.mts";
import { releaseControlPhaseProfile } from "./release-control-phases.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import {
  catalogSigningRoles,
  catalogSigningContextBytes,
  inspectCatalogSigningBinding,
  inspectCatalogSigningFacts,
  inspectCatalogSigningPreflight,
} from "./release-catalog-signing-contract.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const wireTime = (milliseconds: number) =>
  new Date(milliseconds).toISOString().replace(/(\.[0-9]*?[1-9])0+Z$|\.0+Z$/u, "$1Z");
const inventory = (files: ReadonlyMap<string, Buffer>) =>
  [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) }));
type Session = Awaited<ReturnType<typeof requireActualCoordinatorCatalogPreparation>>;
type Executor = Parameters<typeof capacityExecutorIdentity>[0];
type Owned = {
  session: Session;
  directory: string;
  work: string;
  deadline: number;
  files: ReturnType<typeof inventory>;
  facts: ReturnType<typeof inspectCatalogSigningFacts>;
  binding: ReturnType<typeof inspectCatalogSigningBinding>["binding"];
  configuration_sha256: string;
  control_identity: string;
  observed: number;
  source: Session["controls"];
  site: object | null;
  site_component: "catalog" | "application" | null;
  pending?: { executor: Executor; checkpoint: string; operation_id: string };
};
const contexts = new WeakMap<object, Owned>();
function remaining(owned: { deadline: number }, max = 15000) {
  const left = Math.floor(owned.deadline - performance.now());
  if (!Number.isFinite(left) || left < 1)
    throw new Error("catalog context original deadline exhausted");
  return Math.min(left, max);
}
function apiFor(owned: Pick<Owned, "directory" | "work" | "deadline">) {
  let reads = 0;
  const env = {
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
    if (++reads > 32) throw new Error("catalog context bounded GET budget exhausted");
    const response = createGitHubRunner({
      cwd: owned.directory,
      maxBuffer: 2 * 1024 ** 2,
      timeoutMs: remaining(owned),
      spawn: (command, args, settings) => spawnSync(command, args, { ...settings, env }),
    })([...args, "--hostname", "github.com"], input);
    remaining(owned);
    return response;
  });
}
/** Fixed ratified Git paths, complete bounded raw tree and exact Git blob hash.
 * This authenticates public bytes, not a new publisher or trust root. */
export function readCatalogPublicAnchors(
  api: Pick<GitHubApiClient, "request">,
  pins: {
    commit: string;
    root: { path: string; bytes: number; sha256: string };
    offline_targets: { path: string; bytes: number; sha256: string };
  },
  deadline: number,
) {
  const get = (route: string) => {
    remaining({ deadline });
    const response = api.request("GET", `repos/boburning/portcove/${route}`);
    remaining({ deadline });
    if (response.status !== 200) throw new Error("catalog public source unavailable");
    return response.body;
  };
  const commit = inspectRemoteCommitObject(get(`git/commits/${pins.commit}`), pins.commit),
    tree = inspectReleaseSourceTree(get(`git/trees/${commit.tree}?recursive=1`), commit.tree);
  const result = new Map<string, Buffer>();
  for (const [name, pin] of [
    ["trusted-root.json", pins.root],
    ["offline-targets.json", pins.offline_targets],
  ] as const) {
    const entry = tree.entries.get(pin.path);
    if (
      !entry ||
      entry.type !== "blob" ||
      entry.mode !== "100644" ||
      pin.bytes < 1 ||
      pin.bytes > 128 * 1024
    )
      throw new Error("catalog anchor is not bounded regular Git input");
    const body = get(`git/blobs/${entry.oid}`);
    if (
      !isRecord(body) ||
      body.sha !== entry.oid ||
      body.size !== pin.bytes ||
      body.encoding !== "base64" ||
      typeof body.content !== "string" ||
      body.content.length > 180 * 1024
    )
      throw new Error("catalog anchor Git response differs");
    const encoded = body.content.replace(/\n/gu, ""),
      bytes = Buffer.from(encoded, "base64");
    if (
      bytes.toString("base64") !== encoded ||
      bytes.length !== pin.bytes ||
      hash(bytes) !== pin.sha256
    )
      throw new Error("catalog anchor ratified pin differs");
    inspectRemoteGitObject("blob", entry.oid, bytes);
    result.set(name, bytes);
  }
  return result;
}
async function snapshot(owned: Owned) {
  return readRemoteCoordinatorSnapshot(
    owned.directory,
    { schema_version: 1, namespace: owned.session.namespace },
    { transport: { cwd: owned.directory, deadline: owned.deadline } },
  );
}
async function verifyState(owned: Owned) {
  const current = await snapshot(owned),
    descriptor = assertCatalogPublicationBaseline(current.input.catalog_publication, current.input);
  if (
    digest(descriptor) !== digest(owned.facts.descriptor) ||
    current.input.active_candidate != null
  )
    throw new Error("catalog durable subject changed");
  if (!owned.pending) {
    if (current.checkpoint !== owned.session.checkpoint)
      throw new Error("catalog original checkpoint changed");
    return current;
  }
  const controller = current.input.controller,
    op = inspectCapacityOperation(
      isRecord(controller) && isRecord(controller.capacity_attempt)
        ? controller.capacity_attempt.operation
        : null,
    ),
    actual = await refreshCapacityExecutor(owned.pending.executor);
  if (
    !op ||
    op.id !== owned.pending.operation_id ||
    op.catalog_publication?.descriptor_sha256 !== digest(descriptor) ||
    op.kind !== "upload" ||
    op.destination !== "github-actions:boburning/portcove:catalog-publication-context" ||
    digest(op.executor_identity) !== digest(actual) ||
    !["pending", "succeeded", "recovered"].includes(String(op.outcome))
  )
    throw new Error("catalog context is not exact owned upload");
  return current;
}
export async function prepareActualCatalogSigningContext(
  preparation: object,
  parent: string,
  phaseDeadline?: number,
) {
  const session = await requireActualCoordinatorCatalogPreparation(preparation, phaseDeadline),
    deadline = session.deadline;
  return withCoordinatorDeadline(deadline, () => prepareContext(session, parent));
}
async function prepareContext(session: Session, parent: string) {
  const deadline = session.deadline;
  await assertOwnedUnlinkedPath(
    path.dirname(session.directory),
    parent,
    "catalog context private parent",
  );
  const work = await mkdtemp(path.join(parent, "catalog-signing-context-")),
    directory = path.join(work, "context");
  await mkdir(directory, { mode: 0o700 });
  const partial = { work, directory, deadline },
    api = apiFor(partial),
    authorities = await requireControllerCatalogPublicationAuthorities("coordinator"),
    pins = authorities.catalog.public_source;
  if (
    session.namespace !== authorities.namespace ||
    session.descriptor.publisher_configuration_sha256 !== authorities.configuration_sha256 ||
    session.descriptor.prior.catalog_root_sha256 !== pins.root.sha256
  )
    throw new Error("catalog context ratified authority differs");
  const files = readCatalogPublicAnchors(api, pins, deadline),
    bundle = await readCatalogPublicationBundle(session.inspection.bundle, deadline);
  assertControllerCatalogPublisherScope(authorities, session.inspection.inspection, bundle);
  for (const [name, bytes] of bundle) files.set(`bundle/${name}`, bytes);
  const manifest = await readControllerToolFile(
    path.join(session.inspection.directory, "inspection.json"),
    4 * 1024 ** 2,
  );
  if (hash(manifest) !== session.descriptor.core_inspection_sha256)
    throw new Error("catalog original Core manifest changed");
  files.set("core-inspection.json", manifest);
  let site: object | null = null,
    site_component: Owned["site_component"] = null;
  const prior = session.descriptor.prior;
  if (prior.site_generation_sha256 !== null) {
    if (typeof prior.site_generation_sha256 !== "string")
      throw new Error("catalog prior site digest absent");
    if (prior.catalog_repository_sha256 !== null) {
      if (typeof prior.catalog_repository_sha256 !== "string")
        throw new Error("catalog prior repository digest absent");
      const observed = await materializePublishedCatalogCompleteSite(
        {
          repository_sha256: prior.catalog_repository_sha256,
          root_sha256: prior.catalog_root_sha256,
          site_generation_sha256: prior.site_generation_sha256,
        },
        work,
        deadline,
      );
      site = observed.receipt;
      site_component = "catalog";
      for (const [name, bytes] of await readBoundedReleaseContextFiles(observed.catalog))
        files.set(`prior/${name}`, bytes);
    } else {
      if (
        typeof prior.application_repository_sha256 !== "string" ||
        typeof prior.application_root_sha256 !== "string"
      )
        throw new Error("catalog initial existing site lacks authenticated app tuple");
      const observed = await materializePublishedCompleteSite(
        {
          repository_sha256: prior.application_repository_sha256,
          root_sha256: prior.application_root_sha256,
          site_generation_sha256: prior.site_generation_sha256,
        },
        work,
        deadline,
      );
      site = observed.receipt;
      site_component = "application";
    }
  }
  const state = await readRemoteCoordinatorSnapshot(
      directory,
      { schema_version: 1, namespace: session.namespace },
      { transport: { cwd: directory, deadline } },
    ),
    seed = inspectPublishedCatalogMetadata(state.input.published_catalog_metadata);
  if (
    state.checkpoint !== session.checkpoint ||
    (seed?.repository_sha256 ?? null) !== prior.catalog_repository_sha256
  )
    throw new Error("catalog prior role seed changed");
  const generated_at = wireTime(Date.now()),
    at = Date.parse(generated_at),
    versions = Object.fromEntries(
      catalogSigningRoles.map((role) => [
        role,
        (seed ? BigInt(seed.versions[role]) + 1n : 1n).toString(),
      ]),
    );
  const anchorExpiries = [...files]
    .filter(([name]) => name === "trusted-root.json" || name === "offline-targets.json")
    .map(([, bytes]) => {
      const raw: unknown = JSON.parse(bytes.toString("utf8"));
      if (
        !isRecord(raw) ||
        !isRecord(raw.signed) ||
        typeof raw.signed.expires !== "string" ||
        !Number.isFinite(Date.parse(raw.signed.expires))
      )
        throw new Error("catalog public anchor expiry malformed");
      return Date.parse(raw.signed.expires);
    });
  const ceiling = Math.min(...anchorExpiries),
    expires = Object.fromEntries(
      catalogSigningRoles.map((role) => [
        role,
        wireTime(Math.min(ceiling, at + (role === "timestamp" ? 86400000 : 7 * 86400000))),
      ]),
    );
  const facts = inspectCatalogSigningFacts({
    kind: "catalog-signing",
    namespace: session.namespace,
    descriptor: session.descriptor,
    semantic_opportunity: session.semantic.opportunity,
    semantic_check_id: session.semantic.check_id,
    semantic_proof_sha256: session.semantic.proof_sha256,
    generated_at,
    root_sha256: pins.root.sha256,
    offline_targets_sha256: pins.offline_targets.sha256,
    versions,
    expires,
  });
  const context = catalogSigningContextBytes(facts);
  files.set("context.json", context);
  const priorSite = site
    ? await (site_component === "catalog"
        ? requirePublishedCatalogCompleteSite(site)
        : requirePublishedCompleteSite(site))
    : null;
  inspectCatalogSigningPreflight(files, priorSite?.generation.files ?? []);
  const binding = inspectCatalogSigningBinding(
    facts,
    {
      source_commit: facts.descriptor.source_commit,
      source_tree: facts.descriptor.source_tree,
      bundle_sha256: facts.descriptor.bundle_sha256,
      core_inspection_sha256: facts.descriptor.core_inspection_sha256,
      descriptor_sha256: digest(facts.descriptor),
      root_sha256: facts.root_sha256,
      offline_targets_sha256: facts.offline_targets_sha256,
      semantic_proof_sha256: facts.semantic_proof_sha256,
      context_sha256: hash(context),
    },
    prior,
  ).binding;
  const current = session.controls.readMaintenance(api),
    owned: Owned = {
      session,
      directory,
      work,
      deadline,
      files: inventory(files),
      facts,
      binding,
      configuration_sha256: authorities.configuration_sha256,
      control_identity: catalogCoordinatorMaintenanceIdentity(current),
      observed: performance.now(),
      source: session.controls,
      site,
      site_component,
    };
  try {
    for (const [name, bytes] of files) {
      remaining(owned);
      const destination = await assertOwnedUnlinkedPath(
        directory,
        path.join(directory, name),
        "catalog context public input",
      );
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    }
    const receipt = Object.freeze({ kind: "actual-catalog-signing-context", authority: "none" });
    contexts.set(receipt, owned);
    await requireActualCatalogSigningContext(receipt);
    return receipt;
  } catch (error) {
    await writeFile(
      path.join(work, "refusal.json"),
      JSON.stringify({ phase: "catalog-context", authority: "none", automatic_retry: false }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw new Error(`catalog context refused; retain ${work}`, { cause: error });
  }
}
export async function bindActualCatalogSigningContextPending(
  receipt: object,
  executor: Executor,
  pending: { checkpoint: string; operation_id: string },
) {
  const owned = contexts.get(receipt);
  if (!owned) throw new Error("actual catalog context required");
  remaining(owned);
  pending = structuredClone(pending);
  if (
    owned.pending ||
    Object.keys(pending).sort().join(",") !== "checkpoint,operation_id" ||
    !/^[a-f0-9]{40}$/u.test(pending.checkpoint) ||
    !/^[a-f0-9]{64}$/u.test(pending.operation_id)
  )
    throw new Error("one exact catalog pending required");
  const actual = await refreshCapacityExecutor(executor),
    tools = await verifiedControllerToolPaths(owned.session.tools);
  if (
    actual.role !== "coordinator" ||
    actual.controller_revision !== tools.identity.controller_revision ||
    actual.execution_ref !== tools.identity.controller_ref ||
    actual.run_id !== tools.identity.run_id ||
    actual.run_attempt !== tools.identity.run_attempt
  )
    throw new Error("catalog upload executor differs from actual producer");
  if ((await snapshot(owned)).checkpoint !== pending.checkpoint)
    throw new Error("catalog upload pending checkpoint changed");
  owned.pending = { executor, ...pending };
  await requireActualCatalogSigningContext(receipt);
}
export async function requireActualCatalogSigningContext(receipt: object, phaseDeadline?: number) {
  const owned = contexts.get(receipt);
  if (!owned) throw new Error("actual same-process catalog context required");
  if (phaseDeadline !== undefined) {
    remaining({ deadline: phaseDeadline });
    owned.deadline = Math.min(owned.deadline, phaseDeadline);
  }
  return withCoordinatorDeadline(owned.deadline, () => readContext(receipt));
}
async function readContext(receipt: object) {
  const owned = contexts.get(receipt);
  if (!owned) throw new Error("actual same-process catalog context required");
  remaining(owned);
  const authorities = await requireControllerCatalogPublicationAuthorities("coordinator"),
    inspection = await requireActualCatalogInspection(
      owned.session.inputs.inspection,
      owned.deadline,
    ),
    bundle = await readCatalogPublicationBundle(inspection.bundle, owned.deadline);
  if (authorities.configuration_sha256 !== owned.configuration_sha256)
    throw new Error("catalog protected authority changed");
  assertControllerCatalogPublisherScope(authorities, inspection.inspection, bundle);
  const api = apiFor(owned),
    semantic = await owned.session.recheck_semantic(owned.deadline);
  if (
    semantic.proof_sha256 !== owned.facts.semantic_proof_sha256 ||
    inspection.tools_receipt !== owned.session.tools ||
    inspection.inspection_sha256 !== owned.facts.descriptor.core_inspection_sha256 ||
    inspection.bundle_sha256 !== owned.facts.descriptor.bundle_sha256
  )
    throw new Error("catalog actual inspection/semantic proof changed");
  if (performance.now() - owned.observed >= 45000) {
    owned.source = await owned.session.next_controls(owned.deadline);
    owned.observed = performance.now();
  }
  const current = owned.source.readMaintenance(api);
  if (catalogCoordinatorMaintenanceIdentity(current) !== owned.control_identity)
    throw new Error("catalog actual controls changed");
  await verifyState(owned);
  if (owned.site)
    await (owned.site_component === "catalog"
      ? requirePublishedCatalogCompleteSite(owned.site)
      : requirePublishedCompleteSite(owned.site));
  const tools = await verifiedControllerToolPaths(owned.session.tools);
  if (
    digest(inventory(await readBoundedReleaseContextFiles(owned.directory))) !== digest(owned.files)
  )
    throw new Error("catalog retained public context changed");
  remaining(owned);
  return {
    directory: owned.directory,
    context: path.join(owned.directory, "context.json"),
    facts: structuredClone(owned.facts),
    binding: structuredClone(owned.binding),
    control_facts: {
      pause: structuredClone(current.pause),
      capacity: structuredClone(current.capacity),
    },
    capacity_source: current.capacity_source,
    tools,
    tools_receipt: owned.session.tools,
    previous_site: null,
    namespace: owned.session.namespace,
    coordinator_repository: owned.session.repository,
    checkpoint: owned.pending?.checkpoint ?? owned.session.checkpoint,
    descriptor: structuredClone(owned.facts.descriptor),
    deadline: owned.deadline,
    authority: "none" as const,
  };
}
export async function readActualCatalogSigningContextFiles(receipt: object) {
  const current = await requireActualCatalogSigningContext(receipt),
    owned = contexts.get(receipt);
  const files = await readBoundedReleaseContextFiles(current.directory);
  if (!owned || digest(inventory(files)) !== digest(owned.files))
    throw new Error("catalog context changed during final read");
  remaining(owned);
  return files;
}
/** Same-bundle coordinator continuation. A pending/ambiguous prior context
 * refuses in the actual preparation getter; no automatic replay is attempted. */
export async function completeCoordinatorCatalogSigningContext(
  preparation: object,
  parent: string,
  phaseDeadline?: number,
) {
  const receipt = await prepareActualCatalogSigningContext(preparation, parent, phaseDeadline),
    context = await requireActualCatalogSigningContext(receipt),
    deadline = context.deadline;
  return withCoordinatorDeadline(deadline, async () => {
    remaining({ deadline });
    const authorities = await requireControllerCatalogPublicationAuthorities("coordinator"),
      identity = {
        audience: "portcove-capacity-executor",
        subject: controllerOidcSubject(
          context.tools.identity.controller_ref,
          releaseControlPhaseProfile("coordinator").reader_environment,
        ),
        controller_revision: context.tools.identity.controller_revision,
        controller_ref: context.tools.identity.controller_ref,
        run_id: context.tools.identity.run_id,
        run_attempt: context.tools.identity.run_attempt,
        actor_id: authorities.apps.dispatch.actor_id,
      };
    const executor = await authenticateCapacityExecutor("coordinator", identity, parent, deadline),
      artifact = await prepareCatalogSigningContextArtifact(receipt, parent);
    await writeFile(
      path.join(parent, "catalog-context-session.json"),
      JSON.stringify({ schema_version: 1, directory: artifact.directory }),
      { flag: "wx", mode: 0o600 },
    );
    let handoff: Awaited<ReturnType<typeof handoffSigningContextArtifact>> | undefined;
    try {
      const current = await requireActualCatalogSigningContext(receipt, deadline),
        settlement = await executeOwnedCapacityEffect(
          executor,
          {
            repository: current.coordinator_repository,
            checkpoint: current.checkpoint,
            remote_configuration: { schema_version: 1, namespace: current.namespace },
            catalog_publication: current.descriptor,
            request: {
              kind: "upload",
              destination: "github-actions:boburning/portcove:catalog-publication-context",
            },
          },
          async () =>
            (await requireActualCatalogSigningContext(receipt, deadline)).capacity_source.capacity
              .boundary,
          async (pending) => {
            await bindActualCatalogSigningContextPending(receipt, executor, pending);
            handoff = await handoffSigningContextArtifact(artifact, identity, pending, deadline);
            await requireActualCatalogSigningContext(receipt, deadline);
            return {
              remote_identity: `github-actions:boburning/portcove:artifact:${handoff.artifact_id}`,
              evidence_sha256: handoff.predicate_sha256,
            };
          },
        );
      if (!handoff) throw new Error("catalog context upload has no independently read back output");
      await requireActualCatalogSigningContext(receipt, deadline);
      const result = Object.freeze({
        decision: "catalog-context-prepared",
        mode: "catalog",
        attestation_required: true,
        directory: artifact.directory,
        artifact: { id: handoff.artifact_id, sha256: handoff.sha256 },
        manifest_sha256: handoff.manifest_sha256,
        predicate_path: path.join(artifact.directory, "signing-context-predicate.json"),
        subject_path: path.join(artifact.directory, "signing-context-manifest.json"),
        subject_name: "catalog-signing-context-manifest",
        predicate_type: signingContextPredicateType,
        subject_digest: handoff.manifest_sha256,
        settlement,
        pending_obligations: [
          "actual-context-attestation",
          "four-isolated-catalog-role-envelopes",
          "keyless-Tough-assembly",
          "catalog-publication-and-public-readback",
        ],
        authority: "none",
      });
      await writeFile(path.join(parent, "catalog-context-result.json"), JSON.stringify(result), {
        flag: "wx",
        mode: 0o600,
      });
      remaining({ deadline });
      return result;
    } catch (error) {
      await writeFile(
        path.join(artifact.directory, "controller-refusal.json"),
        JSON.stringify({
          phase: "catalog-context-upload",
          authority: "none",
          automatic_retry: false,
        }),
        { flag: "wx", mode: 0o600 },
      ).catch(() => {});
      throw new Error("catalog context stopped; retain public inputs and original pending", {
        cause: error,
      });
    }
  });
}
