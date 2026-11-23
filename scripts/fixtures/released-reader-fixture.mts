/** Offline sources for `acquireCatalogReleasedReader`: a fixture Pages pointer,
 * tag refs, published archive and checksum manifest, and a release attestation
 * statement for exactly those bytes. The statement stands in for
 * GitHub's signature, whose verification is tested separately against a real
 * GitHub attestation (`github-release-attestation.test.mts`). Every other
 * selection check runs unchanged. */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { ReleasedReaderSources } from "../catalog-released-reader.mts";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The fixed single-member ustar archive the release workflow produces. */
export function fixtureCliArchive(binary: Buffer) {
  const header = Buffer.alloc(512);
  header.write("portcove", 0, "latin1");
  const octal = (value: number, offset: number, width: number) =>
    header.write(value.toString(8).padStart(width - 1, "0") + "\0", offset, "latin1");
  octal(0o755, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(binary.length, 124, 12);
  octal(0, 136, 12);
  header[156] = 0x30;
  header.write("ustar\0" + "00", 257, "latin1");
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  const padding = Buffer.alloc((512 - (binary.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, binary, padding, Buffer.alloc(1024)]));
}

export interface ReleasedReaderFixture {
  /** The executable published as the reader. */
  binary: Buffer;
  version: string;
  withdrawn?: string[];
  /** Adjust the fixture before it is served (negative cases). */
  mutate?: (fixture: {
    statement: Record<string, unknown>;
    archive: Buffer;
    checksums: Buffer;
    tagObject: string;
    peeled: string;
    ancestor: boolean;
    feed: Record<string, unknown>;
  }) => void;
}

export function fixtureReleasedReaderSources(options: ReleasedReaderFixture) {
  const { version } = options;
  const tag = `v${version}`;
  const archiveName = `portcove-cli-${version}-linux-x86_64.tar.gz`;
  const archive = fixtureCliArchive(options.binary);
  const checksums = Buffer.from(`${sha256(archive)}  ${archiveName}\n`);
  const source = "c".repeat(40);
  const fixture = {
    archive,
    checksums,
    tagObject: "a".repeat(40),
    peeled: source,
    ancestor: true,
    feed: {
      version,
      platforms: {
        "linux-x86_64": {
          url: `https://github.com/boburning/portcove/releases/download/${tag}/Portcove_${version}_amd64.AppImage`,
        },
      },
    } as Record<string, unknown>,
    statement: {} as Record<string, unknown>,
  };
  const purl = `pkg:github/boburning/portcove@${tag}`;
  fixture.statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://in-toto.io/attestation/release/v0.2",
    predicate: {
      databaseId: "77",
      ownerId: "43177418",
      packageId: "1354613114",
      purl,
      repository: "boburning/portcove",
      repositoryId: "1354613114",
      tag,
    },
    subject: [
      { uri: purl, digest: { sha1: fixture.tagObject } },
      { name: archiveName, digest: { sha256: sha256(archive) } },
      { name: "SHA256SUMS", digest: { sha256: sha256(checksums) } },
    ],
  };
  options.mutate?.(fixture);
  const requests: string[] = [];
  const sources: ReleasedReaderSources = {
    pagesRevision: "f".repeat(40),
    pagesFile(file) {
      requests.push(`pages:${file}`);
      if (file === "updates/preview/latest.json") return Buffer.from(JSON.stringify(fixture.feed));
      if (file === "updates/withdrawn.json" && options.withdrawn)
        return Buffer.from(JSON.stringify(options.withdrawn));
      return null;
    },
    tagRefs: (name) => {
      requests.push(`tag:${name}`);
      return name === tag
        ? { object: fixture.tagObject, peeled: fixture.peeled }
        : { object: null, peeled: null };
    },
    isProtectedMainAncestor: (commit) => commit === source && fixture.ancestor,
    download: (name, file, maximumBytes) => {
      requests.push(`download:${file}`);
      const bytes =
        name === tag && file === archiveName
          ? fixture.archive
          : name === tag && file === "SHA256SUMS"
            ? fixture.checksums
            : null;
      if (!bytes) return Promise.reject(new Error("Portcove public release unavailable"));
      if (bytes.length > maximumBytes)
        return Promise.reject(new Error("Portcove download byte bound"));
      return Promise.resolve(bytes);
    },
    attestations: (digest) => {
      requests.push(`attestations:${digest}`);
      return Promise.resolve({ attestations: [{ bundle: { fixture: digest } }] });
    },
    verifyAttestation: () => fixture.statement,
  };
  return { sources, requests, tag, archiveName, fixture };
}
