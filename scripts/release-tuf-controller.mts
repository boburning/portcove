/** Fixed isolated online-role controller. Public context custody alone never
 * releases a key: current controls, current reservation and owned pending must
 * all hold before the worker's one-use key callback can be reached. */
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import {
  inspectTufSigningRole,
  tufRoleDependencies,
  decodeTufRoleKey,
  signIsolatedTufRole,
} from "./release-tuf-signing.mts";
import {
  requireReceivedSigningContext,
  receiveSigningContextArtifact,
  signingContextRemaining,
} from "./release-signing-context-artifact.mts";
import type { SigningContextArtifactExpected } from "./release-signing-context-artifact.mts";
import {
  requireReceivedTufRoleArtifact,
  receiveTufRoleArtifact,
  tufRolePredicateType,
} from "./release-tuf-role-artifact.mts";
import {
  verifiedControllerToolPaths,
  receiveControllerTools,
} from "./release-controller-tool-admission.mts";
import type { ControllerToolArtifactExpected } from "./release-controller-tool-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { requireControllerPublicationAuthorities } from "./release-authority-configuration.mts";
import { inspectAssemblerIdentityExpectation } from "./assembler-job-identity.mts";
import {
  authenticateCapacityExecutor,
  capacityExecutorIdentity,
  refreshCapacityExecutor,
  executeOwnedCapacityEffect,
} from "./release-capacity-executor.mts";
import { authenticateReleaseControlRound } from "./release-live-control-admission.mts";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import { releaseControlRefQuery } from "./release-control-inputs.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  recoverRemoteCoordinator,
  readRemoteCoordinatorSnapshot,
} from "./release-coordinator-recovery.mts";
import { requireReservedAggregate } from "./production-aggregate-steps.mts";
import { receiveIsolatedRoleKey } from "./release-role-key-channel.mts";
import { handoffSigningOutput } from "./release-signing-handoff.mts";
import { isRecord } from "./runtime-values.mts";
import { currentTufJobDeadline } from "./release-tuf-job-budget.mts";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function tufRoleControllerDeadline(raw?: number) {
  const ceiling = performance.now() + 115000; // selected 2-minute job reserves five seconds for terminal cleanup
  if (raw !== undefined && (!Number.isFinite(raw) || raw <= performance.now()))
    throw new Error("TUF role phase deadline exhausted");
  return raw === undefined ? ceiling : Math.min(raw, ceiling);
}
const actualResults = new WeakMap<
  object,
  {
    context: object;
    tools: object;
    dependencies: readonly object[];
    deadline: number;
    predicate: Record<string, unknown>;
    directory: string;
    predicate_sha256: string;
    result: Awaited<ReturnType<typeof handoffSigningOutput>>;
  }
>();

export async function runTufRoleController(
  rawRole: unknown,
  rawIdentity: unknown,
  toolsReceipt: object,
  contextReceipt: object,
  rawDependencies: readonly object[],
  parent: string,
  rawDeadline?: number,
) {
  const deadline = tufRoleControllerDeadline(rawDeadline),
    role = inspectTufSigningRole(rawRole),
    phase = `tuf-${role}` as const,
    dependencies = tufRoleDependencies(role),
    capturedDependencies = Array.from(rawDependencies),
    identity = inspectAssemblerIdentityExpectation(structuredClone(rawIdentity));
  const active = () => {
    signingContextRemaining(deadline, 15000);
  };
  active();
  if (!path.isAbsolute(parent) || capturedDependencies.length !== dependencies.length)
    throw new Error("exact fixed TUF role dependencies required");
  const tools = await verifiedControllerToolPaths(toolsReceipt),
    context = await requireReceivedSigningContext(contextReceipt, deadline),
    manifest = context.manifest,
    authorities = await requireControllerPublicationAuthorities(phase);
  if (
    !isRecord(manifest.controller) ||
    !isRecord(manifest.binding) ||
    !isRecord(manifest.facts) ||
    !isRecord(manifest.facts.configuration) ||
    !isRecord(manifest.control_facts) ||
    typeof manifest.binding.version !== "string" ||
    manifest.facts.configuration.namespace !== authorities.namespace ||
    identity.controller_revision !== tools.identity.controller_revision ||
    identity.controller_ref !== tools.identity.controller_ref ||
    identity.run_id !== tools.identity.run_id ||
    identity.run_attempt !== tools.identity.run_attempt ||
    identity.actor_id !== authorities.apps.dispatch.actor_id ||
    identity.audience !== "portcove-capacity-executor" ||
    manifest.controller.controller_revision !== tools.identity.controller_revision ||
    manifest.controller.controller_ref !== tools.identity.controller_ref ||
    manifest.controller.source_tree !== tools.identity.source_tree
  )
    throw new Error("actual TUF role controller/tool/context/authority identities differ");
  const version = manifest.binding.version;
  const binding = manifest.binding,
    facts = manifest.facts,
    admitted = manifest.control_facts,
    manifestSha = hash(
      await readControllerToolFile(
        path.join(context.directory, "signing-context-manifest.json"),
        1024 * 1024,
      ),
    );
  const signed: Awaited<ReturnType<typeof requireReceivedTufRoleArtifact>>["envelope"][] = [];
  for (let index = 0; index < capturedDependencies.length; index++) {
    const dependency = await requireReceivedTufRoleArtifact(capturedDependencies[index]!, deadline);
    if (
      dependency.role !== dependencies[index] ||
      dependency.expected.context_manifest_sha256 !== manifestSha ||
      dependency.expected.context_binding_sha256 !== digest(binding) ||
      dependency.expected.context_facts_sha256 !== manifest.facts_sha256
    )
      throw new Error("TUF role dependency differs from exact authenticated context");
    signed.push(dependency.envelope);
  }
  const directory = await mkdtemp(path.join(parent, `tuf-${role}-controller-`));
  // A fixed public location lets the trusted later upload step find this one
  // live process's handoff/ready.json without scanning a shared runner root.
  await writeFile(
    path.join(parent, `tuf-${role}-session.json`),
    JSON.stringify({ schema_version: 1, role, directory }),
    { flag: "wx", mode: 0o600 },
  );
  let progress = "current-reservation";
  try {
    const coordinator = { schema_version: 1, namespace: authorities.namespace },
      recovered = await recoverRemoteCoordinator(directory, coordinator, {
        transport: { cwd: directory, deadline },
      });
    let checkpoint = recovered.checkpoint;
    const descriptor = () =>
      JSON.stringify({
        schema_version: 1,
        checkpoint,
        coordinator,
        assembly: facts.assembly,
        archives: facts.archives,
        evidence: {},
      });
    await requireReservedAggregate(descriptor(), recovered);
    if (
      !isRecord(recovered.input.active_candidate) ||
      digest(recovered.input.active_candidate.frozen_opportunity) !== digest(facts.opportunity)
    )
      throw new Error("TUF role frozen opportunity differs from actual current candidate");
    const executor = await authenticateCapacityExecutor(phase, identity, directory, deadline),
      producer = capacityExecutorIdentity(executor);
    let round = 0,
      observed = -Infinity;
    let source: Awaited<ReturnType<typeof authenticateReleaseControlRound>> | undefined;
    const fresh = async () => {
      active();
      if (!source || performance.now() - observed >= 45000) {
        if (++round > 3) throw new Error("TUF role fixed control rounds exhausted");
        source = await authenticateReleaseControlRound(
          path.join(directory, `controls-r${round}`),
          String(manifest.facts_sha256),
          phase,
          round,
          { deadline },
        );
        observed = performance.now();
      }
      if (source.evidence_scope !== "github.com")
        throw new Error("actual TUF control source required");
      let reads = 0;
      const client = new GitHubApiClient((args, input) => {
        if (++reads > 32) throw new Error("TUF role control read budget exhausted");
        const response = createGitHubRunner({
          cwd: directory,
          maxBuffer: 2 * 1024 ** 2,
          timeoutMs: signingContextRemaining(deadline, 15000),
        })([...args, "--hostname", "github.com"], input);
        active();
        return response;
      });
      const current = source.read(
        {
          request(method, endpoint, body) {
            if (
              method !== "GET" ||
              body !== undefined ||
              !endpoint.startsWith("repos/boburning/portcove/")
            )
              throw new Error("TUF role controls require fixed GET reads");
            return client.request(method, endpoint);
          },
          graphql(query, variables) {
            if (query !== releaseControlRefQuery) throw new Error("TUF role control query differs");
            return client.graphql(query, variables);
          },
        },
        facts.opportunity,
      );
      if (
        current.pause.publication_paused ||
        !current.resource_policy_matches_controller ||
        !isDeepStrictEqual(current.classification, admitted.classification) ||
        !isDeepStrictEqual(current.pause, admitted.pause) ||
        !isDeepStrictEqual(current.capacity, admitted.capacity)
      )
        throw new Error("TUF role current controls differ from authenticated release context");
      return current;
    };
    const guard = async () => {
      active();
      await verifiedControllerToolPaths(toolsReceipt);
      await requireReceivedSigningContext(contextReceipt, deadline);
      for (const dependency of capturedDependencies)
        await requireReceivedTufRoleArtifact(dependency, deadline);
      await fresh();
      const snapshot = await readRemoteCoordinatorSnapshot(directory, coordinator, {
        transport: { cwd: directory, deadline },
      });
      await requireReservedAggregate(descriptor(), snapshot);
      if (
        !isRecord(snapshot.input.active_candidate) ||
        digest(snapshot.input.active_candidate.frozen_opportunity) !== digest(facts.opportunity)
      )
        throw new Error("TUF role frozen opportunity changed");
      active();
    };
    await guard();
    let envelope: Awaited<ReturnType<typeof signIsolatedTufRole>> | undefined,
      handoff: Awaited<ReturnType<typeof handoffSigningOutput>> | undefined,
      ownedPending: { checkpoint: string; operation_id: string } | undefined;
    const settlement = await executeOwnedCapacityEffect(
      executor,
      {
        repository: recovered.repository,
        checkpoint,
        remote_configuration: coordinator,
        request: {
          kind: "upload",
          destination: `github-actions:boburning/portcove:${version}:${phase}-envelope`,
        },
      },
      async () => (await fresh()).capacity_source.capacity.boundary,
      async (pending) => {
        ownedPending = { ...pending };
        checkpoint = pending.checkpoint;
        await guard();
        progress = "single-role-worker";
        const temporary = process.env.RUNNER_TEMP;
        if (!temporary || !path.isAbsolute(temporary))
          throw new Error("private runner role key channel root unavailable");
        envelope = await signIsolatedTufRole(
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
            keyMaterial: async () => {
              const milliseconds = Math.min(30000, signingContextRemaining(deadline, 30000));
              return receiveIsolatedRoleKey(
                path.join(temporary, `tuf-${role}-key`),
                role,
                Date.now() + milliseconds,
                async (key, password) => {
                  if (password)
                    throw new Error("fixed TUF role requires an unencrypted sole PKCS8 key");
                  return decodeTufRoleKey(key);
                },
              );
            },
          },
        );
        await guard();
        progress = "immutable-role-output";
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
      throw new Error("actual TUF output settlement missing");
    checkpoint = settlement.checkpoint;
    progress = "public-attestation-predicate";
    await guard();
    const finalProducer = await refreshCapacityExecutor(executor);
    if (!isDeepStrictEqual(finalProducer, producer))
      throw new Error("TUF producing numeric job changed");
    const manifestFile = handoff.files.find(
      (file) => file.filename === "signing-output-manifest.json",
    );
    if (!manifestFile) throw new Error("actual role output manifest missing");
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
      manifest_sha256: manifestFile.sha256,
      context_manifest_sha256: manifestSha,
      context_binding_sha256: digest(binding),
      context_facts_sha256: manifest.facts_sha256,
      envelope: { filename: envelope.filename, bytes: envelope.bytes, sha256: envelope.sha256 },
      pending: ownedPending,
      publication_admission: "not-established",
      authority: "none",
    };
    const predicateBytes = Buffer.from(JSON.stringify(predicate));
    if (predicateBytes.length > 65536) throw new Error("TUF predicate exceeds public inline bound");
    await writeFile(path.join(directory, "predicate.json"), predicateBytes, {
      flag: "wx",
      mode: 0o600,
    });
    active();
    const result = Object.freeze({
      decision: "role-output-prepared" as const,
      role,
      directory,
      predicate_path: path.join(directory, "predicate.json"),
      subject_path: path.join(directory, "handoff", "output", "signing-output-manifest.json"),
      subject_name: "tuf-role-output-manifest",
      subject_digest: manifestFile.sha256,
      predicate_type: tufRolePredicateType,
      artifact: handoff.artifact,
      settlement,
      pending_obligations: [
        "actual-role-output-attestation",
        "five-role-keyless-Tough-assembly",
        "post-sign-native-qualification",
        "publication-admission",
      ],
      authority: "none",
    });
    actualResults.set(result, {
      context: contextReceipt,
      tools: toolsReceipt,
      dependencies: capturedDependencies,
      deadline,
      predicate: structuredClone(predicate),
      directory,
      predicate_sha256: hash(predicateBytes),
      result: structuredClone(handoff),
    });
    await writeFile(path.join(parent, `tuf-${role}-result.json`), JSON.stringify(result), {
      flag: "wx",
      mode: 0o600,
    });
    return result;
  } catch {
    await writeFile(
      path.join(directory, "refusal.json"),
      JSON.stringify({ phase: progress, role, authority: "none" }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error("fixed TUF role controller refused; retain public evidence");
  }
}

export async function requirePreparedTufRoleOutput(receipt: object) {
  const retained = actualResults.get(receipt);
  if (!retained) throw new Error("actual TUF role output required");
  signingContextRemaining(retained.deadline, 15000);
  await verifiedControllerToolPaths(retained.tools);
  await requireReceivedSigningContext(retained.context, retained.deadline);
  for (const dependency of retained.dependencies)
    await requireReceivedTufRoleArtifact(dependency, retained.deadline);
  for (const file of retained.result.files) {
    const bytes = await readControllerToolFile(
      path.join(retained.directory, "handoff", "output", file.filename),
      file.bytes,
    );
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
      throw new Error("actual TUF public output changed");
    signingContextRemaining(retained.deadline, 15000);
  }
  if (
    hash(await readControllerToolFile(path.join(retained.directory, "predicate.json"), 65536)) !==
    retained.predicate_sha256
  )
    throw new Error("actual role predicate changed");
  return Object.freeze({
    predicate: structuredClone(retained.predicate),
    directory: retained.directory,
    artifact: structuredClone(retained.result.artifact),
    authority: "none",
  });
}

/** Fixed bootstrap receiver route. Tools/context/dependency JSON locates public
 * immutable bytes only; all private brands come from actual default collectors. */
export async function runFixedTufRoleConfiguration(
  raw: unknown,
  parent: string,
  rawDeadline?: number,
) {
  const value: unknown = structuredClone(raw),
    processDeadline = tufRoleControllerDeadline(rawDeadline);
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "context,dependencies,identity,role,tools" ||
    !isRecord(value.tools) ||
    Object.keys(value.tools).sort().join(",") !== "artifact,bundle" ||
    !isRecord(value.tools.artifact) ||
    !isRecord(value.tools.bundle) ||
    !isRecord(value.context) ||
    !Array.isArray(value.dependencies)
  )
    throw new Error("fixed TUF role caller fields differ");
  const role = inspectTufSigningRole(value.role),
    dependencies = tufRoleDependencies(role);
  if (value.dependencies.length !== dependencies.length)
    throw new Error("exact role dependency locators required");
  const deadline = currentTufJobDeadline(
    role,
    inspectAssemblerIdentityExpectation(value.identity),
    parent,
    processDeadline,
  );
  const toolsReceipt = await receiveControllerTools(
    parent,
    value.tools.artifact as unknown as ControllerToolArtifactExpected,
    value.tools.bundle as unknown as { artifact_id: number; sha256: string },
    { deadline },
  );
  const contextReceipt = await receiveSigningContextArtifact(
    parent,
    value.context as unknown as SigningContextArtifactExpected,
    deadline,
  );
  const receipts = [];
  for (let index = 0; index < dependencies.length; index++) {
    const locator: unknown = value.dependencies[index];
    if (!isRecord(locator) || locator.role !== dependencies[index])
      throw new Error("fixed role dependency order differs");
    receipts.push(await receiveTufRoleArtifact(contextReceipt, parent, locator, deadline));
  }
  return runTufRoleController(
    role,
    value.identity,
    toolsReceipt,
    contextReceipt,
    receipts,
    parent,
    deadline,
  );
}
if (
  process.argv[1] &&
  /^release-tuf-controller\.(?:mts|mjs)$/u.test(path.basename(process.argv[1])) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 3) throw new Error("fixed TUF configuration required");
    const raw: unknown = JSON.parse(
      (await readControllerToolFile(process.argv[2]!, 65536)).toString("utf8"),
    );
    const temporary = process.env.RUNNER_TEMP;
    if (!temporary || !path.isAbsolute(temporary)) throw new Error("private role root unavailable");
    const result = await runFixedTufRoleConfiguration(raw, temporary);
    console.log(JSON.stringify(result));
  } catch {
    console.error("fixed TUF role controller refused; retain public evidence");
    process.exitCode = 1;
  }
}
