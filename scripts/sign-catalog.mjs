// Explicit offline publisher utility. Key custody and delivery infrastructure are external.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  catalog: { type: "string" }, key: { type: "string" }, output: { type: "string" },
  sequence: { type: "string" }, "issued-at": { type: "string" }, "expires-at": { type: "string" },
} });
for (const name of ["catalog", "key", "output", "sequence", "expires-at"]) {
  if (!values[name]) throw new Error(`--${name} is required`);
}
function readRegular(path, limit) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.size > limit) throw new Error("Input must be a bounded regular file");
  const file = openSync(path, "r");
  try {
    if (!fstatSync(file).isFile()) throw new Error("Input must remain a regular file");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const count = readSync(file, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > limit) throw new Error("Input grew past the size limit");
    return buffer.subarray(0, length);
  } finally { closeSync(file); }
}
const sequence = Number(values.sequence);
const issuedAt = values["issued-at"] === undefined ? Math.floor(Date.now() / 1000) : Number(values["issued-at"]);
const expiresAt = Number(values["expires-at"]);
if (!Number.isSafeInteger(sequence) || sequence < 1 || !Number.isSafeInteger(issuedAt) || issuedAt < 0
    || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > 366 * 86400) {
  throw new Error("Use a positive safe integer sequence and Unix-second validity of at most 366 days");
}
const privateKey = createPrivateKey(readRegular(values.key, 64 * 1024));
if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("An Ed25519 private key is required");
const jwk = createPublicKey(privateKey).export({ format: "jwk" });
const publicKey = Buffer.from(jwk.x, "base64url");
const keyId = createHash("sha256").update(publicKey).digest("hex");
const catalog = JSON.parse(readRegular(values.catalog, 4 * 1024 * 1024));
const payload = JSON.stringify({ sequence, issued_at: issuedAt, expires_at: expiresAt, catalog });
const message = Buffer.concat([Buffer.from("Portcove signed catalog v1\n"), Buffer.from(keyId), Buffer.from("\n"), Buffer.from(payload)]);
const envelope = JSON.stringify({ format_version: 1, key_id: keyId, payload, signature: sign(null, message, privateKey).toString("hex") });
if (Buffer.byteLength(envelope) > 4 * 1024 * 1024) throw new Error("Signed envelope exceeds 4 MiB");
writeFileSync(values.output, envelope, { flag: "wx" });
process.stdout.write(`${JSON.stringify({ public_key: publicKey.toString("hex"), key_id: keyId, sequence, output: values.output })}\n`);
