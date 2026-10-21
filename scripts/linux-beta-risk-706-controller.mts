/** Fixed-controller risk gate. No public function accepts an approval object,
 * provider callback or scanner JSON in place of actual private admission. */
import { createHash } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import {
  coordinatorCommandTimeout,
  checkCoordinatorDeadline,
} from "./release-coordinator-deadline.mts";
import { nativePaths706, inspectCompilerRiskAssessment706 } from "./linux-beta-risk-706.mts";
import {
  assessInitialProofBudget706,
  inspectInitialProofRisk706Comment,
  inspectRisk706MeasurementPins,
} from "./linux-beta-risk-706-profile.mts";
import { inspectCapacityOperation, inspectCompactCapacityOperations } from "./release-capacity.mts";
import type { ParsedCapacityOperation } from "./release-capacity.mts";
import type { GitHubRestReader } from "./github-api.mts";
const base = "repos/boburning/portcove";
const hash = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");
const linux = (filename: string) => /(?:\.AppImage$|amd64\.deb$|x86_64\.rpm$)/iu.test(filename);
const priorSites = new WeakMap<
  object,
  {
    seed: string;
    site: object;
    preparation: import("./release-metadata-renewal.mts").PreparedMetadataRenewal;
  }
>();

/** Fixed tree traversal, with response bounds applied by the actual transport
 * before parsing. No compare API truncation or candidate execution. */
export function readRisk706NativeInputs(reader: GitHubRestReader, sourceTree: string) {
  if (!/^[a-f0-9]{40}$/u.test(sourceTree)) throw new Error("exact original source tree required");
  const cache = new Map<string, Record<string, unknown>[]>();
  const tree = (sha: string) => {
    const previous = cache.get(sha);
    if (previous) return previous;
    if (cache.size >= 12) throw new Error("risk source tree traversal exhausted");
    const response = reader.request("GET", `${base}/git/trees/${sha}`);
    const raw = response.body;
    if (
      response.status !== 200 ||
      !isRecord(raw) ||
      raw.sha !== sha ||
      raw.truncated !== false ||
      !Array.isArray(raw.tree) ||
      raw.tree.length > 10000
    )
      throw new Error("risk native source tree incomplete");
    const names = new Set<string>();
    const rows = raw.tree.map((entry: unknown) => {
      if (
        !isRecord(entry) ||
        typeof entry.path !== "string" ||
        !entry.path ||
        /[\0/\r\n]/u.test(entry.path) ||
        names.has(entry.path) ||
        typeof entry.sha !== "string" ||
        !/^[a-f0-9]{40}$/u.test(entry.sha) ||
        !["100644", "100755", "040000", "120000", "160000"].includes(String(entry.mode))
      )
        throw new Error("risk native tree identity malformed");
      names.add(entry.path);
      return entry;
    });
    cache.set(sha, rows);
    return rows;
  };
  const lines = nativePaths706
    .map((filename) => {
      const parts = filename.split("/");
      let current = sourceTree;
      for (let index = 0; index < parts.length; index++) {
        const entry = tree(current).find((item) => item.path === parts[index]);
        if (!entry) return null;
        if (index !== parts.length - 1) {
          if (entry.mode !== "040000" || entry.type !== "tree")
            throw new Error("risk native parent is not a tree");
          current = String(entry.sha);
        } else {
          if (
            !["100644", "100755", "040000"].includes(String(entry.mode)) ||
            entry.type !== (entry.mode === "040000" ? "tree" : "blob")
          )
            throw new Error("risk native input cannot be linked or submodule");
          return `${String(entry.mode)} ${String(entry.type)} ${String(entry.sha)}\t${filename}`;
        }
      }
      throw new Error("empty native input path");
    })
    .filter((line): line is string => line !== null)
    .sort((a, b) => (a.split("\t")[1]! < b.split("\t")[1]! ? -1 : 1));
  return hash(lines.join("\n") + "\n");
}

/** A settled publish or partial confirmed effect consumes budget forever,
 * including after withdrawal/deletion and before feed completion. */
export function durableExposure706(operation: ParsedCapacityOperation) {
  const expectation = operation.release_expectation;
  if (!expectation || expectation.effect.kind !== "publish-draft") return null;
  if (!["succeeded", "recovered"].includes(operation.outcome))
    throw new Error("ambiguous/pending publication requires existing readback recovery");
  if (!expectation.identity.assets.some((asset) => linux(asset.filename))) return null;
  if (!operation.completed_effects.length) {
    if (operation.recovery?.resolution !== "effect-not-applied")
      throw new Error("publication has no conclusive zero-effect recovery");
    return null;
  }
  const releaseId = expectation.prior.release_id;
  if (
    releaseId === null ||
    operation.completed_effects.length !== 1 ||
    !operation.completed_effects[0]!.remote_identity.startsWith(
      `github-release:boburning/portcove:release:${releaseId}:immutable:`,
    )
  )
    throw new Error("public exposure lacks original immutable provider identity");
  return { tag: `v${expectation.identity.version}`, release_id: releaseId };
}

export async function authorizeActualLinuxRisk706(
  rawContext: object,
  rawControls?: object,
  checkpoint?: string,
  phaseDeadline?: number,
) {
  checkCoordinatorDeadline();
  if (
    phaseDeadline !== undefined &&
    (!Number.isFinite(phaseDeadline) || performance.now() >= phaseDeadline)
  )
    throw new Error("risk gate original deadline exhausted");
  const admissionModule = await import("./acquire-release-admission.mts");
  const publication = (() => {
    try {
      return admissionModule.requireActualPublicationControllerContext(rawContext).context;
    } catch {
      return null;
    }
  })();
  const context =
    publication ??
    admissionModule.requireActualReleaseAdmissionContext(rawContext, "payload-signing");
  const compiler = await admissionModule.requireActualAdmissionCompilerReceipt706(rawContext);
  const { requireVerifiedLinuxRiskAssessment706 } = await import("./release-compiler-evidence.mts");
  const measured = await requireVerifiedLinuxRiskAssessment706(compiler);
  return authorizeRiskSubject706(
    rawContext,
    { ...context, private_parent: path.dirname(context.coordinator_repository) },
    measured,
    () => requireVerifiedLinuxRiskAssessment706(compiler),
    rawControls,
    checkpoint,
    phaseDeadline,
  );
}

type OriginalRiskContext = ReturnType<
  typeof import("./acquire-release-admission.mts").requireActualReleaseAdmissionContext
>;
type RiskContext = Pick<OriginalRiskContext, "controls"> & {
  stage: "payload-signing" | "release-publication" | "site-publication";
  facts: { opportunity: unknown };
  admission: Partial<Pick<OriginalRiskContext["admission"], "controls">>;
  private_parent: string;
  site_tuf?: object;
};
type RiskMeasurement = Awaited<
  ReturnType<typeof import("./release-compiler-evidence.mts").requireVerifiedLinuxRiskAssessment706>
>;

/** New-candidate feed only. Historical scanner data is authenticated by the
 * existing context/result receivers; it never becomes an original compiler
 * WeakMap receipt. Current tool/source/control/amendment checks run again. */
export async function authorizeActualSiteLinuxRisk706(
  tufReceipt: object,
  resultReceipt: object,
  controls: import("./release-live-control-admission.mts").AuthenticatedReleaseControlSource,
  checkpoint: string,
  deadline: number,
) {
  const { requireRetainedActualTufPublication } = await import("./release-tuf-publication.mts");
  const { requireReceivedPublicationResult } =
    await import("./release-publication-result-artifact.mts");
  const tuf = await requireRetainedActualTufPublication(tufReceipt, deadline);
  const result = await requireReceivedPublicationResult(resultReceipt, deadline);
  const manifest = tuf.context.manifest,
    facts = manifest.facts;
  if (
    tuf.context_receipt !== result.context_receipt ||
    manifest.kind !== "release-signing-context" ||
    !isRecord(facts) ||
    !isRecord(facts.compiler_evidence)
  )
    throw new Error("actual new-release context/result risk custody required");
  const { inspectTrustedAssemblyInput } = await import("./trusted-release-assembly.mts");
  const { accepted } = await inspectTrustedAssemblyInput(facts.assembly);
  const compiler = facts.compiler_evidence;
  if (
    compiler.evidence_scope !== "github.com" ||
    compiler.source_commit !== accepted.source_commit ||
    compiler.source_tree !== accepted.source_tree ||
    compiler.run_id !== accepted.run_id ||
    compiler.run_attempt !== accepted.run_attempt ||
    !Array.isArray(compiler.observations)
  )
    throw new Error("historical compiler subject differs from actual signed source/run");
  const matches = compiler.observations.filter(
    (item: unknown) => isRecord(item) && item.platform === "linux-x86_64",
  );
  const observed: unknown = matches[0];
  if (
    matches.length !== 1 ||
    !isRecord(observed) ||
    !isRecord(observed.desktop) ||
    typeof observed.desktop.started !== "number" ||
    typeof observed.desktop.finished !== "number" ||
    !isRecord(observed.desktop.linux_risk_assessment) ||
    !isRecord(observed.desktop.linux_risk_assessment.candidate)
  )
    throw new Error("authenticated historical scanner subject missing or ambiguous");
  const raw = inspectCompilerRiskAssessment706(observed.desktop.linux_risk_assessment, {
    source_commit: accepted.source_commit,
    started: observed.desktop.started,
    finished: observed.desktop.finished,
    lock_sha256: String(observed.desktop.linux_risk_assessment.candidate.lockSha256),
  });
  if (!isRecord(raw.candidate) || !isRecord(raw.candidate.versionPreparation))
    throw new Error("historical risk subject lacks exact four-file preparation");
  const prepared = raw.candidate.versionPreparation;
  const preparation = {
    source_commit: String(prepared.source_commit),
    source_tree: String(prepared.source_tree),
    prepared_commit: accepted.source_commit,
    prepared_tree: accepted.source_tree,
    version: accepted.version,
  };
  const { compareVerifiedReleaseCompilerSource, requireVerifiedReleaseCompilerSource } =
    await import("./release-compiler-source-admission.mts");
  const readToken = process.env.PORTCOVE_RELEASE_READ_TOKEN;
  if (!readToken)
    throw new Error("fixed read-only workflow token required for site compiler source");
  const sourceProof = await compareVerifiedReleaseCompilerSource(
    tuf.tools_receipt,
    preparation,
    {
      source_commit: tuf.tools.identity.controller_revision,
      source_tree: tuf.tools.identity.source_tree,
    },
    readToken,
  );
  const source = await requireVerifiedReleaseCompilerSource(sourceProof, accepted.source_tree);
  const context: RiskContext = {
    stage: "site-publication",
    controls,
    facts: { opportunity: facts.opportunity },
    admission: {},
    private_parent: path.dirname(tuf.repository),
    site_tuf: tufReceipt,
  };
  return authorizeRiskSubject706(
    tufReceipt,
    context,
    { ...raw, source },
    async () => {
      await requireRetainedActualTufPublication(tufReceipt, deadline);
      await requireReceivedPublicationResult(resultReceipt, deadline);
      await requireVerifiedReleaseCompilerSource(sourceProof, accepted.source_tree);
    },
    controls,
    checkpoint,
    deadline,
  );
}

async function authorizeRiskSubject706(
  cacheKey: object,
  context: RiskContext,
  measured: RiskMeasurement,
  recheck: () => Promise<unknown>,
  rawControls?: object,
  checkpoint?: string,
  phaseDeadline?: number,
) {
  const stage = context.stage === "payload-signing" ? "payload" : context.stage;
  const { requireAuthenticatedReleaseControlSource } =
    await import("./release-live-control-admission.mts");
  // A supplied later-round source must itself have the existing private brand.
  requireAuthenticatedReleaseControlSource(rawControls ?? context.controls, stage);
  const controls = (rawControls ?? context.controls) as typeof context.controls;
  const { requireControllerReleaseAuthorities } =
    await import("./release-authority-configuration.mts");
  const authorities = await requireControllerReleaseAuthorities(stage);
  const { verifiedControllerToolPaths } = await import("./release-controller-tool-admission.mts");
  const tools = await verifiedControllerToolPaths(measured.source.tools);
  const directory = context.private_parent;
  const readToken = process.env.PORTCOVE_RELEASE_READ_TOKEN;
  if (!readToken || readToken.length > 16384 || /\s/u.test(readToken))
    throw new Error(
      "fixed read-only workflow token required; publisher credential cannot substitute",
    );
  const readHome = await mkdtemp(path.join(directory, "risk-readonly-"));
  const readEnvironment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TMP",
    "TEMP",
  ])
    if (process.env[key] !== undefined) readEnvironment[key] = process.env[key];
  Object.assign(readEnvironment, {
    GH_TOKEN: readToken,
    GH_HOST: "github.com",
    GH_CONFIG_DIR: readHome,
    HOME: readHome,
    USERPROFILE: readHome,
    XDG_CONFIG_HOME: readHome,
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
  let requests = 0;
  const readSpawn: NonNullable<Parameters<typeof createGitHubRunner>[0]>["spawn"] = (
    command,
    args,
    options,
  ) => {
    if (++requests > 160) throw new Error("risk gate bounded provider inventory exhausted");
    checkCoordinatorDeadline();
    const left =
      phaseDeadline === undefined ? 15000 : Math.floor(phaseDeadline - performance.now());
    if (left < 1) throw new Error("risk provider cannot start after original deadline");
    const result = spawnSync(command, args, {
      ...options,
      env: readEnvironment,
      timeout: Math.min(coordinatorCommandTimeout(15000), left),
    });
    checkCoordinatorDeadline();
    if (phaseDeadline !== undefined && performance.now() >= phaseDeadline)
      throw new Error("risk provider original deadline exhausted");
    return result;
  };
  const api = new GitHubApiClient((args, input) =>
    createGitHubRunner({
      cwd: directory,
      spawn: readSpawn,
      maxBuffer: 2 * 1024 * 1024,
      timeoutMs: 15000,
    })([...args, "--hostname", "github.com"], input),
  );
  const current = controls.read(api, context.facts.opportunity);
  const original = context.stage === "site-publication" ? current : context.admission.controls;
  if (
    !original ||
    current.pause.publication_paused ||
    !current.resource_policy_matches_controller ||
    current.reader.controller_revision !== tools.identity.controller_revision ||
    current.reader.controller_ref !== tools.identity.controller_ref ||
    String(current.reader.run_id) !== tools.identity.run_id ||
    current.reader.run_attempt !== tools.identity.run_attempt ||
    current.reader.job_id !== original.reader.job_id ||
    digest(current.classification) !== digest(original.classification) ||
    digest(current.pause) !== digest(original.pause) ||
    digest(current.capacity) !== digest(original.capacity) ||
    measured.source.controller.source_commit !== tools.identity.controller_revision
  )
    throw new Error("risk authorization differs from actual fixed source/protection/OIDC controls");
  const recheckControls = () => {
    requireAuthenticatedReleaseControlSource(controls, stage);
    const closingControls = controls.read(api, context.facts.opportunity);
    if (
      digest(closingControls.classification) !== digest(current.classification) ||
      digest(closingControls.pause) !== digest(current.pause) ||
      digest(closingControls.capacity) !== digest(current.capacity) ||
      closingControls.reader.job_id !== current.reader.job_id ||
      closingControls.pause.publication_paused ||
      !closingControls.resource_policy_matches_controller
    )
      throw new Error("risk controls changed during authenticated acquisition");
  };
  const now = new Date().toISOString();
  const { readControllerToolFile } = await import("./release-controller-tools.mts");
  const controllerPolicy = await readControllerToolFile(
    path.join(tools.root, "deny.toml"),
    64 * 1024,
  );
  if (
    !isRecord(measured.assessment) ||
    measured.assessment.policySha256 !==
      hash(controllerPolicy.toString("utf8").replaceAll("\r\n", "\n"))
  )
    throw new Error("compiler scanner policy differs from manifest-owned fixed controller policy");
  if (measured.assessment.scanPassed === true) {
    // Freshness was checked against the producing job when the raw scan was
    // captured. Later callers reauthenticate that immutable exact-source report;
    // they do not start a new scanner-age deadline after build/native/TUF work.
    await recheck();
    recheckControls();
    checkCoordinatorDeadline();
    if (phaseDeadline !== undefined && performance.now() >= phaseDeadline)
      throw new Error("clean risk gate original deadline exhausted");
    return Object.freeze({
      disposition: "actual-clean-scan",
      candidate: measured.source.preparation.prepared_commit,
      scanPassed: true,
      expires_at: null,
      releaseAuthorization: "risk-component-only; other admission still required",
    });
  }
  if (!authorities.linux_risk_profile)
    throw new Error("protected Linux risk held: explicit newly ratified owner amendment absent");
  const profile = authorities.linux_risk_profile;
  const comment = api.request("GET", `${base}/issues/comments/${profile.amendment.comment_id}`);
  if (comment.status !== 200) throw new Error("new owner amendment unavailable");
  inspectInitialProofRisk706Comment(profile, comment.body, now);
  inspectRisk706MeasurementPins(
    profile,
    measured,
    readRisk706NativeInputs(api, measured.source.preparation.source_tree),
    hash(controllerPolicy.toString("utf8").replaceAll("\r\n", "\n")),
  );
  const { recoverRemoteCoordinator, hydrateRetainedCoordinatorOperation } =
    await import("./release-coordinator-recovery.mts");
  const snapshot = await recoverRemoteCoordinator(
    directory,
    { schema_version: 1, namespace: authorities.namespace },
    {
      transport: {
        cwd: directory,
        spawn: readSpawn,
        ...(phaseDeadline === undefined ? {} : { deadline: phaseDeadline }),
      },
    },
  );
  if (
    !isRecord(snapshot) ||
    typeof snapshot.repository !== "string" ||
    typeof snapshot.checkpoint !== "string" ||
    (checkpoint !== undefined && snapshot.checkpoint !== checkpoint) ||
    !isRecord(snapshot.input) ||
    !isRecord(snapshot.input.controller) ||
    !isRecord(snapshot.input.controller.capacity_attempt) ||
    !isRecord(snapshot.input.active_candidate) ||
    snapshot.input.active_candidate.prepared_commit !== measured.source.preparation.prepared_commit
  )
    throw new Error("risk authorization requires exact current reserved candidate checkpoint");
  const capacity = snapshot.input.controller.capacity_attempt;
  if (capacity.schema_version !== 2)
    throw new Error("risk exposure history requires existing compact journal");
  const operation = inspectCapacityOperation(capacity.operation);
  if (operation && !["succeeded", "recovered"].includes(operation.outcome))
    throw new Error("risk held until unresolved effect recovery");
  const { createReleasePublicationReader } = await import("./release-publication-inventory.mts");
  const reader = createReleasePublicationReader(api);
  const beforeTags = reader.tags(),
    beforeReleases = reader.releases();
  const allocations = reader.readAllocations(beforeTags, authorities.namespace).allocations;
  if (allocations.length > 256) throw new Error("risk allocation inventory exceeds existing bound");
  const publicationDestinations = new Set(
    allocations.map((allocation) =>
      digest(`github-release:boburning/portcove:v${allocation.version}:publish`),
    ),
  );
  const durable = [];
  if (operation) {
    const observed = durableExposure706(operation);
    if (observed) durable.push(observed);
  }
  for (const group of inspectCompactCapacityOperations(capacity.prior_operations)) {
    if (!publicationDestinations.has(group.destination_sha256)) continue;
    for (const proof of group.attempts) {
      const raw = await hydrateRetainedCoordinatorOperation(snapshot.repository, proof, { api });
      const observed = durableExposure706(raw);
      if (observed) durable.push(observed);
    }
  }
  const exposed = [];
  const assetSnapshots = new Map<number, unknown[]>();
  const readAssets = (releaseId: number) => {
    let count = 0;
    return api.paginateRest(`${base}/releases/${releaseId}/assets?per_page=100`, {
      select: (body: unknown) => {
        if (!Array.isArray(body) || body.length > 100 || (count += body.length) > 1600)
          throw new Error("risk public assets exceed complete inventory bound");
        return body as unknown[];
      },
      identity: (raw: unknown) =>
        isRecord(raw) && typeof raw.id === "number" && Number.isSafeInteger(raw.id) && raw.id > 0
          ? raw.id
          : null,
      label: "risk public Linux assets",
    });
  };
  for (const release of beforeReleases) {
    if (release.published_at === null) {
      if (!release.draft) throw new Error("nondraft Linux exposure time is unknown");
      continue;
    }
    if (!Number.isFinite(Date.parse(release.published_at)))
      throw new Error("public exposure time malformed");
    if (Date.parse(release.published_at) < Date.parse("2026-10-15T01:21:44.000Z")) continue;
    const assets = readAssets(release.id);
    assetSnapshots.set(release.id, assets);
    if (
      assets.some((raw) => {
        if (
          !isRecord(raw) ||
          typeof raw.name !== "string" ||
          !raw.name ||
          Buffer.byteLength(raw.name) > 512
        )
          throw new Error("public Linux asset inventory incomplete");
        return linux(raw.name);
      })
    )
      exposed.push({ tag: release.tag_name, release_id: release.id });
  }
  if (
    digest(reader.tags()) !== digest(beforeTags) ||
    digest(reader.releases()) !== digest(beforeReleases)
  )
    throw new Error("risk public inventory changed during acquisition");
  for (const [id, before] of assetSnapshots)
    if (digest(readAssets(id)) !== digest(before))
      throw new Error("risk complete asset inventory changed during acquisition");
  // Reuse the maintained whole-site reader and actual keyless Tough preparation.
  // This authenticates immutable release history even after Preview withdrawal.
  const { inspectPublishedMetadata, assertMetadataRenewalBinding } =
    await import("./release-metadata-contract.mts");
  const seed = inspectPublishedMetadata(snapshot.input.published_metadata);
  if (!seed || !authorities.publication)
    throw new Error("risk gate requires actual published Tough seed and ratified anchors");
  const { materializePublishedCompleteSite, requirePublishedCompleteSite } =
    await import("./release-site-readback.mts");
  const { prepareAuthenticatedMetadataRenewal, inspectPreparedMetadataRenewal } =
    await import("./release-metadata-renewal.mts");
  const { readBoundedReleaseContextFiles } = await import("./release-signing-context.mts");
  let priorFiles: ReadonlyMap<string, Buffer>;
  if (context.site_tuf) {
    const tuf = await (
      await import("./release-tuf-publication.mts")
    ).requireRetainedActualTufPublication(context.site_tuf, phaseDeadline);
    const previous = tuf.context.manifest.previous_site_pins;
    if (
      !isRecord(previous) ||
      previous.root_sha256 !== seed.root_sha256 ||
      previous.repository_sha256 !== seed.repository_sha256 ||
      previous.site_generation_sha256 !== seed.publication.site_generation_sha256
    )
      throw new Error("new-candidate feed risk proof differs from current authenticated prior");
    // Already assembled by the actual keyless verifier. Rehash the original
    // context and its complete immutable history instead of another Rust job.
    priorFiles = await readBoundedReleaseContextFiles(tuf.input_root);
  } else {
    let retainedSite = priorSites.get(cacheKey);
    if (!retainedSite || retainedSite.seed !== digest(seed)) {
      const site = await materializePublishedCompleteSite(
        {
          root_sha256: String(seed.root_sha256),
          repository_sha256: String(seed.repository_sha256),
          site_generation_sha256: seed.publication.site_generation_sha256,
        },
        directory,
        phaseDeadline,
      );
      const preparation = await prepareAuthenticatedMetadataRenewal({
        verifier: tools.rust,
        verifier_sha256: hash(await readControllerToolFile(tools.rust, 128 * 1024 * 1024)),
        trusted_root: site.root_path,
        trusted_root_sha256: String(seed.root_sha256),
        previous_repository: site.application,
        prior_repository_sha256: String(seed.repository_sha256),
        generated_at: now,
        output_parent: directory,
        ...(phaseDeadline === undefined ? {} : { deadline: phaseDeadline }),
      });
      retainedSite = { seed: digest(seed), site: site.receipt, preparation };
      priorSites.set(cacheKey, retainedSite);
    }
    await requirePublishedCompleteSite(retainedSite.site);
    const prior = await inspectPreparedMetadataRenewal(retainedSite.preparation);
    assertMetadataRenewalBinding(prior.descriptor, seed, new Date().toISOString());
    priorFiles = await readBoundedReleaseContextFiles(prior.prepared_root);
  }
  const pins = authorities.publication.public_source;
  for (const [name, pin] of [
    ["trusted-root.json", pins.root],
    ["offline-targets.json", pins.offline_targets],
    ["payload.json", pins.payload_key_registry],
  ] as const)
    if (!priorFiles.has(name) || hash(priorFiles.get(name)!) !== pin.sha256)
      throw new Error("risk Tough anchors differ from ratified public pins");
  const manifestBytes = priorFiles.get("records/reconstruction-manifest.json");
  const manifest: unknown = manifestBytes ? JSON.parse(manifestBytes.toString("utf8")) : null;
  if (
    !isRecord(manifest) ||
    manifest.schema_version !== 1 ||
    !Array.isArray(manifest.records) ||
    manifest.records.length > 1536
  )
    throw new Error("risk immutable Tough record history incomplete");
  for (const raw of manifest.records) {
    if (!isRecord(raw) || typeof raw.path !== "string")
      throw new Error("risk Tough record malformed");
    if (raw.kind !== "release" || raw.target !== "linux-x86_64") continue;
    const recordBytes = priorFiles.get(`records/${raw.path}`);
    if (!recordBytes || recordBytes.length !== raw.bytes || hash(recordBytes) !== raw.sha256)
      throw new Error("risk Tough record bytes differ");
    const record: unknown = JSON.parse(recordBytes.toString("utf8"));
    if (
      !isRecord(record) ||
      typeof record.version !== "string" ||
      !durable.some((entry) => entry.tag === `v${String(record.version)}`)
    )
      throw new Error("Tough Linux history lacks original irreversible publication receipt");
  }
  const result = assessInitialProofBudget706({
    durable,
    current: exposed,
    pending: false,
    publication_tag: `v${measured.source.preparation.version}`,
  });
  await recheck();
  recheckControls();
  const closingCheckpoint = api.request(
    "GET",
    `${base}/git/ref/heads/${authorities.namespace}-coordinator-state`,
  );
  if (
    closingCheckpoint.status !== 200 ||
    !isRecord(closingCheckpoint.body) ||
    !isRecord(closingCheckpoint.body.object) ||
    closingCheckpoint.body.object.type !== "commit" ||
    closingCheckpoint.body.object.sha !== snapshot.checkpoint
  )
    throw new Error("risk journal changed during authenticated acquisition");
  const finalComment = api.request(
    "GET",
    `${base}/issues/comments/${profile.amendment.comment_id}`,
  );
  if (finalComment.status !== 200) throw new Error("new owner amendment final read unavailable");
  inspectInitialProofRisk706Comment(profile, finalComment.body, new Date().toISOString());
  checkCoordinatorDeadline();
  if (phaseDeadline !== undefined && performance.now() >= phaseDeadline)
    throw new Error("risk authorization returned after original deadline");
  return Object.freeze({
    ...result,
    disposition: "actual-initial-proof-risk-authorized",
    amendment_sha256: profile.amendment.body_sha256,
    checkpoint: snapshot.checkpoint,
    candidate: measured.source.preparation.prepared_commit,
    scanPassed: measured.assessment.scanPassed,
    expires_at: profile.expires_at,
  });
}
