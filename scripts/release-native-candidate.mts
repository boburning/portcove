/** Actual local-parent candidate selection. Provider acquisition deliberately
 * retains the admission collector's injected-provider scope: this module owns
 * its fixed transport and package custody, never an admission/native result. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { EventEmitter } from "node:events";
import { acquireReleaseAdmission } from "./acquire-release-admission.mts";
import type { PreparedReleaseAdmissionFacts } from "./acquire-release-admission.mts";
import {
  requireActualNativeParent,
  remainingNativeParentBudget,
} from "./release-native-parent.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { readGitHubArtifactArchive, readGitHubReleaseAsset } from "./github-binary.mts";
import {
  recoverRemoteCoordinator,
  hydrateRetainedCoordinatorOperation,
} from "./release-coordinator-recovery.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { artifactName, releaseBuildArtifactName } from "./release-package-policy.mts";
import { prepareNativeStageRequest } from "./release-native-stage-capture.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { isRecord } from "./runtime-values.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { releasePathContains } from "./release-path-safety.mts";
import {
  inspectSigningContextArchive,
  receiveSigningContextArtifact,
} from "./release-signing-context-artifact.mts";
import { readAttestedTufRoleArtifact } from "./release-tuf-role-artifact.mts";
import {
  inspectNativePrepublicationAuthorities,
  inspectPublicationAuthorities,
} from "./release-authority-configuration.mts";
import { discoverReleaseArtifactFiles } from "./release-artifact-archive.mts";
import {
  inspectNativeKeylessAssemblyPlan,
  inspectNativePayloadVerificationPlan,
} from "./release-native-keyless-assembly.mts";
import { runResourceCommand } from "./resource-command.mts";
import { runRustTests } from "./run-rust-tests.mts";
import { readBoundedReleaseContextFiles } from "./release-signing-context.mts";
import { inspectTufPublicationFacts } from "./release-metadata-contract.mts";
import { inspectCapacityOperation, inspectCompactCapacityOperations } from "./release-capacity.mts";
import {
  prepareNativeQualificationCheck,
  collectNativeReleaseQualification,
} from "./release-native-acceptance.mts";
import { deriveNativePublicationJourneys } from "./release-native-publication-admission.mts";
import { inspectNativeQualificationCandidate } from "./release-native-qualification-contract.mts";
import { nativeQualificationCheckName } from "./release-native-qualification-contract.mts";
import {
  nativeCompatibilitySourcePaths,
  inspectNativeCompatibilitySources,
} from "./release-native-source-contract.mts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Parent = Awaited<ReturnType<typeof requireActualNativeParent>>;
type Identity = { platform_label: string; filename: string; bytes: number; sha256: string };

/** Duplicate identity only; these are the existing coordinator recovery
 * counters, not a local permission to advance or retry them. */
export function nativeInvocationIdentity(
  prepared: ReturnType<typeof prepareNativeStageRequest>,
  rawCounters: unknown,
) {
  if (
    !isRecord(rawCounters) ||
    Object.keys(rawCounters).sort().join(",") !== "substantive_repairs,transient_retries"
  )
    throw new Error("native invocation requires exact coordinator recovery counters");
  const counters: Record<string, number> = {};
  for (const [name, maximum] of [
    ["transient_retries", 2],
    ["substantive_repairs", 3],
  ] as const) {
    const value = rawCounters[name];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > maximum)
      throw new Error("native invocation exceeds existing coordinator recovery limits");
    counters[name] = value;
  }
  const { invocation_id: _discard, ...request } = prepared.request;
  return Object.freeze({
    invocation_id: digest({ kind: "native-qualification-invocation-v1", request, counters }),
    counters: Object.freeze(counters),
    authority: "none" as const,
  });
}

/** Integrity reconstruction only. Exact bytes do not establish native success. */
export async function inspectSelectedNativeCandidate(
  facts: Readonly<Pick<PreparedReleaseAdmissionFacts, "assembly" | "archives" | "checkpoint">>,
  platform: "windows-x86_64" | "linux-x86_64",
  retained: { identity: Identity; bytes: Uint8Array },
) {
  const { accepted, policy, labels } = await inspectTrustedAssemblyInput(facts.assembly);
  if (
    accepted.release_profile !== "initial-beta-win-linux" ||
    labels.length !== 2 ||
    facts.archives.length !== 2 ||
    facts.archives
      .map((entry) => entry.platform)
      .sort()
      .join(",") !== [...labels].sort().join(",") ||
    new Set(facts.archives.map((entry) => entry.artifact_id)).size !== 2 ||
    !/^[a-f0-9]{40}$/u.test(facts.checkpoint)
  )
    throw new Error("native selection requires the reserved complete beta pair");
  const rule = policy.packages.find(
    (entry) =>
      entry.platform_label === platform &&
      entry.interface === "desktop" &&
      (entry.format === "nsis" || entry.format === "appimage"),
  );
  if (!rule) throw new Error("native selected updater rule absent");
  const filename = artifactName(rule, accepted.version);
  const file = accepted.files.find(
    (entry) => entry.platform_label === platform && entry.filename === filename,
  );
  const archives = facts.archives.filter((entry) => entry.platform === platform);
  if (
    !file ||
    archives.length !== 1 ||
    !Number.isSafeInteger(archives[0]!.artifact_id) ||
    archives[0]!.artifact_id < 1 ||
    digest(file) !== digest(retained.identity) ||
    retained.bytes.byteLength !== file.bytes ||
    hash(retained.bytes) !== file.sha256
  )
    throw new Error("native retained updater differs from its exact immutable archive");
  return Object.freeze({
    candidate: Object.freeze({
      source_commit: accepted.source_commit,
      source_tree: accepted.source_tree,
      run_id: accepted.run_id,
      run_attempt: accepted.run_attempt,
      artifact_id: archives[0]!.artifact_id,
      package: Object.freeze({ filename, bytes: file.bytes, sha256: file.sha256 }),
    }),
    checkpoint: facts.checkpoint,
    version: accepted.version,
    authority: "none" as const,
    scope: "integrity-only" as const,
  });
}

function toolBytes(file: string, expected: string) {
  const before = lstatSync(file);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1 ||
    before.size > 128 * 1024 * 1024
  )
    throw new Error("native fixed source tool unavailable");
  const bytes = readFileSync(file);
  const after = lstatSync(file);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    bytes.length !== before.size ||
    hash(bytes) !== expected
  )
    throw new Error("native fixed source tool changed");
  return { dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs };
}

/** Data-only route guard used immediately before every credentialled child. */
export function inspectNativeSourceCommand(args: readonly string[], input?: unknown) {
  if (args[0] !== "api" || args.length > 16)
    throw new Error("native source admits fixed read-only GitHub API operations only");
  let endpoint: string | null = null,
    method: string | null = null,
    host: string | null = null,
    stdin = false,
    octetStream = false;
  for (let index = 1; index < args.length; index++) {
    const item = args[index];
    if (item === "--include") continue;
    if (item === "-H" && !octetStream) {
      if (args[++index] !== "Accept: application/octet-stream")
        throw new Error("native source header differs");
      octetStream = true;
    } else if (item === "--hostname" && host === null) host = args[++index] ?? null;
    else if (item === "--method" && method === null) method = args[++index] ?? null;
    else if (item === "--input" && !stdin) {
      if (args[++index] !== "-") throw new Error("native source forbids body files");
      stdin = true;
    } else if (typeof item === "string" && !item.startsWith("-") && endpoint === null)
      endpoint = item;
    else throw new Error("native source command shape differs");
  }
  if (host !== "github.com" || !endpoint) throw new Error("native source host/route differs");
  if (
    octetStream &&
    !/^repos\/boburning\/portcove\/releases\/assets\/[1-9][0-9]{0,15}$/u.test(endpoint)
  )
    throw new Error("native binary transport requires an exact Release asset");
  if (endpoint === "graphql") {
    if (!stdin || input === undefined || (method !== null && method !== "POST"))
      throw new Error("native source GraphQL body required");
    const text = Buffer.isBuffer(input) ? input.toString("utf8") : input;
    if (typeof text !== "string") throw new Error("native source query must be UTF-8 text");
    if (Buffer.byteLength(text) > 128 * 1024) throw new Error("native source query bound exceeded");
    const body: unknown = JSON.parse(text);
    if (
      !isRecord(body) ||
      typeof body.query !== "string" ||
      !/^\s*query(?:\s|\()/u.test(body.query) ||
      /\bmutation\b/u.test(body.query)
    )
      throw new Error("native source GraphQL mutation refused");
  } else if (
    !/^repos\/boburning\/portcove(?:\/[A-Za-z0-9_./?=&%+-]+)?$/u.test(endpoint) ||
    decodeURIComponent(endpoint.split("?")[0]!)
      .split("/")
      .some((part) => part === "." || part === ".." || !part) ||
    (method !== null && method !== "GET") ||
    stdin ||
    input !== undefined
  )
    throw new Error("native source repository mutation/foreign route refused");
  return { scope: "read-only-route-integrity", authority: "none" } as const;
}

/** Only the existing fixed GitHub/Sigstore verifier over retained public files.
 * This command validation cannot authenticate a statement or native result. */
export function inspectNativeControllerVerificationCommand(
  args: readonly string[],
  directory: string,
  controller: { controller_revision: string; controller_ref: string },
) {
  const filename = args[2],
    bundle = args[4],
    predicate = args[19];
  if (
    !path.isAbsolute(directory) ||
    typeof filename !== "string" ||
    typeof bundle !== "string" ||
    !path.isAbsolute(filename) ||
    !path.isAbsolute(bundle) ||
    path.resolve(filename) !== filename ||
    path.resolve(bundle) !== bundle ||
    !releasePathContains(directory, filename) ||
    !releasePathContains(directory, bundle) ||
    path.dirname(filename) !== path.dirname(bundle) ||
    !/^[a-f0-9]{40}$/u.test(controller.controller_revision) ||
    !/^refs\/tags\/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(
      controller.controller_ref,
    )
  )
    throw new Error("native controller verifier requires exact retained public files/source");
  const kind =
    path.basename(filename) === "signing-context-manifest.json"
      ? {
          bundle: "attestation.json",
          predicate: "https://portcove.dev/attestations/release-signing-context/v1",
        }
      : path.basename(filename) === "signing-output-manifest.json"
        ? {
            bundle: "role-attestation.json",
            predicate: "https://portcove.dev/attestations/tuf-role-output/v1",
          }
        : null;
  if (
    !kind ||
    path.basename(bundle) !== kind.bundle ||
    predicate !== kind.predicate ||
    JSON.stringify(args) !==
      JSON.stringify([
        "attestation",
        "verify",
        filename,
        "--bundle",
        bundle,
        "--repo",
        "boburning/portcove",
        "--signer-workflow",
        `boburning/portcove/${productionControllerWorkflow}`,
        "--signer-digest",
        controller.controller_revision,
        "--source-digest",
        controller.controller_revision,
        "--source-ref",
        controller.controller_ref,
        "--cert-oidc-issuer",
        "https://token.actions.githubusercontent.com",
        "--deny-self-hosted-runners",
        "--predicate-type",
        kind.predicate,
        "--format",
        "json",
      ])
  )
    throw new Error("native controller verifier flags or predicate differ");
}

/** Fixed same-job compiler provenance command only; it cannot issue a native
 * result or appoint the prepared source supplied by the actual public pair. */
export function inspectNativeReleaseVerificationCommand(
  args: readonly string[],
  directory: string,
  expected: { source_commit: string; ref: string },
) {
  const filename = args[2];
  if (
    typeof filename !== "string" ||
    !path.isAbsolute(directory) ||
    !path.isAbsolute(filename) ||
    path.resolve(filename) !== filename ||
    !releasePathContains(directory, filename) ||
    !/^compiler-result-(?:cli|desktop)-(?:linux|windows)-x86_64\.json$/u.test(
      path.basename(filename),
    ) ||
    !/^[a-f0-9]{40}$/u.test(expected.source_commit) ||
    !/^refs\/tags\/portcove-[a-z0-9]+(?:-[a-z0-9]+){0,5}-prepared\/v[0-9A-Za-z.+-]{1,128}$/u.test(
      expected.ref,
    ) ||
    JSON.stringify(args) !==
      JSON.stringify([
        "attestation",
        "verify",
        filename,
        "--hostname",
        "github.com",
        "--repo",
        "boburning/portcove",
        "--signer-workflow",
        "boburning/portcove/.github/workflows/release.yml",
        "--signer-digest",
        expected.source_commit,
        "--source-digest",
        expected.source_commit,
        "--source-ref",
        expected.ref,
        "--cert-oidc-issuer",
        "https://token.actions.githubusercontent.com",
        "--deny-self-hosted-runners",
        "--predicate-type",
        "https://slsa.dev/provenance/v1",
        "--limit",
        "5",
        "--format",
        "json",
      ])
  )
    throw new Error("native public compiler attestation command differs");
}

async function sourceTransport(parent: Parent, directory: string) {
  await parent.recheck();
  const fixed = parent.transport_configuration;
  const toolIdentity = toolBytes(fixed.github_cli.path, fixed.github_cli.sha256);
  const checkToolIdentity = () => {
    remainingNativeParentBudget();
    const observed = lstatSync(fixed.github_cli.path);
    if (
      !observed.isFile() ||
      observed.isSymbolicLink() ||
      observed.dev !== toolIdentity.dev ||
      observed.ino !== toolIdentity.ino ||
      observed.size !== toolIdentity.size ||
      observed.mtimeMs !== toolIdentity.mtimeMs
    )
      throw new Error("native fixed source tool identity changed");
  };
  const tokenBytes = await readBoundedPublicBuildInputFile(
    path.dirname(fixed.source_read_token),
    path.basename(fixed.source_read_token),
    16384,
  );
  const token = tokenBytes.toString("utf8").trim();
  if (!/^[A-Za-z0-9_-]{20,16384}$/u.test(token))
    throw new Error("native protected source credential has unsupported bytes");
  tokenBytes.fill(0);
  await parent.recheck();
  const config = path.join(directory, "empty-gh-config");
  await mkdir(config, { mode: 0o700 });
  const env = Object.freeze({
    ...(process.platform === "win32" && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
    PATH: path.dirname(fixed.github_cli.path),
    HOME: config,
    USERPROFILE: config,
    GH_CONFIG_DIR: config,
    GH_HOST: "github.com",
    GH_TOKEN: token,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
  });
  // The closure is never passed to candidate code or exported as a provenance
  // constructor. Only maintained read-only collectors below receive adapters.
  const textSpawn: NonNullable<NonNullable<Parameters<typeof createGitHubRunner>[0]>["spawn"]> = (
    command,
    args,
    options,
  ) => {
    if (command !== "gh") throw new Error("native source executable selection refused");
    inspectNativeSourceCommand(args, options.input);
    checkToolIdentity();
    const result = spawnSync(fixed.github_cli.path, args, { ...options, env });
    checkToolIdentity();
    return result;
  };
  const api = new GitHubApiClient((args, input) =>
    createGitHubRunner({ cwd: directory, maxBuffer: 2 * 1024 * 1024, spawn: textSpawn })(
      [...args, "--hostname", "github.com"],
      input,
    ),
  );
  const opaque =
    (reader: typeof readGitHubArtifactArchive): typeof readGitHubArtifactArchive =>
    (endpoint, options) =>
      reader(endpoint, {
        ...options,
        spawn: (command, args, spawnOptions) => {
          if (command !== "gh") throw new Error("native source executable selection refused");
          inspectNativeSourceCommand(args);
          checkToolIdentity();
          const result = spawnSync(fixed.github_cli.path, args, { ...spawnOptions, env });
          checkToolIdentity();
          return result;
        },
      });
  const download = opaque(readGitHubArtifactArchive);
  const downloadAsset = opaque(readGitHubReleaseAsset);
  const recover = () =>
    recoverRemoteCoordinator(
      directory,
      { schema_version: 1, namespace: parent.descriptor.namespace },
      { transport: { cwd: directory, spawn: textSpawn } },
    );
  const recheck = async () => {
    await parent.recheck();
    checkToolIdentity();
    toolBytes(fixed.github_cli.path, fixed.github_cli.sha256);
  };
  const verifier = (controller: { controller_revision: string; controller_ref: string }) => {
    const expected = Object.freeze({ ...controller });
    const spawn: NonNullable<NonNullable<Parameters<typeof createGitHubRunner>[0]>["spawn"]> = (
      command,
      args,
      options,
    ) => {
      if (command !== "gh") throw new Error("native verifier executable selection refused");
      inspectNativeControllerVerificationCommand(args, directory, expected);
      checkToolIdentity();
      const result = spawnSync(fixed.github_cli.path, args, { ...options, env });
      checkToolIdentity();
      return result;
    };
    return spawn;
  };
  const releaseVerifier = (identity: { source_commit: string; ref: string }) => {
    const expected = Object.freeze({ ...identity });
    if (!expected.ref.startsWith(`refs/tags/${parent.descriptor.namespace}-prepared/v`))
      throw new Error("public compiler source escaped installed namespace");
    const spawn: NonNullable<NonNullable<Parameters<typeof createGitHubRunner>[0]>["spawn"]> = (
      command,
      args,
      options,
    ) => {
      if (command !== "gh") throw new Error("native public verifier executable selection refused");
      inspectNativeReleaseVerificationCommand(args, directory, expected);
      checkToolIdentity();
      const result = spawnSync(fixed.github_cli.path, args, {
        ...options,
        timeout: Math.min(options.timeout ?? 60000, remainingNativeParentBudget(60000)),
        env,
      });
      checkToolIdentity();
      return result;
    };
    return spawn;
  };
  return { api, download, downloadAsset, recover, recheck, verifier, releaseVerifier };
}

/** The public journey uses the same installed parent's read-only source tool
 * and credential custody. It never adopts a hosted tool/admission brand or an
 * incoming candidate. The protected descriptor appoints one fixed cohort rule. */
export async function openActualNativePublicSource(parentReceipt: object) {
  const parent = await requireActualNativeParent(parentReceipt);
  if (parent.descriptor.public_journey?.profile !== "ordinary-public-initial-cohort-v1")
    throw new Error("actual protected public journey profile required");
  const verifier = parent.transport_configuration.post_sign_verifier;
  const git = parent.transport_configuration.windows_tools?.git;
  const signature = parent.transport_configuration.public_signature_control;
  if (
    !verifier ||
    !releasePathContains(parent.controller_root, verifier.path) ||
    (signature && !releasePathContains(parent.controller_root, signature.path)) ||
    (parent.descriptor.platform_label === "windows-x86_64" &&
      (!git || !releasePathContains(parent.controller_root, git.path)))
  )
    throw new Error(
      "public source tools must be staged inside the actual protected controller tree",
    );
  const directory = await mkdtemp(
    path.join(parent.descriptor.capture_root, "native-public-source-"),
  );
  const source = await sourceTransport(parent, directory);
  await parent.recheck();
  return { parent, parent_receipt: parentReceipt, directory, source };
}

const selections = new WeakMap<
  object,
  {
    parent: object;
    directory: string;
    packagePath: string;
    packageSha256: string;
    packageBytes: number;
    predecessor?: { path: string; bytes: number; sha256: string; version: string };
    payloadCrypto?: {
      file: string;
      sha256: string;
      signed_context_sha256: string;
      signatures_sha256: string;
    };
    version: string;
    facts: Readonly<Pick<PreparedReleaseAdmissionFacts, "assembly" | "archives" | "checkpoint">>;
    request: ReturnType<typeof prepareNativeStageRequest>;
    recovery: ReturnType<typeof nativeInvocationIdentity>["counters"];
    recover: Awaited<ReturnType<typeof sourceTransport>>["recover"];
    recheckSource: Awaited<ReturnType<typeof sourceTransport>>["recheck"];
    api: GitHubApiClient;
  }
>();

/** Association only: the controller run is the producer of the final signed
 * role, not the candidate compiler's different release_run. The actual parent
 * below obtains this operation from its authenticated existing journal. */
export function inspectNativePostSignController(
  rawOperation: unknown,
  rawCandidate: unknown,
  controllerRevision: string,
) {
  const operation = inspectCapacityOperation(rawOperation);
  if (!isRecord(rawCandidate)) throw new Error("post-sign native reservation absent");
  const expected = Object.fromEntries(
    ["prepared_commit", "source_commit", "version", "transient_retries", "substantive_repairs"].map(
      (key) => [key, rawCandidate[key]],
    ),
  );
  const executor = operation?.executor_identity;
  if (
    !operation ||
    !operation.candidate ||
    digest(operation.candidate) !== digest(expected) ||
    !["building", "publishing"].includes(String(rawCandidate.phase)) ||
    operation.kind !== "upload" ||
    operation.destination !==
      `github-actions:boburning/portcove:${String(rawCandidate.version)}:tuf-timestamp-envelope` ||
    operation.receipt_limit !== 1 ||
    operation.completed_effects.length !== 1 ||
    !(
      operation.outcome === "succeeded" ||
      (operation.outcome === "recovered" &&
        isRecord(operation.recovery) &&
        operation.recovery.resolution === "effect-completed")
    ) ||
    !executor ||
    executor.role !== "tuf-timestamp" ||
    executor.run_attempt !== 1 ||
    executor.controller_revision !== controllerRevision ||
    executor.workflow !== ".github/workflows/application-update-production.yml" ||
    !/^refs\/tags\/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(
      executor.execution_ref,
    )
  )
    throw new Error("post-sign native run lacks exact completed candidate timestamp operation");
  return Object.freeze({
    controller_revision: executor.controller_revision,
    controller_ref: executor.execution_ref,
    run_id: String(executor.run_id),
    run_attempt: executor.run_attempt,
    operation_id: operation.id,
    operation_sha256: digest(operation),
    authority: "none" as const,
  });
}

/** No incoming run locator or injected provider. Compact history is hydrated
 * through its original retained Git checkpoints, never through latest-run
 * heuristics or imported success flags. Still only public source provenance. */
const postSignControllers = new WeakMap<
  object,
  {
    parent: object;
    source: Awaited<ReturnType<typeof sourceTransport>>;
    directory: string;
    checkpoint: string;
    candidate: Record<string, unknown>;
    controller: ReturnType<typeof inspectNativePostSignController>;
    retainedBytes: Buffer;
  }
>();
export async function readActualNativePostSignController(parentReceipt: object) {
  const parent = await requireActualNativeParent(parentReceipt);
  const directory = await mkdtemp(path.join(parent.descriptor.capture_root, "native-post-sign-"));
  const source = await sourceTransport(parent, directory);
  const before = await source.recover();
  const input = before.input;
  if (!isRecord(input.active_candidate) || !isRecord(input.controller))
    throw new Error("actual post-sign reservation missing");
  const candidate = input.active_candidate;
  const capacity = input.controller.capacity_attempt;
  if (!isRecord(capacity) || capacity.schema_version !== 2)
    throw new Error("post-sign native requires existing bounded operation history");
  const raws: { checkpoint: string; operation: unknown }[] = [];
  if (capacity.operation !== null)
    raws.push({ checkpoint: before.checkpoint, operation: capacity.operation });
  const groups = inspectCompactCapacityOperations(capacity.prior_operations).filter(
    (group) =>
      group.subject.kind === "candidate" &&
      group.subject.identity === candidate.prepared_commit &&
      group.kind === "upload" &&
      group.destination_sha256 ===
        digest(
          `github-actions:boburning/portcove:${String(candidate.version)}:tuf-timestamp-envelope`,
        ),
  );
  for (const group of groups) {
    for (const proof of group.attempts) {
      const operation = await hydrateRetainedCoordinatorOperation(before.repository, proof, {
        api: source.api,
      });
      raws.push({ checkpoint: proof.checkpoint, operation });
    }
  }
  const matches = raws.flatMap((entry) => {
    try {
      return [
        {
          ...entry,
          controller: inspectNativePostSignController(
            entry.operation,
            candidate,
            parent.descriptor.controller_revision,
          ),
        },
      ];
    } catch {
      return [];
    }
  });
  if (matches.length !== 1)
    throw new Error("exact post-sign controller operation missing or ambiguous; preserve history");
  await source.recheck();
  const after = await source.recover();
  if (before.checkpoint !== after.checkpoint)
    throw new Error("post-sign reservation changed during retained history acquisition");
  const retained = {
    checkpoint: before.checkpoint,
    candidate: structuredClone(candidate),
    timestamp: matches[0],
    authority: "none",
    scope: "parent-owned journal source only; signed context and native execution pending",
  };
  const retainedBytes = Buffer.from(JSON.stringify(retained));
  await writeFile(path.join(directory, "original-controller-selection.json"), retainedBytes, {
    flag: "wx",
    mode: 0o600,
  });
  const receipt = Object.freeze({
    kind: "actual-native-post-sign-controller-source",
    directory,
    authority: "none",
    scope: retained.scope,
  });
  postSignControllers.set(receipt, {
    parent: parentReceipt,
    source,
    directory,
    checkpoint: before.checkpoint,
    candidate: structuredClone(candidate),
    controller: matches[0]!.controller,
    retainedBytes,
  });
  return receipt;
}

export async function requireActualNativePostSignController(receipt: object) {
  const retained = postSignControllers.get(receipt);
  if (!retained) throw new Error("actual native post-sign controller source required");
  const parent = await requireActualNativeParent(retained.parent);
  await retained.source.recheck();
  const original = await readBoundedPublicBuildInputFile(
    retained.directory,
    "original-controller-selection.json",
    256 * 1024,
  );
  if (!original.equals(retained.retainedBytes))
    throw new Error("retained post-sign controller selection changed");
  const current = await retained.source.recover();
  if (
    current.checkpoint !== retained.checkpoint ||
    digest(current.input.active_candidate) !== digest(retained.candidate)
  )
    throw new Error("post-sign native reservation advanced; reconcile before execution");
  await parent.recheck();
  return {
    parent,
    directory: retained.directory,
    checkpoint: retained.checkpoint,
    candidate: structuredClone(retained.candidate),
    controller: { ...retained.controller },
    authority: "none" as const,
    scope: "parent-owned journal source only; signed context and native execution pending" as const,
  };
}

/** Complete bounded per-run inventory selects public locators only. Every
 * artifact's provider custody, producer and signature are verified separately. */
export function inspectNativePostSignArtifactInventory(
  raw: unknown,
  controller: {
    run_id: string;
    run_attempt: number;
    controller_revision: string;
  },
) {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.artifacts) ||
    raw.total_count !== raw.artifacts.length ||
    raw.artifacts.length > 100 ||
    controller.run_attempt !== 1 ||
    !/^[1-9][0-9]{0,15}$/u.test(controller.run_id) ||
    !Number.isSafeInteger(Number(controller.run_id)) ||
    !/^[a-f0-9]{40}$/u.test(controller.controller_revision)
  )
    throw new Error("complete bounded post-sign artifact inventory unavailable");
  const seen = new Set<number>();
  const artifacts = raw.artifacts.map((item: unknown) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "number" ||
      !Number.isSafeInteger(item.id) ||
      item.id < 1 ||
      seen.has(item.id) ||
      typeof item.name !== "string"
    )
      throw new Error("post-sign artifact inventory identity duplicated or absent");
    seen.add(item.id);
    return item;
  });
  const select = (name: string, maximum: number) => {
    const rows = artifacts.filter((item) => item.name === name),
      item = rows[0];
    if (
      rows.length !== 1 ||
      !item ||
      item.expired !== false ||
      typeof item.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(item.digest) ||
      typeof item.size_in_bytes !== "number" ||
      !Number.isSafeInteger(item.size_in_bytes) ||
      item.size_in_bytes < 22 ||
      item.size_in_bytes > maximum ||
      !isRecord(item.workflow_run) ||
      item.workflow_run.id !== Number(controller.run_id) ||
      item.workflow_run.repository_id !== 1354613114 ||
      item.workflow_run.head_repository_id !== 1354613114 ||
      item.workflow_run.head_sha !== controller.controller_revision
    )
      throw new Error("exact post-sign public artifact missing or changed");
    return Object.freeze({
      id: Number(item.id),
      sha256: item.digest.slice(7),
      bytes: item.size_in_bytes,
    });
  };
  return Object.freeze({
    context: select(`trusted-payload-signing-context-${controller.run_id}-1`, 128 * 1024 ** 2),
    context_bundle: select(
      `trusted-payload-signing-context-attestation-${controller.run_id}-1`,
      4 * 1024 ** 2,
    ),
    roles: Object.freeze(
      (["releases", "preview", "stable", "snapshot", "timestamp"] as const).map((role) =>
        Object.freeze({
          role,
          artifact: select(`trusted-tuf-${role}-output-${controller.run_id}-1`, 2 * 1024 ** 2),
          bundle: select(`trusted-tuf-${role}-attestation-${controller.run_id}-1`, 4 * 1024 ** 2),
        }),
      ),
    ),
    authority: "none" as const,
  });
}

/** Executes the maintained public receivers with this parent's fixed read-only
 * credential and exact gh verifier. Injected-provider scope is retained: local
 * source custody cannot manufacture a hosted private publication receipt. */
export async function readActualNativePostSignPublicInputs(controllerReceipt: object) {
  const original = postSignControllers.get(controllerReceipt);
  const selected = await requireActualNativePostSignController(controllerReceipt);
  if (!original) throw new Error("actual post-sign source session unavailable");
  const source = original.source,
    controller = selected.controller,
    directory = await mkdtemp(path.join(selected.directory, "public-inputs-"));
  const authorities = inspectNativePrepublicationAuthorities(
    selected.parent.authority_configuration,
  );
  const publicPins = inspectPublicationAuthorities(
    authorities.publication,
    authorities.schema_version,
  );
  const deadline = performance.now() + remainingNativeParentBudget(300000);
  const active = () => {
    if (performance.now() >= deadline)
      throw new Error("native public input acquisition deadline exhausted");
  };
  const inventory = () => {
    active();
    const response = source.api.request(
      "GET",
      `repos/boburning/portcove/actions/runs/${controller.run_id}/artifacts?per_page=100`,
    );
    active();
    if (response.status !== 200) throw new Error("post-sign artifact inventory unavailable");
    return inspectNativePostSignArtifactInventory(response.body, controller);
  };
  const before = inventory();
  const zipEndpoint = `repos/boburning/portcove/actions/artifacts/${before.context.id}/zip`;
  const contextArchive = source.download(zipEndpoint, {
    cwd: directory,
    maxBytes: before.context.bytes,
    timeoutMs: 30000,
  });
  if (
    contextArchive.length !== before.context.bytes ||
    hash(contextArchive) !== before.context.sha256
  )
    throw new Error("native public context archive differs from provider identity");
  const inspected = inspectSigningContextArchive(contextArchive);
  for (const [name, expectedHash] of [
    ["trusted-root.json", publicPins.public_source.root.sha256],
    ["offline-targets.json", publicPins.public_source.offline_targets.sha256],
    ["payload.json", publicPins.public_source.payload_key_registry.sha256],
  ] as const) {
    const bytes = inspected.files.get(name);
    if (!bytes || hash(bytes) !== expectedHash)
      throw new Error("native public context anchors differ from independently pinned setup");
  }
  const factsSha256 = inspected.manifest.facts_sha256;
  if (typeof factsSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(factsSha256))
    throw new Error("native signed context lacks exact facts digest");
  const { bytes: _contextBytes, ...artifact } = before.context,
    { bytes: _bundleBytes, ...bundle } = before.context_bundle;
  const expected = {
    controller_revision: controller.controller_revision,
    source_tree: selected.parent.controller_tree,
    controller_ref: controller.controller_ref,
    run_id: controller.run_id,
    run_attempt: controller.run_attempt,
    artifact,
    bundle,
    manifest_sha256: inspected.manifest_sha256,
    binding_sha256: digest(inspected.manifest.binding),
    facts_sha256: factsSha256,
  };
  const cachedDownload: typeof readGitHubArtifactArchive = (endpoint, options) =>
    endpoint === zipEndpoint ? Buffer.from(contextArchive) : source.download(endpoint, options);
  const context = await receiveSigningContextArtifact(directory, expected, deadline, {
    api: source.api,
    download: cachedDownload,
    spawn: source.verifier(controller),
  });
  const candidate = selected.candidate,
    facts = inspected.manifest.facts;
  if (!isRecord(facts) || digest(facts.opportunity) !== digest(candidate.frozen_opportunity))
    throw new Error("actual signed context differs from reserved complete opportunity");
  const { accepted } = await inspectTrustedAssemblyInput(facts.assembly);
  if (
    accepted.release_profile !== "initial-beta-win-linux" ||
    accepted.source_commit !== candidate.prepared_commit ||
    accepted.source_tree !== candidate.prepared_tree ||
    accepted.version !== candidate.version ||
    !isRecord(candidate.release_run) ||
    accepted.run_id !== String(candidate.release_run.run_id) ||
    accepted.run_attempt !== candidate.release_run.attempt
  )
    throw new Error(
      "native signed context differs from exact reserved compiler run/prepared source",
    );
  const roles = [];
  for (const role of before.roles) {
    const { bytes: _artifactBytes, ...artifact } = role.artifact,
      { bytes: _attestationBytes, ...bundle } = role.bundle;
    roles.push(
      await readAttestedTufRoleArtifact(
        directory,
        {
          role: role.role,
          controller: {
            controller_revision: expected.controller_revision,
            source_tree: expected.source_tree,
            controller_ref: expected.controller_ref,
            run_id: expected.run_id,
            run_attempt: expected.run_attempt,
          },
          artifact,
          bundle,
          context_manifest_sha256: expected.manifest_sha256,
          context_binding_sha256: expected.binding_sha256,
          context_facts_sha256: expected.facts_sha256,
        },
        deadline,
        { api: source.api, download: source.download, spawn: source.verifier(controller) },
      ),
    );
  }
  active();
  if (digest(inventory()) !== digest(before))
    throw new Error("post-sign artifact inventory changed during acquisition");
  await requireActualNativePostSignController(controllerReceipt);
  await writeFile(
    path.join(directory, "public-inputs-source.json"),
    JSON.stringify({
      controller,
      inventory: before,
      context: expected,
      envelopes: roles.map((role) => role.envelope),
      authority: "none",
      scope: "local parent-owned crypto/provider source; keyless Tough and native capture pending",
    }),
    { flag: "wx", mode: 0o600 },
  );
  return Object.freeze({
    directory,
    context,
    roles: Object.freeze(roles),
    authority: "none" as const,
    scope:
      "local parent-owned crypto/provider source; keyless Tough and native capture pending" as const,
  });
}

async function runActualNativeKeylessChild(
  controllerReceipt: object,
  planPath: string,
  planSha256: string,
  directory: string,
) {
  const selected = await requireActualNativePostSignController(controllerReceipt);
  const tool = selected.parent.transport_configuration.post_sign_verifier;
  if (!tool) throw new Error("actual native keyless verifier pin absent");
  const signal = new EventEmitter();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status: number;
  try {
    status = await runResourceCommand(
      "analysis",
      process.execPath,
      [
        path.join(selected.parent.controller_root, "scripts/release-native-keyless-assembly.mts"),
        planPath,
        planSha256,
      ],
      {
        cwd: selected.parent.controller_root,
        environment: {
          SystemRoot: process.env.SystemRoot,
          LANG: "C.UTF-8",
          PATH: path.dirname(process.execPath),
        },
        exclusive: [`native-keyless:${selected.parent.descriptor.namespace}`],
        supervise: (args, options) =>
          runRustTests(args, {
            ...options,
            tempRoot: directory,
            signalTarget: signal,
            acquireLock: async (metadata, admission) => {
              if (!options.acquireLock)
                throw new Error("native keyless source-bound resource admission required");
              const lease = await options.acquireLock(metadata, admission);
              try {
                await requireActualNativePostSignController(controllerReceipt);
                toolBytes(tool.path, tool.sha256);
                timer = setTimeout(
                  () => signal.emit("SIGTERM"),
                  remainingNativeParentBudget(180000),
                );
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
  await requireActualNativePostSignController(controllerReceipt);
  toolBytes(tool.path, tool.sha256);
  if (status !== 0)
    throw new Error("native keyless child failed; preserve original inputs and partial effects");
}

/** Actual local parent owns the only child invocation. The utility's JSON is
 * never treated as a hosted or native brand; original public proofs, fixed tool
 * bytes, complete repository bytes and the current journal remain necessary. */
export async function assembleActualNativePostSignRepository(controllerReceipt: object) {
  const selected = await requireActualNativePostSignController(controllerReceipt);
  const tool = selected.parent.transport_configuration.post_sign_verifier;
  if (!tool) throw new Error("protected installation keyless native verifier pin absent");
  toolBytes(tool.path, tool.sha256);
  const inputs = await readActualNativePostSignPublicInputs(controllerReceipt);
  const contextDirectory = path.join(inputs.context.directory, "context");
  const plan = inspectNativeKeylessAssemblyPlan(
    {
      schema_version: 1,
      context_directory: contextDirectory,
      output_parent: inputs.directory,
      tool,
      signed_roles: inputs.roles.map((role) => role.envelope),
    },
    inputs.directory,
  );
  const wire = Buffer.from(JSON.stringify({ schema_version: 1, ...plan }));
  const planPath = path.join(inputs.directory, "native-keyless-plan.json");
  await writeFile(planPath, wire, { flag: "wx", mode: 0o600 });
  await runActualNativeKeylessChild(controllerReceipt, planPath, hash(wire), inputs.directory);
  const resultBytes = await readBoundedPublicBuildInputFile(
    inputs.directory,
    "native-keyless-result.json",
    1024 * 1024,
  );
  const result: unknown = JSON.parse(resultBytes.toString("utf8"));
  if (
    !isRecord(result) ||
    Object.keys(result).sort().join(",") !==
      "assembled,authority,plan_sha256,schema_version,scope" ||
    result.schema_version !== 1 ||
    result.authority !== "none" ||
    result.plan_sha256 !== hash(wire) ||
    !isRecord(result.assembled) ||
    typeof result.assembled.directory !== "string" ||
    typeof result.assembled.repository !== "string" ||
    !releasePathContains(inputs.directory, result.assembled.directory) ||
    result.assembled.repository !== path.join(result.assembled.directory, "repository")
  )
    throw new Error("native keyless child result does not match original source-bound plan");
  const assembled = result.assembled;
  const publication = inspectTufPublicationFacts(assembled.publication);
  const files = await readBoundedReleaseContextFiles(result.assembled.repository);
  const inventory = [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) }));
  const publicFiles = inventory.filter((file) => file.path !== "repository-manifest.json");
  if (
    digest(inventory) !== digest(assembled.files) ||
    digest(publicFiles) !== publication.repository_sha256
  )
    throw new Error("native keyless repository changed after owned child completion");
  await requireActualNativePostSignController(controllerReceipt);
  return Object.freeze({
    directory: inputs.directory,
    inputs,
    assembled: structuredClone(assembled),
    publication,
    repository: result.assembled.repository,
    authority: "none" as const,
    scope:
      "local parent-owned keyless verification; native package capture still required" as const,
  });
}

/** Local association reuses the hosted journey contract while retaining local
 * source/Tough custody scope. No imported data can enter this private parent path. */
export async function readActualNativePostSignJourney(controllerReceipt: object) {
  const original = postSignControllers.get(controllerReceipt);
  if (!original) throw new Error("actual post-sign source session required");
  const verified = await assembleActualNativePostSignRepository(controllerReceipt);
  const selected = await requireActualNativePostSignController(controllerReceipt);
  const current = await original.source.recover();
  if (current.checkpoint !== selected.checkpoint)
    throw new Error("native post-sign journal changed before journey association");
  const authorities = inspectNativePrepublicationAuthorities(
    selected.parent.authority_configuration,
  );
  const context = verified.inputs.context;
  const files = await readBoundedReleaseContextFiles(path.join(context.directory, "context"));
  const manifestBytes = await readBoundedPublicBuildInputFile(
    context.directory,
    "signing-context-manifest.json",
    1024 * 1024,
  );
  if (hash(manifestBytes) !== context.manifest_sha256)
    throw new Error("native retained authenticated context manifest changed");
  const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
  if (!isRecord(manifest) || typeof verified.publication.repository_sha256 !== "string")
    throw new Error("native post-sign context identity missing");
  const fileInventory = [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) }));
  if (digest(fileInventory) !== digest(manifest.files))
    throw new Error("native context files changed after authenticated keyless assembly");
  const journeys = deriveNativePublicationJourneys({
    files,
    coordinator_input: current.input,
    manifest,
    namespace: authorities.namespace,
    signed_context_sha256: verified.publication.repository_sha256,
    platform_labels: [selected.parent.descriptor.platform_label],
    public_pins: inspectPublicationAuthorities(authorities.publication, authorities.schema_version),
    authority_schema_version: authorities.schema_version,
    api: original.source.api,
  });
  const journey = journeys[0];
  let predecessorRecord: Record<string, unknown> | null = null;
  if (isRecord(journey) && isRecord(journey.predecessor)) {
    const predecessor = inspectNativeQualificationCandidate(journey.predecessor);
    const records = [...files]
      .filter(([name]) => name.startsWith("prior/targets/"))
      .map(([, bytes]) => JSON.parse(bytes.toString("utf8")) as unknown)
      .filter(
        (record) =>
          isRecord(record) &&
          record.target === selected.parent.descriptor.platform_label &&
          record.source_commit === predecessor.source_commit &&
          isRecord(record.artifact) &&
          record.artifact.sha256 === predecessor.package.sha256 &&
          record.artifact.bytes === predecessor.package.bytes,
      );
    if (records.length !== 1 || !isRecord(records[0]))
      throw new Error("native exact predecessor record ambiguous");
    predecessorRecord = records[0];
  }
  await requireActualNativePostSignController(controllerReceipt);
  await writeFile(
    path.join(verified.directory, "native-journey-source.json"),
    JSON.stringify({
      checkpoint: current.checkpoint,
      journey: journeys[0],
      repository_sha256: verified.publication.repository_sha256,
      authority: "none",
    }),
    { flag: "wx", mode: 0o600 },
  );
  return Object.freeze({
    ...verified,
    manifest: structuredClone(manifest),
    journey: structuredClone(journeys[0]),
    predecessor_record: structuredClone(predecessorRecord),
    authority: "none" as const,
    scope:
      "actual local parent/Tough journey association; native execution still required" as const,
  });
}

/** Exact data association only; the actual factory supplies independently
 * authenticated context facts and real immutable provider readback. */
export async function inspectNativePostSignPackageMetadata(
  rawFacts: unknown,
  platform: string,
  raw: unknown,
) {
  if (!isRecord(rawFacts) || !Array.isArray(rawFacts.archives))
    throw new Error("native signed context archive inventory absent");
  const archives = rawFacts.archives.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join(",") !== "artifact_id,bytes,platform,sha256" ||
      typeof entry.platform !== "string" ||
      typeof entry.artifact_id !== "number" ||
      !Number.isSafeInteger(entry.artifact_id) ||
      entry.artifact_id < 1 ||
      typeof entry.bytes !== "number" ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 22 ||
      entry.bytes > 512 * 1024 * 1024 ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    )
      throw new Error("native signed context archive identity invalid");
    return {
      platform: entry.platform,
      artifact_id: entry.artifact_id,
      bytes: entry.bytes,
      sha256: entry.sha256,
    };
  });
  const { accepted, labels } = await inspectTrustedAssemblyInput(rawFacts.assembly);
  const matches = archives.filter((entry) => entry.platform === platform),
    archive = matches[0];
  if (
    accepted.release_profile !== "initial-beta-win-linux" ||
    labels.length !== 2 ||
    archives.length !== 2 ||
    new Set(archives.map((entry) => entry.artifact_id)).size !== 2 ||
    archives
      .map((entry) => entry.platform)
      .sort()
      .join(",") !== [...labels].sort().join(",") ||
    !archive ||
    matches.length !== 1 ||
    !isRecord(raw) ||
    raw.id !== archive.artifact_id ||
    raw.name !== releaseBuildArtifactName(platform, accepted.run_id, accepted.run_attempt) ||
    raw.expired !== false ||
    raw.size_in_bytes !== archive.bytes ||
    raw.digest !== `sha256:${archive.sha256}` ||
    !isRecord(raw.workflow_run) ||
    raw.workflow_run.id !== Number(accepted.run_id) ||
    raw.workflow_run.repository_id !== 1354613114 ||
    raw.workflow_run.head_repository_id !== 1354613114 ||
    raw.workflow_run.head_sha !== accepted.source_commit
  )
    throw new Error("native package archive differs from exact signed candidate/compiler source");
  return { accepted, archives, archive, authority: "none" as const };
}

/** Association only: the exact Tough record and historical native tuple must
 * both identify the same currently immutable public Release asset. */
export function inspectNativePredecessorReleaseAsset(
  rawRecord: unknown,
  rawCandidate: unknown,
  rawRelease: unknown,
  rawAssets: unknown,
) {
  const candidate = inspectNativeQualificationCandidate(rawCandidate);
  return inspectPublicImmutableReleaseAsset(rawRecord, candidate, rawRelease, rawAssets);
}

/** Exact public record/package association only, with no native or build
 * artifact identity inferred from a Release asset identifier. */
export function inspectPublicImmutableReleaseAsset(
  rawRecord: unknown,
  candidate: Pick<
    ReturnType<typeof inspectNativeQualificationCandidate>,
    "source_commit" | "source_tree" | "package"
  >,
  rawRelease: unknown,
  rawAssets: unknown,
) {
  if (
    !isRecord(rawRecord) ||
    !isRecord(rawRecord.artifact) ||
    !isRecord(rawRelease) ||
    !Array.isArray(rawAssets) ||
    rawAssets.length > 64 ||
    typeof rawRecord.version !== "string" ||
    !/^[0-9]+[.][0-9]+[.][0-9]+(?:-[A-Za-z0-9.-]+)?$/u.test(rawRecord.version) ||
    rawRecord.source_commit !== candidate.source_commit ||
    rawRecord.source_tree !== candidate.source_tree ||
    rawRecord.artifact.bytes !== candidate.package.bytes ||
    rawRecord.artifact.sha256 !== candidate.package.sha256 ||
    typeof rawRecord.artifact.url !== "string" ||
    rawRelease.tag_name !== `v${rawRecord.version}` ||
    rawRelease.draft !== false ||
    rawRelease.immutable !== true ||
    typeof rawRelease.id !== "number" ||
    !Number.isSafeInteger(rawRelease.id) ||
    rawRelease.id < 1 ||
    typeof rawRelease.published_at !== "string" ||
    !Number.isFinite(Date.parse(rawRelease.published_at))
  )
    throw new Error("native predecessor immutable Release binding differs");
  const url = new URL(rawRecord.artifact.url);
  if (
    url.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    decodeURIComponent(url.pathname) !==
      `/boburning/portcove/releases/download/v${rawRecord.version}/${candidate.package.filename}`
  )
    throw new Error("native predecessor URL is outside exact Release");
  const ids = new Set<number>();
  for (const item of rawAssets) {
    if (
      !isRecord(item) ||
      typeof item.id !== "number" ||
      !Number.isSafeInteger(item.id) ||
      item.id < 1 ||
      ids.has(item.id)
    )
      throw new Error("native predecessor asset inventory ambiguous");
    ids.add(item.id);
  }
  const rows = rawAssets.filter(
      (item) => isRecord(item) && item.name === candidate.package.filename,
    ),
    asset: unknown = rows[0];
  if (
    rows.length !== 1 ||
    !isRecord(asset) ||
    asset.state !== "uploaded" ||
    asset.size !== candidate.package.bytes ||
    asset.digest !== `sha256:${candidate.package.sha256}` ||
    asset.browser_download_url !== rawRecord.artifact.url ||
    asset.url !==
      `https://api.github.com/repos/boburning/portcove/releases/assets/${String(asset.id)}`
  )
    throw new Error("native predecessor exact immutable asset absent");
  return Object.freeze({
    release_id: rawRelease.id,
    id: Number(asset.id),
    version: rawRecord.version,
    bytes: candidate.package.bytes,
    sha256: candidate.package.sha256,
    filename: candidate.package.filename,
    authority: "none" as const,
  });
}

/** The same installed parent owns signed-input/Tough verification, exact opaque
 * package acquisition and the report2 request. It never imports a journey or
 * substitutes a successful native/admission result for byte custody. */
export async function acquireActualNativePostSignCandidate(parentReceipt: object) {
  const controllerReceipt = await readActualNativePostSignController(parentReceipt);
  const original = postSignControllers.get(controllerReceipt);
  if (!original) throw new Error("actual native source session missing");
  const verified = await readActualNativePostSignJourney(controllerReceipt);
  const selected = await requireActualNativePostSignController(controllerReceipt);
  const parent = selected.parent,
    platform = parent.descriptor.platform_label;
  const facts = verified.manifest.facts;
  if (!isRecord(facts) || !Array.isArray(facts.archives))
    throw new Error("native signed facts missing");
  const rows = facts.archives.filter(
    (entry: unknown) => isRecord(entry) && entry.platform === platform,
  );
  if (rows.length !== 1 || !isRecord(rows[0]) || typeof rows[0].artifact_id !== "number")
    throw new Error("native signed platform archive absent");
  const endpoint = `repos/boburning/portcove/actions/artifacts/${rows[0].artifact_id}`;
  const read = () => {
    const response = original.source.api.request("GET", endpoint);
    if (response.status !== 200) throw new Error("native exact package archive unavailable");
    return response.body;
  };
  const before = read(),
    identity = await inspectNativePostSignPackageMetadata(facts, platform, before);
  const archiveBytes = original.source.download(`${endpoint}/zip`, {
    cwd: verified.directory,
    maxBytes: identity.archive.bytes,
    timeoutMs: remainingNativeParentBudget(120000),
  });
  let retained: { identity: Identity; bytes: Buffer } | undefined;
  await discoverReleaseArtifactFiles(
    archiveBytes,
    { bytes: identity.archive.bytes, sha256: identity.archive.sha256 },
    platform,
    {
      version: identity.accepted.version,
      run_id: identity.accepted.run_id,
      run_attempt: identity.accepted.run_attempt,
      source_commit: identity.accepted.source_commit,
    },
    {
      retainDesktopPackage: async (metadata, bytes) => {
        if (retained) throw new Error("native signed updater package duplicated");
        retained = { identity: structuredClone(metadata), bytes: Buffer.from(bytes) };
      },
    },
  );
  if (!retained) throw new Error("native signed updater package missing");
  const after = read();
  await inspectNativePostSignPackageMetadata(facts, platform, after);
  if (digest(before) !== digest(after))
    throw new Error("native exact package provider identity changed");
  await requireActualNativePostSignController(controllerReceipt);
  const selectedFacts = {
    assembly: facts.assembly,
    archives: identity.archives,
    checkpoint: selected.checkpoint,
  };
  const packageIdentity = await inspectSelectedNativeCandidate(selectedFacts, platform, retained);
  const current = await original.source.recover();
  if (current.checkpoint !== selected.checkpoint || !isRecord(current.input.active_candidate))
    throw new Error("native signed candidate reservation changed");
  const recovery = {
    transient_retries: current.input.active_candidate.transient_retries,
    substantive_repairs: current.input.active_candidate.substantive_repairs,
  };
  const rawRequest = {
    schema_version: 1,
    stage: "release-publication",
    platform_label: platform,
    candidate: packageIdentity.candidate,
    journey: verified.journey,
    invocation_id: "0".repeat(64),
    setup_descriptor_sha256: parent.descriptor_sha256,
  };
  const provisional = prepareNativeStageRequest(rawRequest, parent.authority_configuration);
  const invocation = nativeInvocationIdentity(provisional, recovery);
  const request = prepareNativeStageRequest(
    { ...rawRequest, invocation_id: invocation.invocation_id },
    parent.authority_configuration,
  );
  let predecessor: { path: string; bytes: number; sha256: string; version: string } | undefined;
  if (isRecord(verified.journey) && "predecessor" in verified.journey) {
    const record = verified.predecessor_record;
    if (!record || typeof record.version !== "string")
      throw new Error("native actual predecessor record absent");
    const releaseEndpoint = `repos/boburning/portcove/releases/tags/${encodeURIComponent(`v${record.version}`)}`;
    const readRelease = () => {
      const response = original.source.api.request("GET", releaseEndpoint);
      if (
        response.status !== 200 ||
        !isRecord(response.body) ||
        typeof response.body.id !== "number"
      )
        throw new Error("native predecessor Release unavailable");
      const assets = original.source.api.paginateRest(
        `repos/boburning/portcove/releases/${response.body.id}/assets`,
        {
          identity: (item: unknown) => {
            if (!isRecord(item) || typeof item.id !== "number")
              throw new Error("native asset identity absent");
            return String(item.id);
          },
          label: "native predecessor immutable assets",
        },
      );
      return { release: response.body, assets };
    };
    const before = readRelease();
    const asset = inspectNativePredecessorReleaseAsset(
      record,
      verified.journey.predecessor,
      before.release,
      before.assets,
    );
    const bytes = original.source.downloadAsset(
      `repos/boburning/portcove/releases/assets/${asset.id}`,
      {
        cwd: verified.directory,
        maxBytes: asset.bytes,
        timeoutMs: remainingNativeParentBudget(120000),
      },
    );
    if (bytes.length !== asset.bytes || hash(bytes) !== asset.sha256)
      throw new Error("native predecessor bytes differ from exact Tough identity");
    const after = readRelease();
    const repeated = inspectNativePredecessorReleaseAsset(
      record,
      verified.journey.predecessor,
      after.release,
      after.assets,
    );
    if (digest(asset) !== digest(repeated))
      throw new Error("native predecessor provider state changed");
    const filename = `predecessor-${asset.filename}`;
    await writeFile(path.join(verified.directory, filename), bytes, { flag: "wx", mode: 0o600 });
    predecessor = {
      path: path.join(verified.directory, filename),
      bytes: asset.bytes,
      sha256: asset.sha256,
      version: asset.version,
    };
  }
  const packagePath = path.join(verified.directory, packageIdentity.candidate.package.filename);
  await writeFile(packagePath, retained.bytes, { flag: "wx", mode: 0o600 });
  const contextFiles = await readBoundedReleaseContextFiles(
    path.join(verified.inputs.context.directory, "context"),
  );
  const releaseRecords = [...contextFiles]
    .filter(([name]) => name.startsWith("records/releases/"))
    .map(([, bytes]) => JSON.parse(bytes.toString("utf8")) as unknown)
    .filter(
      (record) =>
        isRecord(record) &&
        record.target === platform &&
        record.source_commit === packageIdentity.candidate.source_commit &&
        record.version === packageIdentity.version &&
        isRecord(record.artifact) &&
        record.artifact.sha256 === packageIdentity.candidate.package.sha256 &&
        record.artifact.bytes === packageIdentity.candidate.package.bytes,
    );
  if (
    releaseRecords.length !== 1 ||
    !isRecord(releaseRecords[0]) ||
    !isRecord(releaseRecords[0].artifact)
  )
    throw new Error("native exact signed candidate record missing");
  const signedArtifact = releaseRecords[0].artifact;
  const registryBytes = contextFiles.get("payload.json");
  if (!registryBytes) throw new Error("native payload key registry absent");
  const registry: unknown = JSON.parse(registryBytes.toString("utf8"));
  if (!isRecord(registry) || !Array.isArray(registry.keys) || registry.keys.length > 32)
    throw new Error("native payload key registry invalid");
  const keys = registry.keys.filter(
    (key: unknown) => isRecord(key) && key.id === signedArtifact.payload_key_id,
  );
  if (
    keys.length !== 1 ||
    !isRecord(keys[0]) ||
    typeof keys[0].tauri_public_key !== "string" ||
    typeof signedArtifact.tauri_signature !== "string" ||
    typeof signedArtifact.payload_key_id !== "string"
  )
    throw new Error("native exact public payload key/signature absent");
  const signaturePath = path.join(verified.directory, "native-payload.sig"),
    publicKeyPath = path.join(verified.directory, "native-payload.key");
  await writeFile(signaturePath, signedArtifact.tauri_signature, { flag: "wx", mode: 0o600 });
  await writeFile(publicKeyPath, keys[0].tauri_public_key, { flag: "wx", mode: 0o600 });
  const tool = parent.transport_configuration.post_sign_verifier;
  if (!tool) throw new Error("native protected payload verifier absent");
  const payloadPlan = inspectNativePayloadVerificationPlan(
    {
      schema_version: 1,
      artifact: packagePath,
      signature: signaturePath,
      public_key: publicKeyPath,
      public_key_sha256: signedArtifact.payload_key_id,
      sha256: packageIdentity.candidate.package.sha256,
      bytes: packageIdentity.candidate.package.bytes,
      version: packageIdentity.version,
      tool,
      output_parent: verified.directory,
    },
    verified.directory,
  );
  const payloadWire = Buffer.from(
    JSON.stringify({ schema_version: 1, ...payloadPlan, output_parent: verified.directory }),
  );
  const payloadPlanPath = path.join(verified.directory, "native-payload-plan.json");
  await writeFile(payloadPlanPath, payloadWire, { flag: "wx", mode: 0o600 });
  await runActualNativeKeylessChild(
    controllerReceipt,
    payloadPlanPath,
    hash(payloadWire),
    verified.directory,
  );
  const payloadResult = await readBoundedPublicBuildInputFile(
    verified.directory,
    "native-payload-result.json",
    1024 * 1024,
  );
  const crypto: unknown = JSON.parse(payloadResult.toString("utf8"));
  if (
    !isRecord(crypto) ||
    crypto.plan_sha256 !== hash(payloadWire) ||
    !isRecord(crypto.report) ||
    crypto.report.signature_verified !== true ||
    crypto.report.sha256 !== packageIdentity.candidate.package.sha256 ||
    crypto.report.bytes !== packageIdentity.candidate.package.bytes ||
    crypto.report.public_key_sha256 !== signedArtifact.payload_key_id
  )
    throw new Error("native owned payload verification result differs");
  if (
    !isRecord(verified.journey) ||
    typeof verified.journey.signed_context_sha256 !== "string" ||
    typeof verified.journey.signatures_sha256 !== "string"
  )
    throw new Error("native exact signed journey binding missing");
  const payloadCrypto = {
    file: "native-payload-result.json",
    sha256: hash(payloadResult),
    signed_context_sha256: verified.journey.signed_context_sha256,
    signatures_sha256: verified.journey.signatures_sha256,
  };

  await writeFile(path.join(verified.directory, "request.json"), JSON.stringify(request), {
    flag: "wx",
    mode: 0o600,
  });
  const receipt = Object.freeze({
    kind: "actual-native-post-sign-candidate-selection",
    directory: verified.directory,
    authority: "none",
    scope: "signed package/journey custody only; native execution pending",
  });
  selections.set(receipt, {
    parent: parentReceipt,
    directory: verified.directory,
    packagePath,
    ...(predecessor ? { predecessor } : {}),
    payloadCrypto,
    packageSha256: packageIdentity.candidate.package.sha256,
    packageBytes: packageIdentity.candidate.package.bytes,
    version: packageIdentity.version,
    facts: selectedFacts,
    request,
    recovery: invocation.counters,
    recover: original.source.recover,
    recheckSource: async () => {
      await original.source.recheck();
      const current = await requireActualNativePostSignController(controllerReceipt);
      const tool = current.parent.transport_configuration.post_sign_verifier;
      if (!tool) throw new Error("native original verifier pin missing");
      toolBytes(tool.path, tool.sha256);
      const manifest = await readBoundedPublicBuildInputFile(
        verified.inputs.context.directory,
        "signing-context-manifest.json",
        1024 * 1024,
      );
      if (hash(manifest) !== verified.inputs.context.manifest_sha256)
        throw new Error("native signed source context changed after package selection");
      const repositoryFiles = await readBoundedReleaseContextFiles(verified.repository);
      const inventory = [...repositoryFiles]
        .filter(([name]) => name !== "repository-manifest.json")
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) }));
      if (digest(inventory) !== verified.publication.repository_sha256)
        throw new Error("native signed repository changed after package selection");
    },
    api: original.source.api,
  });
  await requireActualNativeCandidate(receipt);
  return receipt;
}

/** Existing journal timing selects the native stage. An unresolved timestamp
 * intent selects post-sign readback/refusal, never a fallback pre-sign rerun. */
export function inspectNativeCurrentStage(raw: unknown) {
  if (
    !isRecord(raw) ||
    !isRecord(raw.active_candidate) ||
    !isRecord(raw.controller) ||
    !isRecord(raw.controller.capacity_attempt)
  )
    throw new Error("native stage requires actual candidate/coordinator state");
  const candidate = raw.active_candidate,
    capacity = raw.controller.capacity_attempt;
  if (
    !["building", "publishing"].includes(String(candidate.phase)) ||
    capacity.schema_version !== 2
  )
    throw new Error("native stage candidate is not eligible for either fixed capture stage");
  const destination = `github-actions:boburning/portcove:${String(candidate.version)}:tuf-timestamp-envelope`;
  const operation = inspectCapacityOperation(capacity.operation);
  const sameCounters = (input: {
    prepared_commit?: unknown;
    transient_retries?: unknown;
    substantive_repairs?: unknown;
  }) =>
    input.prepared_commit === candidate.prepared_commit &&
    input.transient_retries === candidate.transient_retries &&
    input.substantive_repairs === candidate.substantive_repairs;
  const currentTimestamp =
    operation &&
    operation.candidate &&
    sameCounters(operation.candidate) &&
    operation.kind === "upload" &&
    operation.destination === destination;
  const retainedTimestamp = inspectCompactCapacityOperations(capacity.prior_operations).some(
    (group) =>
      group.subject.kind === "candidate" &&
      group.subject.identity === candidate.prepared_commit &&
      group.transient_retries === candidate.transient_retries &&
      group.substantive_repairs === candidate.substantive_repairs &&
      group.kind === "upload" &&
      group.destination_sha256 === digest(destination),
  );
  return candidate.phase === "publishing" || currentTimestamp || retainedTimestamp
    ? ("release-publication" as const)
    : ("payload-signing" as const);
}
export async function acquireActualNativeStageCandidate(parentReceipt: object) {
  const parent = await requireActualNativeParent(parentReceipt);
  const directory = await mkdtemp(
    path.join(parent.descriptor.capture_root, "native-stage-selection-"),
  );
  const source = await sourceTransport(parent, directory),
    before = await source.recover();
  const stage = inspectNativeCurrentStage(before.input);
  await writeFile(
    path.join(directory, "stage-source.json"),
    JSON.stringify({ checkpoint: before.checkpoint, stage, authority: "none" }),
    { flag: "wx", mode: 0o600 },
  );
  await source.recheck();
  if ((await source.recover()).checkpoint !== before.checkpoint)
    throw new Error("native stage changed during selection");
  const selected =
    stage === "payload-signing"
      ? await acquireActualNativeCandidate(parentReceipt)
      : await acquireActualNativePostSignCandidate(parentReceipt);
  const current = await requireActualNativeCandidate(selected);
  if (current.request.request.stage !== stage || current.checkpoint !== before.checkpoint)
    throw new Error("native stage/reservation changed during immutable input preparation");
  return selected;
}

/** No injected transport or incoming candidate tuple can enter this factory.
 * It selects only the current reserved run, retaining a data-only request. */
export async function acquireActualNativeCandidate(parentReceipt: object) {
  const parent = await requireActualNativeParent(parentReceipt);
  const directory = await mkdtemp(path.join(parent.descriptor.capture_root, "native-selection-"));
  const source = await sourceTransport(parent, directory);
  const packages = new Map<string, { identity: Identity; bytes: Buffer }>();
  let selected: {
    facts: Readonly<PreparedReleaseAdmissionFacts>;
    identity: Awaited<ReturnType<typeof inspectSelectedNativeCandidate>>;
    bytes: Buffer;
  } | null = null;
  try {
    await acquireReleaseAdmission(
      directory,
      {
        schema_version: 2,
        namespace: parent.descriptor.namespace,
        release_profile: "initial-beta-win-linux",
      },
      {
        api: source.api,
        download: source.download,
        recover: source.recover,
        controlPhase: "payload",
        retainDesktopPackage: async (identity, bytes) => {
          if (identity.platform_label !== parent.descriptor.platform_label) return;
          if (packages.has(identity.platform_label)) throw new Error("native package repeats");
          packages.set(identity.platform_label, { identity: structuredClone(identity), bytes });
        },
        establishNative: async (facts) => {
          await parent.recheck();
          const retained = packages.get(parent.descriptor.platform_label);
          if (!retained) throw new Error("native selected platform package absent");
          const identity = await inspectSelectedNativeCandidate(
            facts,
            parent.descriptor.platform_label,
            retained,
          );
          selected = { facts, identity, bytes: retained.bytes };
          // Intentionally no native result. Existing pair validation refuses this
          // empty return; selection cannot mint a successful admission context.
          return [];
        },
      },
    );
    throw new Error("native selection unexpectedly passed admission");
  } catch (error) {
    if (
      !selected ||
      !(error instanceof CoordinatorRemoteError) ||
      !isRecord(error.evidence) ||
      error.evidence.phase !== "actual-stage-native-qualification"
    )
      throw error;
  }
  // Callback effects are retained privately; TypeScript does not track closure
  // assignment across the collector's awaited invocation.
  const value = selected as {
    facts: Readonly<PreparedReleaseAdmissionFacts>;
    identity: Awaited<ReturnType<typeof inspectSelectedNativeCandidate>>;
    bytes: Buffer;
  };
  const current = await source.recover();
  if (current.checkpoint !== value.facts.checkpoint)
    throw new Error("native reservation changed after immutable acquisition");
  await source.recheck();
  if (!isRecord(current.input) || !isRecord(current.input.active_candidate))
    throw new Error("native invocation lacks the actual active recovery counters");
  const recovery = {
    transient_retries: current.input.active_candidate.transient_retries,
    substantive_repairs: current.input.active_candidate.substantive_repairs,
  };
  const prepared = prepareNativeStageRequest(
    {
      schema_version: 1,
      stage: "payload-signing",
      platform_label: parent.descriptor.platform_label,
      candidate: value.identity.candidate,
      journey: null,
      invocation_id: "0".repeat(64),
      setup_descriptor_sha256: parent.descriptor_sha256,
    },
    parent.authority_configuration,
  );
  const invocation = nativeInvocationIdentity(prepared, recovery);
  const request = prepareNativeStageRequest(
    {
      schema_version: 1,
      stage: prepared.request.stage,
      platform_label: prepared.request.platform_label,
      candidate: prepared.request.candidate,
      journey: prepared.request.journey,
      invocation_id: invocation.invocation_id,
      setup_descriptor_sha256: parent.descriptor_sha256,
    },
    parent.authority_configuration,
  );
  const packagePath = path.join(directory, value.identity.candidate.package.filename);
  await writeFile(packagePath, value.bytes, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(directory, "request.json"), JSON.stringify(request), {
    flag: "wx",
    mode: 0o600,
  });
  await parent.recheck();
  const receipt = Object.freeze({
    kind: "actual-native-candidate-selection",
    directory,
    scope: "actual source/package selection only; native execution pending",
    authority: "none",
  });
  selections.set(receipt, {
    parent: parentReceipt,
    directory,
    packagePath,
    packageSha256: value.identity.candidate.package.sha256,
    packageBytes: value.identity.candidate.package.bytes,
    version: value.identity.version,
    facts: value.facts,
    request,
    recovery: invocation.counters,
    recover: source.recover,
    recheckSource: source.recheck,
    api: source.api,
  });
  packages.clear();
  return receipt;
}

/** Incoming files are locators/data only. Reconstruction binds the original
 * request to the currently appointed producer, host and compatibility scope. */
export function inspectNativeCheckRecoveryPlan(
  rawRequest: unknown,
  rawExpectedCheck: unknown,
  rawAuthorities: unknown,
) {
  if (
    !isRecord(rawRequest) ||
    !isRecord(rawRequest.request) ||
    !isRecord(rawExpectedCheck) ||
    Object.keys(rawExpectedCheck).sort().join(",") !== "body,endpoint,method" ||
    rawExpectedCheck.method !== "POST" ||
    rawExpectedCheck.endpoint !== "repos/boburning/portcove/check-runs" ||
    !isRecord(rawExpectedCheck.body) ||
    !isRecord(rawExpectedCheck.body.output) ||
    typeof rawExpectedCheck.body.output.summary !== "string" ||
    Buffer.byteLength(rawExpectedCheck.body.output.summary) > 64 * 1024
  )
    throw new Error("native original Check request is missing or malformed");
  const prior = rawRequest.request;
  const prepared = prepareNativeStageRequest(
    {
      schema_version: 1,
      stage: prior.stage,
      platform_label: prior.platform_label,
      candidate: prior.candidate,
      journey: prior.journey,
      invocation_id: prior.invocation_id,
      setup_descriptor_sha256: prior.setup_descriptor_sha256,
    },
    rawAuthorities,
  );
  if (
    prepared.request_sha256 !== rawRequest.request_sha256 ||
    digest(prepared.request) !== digest(prior)
  )
    throw new Error("native original Check request differs from current appointed inputs");
  const summary: unknown = JSON.parse(rawExpectedCheck.body.output.summary);
  if (!isRecord(summary)) throw new Error("native original Check report is absent");
  const wire = prepareNativeQualificationCheck(summary.report);
  const report = wire.report;
  if (
    digest(rawExpectedCheck.body) !== digest(wire.body) ||
    report.stage !== prepared.request.stage ||
    report.platform_label !== prepared.request.platform_label ||
    digest(report.candidate) !== digest(prepared.request.candidate) ||
    report.producer.invocation_id !== prepared.request.invocation_id ||
    digest(report.journey) !== digest(prepared.request.journey)
  )
    throw new Error("native retained Check wire differs from its original invocation");
  const schema = prepared.request.native_report_schema_version ?? 1;
  if (
    report.schema_version !== schema ||
    (schema === 2 &&
      report.native_prepublication_profile !== prepared.request.native_prepublication_profile)
  )
    throw new Error("native retained Check temporal profile differs from selected configuration");
  return { prepared, wire, authority: "none" as const };
}

/** GET-only reconciliation through this parent's privately owned real source
 * transport. The reused consumer remains injected-provider/unbranded, so these
 * observations cannot clear admission or mint native acceptance. */
export async function reconcileActualNativeCheck(
  selection: object,
  originalRequest: unknown,
  expectedCheck: unknown,
) {
  const retained = selections.get(selection);
  if (!retained) throw new Error("actual parent-owned native selection required for readback");
  const value = await requireActualNativeCandidate(selection);
  const plan = inspectNativeCheckRecoveryPlan(
    originalRequest,
    expectedCheck,
    value.parent.authority_configuration,
  );
  const { report } = plan.wire;
  const endpoint = `repos/boburning/portcove/commits/${report.candidate.source_commit}/check-runs?check_name=${encodeURIComponent(nativeQualificationCheckName)}&filter=all&per_page=100`;
  const response = retained.api.request("GET", endpoint);
  if (
    response.status !== 200 ||
    !isRecord(response.body) ||
    !Number.isSafeInteger(response.body.total_count) ||
    typeof response.body.total_count !== "number" ||
    response.body.total_count < 0 ||
    response.body.total_count > 100 ||
    !Array.isArray(response.body.check_runs) ||
    response.body.check_runs.length !== response.body.total_count
  )
    throw new Error("native Check readback inventory is incomplete; preserve original attempt");
  const issuer = value.parent.authority_configuration.apps.native_qualification.app_id;
  const matches = response.body.check_runs.filter(
    (raw: unknown) =>
      isRecord(raw) &&
      isRecord(raw.app) &&
      raw.app.id === issuer &&
      raw.head_sha === report.candidate.source_commit &&
      raw.name === nativeQualificationCheckName &&
      raw.external_id === plan.wire.body.external_id,
  );
  if (matches.length !== 1 || !isRecord(matches[0]))
    throw new Error("native Check outcome remains missing or ambiguous; no replay");
  const id = matches[0].id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
    throw new Error("native Check readback identity is invalid");
  const fixed = plan.prepared.request.expected;
  const receipt = await collectNativeReleaseQualification(
    retained.directory,
    {
      schema_version: plan.prepared.request.native_report_schema_version ?? 1,
      ...(plan.prepared.request.native_report_schema_version === 2
        ? {
            native_prepublication_profile: plan.prepared.request.native_prepublication_profile,
          }
        : {}),
      check_id: id,
      native_app_id: issuer,
      semantic_app_id: value.parent.authority_configuration.apps.semantic.app_id,
      classification_app_id: value.parent.authority_configuration.apps.classification.app_id,
      stage: report.stage,
      platform_label: report.platform_label,
      candidate: plan.prepared.request.candidate,
      producer: { ...fixed.producer, invocation_id: plan.prepared.request.invocation_id },
      host: fixed.host,
      compatibility: fixed.compatibility,
      journey: plan.prepared.request.journey,
    },
    { api: retained.api },
  );
  await retained.recheckSource();
  return Object.freeze({
    check_id: receipt.check_id,
    report_sha256: receipt.report_sha256,
    directory: receipt.directory,
    consumer_scope: receipt.evidence_scope,
    scope: "real parent-owned GET readback only; no admission/native acceptance",
    authority: "none" as const,
  });
}

export async function requireActualNativeCandidate(receipt: object) {
  const value = selections.get(receipt);
  if (!value) throw new Error("actual parent-owned native candidate selection required");
  const parent = await requireActualNativeParent(value.parent);
  await value.recheckSource();
  const current = await value.recover();
  if (current.checkpoint !== value.facts.checkpoint)
    throw new Error("native selection reservation advanced; readback/recovery required");
  const bytes = await readBoundedPublicBuildInputFile(
    value.directory,
    path.basename(value.packagePath),
    512 * 1024 * 1024,
  );
  if (bytes.length !== value.packageBytes || hash(bytes) !== value.packageSha256)
    throw new Error("native selected package changed after acquisition");
  if (value.payloadCrypto) {
    const crypto = await readBoundedPublicBuildInputFile(
      value.directory,
      value.payloadCrypto.file,
      1024 * 1024,
    );
    if (hash(crypto) !== value.payloadCrypto.sha256)
      throw new Error("native actual payload crypto capture changed");
    const result: unknown = JSON.parse(crypto.toString("utf8"));
    if (!isRecord(result)) throw new Error("native retained crypto capture invalid");
    for (const name of ["stdout", "stderr"] as const) {
      const stream = await readBoundedPublicBuildInputFile(
        value.directory,
        `native-payload.${name}.bin`,
        1024 * 1024,
      );
      if (hash(stream) !== result[`${name}_sha256`])
        throw new Error("native original crypto stream changed");
    }
  }
  if (value.predecessor) {
    const predecessor = await readBoundedPublicBuildInputFile(
      value.directory,
      path.basename(value.predecessor.path),
      512 * 1024 * 1024,
    );
    if (
      predecessor.length !== value.predecessor.bytes ||
      hash(predecessor) !== value.predecessor.sha256
    )
      throw new Error("native original predecessor package changed");
  }
  await parent.recheck();
  await value.recheckSource();
  return {
    parent,
    request: value.request,
    package_path: value.packagePath,
    predecessor: value.predecessor ? Object.freeze({ ...value.predecessor }) : null,
    payload_cryptography: value.payloadCrypto ? Object.freeze({ ...value.payloadCrypto }) : null,
    version: value.version,
    directory: value.directory,
    checkpoint: value.facts.checkpoint,
    recovery: value.recovery,
    authority: "none" as const,
    scope: "actual source/package selection only; native execution pending" as const,
  };
}

/** The private local reader authenticates exact immutable candidate source data.
 * This does not appoint source declarations as observed native acceptance. */
export async function readActualNativeSourceDeclarations(receipt: object) {
  const retained = selections.get(receipt);
  if (!retained) throw new Error("actual native source selection required");
  const selected = await requireActualNativeCandidate(receipt);
  const files: Record<string, Buffer> = {};
  for (const pathname of nativeCompatibilitySourcePaths) {
    const response = retained.api.request(
      "GET",
      `repos/boburning/portcove/contents/${pathname}?ref=${selected.request.request.candidate.source_commit}`,
    );
    const raw = response.body;
    if (
      response.status !== 200 ||
      !isRecord(raw) ||
      raw.type !== "file" ||
      raw.path !== pathname ||
      raw.encoding !== "base64" ||
      typeof raw.size !== "number" ||
      raw.size < 1 ||
      raw.size > 1024 * 1024 ||
      typeof raw.content !== "string" ||
      raw.content.length > 2 * 1024 * 1024 ||
      typeof raw.sha !== "string" ||
      !/^[a-f0-9]{40}$/u.test(raw.sha)
    )
      throw new Error("native source provider declaration is incomplete");
    const compact = raw.content.replace(/\n/gu, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact))
      throw new Error("native source encoding is invalid");
    const bytes = Buffer.from(compact, "base64");
    if (
      bytes.byteLength !== raw.size ||
      bytes.toString("base64") !== compact ||
      createHash("sha1")
        .update(Buffer.from(`blob ${bytes.length}\0`))
        .update(bytes)
        .digest("hex") !== raw.sha
    )
      throw new Error("native immutable source bytes differ from provider identity");
    files[pathname] = bytes;
    const filename = `native-source-${nativeCompatibilitySourcePaths.indexOf(pathname)}.bin`;
    try {
      const original = await readBoundedPublicBuildInputFile(
        retained.directory,
        filename,
        1024 * 1024,
      );
      if (!original.equals(bytes))
        throw new Error("native retained source declaration changed; preserve original input");
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      await writeFile(path.join(retained.directory, filename), bytes, { flag: "wx", mode: 0o600 });
    }
  }
  const declaration = inspectNativeCompatibilitySources(files);
  await requireActualNativeCandidate(receipt);
  return Object.freeze({
    declaration,
    candidate: selected.request.request.candidate,
    scope: "actual source provider reads; declarations only, no native acceptance",
    authority: "none" as const,
  });
}
