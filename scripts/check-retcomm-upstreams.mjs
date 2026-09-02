import { readFile } from "node:fs/promises";
import { join } from "node:path";

const catalogPath = new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url);
const mappingPath = new URL("./retcomm-psx-upstreams.json", import.meta.url);
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const mappings = JSON.parse(await readFile(mappingPath, "utf8"));
const psxPorts = catalog.ports.filter(port => port.adapter === "psx-recomp-managed");
const failures = [];

const mappedPortIds = new Set(Object.keys(mappings));
for (const port of psxPorts) {
  if (!mappedPortIds.has(port.id)) {
    failures.push(`${port.id}: missing RetComM title mapping`);
  }
  if ((port.release.provider ?? "github") !== "github") {
    failures.push(`${port.id}: RetComM game upstream must resolve directly through GitHub`);
  }
  if (port.release.repository.toLowerCase() === "technicallycomputers/retcomm-launcher".toLowerCase()) {
    failures.push(`${port.id}: points at RetComM-Launcher instead of the game upstream`);
  }
}

for (const portId of mappedPortIds) {
  if (!psxPorts.some(port => port.id === portId)) {
    failures.push(`${portId}: stale mapping has no psx-recomp-managed catalog entry`);
  }
}

const localCatalogDir = process.env.RETCOMM_CATALOG_DIR;
const ref = process.env.RETCOMM_CATALOG_REF ?? "main";
const rawHeaders = { "User-Agent": "Portcove-RetComM-upstream-audit" };

async function loadRetcommTitle(titleId) {
  if (localCatalogDir) {
    return JSON.parse(await readFile(join(localCatalogDir, "titles", `${titleId}.json`), "utf8"));
  }

  const url = `https://raw.githubusercontent.com/TechnicallyComputers/retcomm-catalog/${encodeURIComponent(ref)}/titles/${titleId}.json`;
  const response = await fetch(url, { headers: rawHeaders });
  if (!response.ok) {
    throw new Error(`RetComM catalog returned ${response.status} for ${titleId}`);
  }
  return response.json();
}

await Promise.all(Object.entries(mappings).map(async ([portId, titleId]) => {
  const port = psxPorts.find(candidate => candidate.id === portId);
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
      failures.push(`${titleId}: RetComM release (${releaseRepository}) and build (${buildRepository}) repositories differ`);
    }
    if (port.release.repository !== releaseRepository) {
      failures.push(`${portId}: Portcove uses ${port.release.repository}, RetComM uses ${releaseRepository}`);
    }
  } catch (error) {
    failures.push(`${portId}: ${error.message}`);
  }
}));

if (failures.length) {
  console.error(failures.sort().join("\n"));
  process.exit(1);
}

const source = localCatalogDir ? localCatalogDir : `TechnicallyComputers/retcomm-catalog@${ref}`;
console.log(`Verified ${psxPorts.length} direct PS1 game upstreams against ${source}; RetComM-Launcher is not a runtime source.`);
