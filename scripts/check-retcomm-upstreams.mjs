import { readFile } from "node:fs/promises";
import { join } from "node:path";

const catalogPath = new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url);
const mappingPath = new URL("./retcomm-psx-upstreams.json", import.meta.url);
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const mappings = JSON.parse(await readFile(mappingPath, "utf8"));
const psxPorts = catalog.ports.filter((port) => port.adapter === "psx-recomp-managed");
const failures = [];
const offline = process.argv.includes("--offline");

const mappedPortIds = new Set(Object.keys(mappings));
const outsideRetcomm = [];
const retcommRepositories = new Set([
  "technicallycomputers/retcomm-launcher",
  "technicallycomputers/retcomm-catalog",
  ...psxPorts
    .filter((port) => mappedPortIds.has(port.id))
    .map((port) => port.release?.repository)
    .filter((repository) => typeof repository === "string")
    .map((repository) => repository.toLowerCase()),
]);

function githubIdentity(value, asset = false) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").slice(1);
    if (parts.at(-1) === "") parts.pop();
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !parts.slice(0, 2).every((part) => /^[A-Za-z0-9_.-]+$/u.test(part)) ||
      parts.length < 2 ||
      parts.slice(0, 2).some((part) => part === "." || part === ".." || /\.git$/iu.test(part)) ||
      (asset
        ? parts.length !== 6 || parts[2] !== "releases" || parts[3] !== "download"
        : parts.length !== 2)
    )
      return null;
    return parts.slice(0, 2).join("/").toLowerCase();
  } catch {
    return null;
  }
}

function independentDirectIdentity(port) {
  const project = githubIdentity(port.project_url);
  const direct = port.release.direct;
  if (
    !project ||
    retcommRepositories.has(project) ||
    port.release.repository !== undefined ||
    !Array.isArray(port.platforms) ||
    port.platforms.length === 0 ||
    new Set(port.platforms).size !== port.platforms.length ||
    !direct ||
    typeof direct !== "object" ||
    Array.isArray(direct) ||
    Object.keys(direct).length !== port.platforms.length
  )
    return null;
  const artifacts = [];
  for (const platform of port.platforms) {
    const artifact = direct[platform];
    const repository = githubIdentity(artifact?.url, true);
    if (
      !repository ||
      retcommRepositories.has(repository) ||
      typeof artifact.version !== "string" ||
      !artifact.version.trim() ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size <= 0 ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256 ?? "")
    )
      return null;
    artifacts.push({ platform, ...artifact });
  }
  return { port_id: port.id, project_url: port.project_url, artifacts };
}
for (const port of psxPorts) {
  if (!mappedPortIds.has(port.id)) {
    if (port.release?.provider === "direct-manifest") {
      const identity = independentDirectIdentity(port);
      if (identity) outsideRetcomm.push(identity);
      else failures.push(`${port.id}: ambiguous independent direct-manifest identity`);
      continue;
    }
    failures.push(`${port.id}: missing RetComM title mapping`);
  }
  if ((port.release.provider ?? "github") !== "github") {
    failures.push(`${port.id}: RetComM game upstream must resolve directly through GitHub`);
  }
  if (typeof port.release.repository !== "string" || !port.release.repository.trim()) {
    failures.push(`${port.id}: missing GitHub game repository identity`);
  } else if (port.release.repository.toLowerCase() === "technicallycomputers/retcomm-launcher") {
    failures.push(`${port.id}: points at RetComM-Launcher instead of the game upstream`);
  }
}

for (const portId of mappedPortIds) {
  if (!psxPorts.some((port) => port.id === portId)) {
    failures.push(`${portId}: stale mapping has no psx-recomp-managed catalog entry`);
  }
}

const localCatalogDir = process.env.RETCOMM_CATALOG_DIR;
const ref = process.env.RETCOMM_CATALOG_REF ?? "main";
const rawHeaders = { "User-Agent": "Portcove-RetComM-upstream-audit" };

async function loadRetcommTitle(titleId) {
  const relativeCandidates = [
    join("titles", "psx", `${titleId}.json`),
    join("titles", `${titleId}.json`),
  ];
  if (localCatalogDir) {
    for (const relative of relativeCandidates) {
      try {
        return JSON.parse(await readFile(join(localCatalogDir, relative), "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    throw new Error(`RetComM catalog has no PSX title manifest for ${titleId}`);
  }

  for (const relative of relativeCandidates) {
    const url = `https://raw.githubusercontent.com/TechnicallyComputers/retcomm-catalog/${encodeURIComponent(ref)}/${relative.replaceAll("\\", "/")}`;
    const response = await fetch(url, { headers: rawHeaders });
    if (response.ok) return response.json();
    if (response.status !== 404) {
      throw new Error(`RetComM catalog returned ${response.status} for ${titleId}`);
    }
  }
  throw new Error(`RetComM catalog returned 404 for ${titleId}`);
}

if (!offline) {
  await Promise.all(
    Object.entries(mappings).map(async ([portId, titleId]) => {
      const port = psxPorts.find((candidate) => candidate.id === portId);
      if (!port) return;

      try {
        const title = await loadRetcommTitle(titleId);
        const releaseRepository = title.release?.github;
        const buildRepository = title.build?.source?.github;
        if (!releaseRepository) {
          failures.push(`${titleId}: RetComM entry has no GitHub game release repository`);
          return;
        }
        if (buildRepository && buildRepository !== releaseRepository) {
          failures.push(
            `${titleId}: RetComM release (${releaseRepository}) and build (${buildRepository}) repositories differ`,
          );
        }
        if (port.release.repository !== releaseRepository) {
          failures.push(
            `${portId}: Portcove uses ${port.release.repository}, RetComM uses ${releaseRepository}`,
          );
        }
      } catch (error) {
        failures.push(`${portId}: ${error.message}`);
      }
    }),
  );
}

for (const identity of outsideRetcomm) {
  console.log(
    `RetComM audit NOT_APPLICABLE: ${JSON.stringify(identity)}; independent pinned artifacts, upstream health NOT_CHECKED. Catalog identity and exact-artifact acceptance own this route; this audit performs neither.`,
  );
}

if (failures.length) {
  console.error(failures.sort().join("\n"));
  process.exit(1);
}

if (offline) {
  console.log(
    `Verified ${psxPorts.length - outsideRetcomm.length} local PS1 mappings; live upstream checks were not run.`,
  );
} else {
  const source = localCatalogDir ? localCatalogDir : `TechnicallyComputers/retcomm-catalog@${ref}`;
  console.log(
    `Verified ${psxPorts.length - outsideRetcomm.length} direct PS1 game upstreams against ${source}; RetComM-Launcher is not a runtime source.`,
  );
}
