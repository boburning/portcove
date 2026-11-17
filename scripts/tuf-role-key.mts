/** A TUF role private key from a GitHub secret: PKCS#8 PEM or exact base64 DER, at most 32 KiB. */
export function decodeTufRoleKey(raw: string): Buffer {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 32768 || !raw.length)
    throw new Error("bounded single TUF role key required");
  if (
    /^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PRIVATE KEY-----\r?\n?$/u.test(
      raw,
    )
  )
    return Buffer.from(raw);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(raw)) throw new Error("TUF role key encoding differs");
  const bytes = Buffer.from(raw, "base64");
  if (!bytes.length || bytes.toString("base64") !== raw)
    throw new Error("TUF role key encoding differs");
  return bytes;
}
