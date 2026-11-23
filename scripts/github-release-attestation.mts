/** Offline, credential-free verification of one GitHub immutable-release
 * attestation (a Sigstore v0.3 bundle signed by GitHub's internal Fulcio and
 * timestamped by GitHub's TSA). Signature, chain and timestamp checks use
 * `node:crypto`; this module only parses DER and selects trust material from a
 * Sigstore trusted root. It returns the verified in-toto statement; callers
 * bind the statement's predicate and subjects. No token, network or GitHub CLI
 * is used here. */
import { X509Certificate, createHash, verify as verifySignature } from "node:crypto";
import { isRecord } from "./runtime-values.mts";

/** GitHub's release attestations are signed under this certificate identity. */
export const githubReleaseSignerIdentity = "https://dotcom.releases.github.com";
const githubFulcio = "fulcio.githubapp.com";
const githubTimestamp = "timestamp.githubapp.com";
const bundleMediaType = "application/vnd.dev.sigstore.bundle.v0.3+json";
const inTotoPayloadType = "application/vnd.in-toto+json";
const codeSigning = "1.3.6.1.5.5.7.3.3";
const timeStamping = "1.3.6.1.5.5.7.3.8";
const maximumBundleBytes = 64 * 1024;

const oids = {
  signedData: "1.2.840.113549.1.7.2",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
} as const;
const digestNames: Record<string, string> = {
  "2.16.840.1.101.3.4.2.1": "sha256",
  "2.16.840.1.101.3.4.2.2": "sha384",
  "2.16.840.1.101.3.4.2.3": "sha512",
};
const signatureDigests: Record<string, string> = {
  "1.2.840.10045.4.3.2": "sha256",
  "1.2.840.10045.4.3.3": "sha384",
  "1.2.840.10045.4.3.4": "sha512",
};

const fail = (reason: string): never => {
  throw new Error(`GitHub release attestation refused: ${reason}`);
};

interface Der {
  tag: number;
  /** The complete TLV. */
  bytes: Buffer;
  content: Buffer;
}

/** One strict DER TLV: low tag numbers, definite minimal lengths, in bounds. */
function readDer(buffer: Buffer, offset = 0): Der {
  if (offset + 2 > buffer.length) fail("truncated DER");
  const tag = buffer[offset]!;
  if ((tag & 0x1f) === 0x1f) fail("unsupported DER tag");
  const first = buffer[offset + 1]!;
  let length = first;
  let header = 2;
  if (first & 0x80) {
    const count = first & 0x7f;
    if (count === 0 || count > 4 || offset + 2 + count > buffer.length) fail("invalid DER length");
    length = 0;
    for (let index = 0; index < count; index++) length = length * 256 + buffer[offset + 2 + index]!;
    if (buffer[offset + 2] === 0 || length < 0x80) fail("non-minimal DER length");
    header += count;
  }
  const end = offset + header + length;
  if (end > buffer.length) fail("truncated DER value");
  return {
    tag,
    bytes: buffer.subarray(offset, end),
    content: buffer.subarray(offset + header, end),
  };
}

/** A whole buffer that is exactly one TLV. */
function exact(buffer: Buffer, tag: number) {
  const value = readDer(buffer);
  if (value.tag !== tag || value.bytes.length !== buffer.length) fail("unexpected DER structure");
  return value;
}

function children(value: Der) {
  const result: Der[] = [];
  for (let offset = 0; offset < value.content.length;) {
    const child = readDer(value.content, offset);
    result.push(child);
    offset += child.bytes.length;
  }
  return result;
}

function expectTag(value: Der | undefined, tag: number): Der {
  if (!value || value.tag !== tag) fail("unexpected DER element");
  return value!;
}

function oid(value: Der | undefined) {
  const content = expectTag(value, 0x06).content;
  if (!content.length || content[content.length - 1]! & 0x80) fail("invalid object identifier");
  const parts: number[] = [];
  let current = 0;
  for (const byte of content) {
    if (current === 0 && byte === 0x80) fail("non-minimal object identifier");
    current = current * 128 + (byte & 0x7f);
    if (current > Number.MAX_SAFE_INTEGER / 128) fail("object identifier overflow");
    if (!(byte & 0x80)) {
      parts.push(current);
      current = 0;
    }
  }
  const head = parts.shift()!;
  const leading = head < 40 ? [0, head] : head < 80 ? [1, head - 40] : [2, head - 80];
  return [...leading, ...parts].join(".");
}

function generalizedTime(value: Der | undefined) {
  const text = expectTag(value, 0x18).content.toString("latin1");
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,9}))?Z$/u.exec(text);
  if (!match) fail("invalid timestamp time");
  const [, year, month, day, hour, minute, second, fraction] = match!;
  const time = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number((fraction ?? "0").padEnd(3, "0").slice(0, 3)),
  );
  if (!Number.isFinite(time)) fail("invalid timestamp time");
  return new Date(time);
}

const base64 = (value: unknown, what: string) => {
  if (typeof value !== "string" || !value.length) return fail(`${what} missing`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, ""))
    fail(`${what} is not canonical base64`);
  return bytes;
};

interface Authority {
  uri: string;
  start: Date;
  end: Date | null;
  chain: X509Certificate[];
}

function authorities(entries: unknown, uri: string): Authority[] {
  if (!Array.isArray(entries)) return fail("trusted root authority list missing");
  return entries
    .filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry.uri === uri)
    .map((entry) => {
      const validFor = isRecord(entry.validFor) ? entry.validFor : {};
      const chain = isRecord(entry.certChain) ? entry.certChain.certificates : undefined;
      if (typeof validFor.start !== "string" || !Array.isArray(chain) || !chain.length)
        fail("trusted root authority is incomplete");
      return {
        uri,
        start: new Date(validFor.start as string),
        end: typeof validFor.end === "string" ? new Date(validFor.end) : null,
        chain: (chain as unknown[]).map(
          (certificate) =>
            new X509Certificate(
              base64(isRecord(certificate) ? certificate.rawBytes : undefined, "certificate"),
            ),
        ),
      };
    });
}

const within = (time: Date, start: Date, end: Date | null) =>
  time.getTime() >= start.getTime() && (end === null || time.getTime() <= end.getTime());

const certificateValidAt = (certificate: X509Certificate, time: Date) =>
  within(time, new Date(certificate.validFrom), new Date(certificate.validTo));

/** Walk from `leaf` to the authority's self-signed root through its chain. */
function chainsTo(leaf: X509Certificate, authority: Authority, time: Date) {
  let current = leaf;
  for (let depth = 0; depth <= authority.chain.length; depth++) {
    if (!certificateValidAt(current, time)) return false;
    const issuer = authority.chain.find(
      (candidate) =>
        candidate.ca &&
        current.checkIssued(candidate) &&
        current.verify(candidate.publicKey) &&
        certificateValidAt(candidate, time),
    );
    if (!issuer) return false;
    if (issuer.checkIssued(issuer) && issuer.verify(issuer.publicKey))
      return issuer.fingerprint256 === authority.chain.at(-1)!.fingerprint256;
    current = issuer;
  }
  return false;
}

/** The signing time attested by one RFC 3161 token over `signature`. */
function verifiedTimestamp(token: Buffer, signature: Buffer, tsas: Authority[]) {
  let info = exact(token, 0x30);
  let parts = children(info);
  // A TimeStampResp wraps the token after a granted PKIStatusInfo.
  if (parts[0]?.tag === 0x30 && parts[1]?.tag === 0x30) {
    const status = children(parts[0]);
    const granted = expectTag(status[0], 0x02).content;
    if (granted.length !== 1 || granted[0]! > 1) fail("timestamp was not granted");
    if (parts.length !== 2) fail("unexpected timestamp response");
    info = parts[1];
    parts = children(info);
  }
  if (parts.length !== 2 || oid(parts[0]) !== oids.signedData) fail("timestamp is not SignedData");
  const signedData = children(expectTag(children(expectTag(parts[1], 0xa0))[0], 0x30));
  const encapsulated = children(expectTag(signedData[2], 0x30));
  if (oid(encapsulated[0]) !== oids.tstInfo) fail("timestamp content is not TSTInfo");
  const tstBytes = expectTag(children(expectTag(encapsulated[1], 0xa0))[0], 0x04).content;
  const signerInfos = children(expectTag(signedData.at(-1), 0x31));
  if (signerInfos.length !== 1) fail("timestamp must have exactly one signer");
  const signer = children(expectTag(signerInfos[0], 0x30));
  const digestName = digestNames[oid(children(expectTag(signer[2], 0x30))[0])];
  const attributes = expectTag(signer[3], 0xa0);
  const algorithm = signatureDigests[oid(children(expectTag(signer[4], 0x30))[0])];
  const signatureValue = expectTag(signer[5], 0x04).content;
  if (!digestName || !algorithm) fail("unsupported timestamp algorithm");
  let contentType: string | undefined;
  let messageDigest: Buffer | undefined;
  for (const attribute of children(attributes)) {
    const [type, values] = children(expectTag(attribute, 0x30));
    const valueList = children(expectTag(values, 0x31));
    if (valueList.length !== 1) fail("timestamp attribute must have one value");
    const name = oid(type);
    if (name === oids.contentType) {
      if (contentType !== undefined) fail("repeated timestamp attribute");
      contentType = oid(valueList[0]);
    } else if (name === oids.messageDigest) {
      if (messageDigest !== undefined) fail("repeated timestamp attribute");
      messageDigest = expectTag(valueList[0], 0x04).content;
    }
  }
  if (contentType !== oids.tstInfo) fail("timestamp content type differs");
  if (!messageDigest?.equals(createHash(digestName!).update(tstBytes).digest()))
    fail("timestamp content digest differs");
  // The signature covers the DER SET OF the signed attributes.
  const signedAttributes = Buffer.from(attributes.bytes);
  signedAttributes[0] = 0x31;
  const tst = children(exact(tstBytes, 0x30));
  const imprint = children(expectTag(tst[2], 0x30));
  const imprintDigest = digestNames[oid(children(expectTag(imprint[0], 0x30))[0])];
  if (!imprintDigest) fail("unsupported timestamp imprint");
  if (
    !expectTag(imprint[1], 0x04).content.equals(
      createHash(imprintDigest!).update(signature).digest(),
    )
  )
    fail("timestamp does not cover the attestation signature");
  const time = generalizedTime(tst[4]);
  const authority = tsas.find((candidate) => {
    const leaf = candidate.chain[0]!;
    return (
      within(time, candidate.start, candidate.end) &&
      !leaf.ca &&
      (leaf.keyUsage ?? []).includes(timeStamping) &&
      verifySignature(algorithm, signedAttributes, leaf.publicKey, signatureValue) &&
      chainsTo(leaf, { ...candidate, chain: candidate.chain.slice(1) }, time)
    );
  });
  if (!authority) fail("no trusted timestamp authority signed the timestamp");
  return time;
}

/** Verify a GitHub release attestation bundle against GitHub's entry of a
 * Sigstore trusted root and return its verified in-toto statement. */
export function verifyGitHubReleaseAttestation(bundle: unknown, trustedRoot: unknown) {
  if (Buffer.byteLength(JSON.stringify(bundle ?? null)) > maximumBundleBytes)
    fail("bundle exceeds its bound");
  if (!isRecord(bundle) || bundle.mediaType !== bundleMediaType) return fail("unexpected bundle");
  if (!isRecord(trustedRoot)) return fail("trusted root missing");
  const material = isRecord(bundle.verificationMaterial) ? bundle.verificationMaterial : {};
  const envelope = isRecord(bundle.dsseEnvelope) ? bundle.dsseEnvelope : {};
  if (envelope.payloadType !== inTotoPayloadType) fail("unexpected payload type");
  const signatures = Array.isArray(envelope.signatures) ? envelope.signatures : [];
  if (signatures.length !== 1 || !isRecord(signatures[0])) fail("exactly one signature required");
  const signature = base64((signatures[0] as Record<string, unknown>).sig, "signature");
  const payload = base64(envelope.payload, "payload");
  const leaf = new X509Certificate(
    base64(
      isRecord(material.certificate) ? material.certificate.rawBytes : undefined,
      "certificate",
    ),
  );
  if (leaf.ca || leaf.subjectAltName !== `URI:${githubReleaseSignerIdentity}`)
    fail("signer identity differs");
  if (!(leaf.keyUsage ?? []).includes(codeSigning)) fail("signer is not a code-signing key");
  const timestamps = isRecord(material.timestampVerificationData)
    ? material.timestampVerificationData.rfc3161Timestamps
    : undefined;
  if (!Array.isArray(timestamps) || !timestamps.length || timestamps.length > 4)
    fail("signed timestamp missing");
  const tsas = authorities(trustedRoot.timestampAuthorities, githubTimestamp);
  const cas = authorities(trustedRoot.certificateAuthorities, githubFulcio);
  const times = (timestamps as unknown[]).map((entry) =>
    verifiedTimestamp(
      base64(isRecord(entry) ? entry.signedTimestamp : undefined, "timestamp"),
      signature,
      tsas,
    ),
  );
  const time = times[0]!;
  if (
    !cas.some(
      (authority) =>
        within(time, authority.start, authority.end) && chainsTo(leaf, authority, time),
    )
  )
    fail("signer certificate does not chain to a trusted GitHub authority at its timestamp");
  const curve = leaf.publicKey.asymmetricKeyDetails?.namedCurve;
  const digest = curve === "secp384r1" ? "sha384" : curve === "prime256v1" ? "sha256" : null;
  if (!digest) fail("unsupported signer key");
  const type = Buffer.from(inTotoPayloadType);
  const pae = Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `),
    type,
    Buffer.from(` ${payload.length} `),
    payload,
  ]);
  if (!verifySignature(digest, pae, leaf.publicKey, signature)) fail("signature differs");
  const statement: unknown = JSON.parse(payload.toString("utf8"));
  if (!isRecord(statement) || statement._type !== "https://in-toto.io/Statement/v1")
    fail("statement type differs");
  return { statement: statement as Record<string, unknown>, signed_at: time.toISOString() };
}
