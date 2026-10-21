import {
  assertCatalogReviewRequestBaseline,
  inspectCatalogReviewRequest,
} from "./release-catalog-review-request.mts";
import { readCatalogPublicationSourceBytes } from "./release-catalog-source.mts";
import { inspectCatalogSemanticRequestCheckMatches } from "./release-semantic-disposition-reader.mts";
import { reviewFrozenCatalogCoordinatorRequest } from "./release-semantic-request-pipeline.mts";
import {
  materializePublishedCatalogCompleteSite,
  requirePublishedCatalogCompleteSite,
} from "./release-site-readback.mts";
import { readBoundedReleaseContextFiles } from "./release-signing-context.mts";
import { execFileSync, spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import {
  inspectLinuxQualificationConfiguration,
  inspectLinuxQualificationSettlement,
} from "./qualify-semantic-linux.mts";
import { runResourceCommand } from "./resource-command.mts";
import { semanticSupervisorEnvironment } from "./release-semantic-runtime.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-remote.mts";
import {
  recoverRemoteCoordinator,
  readRemoteCoordinatorSnapshot,
} from "./release-coordinator-recovery.mts";
import { materializeSemanticSource } from "./release-semantic-source.mts";
import { inspectReleaseReviewRequest } from "./release-review-request.mts";
import {
  readIndependentSemanticCheckInventory,
  inspectSemanticRequestCheckMatches,
} from "./release-semantic-disposition-reader.mts";
import { semanticReviewCheckName } from "./release-semantic-review.mts";
import {
  readbackSemanticCheck,
  readbackSemanticDispositionCheck,
} from "./release-semantic-broker.mts";
import type { SemanticIssuerCustody } from "./release-semantic-issuer.mts";
import { reviewFrozenCoordinatorRequest } from "./release-semantic-request-pipeline.mts";
import { capacityDigest } from "./release-capacity.mts";
import { isRecord } from "./runtime-values.mts";
import { claimSemanticTechnicalAttempt } from "./release-semantic-worker-recovery.mts";

/** Inert routing only; simultaneous requests or malformed history cannot select a fallback. */
export function inspectSemanticWorkerRequest(input: unknown) {
  if (!isRecord(input)) throw new Error("semantic journal input unavailable");
  const catalog = inspectCatalogReviewRequest(input.catalog_review_request),
    application = inspectReleaseReviewRequest(input.review_request);
  if (catalog && application)
    throw new Error("simultaneous catalog/application requests require reconciliation");
  if (catalog) assertCatalogReviewRequestBaseline(catalog, input);
  if (catalog)
    return {
      purpose: "catalog" as const,
      request: catalog,
      source_commit: catalog.opportunity.source_commit,
      source_tree: catalog.opportunity.source_tree,
      base_commit: catalog.opportunity.base_commit,
    };
  if (application)
    return {
      purpose: "application" as const,
      request: application,
      source_commit: application.source_commit,
      source_tree: application.source_tree,
      base_commit: application.base_commit,
    };
  return null;
}

const entryStarted = performance.now();
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const repository = "repos/boburning/portcove";
const checkout = fileURLToPath(new URL("..", import.meta.url));
const absolute = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    path.posix.normalize(value) !== value ||
    /[\r\n\0]/u.test(value) ||
    value.split("/").includes("..")
  )
    throw new Error("semantic worker requires fixed absolute Linux paths");
  return value;
};

/** Reviewable initial setup output only. Installing/enabling these units and
 * authentication/custody are separate setup actions, never done by this code. */
export function renderSemanticWorkerUnits(
  raw: unknown,
  configurationPath: string,
  configurationSha256: string,
  workerCheckout: string,
) {
  const config = inspectSemanticWorkerEntryConfiguration(raw);
  const paths = [
    config.runtime.node_executable,
    absolute(configurationPath),
    absolute(workerCheckout),
  ];
  if (
    !paths.every((value) => /^\/[A-Za-z0-9_./-]+$/u.test(value)) ||
    !/^[a-f0-9]{64}$/u.test(configurationSha256)
  )
    throw new Error("fixed systemd unit paths/digest require literal safe configuration");
  if (
    "initial_setup_probe" in config &&
    path.posix.basename(configurationPath) !== "semantic-setup-probe.json"
  )
    throw new Error("initial probe requires its fixed configuration basename");
  return {
    service: `[Unit]\nDescription=Portcove bounded semantic request worker\nAfter=network-online.target\n\n[Service]\nType=oneshot\nWorkingDirectory=${workerCheckout}\nExecStart=${config.runtime.node_executable} ${workerCheckout}/scripts/release-semantic-worker.mts ${configurationPath} ${configurationSha256}\nUMask=0077\nTimeoutStartSec=2700\nTimeoutStopSec=30\nKillMode=control-group\nRestart=no\nStandardOutput=journal\nStandardError=journal\n`,
    timer:
      "[Unit]\nDescription=Observe Portcove semantic requests automatically\n\n[Timer]\nOnBootSec=2min\nOnUnitInactiveSec=5min\nRandomizedDelaySec=30s\nUnit=portcove-semantic-worker.service\n\n[Install]\nWantedBy=timers.target\n",
    initial_state: {
      schema_version: 1,
      kind:
        "initial_setup_probe" in config
          ? "portcove-semantic-setup-probe-custody"
          : "portcove-semantic-worker-custody",
      ...("initial_setup_probe" in config
        ? { configuration_sha256: configurationSha256 }
        : { namespace: config.namespace }),
      setup_grant_sha256: config.setup_grant_sha256,
      worker_revision: config.worker_revision,
    },
    authority: "none",
  };
}

/** Closed initial-only setup input. No credential, selector, outcome or native
 * acceptance field can be added to this configuration. It is not a grant. */
export function inspectSemanticSetupProbeConfiguration(raw: unknown) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !==
      "initial_setup_probe,kind,output_parent,runtime,schema_version,setup_grant_sha256,source_git_sha256,worker_revision" ||
    raw.schema_version !== 1 ||
    raw.kind !== "portcove-initial-semantic-boundary-probe" ||
    raw.initial_setup_probe !== true ||
    typeof raw.worker_revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(raw.worker_revision) ||
    typeof raw.setup_grant_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(raw.setup_grant_sha256) ||
    typeof raw.source_git_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(raw.source_git_sha256)
  )
    throw new Error("fixed credential-free initial semantic probe schema differs");
  const runtime = inspectLinuxQualificationConfiguration(raw.runtime);
  const output = absolute(raw.output_parent);
  if (runtime.output_parent !== output)
    throw new Error("initial semantic probe output boundary differs");
  return {
    initial_setup_probe: true as const,
    worker_revision: raw.worker_revision,
    setup_grant_sha256: raw.setup_grant_sha256,
    source_git_sha256: raw.source_git_sha256,
    output_parent: output,
    runtime,
  };
}

export function inspectSemanticWorkerEntryConfiguration(raw: unknown) {
  return isRecord(raw) && raw.kind === "portcove-initial-semantic-boundary-probe"
    ? inspectSemanticSetupProbeConfiguration(raw)
    : inspectSemanticWorkerConfiguration(raw);
}

/** Setup configuration only, never a supplied report, outcome or grant. The
 * fixed user unit independently pins its bytes after the consolidated setup. */
export function inspectSemanticWorkerConfiguration(raw: unknown) {
  const value: unknown = structuredClone(raw);
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "auth_cache,issuer,kind,namespace,output_parent,runtime,schema_version,setup_grant_sha256,source_git_sha256,source_read_token,source_repository,worker_revision" ||
    value.schema_version !== 1 ||
    value.kind !== "portcove-fixed-semantic-worker" ||
    !/^[a-f0-9]{40}$/u.test(String(value.worker_revision)) ||
    !/^[a-f0-9]{64}$/u.test(String(value.setup_grant_sha256)) ||
    !/^[a-f0-9]{64}$/u.test(String(value.source_git_sha256)) ||
    !isRecord(value.issuer) ||
    !isRecord(value.issuer.issuer)
  )
    throw new Error("semantic worker fixed setup schema differs");
  const runtime = inspectLinuxQualificationConfiguration(value.runtime);
  const ids = value.issuer.issuer;
  if (
    Object.keys(value.issuer).sort().join(",") !==
      "http_modules_sha256,issuer,node_sha256,private_key,public_key_sha256" ||
    Object.keys(ids).sort().join(",") !== "app_id,installation_id,writer_app_id" ||
    ![ids.app_id, ids.installation_id, ids.writer_app_id].every(
      (id) => Number.isSafeInteger(id) && Number(id) > 0,
    ) ||
    ids.app_id === ids.writer_app_id ||
    ids.app_id === 15368 ||
    !/^[a-f0-9]{64}$/u.test(String(value.issuer.public_key_sha256)) ||
    value.issuer.node_sha256 !== runtime.node_sha256 ||
    !isRecord(value.issuer.http_modules_sha256) ||
    Object.keys(value.issuer.http_modules_sha256).sort().join(",") !==
      "release-canonical.mts,release-semantic-issuer-http.mts,runtime-values.mts" ||
    Object.values(value.issuer.http_modules_sha256).some(
      (hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash),
    )
  )
    throw new Error("semantic worker issuer differs from the selected separated role");
  const namespace = inspectCoordinatorRemoteNamespace({
    schema_version: 1,
    namespace: value.namespace,
  });
  const authCache = absolute(value.auth_cache);
  if (path.basename(authCache) !== "auth.json")
    throw new Error("dedicated reviewer auth identity differs");
  const output = absolute(value.output_parent);
  if (runtime.output_parent !== output) throw new Error("semantic runtime output boundary differs");
  const credentials = [
    authCache,
    absolute(value.source_read_token),
    absolute(value.issuer.private_key),
  ];
  if (
    new Set(credentials).size !== 3 ||
    credentials.some(
      (file) =>
        file === output ||
        file.startsWith(`${output}/`) ||
        [runtime.node_executable, runtime.codex_executable].includes(file),
    )
  )
    throw new Error(
      "semantic source/reviewer/issuer credentials share a writable or executable boundary",
    );
  return {
    namespace,
    output_parent: output,
    auth_cache: authCache,
    source_repository: absolute(value.source_repository),
    source_git_sha256: String(value.source_git_sha256),
    source_read_token: absolute(value.source_read_token),
    worker_revision: String(value.worker_revision),
    setup_grant_sha256: String(value.setup_grant_sha256),
    runtime,
    issuer: {
      ...value.issuer,
      private_key: absolute(value.issuer.private_key),
    } as unknown as SemanticIssuerCustody,
  };
}

async function requirePrivateOwnerPath(filename: string, file: boolean) {
  const uid = process.getuid?.();
  if (process.platform !== "linux" || !uid || process.env.GITHUB_ACTIONS === "true")
    throw new Error("semantic worker requires its ordinary dedicated Linux parent");
  for (let current = filename; ; current = path.dirname(current)) {
    const info = await lstat(current);
    if (
      info.isSymbolicLink() ||
      ![0, uid].includes(info.uid) ||
      (info.mode & 0o022) !== 0 ||
      (current === filename &&
        (info.uid !== uid ||
          (info.mode & 0o077) !== 0 ||
          (file ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())))
    )
      throw new Error("semantic worker configuration/output ownership or isolation differs");
    if (path.dirname(current) === current) break;
  }
}
function git(root: string, args: string[], executable = "git") {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return execFileSync(
    executable,
    [
      "--no-optional-locks",
      "--no-replace-objects",
      "-C",
      root,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 128 * 1024,
      env: {
        ...(executable === "/usr/bin/git"
          ? {
              PATH: "/usr/bin:/bin",
              LANG: "C.UTF-8",
              HOME: root,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
            }
          : env),
        GIT_NO_LAZY_FETCH: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  ).trim();
}

async function retainProbeJson(directory: string, name: string, value: unknown) {
  const file = await open(path.join(directory, name), "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Atomic one-attempt exclusion only, not a runtime/semantic authority. */
export async function claimSemanticSetupProbe(
  output: string,
  identity: { configuration_sha256: string; setup_grant_sha256: string; worker_revision: string },
) {
  if (
    !path.isAbsolute(output) ||
    path.resolve(output) !== output ||
    Object.keys(identity).sort().join(",") !==
      "configuration_sha256,setup_grant_sha256,worker_revision" ||
    !/^[a-f0-9]{64}$/u.test(identity.configuration_sha256) ||
    !/^[a-f0-9]{64}$/u.test(identity.setup_grant_sha256) ||
    !/^[a-f0-9]{40}$/u.test(identity.worker_revision)
  )
    throw new Error("fixed initial probe claim identity required");
  const directory = path.join(output, "initial-setup-probe");
  await mkdir(directory, { mode: 0o700 }); // EEXIST always HOLD, including changed config or failed run.
  await retainProbeJson(directory, "claim.json", {
    schema_version: 1,
    ...identity,
    authority: "none",
  });
  return directory;
}

async function runInitialSemanticSetupProbe(
  config: ReturnType<typeof inspectSemanticSetupProbeConfiguration>,
  configurationPath: string,
  configurationSha256: string,
  readConfiguration: () => Promise<ReturnType<typeof inspectSemanticWorkerEntryConfiguration>>,
) {
  if (
    path.posix.basename(configurationPath) !== "semantic-setup-probe.json" ||
    process.env.NODE_OPTIONS ||
    process.env.NODE_PATH
  )
    throw new Error("initial probe fixed path or Node environment differs");
  await requirePrivateOwnerPath(config.output_parent, false);
  const expectedState = {
    schema_version: 1,
    kind: "portcove-semantic-setup-probe-custody",
    configuration_sha256: configurationSha256,
    setup_grant_sha256: config.setup_grant_sha256,
    worker_revision: config.worker_revision,
  };
  const state: unknown = JSON.parse(
    (
      await readBoundedPublicBuildInputFile(config.output_parent, "worker-state.json", 4096)
    ).toString("utf8"),
  );
  if (capacityDigest(state) !== capacityDigest(expectedState))
    throw new Error("initial probe custody differs; no claim or runtime");
  const deadline = entryStarted + 2670000; // Existing45min service ceiling, preserving30s stop reserve.
  const guard = async () => {
    if (performance.now() >= deadline)
      throw new Error("initial probe original service budget exhausted");
    if (capacityDigest(await readConfiguration()) !== capacityDigest(config))
      throw new Error("initial probe configuration changed");
    if (
      digest(await readBoundedPublicBuildInputFile("/usr/bin", "git", 32 * 1024 * 1024)) !==
        config.source_git_sha256 ||
      git(checkout, ["rev-parse", "HEAD"], "/usr/bin/git") !== config.worker_revision ||
      git(checkout, ["status", "--porcelain", "--untracked-files=no"], "/usr/bin/git") !== ""
    )
      throw new Error("initial probe fixed source/Git differs");
    if (
      digest(
        await readBoundedPublicBuildInputFile(
          path.dirname(config.runtime.node_executable),
          path.basename(config.runtime.node_executable),
          128 * 1024 * 1024,
        ),
      ) !== config.runtime.node_sha256 ||
      digest(
        await readBoundedPublicBuildInputFile(
          path.dirname(process.execPath),
          path.basename(process.execPath),
          128 * 1024 * 1024,
        ),
      ) !== config.runtime.node_sha256
    )
      throw new Error("initial probe running/configured Node differs");
  };
  await guard();
  const directory = await claimSemanticSetupProbe(config.output_parent, {
    configuration_sha256: configurationSha256,
    setup_grant_sha256: config.setup_grant_sha256,
    worker_revision: config.worker_revision,
  });
  try {
    await requirePrivateOwnerPath(directory, false);
    const qualification = { ...config.runtime, output_parent: directory };
    await retainProbeJson(directory, "qualification.json", qualification);
    const status = await runResourceCommand(
      "analysis",
      config.runtime.node_executable,
      [
        path.join(checkout, "scripts/qualify-semantic-linux.mts"),
        "fixture",
        path.join(directory, "qualification.json"),
      ],
      { cwd: checkout, queueDeadline: deadline, environment: semanticSupervisorEnvironment() },
    );
    await guard();
    const entries = await readdir(directory, { withFileTypes: true });
    const roots = entries.filter((entry) => entry.name.startsWith("q-"));
    if (
      roots.length !== 1 ||
      !roots[0]!.isDirectory() ||
      roots[0]!.isSymbolicLink() ||
      !/^q-[A-Za-z0-9]+$/u.test(roots[0]!.name)
    )
      throw new Error("initial probe original capture root absent or ambiguous");
    const capture = path.join(directory, roots[0]!.name, "capture");
    const raw = await readBoundedPublicBuildInputFile(capture, "isolation.json", 128 * 1024);
    const isolation: unknown = JSON.parse(raw.toString("utf8"));
    inspectLinuxQualificationSettlement(status, isolation, "fixture");
    await guard();
    const result = {
      schema_version: 1,
      decision: "initial-setup-probe-settled",
      scope:
        "inert Linux fixture boundary only; outer Task/service settlement requires independent readback",
      configuration_sha256: configurationSha256,
      root: roots[0]!.name,
      isolation_sha256: digest(raw),
      authority: "none",
      authenticated: false,
      semantic_acceptance: false,
      native_acceptance: false,
    };
    if (!raw.equals(await readBoundedPublicBuildInputFile(capture, "isolation.json", 128 * 1024)))
      throw new Error("initial probe original settlement changed");
    await retainProbeJson(directory, "probe-settlement.json", result);
    return { ...result, directory };
  } catch (error) {
    await retainProbeJson(directory, "probe-refusal.json", {
      schema_version: 1,
      outcome: "refused-retain-original-no-retry",
      authority: "none",
      message: error instanceof Error ? error.message.slice(0, 4096) : "unknown",
      semantic_acceptance: false,
    });
    throw error;
  }
}

/** Fixed once-only user-unit entry, not an always-on release service. Every
 * activation reads the existing remote journal; no human copies a selector.
 * The caller must install/qualify this unit under the separate setup grant. */
export async function runSemanticWorkerOnce(configurationPath: string, expectedSha256: string) {
  configurationPath = absolute(configurationPath);
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new Error("semantic setup digest unavailable");
  const readConfiguration = async () => {
    await requirePrivateOwnerPath(configurationPath, true);
    const bytes = await readBoundedPublicBuildInputFile(
      path.dirname(configurationPath),
      path.basename(configurationPath),
      32 * 1024,
    );
    if (digest(bytes) !== expectedSha256)
      throw new Error("semantic setup configuration changed; refuse without credentials");
    return inspectSemanticWorkerEntryConfiguration(JSON.parse(bytes.toString("utf8")));
  };
  const config = await readConfiguration();
  if ("initial_setup_probe" in config)
    return runInitialSemanticSetupProbe(
      config,
      configurationPath,
      expectedSha256,
      readConfiguration,
    );
  await requirePrivateOwnerPath(config.output_parent, false);
  const setupState: unknown = JSON.parse(
    (
      await readBoundedPublicBuildInputFile(config.output_parent, "worker-state.json", 4096)
    ).toString("utf8"),
  );
  if (
    capacityDigest(setupState) !==
    capacityDigest({
      schema_version: 1,
      kind: "portcove-semantic-worker-custody",
      namespace: config.namespace,
      setup_grant_sha256: config.setup_grant_sha256,
      worker_revision: config.worker_revision,
    })
  )
    throw new Error("installed semantic worker custody missing or changed; do not reset counters");
  const requireFixedCheckout = () => {
    if (
      git(checkout, ["rev-parse", "HEAD"]) !== config.worker_revision ||
      git(checkout, ["status", "--porcelain", "--untracked-files=no"]) !== ""
    )
      throw new Error("fixed semantic worker checkout differs from reviewed setup");
  };
  requireFixedCheckout();
  const namespace = { schema_version: 1, namespace: config.namespace };
  const directory = config.output_parent;
  // A separately provisioned source reader is not the producer, writer or
  // journal mutation credential. No ambient owner/issuer credential fallback.
  await requirePrivateOwnerPath(config.source_read_token, true);
  const sourceToken = (
    await readBoundedPublicBuildInputFile(
      path.dirname(config.source_read_token),
      path.basename(config.source_read_token),
      16 * 1024,
    )
  ).toString("utf8");
  if (!/^[\x21-\x7e]{1,16384}$/u.test(sourceToken))
    throw new Error("semantic source credential must be exact bounded token bytes");
  const environment = {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    GH_CONFIG_DIR: directory,
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
    GH_TOKEN: sourceToken,
  };
  const transport = {
    cwd: directory,
    spawn: (
      command: string,
      args: readonly string[],
      settings: SpawnSyncOptionsWithStringEncoding,
    ) => spawnSync(command, [...args], { ...settings, env: environment }),
  };
  const snapshot = await readRemoteCoordinatorSnapshot(directory, namespace, {
    transport,
  });
  const selected = inspectSemanticWorkerRequest(snapshot.input);
  if (!selected)
    return {
      decision: "no-review-request",
      checkpoint: snapshot.checkpoint,
      directory,
      authority: "none",
    };
  const request = selected.request;
  const runner = createGitHubRunner({
    cwd: directory,
    maxBuffer: 16 * 1024 * 1024,
    timeoutMs: 15000,
    spawn: transport.spawn,
  });
  const client = new GitHubApiClient((args, input) =>
    runner([...args, "--hostname", "github.com"], input),
  );
  const api = {
    request(method: string, endpoint: string) {
      if (method !== "GET") throw new Error("semantic source/readback transport is GET-only");
      return client.request(method, endpoint);
    },
    graphql(): never {
      throw new Error("semantic source/readback transport admits no GraphQL");
    },
  };
  const producer = {
    schema_version: 1,
    review_app_id: config.issuer.issuer.app_id,
    writer_app_id: config.issuer.issuer.writer_app_id,
    review_check_name: semanticReviewCheckName,
  };
  const requestDirectory = path.join(config.output_parent, `request-${request.request_id}`);
  const existingLocators: string[] = [];
  for (let index = 0; index < 3; index++) {
    const directory = path.join(requestDirectory, `technical-${index}`);
    try {
      await lstat(path.join(directory, "expected-check.json"));
      existingLocators.push(directory);
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
  }
  if (existingLocators.length > 1)
    throw new Error("multiple original Check requests require reconciliation");
  const inventory = readIndependentSemanticCheckInventory(api, producer, selected.source_commit);
  const matches = (
    selected.purpose === "catalog"
      ? inspectCatalogSemanticRequestCheckMatches
      : inspectSemanticRequestCheckMatches
  )(inventory.records, request);
  if (matches.accepted.length || matches.negative.length) {
    const row = inventory.records.find(
      (item) => item.id === (matches.accepted[0]?.check_run_id ?? matches.negative[0]),
    );
    if (
      !row ||
      typeof row.external_id !== "string" ||
      !isRecord(row.output) ||
      typeof row.output.summary !== "string"
    )
      throw new Error("existing semantic Check lacks an exact reconciliation locator");
    const expected = {
      head: selected.source_commit,
      external_id: row.external_id,
      summary: row.output.summary,
    };
    try {
      const retained: unknown = JSON.parse(
        (
          await readBoundedPublicBuildInputFile(
            existingLocators[0] ?? requestDirectory,
            "expected-check.json",
            128 * 1024,
          )
        ).toString("utf8"),
      );
      if (
        !isRecord(retained) ||
        !isRecord(retained.proposed_request) ||
        !isRecord(retained.proposed_request.body) ||
        !isRecord(retained.proposed_request.body.output) ||
        retained.proposed_request.body.head_sha !== expected.head ||
        retained.proposed_request.body.external_id !== expected.external_id ||
        retained.proposed_request.body.output.summary !== expected.summary
      )
        throw new Error("provider result differs from the retained original POST request");
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      let attemptPresent = true;
      try {
        await lstat(requestDirectory);
      } catch (missing) {
        if (isRecord(missing) && missing.code === "ENOENT") attemptPresent = false;
        else throw missing;
      }
      if (attemptPresent)
        throw new Error(
          "original local POST locator missing; reconcile retained capture before any later action",
        );
    }
    const observed = matches.accepted.length
      ? readbackSemanticCheck(api, config.issuer.issuer, matches.accepted[0]!.opportunity, expected)
      : readbackSemanticDispositionCheck(api, config.issuer.issuer, request, expected);
    inventory.assertUnchanged();
    const readbackFile = `readback-${request.request_id}.json`;
    const readback = JSON.stringify(observed);
    try {
      await writeFile(path.join(directory, readbackFile), readback, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (
        !isRecord(error) ||
        error.code !== "EEXIST" ||
        (await readBoundedPublicBuildInputFile(directory, readbackFile, 128 * 1024)).toString(
          "utf8",
        ) !== readback
      )
        throw error;
    }
    return {
      decision: "existing-check-reconciled",
      directory,
      request_id: request.request_id,
      authority: "none",
    };
  }
  inventory.assertUnchanged();
  // An original POST locator selects GET-only reconciliation even when the
  // provider has not yet exposed a matching Check. Never infer no remote effect.
  if (existingLocators.length) throw new Error("original Check POST requires readback; no repeat");
  try {
    await mkdir(requestDirectory, { mode: 0o700 });
  } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") throw error;
  }
  await requirePrivateOwnerPath(requestDirectory, false);
  const attempt = await claimSemanticTechnicalAttempt(
    requestDirectory,
    config.runtime.tools_sha256.systemctl,
  );
  const invocations: { root: string; invocation_sha256: string }[] = [];
  const record = await open(path.join(attempt, "worker-attempt.jsonl"), "wx", 0o600);
  const retain = async (phase: string, evidence: unknown = null) => {
    await record.write(
      JSON.stringify({
        phase,
        request_id: request.request_id,
        checkpoint: snapshot.checkpoint,
        evidence,
      }) + "\n",
    );
    await record.sync();
  };
  const guard = async () => {
    requireFixedCheckout();
    const currentConfiguration = await readConfiguration();
    if (capacityDigest(currentConfiguration) !== capacityDigest(config))
      throw new Error("semantic worker setup changed");
    const fresh = await readRemoteCoordinatorSnapshot(directory, namespace, {
      transport,
    });
    if (capacityDigest(inspectSemanticWorkerRequest(fresh.input)) !== capacityDigest(selected))
      throw new Error(
        "frozen coordinator request changed during semantic attempt; retain capture without POST",
      );
  };
  try {
    await retain("started-no-runtime-no-post", request);
    const recovered = await recoverRemoteCoordinator(attempt, namespace, {
      transport,
    });
    if (capacityDigest(inspectSemanticWorkerRequest(recovered.input)) !== capacityDigest(selected))
      throw new Error("journal changed during full request recovery");
    await guard();
    let publishedObject = selected.base_commit;
    if (selected.purpose === "application") {
      const app = inspectReleaseReviewRequest(request)!;
      const tag = api.request(
        "GET",
        `${repository}/git/ref/tags/${encodeURIComponent(`v${app.base_version}`)}`,
      ).body;
      if (
        !isRecord(tag) ||
        tag.ref !== `refs/tags/v${app.base_version}` ||
        !isRecord(tag.object) ||
        !/^[a-f0-9]{40}$/u.test(String(tag.object.sha)) ||
        !["commit", "tag"].includes(String(tag.object.type))
      )
        throw new Error("existing publication tag unavailable");
      publishedObject = String(tag.object.sha);
    }
    const acquired = await materializeSemanticSource(
      attempt,
      {
        source_commit: selected.source_commit,
        source_tree: selected.source_tree,
        base_commit: selected.base_commit,
        published_object: publishedObject,
      },
      api,
      { git_sha256: config.source_git_sha256, python_sha256: config.runtime.tools_sha256.python },
    );
    await retain("bounded-source-materialized-no-runtime", acquired);
    const source = acquired.repository;
    await guard();
    const pipelineConfiguration = {
      namespace: config.namespace,
      issuer: config.issuer,
      runtime: {
        ...config.runtime,
        backend: "linux-rootless" as const,
        output_parent: attempt,
        auth_cache: config.auth_cache,
        requireIsolationReady: guard,
        onInvocationPrepared: async (value: { root: string; invocation_sha256: string }) => {
          invocations.push(structuredClone(value));
          await retain("runtime-prepared-no-process-yet", value);
        },
      },
      requireCurrentRequestAndProvisioning: guard,
      retainOriginalCheckRequest: async (value: { root: string; proposed_request: unknown }) => {
        await writeFile(path.join(attempt, "expected-check.json"), JSON.stringify(value), {
          flag: "wx",
          mode: 0o600,
        });
        await retain("original-check-request-retained-no-post", {
          root: value.root,
          request_sha256: capacityDigest(value.proposed_request),
        });
      },
    };
    let outcome: unknown;
    if (selected.purpose === "catalog") {
      const catalog = inspectCatalogReviewRequest(request)!;
      const retainedSource = readCatalogPublicationSourceBytes(
        api,
        selected.source_commit,
        performance.now() + 120000,
      );
      if (
        retainedSource.source.tree !== selected.source_tree ||
        retainedSource.bundle_sha256 !== catalog.opportunity.bundle_sha256 ||
        !retainedSource.request ||
        capacityDigest(retainedSource.request.compatibility) !==
          capacityDigest(catalog.opportunity.compatibility)
      )
        throw new Error("catalog frozen source/request differs");
      let prior: Map<string, Buffer> | null = null;
      let priorReceipt: object | null = null;
      const baseline = catalog.opportunity.baseline;
      if (baseline.catalog_repository_sha256 !== null) {
        if (baseline.site_generation_sha256 === null)
          throw new Error("catalog prior generation absent");
        const site = await materializePublishedCatalogCompleteSite(
          {
            repository_sha256: baseline.catalog_repository_sha256,
            root_sha256: baseline.catalog_root_sha256,
            site_generation_sha256: baseline.site_generation_sha256,
          },
          attempt,
          performance.now() + 120000,
        );
        priorReceipt = site.receipt;
        prior = await readBoundedReleaseContextFiles(site.catalog);
        await requirePublishedCatalogCompleteSite(priorReceipt);
      }
      await retain("catalog-frozen-inputs-no-runtime", {
        source: retainedSource.source,
        bundle_sha256: retainedSource.bundle_sha256,
        core_inspection_sha256: catalog.opportunity.core_inspection_sha256,
        prior_repository_sha256: baseline.catalog_repository_sha256,
      });
      await guard();
      // Immutable raw files are frozen by the builder before the runtime or issuer runs.
      outcome = await reviewFrozenCatalogCoordinatorRequest(
        api,
        source,
        catalog,
        { files: retainedSource.files, prior_repository: prior },
        pipelineConfiguration,
      );
      if (priorReceipt) await requirePublishedCatalogCompleteSite(priorReceipt);
    } else
      outcome = await reviewFrozenCoordinatorRequest(api, source, request, pipelineConfiguration);
    await retain("provider-result-verified", outcome);
    return { decision: "review-result-published", directory: attempt, outcome, authority: "none" };
  } catch (error) {
    await retain("stopped-retain-state-no-retry", {
      category: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message.slice(0, 4096) : "unknown",
    });
    const stop = await open(path.join(attempt, "technical-stop.json"), "wx", 0o600);
    try {
      await stop.writeFile(
        JSON.stringify({ schema_version: 1, outcome: "technical-failure", invocations }),
      );
      await stop.sync();
    } finally {
      await stop.close();
    }
    throw error;
  } finally {
    await record.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4)
    throw new Error("fixed semantic worker requires setup path and digest");
  runSemanticWorkerOnce(process.argv[2]!, process.argv[3]!).then(
    (result) => console.log(JSON.stringify(result)),
    () => {
      console.error(
        "semantic worker stopped; retain attempt and use GET-only reconciliation before any later attempt",
      );
      process.exitCode = 1;
    },
  );
}
