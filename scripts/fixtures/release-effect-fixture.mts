import assert from "node:assert/strict";
import {
  proposeImmutableReleaseTransition,
  type ReleasePublicationIdentity,
} from "../release-immutable-publication.mts";
import { releaseCanonicalDigest as digest } from "../release-canonical.mts";
import { inspectReleaseEffectExpectation } from "../release-effect-contract.mts";

/** Inert public intent data; never a publisher/admission receipt. */
export function releaseEffectFixture(
  checkpoint: string,
  identity: ReleasePublicationIdentity,
  suffix = "publish",
) {
  const selected = suffix.startsWith("upload:") ? suffix.slice(7) : null;
  const prior =
    suffix === "create-draft"
      ? []
      : identity.assets
          .filter((a) => a.filename !== selected)
          .map((a) => ({
            id: 500 + identity.assets.indexOf(a),
            name: a.filename,
            size: a.bytes,
            digest: `sha256:${a.sha256}`,
            state: "uploaded",
            url: `https://api.github.com/repos/boburning/portcove/releases/assets/${500 + identity.assets.indexOf(a)}`,
            browser_download_url: `https://github.com/boburning/portcove/releases/download/v${identity.version}/${a.filename}`,
          }));
  const release =
    suffix === "create-draft"
      ? null
      : {
          id: 321,
          tag_name: `v${identity.version}`,
          target_commitish: identity.source_commit,
          prerelease: identity.version.includes("-"),
          draft: true,
          immutable: false,
          url: "https://api.github.com/repos/boburning/portcove/releases/321",
          html_url: `https://github.com/boburning/portcove/releases/tag/v${identity.version}`,
          upload_url:
            "https://uploads.github.com/repos/boburning/portcove/releases/321/assets{?name,label}",
        };
  const next = proposeImmutableReleaseTransition(identity, release, prior);
  assert.equal(next.decision, "effect");
  if (next.decision !== "effect") throw new Error("fixture must propose an effect");
  return inspectReleaseEffectExpectation({
    before_checkpoint: checkpoint,
    effect: next.effect,
    effect_request_sha256: digest({ checkpoint, effect: next.effect }),
    identity: {
      version: identity.version,
      source_commit: identity.source_commit,
      assets: [...identity.assets].sort((a, b) => a.filename.localeCompare(b.filename)),
    },
    prior: {
      release_id: release?.id ?? null,
      assets: prior.map((a) => ({
        id: a.id,
        filename: a.name,
        bytes: a.size,
        sha256: a.digest.slice(7),
      })),
    },
  });
}
