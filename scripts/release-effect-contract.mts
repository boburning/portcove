/** Public intent data only; matching these bytes never grants execution authority. */
import assert from "node:assert/strict";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { classifyApplicationVersion } from "../apps/desktop/scripts/release-version-policy.mts";

function exact(raw: unknown, keys: string): asserts raw is Record<string, unknown> {
  assert.ok(
    isRecord(raw) && Object.keys(raw).sort().join(",") === keys,
    "Release intent schema differs",
  );
}
function sha(raw: unknown, length = 64): asserts raw is string {
  assert.ok(typeof raw === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(raw));
}
function positive(raw: unknown): asserts raw is number {
  assert.ok(typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0);
}
export function inspectReleaseEffectExpectation(raw: unknown) {
  exact(raw, "before_checkpoint,effect,effect_request_sha256,identity,prior");
  sha(raw.before_checkpoint, 40);
  sha(raw.effect_request_sha256);
  exact(raw.identity, "assets,source_commit,version");
  sha(raw.identity.source_commit, 40);
  assert.equal(typeof raw.identity.version, "string");
  const version = String(raw.identity.version);
  const versionKind = classifyApplicationVersion(version);
  const source_commit = raw.identity.source_commit;
  assert.ok(
    Array.isArray(raw.identity.assets) &&
      raw.identity.assets.length > 0 &&
      raw.identity.assets.length <= 32,
  );
  const assets = raw.identity.assets.map((item: unknown) => {
    exact(item, "bytes,filename,sha256");
    assert.ok(
      typeof item.filename === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._+-]{0,200}$/u.test(item.filename),
    );
    positive(item.bytes);
    assert.ok(item.bytes <= 512 * 1024 ** 2);
    sha(item.sha256);
    return { filename: item.filename, bytes: item.bytes, sha256: item.sha256 };
  });
  assert.ok(assets.reduce((sum, a) => sum + a.bytes, 0) <= 2 * 1024 ** 3);
  assert.equal(
    digest(assets),
    digest([...assets].sort((a, b) => a.filename.localeCompare(b.filename))),
    "Release inventory order differs",
  );
  assert.equal(new Set(assets.map((a) => a.filename.toLowerCase())).size, assets.length);
  exact(raw.prior, "assets,release_id");
  if (raw.prior.release_id !== null) positive(raw.prior.release_id);
  assert.ok(Array.isArray(raw.prior.assets) && raw.prior.assets.length <= assets.length);
  const priorAssets = raw.prior.assets.map((item: unknown) => {
    exact(item, "bytes,filename,id,sha256");
    positive(item.id);
    const expected = assets.find((a) => a.filename === item.filename);
    assert.ok(expected && expected.bytes === item.bytes && expected.sha256 === item.sha256);
    return { id: item.id, ...expected };
  });
  assert.equal(new Set(priorAssets.map((a) => a.id)).size, priorAssets.length);
  assert.equal(new Set(priorAssets.map((a) => a.filename)).size, priorAssets.length);
  const prefix = `github-release:boburning/portcove:v${version}:`;
  const base = "repos/boburning/portcove";
  assert.ok(isRecord(raw.effect));
  const common = { tag: `v${version}` };
  let effect: Record<string, unknown>;
  if (raw.effect.kind === "create-draft") {
    assert.equal(raw.prior.release_id, null);
    assert.equal(priorAssets.length, 0);
    effect = {
      ...common,
      kind: "create-draft",
      destination: `${prefix}create-draft`,
      method: "POST",
      endpoint: `${base}/releases`,
      body: {
        tag_name: `v${version}`,
        target_commitish: source_commit,
        name: `v${version}`,
        draft: true,
        prerelease: versionKind.github_prerelease,
        make_latest: "false",
      },
    };
  } else {
    positive(raw.prior.release_id);
    const release_id = raw.prior.release_id;
    const missing = assets.filter((a) => !priorAssets.some((old) => old.filename === a.filename));
    if (raw.effect.kind === "upload-asset") {
      const asset = missing[0];
      assert.ok(asset, "upload requires the exact first missing asset");
      effect = {
        ...common,
        kind: "upload-asset",
        destination: `${prefix}upload:${asset.filename}`,
        method: "POST",
        endpoint: `https://uploads.github.com/${base}/releases/${release_id}/assets?name=${encodeURIComponent(asset.filename)}`,
        release_id,
        asset,
      };
    } else {
      assert.equal(raw.effect.kind, "publish-draft");
      assert.equal(missing.length, 0);
      effect = {
        ...common,
        kind: "publish-draft",
        destination: `${prefix}publish`,
        asset_set_sha256: digest(assets),
        method: "PATCH",
        endpoint: `${base}/releases/${release_id}`,
        release_id,
        body: { draft: false, make_latest: "false" },
      };
    }
  }
  assert.equal(digest(raw.effect), digest(effect), "Release effect differs from exact preimage");
  assert.equal(
    raw.effect_request_sha256,
    digest({ checkpoint: raw.before_checkpoint, effect }),
    "Release effect request digest differs",
  );
  return {
    before_checkpoint: raw.before_checkpoint,
    effect_request_sha256: raw.effect_request_sha256,
    identity: { version, source_commit, assets },
    prior: { release_id: raw.prior.release_id, assets: priorAssets },
    effect,
  };
}

export function assertReleaseEffectBinding(
  raw: unknown,
  checkpoint: string,
  candidate: unknown,
  destination: string,
) {
  const value = inspectReleaseEffectExpectation(raw);
  assert.ok(isRecord(candidate));
  assert.equal(value.before_checkpoint, checkpoint);
  assert.equal(value.identity.version, candidate.version);
  assert.equal(value.identity.source_commit, candidate.prepared_commit);
  assert.equal(value.effect.destination, destination);
  return value;
}
