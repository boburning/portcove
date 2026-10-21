import { createHash } from "node:crypto";
import {
  requireFrozenSemanticInputs,
  requireFrozenSemanticProposalInputs,
} from "./release-semantic-inputs.mts";
import type {
  FrozenSemanticAcceptanceBundle,
  prepareFrozenSemanticProposalInputs,
  FrozenSemanticSnapshot,
} from "./release-semantic-inputs.mts";
import {
  createSemanticSnapshotReader,
  createSemanticSnapshotRpc,
} from "./release-semantic-reader-core.mts";
export { isSemanticReaderCall, semanticReaderServer } from "./release-semantic-reader-core.mts";
type Bundle = FrozenSemanticAcceptanceBundle;
export function createSemanticBundleReader(raw: Bundle) {
  return createSemanticSnapshotReader(requireFrozenSemanticInputs(raw));
}
export function createSemanticReaderRpc(raw: Bundle) {
  return createSemanticSnapshotRpc(requireFrozenSemanticInputs(raw));
}
/** Parent validates the existing builder brand before materializing one immutable
 * reader payload. Child hash validation supplies transport integrity only. */
export function materializeSemanticReaderIndex(raw: Bundle) {
  return materializeIndex(requireFrozenSemanticInputs(raw));
}

export function materializeSemanticProposalReaderIndex(
  raw: ReturnType<typeof prepareFrozenSemanticProposalInputs>,
) {
  return materializeIndex(requireFrozenSemanticProposalInputs(raw));
}

function materializeIndex(bundle: FrozenSemanticSnapshot) {
  const bytes = Buffer.from(
    JSON.stringify({
      manifest: bundle.manifest,
      bundle_sha256: bundle.bundle_sha256,
      files: bundle.files.map(({ name, bytes: data, sha256 }) => ({
        name,
        data: data.toString("base64"),
        sha256,
      })),
    }),
  );
  if (bytes.length > 288 * 1024 * 1024) throw new Error("reader materialization exceeds bound");
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}
