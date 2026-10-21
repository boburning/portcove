/** Four isolated catalog roles and keyless assembly. No app candidate, native
 * completion or catalog publication is manufactured by these adapters. */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify, isDeepStrictEqual } from "node:util";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
import {
  catalogSigningRoles,
  catalogRoleDependencies,
  inspectCatalogSigningRole,
  inspectCatalogSigningBinding,
} from "./release-catalog-signing-contract.mts";
import {
  requireReceivedCatalogSigningContext,
  requireRetainedCatalogSigningContext,
  receiveCatalogSigningContextArtifact,
  signingContextRemaining,
} from "./release-signing-context-artifact.mts";
import type { SigningContextArtifactExpected } from "./release-signing-context-artifact.mts";
import {
  requireReceivedCatalogRoleArtifact,
  requireRetainedCatalogRoleArtifact,
  receiveCatalogRoleArtifact,
  catalogRolePredicateType,
} from "./release-tuf-role-artifact.mts";
import { signIsolatedCatalogTufRole, decodeTufRoleKey } from "./release-tuf-signing.mts";
import {
  verifiedControllerToolPaths,
  receiveControllerTools,
} from "./release-controller-tool-admission.mts";
import type { ControllerToolArtifactExpected } from "./release-controller-tool-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import {
  requireControllerCatalogPublicationAuthorities,
  assertControllerCatalogPublisherScope,
} from "./release-authority-configuration.mts";
import { authenticateCatalogReleaseControlRound } from "./release-live-control-admission.mts";
import {
  authenticateCapacityExecutor,
  capacityExecutorIdentity,
  refreshCapacityExecutor,
  executeOwnedCapacityEffect,
} from "./release-capacity-executor.mts";
import { inspectAssemblerIdentityExpectation } from "./assembler-job-identity.mts";
import {
  recoverRemoteCoordinator,
  readRemoteCoordinatorSnapshot,
} from "./release-coordinator-recovery.mts";
import {
  assertCatalogPublicationBaseline,
  inspectCatalogTufPublicationReport,
} from "./release-catalog-metadata-contract.mts";
import {
  readIndependentCatalogSemanticReview,
  releaseControlRefQuery,
} from "./release-control-inputs.mts";
import { semanticReviewCheckName } from "./release-semantic-review.mts";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import { receiveIsolatedRoleKey } from "./release-role-key-channel.mts";
import { handoffSigningOutput } from "./release-signing-handoff.mts";
import { currentCatalogJobDeadline } from "./release-signing-job-budget.mts";
import {
  readCatalogPublicationBundle,
  inspectCatalogCoreReport,
} from "./release-catalog-inspection.mts";
import { readBoundedReleaseContextFiles } from "./release-signing-context.mts";
import { payloadSigningEnvironment } from "./release-payload-signing.mts";
import {
  materializePublishedCatalogCompleteSite,
  requirePublishedCatalogCompleteSite,
} from "./release-site-readback.mts";
import { inspectCapacityOperation } from "./release-capacity.mts";
import { assertCatalogSitePublicationBinding } from "./release-catalog-publication-contract.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
const run = promisify(execFile),
  hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const inventory = (files: ReadonlyMap<string, Buffer>) =>
  [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([target, bytes]) => ({ target, bytes: bytes.length, sha256: hash(bytes) }));
function active(deadline: number) {
  return signingContextRemaining(deadline, 15000);
}
export function catalogRoleControllerDeadline(raw?: number) {
  const ceiling = performance.now() + 115000;
  if (raw !== undefined && (!Number.isFinite(raw) || raw <= performance.now()))
    throw new Error("catalog role original deadline exhausted");
  return raw === undefined ? ceiling : Math.min(raw, ceiling);
}
function fixedApi(directory: string, deadline: number) {
  let reads = 0;
  const client = new GitHubApiClient((args, input) => {
    if (++reads > 32) throw new Error("catalog control read budget exhausted");
    const result = createGitHubRunner({
      cwd: directory,
      maxBuffer: 2 * 1024 ** 2,
      timeoutMs: active(deadline),
    })([...args, "--hostname", "github.com"], input);
    active(deadline);
    return result;
  });
  return {
    request(method: string, endpoint: string, body?: unknown) {
      if (
        method !== "GET" ||
        body !== undefined ||
        !endpoint.startsWith("repos/boburning/portcove/")
      )
        throw new Error("catalog controller permits fixed GET reads only");
      return client.request(method, endpoint);
    },
    graphql(query: string, variables: Record<string, unknown>) {
      if (query !== releaseControlRefQuery) throw new Error("catalog control query differs");
      return client.graphql(query, variables);
    },
  };
}

/** Later jobs reauthenticate the selected Check from their attested immutable
 * context. They do not import or pretend to reconstruct the producer capture. */
export function recheckCatalogSemanticProof(
  api: Parameters<typeof readIndependentCatalogSemanticReview>[0],
  authorities: { apps: { semantic: { app_id: number }; classification: { app_id: number } } },
  rawFacts: unknown,
  rawBinding: unknown,
  prior: unknown,
) {
  const { facts } = inspectCatalogSigningBinding(rawFacts, rawBinding, prior);
  const proof = readIndependentCatalogSemanticReview(
    api,
    {
      schema_version: 1,
      review_app_id: authorities.apps.semantic.app_id,
      writer_app_id: authorities.apps.classification.app_id,
      review_check_name: semanticReviewCheckName,
    },
    facts.semantic_opportunity,
    facts.semantic_check_id,
  );
  if (digest(proof) !== facts.semantic_proof_sha256)
    throw new Error("catalog fresh semantic Check differs from actual producer proof");
  return facts;
}
async function admittedContext(
  contextReceipt: object,
  toolsReceipt: object,
  phase:
    | "coordinator"
    | "site-publication"
    | `catalog-${ReturnType<typeof inspectCatalogSigningRole>}`,
  deadline: number,
) {
  active(deadline);
  const tools = await verifiedControllerToolPaths(toolsReceipt),
    context = await requireReceivedCatalogSigningContext(contextReceipt, deadline),
    manifest = context.manifest,
    authorities = await requireControllerCatalogPublicationAuthorities(phase);
  if (
    !isRecord(manifest.controller) ||
    !isRecord(manifest.control_facts) ||
    manifest.controller.controller_revision !== tools.identity.controller_revision ||
    manifest.controller.controller_ref !== tools.identity.controller_ref ||
    manifest.controller.source_tree !== tools.identity.source_tree
  )
    throw new Error("catalog tool and attested context source differ");
  const { facts, binding } = inspectCatalogSigningBinding(
    manifest.facts,
    manifest.binding,
    manifest.previous_site_pins,
  );
  if (
    facts.namespace !== authorities.namespace ||
    facts.descriptor.publisher_configuration_sha256 !== authorities.configuration_sha256 ||
    facts.root_sha256 !== authorities.catalog.public_source.root.sha256 ||
    facts.offline_targets_sha256 !== authorities.catalog.public_source.offline_targets.sha256
  )
    throw new Error("catalog context and current protected configuration differ");
  const bundle = await readCatalogPublicationBundle(
      path.join(path.dirname(context.context), "bundle"),
      deadline,
    ),
    report = inspectCatalogCoreReport(
      JSON.parse(
        (
          await readControllerToolFile(
            path.join(path.dirname(context.context), "core-inspection.json"),
            4 * 1024 ** 2,
          )
        ).toString("utf8"),
      ),
      bundle,
    );
  assertControllerCatalogPublisherScope(authorities, report, bundle);
  const manifest_sha256 = hash(
    await readControllerToolFile(
      path.join(context.directory, "signing-context-manifest.json"),
      1024 ** 2,
    ),
  );
  return {
    tools,
    context,
    manifest,
    authorities,
    facts,
    binding,
    manifest_sha256,
    control_facts: manifest.control_facts,
  };
}
async function roleInputs(
  contextReceipt: object,
  receipts: readonly object[],
  roles: readonly ReturnType<typeof inspectCatalogSigningRole>[],
  admitted: Awaited<ReturnType<typeof admittedContext>>,
  deadline: number,
) {
  if (receipts.length !== roles.length) throw new Error("exact catalog role receipt set required");
  const files = [];
  for (let index = 0; index < roles.length; index++) {
    const current = await requireReceivedCatalogRoleArtifact(receipts[index]!, deadline);
    if (
      current.role !== roles[index] ||
      current.expected.context_manifest_sha256 !== admitted.manifest_sha256 ||
      current.expected.context_binding_sha256 !== digest(admitted.binding) ||
      current.expected.context_facts_sha256 !== admitted.manifest.facts_sha256
    )
      throw new Error("catalog role does not bind exact context");
    files.push(current.envelope);
  }
  await requireRetainedCatalogSigningContext(contextReceipt, deadline);
  return files;
}
type RoleResult = {
  context: object;
  tools: object;
  dependencies: readonly object[];
  deadline: number;
  directory: string;
  handoff: Awaited<ReturnType<typeof handoffSigningOutput>>;
  predicate: Record<string, unknown>;
  predicate_sha256: string;
};
const results = new WeakMap<object, RoleResult>();
export async function runCatalogRoleController(
  rawRole: unknown,
  rawIdentity: unknown,
  toolsReceipt: object,
  contextReceipt: object,
  rawDependencies: readonly object[],
  parent: string,
  rawDeadline?: number,
) {
  const ceiling = catalogRoleControllerDeadline(rawDeadline),
    role = inspectCatalogSigningRole(rawRole),
    identity = inspectAssemblerIdentityExpectation(structuredClone(rawIdentity)),
    deadline = currentCatalogJobDeadline(`catalog-${role}`, identity, parent, ceiling);
  return withCoordinatorDeadline(deadline, () =>
    runRole(rawRole, rawIdentity, toolsReceipt, contextReceipt, rawDependencies, parent, deadline),
  );
}
async function runRole(
  rawRole: unknown,
  rawIdentity: unknown,
  toolsReceipt: object,
  contextReceipt: object,
  rawDependencies: readonly object[],
  parent: string,
  rawDeadline?: number,
) {
  const deadline = catalogRoleControllerDeadline(rawDeadline),
    role = inspectCatalogSigningRole(rawRole),
    phase = `catalog-${role}` as const,
    identity = inspectAssemblerIdentityExpectation(structuredClone(rawIdentity)),
    dependencies = Array.from(rawDependencies);
  active(deadline);
  if (!path.isAbsolute(parent)) throw new Error("private catalog role parent required");
  const admitted = await admittedContext(contextReceipt, toolsReceipt, phase, deadline),
    { tools, context, manifest, authorities, facts, binding } = admitted;
  if (
    identity.controller_revision !== tools.identity.controller_revision ||
    identity.controller_ref !== tools.identity.controller_ref ||
    identity.run_id !== tools.identity.run_id ||
    identity.run_attempt !== tools.identity.run_attempt ||
    identity.actor_id !== authorities.apps.dispatch.actor_id ||
    identity.audience !== "portcove-capacity-executor"
  )
    throw new Error("catalog actual executor/tool identity differs");
  const signed = await roleInputs(
      contextReceipt,
      dependencies,
      catalogRoleDependencies(role),
      admitted,
      deadline,
    ),
    directory = await mkdtemp(path.join(parent, `${phase}-controller-`));
  await writeFile(
    path.join(parent, `${phase}-session.json`),
    JSON.stringify({ schema_version: 1, role, directory }),
    { flag: "wx", mode: 0o600 },
  );
  let progress = "current-catalog-reservation";
  try {
    const coordinator = { schema_version: 1, namespace: authorities.namespace },
      recovered = await recoverRemoteCoordinator(directory, coordinator, {
        transport: { cwd: directory, deadline },
      });
    let checkpoint = recovered.checkpoint;
    const reservation = (
      state: typeof recovered | Awaited<ReturnType<typeof readRemoteCoordinatorSnapshot>>,
    ) => {
      if (
        state.checkpoint !== checkpoint ||
        state.input.active_candidate != null ||
        digest(assertCatalogPublicationBaseline(state.input.catalog_publication, state.input)) !==
          digest(facts.descriptor)
      )
        throw new Error("catalog role current reservation differs");
    };
    reservation(recovered);
    const executor = await authenticateCapacityExecutor(phase, identity, directory, deadline),
      producer = capacityExecutorIdentity(executor);
    let round = 0,
      observed = -Infinity,
      source: Awaited<ReturnType<typeof authenticateCatalogReleaseControlRound>> | undefined;
    const fresh = async () => {
      active(deadline);
      if (!source || performance.now() - observed >= 45000) {
        if (++round > 3) throw new Error("catalog role control rounds exhausted");
        source = await authenticateCatalogReleaseControlRound(
          path.join(directory, `controls-r${round}`),
          String(manifest.facts_sha256),
          phase,
          round,
          { deadline },
        );
        observed = performance.now();
      }
      if (source.evidence_scope !== "github.com")
        throw new Error("actual catalog control source required");
      const api = fixedApi(directory, deadline),
        current = source.readMaintenance(api);
      if (
        current.purpose !== "catalog-signing-controls" ||
        current.pause.publication_paused ||
        !current.resource_policy_matches_controller ||
        !isDeepStrictEqual(current.pause, admitted.control_facts.pause) ||
        !isDeepStrictEqual(current.capacity, admitted.control_facts.capacity)
      )
        throw new Error("catalog role controls changed");
      recheckCatalogSemanticProof(api, authorities, facts, binding, manifest.previous_site_pins);
      return current;
    };
    const guard = async () => {
      active(deadline);
      await verifiedControllerToolPaths(toolsReceipt);
      await requireRetainedCatalogSigningContext(contextReceipt, deadline);
      for (const dependency of dependencies)
        await requireRetainedCatalogRoleArtifact(dependency, deadline);
      const currentAuthorities = await requireControllerCatalogPublicationAuthorities(phase);
      if (currentAuthorities.configuration_sha256 !== authorities.configuration_sha256)
        throw new Error("catalog role authority changed");
      await fresh();
      reservation(
        await readRemoteCoordinatorSnapshot(directory, coordinator, {
          transport: { cwd: directory, deadline },
        }),
      );
      active(deadline);
    };
    await guard();
    let envelope: Awaited<ReturnType<typeof signIsolatedCatalogTufRole>> | undefined,
      handoff: Awaited<ReturnType<typeof handoffSigningOutput>> | undefined,
      ownedPending: { checkpoint: string; operation_id: string } | undefined;
    const settlement = await executeOwnedCapacityEffect(
      executor,
      {
        repository: recovered.repository,
        checkpoint,
        remote_configuration: coordinator,
        catalog_publication: facts.descriptor,
        request: {
          kind: "upload",
          destination: `github-actions:boburning/portcove:catalog-tuf-role-${role}`,
        },
      },
      async () => (await fresh()).capacity_source.capacity.boundary,
      async (pending) => {
        ownedPending = { ...pending };
        checkpoint = pending.checkpoint;
        await guard();
        progress = "single-appointed-catalog-key";
        const temporary = process.env.RUNNER_TEMP;
        if (!temporary || !path.isAbsolute(temporary))
          throw new Error("catalog isolated role key root unavailable");
        envelope = await signIsolatedCatalogTufRole(
          {
            role,
            context_directory: path.dirname(context.context),
            tool: { path: tools.rust, sha256: hash(await readControllerToolFile(tools.rust)) },
            signed_roles: signed,
            output: path.join(directory, "role-output"),
          },
          {
            deadline,
            beforeKey: guard,
            keyMaterial: async () =>
              receiveIsolatedRoleKey(
                path.join(temporary, `${phase}-key`),
                phase,
                Date.now() + Math.min(30000, active(deadline)),
                async (key, password) => {
                  if (password) throw new Error("catalog role requires unencrypted sole PKCS8 key");
                  return decodeTufRoleKey(key);
                },
              ),
          },
        );
        await guard();
        progress = "immutable-catalog-role-output";
        handoff = await handoffSigningOutput(
          path.join(directory, "handoff"),
          {
            producer,
            pending,
            input_binding_sha256: digest(binding),
            files: [
              {
                filename: envelope.filename,
                path: envelope.path,
                bytes: envelope.bytes,
                sha256: envelope.sha256,
              },
            ],
          },
          deadline,
        );
        await guard();
        return {
          remote_identity: `github-actions:boburning/portcove:artifact:${handoff.artifact.id}`,
          evidence_sha256: digest(handoff),
        };
      },
    );
    if (!envelope || !handoff || !ownedPending)
      throw new Error("actual catalog role output missing");
    checkpoint = settlement.checkpoint;
    await guard();
    if (!isDeepStrictEqual(await refreshCapacityExecutor(executor), producer))
      throw new Error("catalog producing job identity changed");
    const subject = handoff.files.find((file) => file.filename === "signing-output-manifest.json");
    if (!subject) throw new Error("catalog role manifest missing");
    const predicate = {
      schema_version: 1,
      role: phase,
      controller: {
        controller_revision: tools.identity.controller_revision,
        source_tree: tools.identity.source_tree,
        controller_ref: tools.identity.controller_ref,
        run_id: tools.identity.run_id,
        run_attempt: tools.identity.run_attempt,
      },
      producer,
      artifact: handoff.artifact,
      manifest_sha256: subject.sha256,
      context_manifest_sha256: admitted.manifest_sha256,
      context_binding_sha256: digest(binding),
      context_facts_sha256: manifest.facts_sha256,
      envelope: { filename: envelope.filename, bytes: envelope.bytes, sha256: envelope.sha256 },
      pending: ownedPending,
      publication_admission: "not-established",
      authority: "none",
    };
    const bytes = Buffer.from(JSON.stringify(predicate));
    if (bytes.length > 65536) throw new Error("catalog role predicate exceeds inline bound");
    await writeFile(path.join(directory, "predicate.json"), bytes, { flag: "wx", mode: 0o600 });
    const receipt = Object.freeze({
      decision: "catalog-role-output-prepared",
      role,
      directory,
      predicate_path: path.join(directory, "predicate.json"),
      subject_path: path.join(directory, "handoff/output/signing-output-manifest.json"),
      subject_name: "catalog-role-output-manifest",
      subject_digest: subject.sha256,
      predicate_type: catalogRolePredicateType,
      artifact: handoff.artifact,
      settlement,
      pending_obligations: [
        "actual-role-output-attestation",
        "four-role-keyless-Tough-assembly",
        "catalog-publication-and-public-readback",
      ],
      authority: "none",
    });
    results.set(receipt, {
      context: contextReceipt,
      tools: toolsReceipt,
      dependencies,
      deadline,
      directory,
      handoff,
      predicate,
      predicate_sha256: hash(bytes),
    });
    return receipt;
  } catch (error) {
    await writeFile(
      path.join(directory, "refusal.json"),
      JSON.stringify({ phase: progress, role, authority: "none", automatic_retry: false }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw new Error(`catalog role refused; retain ${directory}`, { cause: error });
  }
}
export async function requirePreparedCatalogRoleOutput(receipt: object) {
  const actual = results.get(receipt);
  if (!actual) throw new Error("actual catalog role output required");
  active(actual.deadline);
  await verifiedControllerToolPaths(actual.tools);
  await requireRetainedCatalogSigningContext(actual.context, actual.deadline);
  for (const input of actual.dependencies)
    await requireRetainedCatalogRoleArtifact(input, actual.deadline);
  for (const file of actual.handoff.files) {
    const bytes = await readControllerToolFile(
      path.join(actual.directory, "handoff/output", file.filename),
      file.bytes,
    );
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
      throw new Error("catalog role retained output changed");
  }
  if (
    hash(await readControllerToolFile(path.join(actual.directory, "predicate.json"), 65536)) !==
    actual.predicate_sha256
  )
    throw new Error("catalog predicate changed");
  active(actual.deadline);
  return {
    directory: actual.directory,
    predicate: structuredClone(actual.predicate),
    artifact: structuredClone(actual.handoff.artifact),
    authority: "none",
  };
}

export async function runFixedCatalogRoleConfiguration(
  raw: unknown,
  parent: string,
  rawDeadline?: number,
) {
  const value: unknown = structuredClone(raw),
    processDeadline = catalogRoleControllerDeadline(rawDeadline);
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "context,dependencies,identity,role,tools" ||
    !isRecord(value.tools) ||
    Object.keys(value.tools).sort().join(",") !== "artifact,bundle" ||
    !Array.isArray(value.dependencies)
  )
    throw new Error("fixed catalog role configuration differs");
  const role = inspectCatalogSigningRole(value.role),
    expected = catalogRoleDependencies(role),
    deadline = currentCatalogJobDeadline(
      `catalog-${role}`,
      inspectAssemblerIdentityExpectation(value.identity),
      parent,
      processDeadline,
    );
  if (value.dependencies.length !== expected.length)
    throw new Error("catalog dependency count differs");
  const tools = await receiveControllerTools(
      parent,
      value.tools.artifact as ControllerToolArtifactExpected,
      value.tools.bundle as { artifact_id: number; sha256: string },
      { deadline },
    ),
    context = await receiveCatalogSigningContextArtifact(
      parent,
      value.context as SigningContextArtifactExpected,
      deadline,
    ),
    dependencies = [];
  for (let index = 0; index < expected.length; index++) {
    const locator: unknown = value.dependencies[index];
    if (!isRecord(locator) || locator.role !== expected[index] || locator.purpose !== "catalog")
      throw new Error("catalog dependency order/purpose differs");
    dependencies.push(await receiveCatalogRoleArtifact(context, parent, locator, deadline));
  }
  return runCatalogRoleController(
    role,
    value.identity,
    tools,
    context,
    dependencies,
    parent,
    deadline,
  );
}

type Assembly = {
  recovery_only?: boolean;
  recovery_intent?: { checkpoint: string; operation_sha256: string };
  phase: "coordinator" | "site-publication";
  context: object;
  tools: object;
  roles: readonly object[];
  directory: string;
  repository: string;
  deadline: number;
  report: ReturnType<typeof inspectCatalogTufPublicationReport>;
  files: ReturnType<typeof inventory>;
  proof_files: { path: string; bytes: number; sha256: string }[];
};
const assemblies = new WeakMap<object, Assembly>();
/** Keyless assembly consumes only all four actually attested role receipts.
 * The Rust engine independently verifies anchors, signatures, history and all
 * target bytes; its report is not a permission to deploy. */
export async function assembleActualCatalogRepository(
  contextReceipt: object,
  toolsReceipt: object,
  rawRoles: readonly object[],
  parent: string,
  deadline: number,
) {
  active(deadline);
  return withCoordinatorDeadline(deadline, () =>
    assembleRepository(
      contextReceipt,
      toolsReceipt,
      rawRoles,
      parent,
      deadline,
      "site-publication",
    ),
  );
}
/** GET-only coordinator recovery has its own appointed job admission. This
 * never changes the default publisher's required site-publication identity. */
export async function assembleActualCatalogRepositoryForRecovery(
  contextReceipt: object,
  toolsReceipt: object,
  rawRoles: readonly object[],
  parent: string,
  deadline: number,
) {
  active(deadline);
  return withCoordinatorDeadline(deadline, () =>
    verifyPublishedRepositoryForRecovery(contextReceipt, toolsReceipt, rawRoles, parent, deadline),
  );
}
/** Read-only recovery authenticates the already public, precommitted inventory.
 * It never calls the signing/assembly engine or changes the original clock. */
async function verifyPublishedRepositoryForRecovery(
  contextReceipt: object,
  toolsReceipt: object,
  rawRoles: readonly object[],
  parent: string,
  deadline: number,
) {
  const roles = Array.from(rawRoles),
    admitted = await admittedContext(contextReceipt, toolsReceipt, "coordinator", deadline),
    signed = await roleInputs(contextReceipt, roles, catalogSigningRoles, admitted, deadline),
    directory = await mkdtemp(path.join(parent, "catalog-public-recovery-")),
    scratch = path.join(directory, "work");
  await mkdir(scratch, { mode: 0o700 });
  const remote = { schema_version: 1, namespace: admitted.authorities.namespace };
  const readIntent = async () => {
    const state = await readRemoteCoordinatorSnapshot(directory, remote, {
      transport: { cwd: directory, deadline },
    });
    const controller = state.input.controller,
      operation = inspectCapacityOperation(
        isRecord(controller) && isRecord(controller.capacity_attempt)
          ? controller.capacity_attempt.operation
          : null,
      );
    if (
      !operation ||
      operation.kind !== "upload" ||
      operation.destination !== "github-pages:boburning/portcove:complete-site" ||
      !["succeeded", "recovered"].includes(operation.outcome) ||
      (operation.outcome === "recovered" &&
        operation.recovery?.resolution !== "effect-completed") ||
      operation.completed_effects.length !== 1 ||
      digest(operation.catalog_publication?.descriptor) !== digest(admitted.facts.descriptor) ||
      digest(state.input.catalog_publication) !== digest(admitted.facts.descriptor)
    )
      throw new Error("exact settled catalog Pages intent required for read-only verification");
    return {
      checkpoint: state.checkpoint,
      operation,
      expected: assertCatalogSitePublicationBinding(
        admitted.facts.descriptor,
        operation.catalog_site_expectation,
      ),
    };
  };
  try {
    const intent = await readIntent(),
      publicSite = await materializePublishedCatalogCompleteSite(
        {
          root_sha256: String(intent.expected.catalog_root_sha256),
          repository_sha256: String(intent.expected.catalog_repository_sha256),
          site_generation_sha256: String(intent.expected.site_generation_sha256),
        },
        directory,
        deadline,
      ),
      site = await requirePublishedCatalogCompleteSite(publicSite.receipt),
      repository = site.catalog,
      binary = await readControllerToolFile(admitted.tools.rust),
      tool = path.join(
        scratch,
        process.platform === "win32" ? "portcove-release-tools.exe" : "portcove-release-tools",
      ),
      config = path.join(directory, "verification.json");
    await writeFile(tool, binary, { flag: "wx", mode: 0o700 });
    await writeFile(
      config,
      JSON.stringify({
        schema_version: 1,
        trusted_root: path.join(path.dirname(admitted.context.context), "trusted-root.json"),
        trusted_root_sha256: admitted.facts.root_sha256,
        offline_targets: path.join(path.dirname(admitted.context.context), "offline-targets.json"),
        offline_targets_sha256: admitted.facts.offline_targets_sha256,
        repository,
      }),
      { flag: "wx", mode: 0o600 },
    );
    const env = payloadSigningEnvironment(scratch);
    for (const value of new Set(Object.values(env)))
      if (typeof value === "string" && value.startsWith(scratch))
        await mkdir(value, { recursive: true, mode: 0o700 });
    const result = await run(tool, ["verify-definition-repository", config], {
      cwd: scratch,
      env,
      windowsHide: true,
      timeout: Math.min(90000, Math.floor(deadline - performance.now())),
      maxBuffer: 4 * 1024 ** 2,
      encoding: "utf8",
    });
    await writeFile(path.join(directory, "stdout.json"), result.stdout, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(path.join(directory, "stderr.txt"), result.stderr, { flag: "wx", mode: 0o600 });
    if (result.stderr) throw new Error("read-only catalog verifier stderr not empty");
    const raw: unknown = JSON.parse(result.stdout),
      report = inspectCatalogTufPublicationReport(raw),
      files = await readBoundedReleaseContextFiles(repository);
    if (
      !isRecord(raw) ||
      raw.changed !== false ||
      digest(inventory(files)) !== digest(report.files) ||
      report.facts.repository_sha256 !== intent.expected.catalog_repository_sha256 ||
      report.facts.root_sha256 !== admitted.facts.root_sha256 ||
      report.facts.offline_targets_sha256 !== admitted.facts.offline_targets_sha256 ||
      hash(await readControllerToolFile(tool)) !== hash(binary)
    )
      throw new Error("recovered catalog verifier inventory or public anchors differ");
    for (const [index, role] of catalogSigningRoles.entries()) {
      const wire = role === "definitions" || role === "policy" ? `official-${role}` : role,
        filename =
          role === "timestamp"
            ? "metadata/timestamp.json"
            : `metadata/${admitted.facts.versions[role]}.${wire}.json`,
        envelope = signed[index]!;
      if (
        report.facts.versions[role] !== admitted.facts.versions[role] ||
        report.facts.expires[role] !== admitted.facts.expires[role] ||
        hash(files.get(filename) ?? Buffer.alloc(0)) !== envelope.sha256
      )
        throw new Error("recovered catalog differs from original attested role bytes or clock");
    }
    const core: unknown = JSON.parse(
      (
        await readControllerToolFile(
          path.join(path.dirname(admitted.context.context), "core-inspection.json"),
          4 * 1024 ** 2,
        )
      ).toString("utf8"),
    );
    if (!isRecord(core) || report.facts.index_sha256 !== core.index_sha256)
      throw new Error("recovered catalog index differs from reviewed Core input");
    await admittedContext(contextReceipt, toolsReceipt, "coordinator", deadline);
    await roleInputs(contextReceipt, roles, catalogSigningRoles, admitted, deadline);
    recheckCatalogSemanticProof(
      fixedApi(directory, deadline),
      admitted.authorities,
      admitted.facts,
      admitted.binding,
      admitted.manifest.previous_site_pins,
    );
    await requirePublishedCatalogCompleteSite(publicSite.receipt);
    if (digest(await readIntent()) !== digest(intent))
      throw new Error("catalog recovery intent changed during public verification");
    const proof_files = [];
    for (const name of ["stdout.json", "stderr.txt", "verification.json"]) {
      const bytes = await readControllerToolFile(path.join(directory, name), 4 * 1024 ** 2);
      proof_files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
    }
    const receipt = Object.freeze({ kind: "actual-catalog-read-only-recovery", authority: "none" });
    assemblies.set(receipt, {
      recovery_only: true,
      recovery_intent: {
        checkpoint: intent.checkpoint,
        operation_sha256: digest(intent.operation),
      },
      phase: "coordinator",
      context: contextReceipt,
      tools: toolsReceipt,
      roles,
      directory,
      repository,
      deadline,
      report,
      files: inventory(files),
      proof_files,
    });
    await requireActualCatalogRepositoryForRecovery(receipt, deadline);
    return receipt;
  } catch (error) {
    await writeFile(
      path.join(directory, "refusal.json"),
      JSON.stringify({
        phase: "catalog-read-only-recovery",
        automatic_retry: false,
        authority: "none",
      }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw new Error(`catalog public recovery verification refused; retain ${directory}`, {
      cause: error,
    });
  }
}
async function assembleRepository(
  contextReceipt: object,
  toolsReceipt: object,
  rawRoles: readonly object[],
  parent: string,
  deadline: number,
  phase: "coordinator" | "site-publication",
) {
  active(deadline);
  const roles = Array.from(rawRoles),
    admitted = await admittedContext(contextReceipt, toolsReceipt, phase, deadline),
    signed = await roleInputs(contextReceipt, roles, catalogSigningRoles, admitted, deadline),
    directory = await mkdtemp(path.join(parent, "catalog-keyless-assembly-")),
    scratch = path.join(directory, "work"),
    roleDirectory = path.join(directory, "roles");
  await mkdir(scratch, { mode: 0o700 });
  await mkdir(roleDirectory, { mode: 0o700 });
  const guard = async () => {
    active(deadline);
    const current = await admittedContext(contextReceipt, toolsReceipt, phase, deadline);
    if (current.manifest_sha256 !== admitted.manifest_sha256)
      throw new Error("catalog assembly context changed");
    recheckCatalogSemanticProof(
      fixedApi(directory, deadline),
      current.authorities,
      current.facts,
      current.binding,
      current.manifest.previous_site_pins,
    );
    await roleInputs(contextReceipt, roles, catalogSigningRoles, current, deadline);
  };
  try {
    await guard();
    for (const file of signed) {
      const bytes = await readControllerToolFile(file.path, file.bytes);
      if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
        throw new Error("catalog assembly role bytes changed");
      await writeFile(path.join(roleDirectory, file.filename), bytes, { flag: "wx", mode: 0o600 });
    }
    const binary = await readControllerToolFile(admitted.tools.rust),
      tool = path.join(
        scratch,
        process.platform === "win32" ? "portcove-release-tools.exe" : "portcove-release-tools",
      ),
      repository = path.join(directory, "repository"),
      config = path.join(directory, "assembly.json");
    await writeFile(tool, binary, { flag: "wx", mode: 0o700 });
    await writeFile(
      config,
      JSON.stringify({
        schema_version: 1,
        context: admitted.context.context,
        signed_roles: roleDirectory,
        output: repository,
      }),
      { flag: "wx", mode: 0o600 },
    );
    const env = payloadSigningEnvironment(scratch);
    for (const value of new Set(Object.values(env)))
      if (typeof value === "string" && value.startsWith(scratch))
        await mkdir(value, { recursive: true, mode: 0o700 });
    const result = await run(tool, ["assemble-definition-repository", config], {
      cwd: scratch,
      env,
      windowsHide: true,
      timeout: Math.min(90000, Math.floor(deadline - performance.now())),
      maxBuffer: 4 * 1024 ** 2,
      encoding: "utf8",
    });
    await writeFile(path.join(directory, "stdout.json"), result.stdout, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(path.join(directory, "stderr.txt"), result.stderr, { flag: "wx", mode: 0o600 });
    if (result.stderr) throw new Error("catalog assembler stderr not empty");
    const report = inspectCatalogTufPublicationReport(JSON.parse(result.stdout)),
      files = await readBoundedReleaseContextFiles(repository);
    if (
      digest(inventory(files)) !== digest(report.files) ||
      report.facts.root_sha256 !== admitted.facts.root_sha256 ||
      report.facts.offline_targets_sha256 !== admitted.facts.offline_targets_sha256 ||
      hash(await readControllerToolFile(tool)) !== hash(binary)
    )
      throw new Error("catalog assembler output/tool identity differs");
    await guard();
    const proof_files = [];
    for (const name of [
      "stdout.json",
      "stderr.txt",
      "assembly.json",
      ...signed.map((file) => `roles/${file.filename}`),
    ]) {
      const bytes = await readControllerToolFile(
        path.join(directory, name),
        name === "stdout.json" ? 4 * 1024 ** 2 : 512 * 1024,
      );
      proof_files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
    }
    const receipt = Object.freeze({ kind: "actual-catalog-keyless-assembly", authority: "none" });
    assemblies.set(receipt, {
      phase,
      context: contextReceipt,
      tools: toolsReceipt,
      roles,
      directory,
      repository,
      deadline,
      report,
      files: inventory(files),
      proof_files,
    });
    await requireActualCatalogRepository(receipt);
    return receipt;
  } catch (error) {
    if (isRecord(error))
      for (const key of ["stdout", "stderr"])
        if (typeof error[key] === "string")
          await writeFile(path.join(directory, `failed-${key}.txt`), error[key], {
            flag: "wx",
            mode: 0o600,
          }).catch(() => {});
    await writeFile(
      path.join(directory, "refusal.json"),
      JSON.stringify({
        phase: "catalog-keyless-assembly",
        authority: "none",
        automatic_retry: false,
      }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw new Error(`catalog assembly refused; retain ${directory}`, { cause: error });
  }
}
export async function requireActualCatalogRepository(receipt: object, phaseDeadline?: number) {
  const actual = assemblies.get(receipt);
  if (!actual || actual.recovery_only)
    throw new Error("actual keyless catalog assembly required for live publication");
  if (phaseDeadline !== undefined) {
    active(phaseDeadline);
    actual.deadline = Math.min(actual.deadline, phaseDeadline);
  }
  return withCoordinatorDeadline(actual.deadline, () => readRepository(receipt));
}
/** A read-only recovery receipt cannot enter fresh composition/publication. */
export async function requireActualCatalogRepositoryForRecovery(
  receipt: object,
  phaseDeadline?: number,
) {
  const actual = assemblies.get(receipt);
  if (!actual?.recovery_only || actual.phase !== "coordinator")
    throw new Error("actual read-only catalog recovery verification required");
  if (phaseDeadline !== undefined) {
    active(phaseDeadline);
    actual.deadline = Math.min(actual.deadline, phaseDeadline);
  }
  return withCoordinatorDeadline(actual.deadline, () => readRepository(receipt));
}
async function readRepository(receipt: object) {
  const actual = assemblies.get(receipt);
  if (!actual) throw new Error("actual keyless catalog assembly required");
  active(actual.deadline);
  if (
    actual.recovery_only &&
    Object.values(actual.report.facts.expires).some((expiry) => Date.parse(expiry) <= Date.now())
  )
    throw new Error("recovered catalog metadata expired before handoff");
  const admitted = await admittedContext(
    actual.context,
    actual.tools,
    actual.phase,
    actual.deadline,
  );
  await roleInputs(actual.context, actual.roles, catalogSigningRoles, admitted, actual.deadline);
  recheckCatalogSemanticProof(
    fixedApi(actual.directory, actual.deadline),
    admitted.authorities,
    admitted.facts,
    admitted.binding,
    admitted.manifest.previous_site_pins,
  );
  if (
    digest(inventory(await readBoundedReleaseContextFiles(actual.repository))) !==
    digest(actual.files)
  )
    throw new Error("catalog assembled repository changed");
  for (const file of actual.proof_files) {
    const bytes = await readControllerToolFile(path.join(actual.directory, file.path), file.bytes);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
      throw new Error("catalog assembly retained proof changed");
  }
  active(actual.deadline);
  return {
    directory: actual.directory,
    repository: actual.repository,
    report: structuredClone(actual.report),
    descriptor: admitted.facts.descriptor,
    ...(actual.recovery_intent ? { recovery_intent: structuredClone(actual.recovery_intent) } : {}),
    context_receipt: actual.context,
    tools_receipt: actual.tools,
    deadline: actual.deadline,
    authority: "none",
  };
}
