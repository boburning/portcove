import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import {
  type ScanDependencies,
  type UpstreamRelease,
  channelRelease,
  hintedAsset,
  parse7zTechnical,
  parseTarVerbose,
  parseUnsquashfs,
  scan,
  scanTargets,
} from "./release-content-scan.mts";

const listings = {
  listings: [
    {
      id: "code-only",
      project_url: "https://github.com/up/code",
      release_url: "https://github.com/up/code/releases",
      download_asset_hints: { "windows-x86-64": ["Code-", "-windows-x64.zip"] },
    },
    {
      id: "header",
      project_url: "https://github.com/up/header",
      download_asset_hints: { "linux-x86-64": ["release_Linux.zip"] },
      recommended_download_channel: "beta",
    },
    {
      id: "held",
      project_url: "https://github.com/up/held",
      download_block_reason: "Held.",
      download_asset_hints: { "windows-x86-64": ["x"] },
    },
    { id: "no-hints", project_url: "https://github.com/up/none" },
    {
      id: "gitlab",
      project_url: "https://gitlab.com/group/Project",
      release_url: "https://gitlab.com/group/Project/-/releases",
      download_asset_hints: { "windows-x86-64": ["Project-", "-Windows"] },
    },
  ],
};

void test("targets cover unheld hinted listings on GitHub and GitLab", () => {
  assert.deepEqual(
    scanTargets(listings).map((target) => [
      target.id,
      target.provider,
      target.repository,
      target.platform,
      target.channel,
    ]),
    [
      ["code-only", "github", "up/code", "windows-x86-64", "stable"],
      ["header", "github", "up/header", "linux-x86-64", "beta"],
      ["gitlab", "gitlab", "group/Project", "windows-x86-64", "stable"],
    ],
  );
});

void test("channel and hint selection skip drafts, prereleases, symbols and ambiguity", () => {
  const releases: UpstreamRelease[] = [
    { tag: "v3", draft: true, prerelease: false, assets: [] },
    { tag: "v2-beta", draft: false, prerelease: true, assets: [] },
    { tag: "v1", draft: false, prerelease: false, assets: [] },
  ];
  assert.equal(channelRelease(releases, "stable")?.tag, "v1");
  assert.equal(channelRelease(releases, "beta")?.tag, "v2-beta");
  const asset = (name: string) => ({
    name,
    url: `https://example.invalid/${name}`,
    size: 1,
    digest: null,
  });
  assert.equal(
    hintedAsset(
      [
        asset("Code-1-windows-x64.zip"),
        asset("Code-1-windows-x64-symbols.zip"),
        asset("Code-1-windows-x64.zip.sha256"),
      ],
      ["Code-", "-windows-x64.zip"],
    )?.name,
    "Code-1-windows-x64.zip",
  );
  assert.equal(hintedAsset([asset("a-win.zip"), asset("b-win.zip")], ["win.zip"]), undefined);
});

const header = Buffer.alloc(352);
Buffer.from("24ffae51699aa2213d84820a84e409ad", "hex").copy(header, 0xc0);

function fakes(calls: string[]): ScanDependencies {
  const releases: Record<string, UpstreamRelease[]> = {
    "up/code": [
      {
        tag: "v1",
        draft: false,
        prerelease: false,
        assets: [{ name: "Code-1-windows-x64.zip", url: "u1", size: 10, digest: "sha256:aa" }],
      },
    ],
    "up/header": [
      {
        tag: "v0.2",
        draft: false,
        prerelease: true,
        assets: [{ name: "release_Linux.zip", url: "u2", size: 10, digest: "sha256:bb" }],
      },
    ],
    "group/Project": [{ tag: "v9", draft: false, prerelease: false, assets: [] }],
  };
  return {
    async releases(target) {
      calls.push(`releases ${target.repository}`);
      return releases[target.repository] ?? [];
    },
    async download(asset, file) {
      calls.push(`download ${asset.name}`);
      await writeFile(file, asset.name);
    },
    async list(_file, name) {
      return name === "release_Linux.zip"
        ? [
            { path: "main", size: 70_000_000 },
            { path: "header.bin", size: 352 },
          ]
        : [{ path: "game.exe", size: 5_000_000 }];
    },
    async heads(_file, _name, entries) {
      return new Map(
        entries.filter((entry) => entry.path === "header.bin").map((entry) => [entry.path, header]),
      );
    },
  };
}

void test("a scan flags copied headers, records coverage and reuses its checkpoint", async () => {
  const calls: string[] = [];
  const targets = scanTargets(listings);
  const first = await scan(targets, new Map(), fakes(calls));
  assert.deepEqual(
    first.report.scanned.map((record) => [
      record.id,
      record.asset,
      record.signals.map((signal) => signal.kind),
    ]),
    [
      ["code-only", "Code-1-windows-x64.zip", []],
      ["header", "release_Linux.zip", ["cartridge-header"]],
    ],
  );
  assert.deepEqual(
    first.report.findings.map((record) => record.id),
    ["header"],
  );
  assert.deepEqual(first.report.unscanned, [
    { id: "gitlab", platform: "windows-x86-64", reason: "hints select no single asset in v9" },
  ]);
  const again: string[] = [];
  const second = await scan(targets, first.checkpoint, fakes(again));
  assert.equal(second.report.scanned.length, 0);
  assert.equal(second.report.reused, 2);
  assert.deepEqual(
    second.report.findings.map((record) => record.id),
    ["header"],
  );
  assert.ok(!again.some((call) => call.startsWith("download")));
});

void test("budgets leave assets for a later run without guessing their contents", async () => {
  const limited = await scan(scanTargets(listings), new Map(), fakes([]), { maxAssets: 1 });
  assert.equal(limited.report.scanned.length, 1);
  assert.ok(limited.report.unscanned.some((entry) => entry.reason.includes("asset budget")));
  const small = await scan(scanTargets(listings), new Map(), fakes([]), { maxAssetBytes: 5 });
  assert.equal(small.report.scanned.length, 0);
  assert.ok(
    small.report.unscanned.every(
      (entry) => !entry.reason.includes("budget") || entry.reason.includes("exceeds"),
    ),
  );
});

void test("listers' output parses into entries with sizes", () => {
  assert.deepEqual(
    parse7zTechnical("Path = a/b.bin\nSize = 352\nFolder = -\n\nPath = a\nSize = 0\nFolder = +\n"),
    [{ path: "a/b.bin", size: 352 }],
  );
  assert.deepEqual(
    parseTarVerbose(
      "-rw-r--r-- user/group 1584 2026-11-07 18:37 ./dir/firmware.bin\ndrwxr-xr-x user/group 0 2026-11-07 18:37 ./dir/\n",
    ),
    [{ path: "dir/firmware.bin", size: 1584 }],
  );
  assert.deepEqual(
    parseUnsquashfs(
      "drwxr-xr-x root/root 120 2026-11-07 18:37 squashfs-root\n-rwxr-xr-x root/root 42 2026-11-07 18:37 squashfs-root/usr/bin/game\n",
    ),
    [{ path: "usr/bin/game", size: 42 }],
  );
});

void test("the job summary leads with findings and lists unscanned targets", async () => {
  const { report } = await scan(scanTargets(listings), new Map(), fakes([]));
  const { summaryMarkdown } = await import("./release-content-scan.mts");
  const text = summaryMarkdown(report);
  assert.match(text, /Scanned 2 new package\(s\)/);
  assert.match(
    text,
    /`header` \(linux-x86-64\) v0\.2 `release_Linux\.zip`: header\.bin \(contains Nintendo's cartridge boot logo\)/,
  );
  assert.match(text, /`gitlab` \(windows-x86-64\): hints select no single asset in v9/);
});
