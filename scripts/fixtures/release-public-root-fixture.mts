import { releaseCanonicalDigest } from "../release-canonical.mts";
const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
// Inert public envelopes for structural input validation only. These zero
// signatures do not establish Tough acceptance or production key authority.
export function profiledRoot(rootCount: 1 | 3) {
  const entries = Array.from({ length: rootCount + 3 }, (_, i) => {
    const key = {
      keytype: "ed25519",
      scheme: "ed25519",
      keyval: { public: (i + 1).toString(16).padStart(2, "0").repeat(32) },
    };
    return [releaseCanonicalDigest(key), key] as const;
  });
  const threshold = rootCount === 1 ? 1 : 2;
  return json({
    signatures: entries.slice(0, threshold).map(([keyid]) => ({ keyid, sig: "00".repeat(64) })),
    signed: {
      _type: "root",
      spec_version: "1.0.0",
      version: 1,
      consistent_snapshot: true,
      expires: "2030-01-01T00:00:00Z",
      keys: Object.fromEntries(entries),
      roles: {
        root: { keyids: entries.slice(0, rootCount).map(([id]) => id), threshold },
        ...Object.fromEntries(
          ["targets", "snapshot", "timestamp"].map((name, i) => [
            name,
            { keyids: [entries[rootCount + i]![0]], threshold: 1 },
          ]),
        ),
      },
    },
  });
}
