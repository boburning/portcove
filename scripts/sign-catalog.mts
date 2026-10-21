// Explicit offline publisher utility. Key custody and delivery infrastructure are external.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    help: { type: "boolean" },
    catalog: { type: "string" },
    key: { type: "string" },
    output: { type: "string" },
    sequence: { type: "string" },
    "issued-at": { type: "string" },
    "expires-at": { type: "string" },
  },
});
if (values.help) {
  process.stdout
    .write(`Usage: node scripts/sign-catalog.mts --catalog FILE --key FILE --sequence N --expires-at SECONDS --output FILE [--issued-at SECONDS]

Create a format-1 signed catalog envelope offline using an existing Ed25519 key.

Options:
  --catalog FILE        Catalog JSON in a regular file, at most 4194304 bytes (4 MiB).
  --key FILE            Ed25519 PKCS#8 PEM private key in a regular file, at most 65536 bytes (64 KiB).
  --sequence N          Positive safe integer, at most 9007199254740991.
  --expires-at SECONDS  Integer Unix seconds, later than issuance by at most 366 days.
  --output FILE         New envelope file to create; existing files are never overwritten.
  --issued-at SECONDS   Nonnegative integer Unix seconds; defaults to the current time.
  --help                Show this help without reading inputs or writing output.

The escaped envelope must also fit within 4194304 bytes (4 MiB).
Successful signing prints the existing public-key, key-ID, sequence and output JSON summary.

Example:
  node scripts/sign-catalog.mts --catalog catalog.json --key publisher-private.pem --sequence 1 --expires-at <unix-seconds> --output catalog-signed.json
`);
  process.exit(0);
}
const requiredArguments = ["catalog", "key", "output", "sequence", "expires-at"] as const;
function requireArguments(
  value: typeof values,
): asserts value is typeof values & Record<(typeof requiredArguments)[number], string> {
  for (const name of requiredArguments) {
    if (!value[name])
      throw new Error(`--${name} is required. Run with --help for usage and an example.`);
  }
}
requireArguments(values);
function readRegular(path: string, limit: number, option: "--key" | "--catalog") {
  const metadata = lstatSync(path);
  if (!metadata.isFile()) {
    const received = metadata.isSymbolicLink()
      ? "a symbolic link"
      : metadata.isDirectory()
        ? "a directory"
        : "a non-regular file";
    throw new Error(
      `${option} must name a regular file; received ${received}. Supply a regular file of at most ${limit} bytes.`,
    );
  }
  if (metadata.size > limit)
    throw new Error(
      `${option} exceeds the ${limit}-byte read limit: received ${metadata.size} bytes. Supply a smaller regular file.`,
    );
  const file = openSync(path, "r");
  try {
    if (!fstatSync(file).isFile())
      throw new Error(
        `${option} must remain a regular file when opened (limit ${limit} bytes). Select a stable regular file and try again.`,
      );
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const count = readSync(file, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > limit)
      throw new Error(
        `${option} exceeded the ${limit}-byte read limit while being read: read at least ${length} bytes. Retry with a stable file within the limit.`,
      );
    return buffer.subarray(0, length);
  } finally {
    closeSync(file);
  }
}
const sequence = Number(values.sequence);
const issuedAt =
  values["issued-at"] === undefined ? Math.floor(Date.now() / 1000) : Number(values["issued-at"]);
const expiresAt = Number(values["expires-at"]);
if (!Number.isSafeInteger(sequence) || sequence < 1) {
  throw new Error(
    `--sequence must be a positive safe integer from 1 to 9007199254740991; received ${JSON.stringify(values.sequence)}.`,
  );
}
if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
  throw new Error(
    `--issued-at must be a nonnegative safe integer in Unix seconds; received ${JSON.stringify(values["issued-at"])}.`,
  );
}
if (!Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) {
  throw new Error(
    `--expires-at must be a safe integer in Unix seconds greater than --issued-at (${issuedAt}); received ${JSON.stringify(values["expires-at"])}.`,
  );
}
if (expiresAt - issuedAt > 366 * 86400) {
  throw new Error(
    `Catalog validity must be at most 366 days (31622400 seconds); received ${expiresAt - issuedAt} seconds. Choose --issued-at and --expires-at within that interval.`,
  );
}
const privateKey = createPrivateKey(readRegular(values.key, 64 * 1024, "--key"));
if (privateKey.asymmetricKeyType !== "ed25519")
  throw new Error(
    `--key must contain an Ed25519 private key; received ${privateKey.asymmetricKeyType ?? "an unknown key algorithm"}. Supply an Ed25519 PKCS#8 PEM key.`,
  );
const jwk = createPublicKey(privateKey).export({ format: "jwk" });
if (typeof jwk.x !== "string") throw new Error("Ed25519 public key must contain its encoded point");
const publicKey = Buffer.from(jwk.x, "base64url");
const keyId = createHash("sha256").update(publicKey).digest("hex");
const catalog: unknown = JSON.parse(
  readRegular(values.catalog, 4 * 1024 * 1024, "--catalog").toString("utf8"),
);
const payload = JSON.stringify({
  sequence,
  issued_at: issuedAt,
  expires_at: expiresAt,
  catalog,
});
const message = Buffer.concat([
  Buffer.from("Portcove signed catalog v1\n"),
  Buffer.from(keyId),
  Buffer.from("\n"),
  Buffer.from(payload),
]);
const envelope = JSON.stringify({
  format_version: 1,
  key_id: keyId,
  payload,
  signature: sign(null, message, privateKey).toString("hex"),
});
const envelopeBytes = Buffer.byteLength(envelope);
if (envelopeBytes > 4 * 1024 * 1024)
  throw new Error(
    `Signed envelope exceeds the 4194304-byte (4 MiB) limit: received ${envelopeBytes} bytes after JSON escaping. Reduce the catalog size.`,
  );
writeFileSync(values.output, envelope, { flag: "wx" });
process.stdout.write(
  `${JSON.stringify({ public_key: publicKey.toString("hex"), key_id: keyId, sequence, output: values.output })}\n`,
);
