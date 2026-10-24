/** Inert setup-input collection. Historical owner observations are authenticated
 * only by the protected setup pins; this reader cannot mint a signing/session
 * capability or relabel the historical preimage as a fresh owner observation. */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { GitHubRestReader } from "./github-api.mts";
import {
  inspectPublicationAuthorities,
  inspectCatalogAuthorityConfiguration,
  inspectSelectedPublicationAuthorityConfiguration,
  requireControllerCatalogJobAuthorities,
} from "./release-authority-configuration.mts";
import {
  inspectRemoteCommitObject,
  inspectRemoteGitObject,
} from "./release-coordinator-recovery.mts";
import { inspectReleaseSourceTree } from "./release-source-changes.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";

import { inspectBootstrapCatalogPins } from "./release-metadata-signing-contract.mts";
import {
  requirePublishedCatalogCompleteSite,
  readPublicApplicationSite,
} from "./release-site-readback.mts";

const base = "repos/boburning/portcove";
const origin = "https://boburning.github.io/portcove/";
const routes = [
  "",
  "publication.json",
  "application/metadata/timestamp.json",
  "catalog/metadata/timestamp.json",
];
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function check(deadline: number) {
  if (!Number.isFinite(deadline) || performance.now() >= deadline)
    throw new Error("bootstrap public input deadline exhausted");
}
export function inspectHistoricalBootstrapPreimage(bytes: Buffer, generatedAt: string) {
  if (!bytes.length || bytes.length > 128 * 1024)
    throw new Error("historical preimage byte bound differs");
  const raw: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !==
      "authority,evidence_scope,kind,observations,observed_at,origin,schema_version,scope" ||
    raw.schema_version !== 1 ||
    raw.kind !== "unconfigured-application-site-preimage" ||
    raw.origin !== origin ||
    raw.evidence_scope !== "github.com" ||
    raw.authority !== "none" ||
    raw.scope !==
      "initial setup preimage only; no unlisted URL, historical absence or publication claim" ||
    typeof raw.observed_at !== "string" ||
    !Number.isFinite(Date.parse(raw.observed_at)) ||
    new Date(raw.observed_at).toISOString() !== raw.observed_at ||
    !Number.isFinite(Date.parse(generatedAt)) ||
    Date.parse(raw.observed_at) > Date.parse(generatedAt) ||
    !Array.isArray(raw.observations) ||
    raw.observations.length !== 6
  )
    throw new Error("historical owner-ratified setup preimage differs");
  const provider = {
    owner_id: 43177418,
    repository_id: 1354613114,
    owner_repository_visibility: "repo-scope-with-admin-readback",
    project_site_status: 404,
    user_site_repository_status: 404,
  };
  const expected = [
    { phase: "provider-before", ...provider },
    ...routes.map((route) => ({
      phase: "public-route",
      url: new URL(route, origin).href,
      status: 404,
    })),
    { phase: "provider-after", ...provider },
  ];
  if (digest(raw.observations) !== digest(expected))
    throw new Error(
      "historical setup preimage does not cover the exact original provider/public bracket",
    );
  return raw;
}

/** Exact setup-ratified alternative to the historical whole-404 observation.
 * The explicit historical declaration is appointed by the existing protected source pin. */
export function inspectCatalogOnlyBootstrapPreimage(bytes: Buffer, generatedAt: string) {
  if (
    !bytes.length ||
    bytes.length > 128 * 1024 ||
    !Buffer.from(bytes.toString("utf8")).equals(bytes)
  )
    throw new Error("catalog-only preimage bytes invalid");
  const raw: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !==
      "application_history,authority,evidence_scope,kind,observed_at,origin,pins,provider,schema_version,scope" ||
    raw.schema_version !== 1 ||
    raw.kind !== "catalog-only-application-site-preimage" ||
    raw.origin !== origin ||
    raw.evidence_scope !== "github.com" ||
    raw.authority !== "none" ||
    raw.application_history !== "owner-ratified-no-prior-application-publication" ||
    raw.scope !==
      "initial application setup over exact retained catalog; no unlisted URL absence claim" ||
    typeof raw.observed_at !== "string" ||
    !Number.isFinite(Date.parse(raw.observed_at)) ||
    new Date(raw.observed_at).toISOString() !== raw.observed_at ||
    !Number.isFinite(Date.parse(generatedAt)) ||
    Date.parse(raw.observed_at) > Date.parse(generatedAt)
  )
    throw new Error("catalog-only owner-ratified setup preimage differs");
  const pins = inspectBootstrapCatalogPins(raw.pins);
  const provider = inspectConfiguredBootstrapProvider(
    {
      id: 1354613114,
      full_name: "boburning/portcove",
      private: false,
      owner: { id: 43177418, login: "boburning" },
    },
    {
      url: `https://api.github.com/${base}/pages`,
      build_type: "workflow",
      html_url: origin,
      cname: null,
      https_enforced: true,
      public: true,
    },
  );
  if (digest(raw.provider) !== digest(provider))
    throw new Error("catalog-only setup provider differs");
  return { ...raw, pins, observed_at: raw.observed_at };
}
export function bootstrapPreimageCatalogPins(bytes: Buffer, generatedAt: string) {
  if (
    !bytes.length ||
    bytes.length > 128 * 1024 ||
    !Buffer.from(bytes.toString("utf8")).equals(bytes)
  )
    throw new Error("bootstrap preimage byte bound/UTF8 differs");
  const raw: unknown = JSON.parse(bytes.toString("utf8"));
  if (isRecord(raw) && raw.kind === "catalog-only-application-site-preimage")
    return inspectCatalogOnlyBootstrapPreimage(bytes, generatedAt).pins;
  inspectHistoricalBootstrapPreimage(bytes, generatedAt);
  return null;
}
/** Fresh complete fixed-origin bytes and provider bracket from an actual retained
 * catalog receipt. This does not appoint Root, infer historical absence or mint admission. */
export async function readConfiguredCatalogOnlyBootstrapSite(
  api: GitHubRestReader,
  rawPins: unknown,
  receipt: object,
  deadline: number,
) {
  check(deadline);
  const pins = inspectBootstrapCatalogPins(rawPins);
  const provider = () => {
    const get = (endpoint: string) => {
      check(deadline);
      const response = api.request("GET", endpoint);
      check(deadline);
      if (response.status !== 200) throw new Error("catalog-only bootstrap provider unavailable");
      return response.body;
    };
    return inspectConfiguredBootstrapProvider(get(base), get(`${base}/pages`));
  };
  const before = provider();
  const site = await requirePublishedCatalogCompleteSite(receipt);
  if (
    site.generation.application_root_sha256 !== null ||
    site.generation.files.some((file) => file.path.startsWith("application/")) ||
    digest({ ...site.pins, kind: "catalog-only" }) !== digest(pins)
  )
    throw new Error("catalog-only actual site differs from ratified prior");
  // Initial app layout is bounded to its seven anchors/role envelopes; reserve
  // sixteen 1MiB entries conservatively before any online role key is released.
  if (
    site.generation.files.length + 1 + 16 > 6000 ||
    site.generation.files.reduce((total, file) => total + file.bytes, 0) +
      4 * 1024 * 1024 +
      16 * 1024 * 1024 >
      256 * 1024 * 1024
  )
    throw new Error("catalog prior leaves insufficient bounded complete-site bootstrap headroom");
  const publicReadback = await readPublicApplicationSite(site.generation, deadline);
  await requirePublishedCatalogCompleteSite(receipt);
  const after = provider();
  check(deadline);
  if (digest(before) !== digest(after))
    throw new Error("catalog-only provider changed during public readback");
  return { before, public_readback: publicReadback, after, pins, authority: "none" as const };
}

/** The complete bounded tree and raw objects authenticate the configured commit
 * paths. A JSON hash alone is never substituted for that path/commit custody. */
export function readBootstrapPublicSource(
  api: GitHubRestReader,
  rawPublication: unknown,
  generatedAt: string,
  deadline: number,
) {
  const publication = inspectPublicationAuthorities(rawPublication, 2);
  const pins = publication.public_source;
  if (!pins.initial_site_preimage)
    throw new Error("explicit schema2 historical setup locator required");
  const result = readPinnedBootstrapSource(
    api,
    pins.commit,
    {
      root: pins.root,
      offline_targets: pins.offline_targets,
      payload_key_registry: pins.payload_key_registry,
      initial_site_preimage: pins.initial_site_preimage,
    },
    generatedAt,
    deadline,
    true,
  );
  return { publication, ...result };
}

/** Catalog bootstrap has its own explicit setup pin and never requires an
 * application Root, payload registry or application authority appointment. */
export function readCatalogBootstrapPublicSource(
  api: GitHubRestReader,
  rawAuthorities: unknown,
  generatedAt: string,
  deadline: number,
) {
  const authorities =
    isRecord(rawAuthorities) &&
    (rawAuthorities.schema_version === 4 || rawAuthorities.kind === "two-app-fixed-jobs-v1")
      ? inspectSelectedPublicationAuthorityConfiguration(rawAuthorities)
      : inspectCatalogAuthorityConfiguration(rawAuthorities);
  if ("purpose" in authorities && authorities.purpose !== "catalog-publication")
    throw new Error("catalog bootstrap requires catalog purpose");
  if (!("catalog" in authorities)) throw new Error("complete catalog bootstrap scope required");
  const pins = authorities.catalog.public_source;
  if (!pins.initial_site_preimage)
    throw new Error("explicit catalog historical whole-site preimage locator required");
  return {
    authorities,
    ...readPinnedBootstrapSource(
      api,
      pins.commit,
      {
        root: pins.root,
        offline_targets: pins.offline_targets,
        initial_site_preimage: pins.initial_site_preimage,
      },
      generatedAt,
      deadline,
    ),
  };
}

function readPinnedBootstrapSource(
  api: GitHubRestReader,
  sourceCommit: string,
  pins: Record<string, { path: string; bytes: number; sha256: string }>,
  generatedAt: string,
  deadline: number,
  allowCatalogOnly = false,
) {
  let reads = 0;
  const get = (endpoint: string) => {
    check(deadline);
    if (++reads > Object.keys(pins).length + 2)
      throw new Error("bootstrap public source read bound exhausted");
    const response = api.request("GET", endpoint);
    check(deadline);
    if (response.status !== 200) throw new Error("bootstrap public source unavailable");
    return response.body;
  };
  const commit = inspectRemoteCommitObject(
    get(`${base}/git/commits/${sourceCommit}`),
    sourceCommit,
  );
  const tree = inspectReleaseSourceTree(
    get(`${base}/git/trees/${commit.tree}?recursive=1`),
    commit.tree,
  );
  const files = new Map<string, Buffer>();
  for (const name of Object.keys(pins)) {
    const pin = pins[name]!;
    const entry = tree.entries.get(pin.path);
    if (!entry || entry.type !== "blob" || entry.mode !== "100644" || pin.bytes > 128 * 1024)
      throw new Error("bootstrap public input is not a supported bounded regular Git blob");
    const body = get(`${base}/git/blobs/${entry.oid}`);
    if (
      !isRecord(body) ||
      body.sha !== entry.oid ||
      body.encoding !== "base64" ||
      body.size !== pin.bytes ||
      typeof body.content !== "string" ||
      body.content.length > 180 * 1024
    )
      throw new Error("bootstrap public blob response differs");
    const encoded = body.content.replace(/\n/gu, ""),
      bytes = Buffer.from(encoded, "base64");
    if (
      bytes.toString("base64") !== encoded ||
      bytes.length !== pin.bytes ||
      hash(bytes) !== pin.sha256
    )
      throw new Error("bootstrap public blob bytes differ from ratified pin");
    inspectRemoteGitObject("blob", entry.oid, bytes);
    files.set(name, bytes);
  }
  const preimage = files.get("initial_site_preimage")!;
  const historical =
    allowCatalogOnly && bootstrapPreimageCatalogPins(preimage, generatedAt) !== null
      ? inspectCatalogOnlyBootstrapPreimage(preimage, generatedAt)
      : inspectHistoricalBootstrapPreimage(preimage, generatedAt);
  return {
    files,
    historical,
    source_tree: commit.tree,
    api_reads: reads,
    authority: "none" as const,
  };
}

/** Actual protected catalog configuration selects the historical preimage;
 * fresh provider and exact public-route absence are independently re-observed.
 * This is retained input evidence only, never a publication capability. Call
 * again immediately before the sole Pages effect; absence is not reusable. */
export async function readConfiguredCatalogBootstrapSite(
  api: GitHubRestReader,
  generatedAt: string,
  phaseDeadline: number,
) {
  check(phaseDeadline);
  const authorities = await withCoordinatorDeadline(phaseDeadline, () =>
    requireControllerCatalogJobAuthorities("site-publication"),
  );
  check(phaseDeadline);
  const { configuration_sha256 } = authorities;
  const configuration = Object.fromEntries(
    Object.entries(authorities.configuration).filter(([key]) => key !== "configuration_sha256"),
  );
  const source = readCatalogBootstrapPublicSource(api, configuration, generatedAt, phaseDeadline);
  const current = await readConfiguredBootstrapSite(api, phaseDeadline);
  check(phaseDeadline);
  return {
    configuration_sha256,
    setup_plan_sha256: authorities.catalog.setup_plan_sha256,
    root_sha256: authorities.catalog.public_source.root.sha256,
    historical_preimage_sha256: authorities.catalog.public_source.initial_site_preimage!.sha256,
    source,
    current,
    authority: "none" as const,
  };
}

export function inspectConfiguredBootstrapProvider(repo: unknown, pages: unknown) {
  if (
    !isRecord(repo) ||
    repo.id !== 1354613114 ||
    repo.full_name !== "boburning/portcove" ||
    repo.private !== false ||
    !isRecord(repo.owner) ||
    repo.owner.id !== 43177418 ||
    repo.owner.login !== "boburning" ||
    !isRecord(pages) ||
    pages.url !== `https://api.github.com/${base}/pages` ||
    pages.build_type !== "workflow" ||
    pages.html_url !== origin ||
    pages.cname !== null ||
    pages.https_enforced !== true ||
    pages.public !== true
  )
    throw new Error("configured bootstrap Pages provider tuple differs from selected setup");
  return {
    repository_id: repo.id,
    owner_id: repo.owner.id,
    url: pages.url,
    build_type: pages.build_type,
    html_url: pages.html_url,
    cname: pages.cname,
    https_enforced: true,
    public: true,
  };
}

/** Fresh configured project state only. This intentionally does not query the
 * owner account or claim a new user-site absence observation. */
export async function readConfiguredBootstrapSite(
  api: GitHubRestReader,
  phaseDeadline: number,
  options: { fetch?: typeof fetch } = {},
) {
  const deadline = Math.min(phaseDeadline, performance.now() + 30000);
  check(deadline);
  const provider = () => {
    const get = (endpoint: string) => {
      check(deadline);
      const response = api.request("GET", endpoint);
      check(deadline);
      if (response.status !== 200)
        throw new Error("configured bootstrap Pages provider unavailable");
      return response.body;
    };
    return inspectConfiguredBootstrapProvider(get(base), get(`${base}/pages`));
  };
  const before = provider();
  const observations: unknown[] = [];
  for (const route of routes) {
    check(deadline);
    const url = new URL(route, origin).href;
    const response = await (options.fetch ?? fetch)(url, {
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      headers: { Accept: "application/octet-stream", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(
        Math.max(1, Math.floor(Math.min(5000, deadline - performance.now()))),
      ),
    });
    await response.body?.cancel();
    check(deadline);
    if (response.url !== url || response.status !== 404)
      throw new Error("configured bootstrap public route is present, redirected or unavailable");
    observations.push({ url, status: response.status });
  }
  const after = provider();
  if (digest(before) !== digest(after))
    throw new Error("configured bootstrap provider changed during public bracket");
  return {
    before,
    public_routes: observations,
    after,
    scope:
      "fresh configured project Pages and fixed public routes only; owner user-site absence remains historical ratified evidence",
    authority: "none" as const,
  };
}
