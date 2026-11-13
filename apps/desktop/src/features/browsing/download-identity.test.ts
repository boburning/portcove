import { describe, expect, it } from "vite-plus/test";
import {
  assetKey,
  isAssetReference,
  isReleaseReference,
  matchingReferences,
  releaseKey,
  sameAsset,
  validPackageKey,
} from "./download-identity";
import type { CatalogDownloadCandidate } from "../../types";

const release = { provider: "gitlab" as const, project_id: 42, tag: "v1/日本" };
const asset = { ...release, link_id: 7, file_id: 17 };

describe("download provider identity", () => {
  it("preserves legacy keys and compares independently decoded foreign references", () => {
    expect(releaseKey(42)).toBe("42");
    expect(assetKey({ release_id: 42, asset_id: 7 } as CatalogDownloadCandidate)).toBe("42:7");
    const decoded: unknown = JSON.parse(JSON.stringify(asset));
    expect(isAssetReference(decoded)).toBe(true);
    if (!isAssetReference(decoded)) throw new Error("fixture identity failed to decode");
    expect(sameAsset(asset, decoded)).toBe(true);
    expect(sameAsset(asset, 7)).toBe(false);
    expect(sameAsset(asset, { ...asset, file_id: 18 })).toBe(false);
    expect(sameAsset(asset, { ...asset, project_id: 43 })).toBe(false);
    expect(sameAsset(undefined, undefined)).toBe(false);
    expect(matchingReferences(release, asset)).toBe(true);
    expect(matchingReferences(release, { ...asset, tag: "v2" })).toBe(false);
    expect(matchingReferences(42, asset)).toBe(false);
  });

  it("rejects coercion, unknown providers, extra fields and malformed tag text", () => {
    for (const value of [
      0,
      -1,
      1.5,
      "42",
      Number.MAX_SAFE_INTEGER + 1,
      { ...release, provider: "other" },
      { ...release, extra: 1 },
      { ...release, project_id: "42" },
      { ...release, tag: "" },
      { ...release, tag: "v1\n" },
      { ...release, tag: "\ud800" },
      { ...release, tag: "日".repeat(171) },
    ]) {
      expect(isReleaseReference(value)).toBe(false);
    }
    expect(isReleaseReference(release)).toBe(true);
    expect(isReleaseReference({ ...release, tag: "v1😀" })).toBe(true);
  });

  it("retains distinct canonical package keys without numeric conversion", () => {
    const key = assetKey({ release_id: release, asset_id: asset } as CatalogDownloadCandidate);
    expect(validPackageKey(key)).toBe(true);
    expect(validPackageKey(key, true)).toBe(false);
    expect(validPackageKey("42:7", true)).toBe(true);
    expect(validPackageKey("9007199254740992:7")).toBe(false);
    expect(validPackageKey('gitlab:[42,"v1",7]')).toBe(false);
    expect(validPackageKey('gitlab:["42","v1",7,17]')).toBe(false);
    expect(validPackageKey('gitlab:[42, "v1",7,17]')).toBe(false);
  });
});
