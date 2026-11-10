export const semanticSourceBlobLimit = 16 * 1024 * 1024;
export const largeQualificationEvidence = Object.freeze({
  oid: "449f7e6a4361fadea0d092f3e42fb12128b0d17b",
  bytes: 21_245_243,
  path: "docs/qualification/non-switch-ecosystem-reconciliation-2026-10-25.json",
});
/** One retained qualification record exceeds the ordinary per-blob limit. Its
 * exact Git identity and length keep the exception inside the same total cap. */
export function semanticSourceBlobFits(oid: string, size: number, allowPinnedEvidence: boolean) {
  return (
    size <= semanticSourceBlobLimit ||
    (allowPinnedEvidence &&
      oid === largeQualificationEvidence.oid &&
      size === largeQualificationEvidence.bytes)
  );
}
