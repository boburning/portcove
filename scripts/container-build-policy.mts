// Per-format acceptance is separate from compilation and from native installation.
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
export const desktopFormats = Object.freeze(["appimage", "deb", "rpm"]);
export function assertPackageExecutable(format: string, listing: string) {
  const matches = listing
    .trim()
    .split(/\r?\n/u)
    .flatMap((line: string) => {
      if (format === "deb") {
        const match =
          /^(\S{10})\s+\S+\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.+)$/u.exec(line);
        if (!match && line.includes("usr/bin/portcove-desktop"))
          throw new Error("Unparsed package record at selected regular executable path");
        if (match && (match[1] === undefined || match[2] === undefined))
          throw new Error("Unparsed package record at selected regular executable path");
        const permissions = match?.[1] ?? "";
        const filename = match?.[2] ?? "";
        return match
          ? [
              {
                path:
                  permissions.charAt(0) === "l"
                    ? filename.split(" -> ")[0]
                    : permissions.charAt(0) === "h"
                      ? filename.split(" link to ")[0]
                      : filename,
                regular:
                  /^-[rwxstST-]{9}$/u.test(permissions) && /[xs]/u.test(permissions.charAt(3)),
              },
            ]
          : [];
      }
      if (format !== "rpm") throw new Error("Executable inspection requires deb or rpm");
      const fields = line.trim().split(/\s+/u);
      const mode = /^[0-7]+$/u.test(fields[4] ?? "") ? Number.parseInt(fields[4] ?? "", 8) : 0;
      return [
        { path: fields[0] ?? "", regular: (mode & 0o170000) === 0o100000 && (mode & 0o111) !== 0 },
      ];
    })
    .filter(
      (item) =>
        (item.path ?? "").replace(/^\.\//u, "").replace(/^\//u, "").replace(/\/+$/u, "") ===
        "usr/bin/portcove-desktop",
    );
  if (matches.length !== 1 || !matches[0]?.regular)
    throw new Error(`${format} lacks exactly one regular executable usr/bin/portcove-desktop`);
}
export function assertFreshBuildOutputs(root: string) {
  for (const relative of ["target", "work/target", "release-assets", "apps/desktop/dist"])
    if (existsSync(path.join(root, relative)))
      throw new Error(`Stale generated output refuses execution: ${relative}`);
}
export function builtPackage(
  directory: string,
  format: string,
  phase: { code: number | null; signal?: string | null },
) {
  if (!desktopFormats.includes(format)) throw new Error("Unknown desktop format");
  if (phase.code !== 0 || phase.signal)
    throw new Error(`${format} command failed; existing files are not success`);
  const suffix = format === "appimage" ? ".AppImage" : `.${format}`;
  const files = existsSync(directory)
    ? readdirSync(directory).filter((file: string) => file.endsWith(suffix))
    : [];
  if (files.length !== 1) throw new Error(`${format} requires exactly one newly produced package`);
  const selected = files[0];
  if (selected === undefined)
    throw new Error(`${format} requires exactly one newly produced package`);
  const file = path.join(directory, selected);
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())
    throw new Error("Package must be a regular file");
  const bytes = readFileSync(file);
  const signature =
    format === "appimage"
      ? Buffer.from([0x7f, 0x45, 0x4c, 0x46])
      : format === "deb"
        ? Buffer.from("!<arch>\n")
        : Buffer.from([0xed, 0xab, 0xee, 0xdb]);
  if (bytes.length <= signature.length || !bytes.subarray(0, signature.length).equals(signature))
    throw new Error(`${format} package signature differs`);
  return file;
}
export function validatePackageMetadata(format: string, metadata: string, version: string) {
  const values = metadata.trim().split(/\r?\n/u);
  if (format === "deb") {
    if (
      values.length !== 3 ||
      values[0]?.toLowerCase() !== "portcove" ||
      values[1] !== version ||
      values[2] !== "amd64"
    )
      throw new Error("deb package identity differs from selected source");
  } else if (format === "rpm") {
    // Pinned Tauri 2.12.2 preserves the complete version; this source uses default Release 1.
    if (
      values.length !== 4 ||
      values[0] !== "portcove" ||
      values[1] !== version ||
      values[2] !== "1" ||
      values[3] !== "x86_64"
    )
      throw new Error("rpm package identity differs from selected source");
  } else throw new Error("Metadata inspection requires deb or rpm");
  return {
    name: values[0] ?? "",
    version: values[1] ?? "",
    release: format === "rpm" ? (values[2] ?? null) : null,
    architecture: values.at(-1) ?? "",
  };
}
