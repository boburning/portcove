/** Restriction data only. The signing caller must supply its actual Tough-admitted
 * prior records and independently accepted complete opportunity. */
import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import {
  classifyApplicationVersion,
  compareApplicationVersionPrecedence,
} from "../apps/desktop/scripts/release-version-policy.mts";

export const previewWithdrawalSourcePath = "release-preview-withdrawals.json";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const maximumSourceBytes = 32 * 1024;
function hasControlCharacter(value: string) {
  for (let index = 0; index < value.length; index++)
    if (value.charCodeAt(index) < 32 || value.charCodeAt(index) === 127) return true;
  return false;
}
export interface PreviewWithdrawal {
  promotion_path: string;
  promotion_sha256: string;
  release_path: string;
  release_sha256: string;
  reason: string;
}
function exact(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== keys)
    throw new Error("Preview withdrawal fields differ");
}
export function inspectPreviewWithdrawals(raw: unknown): PreviewWithdrawal[] {
  if (!Array.isArray(raw) || raw.length > 16)
    throw new Error("Preview withdrawal count exceeds bound");
  let previous = "";
  return raw.map((value: unknown) => {
    exact(value, "promotion_path,promotion_sha256,reason,release_path,release_sha256");
    if (
      typeof value.promotion_path !== "string" ||
      typeof value.release_path !== "string" ||
      typeof value.reason !== "string" ||
      !value.reason.trim() ||
      value.reason !== value.reason.trim() ||
      Buffer.byteLength(value.reason) > 1024 ||
      hasControlCharacter(value.reason) ||
      typeof value.promotion_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.promotion_sha256) ||
      typeof value.release_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.release_sha256)
    )
      throw new Error("Preview withdrawal identity or bounded reason differs");
    const match =
      /^channels\/preview\/(windows-x86_64\/nsis|linux-x86_64\/appimage)\/([^/]+)\.json$/u.exec(
        value.promotion_path,
      );
    if (!match) throw new Error("Preview withdrawal must address a maintained Preview promotion");
    classifyApplicationVersion(match[2]);
    if (
      value.release_path !== `releases/${match[2]}/${match[1]}.json` ||
      value.promotion_path <= previous
    )
      throw new Error("Preview withdrawal release path, ordering or uniqueness differs");
    previous = value.promotion_path;
    return {
      promotion_path: value.promotion_path,
      promotion_sha256: value.promotion_sha256,
      release_path: value.release_path,
      release_sha256: value.release_sha256,
      reason: value.reason,
    };
  });
}

function priorPromotion(request: PreviewWithdrawal, promotionBytes: Buffer, releaseBytes: Buffer) {
  if (
    hash(promotionBytes) !== request.promotion_sha256 ||
    hash(releaseBytes) !== request.release_sha256
  )
    throw new Error("Preview withdrawal prior record bytes differ");
  const promotion: unknown = JSON.parse(promotionBytes.toString("utf8"));
  const release: unknown = JSON.parse(releaseBytes.toString("utf8"));
  exact(
    promotion,
    "channel,eligible,package,production_eligible,reason,release_path,release_sha256,required_bridge,schema_version,target,version,withdrawn",
  );
  if (
    promotion.schema_version !== 1 ||
    promotion.channel !== "preview" ||
    promotion.eligible !== true ||
    promotion.withdrawn !== false ||
    promotion.production_eligible !== false ||
    promotion.release_path !== request.release_path ||
    promotion.release_sha256 !== request.release_sha256 ||
    request.promotion_path !==
      `channels/preview/${String(promotion.target)}/${String(promotion.package)}/${String(promotion.version)}.json` ||
    !isRecord(release) ||
    release.schema_version !== 1 ||
    release.version !== promotion.version ||
    release.target !== promotion.target ||
    !isRecord(release.package) ||
    release.package.kind !== promotion.package
  )
    throw new Error("Preview withdrawal prior promotion/release association differs");
  return promotion;
}

type FrozenSource = {
  manifest: { snapshots: { source: readonly { mode: string; oid: string; path: string }[] } };
  files: readonly { name: string; bytes: Buffer }[];
};
/** The existing inert source snapshot binds both the small classification map and
 * full reviewed prior bytes. Those source bytes acquire no TUF authority here. */
export function readPreviewWithdrawalSource(bundle: FrozenSource): PreviewWithdrawal[] {
  const entries = bundle.manifest.snapshots.source.filter(
    (entry) => entry.path === previewWithdrawalSourcePath,
  );
  if (!entries.length) return [];
  if (entries.length !== 1 || entries[0]!.mode !== "100644")
    throw new Error("Preview withdrawal source must be one regular source blob");
  const entry = entries[0]!;
  const blobs = bundle.files.filter((file) => file.name === `objects/${entry.oid}.data`);
  if (blobs.length !== 1) throw new Error("Preview withdrawal source blob missing or repeated");
  const bytes = blobs[0]!.bytes;
  if (
    bytes.length < 1 ||
    bytes.length > maximumSourceBytes ||
    createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== entry.oid ||
    !Buffer.from(bytes.toString("utf8")).equals(bytes)
  )
    throw new Error("Preview withdrawal source bytes or bound differ");
  const source: unknown = JSON.parse(bytes.toString("utf8"));
  exact(source, "schema_version,withdrawals");
  if (
    source.schema_version !== 1 ||
    !Array.isArray(source.withdrawals) ||
    source.withdrawals.length > 16
  )
    throw new Error("Preview withdrawal source schema differs");
  const requests = source.withdrawals.map((raw: unknown) => {
    exact(
      raw,
      "prior_promotion_utf8,prior_release_utf8,promotion_path,promotion_sha256,reason,release_path,release_sha256",
    );
    const { prior_promotion_utf8: promotion, prior_release_utf8: release, ...request } = raw;
    if (typeof promotion !== "string" || typeof release !== "string")
      throw new Error("Preview withdrawal requires full frozen prior UTF8 records");
    return { request, promotion, release };
  });
  const parsed = inspectPreviewWithdrawals(requests.map((entry) => entry.request));
  parsed.forEach((request, index) =>
    priorPromotion(
      request,
      Buffer.from(requests[index]!.promotion),
      Buffer.from(requests[index]!.release),
    ),
  );
  return parsed;
}

export function assertPreviewWithdrawalClassification(
  classification: unknown,
  source: readonly PreviewWithdrawal[],
) {
  if (!isRecord(classification)) throw new Error("Preview withdrawal classification missing");
  const requests =
    classification.preview_withdrawals === undefined
      ? []
      : inspectPreviewWithdrawals(classification.preview_withdrawals);
  if (releaseCanonicalDigest(requests) !== releaseCanonicalDigest(source))
    throw new Error("Preview withdrawal classification differs from exact frozen source request");
  return requests;
}

/** This pure transformation is used only after actual payload and Tough getters.
 * It cannot replace releases/Stable, add promotions, reactivate or change payloads. */
export function applyReviewedPreviewWithdrawals(
  prior: ReadonlyMap<string, Buffer>,
  rawManifest: unknown,
  classification: unknown,
  forwardVersion: string,
) {
  if (!isRecord(classification)) throw new Error("Preview withdrawal classification missing");
  const requests =
    classification.preview_withdrawals === undefined
      ? []
      : inspectPreviewWithdrawals(classification.preview_withdrawals);
  const files = new Map([...prior].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  const manifest: unknown = structuredClone(rawManifest);
  exact(manifest, "records,schema_version");
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.records))
    throw new Error("Preview withdrawal reconstruction manifest differs");
  for (const request of requests) {
    const promotionBytes = prior.get(request.promotion_path),
      releaseBytes = prior.get(request.release_path);
    if (!promotionBytes || !releaseBytes)
      throw new Error("Preview withdrawal authenticated prior record missing");
    const promotion = priorPromotion(request, promotionBytes, releaseBytes);
    if (compareApplicationVersionPrecedence(promotion.version, forwardVersion) >= 0)
      throw new Error("Preview withdrawal requires a later ordinary forward-repair version");
    const bytes = Buffer.from(
      `${JSON.stringify({ ...promotion, eligible: false, withdrawn: true, reason: request.reason }, null, 2)}\n`,
    );
    const rows = manifest.records.filter(
      (raw: unknown) => isRecord(raw) && raw.path === request.promotion_path,
    );
    if (rows.length !== 1) throw new Error("Preview withdrawal manifest row missing or repeated");
    const row: unknown = rows[0];
    if (
      !isRecord(row) ||
      row.kind !== "promotion" ||
      row.channel !== "preview" ||
      row.bytes !== promotionBytes.length ||
      row.sha256 !== request.promotion_sha256 ||
      row.version !== promotion.version ||
      row.target !== promotion.target ||
      row.package !== promotion.package
    )
      throw new Error("Preview withdrawal prior manifest identity differs");
    row.bytes = bytes.length;
    row.sha256 = hash(bytes);
    files.set(request.promotion_path, bytes);
  }
  return { files, manifest, withdrawals: requests };
}
