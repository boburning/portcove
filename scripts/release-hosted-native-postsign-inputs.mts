/** Original hosted source + default context/role receivers + owned keyless
 * child. This is signed-input custody, never installed-parent, candidate,
 * native acceptance or permission to publish. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  requireActualHostedNativePostSignController,
  readActualHostedNativePostSignInventory,
  readActualHostedNativePostSignContextArchive,
} from "./release-hosted-native-candidate.mts";
import {
  requireHostedNativeRuntime,
  hostedNativeSupportDependencies,
} from "./release-hosted-native-runtime.mts";
import { verifiedControllerToolPaths } from "./release-controller-tool-admission.mts";
import {
  inspectSigningContextArchive,
  receiveSigningContextArtifact,
  requireReceivedSigningContext,
} from "./release-signing-context-artifact.mts";
import {
  receiveTufRoleArtifact,
  requireReceivedTufRoleArtifact,
} from "./release-tuf-role-artifact.mts";
import { inspectSelectedPublicationAuthorityConfiguration } from "./release-authority-configuration.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { readBoundedReleaseContextFiles } from "./release-signing-context.mts";
import { inspectTufPublicationFacts } from "./release-metadata-contract.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { releasePathContains } from "./release-path-safety.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { payloadSigningEnvironment } from "./release-payload-signing.mts";
import {
  withReadOnlyReleaseChildren,
  bindReadOnlyReleaseChildren,
} from "./release-readonly-child-environment.mts";
import { runResourceCommand } from "./resource-command.mts";
import { runRustTests } from "./run-rust-tests.mts";
import { isRecord } from "./runtime-values.mts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Source = Awaited<ReturnType<typeof requireActualHostedNativePostSignController>>;
type Tools = Awaited<ReturnType<typeof verifiedControllerToolPaths>>;
const sourceBinding = (value: Source) =>
  digest({
    checkpoint: value.checkpoint,
    candidate: value.candidate,
    controller: value.controller,
    producer: value.producer,
    configuration: value.configuration,
  });
const toolsBinding = (tools: Tools) =>
  digest({
    identity: tools.identity,
    root: tools.root,
    node: tools.node,
    rust: tools.rust,
    entry: tools.entries["release-native-keyless-assembly"],
  });
const files = (input: ReadonlyMap<string, Buffer>) =>
  [...input]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) }));
function sameTools(source: Source, tools: Tools) {
  for (const key of ["controller_revision", "controller_ref", "run_id", "run_attempt"] as const)
    assert.equal(
      tools.identity[key],
      source.producer[key],
      "original hosted source/tool binding differs",
    );
  assert.ok(tools.entries["release-native-keyless-assembly"], "fixed keyless child absent");
}
const attempted = new WeakSet<object>();
type State = {
  source: object;
  tools: object;
  runtime: object;
  runtime_root: string;
  directory: string;
  deadline: number;
  source_binding: string;
  tools_binding: string;
  inventory: unknown;
  context: object;
  roles: object[];
  plan: Buffer;
  result: Buffer;
  record: Buffer;
  assembly_directory: string;
  input_files: ReturnType<typeof files>;
  signed_files: ReturnType<typeof files>;
  report_sha256: string;
  repository: string;
  repository_files: ReturnType<typeof files>;
  publication: ReturnType<typeof inspectTufPublicationFacts>;
  read: () => Promise<{
    source: Source;
    tools: Tools;
    context: Awaited<ReturnType<typeof requireReceivedSigningContext>>;
  }>;
  stopped: boolean;
};
const retained = new WeakMap<object, State>();
function active(state: Pick<State, "stopped" | "deadline">) {
  if (state.stopped || !Number.isFinite(state.deadline) || performance.now() >= state.deadline)
    throw new Error("original hosted signed-input custody stopped or expired");
}
async function original(state: State) {
  active(state);
  const source = await requireActualHostedNativePostSignController(state.source);
  active(state);
  const tools = await verifiedControllerToolPaths(state.tools);
  active(state);
  sameTools(source, tools);
  const runtime = await requireHostedNativeRuntime(state.runtime, source.parent_source);
  active(state);
  assert.equal(runtime.root, state.runtime_root);
  if (sourceBinding(source) !== state.source_binding || toolsBinding(tools) !== state.tools_binding)
    throw new Error("original hosted signed-input source/tools changed");
  return { source, tools };
}

async function child(
  sourceReceipt: object,
  toolsReceipt: object,
  runtimeReceipt: object,
  runtimeRoot: string,
  directory: string,
  plan: Buffer,
  deadline: number,
  expectedSource: string,
  expectedTools: string,
) {
  const recheck = async () => {
    const source = await requireActualHostedNativePostSignController(sourceReceipt);
    const tools = await verifiedControllerToolPaths(toolsReceipt);
    sameTools(source, tools);
    const runtime = await requireHostedNativeRuntime(runtimeReceipt, source.parent_source);
    assert.equal(runtime.root, runtimeRoot);
    if (
      sourceBinding(source) !== expectedSource ||
      toolsBinding(tools) !== expectedTools ||
      performance.now() >= deadline
    )
      throw new Error("original hosted keyless source expired or changed");
    return { source, tools };
  };
  const { source } = await recheck();
  const dependencies = await hostedNativeSupportDependencies(
    runtimeReceipt,
    source.parent_source,
    directory,
  );
  const node = path.join(runtimeRoot, "bin/node");
  const entry = path.join(runtimeRoot, "scripts/release-native-keyless-assembly.bundle.mjs");
  const signal = new EventEmitter();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status: number;
  try {
    status = await runResourceCommand(
      "analysis",
      node,
      [entry, path.join(directory, "native-keyless-plan.json"), hash(plan)],
      {
        cwd: runtimeRoot,
        queueDeadline: deadline,
        environment: {
          ...payloadSigningEnvironment(directory),
          LANG: "C.UTF-8",
          PATH: path.dirname(node),
        },
        exclusive: [`native-keyless:${source.configuration.journal.namespace}`],
        supervise: (args, options) =>
          runRustTests(args, {
            ...options,
            ...dependencies,
            tempRoot: directory,
            signalTarget: signal,
            acquireLock: async (metadata, admission) => {
              if (!options.acquireLock)
                throw new Error("source-bound keyless resource admission required");
              const lease = await options.acquireLock(metadata, admission);
              try {
                await recheck();
                const remaining = Math.floor(deadline - performance.now());
                if (remaining < 1) throw new Error("hosted keyless deadline exhausted in queue");
                timer = setTimeout(() => signal.emit("SIGTERM"), remaining);
                return lease;
              } catch (error) {
                await lease.release();
                throw error;
              }
            },
          }),
      },
    );
  } finally {
    clearTimeout(timer);
  }
  await recheck();
  if (status !== 0)
    throw new Error("hosted keyless child failed; retain all outputs and recover explicitly");
}

/** Fixed source and genuine tool receipts only. The context and five roles use
 * their DEFAULT transports, retaining their original actual private custody. */
export async function acquireActualHostedNativePostSignInputs(
  sourceReceipt: object,
  toolsReceipt: object,
  runtimeReceipt: object,
) {
  const phaseDeadline = performance.now() + 300000;
  if (attempted.has(sourceReceipt))
    throw new Error("one original signed-input attempt; explicit recovery required");
  attempted.add(sourceReceipt);
  const source = await requireActualHostedNativePostSignController(sourceReceipt);
  const deadline = Math.min(phaseDeadline, source.deadline);
  active({ stopped: false, deadline });
  const directory = await mkdtemp(path.join(source.directory, "signed-inputs-"));
  await chmod(directory, 0o700);
  let phase = "source-and-tools";
  try {
    return await withReadOnlyReleaseChildren(directory, async () => {
      const tools = await verifiedControllerToolPaths(toolsReceipt);
      sameTools(source, tools);
      const runtime = await requireHostedNativeRuntime(runtimeReceipt, source.parent_source);
      const runtimeRust = path.join(runtime.root, "bin/portcove-release-tools");
      const sourceHash = sourceBinding(source),
        toolsHash = toolsBinding(tools);
      const configuration = inspectSelectedPublicationAuthorityConfiguration(source.configuration);
      if (configuration.purpose !== "application")
        throw new Error("original application configuration required");
      phase = "context-preflight";
      const preflight = await readActualHostedNativePostSignContextArchive(sourceReceipt);
      const inspected = inspectSigningContextArchive(preflight.bytes);
      const pins = configuration.publication.public_source;
      for (const [name, pin] of [
        ["trusted-root.json", pins.root],
        ["offline-targets.json", pins.offline_targets],
        ["payload.json", pins.payload_key_registry],
      ] as const) {
        const bytes = inspected.files.get(name);
        if (!bytes || bytes.length !== pin.bytes || hash(bytes) !== pin.sha256)
          throw new Error("hosted signed context anchors differ from appointed public pins");
      }
      const { bytes: _contextBytes, ...artifact } = preflight.inventory.context;
      const { bytes: _bundleBytes, ...bundle } = preflight.inventory.context_bundle;
      const factsSha256 = inspected.manifest.facts_sha256;
      if (typeof factsSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(factsSha256))
        throw new Error("authenticated context facts hash absent");
      const expected = {
        ...source.controller,
        source_tree: tools.identity.source_tree,
        artifact,
        bundle,
        manifest_sha256: inspected.manifest_sha256,
        binding_sha256: digest(inspected.manifest.binding),
        facts_sha256: factsSha256,
      };
      // Controller data also contains operation provenance. The public receiver
      // accepts exactly its existing five-field controller identity, not that data.
      const controller = {
        controller_revision: source.controller.controller_revision,
        source_tree: tools.identity.source_tree,
        controller_ref: source.controller.controller_ref,
        run_id: source.controller.run_id,
        run_attempt: source.controller.run_attempt,
      };
      const contextExpected = {
        ...controller,
        artifact,
        bundle,
        manifest_sha256: expected.manifest_sha256,
        binding_sha256: expected.binding_sha256,
        facts_sha256: expected.facts_sha256,
      };
      phase = "default-context-receiver";
      const contextReceipt = await receiveSigningContextArtifact(
        directory,
        contextExpected,
        deadline,
      );
      assert.equal(
        contextReceipt.evidence_scope,
        "github.com",
        "actual default context receiver required",
      );
      const context = await requireReceivedSigningContext(contextReceipt, deadline);
      if (digest(context.manifest) !== digest(inspected.manifest))
        throw new Error("hosted authenticated manifest differs");
      const facts = context.manifest.facts;
      if (
        !isRecord(facts) ||
        digest(facts.opportunity) !== digest(source.candidate.frozen_opportunity)
      )
        throw new Error("hosted signed context differs from the complete reserved opportunity");
      const { accepted, labels } = await inspectTrustedAssemblyInput(facts.assembly);
      const candidate = source.candidate;
      if (
        accepted.release_profile !== "initial-beta-win-linux" ||
        labels.length !== 2 ||
        [...labels].sort().join(",") !== "linux-x86_64,windows-x86_64" ||
        accepted.source_commit !== candidate.prepared_commit ||
        accepted.source_tree !== candidate.prepared_tree ||
        accepted.version !== candidate.version ||
        !isRecord(candidate.release_run) ||
        accepted.run_id !== String(candidate.release_run.run_id) ||
        accepted.run_attempt !== candidate.release_run.attempt
      )
        throw new Error("hosted signed context differs from exact reserved compiler tuple");
      phase = "default-five-role-receivers";
      const roles: object[] = [];
      const envelopes = [];
      for (const role of preflight.inventory.roles) {
        const { bytes: _roleBytes, ...artifact } = role.artifact;
        const { bytes: _proofBytes, ...bundle } = role.bundle;
        const receipt = await receiveTufRoleArtifact(
          contextReceipt,
          directory,
          {
            role: role.role,
            controller,
            artifact,
            bundle,
            context_manifest_sha256: contextExpected.manifest_sha256,
            context_binding_sha256: contextExpected.binding_sha256,
            context_facts_sha256: contextExpected.facts_sha256,
          },
          deadline,
        );
        const actual = await requireReceivedTufRoleArtifact(receipt, deadline);
        roles.push(receipt);
        envelopes.push(actual.envelope);
      }
      phase = "owned-keyless-child";
      const toolBytes = await readControllerToolFile(runtimeRust);
      const plan = Buffer.from(
        JSON.stringify({
          schema_version: 1,
          context_directory: path.dirname(context.context),
          output_parent: directory,
          tool: { path: runtimeRust, sha256: hash(toolBytes) },
          signed_roles: envelopes,
        }),
      );
      if (plan.length > 65536) throw new Error("fixed hosted keyless plan exceeds bound");
      await writeFile(path.join(directory, "native-keyless-plan.json"), plan, {
        flag: "wx",
        mode: 0o600,
      });
      await child(
        sourceReceipt,
        toolsReceipt,
        runtimeReceipt,
        runtime.root,
        directory,
        plan,
        deadline,
        sourceHash,
        toolsHash,
      );
      const result = await readBoundedPublicBuildInputFile(
        directory,
        "native-keyless-result.json",
        1024 * 1024,
      );
      const raw: unknown = JSON.parse(result.toString("utf8"));
      if (
        !isRecord(raw) ||
        Object.keys(raw).sort().join(",") !==
          "assembled,authority,plan_sha256,schema_version,scope" ||
        raw.schema_version !== 1 ||
        raw.authority !== "none" ||
        raw.plan_sha256 !== hash(plan) ||
        !isRecord(raw.assembled) ||
        typeof raw.assembled.directory !== "string" ||
        !releasePathContains(directory, raw.assembled.directory) ||
        raw.assembled.repository !== path.join(raw.assembled.directory, "repository")
      )
        throw new Error("hosted keyless result differs from the owned plan");
      const assemblyDirectory = raw.assembled.directory;
      const inputFiles = files(
        await readBoundedReleaseContextFiles(path.join(assemblyDirectory, "public-inputs")),
      );
      const signedFiles = files(
        await readBoundedReleaseContextFiles(path.join(assemblyDirectory, "signed-roles")),
      );
      const reportSha256 = hash(
        await readBoundedPublicBuildInputFile(
          assemblyDirectory,
          "assembly-report.json",
          1024 * 1024,
        ),
      );
      const signedInventory: unknown = raw.assembled.signed_files;
      if (!Array.isArray(signedInventory)) throw new Error("signed inventory absent");
      const signedEntries: unknown[] = signedInventory;
      const normalizedSigned = signedEntries
        .map((entry) => {
          if (
            !isRecord(entry) ||
            typeof entry.path !== "string" ||
            typeof entry.bytes !== "number" ||
            typeof entry.sha256 !== "string" ||
            Object.keys(entry).sort().join(",") !== "bytes,path,sha256"
          )
            throw new Error("signed inventory entry differs");
          return { path: entry.path, bytes: entry.bytes, sha256: entry.sha256 };
        })
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      if (
        digest(inputFiles) !== digest(raw.assembled.input_files) ||
        digest(signedFiles) !== digest(normalizedSigned) ||
        reportSha256 !== raw.assembled.report_sha256
      )
        throw new Error("hosted keyless staged input or report custody differs");
      const repository = raw.assembled.repository;
      const publication = inspectTufPublicationFacts(raw.assembled.publication);
      const repositoryFiles = files(await readBoundedReleaseContextFiles(repository));
      const publicFiles = repositoryFiles.filter(
        (file) => file.path !== "repository-manifest.json",
      );
      if (
        digest(repositoryFiles) !== digest(raw.assembled.files) ||
        digest(publicFiles) !== publication.repository_sha256 ||
        !isRecord(context.manifest.binding) ||
        publication.records_sha256 !== context.manifest.binding.records_sha256
      )
        throw new Error("hosted keyless repository inventory or signed record set differs");
      phase = "final-input-retention";
      const record = Buffer.from(
        JSON.stringify({
          schema_version: 1,
          source_binding: sourceHash,
          tools_binding: toolsHash,
          inventory: preflight.inventory,
          context: contextExpected,
          roles: preflight.inventory.roles.map((role) => role.role),
          plan_sha256: hash(plan),
          result_sha256: hash(result),
          repository,
          assembly_directory: assemblyDirectory,
          repository_files: repositoryFiles,
          input_files: inputFiles,
          signed_files: signedFiles,
          report_sha256: reportSha256,
          publication,
          authority: "none",
          native_acceptance: "not-established",
        }),
      );
      if (record.length > 2 * 1024 * 1024)
        throw new Error("hosted signed-input receipt exceeds bound");
      await writeFile(path.join(directory, "signed-inputs.json"), record, {
        flag: "wx",
        mode: 0o600,
      });
      const state: State = {
        source: sourceReceipt,
        tools: toolsReceipt,
        runtime: runtimeReceipt,
        runtime_root: runtime.root,
        directory,
        deadline,
        source_binding: sourceHash,
        tools_binding: toolsHash,
        inventory: preflight.inventory,
        context: contextReceipt,
        roles,
        plan,
        result,
        record,
        repository,
        assembly_directory: assemblyDirectory,
        input_files: inputFiles,
        signed_files: signedFiles,
        report_sha256: reportSha256,
        repository_files: repositoryFiles,
        publication,
        read: async () => {
          throw new Error("original signed-input reader not installed");
        },
        stopped: false,
      };
      state.read = bindReadOnlyReleaseChildren(async () => {
        const value = await original(state);
        const context = await requireReceivedSigningContext(state.context, state.deadline);
        active(state);
        for (const receipt of state.roles) {
          await requireReceivedTufRoleArtifact(receipt, state.deadline);
          active(state);
        }
        const inventory = await readActualHostedNativePostSignInventory(state.source);
        active(state);
        if (digest(inventory) !== digest(state.inventory))
          throw new Error("original signed artifact inventory changed");
        for (const [name, expected] of [
          ["native-keyless-plan.json", state.plan],
          ["native-keyless-result.json", state.result],
          ["signed-inputs.json", state.record],
        ] as const) {
          const bytes = await readBoundedPublicBuildInputFile(
            state.directory,
            name,
            Math.max(expected.length, 1),
          );
          active(state);
          if (!bytes.equals(expected))
            throw new Error("original hosted signed-input bytes changed");
        }
        if (
          digest(
            files(
              await readBoundedReleaseContextFiles(
                path.join(state.assembly_directory, "public-inputs"),
              ),
            ),
          ) !== digest(state.input_files) ||
          digest(
            files(
              await readBoundedReleaseContextFiles(
                path.join(state.assembly_directory, "signed-roles"),
              ),
            ),
          ) !== digest(state.signed_files) ||
          hash(
            await readBoundedPublicBuildInputFile(
              state.assembly_directory,
              "assembly-report.json",
              1024 * 1024,
            ),
          ) !== state.report_sha256
        )
          throw new Error("hosted signed staged inputs or report changed");
        const currentFiles = files(await readBoundedReleaseContextFiles(state.repository));
        active(state);
        if (digest(currentFiles) !== digest(state.repository_files))
          throw new Error("hosted signed repository changed");
        await original(state);
        active(state);
        return { ...value, context };
      });
      const receipt = Object.freeze({
        kind: "original-hosted-native-signed-inputs",
        directory,
        authority: "none",
        native_acceptance: "not-established",
      });
      retained.set(receipt, state);
      await requireActualHostedNativePostSignInputs(receipt);
      return receipt;
    });
  } catch {
    await writeFile(
      path.join(directory, "refusal.json"),
      JSON.stringify({
        phase,
        automatic_retry: false,
        recovery_required: true,
        authority: "none",
        native_acceptance: "not-established",
      }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw new Error(`hosted signed-input acquisition refused; retain ${directory}`);
  }
}

export async function requireActualHostedNativePostSignInputs(receipt: object) {
  const state = retained.get(receipt);
  if (!state || state.stopped)
    throw new Error("original active hosted signed-input receipt required");
  try {
    const current = await state.read();
    active(state);
    return Object.freeze({
      directory: state.directory,
      source_receipt: state.source,
      tools_receipt: state.tools,
      source: current.source,
      context: current.context,
      repository: state.repository,
      publication: structuredClone(state.publication),
      deadline: state.deadline,
      authority: "none" as const,
      native_acceptance: "not-established" as const,
      scope:
        "actual hosted signed-input/Tough custody only; package/journey/capture pending" as const,
    });
  } catch (error) {
    state.stopped = true;
    throw error;
  }
}
