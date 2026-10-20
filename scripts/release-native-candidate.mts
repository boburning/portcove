/** Actual local-parent candidate selection. Provider acquisition deliberately
 * retains the admission collector's injected-provider scope: this module owns
 * its fixed transport and package custody, never an admission/native result. */
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { acquireReleaseAdmission } from "./acquire-release-admission.mts";
import type { PreparedReleaseAdmissionFacts } from "./acquire-release-admission.mts";
import { requireActualNativeParent } from "./release-native-parent.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { recoverRemoteCoordinator } from "./release-coordinator-recovery.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { artifactName } from "./release-package-policy.mts";
import { prepareNativeStageRequest } from "./release-native-stage-capture.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { isRecord } from "./runtime-values.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Parent = Awaited<ReturnType<typeof requireActualNativeParent>>;
type Identity = { platform_label: string; filename: string; bytes: number; sha256: string };

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

async function sourceTransport(parent: Parent, directory: string) {
  await parent.recheck();
  const fixed = parent.transport_configuration;
  const toolIdentity = toolBytes(fixed.github_cli.path, fixed.github_cli.sha256);
  const checkToolIdentity = () => {
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
  return { api, download, recover, recheck };
}

const selections = new WeakMap<
  object,
  {
    parent: object;
    directory: string;
    packagePath: string;
    packageSha256: string;
    packageBytes: number;
    facts: Readonly<PreparedReleaseAdmissionFacts>;
    request: ReturnType<typeof prepareNativeStageRequest>;
    recover: Awaited<ReturnType<typeof sourceTransport>>["recover"];
    recheckSource: Awaited<ReturnType<typeof sourceTransport>>["recheck"];
  }
>();

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
  const request = prepareNativeStageRequest(
    {
      schema_version: 1,
      stage: "payload-signing",
      platform_label: parent.descriptor.platform_label,
      candidate: value.identity.candidate,
      journey: null,
      invocation_id: randomBytes(32).toString("hex"),
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
    facts: value.facts,
    request,
    recover: source.recover,
    recheckSource: source.recheck,
  });
  packages.clear();
  return receipt;
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
    directory: value.directory,
    checkpoint: value.facts.checkpoint,
    authority: "none" as const,
    scope: "actual source/package selection only; native execution pending" as const,
  };
}
