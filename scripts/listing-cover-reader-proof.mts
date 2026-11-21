import { createHash } from "node:crypto";
import { artworkCheckpointTarget } from "./listing-artwork-checkpoint.mts";
import { compactListingDeliveryTarget } from "./listing-directory-carrier.mts";
import { isRecord } from "./runtime-values.mts";

const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");

export function requireExactReleasedCoverInspection(
  inspection: unknown,
  cover: Buffer,
  compactWire: Buffer,
) {
  if (
    !isRecord(inspection) ||
    inspection.ok !== true ||
    inspection.error !== null ||
    inspection.command !== "catalog.inspect-definition-publication" ||
    !isRecord(inspection.data) ||
    inspection.data.publication_schema !== 2 ||
    inspection.data.authority !== "none" ||
    !isRecord(inspection.data.listings) ||
    inspection.data.listings.target !== compactListingDeliveryTarget ||
    inspection.data.listings.sha256 !== hash(compactWire) ||
    !Array.isArray(inspection.data.files)
  )
    throw new Error("Released reader did not verify the active compact listing");
  const entries = (inspection.data.files as unknown[]).filter(
    (row) => isRecord(row) && row.target === artworkCheckpointTarget,
  );
  if (
    entries.length !== 1 ||
    !isRecord(entries[0]) ||
    entries[0].bytes !== cover.length ||
    entries[0].sha256 !== hash(cover)
  )
    throw new Error(
      "Released reader did not verify the exact cover checkpoint in the prepared bundle",
    );
}
