/** Read-only public pages from existing public catalog projections. Nothing in
 * this module admits a definition, selects a package or asserts publication. */
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { listingDirectoryTextMaximum } from "./listing-directory-carrier.mts";

// Inputs include the canonical listing directory, so they share its text bound.
const maximumInput = listingDirectoryTextMaximum;
const maximumOutput = 64 * 1024 ** 2;
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const text = (value: unknown, fallback = "Not specified") =>
  typeof value === "string" && value.trim() && value.length <= 16384 ? value : fallback;
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.length <= 16384)
        .slice(0, 128)
    : [];
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
export const escapePublicHtml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}
function link(url: unknown, label: string) {
  const safe = safeUrl(url);
  return safe
    ? `<a href="${escapePublicHtml(safe)}" rel="noreferrer">${escapePublicHtml(label)}</a>`
    : escapePublicHtml(label);
}
function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord).slice(0, 128) : [];
}
function guideEntries(value: unknown) {
  return rows(value).map((step) => ({
    title: text(step.title),
    instruction: text(step.instruction),
  }));
}
function parse(bytes: Buffer): Record<string, unknown> {
  if (bytes.length > maximumInput || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes))
    throw new Error("public catalog input exceeds UTF-8 byte bound");
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isRecord(value)) throw new Error("public catalog input must be an object");
  return value;
}
export interface PublicCatalogEntry {
  id: string;
  name: string;
  summary: string;
  game_id: string | null;
  game_title: string;
  page: string;
  platforms: string[];
  methods: { kind: string; evidence_urls: string[]; note?: string }[];
  dependencies: {
    kind: string;
    name: string;
    project_url?: string | undefined;
    confidence: string;
    evidence_urls: string[];
    version_scope?: string;
    note?: string;
  }[];
  editions: { title: string; system: string; evidence_urls: string[] }[];
  project_url?: string | undefined;
  release_url?: string | undefined;
  setup_url?: string | undefined;
  availability: string;
  download_block_reason?: string;
  setup: { title: string; instruction: string }[];
  setup_notes?: { title: string; instruction: string }[];
  limitations: string[];
  declared_platforms: string[];
  installation_method?: string;
  original_requirements: string[];
  qualification: string[];
  identity_evidence: string[];
}
export interface PublicCatalogProjection {
  format_version: 1;
  scope: "development";
  source_revision: string;
  source_url: string;
  observed_at: string;
  listings_sha256: string;
  catalog_sha256: string;
  entries: PublicCatalogEntry[];
}

async function publicCatalogInputs(listingsSha: string, catalogSha: string) {
  const files = await Promise.all(
    ["public-catalog.mts", "public-catalog/catalog.css", "public-catalog/search.ts"].map(
      async (name) => ({
        name,
        sha256: digest(
          await readControllerToolFile(
            fileURLToPath(new URL(`./${name}`, import.meta.url)),
            128 * 1024,
          ),
        ),
      }),
    ),
  );
  return {
    format_version: 1,
    listings_sha256: listingsSha,
    catalog_sha256: catalogSha,
    renderer_sha256: digest(
      JSON.stringify({
        files,
        javascript_emitter: { kind: "node-strip-types", version: process.versions.node },
      }),
    ),
  };
}

/** No provider reads: the current source and renderer must match the retained
 * input identity. A missing legacy browse result requests a fresh generation. */
export async function publicCatalogUnchanged(
  listings: Buffer,
  catalog: Buffer,
  previous: string | null,
) {
  if (!previous) return false;
  const expected = await publicCatalogInputs(digest(listings), digest(catalog));
  let bytes: Buffer;
  try {
    bytes = await readControllerToolFile(path.join(previous, "inputs.json"), 8192);
  } catch {
    return false;
  }
  try {
    return JSON.stringify(JSON.parse(bytes.toString("utf8"))) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

export async function retainPublicCatalogCapture(
  projection: PublicCatalogProjection,
  previous: string | null,
) {
  if (!previous) return projection;
  try {
    const expected = await publicCatalogInputs(
      projection.listings_sha256,
      projection.catalog_sha256,
    );
    const identity: unknown = JSON.parse(
      (await readControllerToolFile(path.join(previous, "inputs.json"), 8192)).toString("utf8"),
    );
    if (JSON.stringify(identity) !== JSON.stringify(expected)) return projection;
    const capture = parse(
      await readControllerToolFile(path.join(previous, "projection.json"), maximumInput),
    );
    if (
      capture.scope !== "development" ||
      capture.listings_sha256 !== projection.listings_sha256 ||
      capture.catalog_sha256 !== projection.catalog_sha256 ||
      typeof capture.source_revision !== "string" ||
      !/^[a-f0-9]{40}$/u.test(capture.source_revision) ||
      typeof capture.observed_at !== "string" ||
      !Number.isFinite(Date.parse(capture.observed_at))
    )
      return projection;
    // Re-render current validated data with the original capture provenance.
    // No previous HTML, script or arbitrary projection field is copied.
    return {
      ...projection,
      source_revision: capture.source_revision,
      source_url: `https://github.com/boburning/portcove/tree/${capture.source_revision}`,
      observed_at: new Date(capture.observed_at).toISOString(),
    };
  } catch {
    return projection;
  }
}

/** Explicit allowlist excludes artwork, paths, source profiles, credentials,
 * private maintenance rows, arbitrary upstream fields and publication claims. */
export function projectPublicCatalog(request: {
  listings: Buffer;
  catalog: Buffer;
  revision: string;
  observedAt: string;
}): PublicCatalogProjection {
  if (!/^[a-f0-9]{40}$/u.test(request.revision) || !Number.isFinite(Date.parse(request.observedAt)))
    throw new Error("public projection needs an exact revision and observation time");
  const listingsDocument = parse(request.listings);
  const catalog = parse(request.catalog);
  const directory = record(listingsDocument.directory);
  const listings = listingsDocument.listings ?? directory.listings;
  if (!Array.isArray(listings) || !Array.isArray(catalog.ports))
    throw new Error("public catalog document shape differs");
  const managed = new Map<string, Record<string, unknown>>();
  for (const port of catalog.ports)
    if (isRecord(port) && typeof port.id === "string") {
      if (managed.has(port.id)) throw new Error("duplicate operational public identity");
      managed.set(port.id, port);
    }
  const seen = new Set<string>();
  const withdrawn = new Set(strings(listingsDocument.withdrawn_ids));
  const entries = listings
    .map((raw): PublicCatalogEntry => {
      if (
        !isRecord(raw) ||
        typeof raw.id !== "string" ||
        !idPattern.test(raw.id) ||
        raw.id.length > 128 ||
        seen.has(raw.id)
      )
        throw new Error("invalid or duplicate public listing identity");
      seen.add(raw.id);
      const port = managed.get(raw.id);
      const presentation = record(port?.presentation);
      const identity = record(raw.original_game);
      const validId = (value: unknown): value is string =>
        typeof value === "string" && value.length <= 128 && idPattern.test(value);
      const validEvidence = (value: unknown) =>
        Array.isArray(value) &&
        value.length > 0 &&
        value.length <= 32 &&
        value.every((url) => !!safeUrl(url));
      const validEditions =
        Array.isArray(identity.source_editions) &&
        identity.source_editions.length <= 128 &&
        identity.source_editions.every(
          (edition) =>
            isRecord(edition) &&
            validId(edition.id) &&
            typeof edition.title === "string" &&
            !!edition.title.trim() &&
            edition.title.length <= 16384 &&
            (edition.system === undefined || validId(edition.system)) &&
            validEvidence(edition.evidence_urls),
        );
      const gameId =
        identity.format_version === 1 &&
        validId(identity.id) &&
        validEvidence(identity.evidence_urls) &&
        validEditions
          ? identity.id
          : null;
      const implementation = record(raw.implementation);
      const compatibleImplementation =
        implementation.format_version === 1 &&
        Array.isArray(implementation.methods) &&
        implementation.methods.length <= 8 &&
        Array.isArray(implementation.dependencies) &&
        implementation.dependencies.length <= 16
          ? implementation
          : {};
      const guide = record(presentation.manual_setup ?? raw.manual_setup);
      return {
        id: raw.id,
        name: text(raw.name),
        summary: text(raw.summary),
        game_id: gameId,
        game_title: text(raw.original_game_title, text(raw.name)),
        page: gameId ? `games/${gameId}/index.html#${raw.id}` : `projects/${raw.id}/index.html`,
        platforms: strings(raw.platforms),
        methods: rows(compatibleImplementation.methods)
          .filter(
            (method) =>
              Array.isArray(method.evidence_urls) &&
              method.evidence_urls.length <= 8 &&
              validEvidence(method.evidence_urls),
          )
          .map((method) => ({
            kind: text(method.kind, "unknown"),
            evidence_urls: strings(method.evidence_urls).filter((url) => !!safeUrl(url)),
            ...(typeof method.note === "string" ? { note: text(method.note) } : {}),
          })),
        dependencies: rows(compatibleImplementation.dependencies)
          .filter(
            (dependency) =>
              typeof dependency.kind === "string" &&
              ["toolchain", "runtime", "library", "source-preparation"].includes(dependency.kind) &&
              typeof dependency.confidence === "string" &&
              ["confirmed", "inferred", "contradicted"].includes(dependency.confidence) &&
              typeof dependency.name === "string" &&
              !!dependency.name.trim() &&
              dependency.name.length <= 128 &&
              !!safeUrl(dependency.project_url) &&
              validEvidence(dependency.evidence_urls),
          )
          .map((dependency) => ({
            kind: text(dependency.kind, "unknown"),
            name: text(dependency.name),
            project_url: safeUrl(dependency.project_url),
            confidence: text(dependency.confidence, "unknown"),
            evidence_urls: strings(dependency.evidence_urls).filter((url) => !!safeUrl(url)),
            ...(typeof dependency.version_scope === "string" &&
            dependency.version_scope.length <= 256
              ? { version_scope: dependency.version_scope }
              : {}),
            ...(typeof dependency.note === "string" && dependency.note.length <= 1024
              ? { note: dependency.note }
              : {}),
          })),
        editions: rows(gameId ? identity.source_editions : undefined).map((edition) => ({
          title: text(edition.title),
          system: text(edition.system),
          evidence_urls: strings(edition.evidence_urls).filter((url) => !!safeUrl(url)),
        })),
        project_url: safeUrl(raw.project_url),
        release_url: safeUrl(raw.release_url),
        setup_url: safeUrl(raw.setup_url),
        availability: text(raw.availability, "unknown"),
        ...(typeof raw.download_block_reason === "string"
          ? { download_block_reason: text(raw.download_block_reason) }
          : {}),
        setup: guideEntries(guide.steps),
        ...(Array.isArray(guide.references) && guide.references.length
          ? { setup_notes: guideEntries(guide.references) }
          : {}),
        limitations: strings(guide.warnings),
        declared_platforms: strings(port?.platforms),
        ...(typeof presentation.installation_method === "string"
          ? { installation_method: text(presentation.installation_method) }
          : {}),
        original_requirements: rows(presentation.source_requirements).map((requirement) =>
          text(requirement.label),
        ),
        qualification: [
          ...strings(port?.automated_tested_platforms).map(
            (platform) => `Automated checks declared: ${platform}`,
          ),
          ...strings(port?.manually_validated_platforms).map(
            (platform) => `Manual checks declared: ${platform}`,
          ),
        ],
        identity_evidence: gameId
          ? strings(identity.evidence_urls).filter((url) => !!safeUrl(url))
          : [],
      };
    })
    .filter((entry) => !withdrawn.has(entry.id))
    .sort((a, b) => a.id.localeCompare(b.id, "en"));
  return {
    format_version: 1,
    scope: "development",
    source_revision: request.revision,
    source_url: `https://github.com/boburning/portcove/tree/${request.revision}`,
    observed_at: new Date(request.observedAt).toISOString(),
    listings_sha256: digest(request.listings),
    catalog_sha256: digest(request.catalog),
    entries,
  };
}

const methodNames: Record<string, string> = {
  "static-recompilation": "Static recompilation",
  "matching-decompilation": "Matching decompilation",
  "non-matching-decompilation": "Non-matching decompilation",
  "source-port": "Source port",
  "engine-reimplementation": "Engine reimplementation",
  other: "Other method",
};
const methodName = (kind: string) => methodNames[kind] ?? "Method not recognized";
const list = (items: string[]) =>
  items.length
    ? `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`
    : "<p>Not specified. Check the project’s instructions.</p>";
const safeList = (items: string[]) => list(items.map(escapePublicHtml));
function evidence(urls: string[]) {
  return urls.length
    ? list(urls.map((url, index) => link(url, `Source ${index + 1}`)))
    : "<p>No source recorded.</p>";
}

function shell(title: string, body: string, projection: PublicCatalogProjection, prefix: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light"><title>${escapePublicHtml(title)} · Portcove</title><link rel="stylesheet" href="${prefix}catalog.css"></head><body><a class="skip" href="#main">Skip to content</a><header><a class="brand" href="${prefix}index.html">Portcove</a><nav aria-label="Primary"><a href="${prefix}index.html">Explore games</a><a href="https://github.com/boburning/portcove">About Portcove</a></nav></header><main id="main"><p class="notice"><strong>Development catalog.</strong> These pages describe repository data. Published delivery has not been checked; installation and gameplay availability must be checked in the app.</p>${body}</main><footer><p>Catalog captured <time datetime="${escapePublicHtml(projection.observed_at)}">${escapePublicHtml(projection.observed_at)}</time> · ${link(projection.source_url, `Source ${projection.source_revision.slice(0, 12)}`)}</p><p>Optional descriptions can be dated or incomplete. This site works without live GitHub requests and does not select, install or update games.</p><details><summary>Input identities</summary><dl><dt>Listings SHA-256</dt><dd><code>${projection.listings_sha256}</code></dd><dt>Catalog SHA-256</dt><dd><code>${projection.catalog_sha256}</code></dd></dl></details></footer></body></html>`;
}
function implementation(entry: PublicCatalogEntry) {
  const notes = entry.setup_notes?.length
    ? `<details><summary>Setup notes</summary><dl>${entry.setup_notes.map((note) => `<dt>${escapePublicHtml(note.title)}</dt><dd>${escapePublicHtml(note.instruction)}</dd>`).join("")}</dl></details>`
    : "";
  return `<article id="${entry.id}"><h2>${escapePublicHtml(entry.name)}</h2><p>${escapePublicHtml(entry.summary)}</p><dl><dt>Original game files</dt><dd>${safeList(entry.original_requirements)}${entry.editions.length ? `<p>Reviewed source editions:</p>${safeList(entry.editions.map((edition) => `${edition.title} · ${edition.system}`))}` : "<p>Source edition identity has not been reviewed.</p>"}</dd><dt>Target platforms reported upstream</dt><dd>${safeList(entry.platforms)}</dd><dt>Implementation method</dt><dd>${entry.methods.length ? list(entry.methods.map((method) => `${escapePublicHtml(methodName(method.kind))}${method.note ? ` — ${escapePublicHtml(method.note)}` : ""}${evidence(method.evidence_urls)}`)) : "<p>Not recorded.</p>"}</dd><dt>Portcove integration in development</dt><dd>${entry.declared_platforms.length ? `<p>${escapePublicHtml(entry.installation_method ?? "Declared integration")}</p>${safeList(entry.declared_platforms)}` : "<p>Descriptive listing only. No managed definition in this input.</p>"}</dd><dt>Published delivery</dt><dd>Not checked. A repository definition does not establish an available published route.</dd><dt>Upstream availability claim</dt><dd>${escapePublicHtml(entry.availability)}${entry.download_block_reason ? `<p>${escapePublicHtml(entry.download_block_reason)}</p>` : ""}<p>A release may contain research reports rather than a playable package.</p></dd></dl><h3>Setup</h3>${entry.setup.length ? `<ol>${entry.setup.map((step) => `<li><strong>${escapePublicHtml(step.title)}</strong><p>${escapePublicHtml(step.instruction)}</p></li>`).join("")}</ol>` : "<p>Follow the project’s setup instructions.</p>"}${notes}<h3>Limitations and evidence</h3>${safeList(entry.limitations)}${safeList(entry.qualification)}<p>Check declarations describe their original scope; they do not establish current gameplay, save compatibility or a different platform.</p>${entry.dependencies.length ? `<h3>Shared tools and runtimes</h3>${list(entry.dependencies.map((dependency) => `${link(dependency.project_url, dependency.name)} · ${escapePublicHtml(dependency.kind)} · ${escapePublicHtml(dependency.confidence)}${dependency.version_scope ? `<p>Applies to: ${escapePublicHtml(dependency.version_scope)}</p>` : ""}${dependency.note ? `<p>${escapePublicHtml(dependency.note)}</p>` : ""}${evidence(dependency.evidence_urls)}`))}` : ""}<p class="links">${link(entry.project_url, "Project")}${entry.setup_url ? ` · ${link(entry.setup_url, "Setup instructions")}` : ""}${entry.release_url ? ` · ${link(entry.release_url, "Upstream releases")}` : ""}</p><details><summary>Game identity sources</summary>${evidence(entry.identity_evidence)}${entry.editions.map((edition) => `<p>${escapePublicHtml(edition.title)}</p>${evidence(edition.evidence_urls)}`).join("")}</details></article>`;
}
function comparison(entries: PublicCatalogEntry[]) {
  if (entries.length < 2) return "";
  const columns = [
    "Implementation",
    "Original files",
    "Target platforms",
    "Method",
    "Development route",
  ];
  return `<div class="comparison" tabindex="0" role="region" aria-labelledby="comparison-caption"><table><caption id="comparison-caption">Compare implementations</caption><thead><tr>${columns.map((column) => `<th scope="col">${column}</th>`).join("")}</tr></thead><tbody>${entries.map((entry) => `<tr><th scope="row"><a href="#${entry.id}">${escapePublicHtml(entry.name)}</a></th><td>${escapePublicHtml(entry.editions.map((edition) => edition.title).join("; ") || "Check source requirements below")}</td><td>${escapePublicHtml(entry.platforms.join(", ") || "Not specified")}</td><td>${escapePublicHtml(entry.methods.map((method) => methodName(method.kind)).join(" + ") || "Not recorded")}</td><td>${escapePublicHtml(entry.installation_method ?? "Project instructions")}</td></tr>`).join("")}</tbody></table></div><p>No personal recommendation is made. Compare your source edition, target platform and setup requirements below.</p>`;
}

/** All emitted paths are generated from validated stable IDs. HTML uses escaped
 * text; the browser loads one allowlisted compact index and never upstream HTML. */
export async function publicCatalogFiles(
  projection: PublicCatalogProjection,
): Promise<Map<string, Buffer>> {
  if (
    projection.scope !== "development" ||
    projection.entries.some(
      (entry) =>
        !idPattern.test(entry.id) ||
        entry.id.length > 128 ||
        (entry.game_id !== null && (!idPattern.test(entry.game_id) || entry.game_id.length > 128)),
    )
  )
    throw new Error("public page projection identity or scope differs");
  const files = new Map<string, Buffer>();
  const put = (name: string, value: string | Buffer) => files.set(name, Buffer.from(value));
  const groups = new Map<string, PublicCatalogEntry[]>();
  for (const entry of projection.entries) {
    const key = entry.game_id ? `games/${entry.game_id}` : `projects/${entry.id}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const items = [...groups].sort(([, a], [, b]) =>
    a[0]!.game_title.localeCompare(b[0]!.game_title, "en"),
  );
  const index = items.map(([key, entries]) => ({
    title: entries[0]!.game_title,
    url: `${key}/index.html`,
    reviewed_game: !!entries[0]!.game_id,
    projects: entries.map((entry) => ({
      name: entry.name,
      platforms: entry.platforms,
      methods: entry.methods.map((method) => methodName(method.kind)),
    })),
  }));
  const indexBytes = JSON.stringify(index);
  if (Buffer.byteLength(indexBytes) > 4 * 1024 ** 2)
    throw new Error("public search index exceeds bound");
  put("search-index.json", indexBytes);
  put(
    "index.html",
    shell(
      "Explore native game projects",
      `<h1>Find a game.<br>Compare the ways to play.</h1><p class="intro">Browse game projects, check the original files you need, and follow the right setup instructions for your device.</p><form id="filters" role="search"><div><label for="query">Search games or projects</label><input id="query" type="search" name="q" maxlength="256"></div><div><label for="platform">Target platform</label><select id="platform" name="platform"><option value="">All platforms</option>${[
        ...new Set(projection.entries.flatMap((entry) => entry.platforms)),
      ]
        .sort()
        .map((value) => `<option>${escapePublicHtml(value)}</option>`)
        .join(
          "",
        )}</select></div><div><label for="method">Implementation method</label><select id="method" name="method"><option value="">All methods</option>${[
        ...new Set(
          projection.entries.flatMap((entry) =>
            entry.methods.map((method) => methodName(method.kind)),
          ),
        ),
      ]
        .sort()
        .map((value) => `<option>${escapePublicHtml(value)}</option>`)
        .join(
          "",
        )}</select></div><button type="reset">Clear filters</button></form><p id="result-status" role="status">${items.length} game groups and ungrouped projects</p><p id="search-error" hidden>Search could not load. Browse all entries below or reload to try again.</p><ul id="results" class="results">${index.map((item) => `<li><a href="${item.url}"><h2>${escapePublicHtml(item.title)}</h2><p>${escapePublicHtml(item.projects.map((project) => project.name).join(" · "))}</p></a><p>${item.reviewed_game ? `${item.projects.length} implementation${item.projects.length === 1 ? "" : "s"}` : "Game identity not reviewed · separate project"}</p></li>`).join("")}</ul><noscript><p>All entries are shown. Enable JavaScript to search or filter.</p></noscript><script type="module" src="search.js"></script>`,
      projection,
      "",
    ),
  );
  for (const [key, entries] of items)
    put(
      `${key}/index.html`,
      shell(
        entries[0]!.game_title,
        `<p><a href="../../index.html">All games and projects</a></p><h1>${escapePublicHtml(entries[0]!.game_title)}</h1>${entries[0]!.game_id ? `<p>${entries.length} implementation${entries.length === 1 ? "" : "s"} linked by reviewed game identity.</p>` : "<p>This project has no reviewed game identity. Similar names have not been grouped.</p>"}${comparison(entries)}${entries.map(implementation).join("")}`,
        projection,
        "../../",
      ),
    );
  put(
    "catalog.css",
    await readControllerToolFile(
      fileURLToPath(new URL("./public-catalog/catalog.css", import.meta.url)),
      128 * 1024,
    ),
  );
  const searchSource = await readControllerToolFile(
    fileURLToPath(new URL("./public-catalog/search.ts", import.meta.url)),
    128 * 1024,
  );
  put("search.js", stripTypeScriptTypes(searchSource.toString("utf8"), { mode: "strip" }));
  put("projection.json", JSON.stringify(projection));
  put(
    "inputs.json",
    JSON.stringify(
      await publicCatalogInputs(projection.listings_sha256, projection.catalog_sha256),
    ),
  );
  if (
    files.size > 6000 ||
    [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0) > maximumOutput
  )
    throw new Error("public catalog output exceeds publication bound");
  return files;
}
export async function writePublicCatalog(projection: PublicCatalogProjection, output: string) {
  const files = await publicCatalogFiles(projection);
  const staging = `${output}.staging-${process.pid}`;
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(staging, { recursive: false });
  try {
    for (const [name, bytes] of files) {
      await mkdir(path.dirname(path.join(staging, name)), { recursive: true });
      await writeFile(path.join(staging, name), bytes, { flag: "wx" });
    }
    await rename(staging, output);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    files: files.size,
    bytes: [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0),
    output,
    scope: projection.scope,
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "unchanged") {
    if (args.length !== 7)
      throw new Error(
        "usage: public-catalog.mts unchanged --listings PATH --catalog PATH --prior DIRECTORY_OR_NONE",
      );
    const options = Object.fromEntries([1, 3, 5].map((index) => [args[index]!, args[index + 1]!]));
    for (const key of ["--listings", "--catalog", "--prior"])
      if (!options[key]) throw new Error(`missing ${key}`);
    const [listings, catalog] = await Promise.all([
      readControllerToolFile(path.resolve(options["--listings"]!), maximumInput),
      readControllerToolFile(path.resolve(options["--catalog"]!), maximumInput),
    ]);
    console.log(
      await publicCatalogUnchanged(
        listings,
        catalog,
        options["--prior"] === "none" ? null : path.resolve(options["--prior"]!),
      ),
    );
  } else {
    if (
      ![10, 12].includes(args.length) ||
      args.some(
        (value, index) =>
          index % 2 === 0 &&
          ![
            "--listings",
            "--catalog",
            "--revision",
            "--observed-at",
            "--output",
            "--prior",
          ].includes(value),
      )
    )
      throw new Error(
        "usage: public-catalog.mts --listings PATH --catalog PATH --revision SHA --observed-at ISO --output NEW_DIRECTORY",
      );
    const options = Object.fromEntries(
      Array.from({ length: args.length / 2 }, (_, index) => [
        args[index * 2]!,
        args[index * 2 + 1]!,
      ]),
    );
    for (const name of ["--listings", "--catalog", "--revision", "--observed-at", "--output"])
      if (!options[name]) throw new Error(`missing ${name}`);
    const [listings, catalog] = await Promise.all([
      readControllerToolFile(path.resolve(options["--listings"]!), maximumInput),
      readControllerToolFile(path.resolve(options["--catalog"]!), maximumInput),
    ]);
    const projection = projectPublicCatalog({
      listings,
      catalog,
      revision: options["--revision"]!,
      observedAt: options["--observed-at"]!,
    });
    console.log(
      JSON.stringify(
        await writePublicCatalog(
          await retainPublicCatalogCapture(
            projection,
            options["--prior"] && options["--prior"] !== "none"
              ? path.resolve(options["--prior"])
              : null,
          ),
          path.resolve(options["--output"]!),
        ),
      ),
    );
  }
}
