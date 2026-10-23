import fadePin from "./upstream-health-fade-to-black.json" with { type: "json" };
import pinCases from "./upstream-health-pins.json" with { type: "json" };
import { isRecord } from "../runtime-values.mts";
import accountingCases from "./upstream-health-accounting-cases.json" with { type: "json" };
import type { ObserverRequestOptions } from "../upstream-observer.mts";
import type {
  HealthOptions,
  HealthFetch,
  HealthRequestOptions,
} from "../check-catalog-repositories.mts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { observationHash, validateObserverConfig } from "../upstream-observer.mts";
import {
  collectRepositoryHealth as collectRepositoryHealthWithPolicy,
  validateHealthAccountingPolicy,
} from "../check-catalog-repositories.mts";

export const config = validateObserverConfig(
  JSON.parse(
    await readFile(new URL("../../release/upstream-observer.json", import.meta.url), "utf8"),
  ),
);

export const reviewedAccounting = validateHealthAccountingPolicy(
  accountingCases.reviewedAccounting,
);

export const root = `https://api.github.com/repos/${config.repository}`;
export const time = "2026-09-09T12:00:00Z";
export const release = (id = 1, extra = {}) => ({
  id,
  tag_name: `v${id}.0.0`,
  draft: false,
  prerelease: false,
  created_at: time,
  published_at: time,
  ...extra,
});
export const asset = (id = 2, contents = "redistributable fixture one") => ({
  id,
  name: `fixture-${id}-windows.zip`,
  size: Buffer.byteLength(contents),
  state: "uploaded",
  digest: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
  browser_download_url: `https://github.com/${config.repository}/releases/download/v1.0.0/fixture-${id}-windows.zip`,
  created_at: time,
  updated_at: time,
});

interface FixtureReply {
  body: unknown;
  link?: string;
}
class FixtureReplies extends Map<string, FixtureReply> {
  override get(key: string): FixtureReply {
    return requiredFixture(super.get(key));
  }
}
interface FixtureOverrides {
  intercept?: (
    url: string,
    options: ObserverRequestOptions,
    count: number,
    replies: FixtureReplies,
  ) => Response | null | void | Promise<Response | null | void>;
}
export function requiredFixture<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null, "missing expected fixture");
  return value;
}
export function objectFixture(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
export function incrementFixtureId(value: unknown) {
  const object = objectFixture(value);
  assert.ok(typeof object.id === "number");
  object.id++;
}
export function arrayFixture(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
export function fixture(overrides: FixtureOverrides = {}) {
  const replies = new FixtureReplies([
    [
      root,
      {
        body: {
          id: config.repository_id,
          full_name: config.repository,
          archived: false,
        },
      },
    ],
    [`${root}/releases?per_page=100&page=1`, { body: [release()] }],
    [`${root}/releases/1/assets?per_page=100&page=1`, { body: [asset()] }],
  ]);
  const requests: { url: string; options: ObserverRequestOptions }[] = [];
  const fetch = async (url: string, options: ObserverRequestOptions) => {
    requests.push({ url, options });
    if (overrides.intercept) {
      const intercepted = await overrides.intercept(url, options, requests.length, replies);
      if (intercepted) return intercepted;
    }
    const reply = replies.get(url);
    assert.ok(reply, `Unexpected URL ${url}`);
    const etag = `"${observationHash(reply)}"`;
    if (options.headers["If-None-Match"] === etag) return new Response(null, { status: 304 });
    return new Response(JSON.stringify(reply.body), {
      headers: {
        "content-type": "application/json",
        etag,
        link: reply.link ?? "",
      },
    });
  };
  return { replies, requests, fetch };
}

export const project = async (observation: { facts_sha256: string }) => ({
  format: 1,
  port_id: config.port_id,
  repository_id: config.repository_id,
  facts_sha256: observation.facts_sha256,
  projections: [],
});

// #247 early slice: exact declared locations and six independent evidence roles.
export const healthPin = {
  version: "v1",
  url: "https://downloads.example.com/package.zip",
  size: 42,
  sha256: "a".repeat(64),
};
interface HealthTestPort {
  id: string;
  project_url?: string;
  upstream_status?: string;
  release: { provider?: string; repository?: string; direct?: Record<string, typeof healthPin> };
}
interface HealthTestCatalog {
  source_catalog: {
    qualification: {
      scope: { port_id: string; artifact_sha256: string; upstream_ref: string };
      kind: string;
      outcome: string;
      evidence_ids: string[];
      method?: string;
    }[];
  };
  ports: HealthTestPort[];
}
export const healthCatalog = (pin = healthPin): HealthTestCatalog => ({
  source_catalog: {
    qualification: [
      {
        scope: { port_id: "sample-port", artifact_sha256: "b".repeat(64), upstream_ref: "v0" },
        kind: "automated_lifecycle",
        outcome: "passed",
        evidence_ids: ["historical"],
      },
    ],
  },
  ports: [
    {
      id: "sample-port",
      project_url: "https://github.com/original/project",
      release: { provider: "direct-manifest", direct: { "windows-x86-64": { ...pin } } },
    },
  ],
});
export const healthTime = Date.parse("2026-10-08T12:00:00Z");
export const healthFetch: HealthFetch = async (url, _options) =>
  url.includes("/releases/tags/")
    ? new Response(
        JSON.stringify({ id: 3, tag_name: "v0", assets: [{ digest: `sha256:${"b".repeat(64)}` }] }),
        { headers: { "content-type": "application/json" } },
      )
    : url === healthPin.url
      ? new Response(null, { headers: { "content-length": String(healthPin.size) } })
      : new Response(JSON.stringify({ id: 1, full_name: "original/project", archived: false }), {
          headers: { "content-type": "application/json" },
        });

export interface HealthScopeFixture {
  id: string;
  summary: string;
  platforms: string[];
  adapter: string;
  project_url?: string;
  upstream_status?: string;
  source_profile?: string;
  release: {
    repository: string;
    provider?: string;
    sha256?: string;
    direct?: Record<string, typeof healthPin>;
  };
}
export const healthScopePort = (id: string, repository = `owner/${id}`): HealthScopeFixture => ({
  id,
  summary: "A native port.",
  platforms: ["windows-x86-64"],
  release: { repository },
  adapter: "owned",
});
export const healthScopeCatalog = <T,>(
  ...ports: T[]
): { schema_version: number; ports: T[]; source_catalog?: unknown } => ({
  schema_version: 2,
  ports,
});
export const change = (file = "crates/portcove-core/catalog/catalog.json", extra = {}) => ({
  oldPath: file,
  newPath: file,
  status: "M",
  oldMode: "100644",
  newMode: "100644",
  ...extra,
});
export const copy = <T,>(value: T): T => structuredClone(value);

// Generic monitoring tests use retained independent cases, not a changing live
// catalog/pin inventory. Explicit negative-policy cases still override this.
export function collectRepositoryHealth(catalog: unknown, options: HealthOptions = {}) {
  return collectRepositoryHealthWithPolicy(catalog, { reviewedAccounting, ...options });
}

export const pinMetadata = pinCases.pins;
// Independently retained complete public provider metadata; no accepted-byte claim.
pinMetadata.push({
  repository: {
    id: 1352788804,
    full_name: "alexbeavs-ps1-ports/armored-core-recomp",
    archived: false,
  },
  release: {
    id: 382786096,
    tag_name: "v0.3.6",
    draft: false,
    prerelease: false,
    created_at: "2026-09-04T11:49:26Z",
    published_at: "2026-09-04T14:48:29Z",
    assets: [
      {
        id: 544444024,
        name: "Armored-Core-Recomp-0.3.6-linux-x64.zip",
        size: 28046282,
        state: "uploaded",
        digest: "sha256:a8bb86eb739f10653c39f8cb3c83b59d4d8a7b3b837ea7b580667868c6698e6a",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/armored-core-recomp/releases/download/v0.3.6/Armored-Core-Recomp-0.3.6-linux-x64.zip",
        created_at: "2026-09-04T14:19:50Z",
        updated_at: "2026-09-04T14:19:52Z",
      },
      {
        id: 544444106,
        name: "Armored-Core-Recomp-0.3.6-macos-arm64.zip",
        size: 25791499,
        state: "uploaded",
        digest: "sha256:83f4f37a9d35119d00eb8f015f29fb25f2d628977835e4ab04545a8271b45740",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/armored-core-recomp/releases/download/v0.3.6/Armored-Core-Recomp-0.3.6-macos-arm64.zip",
        created_at: "2026-09-04T14:19:54Z",
        updated_at: "2026-09-04T14:19:56Z",
      },
      {
        id: 544444221,
        name: "Armored-Core-Recomp-0.3.6-macos-x64.zip",
        size: 26135526,
        state: "uploaded",
        digest: "sha256:99fe56d964b52d3d5c7fbd17cb8a5c655f76fef30fd4214d87ee212517fb5963",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/armored-core-recomp/releases/download/v0.3.6/Armored-Core-Recomp-0.3.6-macos-x64.zip",
        created_at: "2026-09-04T14:19:59Z",
        updated_at: "2026-09-04T14:20:00Z",
      },
      {
        id: 544444321,
        name: "Armored-Core-Recomp-0.3.6-windows-x64.zip",
        size: 30152526,
        state: "uploaded",
        digest: "sha256:43575a4795e5af42c3f545c245a073224d4e1a4643eaa59b3b2dba79c46e231e",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/armored-core-recomp/releases/download/v0.3.6/Armored-Core-Recomp-0.3.6-windows-x64.zip",
        created_at: "2026-09-04T14:20:03Z",
        updated_at: "2026-09-04T14:20:05Z",
      },
    ],
  },
  assets: [
    {
      id: 544444024,
      name: "Armored-Core-Recomp-0.3.6-linux-x64.zip",
      size: 28046282,
      state: "uploaded",
      digest: "sha256:a8bb86eb739f10653c39f8cb3c83b59d4d8a7b3b837ea7b580667868c6698e6a",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/armored-core-recomp/releases/download/v0.3.6/Armored-Core-Recomp-0.3.6-linux-x64.zip",
      created_at: "2026-09-04T14:19:50Z",
      updated_at: "2026-09-04T14:19:52Z",
    },
    {
      id: 544444106,
      name: "Armored-Core-Recomp-0.3.6-macos-arm64.zip",
      size: 25791499,
      state: "uploaded",
      digest: "sha256:83f4f37a9d35119d00eb8f015f29fb25f2d628977835e4ab04545a8271b45740",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/armored-core-recomp/releases/download/v0.3.6/Armored-Core-Recomp-0.3.6-macos-arm64.zip",
      created_at: "2026-09-04T14:19:54Z",
      updated_at: "2026-09-04T14:19:56Z",
    },
    {
      id: 544444221,
      name: "Armored-Core-Recomp-0.3.6-macos-x64.zip",
      size: 26135526,
      state: "uploaded",
      digest: "sha256:99fe56d964b52d3d5c7fbd17cb8a5c655f76fef30fd4214d87ee212517fb5963",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/armored-core-recomp/releases/download/v0.3.6/Armored-Core-Recomp-0.3.6-macos-x64.zip",
      created_at: "2026-09-04T14:19:59Z",
      updated_at: "2026-09-04T14:20:00Z",
    },
    {
      id: 544444321,
      name: "Armored-Core-Recomp-0.3.6-windows-x64.zip",
      size: 30152526,
      state: "uploaded",
      digest: "sha256:43575a4795e5af42c3f545c245a073224d4e1a4643eaa59b3b2dba79c46e231e",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/armored-core-recomp/releases/download/v0.3.6/Armored-Core-Recomp-0.3.6-windows-x64.zip",
      created_at: "2026-09-04T14:20:03Z",
      updated_at: "2026-09-04T14:20:05Z",
    },
  ],
});
// Independently retained Blood Omen v0.3.6 provider metadata; no accepted-byte claim.
pinMetadata.push({
  repository: {
    id: 1352791125,
    full_name: "alexbeavs-ps1-ports/blood-omen-legacy-of-kain-recomp",
    archived: false,
  },
  release: {
    id: 382786113,
    tag_name: "v0.3.6",
    draft: false,
    prerelease: false,
    created_at: "2026-09-04T11:49:26Z",
    published_at: "2026-09-04T14:48:30Z",
    assets: [
      {
        id: 544444045,
        name: "Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-linux-x64.zip",
        size: 28049902,
        state: "uploaded",
        digest: "sha256:7cbef94c5fc72a1dd1ecaad2afe48a40faf2381e3bb579b2f7bbdfb3a74f80fc",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/blood-omen-legacy-of-kain-recomp/releases/download/v0.3.6/Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-linux-x64.zip",
        created_at: "2026-09-04T14:19:51Z",
        updated_at: "2026-09-04T14:19:53Z",
      },
      {
        id: 544444163,
        name: "Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-macos-arm64.zip",
        size: 25793743,
        state: "uploaded",
        digest: "sha256:2554274350a93468cc7e120cfafb64553bc266d661aca56118989310898b369a",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/blood-omen-legacy-of-kain-recomp/releases/download/v0.3.6/Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-macos-arm64.zip",
        created_at: "2026-09-04T14:19:56Z",
        updated_at: "2026-09-04T14:19:58Z",
      },
      {
        id: 544444256,
        name: "Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-macos-x64.zip",
        size: 26139194,
        state: "uploaded",
        digest: "sha256:e126de5019ba1937a166912bde5f577be256429d8cabb219910f87e6d5c1887c",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/blood-omen-legacy-of-kain-recomp/releases/download/v0.3.6/Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-macos-x64.zip",
        created_at: "2026-09-04T14:20:01Z",
        updated_at: "2026-09-04T14:20:02Z",
      },
      {
        id: 544444399,
        name: "Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-windows-x64.zip",
        size: 30156064,
        state: "uploaded",
        digest: "sha256:8a829e5913943b45cf086416e15a4a614ad8ce5b8ca407bfb70736a4c68b1759",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/blood-omen-legacy-of-kain-recomp/releases/download/v0.3.6/Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-windows-x64.zip",
        created_at: "2026-09-04T14:20:06Z",
        updated_at: "2026-09-04T14:20:07Z",
      },
    ],
  },
  assets: [
    {
      id: 544444045,
      name: "Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-linux-x64.zip",
      size: 28049902,
      state: "uploaded",
      digest: "sha256:7cbef94c5fc72a1dd1ecaad2afe48a40faf2381e3bb579b2f7bbdfb3a74f80fc",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/blood-omen-legacy-of-kain-recomp/releases/download/v0.3.6/Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-linux-x64.zip",
      created_at: "2026-09-04T14:19:51Z",
      updated_at: "2026-09-04T14:19:53Z",
    },
    {
      id: 544444163,
      name: "Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-macos-arm64.zip",
      size: 25793743,
      state: "uploaded",
      digest: "sha256:2554274350a93468cc7e120cfafb64553bc266d661aca56118989310898b369a",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/blood-omen-legacy-of-kain-recomp/releases/download/v0.3.6/Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-macos-arm64.zip",
      created_at: "2026-09-04T14:19:56Z",
      updated_at: "2026-09-04T14:19:58Z",
    },
    {
      id: 544444256,
      name: "Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-macos-x64.zip",
      size: 26139194,
      state: "uploaded",
      digest: "sha256:e126de5019ba1937a166912bde5f577be256429d8cabb219910f87e6d5c1887c",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/blood-omen-legacy-of-kain-recomp/releases/download/v0.3.6/Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-macos-x64.zip",
      created_at: "2026-09-04T14:20:01Z",
      updated_at: "2026-09-04T14:20:02Z",
    },
    {
      id: 544444399,
      name: "Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-windows-x64.zip",
      size: 30156064,
      state: "uploaded",
      digest: "sha256:8a829e5913943b45cf086416e15a4a614ad8ce5b8ca407bfb70736a4c68b1759",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/blood-omen-legacy-of-kain-recomp/releases/download/v0.3.6/Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-windows-x64.zip",
      created_at: "2026-09-04T14:20:06Z",
      updated_at: "2026-09-04T14:20:07Z",
    },
  ],
});
// Independently retained Digimon World 2003 v0.3.6 provider metadata; no accepted-byte claim.
pinMetadata.push({
  repository: {
    id: 1352789057,
    full_name: "alexbeavs-ps1-ports/digimon-world-2003-recomp",
    archived: false,
  },
  release: {
    id: 382786572,
    tag_name: "v0.3.6",
    draft: false,
    prerelease: false,
    created_at: "2026-09-04T11:49:29Z",
    published_at: "2026-09-04T14:48:39Z",
    assets: [
      {
        id: 544445063,
        name: "Digimon-World-2003-Recomp-0.3.6-linux-x64.zip",
        size: 28046744,
        state: "uploaded",
        digest: "sha256:0538611d06da652482d035a5b97f356bc4bbae18728a34d27712772bb557bae8",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/digimon-world-2003-recomp/releases/download/v0.3.6/Digimon-World-2003-Recomp-0.3.6-linux-x64.zip",
        created_at: "2026-09-04T14:20:33Z",
        updated_at: "2026-09-04T14:20:37Z",
      },
      {
        id: 544445200,
        name: "Digimon-World-2003-Recomp-0.3.6-macos-arm64.zip",
        size: 25790678,
        state: "uploaded",
        digest: "sha256:d8c7adc1ae1737e76c625b46df1d3eab68de2f5cc33a94aff081c45ac1a97bb2",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/digimon-world-2003-recomp/releases/download/v0.3.6/Digimon-World-2003-Recomp-0.3.6-macos-arm64.zip",
        created_at: "2026-09-04T14:20:40Z",
        updated_at: "2026-09-04T14:20:42Z",
      },
      {
        id: 544445334,
        name: "Digimon-World-2003-Recomp-0.3.6-macos-x64.zip",
        size: 26136022,
        state: "uploaded",
        digest: "sha256:364cb136d8e435016b559feae8ecf0b895406897269263b8644b45954d13cfc3",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/digimon-world-2003-recomp/releases/download/v0.3.6/Digimon-World-2003-Recomp-0.3.6-macos-x64.zip",
        created_at: "2026-09-04T14:20:45Z",
        updated_at: "2026-09-04T14:20:46Z",
      },
      {
        id: 544445450,
        name: "Digimon-World-2003-Recomp-0.3.6-windows-x64.zip",
        size: 30152631,
        state: "uploaded",
        digest: "sha256:71f0fe285fe0d6cd34d61e3b286bbdda55eecd551487b8ee33648301a99c249b",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/digimon-world-2003-recomp/releases/download/v0.3.6/Digimon-World-2003-Recomp-0.3.6-windows-x64.zip",
        created_at: "2026-09-04T14:20:49Z",
        updated_at: "2026-09-04T14:20:51Z",
      },
    ],
  },
  assets: [
    {
      id: 544445063,
      name: "Digimon-World-2003-Recomp-0.3.6-linux-x64.zip",
      size: 28046744,
      state: "uploaded",
      digest: "sha256:0538611d06da652482d035a5b97f356bc4bbae18728a34d27712772bb557bae8",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/digimon-world-2003-recomp/releases/download/v0.3.6/Digimon-World-2003-Recomp-0.3.6-linux-x64.zip",
      created_at: "2026-09-04T14:20:33Z",
      updated_at: "2026-09-04T14:20:37Z",
    },
    {
      id: 544445200,
      name: "Digimon-World-2003-Recomp-0.3.6-macos-arm64.zip",
      size: 25790678,
      state: "uploaded",
      digest: "sha256:d8c7adc1ae1737e76c625b46df1d3eab68de2f5cc33a94aff081c45ac1a97bb2",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/digimon-world-2003-recomp/releases/download/v0.3.6/Digimon-World-2003-Recomp-0.3.6-macos-arm64.zip",
      created_at: "2026-09-04T14:20:40Z",
      updated_at: "2026-09-04T14:20:42Z",
    },
    {
      id: 544445334,
      name: "Digimon-World-2003-Recomp-0.3.6-macos-x64.zip",
      size: 26136022,
      state: "uploaded",
      digest: "sha256:364cb136d8e435016b559feae8ecf0b895406897269263b8644b45954d13cfc3",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/digimon-world-2003-recomp/releases/download/v0.3.6/Digimon-World-2003-Recomp-0.3.6-macos-x64.zip",
      created_at: "2026-09-04T14:20:45Z",
      updated_at: "2026-09-04T14:20:46Z",
    },
    {
      id: 544445450,
      name: "Digimon-World-2003-Recomp-0.3.6-windows-x64.zip",
      size: 30152631,
      state: "uploaded",
      digest: "sha256:71f0fe285fe0d6cd34d61e3b286bbdda55eecd551487b8ee33648301a99c249b",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/digimon-world-2003-recomp/releases/download/v0.3.6/Digimon-World-2003-Recomp-0.3.6-windows-x64.zip",
      created_at: "2026-09-04T14:20:49Z",
      updated_at: "2026-09-04T14:20:51Z",
    },
  ],
});
// Independently retained Duke Nukem: Land of the Babes v0.3.6 provider metadata; no accepted-byte claim.
pinMetadata.push({
  repository: {
    id: 1352788290,
    full_name: "alexbeavs-ps1-ports/duke-nukem-land-of-the-babes-recomp",
    archived: false,
  },
  release: {
    id: 382786775,
    tag_name: "v0.3.6",
    draft: false,
    prerelease: false,
    created_at: "2026-09-04T11:49:30Z",
    published_at: "2026-09-04T14:48:44Z",
    assets: [
      {
        id: 544445523,
        name: "Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-linux-x64.zip",
        size: 28048314,
        state: "uploaded",
        digest: "sha256:46a9b69d869bb7ae868e1d8b9943ae6902b7ba81733f0afc957da8ae9692ebad",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/duke-nukem-land-of-the-babes-recomp/releases/download/v0.3.6/Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-linux-x64.zip",
        created_at: "2026-09-04T14:20:53Z",
        updated_at: "2026-09-04T14:20:54Z",
      },
      {
        id: 544445636,
        name: "Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-macos-arm64.zip",
        size: 25792070,
        state: "uploaded",
        digest: "sha256:89c1649003e66032bc44ff5ac60d1d6ae9b4bccaddf58b4156a16d71cbe4d8cb",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/duke-nukem-land-of-the-babes-recomp/releases/download/v0.3.6/Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-macos-arm64.zip",
        created_at: "2026-09-04T14:20:57Z",
        updated_at: "2026-09-04T14:20:58Z",
      },
      {
        id: 544445706,
        name: "Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-macos-x64.zip",
        size: 26137531,
        state: "uploaded",
        digest: "sha256:5fc535897799e593c45090431f2c49da4c54e6fa194c9b8001ed0d41e95266e2",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/duke-nukem-land-of-the-babes-recomp/releases/download/v0.3.6/Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-macos-x64.zip",
        created_at: "2026-09-04T14:21:01Z",
        updated_at: "2026-09-04T14:21:02Z",
      },
      {
        id: 544445831,
        name: "Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-windows-x64.zip",
        size: 30154371,
        state: "uploaded",
        digest: "sha256:33a2bf033dd610b8f6d8afab2373b609b536a1253f15b78138fc6d37a2831c5b",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/duke-nukem-land-of-the-babes-recomp/releases/download/v0.3.6/Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-windows-x64.zip",
        created_at: "2026-09-04T14:21:05Z",
        updated_at: "2026-09-04T14:21:07Z",
      },
    ],
  },
  assets: [
    {
      id: 544445523,
      name: "Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-linux-x64.zip",
      size: 28048314,
      state: "uploaded",
      digest: "sha256:46a9b69d869bb7ae868e1d8b9943ae6902b7ba81733f0afc957da8ae9692ebad",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/duke-nukem-land-of-the-babes-recomp/releases/download/v0.3.6/Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-linux-x64.zip",
      created_at: "2026-09-04T14:20:53Z",
      updated_at: "2026-09-04T14:20:54Z",
    },
    {
      id: 544445636,
      name: "Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-macos-arm64.zip",
      size: 25792070,
      state: "uploaded",
      digest: "sha256:89c1649003e66032bc44ff5ac60d1d6ae9b4bccaddf58b4156a16d71cbe4d8cb",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/duke-nukem-land-of-the-babes-recomp/releases/download/v0.3.6/Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-macos-arm64.zip",
      created_at: "2026-09-04T14:20:57Z",
      updated_at: "2026-09-04T14:20:58Z",
    },
    {
      id: 544445706,
      name: "Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-macos-x64.zip",
      size: 26137531,
      state: "uploaded",
      digest: "sha256:5fc535897799e593c45090431f2c49da4c54e6fa194c9b8001ed0d41e95266e2",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/duke-nukem-land-of-the-babes-recomp/releases/download/v0.3.6/Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-macos-x64.zip",
      created_at: "2026-09-04T14:21:01Z",
      updated_at: "2026-09-04T14:21:02Z",
    },
    {
      id: 544445831,
      name: "Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-windows-x64.zip",
      size: 30154371,
      state: "uploaded",
      digest: "sha256:33a2bf033dd610b8f6d8afab2373b609b536a1253f15b78138fc6d37a2831c5b",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/duke-nukem-land-of-the-babes-recomp/releases/download/v0.3.6/Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-windows-x64.zip",
      created_at: "2026-09-04T14:21:05Z",
      updated_at: "2026-09-04T14:21:07Z",
    },
  ],
});
// Independently retained Driver v0.3.6 provider metadata; no accepted-byte claim.
pinMetadata.push({
  repository: {
    id: 1352790121,
    full_name: "alexbeavs-ps1-ports/driver-recomp",
    archived: false,
  },
  release: {
    id: 382786594,
    tag_name: "v0.3.6",
    draft: false,
    prerelease: false,
    created_at: "2026-09-04T11:49:29Z",
    published_at: "2026-09-04T14:48:39Z",
    assets: [
      {
        id: 544445102,
        name: "Driver-Recomp-0.3.6-linux-x64.zip",
        size: 28047869,
        state: "uploaded",
        digest: "sha256:35bb94181910a9fed63e48ef0e0bcc1e569befc9e19925c0bf29f12b0fabc7cd",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/driver-recomp/releases/download/v0.3.6/Driver-Recomp-0.3.6-linux-x64.zip",
        created_at: "2026-09-04T14:20:35Z",
        updated_at: "2026-09-04T14:20:37Z",
      },
      {
        id: 544445190,
        name: "Driver-Recomp-0.3.6-macos-arm64.zip",
        size: 25793364,
        state: "uploaded",
        digest: "sha256:b89e64216bc74505762eb9bf79cffe21415080aeb086ec70126f8bb965b64180",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/driver-recomp/releases/download/v0.3.6/Driver-Recomp-0.3.6-macos-arm64.zip",
        created_at: "2026-09-04T14:20:40Z",
        updated_at: "2026-09-04T14:20:41Z",
      },
      {
        id: 544445319,
        name: "Driver-Recomp-0.3.6-macos-x64.zip",
        size: 26138386,
        state: "uploaded",
        digest: "sha256:4ec37fa02646e44787ea0c4b2c8fe857fc0d0caa501615f0301b01f0d7b9b14b",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/driver-recomp/releases/download/v0.3.6/Driver-Recomp-0.3.6-macos-x64.zip",
        created_at: "2026-09-04T14:20:44Z",
        updated_at: "2026-09-04T14:20:46Z",
      },
      {
        id: 544445443,
        name: "Driver-Recomp-0.3.6-windows-x64.zip",
        size: 30154093,
        state: "uploaded",
        digest: "sha256:57d50b4065b1b680cb660029bb14db3f53d911516342e58fc16f59386aeba2ab",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/driver-recomp/releases/download/v0.3.6/Driver-Recomp-0.3.6-windows-x64.zip",
        created_at: "2026-09-04T14:20:48Z",
        updated_at: "2026-09-04T14:20:50Z",
      },
    ],
  },
  assets: [
    {
      id: 544445102,
      name: "Driver-Recomp-0.3.6-linux-x64.zip",
      size: 28047869,
      state: "uploaded",
      digest: "sha256:35bb94181910a9fed63e48ef0e0bcc1e569befc9e19925c0bf29f12b0fabc7cd",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/driver-recomp/releases/download/v0.3.6/Driver-Recomp-0.3.6-linux-x64.zip",
      created_at: "2026-09-04T14:20:35Z",
      updated_at: "2026-09-04T14:20:37Z",
    },
    {
      id: 544445190,
      name: "Driver-Recomp-0.3.6-macos-arm64.zip",
      size: 25793364,
      state: "uploaded",
      digest: "sha256:b89e64216bc74505762eb9bf79cffe21415080aeb086ec70126f8bb965b64180",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/driver-recomp/releases/download/v0.3.6/Driver-Recomp-0.3.6-macos-arm64.zip",
      created_at: "2026-09-04T14:20:40Z",
      updated_at: "2026-09-04T14:20:41Z",
    },
    {
      id: 544445319,
      name: "Driver-Recomp-0.3.6-macos-x64.zip",
      size: 26138386,
      state: "uploaded",
      digest: "sha256:4ec37fa02646e44787ea0c4b2c8fe857fc0d0caa501615f0301b01f0d7b9b14b",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/driver-recomp/releases/download/v0.3.6/Driver-Recomp-0.3.6-macos-x64.zip",
      created_at: "2026-09-04T14:20:44Z",
      updated_at: "2026-09-04T14:20:46Z",
    },
    {
      id: 544445443,
      name: "Driver-Recomp-0.3.6-windows-x64.zip",
      size: 30154093,
      state: "uploaded",
      digest: "sha256:57d50b4065b1b680cb660029bb14db3f53d911516342e58fc16f59386aeba2ab",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/driver-recomp/releases/download/v0.3.6/Driver-Recomp-0.3.6-windows-x64.zip",
      created_at: "2026-09-04T14:20:48Z",
      updated_at: "2026-09-04T14:20:50Z",
    },
  ],
});
// Independently retained Duke Nukem: Time to Kill v0.3.6 provider metadata; no accepted-byte claim.
pinMetadata.push({
  repository: {
    id: 1350730805,
    full_name: "alexbeavs-ps1-ports/duke-nukem-time-to-kill-recomp",
    archived: false,
  },
  release: {
    id: 382786779,
    tag_name: "v0.3.6",
    draft: false,
    prerelease: false,
    created_at: "2026-09-04T11:49:31Z",
    published_at: "2026-09-04T14:48:44Z",
    assets: [
      {
        id: 544445527,
        name: "Duke-Nukem-Time-to-Kill-Recomp-0.3.6-linux-x64.zip",
        size: 28051653,
        state: "uploaded",
        digest: "sha256:c2b421fe2214efecd6736d3f95636b44a6562f459965c7aee098b5cdebaeb1f3",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/duke-nukem-time-to-kill-recomp/releases/download/v0.3.6/Duke-Nukem-Time-to-Kill-Recomp-0.3.6-linux-x64.zip",
        created_at: "2026-09-04T14:20:53Z",
        updated_at: "2026-09-04T14:20:54Z",
      },
      {
        id: 544445640,
        name: "Duke-Nukem-Time-to-Kill-Recomp-0.3.6-macos-arm64.zip",
        size: 25795533,
        state: "uploaded",
        digest: "sha256:71481804b16e433688c43625556222fe79561e956bc5ed905911cb23644ee1d5",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/duke-nukem-time-to-kill-recomp/releases/download/v0.3.6/Duke-Nukem-Time-to-Kill-Recomp-0.3.6-macos-arm64.zip",
        created_at: "2026-09-04T14:20:57Z",
        updated_at: "2026-09-04T14:20:59Z",
      },
      {
        id: 544445718,
        name: "Duke-Nukem-Time-to-Kill-Recomp-0.3.6-macos-x64.zip",
        size: 26140959,
        state: "uploaded",
        digest: "sha256:e41aa8968e70c12c993561a671ccc08d64c2ff7d17fd6c1a0d3980389f86708f",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/duke-nukem-time-to-kill-recomp/releases/download/v0.3.6/Duke-Nukem-Time-to-Kill-Recomp-0.3.6-macos-x64.zip",
        created_at: "2026-09-04T14:21:01Z",
        updated_at: "2026-09-04T14:21:03Z",
      },
      {
        id: 544445845,
        name: "Duke-Nukem-Time-to-Kill-Recomp-0.3.6-windows-x64.zip",
        size: 30158026,
        state: "uploaded",
        digest: "sha256:6ac51ddf4db437fd10ec8ec1de73b66e34904b9b30bbcaf813266dba2997c662",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/duke-nukem-time-to-kill-recomp/releases/download/v0.3.6/Duke-Nukem-Time-to-Kill-Recomp-0.3.6-windows-x64.zip",
        created_at: "2026-09-04T14:21:05Z",
        updated_at: "2026-09-04T14:21:07Z",
      },
    ],
  },
  assets: [
    {
      id: 544445527,
      name: "Duke-Nukem-Time-to-Kill-Recomp-0.3.6-linux-x64.zip",
      size: 28051653,
      state: "uploaded",
      digest: "sha256:c2b421fe2214efecd6736d3f95636b44a6562f459965c7aee098b5cdebaeb1f3",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/duke-nukem-time-to-kill-recomp/releases/download/v0.3.6/Duke-Nukem-Time-to-Kill-Recomp-0.3.6-linux-x64.zip",
      created_at: "2026-09-04T14:20:53Z",
      updated_at: "2026-09-04T14:20:54Z",
    },
    {
      id: 544445640,
      name: "Duke-Nukem-Time-to-Kill-Recomp-0.3.6-macos-arm64.zip",
      size: 25795533,
      state: "uploaded",
      digest: "sha256:71481804b16e433688c43625556222fe79561e956bc5ed905911cb23644ee1d5",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/duke-nukem-time-to-kill-recomp/releases/download/v0.3.6/Duke-Nukem-Time-to-Kill-Recomp-0.3.6-macos-arm64.zip",
      created_at: "2026-09-04T14:20:57Z",
      updated_at: "2026-09-04T14:20:59Z",
    },
    {
      id: 544445718,
      name: "Duke-Nukem-Time-to-Kill-Recomp-0.3.6-macos-x64.zip",
      size: 26140959,
      state: "uploaded",
      digest: "sha256:e41aa8968e70c12c993561a671ccc08d64c2ff7d17fd6c1a0d3980389f86708f",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/duke-nukem-time-to-kill-recomp/releases/download/v0.3.6/Duke-Nukem-Time-to-Kill-Recomp-0.3.6-macos-x64.zip",
      created_at: "2026-09-04T14:21:01Z",
      updated_at: "2026-09-04T14:21:03Z",
    },
    {
      id: 544445845,
      name: "Duke-Nukem-Time-to-Kill-Recomp-0.3.6-windows-x64.zip",
      size: 30158026,
      state: "uploaded",
      digest: "sha256:6ac51ddf4db437fd10ec8ec1de73b66e34904b9b30bbcaf813266dba2997c662",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/duke-nukem-time-to-kill-recomp/releases/download/v0.3.6/Duke-Nukem-Time-to-Kill-Recomp-0.3.6-windows-x64.zip",
      created_at: "2026-09-04T14:21:05Z",
      updated_at: "2026-09-04T14:21:07Z",
    },
  ],
});
pinMetadata.push(fadePin);
export const currentHealthCatalog = accountingCases.catalog;
export const accountingCatalog = () => ({
  ports: structuredClone(
    currentHealthCatalog.ports.filter((port) =>
      [...reviewedAccounting.pins, ...reviewedAccounting.original_conditions].some(
        (rule) => rule.port_id === port.id,
      ),
    ),
  ),
});

export interface AccountingReply {
  status?: number;
  data: unknown;
  headers?: Record<string, string>;
}
export type HealthCall = { url: string; options: HealthRequestOptions };
export function accountingFetch(
  calls: HealthCall[],
  mutate: (url: string, response: AccountingReply) => AccountingReply = (_url, response) =>
    response,
): HealthFetch {
  return async (url, options) => {
    calls.push({ url, options });
    let response: AccountingReply | undefined;
    const pin = reviewedAccounting.pins.find((rule) => rule.url === url);
    const condition = reviewedAccounting.original_conditions.find(
      (rule) => url === `https://api.github.com/repos/${rule.repository}`,
    );
    if (pin)
      response = {
        status: 302,
        data: null,
        headers: { location: "https://example.invalid/signed?secret=synthetic-private-value" },
      };
    else if (condition)
      response = {
        status: condition.http_status,
        data:
          condition.http_status === 301
            ? {
                message: "Moved Permanently",
                url: `https://api.github.com/repositories/${condition.redirect_repository_id}`,
              }
            : { message: "Not Found" },
      };
    else {
      for (let i = 0; i < reviewedAccounting.pins.length; i++) {
        const rule = requiredFixture(reviewedAccounting.pins[i]),
          fixture = requiredFixture(pinMetadata[i]),
          prefix = `https://api.github.com/repos/${rule.repository}`;
        if (url === prefix) response = { data: structuredClone(fixture.repository) };
        else if (url === `${prefix}/releases/tags/${encodeURIComponent(rule.tag)}`)
          response = { data: structuredClone(fixture.release) };
        else if (url === `${prefix}/releases/${rule.release_id}/assets?per_page=100`)
          response = { data: structuredClone(fixture.assets) };
      }
    }
    assert.ok(response, `unexpected fixed request ${url}`);
    response = mutate(url, response);
    return new Response(response.data === null ? null : JSON.stringify(response.data), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json", ...response.headers },
    });
  };
}

export const capacityPort = (id: string) => ({
  id,
  release: { provider: "github", repository: `fixture/${id}` },
});
export const capacityFetch =
  (calls: HealthCall[]): HealthFetch =>
  async (url, options) => {
    calls.push({ url, options });
    return new Response(
      JSON.stringify({
        id: 42,
        full_name: url.slice("https://api.github.com/repos/".length),
        archived: false,
      }),
      { headers: { "content-type": "application/json" } },
    );
  };

export function sourceArchiveFixture(parents = ["3".repeat(40), "4".repeat(40)]) {
  const repository = { id: 567, full_name: "fixture/source", archived: false };
  const sha = "1".repeat(40),
    tree = "2".repeat(40);
  const api = `https://api.github.com/repos/${repository.full_name}/git`;
  const html = `https://github.com/${repository.full_name}/commit`;
  const commit = {
    sha,
    url: `${api}/commits/${sha}`,
    html_url: `${html}/${sha}`,
    tree: { sha: tree, url: `${api}/trees/${tree}` },
    parents: parents.map((value) => ({
      sha: value,
      url: `${api}/commits/${value}`,
      html_url: `${html}/${value}`,
    })),
  };
  const port = {
    id: "source-archive",
    project_url: `https://github.com/${repository.full_name}`,
    release: {
      provider: "direct-manifest",
      direct: {
        windows: {
          url: `https://github.com/${repository.full_name}/archive/${sha}.zip`,
          version: "source-pinned",
          size: 10,
          sha256: "a".repeat(64),
        },
      },
    },
  };
  const scope = {
    port_id: port.id,
    port_contract_sha256: observationHash(port),
    platform: "windows",
    ...port.release.direct.windows,
    repository: repository.full_name,
    repository_id: repository.id,
    archived: false,
    commit_sha: sha,
    tree_sha: tree,
    commit_facts_sha256: observationHash({ sha, tree_sha: tree, parents }),
  };
  const { version: _version, ...rule } = scope;
  return { repository, commit, port, rule, api: api.slice(0, -4) };
}
export function sourceArchivePolicy(fixture = sourceArchiveFixture()) {
  return {
    format_version: 1,
    authority: "fixture metadata only",
    decision: "independent synthetic case",
    pins: [],
    original_conditions: [],
    source_archives: [structuredClone(fixture.rule)],
  };
}
export function sourceArchiveFetch(
  fixture: ReturnType<typeof sourceArchiveFixture>,
  calls: HealthCall[],
): HealthFetch {
  return async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, "manual");
    if (url === fixture.rule.url) {
      assert.equal(options.method, "HEAD");
      assert.equal(options.headers.Authorization, undefined);
      return new Response(null, {
        status: 302,
        headers: { location: "https://untrusted.invalid/private-signed-url" },
      });
    }
    const body =
      url === fixture.api
        ? fixture.repository
        : url === `${fixture.api}/git/commits/${fixture.rule.commit_sha}`
          ? fixture.commit
          : null;
    assert.ok(body, `unexpected source metadata request ${url}`);
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
}
