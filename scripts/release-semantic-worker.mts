import { execFileSync, spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { inspectLinuxQualificationConfiguration } from "./qualify-semantic-linux.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-remote.mts";
import {
  recoverRemoteCoordinator,
  readRemoteCoordinatorSnapshot,
} from "./release-coordinator-recovery.mts";
import { hydrateReleasePreparationSource } from "./release-preparation-source.mts";
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

/** Setup configuration only, never a supplied report, outcome or grant. The
 * fixed user unit independently pins its bytes after the consolidated setup. */
export function inspectSemanticWorkerConfiguration(raw: unknown) {
  const value: unknown = structuredClone(raw);
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "auth_cache,issuer,kind,namespace,output_parent,runtime,schema_version,setup_grant_sha256,source_read_token,source_repository,worker_revision" ||
    value.schema_version !== 1 ||
    value.kind !== "portcove-fixed-semantic-worker" ||
    !/^[a-f0-9]{40}$/u.test(String(value.worker_revision)) ||
    !/^[a-f0-9]{64}$/u.test(String(value.setup_grant_sha256)) ||
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
function git(root: string, args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return execFileSync(
    "git",
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
      env: { ...env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    },
  ).trim();
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
    return inspectSemanticWorkerConfiguration(JSON.parse(bytes.toString("utf8")));
  };
  const config = await readConfiguration();
  await requirePrivateOwnerPath(config.output_parent, false);
  if (
    git(checkout, ["rev-parse", "HEAD"]) !== config.worker_revision ||
    git(checkout, ["status", "--porcelain", "--untracked-files=no"]) !== ""
  )
    throw new Error("fixed semantic worker checkout differs from reviewed setup");
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
  const request = inspectReleaseReviewRequest(snapshot.input.review_request);
  if (!request)
    return {
      decision: "no-review-request",
      checkpoint: snapshot.checkpoint,
      directory,
      authority: "none",
    };
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
  const attempt = path.join(config.output_parent, `request-${request.request_id}`);
  const inventory = readIndependentSemanticCheckInventory(api, producer, request.source_commit);
  const matches = inspectSemanticRequestCheckMatches(inventory.records, request);
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
      head: request.source_commit,
      external_id: row.external_id,
      summary: row.output.summary,
    };
    try {
      const retained: unknown = JSON.parse(
        (
          await readBoundedPublicBuildInputFile(attempt, "expected-check.json", 128 * 1024)
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
        await lstat(attempt);
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
  // Technical duplicate-execution exclusion only; the existing remote journal
  // remains the request/recovery authority. A previous directory means HOLD,
  // including a lost POST response or a startup failure. Never replay a report.
  await mkdir(attempt, { mode: 0o700 });
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
    const currentConfiguration = await readConfiguration();
    if (capacityDigest(currentConfiguration) !== capacityDigest(config))
      throw new Error("semantic worker setup changed");
    const fresh = await readRemoteCoordinatorSnapshot(directory, namespace, {
      transport,
    });
    if (
      capacityDigest(inspectReleaseReviewRequest(fresh.input.review_request)) !==
      capacityDigest(request)
    )
      throw new Error(
        "frozen coordinator request changed during semantic attempt; retain capture without POST",
      );
  };
  try {
    await retain("started-no-runtime-no-post", request);
    const recovered = await recoverRemoteCoordinator(attempt, namespace, {
      transport,
    });
    if (capacityDigest(recovered.input.review_request) !== capacityDigest(request))
      throw new Error("journal changed during full request recovery");
    await guard();
    const source = path.join(attempt, "source.git");
    git(attempt, ["init", "--bare", "--quiet", source]);
    const objects = await realpath(
      git(config.source_repository, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "objects",
      ]),
    );
    if (/[\r\n\0]/u.test(objects)) throw new Error("source object path invalid");
    await writeFile(path.join(source, "objects/info/alternates"), `${objects}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    const tag = api.request(
      "GET",
      `${repository}/git/ref/tags/${encodeURIComponent(`v${request.base_version}`)}`,
    ).body;
    if (
      !isRecord(tag) ||
      tag.ref !== `refs/tags/v${request.base_version}` ||
      !isRecord(tag.object) ||
      !/^[a-f0-9]{40}$/u.test(String(tag.object.sha))
    )
      throw new Error("existing publication tag unavailable");
    if (tag.object.type === "commit") {
      const commit = api.request("GET", `${repository}/git/commits/${String(tag.object.sha)}`).body;
      if (!isRecord(commit) || !isRecord(commit.tree) || typeof commit.tree.sha !== "string")
        throw new Error("published preparation tree unavailable");
      await retain(
        "prepared-source-materialization",
        hydrateReleasePreparationSource(
          source,
          { source_commit: String(tag.object.sha), source_tree: commit.tree.sha },
          api,
        ),
      );
    } else if (tag.object.type !== "tag") throw new Error("unsupported publication object");
    // Missing ordinary source objects or legacy annotated tags are explicit
    // source-acquisition failures. No unbounded fetch or candidate checkout.
    git(source, ["cat-file", "-e", `${request.source_commit}^{commit}`]);
    await guard();
    const outcome = await reviewFrozenCoordinatorRequest(api, source, request, {
      namespace: config.namespace,
      issuer: config.issuer,
      runtime: {
        ...config.runtime,
        backend: "linux-rootless",
        auth_cache: config.auth_cache,
        requireIsolationReady: guard,
      },
      requireCurrentRequestAndProvisioning: guard,
      retainOriginalCheckRequest: async (value) => {
        await writeFile(path.join(attempt, "expected-check.json"), JSON.stringify(value), {
          flag: "wx",
          mode: 0o600,
        });
        await retain("original-check-request-retained-no-post", {
          root: value.root,
          request_sha256: capacityDigest(value.proposed_request),
        });
      },
    });
    await retain("provider-result-verified", outcome);
    return { decision: "review-result-published", directory: attempt, outcome, authority: "none" };
  } catch (error) {
    await retain("stopped-retain-state-no-retry", {
      category: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message.slice(0, 4096) : "unknown",
    });
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
