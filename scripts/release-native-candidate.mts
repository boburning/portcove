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
import { readGitHubArtifactArchive } from "./github-binary.mts";
import {
  recoverRemoteCoordinator,
  hydrateRetainedCoordinatorOperation,
} from "./release-coordinator-recovery.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { artifactName } from "./release-package-policy.mts";
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
import { inspectNativeKeylessAssemblyPlan } from "./release-native-keyless-assembly.mts";
import { runResourceCommand } from "./resource-command.mts";
import { runRustTests } from "./run-rust-tests.mts";
import { readBoundedReleaseContextFiles } from "./release-signing-context.mts";
import { inspectTufPublicationFacts } from "./release-metadata-contract.mts";
import { inspectCapacityOperation, inspectCompactCapacityOperations } from "./release-capacity.mts";
import {
  prepareNativeQualificationCheck,
  collectNativeReleaseQualification,
} from "./release-native-acceptance.mts";
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
    stdin = false;
  for (let index = 1; index < args.length; index++) {
    const item = args[index];
    if (item === "--include") continue;
    if (item === "--hostname" && host === null) host = args[++index] ?? null;
    else if (item === "--method" && method === null) method = args[++index] ?? null;
    else if (item === "--input" && !stdin) {
      if (args[++index] !== "-") throw new Error("native source forbids body files");
      stdin = true;
    } else if (typeof item === "string" && !item.startsWith("-") && endpoint === null)
      endpoint = item;
    else throw new Error("native source command shape differs");
  }
  if (host !== "github.com" || !endpoint) throw new Error("native source host/route differs");
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
  const download: typeof readGitHubArtifactArchive = (endpoint, options) =>
    readGitHubArtifactArchive(endpoint, {
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
  return { api, download, recover, recheck, verifier };
}

const selections = new WeakMap<
  object,
  {
    parent: object;
    directory: string;
    packagePath: string;
    packageSha256: string;
    packageBytes: number;
    version: string;
    facts: Readonly<PreparedReleaseAdmissionFacts>;
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
  const publicPins = inspectPublicationAuthorities(authorities.publication);
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
        hash(wire),
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
            tempRoot: inputs.directory,
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
  await parent.recheck();
  await value.recheckSource();
  return {
    parent,
    request: value.request,
    package_path: value.packagePath,
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
