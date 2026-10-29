import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";

export interface MaintenanceArtifact {
  manager: "cargo" | "npm";
  name: string;
  version: string;
  integrity: string;
}
// Preserve the resolved Renovate 44.188.2 policy: configured one day plus
// its inherited default buffer. This explicit contract has no clock/age override.
export const maintenanceAgePolicy = Object.freeze({
  minimumReleaseAge: "1 day",
  minimumReleaseAgeMs: 86_400_000,
  minimumReleaseAgeBuffer: "30 minutes",
  minimumReleaseAgeBufferMs: 1_800_000,
  provenance: {
    renovateVersion: "44.188.2",
    configuration: "renovate.json",
    defaultSource: "lib/config/options/index.ts#minimumReleaseAgeBuffer",
    calculationSource: "lib/util/minimum-release-age.ts",
  },
});
export const maintenanceLimits = Object.freeze({
  lockBytes: 16 * 1024 * 1024,
  entries: 4096,
  artifacts: 128,
  requestMs: 20_000,
  totalMs: 12 * 60_000,
  metadataBytes: 32 * 1024 * 1024,
  totalMetadataBytes: 256 * 1024 * 1024,
  archiveBytes: 128 * 1024 * 1024,
  totalArchiveBytes: 512 * 1024 * 1024,
  ageMs: maintenanceAgePolicy.minimumReleaseAgeMs + maintenanceAgePolicy.minimumReleaseAgeBufferMs,
});
const lengths = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 } as const;
type Algorithm = keyof typeof lengths;
function object(value: unknown, label: string) {
  if (!isRecord(value)) throw new Error(`Missing or malformed ${label}`);
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing ${label}`);
  return value;
}
export function integrityParts(value: string) {
  const parts = value.split(" ").map((token) => {
    const match = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/u.exec(token);
    if (!match) throw new Error("Unsupported or malformed artifact integrity");
    const algorithm = match[1] as Algorithm;
    const digest = text(match[2], "integrity digest");
    const bytes = Buffer.from(digest, "base64");
    if (bytes.length !== lengths[algorithm] || bytes.toString("base64") !== digest)
      throw new Error("Noncanonical artifact integrity");
    return { algorithm, digest };
  });
  if (new Set(parts.map((p) => p.algorithm)).size !== parts.length)
    throw new Error("Ambiguous artifact integrity algorithms");
  return parts;
}
// Ceil fractional milliseconds, never admit .285686 at .285.
export function publicationMilliseconds(value: unknown): number {
  const match =
    typeof value === "string" && /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/u.exec(value);
  if (!match) throw new Error("Authoritative publication timestamp is missing or invalid");
  const seconds = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(seconds) || new Date(seconds).toISOString().slice(0, 19) !== match[1])
    throw new Error("Invalid publication calendar timestamp");
  return seconds + Number((BigInt((match[2] ?? "").padEnd(9, "0")) + 999_999n) / 1_000_000n);
}

export interface RegistryObservation {
  artifact: MaintenanceArtifact;
  publication: string;
  eligibleAt: string;
  metadataUrl: string;
  age: "eligible" | "young";
  archiveVerified: boolean;
  archiveBytes: number;
}
export class MaintenanceRegistry {
  readonly observedAt: number;
  private deadline: number;
  private metadataBytes = 0;
  private archiveBytes = 0;
  private packuments = new Map<string, unknown>();
  private request: typeof fetch;
  constructor(request: typeof fetch = fetch) {
    this.request = request;
    this.observedAt = Date.now();
    this.deadline = this.observedAt + maintenanceLimits.totalMs;
  }
  private async response(url: string) {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new Error("Maintenance registry deadline expired");
    const response = await this.request(url, {
      headers: { accept: "application/json", "user-agent": "Portcove dependency-policy (#1372)" },
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(remaining, maintenanceLimits.requestMs)),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Registry HTTP ${response.status}: ${url}`);
    }
    return response;
  }
  private async metadata(url: string): Promise<unknown> {
    const response = await this.response(url);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const raw of response.body!) {
      const chunk: unknown = raw;
      if (!(chunk instanceof Uint8Array)) throw new Error("Registry emitted a non-byte stream");
      bytes += chunk.length;
      this.metadataBytes += chunk.length;
      if (
        bytes > maintenanceLimits.metadataBytes ||
        this.metadataBytes > maintenanceLimits.totalMetadataBytes
      )
        throw new Error("Maintenance metadata byte budget exceeded");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  private async cargo(artifact: MaintenanceArtifact) {
    const metadataUrl = `https://crates.io/api/v1/crates/${encodeURIComponent(artifact.name)}/${encodeURIComponent(artifact.version)}`;
    const version = object(
      object(await this.metadata(metadataUrl), "crate response").version,
      "crate version",
    );
    if (
      version.crate !== artifact.name ||
      version.num !== artifact.version ||
      version.yanked !== false
    )
      throw new Error("Crate version identity is inconsistent or yanked");
    const checksum = text(version.checksum, "crate checksum");
    if (!/^[0-9a-f]{64}$/u.test(checksum)) throw new Error("Invalid registry SHA256");
    const integrity = `sha256-${Buffer.from(checksum, "hex").toString("base64")}`;
    if (artifact.integrity !== integrity) throw new Error("Crate checksum differs from Cargo.lock");
    return {
      metadataUrl,
      publication: text(version.created_at, "crate created_at"),
      integrity,
      archive: `https://static.crates.io/crates/${artifact.name}/${artifact.name}-${artifact.version}.crate`,
    };
  }
  private async npm(artifact: MaintenanceArtifact) {
    const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(artifact.name)}`;
    if (!this.packuments.has(artifact.name))
      this.packuments.set(artifact.name, await this.metadata(metadataUrl));
    const document = object(this.packuments.get(artifact.name), "npm packument");
    const version = object(
      object(document.versions, "npm versions")[artifact.version],
      "exact npm version",
    );
    if (
      document.name !== artifact.name ||
      version.name !== artifact.name ||
      version.version !== artifact.version
    )
      throw new Error("npm registry identity differs from lock identity");
    const dist = object(version.dist, "npm distribution");
    const integrity =
      typeof dist.integrity === "string"
        ? dist.integrity
        : typeof dist.shasum === "string" && /^[0-9a-f]{40}$/u.test(dist.shasum)
          ? `sha1-${Buffer.from(dist.shasum, "hex").toString("base64")}`
          : "";
    const authoritative = integrityParts(integrity),
      locked = integrityParts(artifact.integrity);
    const strongest = (parts: ReturnType<typeof integrityParts>) =>
      Math.max(...parts.map((p) => lengths[p.algorithm]));
    if (
      strongest(authoritative) < strongest(locked) ||
      strongest(locked) < strongest(authoritative) ||
      locked.some(
        (p) => !authoritative.some((a) => a.algorithm === p.algorithm && a.digest === p.digest),
      )
    )
      throw new Error("npm integrity mismatch or digest downgrade");
    const archive = new URL(text(dist.tarball, "npm tarball"));
    if (
      archive.protocol !== "https:" ||
      archive.hostname !== "registry.npmjs.org" ||
      archive.port ||
      archive.username ||
      archive.password ||
      archive.search ||
      archive.hash ||
      !decodeURIComponent(archive.pathname).startsWith(`/${artifact.name}/-/`)
    )
      throw new Error("Unsupported npm tarball authority");
    return {
      metadataUrl,
      integrity,
      archive: archive.href,
      publication: text(
        object(document.time, "npm publication times")[artifact.version],
        "npm publication time",
      ),
    };
  }
  private async archive(url: string, integrity: string) {
    const hashes = integrityParts(integrity).map((p) => ({
      hash: createHash(p.algorithm),
      expected: p.digest,
    }));
    const response = await this.response(url);
    let bytes = 0;
    for await (const raw of response.body!) {
      const chunk: unknown = raw;
      if (!(chunk instanceof Uint8Array)) throw new Error("Registry emitted a non-byte stream");
      bytes += chunk.length;
      this.archiveBytes += chunk.length;
      if (
        bytes > maintenanceLimits.archiveBytes ||
        this.archiveBytes > maintenanceLimits.totalArchiveBytes
      )
        throw new Error("Maintenance archive byte budget exceeded");
      for (const { hash } of hashes) hash.update(chunk);
    }
    if (!bytes || hashes.some(({ hash, expected }) => hash.digest("base64") !== expected))
      throw new Error("Actual registry archive integrity mismatch");
    return bytes;
  }
  async verify(artifact: MaintenanceArtifact): Promise<RegistryObservation> {
    const name =
      artifact.manager === "cargo" ? /^[A-Za-z0-9_-]+$/u : /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u;
    if (
      !name.test(artifact.name) ||
      !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/u.test(artifact.version)
    )
      throw new Error("Invalid registry artifact identity");
    const metadata =
      artifact.manager === "cargo" ? await this.cargo(artifact) : await this.npm(artifact);
    const published = publicationMilliseconds(metadata.publication);
    if (published > this.observedAt) throw new Error("Publication timestamp is in the future");
    const eligible = published + maintenanceLimits.ageMs;
    const mature = eligible <= this.observedAt;
    const bytes = mature ? await this.archive(metadata.archive, artifact.integrity) : 0;
    return {
      artifact,
      publication: metadata.publication,
      eligibleAt: new Date(eligible).toISOString(),
      metadataUrl: metadata.metadataUrl,
      age: mature ? "eligible" : "young",
      archiveVerified: mature,
      archiveBytes: bytes,
    };
  }
}
