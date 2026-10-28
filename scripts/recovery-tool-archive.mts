import { gunzipSync } from "node:zlib";

/** Narrow USTAR bootstrap reader. Bound decompression before inspecting raw
 * records; no tar library can buffer PAX/long-name/link extensions first. */
export function inspectRecoveryToolTar(archive: Buffer, kind: "aqua" | "age" | "gh") {
  if (!archive.length || archive.length > 32 * 1024 ** 2)
    throw new Error("recovery tool compressed limit");
  const bytes = gunzipSync(archive, { maxOutputLength: 128 * 1024 ** 2 });
  if (bytes.length % 512 !== 0) throw new Error("recovery tar block alignment");
  const files = new Map<string, Buffer>();
  const names = new Set<string>();
  const octal = (field: Buffer) => {
    const text = field.toString("ascii").replace(/\0.*$/u, "").trim();
    if (!/^[0-7]+$/u.test(text)) throw new Error("recovery tar numeric field");
    const value = Number.parseInt(text, 8);
    if (!Number.isSafeInteger(value)) throw new Error("recovery tar numeric bound");
    return value;
  };
  const string = (field: Buffer) => {
    const end = field.indexOf(0);
    const raw = end < 0 ? field : field.subarray(0, end);
    if (raw.some((byte) => byte < 32 || byte > 126)) throw new Error("recovery tar name encoding");
    return raw.toString("ascii");
  };
  let offset = 0;
  for (let count = 0; offset < bytes.length; count++) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (bytes.length - offset < 1024 || bytes.subarray(offset).some((byte) => byte !== 0))
        throw new Error("recovery tar termination");
      for (const required of kind === "aqua"
        ? ["aqua", "LICENSE", "README.md"]
        : kind === "age"
          ? ["age/age", "age/age-keygen"]
          : ["gh_2.102.0_linux_amd64/bin/gh"])
        if (!files.has(required)) throw new Error("recovery tar missing tool");
      return files;
    }
    if (count >= 2048) throw new Error("recovery tar record bound");
    const sum = header.reduce(
      (total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (sum !== octal(header.subarray(148, 156))) throw new Error("recovery tar checksum");
    const type = header[156];
    // Refuse extensions before interpreting their declared payload.
    if (![0, 48, 53].includes(type!)) throw new Error("recovery tar extension or link");
    if (!["ustar", "ustar "].includes(string(header.subarray(257, 263))))
      throw new Error("recovery tar format");
    const prefix = string(header.subarray(345, 500));
    const name = `${prefix ? `${prefix}/` : ""}${string(header.subarray(0, 100))}`;
    const normalized = name.replace(/\/$/u, "");
    if (
      !normalized ||
      name.length > 256 ||
      normalized
        .split("/")
        .some(
          (part) =>
            !part || part === "." || part === ".." || part.includes("\\") || part.includes(":"),
        ) ||
      names.has(normalized)
    )
      throw new Error("recovery tar path or alias");
    names.add(normalized);
    const allowed =
      kind === "aqua"
        ? ["aqua", "LICENSE", "README.md", "third_party_licenses"].includes(normalized) ||
          normalized.startsWith("third_party_licenses/")
        : kind === "age"
          ? [
              "age",
              "age/age",
              "age/age-keygen",
              "age/LICENSE",
              "age/age-inspect",
              "age/age-plugin-batchpass",
              "age/age-plugin-pq",
              "age/age-plugin-tag",
              "age/age-plugin-tagpq",
            ].includes(normalized)
          : normalized === "gh_2.102.0_linux_amd64" ||
            normalized.startsWith("gh_2.102.0_linux_amd64/");
    if (!allowed) throw new Error(`recovery tar unappointed member: ${normalized}`);
    const size = octal(header.subarray(124, 136));
    if ((type === 53 && size !== 0) || size > 64 * 1024 ** 2 || offset + 512 + size > bytes.length)
      throw new Error("recovery tar declared limit");
    if (type !== 53) files.set(normalized, bytes.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("recovery tar missing terminator");
}
