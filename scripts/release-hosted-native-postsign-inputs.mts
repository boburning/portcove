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
  snapshotReceivedSigningContextEvidence,
} from "./release-signing-context-artifact.mts";
import {
  receiveTufRoleArtifact,
  requireReceivedTufRoleArtifact,
  snapshotReceivedTufRoleEvidence,
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
import {
  hashNativeCapturedFile,
  readNativeCapturedStream,
} from "./release-native-capture-files.mts";
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
  context_snapshot: Awaited<ReturnType<typeof requireReceivedSigningContext>>;
  proof_snapshots: { root: string; files: { path: string; bytes: number; sha256: string }[] }[];
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
  filename: "native-keyless-plan.json" | "native-payload-plan.json" = "native-keyless-plan.json",
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
      [entry, path.join(directory, filename), hash(plan)],
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
      phase = "original-proof-snapshot-handoff";
      const contextSnapshot = await snapshotReceivedSigningContextEvidence(
        contextReceipt,
        deadline,
      );
      const proofSnapshots = [{ root: contextSnapshot.root, files: contextSnapshot.files }];
      for (const role of roles)
        proofSnapshots.push(await snapshotReceivedTufRoleEvidence(role, deadline));
      active({ stopped: false, deadline });
      phase = "final-input-retention";
      const record = Buffer.from(
        JSON.stringify({
          schema_version: 1,
          source_binding: sourceHash,
          tools_binding: toolsHash,
          inventory: preflight.inventory,
          original_proof_snapshots: proofSnapshots,
          construction_deadline: deadline,
          original_parent_deadline: source.deadline,
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
        deadline: source.deadline,
        source_binding: sourceHash,
        tools_binding: toolsHash,
        inventory: preflight.inventory,
        context: contextReceipt,
        context_snapshot: structuredClone(contextSnapshot.context),
        proof_snapshots: structuredClone(proofSnapshots),
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
        // The native parent owns these original verified bytes after the short
        // receiver phase. Generic receiver deadlines are never extended/reused.
        for (const proof of state.proof_snapshots)
          for (const file of proof.files) {
            const actual = await hashNativeCapturedFile(
              proof.root,
              file.path,
              Math.max(file.bytes, 1),
              state.deadline,
            );
            active(state);
            if (digest(actual) !== digest(file))
              throw new Error("original signed proof snapshot changed");
          }
        const context = structuredClone(state.context_snapshot);
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
      active({ stopped: false, deadline });
      retained.set(receipt, state);
      await requireActualHostedNativePostSignInputs(receipt);
      active({ stopped: false, deadline });
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

const payloadAttempts = new WeakSet<object>();
const payloads = new WeakMap<
  object,
  {
    read: () => Promise<
      Awaited<
        ReturnType<
          typeof import("./release-hosted-native-candidate.mts").requireActualHostedNativePostSignPackage
        >
      >
    >;
    stopped: boolean;
    package: object;
    plan: Buffer;
    result: Buffer;
    directory: string;
    signed_context_sha256: string;
    signatures_sha256: string;
  }
>();

/** Original package and context only; the fixed retained-runtime verifier never
 * receives a signing key, provider credential, injected executable or callback. */
export async function verifyActualHostedNativePostSignPayload(packageReceipt: object) {
  if (payloadAttempts.has(packageReceipt))
    throw new Error("one original hosted payload verification; explicit recovery required");
  payloadAttempts.add(packageReceipt);
  const { requireActualHostedNativePostSignPackage } =
    await import("./release-hosted-native-candidate.mts");
  const selected = await requireActualHostedNativePostSignPackage(packageReceipt);
  const state = retained.get(selected.inputs_receipt);
  if (!state || state.stopped) throw new Error("original payload signed-input custody required");
  const directory = selected.directory;
  let phase = "signed-payload-record";
  try {
    return await withReadOnlyReleaseChildren(directory, async () => {
      const current = await requireActualHostedNativePostSignInputs(selected.inputs_receipt);
      const contextFiles = await readBoundedReleaseContextFiles(
        path.dirname(current.context.context),
      );
      const matches = [...contextFiles]
        .filter(([name]) => name.startsWith("records/releases/"))
        .map(([, bytes]) => JSON.parse(bytes.toString("utf8")) as unknown)
        .filter(
          (record) =>
            isRecord(record) &&
            record.target === selected.platform_label &&
            record.version === selected.version &&
            record.source_commit === selected.candidate.source_commit &&
            record.source_tree === selected.candidate.source_tree &&
            isRecord(record.artifact) &&
            record.artifact.sha256 === selected.candidate.package.sha256 &&
            record.artifact.bytes === selected.candidate.package.bytes,
        );
      if (matches.length !== 1 || !isRecord(matches[0]) || !isRecord(matches[0].artifact))
        throw new Error("one original signed payload record required");
      const artifact = matches[0].artifact;
      const registryBytes = contextFiles.get("payload.json");
      if (!registryBytes) throw new Error("original public payload registry absent");
      const registry: unknown = JSON.parse(registryBytes.toString("utf8"));
      if (!isRecord(registry) || !Array.isArray(registry.keys) || registry.keys.length > 32)
        throw new Error("original public payload registry differs");
      const keys = registry.keys.filter(
        (key: unknown) => isRecord(key) && key.id === artifact.payload_key_id,
      );
      if (
        keys.length !== 1 ||
        !isRecord(keys[0]) ||
        typeof keys[0].tauri_public_key !== "string" ||
        typeof artifact.payload_key_id !== "string" ||
        typeof artifact.tauri_signature !== "string"
      )
        throw new Error("original payload key/signature absent or ambiguous");
      const signature = Buffer.from(artifact.tauri_signature),
        key = Buffer.from(keys[0].tauri_public_key);
      if (!signature.length || signature.length > 16384 || !key.length || key.length > 16384)
        throw new Error("public payload verification material exceeds bound");
      const signaturePath = path.join(directory, "native-payload.sig"),
        keyPath = path.join(directory, "native-payload.key");
      await writeFile(signaturePath, signature, { flag: "wx", mode: 0o600 });
      await writeFile(keyPath, key, { flag: "wx", mode: 0o600 });
      const rust = path.join(state.runtime_root, "bin/portcove-release-tools");
      const toolBytes = await readControllerToolFile(rust);
      const plan = Buffer.from(
        JSON.stringify({
          schema_version: 1,
          output_parent: directory,
          artifact: selected.package_path,
          signature: signaturePath,
          public_key: keyPath,
          public_key_sha256: artifact.payload_key_id,
          bytes: selected.candidate.package.bytes,
          sha256: selected.candidate.package.sha256,
          version: selected.version,
          tool: { path: rust, sha256: hash(toolBytes) },
        }),
      );
      if (plan.length > 65536) throw new Error("fixed hosted payload plan exceeds bound");
      await writeFile(path.join(directory, "native-payload-plan.json"), plan, {
        flag: "wx",
        mode: 0o600,
      });
      phase = "fixed-payload-verifier";
      await requireActualHostedNativePostSignPackage(packageReceipt);
      await child(
        state.source,
        state.tools,
        state.runtime,
        state.runtime_root,
        directory,
        plan,
        state.deadline,
        state.source_binding,
        state.tools_binding,
        "native-payload-plan.json",
      );
      const result = await readBoundedPublicBuildInputFile(
        directory,
        "native-payload-result.json",
        1024 * 1024,
      );
      const raw: unknown = JSON.parse(result.toString("utf8"));
      if (
        !isRecord(raw) ||
        Object.keys(raw).sort().join(",") !==
          "authority,plan_sha256,report,schema_version,stderr_sha256,stdout_sha256" ||
        raw.schema_version !== 1 ||
        raw.authority !== "none" ||
        raw.plan_sha256 !== hash(plan) ||
        !isRecord(raw.report) ||
        raw.report.signature_verified !== true ||
        raw.report.sha256 !== selected.candidate.package.sha256 ||
        raw.report.bytes !== selected.candidate.package.bytes ||
        raw.report.public_key_sha256 !== artifact.payload_key_id ||
        !isRecord(selected.journey) ||
        typeof selected.journey.signed_context_sha256 !== "string" ||
        typeof selected.journey.signatures_sha256 !== "string"
      )
        throw new Error("original hosted payload verification result differs");
      const resultIdentity = raw;
      const read = bindReadOnlyReleaseChildren(async () => {
        await requireActualHostedNativePostSignInputs(selected.inputs_receipt);
        const repeated = await requireActualHostedNativePostSignPackage(packageReceipt);
        for (const [name, bytes] of [
          ["native-payload.sig", signature],
          ["native-payload.key", key],
          ["native-payload-plan.json", plan],
          ["native-payload-result.json", result],
        ] as const) {
          if (!(await readBoundedPublicBuildInputFile(directory, name, bytes.length)).equals(bytes))
            throw new Error("original hosted payload evidence changed");
          active(state);
        }
        for (const stream of ["stdout", "stderr"] as const) {
          const bytes = await readNativeCapturedStream(directory, `native-payload.${stream}.bin`);
          if (bytes.length > 1024 * 1024) throw new Error("payload verifier stream exceeds bound");
          if (hash(bytes) !== resultIdentity[`${stream}_sha256`])
            throw new Error("original payload verifier capture changed");
        }
        await requireActualHostedNativePostSignInputs(selected.inputs_receipt);
        return repeated;
      });
      const receipt = Object.freeze({
        kind: "original-hosted-payload-verification",
        directory,
        authority: "none",
        native_acceptance: "not-established",
      });
      payloads.set(receipt, {
        read,
        stopped: false,
        package: packageReceipt,
        plan,
        result,
        directory,
        signed_context_sha256: selected.journey.signed_context_sha256,
        signatures_sha256: selected.journey.signatures_sha256,
      });
      await requireActualHostedNativePostSignPayload(receipt);
      return receipt;
    });
  } catch {
    state.stopped = true;
    await writeFile(
      path.join(directory, "payload-refusal.json"),
      JSON.stringify({ phase, automatic_retry: false, recovery_required: true, authority: "none" }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw new Error(`hosted payload verification refused; retain ${directory}`);
  }
}

export async function requireActualHostedNativePostSignPayload(receipt: object) {
  const state = payloads.get(receipt);
  if (!state || state.stopped)
    throw new Error("original active hosted payload verification required");
  try {
    const selected = await state.read();
    if (state.stopped) throw new Error("original hosted payload stopped during readback");
    return {
      ...selected,
      package_receipt: state.package,
      payload_crypto: {
        file: "native-payload-result.json",
        sha256: hash(state.result),
        signed_context_sha256: state.signed_context_sha256,
        signatures_sha256: state.signatures_sha256,
      },
      signature_verification: "actual-fixed-verifier" as const,
      authority: "none" as const,
      native_acceptance: "not-established" as const,
    };
  } catch (error) {
    state.stopped = true;
    throw error;
  }
}
