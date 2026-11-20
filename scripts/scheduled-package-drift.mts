import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  derivationInputsDigest,
  MANAGED_PORTABLE_ADAPTERS,
  SHAPE_COMPONENTS,
} from "./package-shape-baselines.mts";
import { callTimeout, hostedDependencies } from "./release-content-scan.mts";
import { isRecord } from "./runtime-values.mts";

export interface ObservationRun {
  source_commit: string;
  run_id: string;
  run_attempt: string;
}

const inspectionTriggers = {
  schedule: "the schedule",
  workflow_dispatch: "a manual dispatch",
  push: "a push to main",
} as const;

type InspectionTrigger = keyof typeof inspectionTriggers;
interface DriftReportRun extends ObservationRun {
  event_name: InspectionTrigger;
}

function inspectionTrigger(value: string | undefined): InspectionTrigger {
  if (value === "schedule" || value === "workflow_dispatch" || value === "push") return value;
  throw new Error("An exact observer workflow trigger is required");
}

export interface DriftTarget {
  portId: string;
  issue?: number;
  platform: string;
  channel: "stable" | "beta";
  definitionSha256: string;
  baselineSha256: string;
  baselineSource?: "reviewed_layout";
  derivationSha256: string;
  shapeVersion: number;
  repositoryId: number;
  releaseId: number;
  assetId: number;
  version: string;
  asset: { name: string; url: string; size: number; sha256: string };
}

interface DriftBaselineGap {
  reason: "no-reviewed-baseline";
  port_id: string;
  platform: string;
  channel: "stable" | "beta";
  definition_sha256: string;
  repository_id: number;
  release_id: number;
  asset_id: number;
  asset_sha256: string;
  version?: string;
}

type KnownRoute = Pick<DriftTarget, "issue" | "shapeVersion"> & {
  repository: string;
} & (
    | Pick<DriftTarget, "baselineSha256" | "baselineSource" | "derivationSha256">
    | { noReviewedBaseline: true }
  );

const platforms = new Set(["windows-x86-64", "linux-x86-64", "macos-x86-64", "macos-aarch64"]);
const digest = /^[a-f0-9]{64}$/;
const catalogId = /^[a-z0-9][a-z0-9-]{0,127}$/;
const archiveName = /^[a-zA-Z0-9][a-zA-Z0-9._+() -]{0,239}\.(?:zip|tar\.gz|tgz|tar\.xz)$/i;
const supportedScope =
  "complete-current-consumer-projections; managed eligibility remains Core-only";

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isShapeComponentList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((part: unknown) => typeof part === "string" && /^[a-z_]{1,48}$/.test(part))
  );
}

function reviewedLayout(port: Record<string, unknown>, platform: string) {
  if (!isRecord(port.reviewed_package_layouts)) return undefined;
  const layout = port.reviewed_package_layouts[platform];
  if (
    isRecord(layout) &&
    Array.isArray(layout.directories) &&
    layout.directories.every((item: unknown) => typeof item === "string") &&
    Array.isArray(layout.executables) &&
    layout.executables.length > 0 &&
    layout.executables.every((item: unknown) => typeof item === "string")
  )
    return layout;
}

function knownRoutes(catalog: unknown, listings: unknown, shapes: unknown) {
  if (!isRecord(catalog) || !isRecord(listings) || !isRecord(shapes)) {
    throw new Error("The managed catalog, listing projection and shape table are required");
  }
  const listingsById = new Map(
    records(listings.listings).flatMap((listing) =>
      typeof listing.id === "string" ? [[listing.id, listing] as const] : [],
    ),
  );
  if (!positiveInteger(shapes.shape_version)) throw new Error("Invalid shape table version");
  const shapeVersion = shapes.shape_version;
  const table = records(shapes.entries);
  const canUseLayoutFallback =
    Array.isArray(shapes.entries) && shapes.entries.length === table.length;
  const routes = new Map<string, KnownRoute>();
  for (const port of records(catalog.ports)) {
    if (
      typeof port.id !== "string" ||
      !catalogId.test(port.id) ||
      !isRecord(port.release) ||
      typeof port.release.repository !== "string" ||
      !Array.isArray(port.platforms)
    )
      continue;
    const listing = listingsById.get(port.id);
    if (!listing) continue;
    const issue = listing.issue_number;
    for (const platform of port.platforms) {
      if (typeof platform !== "string" || !platforms.has(platform)) continue;
      const baselines = table.filter(
        (shape) => shape.port_id === port.id && shape.platform === platform,
      );
      const route = {
        ...(positiveInteger(issue) ? { issue } : {}),
        repository: port.release.repository,
        shapeVersion,
      };
      if (baselines.length === 0) {
        if (
          !canUseLayoutFallback ||
          typeof port.adapter !== "string" ||
          !MANAGED_PORTABLE_ADAPTERS.has(port.adapter) ||
          (port.release.provider !== undefined && port.release.provider !== "github")
        )
          continue;
        const layout = reviewedLayout(port, platform);
        if (layout) {
          routes.set(`${port.id}/${platform}`, {
            ...route,
            baselineSha256: createHash("sha256").update(JSON.stringify(layout)).digest("hex"),
            baselineSource: "reviewed_layout",
            derivationSha256: derivationInputsDigest(port, platform),
          });
        } else routes.set(`${port.id}/${platform}`, { ...route, noReviewedBaseline: true });
        continue;
      }
      const derivationSha256 = baselines[0]?.derivation_inputs_sha256;
      if (
        typeof derivationSha256 !== "string" ||
        !digest.test(derivationSha256) ||
        baselines.some((shape) => shape.derivation_inputs_sha256 !== derivationSha256)
      )
        continue;
      routes.set(`${port.id}/${platform}`, {
        ...route,
        baselineSha256: createHash("sha256").update(JSON.stringify(baselines)).digest("hex"),
        derivationSha256,
      });
    }
  }
  return routes;
}

function parseAsset(
  value: unknown,
  repository: string,
  version: string,
): DriftTarget["asset"] | null {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !archiveName.test(value.name) ||
    typeof value.url !== "string" ||
    !positiveInteger(value.size) ||
    typeof value.sha256 !== "string" ||
    !digest.test(value.sha256)
  )
    return null;
  const url = URL.parse(value.url);
  if (
    !url ||
    url.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return null;
  const path = url.pathname.split("/");
  if (path.length !== 7 || path[3] !== "releases" || path[4] !== "download") return null;
  try {
    if (
      `${path[1]}/${path[2]}`.toLowerCase() !== repository.toLowerCase() ||
      decodeURIComponent(path[5]!) !== version ||
      decodeURIComponent(path[6]!) !== value.name
    )
      return null;
  } catch {
    return null;
  }
  return { name: value.name, url: url.href, size: value.size, sha256: value.sha256 };
}

export function collectDriftTargets(
  catalog: unknown,
  listings: unknown,
  shapeTable: unknown,
  handoffs: readonly unknown[],
  run: ObservationRun,
  now: number,
) {
  const routes = knownRoutes(catalog, listings, shapeTable);
  const candidates = new Map<string, DriftTarget>();
  const gaps = new Map<string, { row: DriftBaselineGap; identity: string }>();
  const conflicts = new Set<string>();
  for (const handoff of handoffs) {
    if (
      !isRecord(handoff) ||
      handoff.catalog_policies_scope !== supportedScope ||
      !isRecord(handoff.execution) ||
      !Array.isArray(handoff.unassessed_current_port_ids) ||
      handoff.unassessed_current_port_ids.length !== 0 ||
      !Array.isArray(handoff.source_port_ids) ||
      handoff.execution.source_commit !== run.source_commit ||
      handoff.execution.run_id !== run.run_id ||
      handoff.execution.run_attempt !== run.run_attempt
    )
      continue;
    for (const policy of records(handoff.catalog_policies)) {
      if (
        typeof policy.port_id !== "string" ||
        !handoff.source_port_ids.includes(policy.port_id) ||
        !positiveInteger(policy.repository_id) ||
        typeof policy.catalog_definition_sha256 !== "string" ||
        !digest.test(policy.catalog_definition_sha256) ||
        typeof policy.observed_at !== "string"
      )
        continue;
      const age = now - Date.parse(policy.observed_at);
      if (!(age >= 0 && age <= 4 * 60 * 60_000)) continue;
      for (const projection of records(policy.projections)) {
        if (
          typeof projection.platform !== "string" ||
          (projection.channel !== "stable" && projection.channel !== "beta") ||
          !isRecord(projection.latest_eligible) ||
          !isRecord(projection.channel_candidate)
        )
          continue;
        const route = routes.get(`${policy.port_id}/${projection.platform}`);
        const selected = projection.latest_eligible;
        if (
          !route ||
          !positiveInteger(selected.release_id) ||
          !positiveInteger(selected.asset_id) ||
          selected.release_id !== projection.channel_candidate.id ||
          !isRecord(selected.release) ||
          typeof selected.release.version !== "string" ||
          selected.release.version !== projection.channel_candidate.tag ||
          selected.release.channel !== projection.channel
        )
          continue;
        const asset = parseAsset(
          selected.release.asset,
          route.repository,
          selected.release.version,
        );
        if (!asset) continue;
        const key = `${policy.port_id}/${projection.platform}/${projection.channel}`;
        if ("noReviewedBaseline" in route) {
          const gap: DriftBaselineGap = {
            reason: "no-reviewed-baseline",
            port_id: policy.port_id,
            platform: projection.platform,
            channel: projection.channel,
            definition_sha256: policy.catalog_definition_sha256,
            repository_id: policy.repository_id,
            release_id: selected.release_id,
            asset_id: selected.asset_id,
            asset_sha256: asset.sha256,
            ...(Buffer.byteLength(selected.release.version) <= 256
              ? { version: selected.release.version }
              : {}),
          };
          const identity = createHash("sha256")
            .update(JSON.stringify([gap, selected.release.version, asset]))
            .digest("hex");
          const prior = gaps.get(key);
          if (prior && prior.identity !== identity) conflicts.add(key);
          gaps.set(key, { row: gap, identity });
          continue;
        }
        const target: DriftTarget = {
          portId: policy.port_id,
          ...(route.issue === undefined ? {} : { issue: route.issue }),
          platform: projection.platform,
          channel: projection.channel,
          definitionSha256: policy.catalog_definition_sha256,
          baselineSha256: route.baselineSha256,
          ...(route.baselineSource ? { baselineSource: route.baselineSource } : {}),
          derivationSha256: route.derivationSha256,
          shapeVersion: route.shapeVersion,
          repositoryId: policy.repository_id,
          releaseId: selected.release_id,
          assetId: selected.asset_id,
          version: selected.release.version,
          asset,
        };
        const prior = candidates.get(key);
        if (prior && driftTargetKey(prior) !== driftTargetKey(target)) conflicts.add(key);
        candidates.set(key, target);
      }
    }
  }
  const generated: DriftTarget[] = [];
  const layouts: DriftTarget[] = [];
  for (const [key, target] of candidates) {
    if (conflicts.has(key)) continue;
    (target.baselineSource ? layouts : generated).push(target);
  }
  const gapKeys = [...gaps.keys()].filter((key) => !conflicts.has(key)).sort();
  const retainedGapKeys = gapKeys.slice(0, 1024);
  return {
    targets: [...generated, ...layouts],
    baselineGaps: {
      rows: retainedGapKeys.map((key) => gaps.get(key)!.row),
      omitted: gapKeys.length - retainedGapKeys.length,
    },
  };
}

export function driftTargetKey(target: DriftTarget): string {
  const { issue: _issue, ...inspectionInputs } = target;
  return createHash("sha256").update(JSON.stringify(inspectionInputs)).digest("hex");
}

interface Inspection {
  status: "compatible" | "drifted" | "unknown";
  shapeVersion: number;
  derivationSha256: string;
  components: string[];
  layoutMatch?: true;
}

interface DriftObservation {
  key: string;
  target: DriftTarget;
  inspection: Inspection;
}

const exec = promisify(execFile);
const archiveLimit = 768 * 1024 * 1024;
const totalArchiveLimit = 2 * 1024 * 1024 * 1024;
const subprocessLimit = 4 * 1024 * 1024;
const layoutComponents = new Set<string>(["programs", "top_directories"]);
const otherComponents = SHAPE_COMPONENTS.filter((part) => !layoutComponents.has(part));
const driftTiers = ["generated", "reviewed_layout"] as const;
type DriftTier = (typeof driftTiers)[number];
type DriftContinuation = Partial<Record<DriftTier, string>>;

function driftRouteKey(target: DriftTarget): string {
  return `${target.portId}/${target.platform}/${target.channel}`;
}

function driftTier(target: DriftTarget): DriftTier {
  return target.baselineSource ?? "generated";
}

export function readDriftContinuation(value: unknown): DriftContinuation {
  if (!isRecord(value) || value.format !== 1 || !isRecord(value.continuation)) return {};
  const continuation: DriftContinuation = {};
  for (const tier of driftTiers) {
    const key = value.continuation[tier];
    if (typeof key !== "string" || key.length > 160) continue;
    const [port, platform, channel, ...extra] = key.split("/");
    if (
      port !== undefined &&
      catalogId.test(port) &&
      platform !== undefined &&
      platforms.has(platform) &&
      (channel === "stable" || channel === "beta") &&
      extra.length === 0
    )
      continuation[tier] = key;
  }
  return continuation;
}

function orderedDriftTargets(targets: readonly DriftTarget[], resumeAt: string | undefined) {
  const byRoute = targets
    .map((target) => ({ key: driftRouteKey(target), target }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const start = resumeAt === undefined ? 0 : byRoute.findIndex(({ key }) => key >= resumeAt);
  if (start <= 0) return byRoute;
  return [...byRoute.slice(start), ...byRoute.slice(0, start)];
}

export function inspectionFromResponse(value: unknown, target: DriftTarget): Inspection {
  const data =
    isRecord(value) && value.ok === true && value.command === "catalog.inspect-package-shape"
      ? value.data
      : null;
  if (
    !isRecord(data) ||
    data.port_id !== target.portId ||
    data.platform !== target.platform ||
    data.sha256 !== target.asset.sha256 ||
    data.shape_version !== target.shapeVersion ||
    data.derivation_inputs_sha256 !== target.derivationSha256 ||
    !isRecord(data.verdict)
  )
    throw new Error("Core did not return an inspection bound to the selected package");
  const status = data.verdict.status;
  if (status !== "compatible" && status !== "drifted" && status !== "unknown") {
    throw new Error("Core returned an unrecognized shape verdict");
  }
  const components = records(data.verdict.changes).map((change) => change.component);
  if (!isShapeComponentList(components)) {
    throw new Error("Core returned an unrecognized shape component");
  }
  if (
    target.baselineSource === "reviewed_layout" &&
    (!isRecord(data.verdict.baseline) ||
      data.verdict.baseline.source !== "reviewed_layout" ||
      (status === "unknown"
        ? data.verdict.reason !== "incomplete_comparison"
        : status !== "drifted" ||
          components.length === 0 ||
          components.some((part) => !layoutComponents.has(part))))
  )
    throw new Error("Core did not compare against the explicit reviewed layout");
  // These are the components omitted by a reviewed layout. If Core reported
  // any other unknown, one of the two reviewed components did not compare.
  const unknown = data.verdict.unknown;
  const layoutMatch =
    target.baselineSource === "reviewed_layout" &&
    status === "unknown" &&
    components.length === 0 &&
    isShapeComponentList(unknown) &&
    unknown.length === otherComponents.length &&
    otherComponents.every((part) => unknown.includes(part));
  return {
    status,
    shapeVersion: data.shape_version,
    derivationSha256: data.derivation_inputs_sha256,
    components: [...new Set(components)].sort(),
    ...(layoutMatch ? { layoutMatch: true } : {}),
  };
}

async function inspect(archive: string, target: DriftTarget, cli: string, deadline: number) {
  const { stdout } = await exec(
    cli,
    [
      "--json",
      "catalog",
      "inspect-package-drift",
      archive,
      "--port",
      target.portId,
      "--platform",
      target.platform,
      "--size",
      String(target.asset.size),
      "--sha256",
      target.asset.sha256,
    ],
    { encoding: "utf8", timeout: callTimeout(180_000, deadline), maxBuffer: subprocessLimit },
  );
  return inspectionFromResponse(JSON.parse(stdout), target);
}

export async function scanDriftTargets(
  targets: readonly DriftTarget[],
  completed: ReadonlyMap<string, Inspection>,
  stopAt: number,
  dependencies: {
    download: (asset: DriftTarget["asset"], archive: string, stopAt: number) => Promise<void>;
    inspect: (archive: string, target: DriftTarget, stopAt: number) => Promise<Inspection>;
    now?: () => number;
  },
  priorContinuation: DriftContinuation = {},
) {
  const observations: DriftObservation[] = [];
  const unassessed: { target: DriftTarget; reason: string }[] = [];
  let bytes = 0;
  const now = dependencies.now ?? Date.now;
  const queues = driftTiers.map((tier) => ({
    tier,
    routes: orderedDriftTargets(
      targets.filter((target) => driftTier(target) === tier),
      priorContinuation[tier],
    ),
  }));
  const deferred: DriftContinuation = {};
  for (const { key: route, target } of queues.flatMap(({ routes }) => routes)) {
    const key = driftTargetKey(target);
    const prior = completed.get(key);
    if (
      prior?.shapeVersion === target.shapeVersion &&
      prior.derivationSha256 === target.derivationSha256 &&
      (prior.status !== "unknown" ||
        (target.baselineSource === "reviewed_layout" && prior.layoutMatch === true))
    ) {
      observations.push({ key, target, inspection: prior });
      continue;
    }
    if (
      target.asset.size > archiveLimit ||
      target.asset.size + bytes > totalArchiveLimit ||
      now() >= stopAt
    ) {
      if (target.asset.size <= archiveLimit) deferred[driftTier(target)] ??= route;
      unassessed.push({ target, reason: "inspection-budget" });
      continue;
    }
    bytes += target.asset.size;
    const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-package-drift-"));
    let phase = "download";
    try {
      const archive = path.join(directory, target.asset.name);
      await dependencies.download(target.asset, archive, stopAt);
      phase = "core-inspection";
      const inspection = await dependencies.inspect(archive, target, stopAt);
      observations.push({ key, target, inspection });
    } catch {
      unassessed.push({ target, reason: `${phase}-failed` });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  const continuation: DriftContinuation = {};
  for (const { tier, routes } of queues) {
    const resume = deferred[tier];
    if (resume !== undefined) {
      // A route that could not fit even in the first slot must not pin the queue.
      const next = routes.find(
        ({ key, target }) => key !== resume && target.asset.size <= archiveLimit,
      );
      continuation[tier] = resume === routes[0]?.key ? (next?.key ?? resume) : resume;
    }
  }
  return { observations, unassessed, attempted_bytes: bytes, continuation };
}

async function readBoundedJson(file: string, maxBytes: number): Promise<unknown> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > maxBytes)
    throw new Error(`Invalid JSON input ${path.basename(file)}`);
  return JSON.parse(await readFile(file, "utf8"));
}

export function completedInspections(
  value: unknown,
  inspectorSha256: string,
): Map<string, Inspection> {
  const completed = new Map<string, Inspection>();
  if (!isRecord(value) || value.format !== 1 || value.inspector_sha256 !== inspectorSha256)
    return completed;
  for (const item of records(value.observations)) {
    if (typeof item.key !== "string" || !digest.test(item.key) || !isRecord(item.inspection))
      continue;
    const { status, shapeVersion, derivationSha256, components, layoutMatch } = item.inspection;
    if (
      (status !== "compatible" &&
        status !== "drifted" &&
        !(status === "unknown" && layoutMatch === true)) ||
      !positiveInteger(shapeVersion) ||
      typeof derivationSha256 !== "string" ||
      !digest.test(derivationSha256) ||
      !isShapeComponentList(components) ||
      (status === "unknown" && components.length > 0)
    )
      continue;
    completed.set(item.key, {
      status,
      shapeVersion,
      derivationSha256,
      components,
      ...(status === "unknown" ? { layoutMatch: true } : {}),
    });
  }
  return completed;
}

async function writeJson(file: string, value: unknown) {
  const temporary = `${file}.${process.pid}.next`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx" });
  await rename(temporary, file);
}

async function runScan(cli: string, directory: string, output: string, checkpoint: string) {
  const source_commit = process.env.GITHUB_SHA;
  const run_id = process.env.GITHUB_RUN_ID;
  const run_attempt = process.env.GITHUB_RUN_ATTEMPT;
  if (!source_commit || !/^[a-f0-9]{40}$/.test(source_commit) || !run_id || !run_attempt) {
    throw new Error("An exact observer run and attempt are required");
  }
  const run = {
    source_commit,
    run_id,
    run_attempt,
    event_name: inspectionTrigger(process.env.GITHUB_EVENT_NAME),
  };
  const catalogRoot = path.resolve("crates/portcove-core/catalog");
  const inspector = path.resolve(cli);
  const fileHash = createHash("sha256");
  for await (const chunk of createReadStream(inspector)) {
    if (!Buffer.isBuffer(chunk)) throw new Error("The inspector must be read as binary bytes");
    fileHash.update(chunk);
  }
  const inspector_sha256 = fileHash.digest("hex");
  const [catalog, listings, shapes, handoffFiles] = await Promise.all([
    readBoundedJson(path.join(catalogRoot, "catalog.json"), 32 * 1024 * 1024),
    readBoundedJson(path.join(catalogRoot, "listings.json"), 32 * 1024 * 1024),
    readBoundedJson(path.join(catalogRoot, "package-shapes.generated.json"), 8 * 1024 * 1024),
    readdir(directory, { withFileTypes: true }),
  ]);
  const handoffs: unknown[] = [];
  let handoffBytes = 0;
  for (const file of handoffFiles) {
    if (file.isFile() && file.name.endsWith(".json") && file.name !== "summary.json") {
      const source = path.join(directory, file.name);
      handoffBytes += (await lstat(source)).size;
      if (handoffBytes > 128 * 1024 * 1024)
        throw new Error("Observation handoff exceeds the inspection budget");
      handoffs.push(await readBoundedJson(source, 16 * 1024 * 1024));
    }
  }
  const { targets, baselineGaps } = collectDriftTargets(
    catalog,
    listings,
    shapes,
    handoffs,
    run,
    Date.now(),
  );
  let previous: unknown;
  try {
    previous = await readBoundedJson(checkpoint, 4 * 1024 * 1024);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  const downloader = hostedDependencies();
  const cache = completedInspections(previous, inspector_sha256);
  const { continuation, ...result } = await scanDriftTargets(
    targets,
    cache,
    Date.now() + 20 * 60_000,
    {
      download: (asset, archive, deadline) =>
        downloader.download(
          { ...asset, digest: `sha256:${asset.sha256}` },
          archive,
          asset.size,
          deadline,
        ),
      inspect: (archive, candidate, deadline) => inspect(archive, candidate, inspector, deadline),
    },
    readDriftContinuation(previous),
  );
  // Only current evidence goes to the notice job. Preserve earlier comparisons
  // for unobserved routes only while the same inspector bytes are in use.
  for (const item of result.observations) {
    if (item.inspection.status === "unknown" && item.inspection.layoutMatch !== true) continue;
    cache.delete(item.key);
    cache.set(item.key, item.inspection);
  }
  const observations = [...cache].slice(-512).map(([key, inspection]) => ({ key, inspection }));
  await writeJson(checkpoint, { format: 1, inspector_sha256, observations, continuation });
  await writeJson(output, {
    format: 1,
    run,
    inspector_sha256,
    ...result,
    baseline_gaps: baselineGaps,
  });
  console.log(
    `Compared ${result.observations.length} packages for ${targets.length} current routes with a baseline. ${result.unassessed.length} were unassessed. ${baselineGaps.rows.length + baselineGaps.omitted} other current routes lack a reviewed baseline.`,
  );
}

const noticeMarker = "<!-- portcove-scheduled-package-drift:v1 -->";
const repo = "boburning/portcove";
const botId = 41898282;
const versionLabel = /^[a-zA-Z0-9][a-zA-Z0-9._+() -]{0,127}$/;

interface DriftNotice {
  issue: number;
  identity: string;
  body: string;
}

export function driftNotices(
  report: unknown,
  listings: unknown,
  run: DriftReportRun,
): DriftNotice[] {
  if (
    !isRecord(report) ||
    report.format !== 1 ||
    !isRecord(report.run) ||
    Object.entries(run).some(
      ([key, value]) => !isRecord(report.run) || report.run[key] !== value,
    ) ||
    !isRecord(listings)
  )
    throw new Error("The exact observer package inspection report is required");
  const issues = new Map(records(listings.listings).map((entry) => [entry.id, entry.issue_number]));
  const eligible = new Map<number, { key: string; line: string }[]>();
  for (const observation of records(report.observations)) {
    const { target, inspection, key } = observation;
    if (
      !isRecord(inspection) ||
      inspection.status !== "drifted" ||
      !isRecord(target) ||
      !positiveInteger(target.issue) ||
      issues.get(target.portId) !== target.issue ||
      typeof target.portId !== "string" ||
      !catalogId.test(target.portId) ||
      typeof target.platform !== "string" ||
      !platforms.has(target.platform) ||
      (target.channel !== "beta" && target.channel !== "stable") ||
      typeof target.version !== "string" ||
      !versionLabel.test(target.version) ||
      !isRecord(target.asset) ||
      typeof target.asset.sha256 !== "string" ||
      !digest.test(target.asset.sha256) ||
      !positiveInteger(target.releaseId) ||
      !positiveInteger(target.assetId) ||
      typeof key !== "string" ||
      !digest.test(key) ||
      !isShapeComponentList(inspection.components) ||
      inspection.components.length === 0
    )
      continue;
    const line = `- \`${target.portId}\` · ${target.platform} · ${target.channel} · \`${target.version}\` · release ${target.releaseId}, asset ${target.assetId} · SHA-256 \`${target.asset.sha256}\` · ${inspection.components.map((component) => component.replaceAll("_", " ")).join(", ")}`;
    const rows = eligible.get(target.issue) ?? [];
    if (rows.every((row) => row.key !== key)) rows.push({ key, line });
    eligible.set(target.issue, rows);
  }
  return [...eligible].map(([issue, rows]) => {
    rows.sort((left, right) => left.line.localeCompare(right.line));
    const identity = createHash("sha256")
      .update(rows.map((row) => row.key).join("\n"))
      .digest("hex");
    return {
      issue,
      identity,
      body: [
        noticeMarker,
        `<!-- observation:${identity} run:${run.run_id} attempt:${run.run_attempt} -->`,
        "",
        `Core found a changed package shape during an archive inspection started by ${inspectionTriggers[run.event_name]}.`,
        "",
        ...rows.map((row) => row.line),
        "",
        `The [inspection run](https://github.com/${repo}/actions/runs/${run.run_id}/attempts/${run.run_attempt}) records the exact package bytes and comparison scope. This notice records the observation. Runtime or update eligibility is decided by Core using the installed state.`,
      ].join("\n"),
    };
  });
}

function ownedMarker(comment: Record<string, unknown>) {
  return (
    isRecord(comment.user) &&
    comment.user.id === botId &&
    typeof comment.body === "string" &&
    comment.body.startsWith(`${noticeMarker}\n`)
  );
}

async function issueApi(args: string[], stopAt: number): Promise<unknown> {
  const { stdout } = await exec("gh", ["api", ...args], {
    encoding: "utf8",
    timeout: callTimeout(25_000, stopAt),
    maxBuffer: subprocessLimit,
  });
  return JSON.parse(stdout);
}

async function publishNotices(reportPath: string) {
  const { GITHUB_REPOSITORY, GITHUB_REF, GITHUB_SHA, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } =
    process.env;
  if (
    GITHUB_REPOSITORY !== repo ||
    GITHUB_REF !== "refs/heads/main" ||
    !GITHUB_SHA ||
    !/^[a-f0-9]{40}$/.test(GITHUB_SHA) ||
    !GITHUB_RUN_ID ||
    !/^\d+$/.test(GITHUB_RUN_ID) ||
    !GITHUB_RUN_ATTEMPT ||
    !/^\d+$/.test(GITHUB_RUN_ATTEMPT)
  )
    throw new Error("Notices require the approved workflow on Portcove main");
  const run = {
    source_commit: GITHUB_SHA,
    run_id: GITHUB_RUN_ID,
    run_attempt: GITHUB_RUN_ATTEMPT,
    event_name: inspectionTrigger(process.env.GITHUB_EVENT_NAME),
  };
  const report = await readBoundedJson(reportPath, 8 * 1024 * 1024);
  const listing = await readBoundedJson(
    "crates/portcove-core/catalog/listings.json",
    32 * 1024 * 1024,
  );
  const notices = driftNotices(report, listing, run);
  const deadline = Date.now() + 4 * 60_000;
  for (const notice of notices) {
    const issuePath = `repos/${repo}/issues/${notice.issue}`;
    const issue = await issueApi([issuePath], deadline);
    if (
      !isRecord(issue) ||
      issue.number !== notice.issue ||
      issue.locked !== false ||
      issue.pull_request
    )
      continue;
    const pages = await issueApi(
      ["--paginate", "--slurp", `${issuePath}/comments?per_page=100`],
      deadline,
    );
    if (!Array.isArray(pages) || !pages.every(Array.isArray))
      throw new Error("Issue comment coverage is unavailable");
    const markers = records(pages.flat()).filter(ownedMarker);
    if (markers.length > 1) throw new Error(`Duplicate drift notice markers on #${notice.issue}`);
    const previous = markers[0];
    if (typeof previous?.body === "string") {
      const receipt = /\n<!-- observation:([a-f0-9]{64}) run:(\d+) attempt:(\d+) -->\n/.exec(
        previous.body,
      );
      if (!receipt || !positiveInteger(previous.id))
        throw new Error(`Invalid drift notice marker on #${notice.issue}`);
      if (
        receipt[1] === notice.identity ||
        BigInt(receipt[2]!) > BigInt(run.run_id) ||
        (receipt[2] === run.run_id && BigInt(receipt[3]!) > BigInt(run.run_attempt))
      )
        continue;
      const commentPath = `repos/${repo}/issues/comments/${previous.id}`;
      const preimage = await issueApi([commentPath], deadline);
      if (!isRecord(preimage) || !ownedMarker(preimage) || preimage.body !== previous.body) {
        throw new Error(`Drift notice changed before update for #${notice.issue}`);
      }
      const reply = await issueApi(
        ["--method", "PATCH", commentPath, "-f", `body=${notice.body}`],
        deadline,
      );
      if (
        !isRecord(reply) ||
        reply.id !== previous.id ||
        !ownedMarker(reply) ||
        reply.body !== notice.body
      ) {
        throw new Error(`Drift notice update is unconfirmed for #${notice.issue}`);
      }
    } else {
      const reply = await issueApi(
        ["--method", "POST", `${issuePath}/comments`, "-f", `body=${notice.body}`],
        deadline,
      );
      if (
        !isRecord(reply) ||
        !positiveInteger(reply.id) ||
        !ownedMarker(reply) ||
        reply.body !== notice.body
      ) {
        throw new Error(`Drift notice creation is unconfirmed for #${notice.issue}`);
      }
    }
    console.log(`Recorded package shape observation on #${notice.issue}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  const [cli, handoffs, output, checkpoint] = args;
  if (mode === "scan" && args.length === 4 && cli && handoffs && output && checkpoint) {
    await runScan(cli, handoffs, output, checkpoint);
  } else if (mode === "notice" && args.length === 1 && cli) {
    await publishNotices(cli);
  } else {
    throw new Error(
      "Usage: scheduled-package-drift.mts scan CLI HANDOFF_DIR REPORT CHECKPOINT | notice REPORT",
    );
  }
}
