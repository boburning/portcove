import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";

export const vectorFamilyRoot = "apps/desktop/assets/brand/vector/original-2d-20261019";
export const vectorFamilyManifest = `${vectorFamilyRoot}/manifest.generated.json`;
export const vectorIconManifest = `${vectorFamilyRoot}/platform-icons/manifest.generated.json`;
export const vectorIconFiles = [
  "32x32.png",
  "64x64.png",
  "128x128.png",
  "128x128@2x.png",
  "icon.png",
  "icon.ico",
  "icon.icns",
  "StoreLogo.png",
  "Square30x30Logo.png",
  "Square44x44Logo.png",
  "Square71x71Logo.png",
  "Square89x89Logo.png",
  "Square107x107Logo.png",
  "Square142x142Logo.png",
  "Square150x150Logo.png",
  "Square284x284Logo.png",
  "Square310x310Logo.png",
];
export const vectorRoles = ["mascot", "compact", "compact-small", "wordmark", "lockup"] as const;
export const vectorVariants = ["color", "color-dark", "ink", "ink-inverse"] as const;
export const sha256 = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export type VectorMaster = {
  id: string;
  role: (typeof vectorRoles)[number];
  variant: (typeof vectorVariants)[number];
  path: string;
  viewBox: [number, number];
  sha256: string;
  exportWidths: number[];
};
export type VectorDerivative = {
  source: string;
  path: string;
  width: number;
  height: number;
  sha256: string;
  transparentPixels: number;
  opaquePixels: number;
};
export type VectorFamily = {
  schema_version: 1;
  id: "original-2d-20261019";
  status: "candidate" | "approved";
  authorship: string;
  permissions: string;
  renderer: { name: "@resvg/resvg-js"; version: "2.6.2"; systemFonts: false };
  candidate_sha256: string;
  production_approval: null | { owner: string; evidence: string; candidate_sha256: string };
  masters: VectorMaster[];
  derivatives: VectorDerivative[];
  platform_icons?: { path: string; sha256: string };
};

// Tauri 2.12.2 iterates a HashMap when writing ICNS. Preserve every encoded
// element byte and image/mask association, ordering only this known output set.
export function canonicalBrandIcns(bytes: Buffer) {
  const order = [
    "is32",
    "s8mk",
    "il32",
    "l8mk",
    "ic11",
    "ic12",
    "ic07",
    "ic08",
    "ic13",
    "ic09",
    "ic14",
    "ic10",
  ];
  if (
    bytes.length < 8 ||
    bytes.toString("ascii", 0, 4) !== "icns" ||
    bytes.readUInt32BE(4) !== bytes.length
  )
    throw new Error("Invalid brand ICNS header");
  const chunks = new Map<string, Buffer>();
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new Error("Truncated brand ICNS element");
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32BE(offset + 4);
    if (!order.includes(type) || chunks.has(type) || length <= 8 || offset + length > bytes.length)
      throw new Error("Unexpected, duplicate or truncated brand ICNS element");
    chunks.set(type, bytes.subarray(offset, offset + length));
    offset += length;
  }
  if (chunks.size !== order.length) throw new Error("Incomplete brand ICNS family");
  return Buffer.concat([bytes.subarray(0, 8), ...order.map((type) => chunks.get(type)!)]);
}

export function familyDigest(masters: VectorMaster[]) {
  return sha256(JSON.stringify(masters));
}

export function vectorPath(relative: string) {
  if (
    !relative.startsWith(`${vectorFamilyRoot}/`) ||
    path.posix.normalize(relative) !== relative ||
    relative.includes("\\") ||
    relative.split("/").includes("..")
  )
    throw new Error(`Invalid vector-family path: ${relative}`);
  return relative;
}

/** Authored brand source contract, not a general untrusted-SVG sanitizer. */
export function validateVectorSource(source: string, box: [number, number]) {
  if (
    /<!|<\s*(?:text|image|script|style|foreignObject|use|filter|a)\b|\b(?:href|on\w+)\s*=/iu.test(
      source,
    )
  )
    throw new Error(
      "Brand masters must use original outlined geometry without fonts, embedded images, scripts or linked resources",
    );
  if (/url\(\s*(?!#[a-z][\w-]*\))/iu.test(source))
    throw new Error("Brand geometry may reference only local mask identifiers");
  if (!source.includes(`viewBox="0 0 ${box[0]} ${box[1]}"`))
    throw new Error("Brand master viewBox does not match its natural aspect ratio");
  const elements = [...source.matchAll(/<\s*\/?\s*([a-z][\w:-]*)/giu)].map((match) => match[1]);
  if (
    elements.some(
      (name) => !["svg", "title", "g", "path", "ellipse", "rect", "defs", "mask"].includes(name!),
    )
  )
    throw new Error("Unsupported authored brand geometry element");
}

export function readVectorFamily(value: unknown): VectorFamily {
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    value.id !== "original-2d-20261019" ||
    !["candidate", "approved"].includes(String(value.status)) ||
    typeof value.authorship !== "string" ||
    !value.authorship.includes("AI-assisted") ||
    typeof value.permissions !== "string" ||
    !value.permissions ||
    !isRecord(value.renderer) ||
    value.renderer.name !== "@resvg/resvg-js" ||
    value.renderer.version !== "2.6.2" ||
    value.renderer.systemFonts !== false ||
    !Array.isArray(value.masters) ||
    !Array.isArray(value.derivatives)
  )
    throw new Error("Invalid vector-family identity, provenance or renderer contract");
  const masters: VectorMaster[] = value.masters.map((raw: unknown) => {
    if (
      !isRecord(raw) ||
      typeof raw.id !== "string" ||
      typeof raw.path !== "string" ||
      !vectorRoles.some((role) => role === raw.role) ||
      !vectorVariants.some((variant) => variant === raw.variant) ||
      !Array.isArray(raw.viewBox) ||
      raw.viewBox.length !== 2 ||
      !raw.viewBox.every(
        (number: unknown) => typeof number === "number" && Number.isInteger(number) && number > 0,
      ) ||
      typeof raw.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(raw.sha256) ||
      !Array.isArray(raw.exportWidths) ||
      !raw.exportWidths.length ||
      !raw.exportWidths.every(
        (width: unknown) =>
          typeof width === "number" && Number.isInteger(width) && width >= 16 && width <= 2048,
      )
    )
      throw new Error("Invalid vector master");
    vectorPath(raw.path);
    if (
      raw.id !== `${String(raw.role)}-${String(raw.variant)}` ||
      raw.path !== `${vectorFamilyRoot}/masters/${raw.id}.svg`
    )
      throw new Error("Vector master identity/path mismatch");
    return raw as VectorMaster;
  });
  if (
    masters.length !== vectorRoles.length * vectorVariants.length ||
    new Set(masters.map((master) => master.id)).size !== masters.length
  )
    throw new Error("Vector family must contain every independent role and variant exactly once");
  const digest = familyDigest(masters);
  if (value.candidate_sha256 !== digest)
    throw new Error("Vector family candidate identity changed");
  if (value.status === "candidate" && value.production_approval !== null)
    throw new Error("A candidate cannot imply production approval");
  if (value.status === "approved") {
    const approval = value.production_approval;
    if (
      !isRecord(approval) ||
      approval.candidate_sha256 !== digest ||
      typeof approval.owner !== "string" ||
      !approval.owner ||
      typeof approval.evidence !== "string" ||
      !approval.evidence
    )
      throw new Error("Production approval must bind this exact family and owner evidence");
  }
  return { ...value, masters } as VectorFamily;
}

/** Dependency-free release validation retains V2 separately from vector checks. */
export async function verifyVectorFamily(root: string, relative = vectorFamilyManifest) {
  vectorPath(relative);
  const bytes = await readFile(path.join(root, relative));
  const raw: unknown = JSON.parse(bytes.toString("utf8"));
  const family = readVectorFamily(raw);
  for (const master of family.masters) {
    const source = await readFile(path.join(root, master.path));
    if (sha256(source) !== master.sha256) throw new Error(`Vector master changed: ${master.id}`);
    validateVectorSource(source.toString("utf8"), master.viewBox);
  }
  const expected = new Set(
    family.masters.flatMap((master) =>
      master.exportWidths.map((width) => `${vectorFamilyRoot}/exports/${master.id}-${width}.png`),
    ),
  );
  for (const derivative of family.derivatives) {
    if (
      !isRecord(derivative) ||
      typeof derivative.path !== "string" ||
      !expected.delete(derivative.path)
    )
      throw new Error("Missing, duplicate or unexpected vector derivative");
    vectorPath(derivative.path);
    const master = family.masters.find((item) => item.id === derivative.source);
    if (
      !master ||
      !master.exportWidths.includes(derivative.width) ||
      derivative.path !== `${vectorFamilyRoot}/exports/${master.id}-${derivative.width}.png` ||
      !Number.isInteger(derivative.height) ||
      derivative.height <= 0 ||
      Math.abs(derivative.height - (derivative.width * master.viewBox[1]) / master.viewBox[0]) >
        1 ||
      !Number.isInteger(derivative.transparentPixels) ||
      derivative.transparentPixels < 1 ||
      !Number.isInteger(derivative.opaquePixels) ||
      derivative.opaquePixels < 1
    )
      throw new Error("Vector derivative geometry or alpha contract is invalid");
    const png = await readFile(path.join(root, derivative.path));
    if (
      sha256(png) !== derivative.sha256 ||
      png.length < 33 ||
      png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      png.readUInt32BE(16) !== derivative.width ||
      png.readUInt32BE(20) !== derivative.height ||
      png[24] !== 8 ||
      png[25] !== 6
    )
      throw new Error(`Vector derivative bytes changed: ${derivative.path}`);
  }
  if (expected.size) throw new Error("Vector derivatives are incomplete");
  if (family.platform_icons) {
    if (family.platform_icons.path !== vectorIconManifest)
      throw new Error("Unexpected vector icon manifest");
    const iconBytes = await readFile(path.join(root, vectorIconManifest));
    if (sha256(iconBytes) !== family.platform_icons.sha256)
      throw new Error("Vector icon manifest changed");
    const icons: unknown = JSON.parse(iconBytes.toString("utf8"));
    if (
      !isRecord(icons) ||
      icons.candidate_sha256 !== family.candidate_sha256 ||
      icons.source !== "compact-small-color" ||
      !Array.isArray(icons.outputs)
    )
      throw new Error("Vector icon provenance changed");
    const remaining = new Set(vectorIconFiles);
    for (const file of icons.outputs) {
      if (!isRecord(file) || typeof file.name !== "string" || !remaining.delete(file.name))
        throw new Error("Unexpected or duplicate vector icon");
      const content = await readFile(
        path.join(root, vectorFamilyRoot, "platform-icons", file.name),
      );
      if (sha256(content) !== file.sha256) throw new Error(`Vector icon changed: ${file.name}`);
      if (file.name === "icon.icns" && !canonicalBrandIcns(content).equals(content))
        throw new Error("Brand ICNS is not canonically ordered");
    }
    if (remaining.size) throw new Error("Vector desktop icons are incomplete");
  }
  return { family, sha256: sha256(bytes) };
}
