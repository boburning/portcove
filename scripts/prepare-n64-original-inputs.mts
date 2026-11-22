import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogSourceNames, readCatalogSource } from "./catalog-authoring.mts";
import { orderedJsonSha256 } from "./json-values.mts";
import { upstreamFacts } from "./maintenance-upstream.mts";
import { isRecord } from "./runtime-values.mts";

const [checkpointPath, portId, ...extra] = process.argv.slice(2);
if (!checkpointPath || !portId || extra.length) {
  throw new Error("Usage: node scripts/prepare-n64-original-inputs.mts CHECKPOINT PORT_ID");
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const catalogRoot = join(root, "crates", "portcove-core", "catalog");
const { catalog } = readCatalogSource(catalogRoot);
const checkpoint: unknown = JSON.parse(readFileSync(checkpointPath, "utf8"));
const current = upstreamFacts(checkpoint, catalog).facts.get("port:" + portId);
const sources: unknown[] =
  isRecord(current) && Array.isArray(current.sources) ? current.sources : [];
const amendments = sources.flatMap((entry) =>
  isRecord(entry) && isRecord(entry.n64_original_contract_amendment)
    ? [entry.n64_original_contract_amendment]
    : [],
);
if (amendments.length !== 1) {
  throw new Error("The current checkpoint does not supply one prepared N64 source amendment.");
}
const amendment = amendments[0]!;
const contract = catalog.source_catalog.contracts.find(({ id }) => id === amendment.contract_id);
const evidence = amendment.upstream_support_evidence;
const evidenceIds: unknown = contract?.evidence_ids;
if (
  !contract ||
  !Array.isArray(evidenceIds) ||
  !(evidenceIds as unknown[]).every((id) => typeof id === "string") ||
  !isRecord(evidence) ||
  typeof evidence.id !== "string"
) {
  throw new Error("The prepared N64 amendment has incomplete source authoring records.");
}
const existing = catalog.source_catalog.evidence.find(({ id }) => id === evidence.id);
if (existing && orderedJsonSha256(existing) !== orderedJsonSha256(evidence)) {
  throw new Error("The prepared N64 evidence identity already names a different review.");
}
process.stdout.write(
  JSON.stringify(
    {
      catalog_source: catalogSourceNames.shared,
      authoring_scope_sha256: amendment.authoring_scope_sha256,
      requires_reader: amendment.requires_reader,
      previous_contract_sha256: orderedJsonSha256(contract),
      source_contract: {
        ...contract,
        evidence_ids: [...new Set([...(evidenceIds as string[]), evidence.id])],
        n64_recomp_inputs_v1: amendment.n64_recomp_inputs_v1,
      },
      upstream_support_evidence: evidence,
      packages: amendment.packages,
    },
    null,
    2,
  ) + "\n",
);
