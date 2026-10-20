import {
  assessBoundedCapacity,
  capacityDigest,
  slice4CapacityResourceDigest,
} from "./release-capacity.mts";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import {
  recoverRemoteCoordinator,
  inspectRemoteCommitObject,
} from "./release-coordinator-recovery.mts";
import { inspectPreparationCommitBytes } from "./release-coordinator-state.mts";
import { collectReleaseRunEvidence } from "./release-run-evidence.mts";
import {
  requiredCheckContexts,
  requiredContextsFromConfigs,
  PullRequestDeliveryClient,
} from "./pr-delivery.mts";
import {
  loadPackagePolicy,
  releaseLabels,
  releaseBuildArtifactName,
  inspectReleaseProfile,
  selectReleasePackagePolicy,
} from "./release-package-policy.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { discoverReleaseArtifactFiles } from "./release-artifact-archive.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import {
  inspectPublicBuildConfiguration,
  selectPublicBuildInputBinding,
  verifyReleasePublicBuildInputs,
  requireStablePublicBuildInputEvidence,
} from "./release-public-build-provenance.mts";
import { planReleaseOpportunity } from "./release-coordinator.mts";
import {
  classifyApplicationVersion,
  parseVersionClassification,
} from "../apps/desktop/scripts/release-version-policy.mts";
import { collectReleaseSourceChanges, netTreeDeltaScope } from "./release-source-changes.mts";
import { isRecord } from "./runtime-values.mts";
import { isDeepStrictEqual } from "node:util";
import { retainAggregateStepReceipt } from "./production-aggregate-steps.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";

const project = fileURLToPath(new URL("..", import.meta.url));
const repository = "boburning/portcove";
const base = `repos/${repository}`;
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const refsQuery = `query AdmissionRefs($cursor:String) {
 repository(owner:"boburning",name:"portcove") { id databaseId nameWithOwner
  refs(refPrefix:"refs/tags/",first:100,after:$cursor,orderBy:{field:ALPHABETICAL,direction:ASC}) {
   totalCount pageInfo { hasNextPage endCursor }
   nodes { id name prefix target { __typename oid ... on Tag { target { __typename oid ... on Tag { target { __typename oid ... on Tag { target { __typename oid } } } } } } } }
  }
 }
}`;
type Api = Pick<GitHubApiClient, "request" | "graphql">;
type Recover = (...args: Parameters<typeof recoverRemoteCoordinator>) => Promise<unknown>;

function oid(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value))
    throw new Error("admission requires exact Git object identity");
}
function integer(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("admission requires positive numeric identity");
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("admission provider record is incomplete");
  return value;
}
function configuration(raw: unknown) {
  const value = record(raw);
  if (
    !(
      (value.schema_version === 1 &&
        Object.keys(value).sort().join(",") === "namespace,schema_version") ||
      (value.schema_version === 2 &&
        Object.keys(value).sort().join(",") === "namespace,release_profile,schema_version") ||
      (value.schema_version === 3 &&
        value.release_profile === "initial-beta-win-linux" &&
        Object.keys(value).sort().join(",") ===
          "namespace,public_build_inputs,release_profile,schema_version")
    ) ||
    typeof value.namespace !== "string" ||
    !/^portcove-[a-z0-9]+(?:-[a-z0-9]+){0,5}$/u.test(value.namespace) ||
    value.namespace.length > 64
  )
    throw new Error("admission needs separately ratified coordinator configuration");
  return {
    schema_version: value.schema_version,
    namespace: value.namespace,
    public_build_inputs:
      value.schema_version === 3
        ? inspectPublicBuildConfiguration(value.public_build_inputs)
        : null,
    release_profile:
      value.schema_version === 2 || value.schema_version === 3
        ? inspectReleaseProfile(value.release_profile)
        : ("full" as const),
  };
}
function peel(ref: Record<string, unknown>) {
  let target = record(ref.target);
  for (let depth = 0; depth < 4; depth++) {
    oid(target.oid);
    if (target.__typename === "Commit") return target.oid;
    if (target.__typename !== "Tag") break;
    target = record(target.target);
  }
  throw new Error("published tag does not resolve to one bounded commit");
}

/** Executable remote-read-only gate. Acquires facts; never allocates, writes a
 * ref, executes candidate code or equates provider identity with acceptance.
 * Unconfigured independent control/producer authorities remain explicit holds.
 */
export async function acquireReleaseAdmission(
  privateRoot: string,
  rawConfiguration: unknown,
  options: {
    api?: Api;
    recover?: Recover;
    download?: typeof readGitHubArtifactArchive;
    now?: () => number;
    capacity?: { ratification: unknown; readBoundary: () => Promise<unknown> };
  } = {},
) {
  const capacitySource = options.capacity
    ? {
        ratification: structuredClone(options.capacity.ratification),
        readBoundary: options.capacity.readBoundary,
      }
    : undefined;
  const config = configuration(structuredClone(rawConfiguration));
  const started = performance.now();
  const root = await mkdtemp(path.join(path.resolve(privateRoot), "release-admission-"));
  let phase = "initialize";
  let checkpoint: string | null = null;
  let requests = 0;
  try {
    const rawApi =
      options.api ??
      new GitHubApiClient((args, input) =>
        createGitHubRunner({ cwd: root, maxBuffer: 2 * 1024 * 1024, timeoutMs: 15000 })(
          [...args, "--hostname", "github.com"],
          input,
        ),
      );
    let apiMilliseconds = 0;
    const budget = () => {
      if (
        ++requests > 160 ||
        apiMilliseconds > 120000 ||
        performance.now() - started > 15 * 60 * 1000
      )
        throw new Error("admission API acquisition bound exhausted");
    };
    const api: Api = {
      request(method, endpoint, body) {
        const url = new URL(
          endpoint.startsWith("https:") ? endpoint : `https://api.github.com/${endpoint}`,
        );
        const route = url.pathname.slice(`/repos/${repository}`.length);
        const comparison = /^\/compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}$/u.test(route);
        const tree = /^\/git\/trees\/[a-f0-9]{40}$/u.test(route);
        const collection =
          comparison ||
          /^(?:\/releases|\/actions\/runs\/[1-9][0-9]*\/(?:artifacts|attempts\/[1-9][0-9]*\/jobs)|\/commits\/[a-f0-9]{40}\/(?:check-runs|status))$/u.test(
            route,
          );
        const contents = route === "/contents/.github/workflows/release.yml";
        const single =
          route === "" ||
          /^\/(?:git\/commits\/[a-f0-9]{40}|actions\/runs\/[1-9][0-9]*(?:\/attempts\/[1-9][0-9]*)?)$/u.test(
            route,
          );
        const keys = [...url.searchParams.keys()];
        if (
          method !== "GET" ||
          body != null ||
          url.origin !== "https://api.github.com" ||
          url.username ||
          url.password ||
          url.hash ||
          (url.pathname !== `/repos/${repository}` &&
            !url.pathname.startsWith(`/repos/${repository}/`)) ||
          (!collection && !contents && !single && !tree) ||
          new Set(keys).size !== keys.length ||
          keys.some(
            (key) =>
              !(
                collection
                  ? ["per_page", "page", ...(route.endsWith("/check-runs") ? ["filter"] : [])]
                  : tree
                    ? ["recursive"]
                    : contents
                      ? ["ref"]
                      : []
              ).includes(key),
          ) ||
          (collection &&
            (url.searchParams.get("per_page") !== "100" ||
              (url.searchParams.has("page") &&
                !/^(?:[1-9]|1[0-6])$/u.test(url.searchParams.get("page") ?? "")))) ||
          (route.endsWith("/check-runs") && url.searchParams.get("filter") !== "latest") ||
          (tree && url.searchParams.get("recursive") !== "1") ||
          (contents && !/^[a-f0-9]{40}$/u.test(url.searchParams.get("ref") ?? ""))
        )
          throw new Error("admission traversal escaped its remote-read-only repository");
        budget();
        const requestStarted = performance.now();
        const response = rawApi.request("GET", endpoint);
        apiMilliseconds += performance.now() - requestStarted;
        if (
          response.status !== 200 ||
          apiMilliseconds > 120000 ||
          performance.now() - started > 15 * 60 * 1000
        )
          throw new Error("admission API source unavailable or late");
        return response;
      },
      graphql(query, variables) {
        if (query !== refsQuery)
          throw new Error("admission permits only the fixed read-only ref query");
        budget();
        const requestStarted = performance.now();
        const response = rawApi.graphql(query, variables);
        apiMilliseconds += performance.now() - requestStarted;
        if (apiMilliseconds > 120000 || performance.now() - started > 15 * 60 * 1000)
          throw new Error("admission ref acquisition was late");
        return response;
      },
    };
    const get = (endpoint: string) =>
      api.request("GET", endpoint ? `${base}/${endpoint}` : base).body;
    const page = (endpoint: string, key?: string) => {
      let count = 0;
      return GitHubApiClient.prototype.paginateRest
        .call({ request: api.request }, `${base}/${endpoint}`, {
          select: (body: unknown) => {
            const rows = key ? record(body)[key] : body;
            if (!Array.isArray(rows) || rows.length > 100 || (count += rows.length) > 1600)
              throw new Error("admission collection exceeds record bound");
            return rows as unknown[];
          },
          identity: (item: unknown) => {
            const id = record(item).id;
            integer(id);
            return id;
          },
          ...(key
            ? {
                totalCount: (body: unknown) => {
                  const n = record(body).total_count;
                  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > 1600)
                    throw new Error("admission collection exceeds bound");
                  return n;
                },
              }
            : {}),
          label: "release admission inventory",
        })
        .map(record);
    };
    phase = "repository-and-reservation";
    const repo = record(get(""));
    if (repo.id !== 1354613114 || repo.full_name !== repository || typeof repo.node_id !== "string")
      throw new Error("admission repository identity differs");
    const tags = () => {
      const result: Record<string, unknown>[] = [];
      const ids = new Set<string>();
      const names = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | null = null;
      let total: number | null = null;
      for (let index = 0; index < 16; index++) {
        const data = record(api.graphql(refsQuery, { cursor }).data);
        const r = record(data.repository);
        if (r.id !== repo.node_id || r.databaseId !== 1354613114 || r.nameWithOwner !== repository)
          throw new Error("admission ref repository identity differs");
        const connection = record(r.refs);
        const info = record(connection.pageInfo);
        if (
          typeof connection.totalCount !== "number" ||
          !Number.isSafeInteger(connection.totalCount) ||
          connection.totalCount < 0 ||
          connection.totalCount > 1600 ||
          !Array.isArray(connection.nodes) ||
          connection.nodes.length > 100 ||
          typeof info.hasNextPage !== "boolean"
        )
          throw new Error("admission ref connection is incomplete or oversized");
        total ??= connection.totalCount;
        if (total !== connection.totalCount) throw new Error("admission ref count changed");
        for (const raw of connection.nodes) {
          const ref = record(raw);
          if (
            typeof ref.id !== "string" ||
            !ref.id ||
            ref.id.length > 512 ||
            typeof ref.name !== "string" ||
            ref.name.length > 256 ||
            ref.prefix !== "refs/tags/" ||
            ids.has(ref.id) ||
            names.has(ref.name)
          )
            throw new Error("admission refs duplicate identities or names");
          ids.add(ref.id);
          names.add(ref.name);
          result.push(structuredClone(ref));
        }
        if (result.length > total) throw new Error("admission refs exceed total");
        if (!info.hasNextPage) {
          if (result.length !== total) throw new Error("admission refs omit records");
          return result.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        }
        if (
          typeof info.endCursor !== "string" ||
          !info.endCursor ||
          info.endCursor.length > 1024 ||
          cursors.has(info.endCursor) ||
          connection.nodes.length === 0
        )
          throw new Error("admission ref cursor did not advance");
        cursors.add(info.endCursor);
        cursor = info.endCursor;
      }
      throw new Error("admission refs exceed page bound");
    };
    const releases = () =>
      page("releases?per_page=100")
        .map((r) => {
          integer(r.id);
          if (
            typeof r.tag_name !== "string" ||
            r.tag_name.length > 128 ||
            typeof r.draft !== "boolean" ||
            typeof r.prerelease !== "boolean" ||
            (r.published_at !== null && typeof r.published_at !== "string") ||
            typeof r.updated_at !== "string"
          )
            throw new Error("publication record is incomplete");
          return {
            id: r.id,
            tag_name: r.tag_name,
            draft: r.draft,
            prerelease: r.prerelease,
            published_at: r.published_at,
            updated_at: r.updated_at,
          };
        })
        .sort((a, b) => a.id - b.id);
    const recover = () =>
      (options.recover ?? recoverRemoteCoordinator)(
        root,
        { schema_version: 1, namespace: config.namespace },
        { transport: { cwd: root } },
      );
    const before = record(structuredClone(await recover()));
    oid(before.checkpoint);
    checkpoint = before.checkpoint;
    const state = record(before.input);
    const candidate = record(state.active_candidate);
    if (!["building", "publishing"].includes(String(candidate.phase)))
      throw new Error("admission cannot revive an inactive or failed candidate");
    for (const key of ["source_commit", "source_tree", "prepared_commit", "prepared_tree"])
      oid(candidate[key]);
    if (typeof candidate.version !== "string" || !isRecord(candidate.release_run))
      throw new Error("admission requires the existing frozen Release run");
    const version = classifyApplicationVersion(candidate.version).version;
    integer(candidate.release_run.run_id);
    integer(candidate.release_run.attempt);
    if (candidate.release_run.revision !== candidate.prepared_commit)
      throw new Error("admission frozen run differs from prepared source");
    const initialTags = tags();
    const initialReleases = releases();
    const commits = new Map<string, ReturnType<typeof inspectRemoteCommitObject>>();
    const commit = (id: string) => {
      let value = commits.get(id);
      if (!value) {
        value = inspectRemoteCommitObject(get(`git/commits/${id}`), id);
        commits.set(id, value);
      }
      return value;
    };
    const versionPrefix = `${config.namespace}-prepared/`;
    const sourcePrefix = `${config.namespace}-prepared-source/`;
    const versions = initialTags.filter((r) => String(r.name).startsWith(versionPrefix));
    const sources = initialTags.filter((r) => String(r.name).startsWith(sourcePrefix));
    if ([...versions, ...sources].some((ref) => record(ref.target).__typename !== "Commit"))
      throw new Error("preparation receipts must point directly to raw commits");
    if (versions.length !== sources.length)
      throw new Error("reservation namespace has incomplete receipt pairs");
    const allocations = [];
    let activePreparationIntent: string | null = null;
    const seenSources = new Set<string>();
    for (const ref of versions) {
      const tag = String(ref.name).slice(versionPrefix.length);
      if (!tag.startsWith("v")) throw new Error("reservation version prefix differs");
      const allocated = classifyApplicationVersion(tag.slice(1)).version;
      const prepared = peel(ref);
      const object = commit(prepared);
      const matches = sources.filter((r) => peel(r) === prepared);
      if (matches.length !== 1) throw new Error("reservation source pair is missing or ambiguous");
      const source = String(matches[0]!.name).slice(sourcePrefix.length);
      oid(source);
      if (seenSources.has(source)) throw new Error("reservation source allocated more than once");
      seenSources.add(source);
      const original = commit(source);
      const text = Buffer.from(object.object.bytes).toString("utf8");
      const intent = text.match(/\nPortcove-Preparation-SHA256: ([a-f0-9]{64})\n/u)?.[1];
      if (!intent) throw new Error("reservation prepared intent is missing");
      const payload = inspectPreparationCommitBytes(
        Buffer.from(original.object.bytes).toString("utf8"),
        text,
        {
          source_commit: source,
          source_tree: original.tree,
          prepared_commit: prepared,
          prepared_tree: object.tree,
          version: allocated,
          intent_sha256: intent,
        },
      );
      const declared = record(JSON.parse(payload));
      const proposal = record(declared.proposal);
      if (proposal.source_commit !== source || proposal.version !== allocated)
        throw new Error("reservation intent does not match its complete receipt pair");
      if (allocated === version) activePreparationIntent = payload;
      allocations.push({
        version: allocated,
        source_commit: source,
        source_tree: original.tree,
        prepared_commit: prepared,
        prepared_tree: object.tree,
        intent_sha256: intent,
      });
    }
    const active = allocations.find((a) => a.version === version);
    if (
      !active ||
      ["source_commit", "source_tree", "prepared_commit", "prepared_tree", "intent_sha256"].some(
        (key) => active[key as keyof typeof active] !== candidate[key],
      )
    )
      throw new Error("active reservation differs from complete namespace receipts");
    const holds = new Set<string>();
    // Separate live source seam; retained coordinator facts cannot self-attest
    // a current provider boundary. Missing/invalid input holds independently.
    let capacityBefore: unknown = null;
    try {
      capacityBefore = capacitySource ? structuredClone(await capacitySource.readBoundary()) : null;
    } catch {
      /* unknown stays held */
    }

    let sourceChanges: ReturnType<typeof collectReleaseSourceChanges> | null = null;
    phase = "source-consistency";
    if (!Object.hasOwn(candidate, "frozen_opportunity")) {
      holds.add("active-frozen-opportunity-unavailable-no-latest-opportunity-substitution");
    } else {
      const frozen = record(candidate.frozen_opportunity);
      const classification = record(frozen.classification);
      if (
        frozen.source_commit !== active.source_commit ||
        frozen.source_tree !== active.source_tree ||
        classification.source_commit !== active.source_commit ||
        classification.reviewed_commit !== active.source_commit ||
        classification.source_tree !== active.source_tree ||
        classification.reviewed_tree !== active.source_tree
      )
        throw new Error("frozen classification differs from the active original source");
      if (classification.change_set_scope !== netTreeDeltaScope) {
        holds.add("frozen-change-set-scope-unsupported-no-legacy-hash-reinterpretation");
      } else {
        sourceChanges = collectReleaseSourceChanges(api, frozen);
        if (
          sourceChanges.change_set_sha256 !== frozen.change_set_sha256 ||
          sourceChanges.change_set_sha256 !== classification.change_set_sha256
        )
          throw new Error("frozen change-set digest differs from acquired complete source facts");
        const parsed = parseVersionClassification(classification);
        // Associate the already-frozen proposal rather than fabricating its
        // historical publication input or reallocating on a later retry.
        const intent = record(JSON.parse(activePreparationIntent ?? "null"));
        const proposal = record(intent.proposal);
        const classified = classifyApplicationVersion(version);
        if (
          Object.keys(intent).sort().join(",") !== "compatibility,migration_notes,proposal" ||
          Object.keys(proposal).sort().join(",") !==
            "base_version,change,channels,github_prerelease,schema_version,source_commit,version" ||
          proposal.schema_version !== 1 ||
          proposal.source_commit !== active.source_commit ||
          proposal.version !== version ||
          proposal.base_version !== parsed.base_version ||
          proposal.change !== parsed.change ||
          proposal.github_prerelease !== classified.github_prerelease ||
          !isDeepStrictEqual(proposal.channels, classified.channels) ||
          intent.compatibility !== parsed.compatibility ||
          intent.migration_notes !== (parsed.migration_notes ?? "")
        )
          throw new Error("frozen classification differs from the existing preparation intent");
      }
    }
    const publishedVersions: string[] = [];
    const publishedSources: string[] = [];
    for (const release of initialReleases.filter((r) => !r.draft)) {
      if (!release.tag_name.startsWith("v")) {
        holds.add("published-version-identity-unknown");
        continue;
      }
      const published = classifyApplicationVersion(release.tag_name.slice(1)).version;
      if (publishedVersions.includes(published))
        throw new Error("published version has multiple release identities");
      publishedVersions.push(published);
      const ref = initialTags.find((r) => r.name === release.tag_name);
      if (!ref) {
        holds.add("published-tag-identity-unavailable");
        continue;
      }
      const publishedCommit = peel(ref);
      const allocation = allocations.find(
        (a) => a.prepared_commit === publishedCommit && a.version === published,
      );
      if (!allocation) {
        holds.add("historical-original-source-and-routine-preview-classification-unresolved");
        continue;
      }
      publishedSources.push(allocation.source_commit);
      // Preparation intent does not authenticate whether publication was routine
      // or urgent. A mutable Release timestamp/title cannot supply that history.
      holds.add("routine-preview-publication-history-unresolved");
    }
    const reservedVersions = allocations
      .filter((a) => !publishedVersions.includes(a.version))
      .map((a) => a.version)
      .sort();
    if (reservedVersions.length !== 1 || reservedVersions[0] !== version)
      holds.add("complete-reservation-inventory-conflicts-with-active-candidate");
    phase = "qualification";
    const workflow = await readFile(path.join(project, ".github/workflows/release.yml"));
    const evidenceRequest = {
      schema_version: 1,
      repository_id: 1354613114,
      run_id: candidate.release_run.run_id,
      attempt: candidate.release_run.attempt,
      revision: active.prepared_commit,
      tree: active.prepared_tree,
      workflow_sha256: hash(workflow),
    };
    const evidence = collectReleaseRunEvidence(evidenceRequest, { api });
    if (
      evidence.run.conclusion !== "success" ||
      evidence.jobs.some((job) => !["success", "skipped"].includes(job.conclusion ?? ""))
    )
      holds.add("Release-attempt-has-required-failure-or-unknown-jobs");
    const required = requiredContextsFromConfigs(
      JSON.parse(await readFile(path.join(project, ".github/repository-ruleset.json"), "utf8")),
      JSON.parse(await readFile(path.join(project, ".github/qualification-coverage.json"), "utf8")),
    );
    const checkApi = {
      ...api,
      request: (method: string, endpoint: string, body?: unknown) => {
        const response = api.request(method, endpoint, body);
        const url = new URL(
          endpoint.startsWith("https:") ? endpoint : `https://api.github.com/${endpoint}`,
        );
        if (url.pathname.endsWith("/check-runs")) {
          const runs = record(response.body).check_runs;
          if (!Array.isArray(runs)) throw new Error("qualification check inventory missing");
          for (const raw of runs) {
            const run = record(raw);
            if (run.head_sha !== active.prepared_commit)
              throw new Error("qualification check source differs");
            if (required.includes(String(run.name)) && record(run.app).id !== 15368)
              throw new Error("required qualification check issuer differs");
          }
        } else if (
          url.pathname.endsWith("/status") &&
          record(response.body).sha !== active.prepared_commit
        )
          throw new Error("qualification status source differs");
        return response;
      },
    };
    const delivery = new PullRequestDeliveryClient({
      ...checkApi,
      paginateRest: (endpoint, options) =>
        GitHubApiClient.prototype.paginateRest.call(checkApi, endpoint, options),
    });
    const readQualification = () =>
      requiredCheckContexts(
        delivery.checkRuns(active.prepared_commit),
        delivery.commitStatuses(active.prepared_commit),
        required,
      );
    const contexts = readQualification();
    if (contexts.some((context) => context.outcome !== "success" || context.source !== "check-run"))
      holds.add("exact-prepared-head-required-contexts-not-successful");
    const policy = selectReleasePackagePolicy(
      await loadPackagePolicy(project),
      config.release_profile,
    );
    const labels = releaseLabels(policy);
    const archives: { platform: string; artifact_id: number; bytes: number; sha256: string }[] = [];
    for (const platform of labels) {
      const matches = evidence.artifacts.filter(
        (a) =>
          a.name ===
          releaseBuildArtifactName(
            platform,
            String(evidenceRequest.run_id),
            evidenceRequest.attempt,
          ),
      );
      const artifact = matches[0];
      if (
        matches.length !== 1 ||
        !artifact ||
        artifact.expired ||
        !artifact.archive_sha256 ||
        artifact.bytes < 22 ||
        artifact.bytes > 512 * 1024 * 1024
      )
        throw new Error("complete immutable platform archive identity is unavailable");
      archives.push({
        platform,
        artifact_id: artifact.id,
        bytes: artifact.bytes,
        sha256: artifact.archive_sha256,
      });
    }
    if (archives.reduce((sum, a) => sum + a.bytes, 0) > 2 * 1024 * 1024 * 1024)
      throw new Error("admission archive matrix exceeds total bytes");
    phase = "archive-acquisition";
    const files = [];
    const declarations = [];
    for (const archive of archives) {
      if (performance.now() - started > 15 * 60 * 1000)
        throw new Error("admission archive acquisition deadline exhausted");
      const bytes = (options.download ?? readGitHubArtifactArchive)(
        `${base}/actions/artifacts/${archive.artifact_id}/zip`,
        { cwd: root, maxBytes: archive.bytes, timeoutMs: 120000 },
      );
      const discovered = await discoverReleaseArtifactFiles(
        bytes,
        { bytes: archive.bytes, sha256: archive.sha256 },
        archive.platform,
        {
          version,
          run_id: String(evidenceRequest.run_id),
          run_attempt: evidenceRequest.attempt,
          source_commit: active.prepared_commit,
        },
      );
      files.push(...discovered.files);
      declarations.push(discovered.declared_producer);
    }
    phase = "public-build-input-acquisition";
    const publicBinding = config.public_build_inputs
      ? selectPublicBuildInputBinding(config.public_build_inputs, evidence)
      : null;
    const publicBuildInputs = publicBinding
      ? await verifyReleasePublicBuildInputs(root, publicBinding, evidence, {
          download: options.download,
        })
      : null;
    if (config.release_profile === "initial-beta-win-linux" && !publicBinding)
      holds.add("ratified-public-build-inputs-unavailable");
    if (
      publicBinding?.artifacts.some((item) =>
        archives.some((archive) => archive.artifact_id === item.artifact_id),
      )
    )
      throw new Error("public build inputs cannot reuse package artifact identities");
    const assembly = {
      schema_version: publicBinding ? 3 : 2,
      ...(publicBinding ? { public_build_inputs: publicBinding } : {}),
      release_profile: config.release_profile,
      source_commit: active.prepared_commit,
      source_tree: active.prepared_tree,
      version,
      run_id: String(evidenceRequest.run_id),
      run_attempt: evidenceRequest.attempt,
      files,
    };
    await inspectTrustedAssemblyInput(assembly);
    phase = "freshness-bracket";
    const afterEvidence = collectReleaseRunEvidence(evidenceRequest, { api });
    if (publicBinding)
      requireStablePublicBuildInputEvidence(publicBinding, evidence, afterEvidence);
    if (
      !isDeepStrictEqual(evidence.run, afterEvidence.run) ||
      !isDeepStrictEqual(evidence.jobs, afterEvidence.jobs) ||
      !isDeepStrictEqual(evidence.artifacts, afterEvidence.artifacts)
    )
      throw new Error(
        "Release run, jobs or complete artifact inventory changed during acquisition",
      );
    if (!isDeepStrictEqual(contexts, readQualification()))
      throw new Error("required qualification changed during acquisition");
    if (!isDeepStrictEqual(initialTags, tags()) || !isDeepStrictEqual(initialReleases, releases()))
      throw new Error("publication or complete reservation snapshot changed");
    const after = record(await recover());
    if (after.checkpoint !== checkpoint)
      throw new Error("coordinator checkpoint changed during admission");
    // The retained snapshot's classification/pause/capacity fields are supplied
    // facts, not independent live authority. Do not feed them to an executing
    // plan or adopt a package's own checksum as acceptance.

    const capacityInput = {
      schema_version: 1,
      prior_operations:
        state.schema_version === 2 &&
        isRecord(state.controller) &&
        isRecord(state.controller.capacity_attempt)
          ? state.controller.capacity_attempt.prior_operations
          : [],
      ratification: capacitySource?.ratification ?? {
        active: false,
        boundary_sha256: "0".repeat(64),
        resource_policy_sha256: slice4CapacityResourceDigest,
        selection: "slice4-d2-c6470ec28ba9addb0f70d9f86953322d835bb8c0",
      },
      boundary: null as unknown,
      operation:
        isRecord(state.controller) && isRecord(state.controller.capacity_attempt)
          ? state.controller.capacity_attempt.operation
          : null,
    };
    try {
      const boundary = capacitySource ? structuredClone(await capacitySource.readBoundary()) : null;
      if (capacityBefore !== null && capacityDigest(capacityBefore) === capacityDigest(boundary))
        capacityInput.boundary = boundary;
    } catch {
      /* unavailable provider source never supplies eligibility */
    }
    let capacity;
    try {
      capacity = assessBoundedCapacity(capacityInput);
    } catch {
      capacityInput.boundary = null;
      capacityInput.ratification = {
        active: false,
        boundary_sha256: "0".repeat(64),
        resource_policy_sha256: slice4CapacityResourceDigest,
        selection: "slice4-d2-c6470ec28ba9addb0f70d9f86953322d835bb8c0",
      };
      capacity = assessBoundedCapacity(capacityInput);
    }
    if (!capacitySource) holds.add("admitted-spending-boundary-source-unconfigured");
    if (capacity.eligibility !== "eligible") holds.add("bounded-no-spend-attempt-ineligible");
    holds.add("independent-classification-and-pause-sources-unconfigured");
    holds.add("candidate-workflow-execution-and-producer-acceptance-unproven");
    holds.add("strict-release-SBOM-and-native-authorization-not-evaluated");
    const publication = {
      complete: publishedSources.length === publishedVersions.length,
      observed_at: new Date((options.now ?? Date.now)()).toISOString(),
      published_versions: publishedVersions.sort(),
      published_sources: [...new Set(publishedSources)].sort(),
      reserved_versions: reservedVersions,
      last_routine_preview_at: null,
    };
    // Exercise the existing planner's schema/active-state path only behind a
    // conservative hold. This diagnostic plan has no acquired control authority.
    const diagnosticPlan =
      publication.complete && initialReleases.every((r) => r.draft)
        ? planReleaseOpportunity({
            ...state,
            schema_version: 2,
            now: publication.observed_at,
            publication,
            controller: {
              workflow: record(state.controller).workflow,
              revision: record(state.controller).revision,
              publication_paused: true,
              capacity_attempt: capacityInput,
            },
          })
        : null;
    return {
      schema_version: 1,
      decision: "hold",
      descriptor: null,
      directory: root,
      checkpoint,
      holds: [...holds].sort(),
      capacity,
      publication,
      allocations,
      contexts,
      source_changes: sourceChanges,
      evidence,
      assembly,
      archives,
      public_build_inputs: publicBuildInputs,
      declared_producers: declarations,
      diagnostic_plan: diagnosticPlan,
      diagnostic_plan_scope: "conservative paused schema check only; no acquired control authority",
      api_requests: requests,
      evidence_scope:
        options.api || options.recover || options.download || options.now || options.capacity
          ? "injected-provider"
          : "github.com",
      authority: "none",
    };
  } catch {
    const evidence = {
      schema_version: 1,
      decision: "refused",
      directory: root,
      checkpoint,
      phase,
      api_requests: requests,
      authority: "none",
    };
    // Only our own bounded fields cross this boundary. Provider errors can
    // contain bearer material, arbitrary candidate text or transport commands.
    try {
      await writeFile(path.join(root, "admission-failure.json"), JSON.stringify(evidence), {
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      // A storage failure must still return the owned location to the caller;
      // the CLI can retain that bounded evidence in its outer result receipt.
    }
    throw new CoordinatorRemoteError(`release admission refused during ${phase}`, evidence);
  }
}

async function main() {
  if (process.argv.length !== 2)
    throw new Error("admission accepts no candidate path or dispatch arguments");
  const raw = process.env.PORTCOVE_COORDINATOR_CONFIGURATION;
  if (!raw || Buffer.byteLength(raw) > 4096)
    throw new Error("ratified coordinator configuration unavailable");
  const root = process.env.RUNNER_TEMP;
  if (!root || !path.isAbsolute(root)) throw new Error("private runner root unavailable");
  await retainAggregateStepReceipt(
    path.join(root, "release-admission-control-receipt.jsonl"),
    {
      operation: "independent-admission",
      checkpoint: "unresolved",
      descriptor_sha256: hash(raw),
    },
    async (stage) => {
      stage("acquire-publication-reservation-and-qualification");
      let result;
      try {
        result = await acquireReleaseAdmission(root, JSON.parse(raw));
      } catch (error) {
        if (error instanceof CoordinatorRemoteError)
          await writeFile(
            path.join(root, "release-admission-result.json"),
            JSON.stringify(error.evidence),
            {
              flag: "wx",
              mode: 0o600,
            },
          );
        throw error;
      }
      const bytes = JSON.stringify(result);
      if (Buffer.byteLength(bytes) > 2 * 1024 * 1024)
        throw new Error("admission diagnostic evidence exceeds bound");
      await writeFile(path.join(root, "release-admission-result.json"), bytes, {
        flag: "wx",
        mode: 0o600,
      });
      console.log(
        JSON.stringify({
          decision: result.decision,
          checkpoint: result.checkpoint,
          holds: result.holds,
          authority: result.authority,
        }),
      );
    },
  );
  process.exitCode = 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error(
      "independent release admission refused; retain owned acquisition evidence; no descriptor or mutation emitted",
    );
    process.exitCode = 2;
  });
