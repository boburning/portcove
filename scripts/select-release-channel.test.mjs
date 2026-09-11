import assert from "node:assert/strict";
import test from "node:test";

import { selectReleaseForChannel } from "./select-release-channel.mjs";

const releases = [
  {
    tag_name: "v2.0.0-beta.2",
    draft: false,
    prerelease: true,
    published_at: "2026-09-05T12:00:00Z",
  },
  {
    tag_name: "v2.0.0-beta.3",
    draft: true,
    prerelease: true,
    published_at: "2026-09-06T12:00:00Z",
  },
  {
    tag_name: "v1.5.0",
    draft: false,
    prerelease: false,
    published_at: "2026-08-01T12:00:00Z",
  },
  {
    tag_name: "v2.0.0-beta.1",
    draft: false,
    prerelease: true,
    published_at: "2026-09-01T12:00:00Z",
  },
];

test("selects the newest published preview without returning a draft or older stable", () => {
  assert.equal(selectReleaseForChannel(releases, "preview").tag_name, "v2.0.0-beta.2");
});

test("selects stable independently when a newer preview exists", () => {
  assert.equal(selectReleaseForChannel(releases, "stable"), null);
  const eligibility = {
    "v1.5.0": {
      version: "1.5.0",
      preview_eligible: true,
      production_eligible: true,
    },
  };
  assert.equal(selectReleaseForChannel(releases, "stable", { eligibility }).tag_name, "v1.5.0");
});

test("supports preview-only repositories and reports absent stable", () => {
  const previewOnly = releases.filter((release) => release.prerelease);
  assert.equal(selectReleaseForChannel(previewOnly, "preview").tag_name, "v2.0.0-beta.2");
  assert.equal(selectReleaseForChannel(previewOnly, "stable"), null);
});

test("rejects unknown channels", () => {
  assert.throws(() => selectReleaseForChannel(releases, "latest"), /unknown release channel/);
});

test("rejects a published channel candidate without a trustworthy publication timestamp", () => {
  const malformed = [
    {
      tag_name: "v2.0.0-beta.4",
      draft: false,
      prerelease: true,
      published_at: "not-a-date",
    },
  ];
  assert.throws(() => selectReleaseForChannel(malformed, "preview"), /invalid published timestamp/);
});
