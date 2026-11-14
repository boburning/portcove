import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  type Runner,
  type ScanDependencies,
  type UpstreamRelease,
  RECORDED_FAILURES,
  ScanError,
  hostedDependencies,
  main,
  readCheckpoint,
  SIGNAL_CAP,
  accountingFor,
  cappedSignals,
  readAccounting,
  summaryMarkdown,
  channelRelease,
  listerFailure,
  permanentRelease,
  targetsDigest,
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
        assets: [{ name: "Code-1-windows-x64.zip", url: "u1", size: 10, digest: null }],
      },
    ],
    "up/header": [
      {
        tag: "v0.2",
        draft: false,
        prerelease: true,
        assets: [{ name: "release_Linux.zip", url: "u2", size: 10, digest: null }],
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
    {
      id: "gitlab",
      platform: "windows-x86-64",
      code: "no-single-asset",
      reason: "hints select no single asset in v9",
    },
  ]);
  assert.deepEqual(first.report.reused_targets, []);
  const again: string[] = [];
  const second = await scan(targets, first.checkpoint, fakes(again));
  assert.equal(second.report.scanned.length, 0);
  assert.equal(second.report.reused, 2);
  // Every reused target is named, so a consumer can account for each target.
  assert.deepEqual(
    second.report.reused_targets.map(({ id, platform, key }) => [
      id,
      platform,
      key === first.report.scanned.find((record) => record.id === id)?.key,
    ]),
    [
      ["code-only", "windows-x86-64", true],
      ["header", "linux-x86-64", true],
    ],
  );
  assert.deepEqual(
    second.report.findings.map((record) => record.id),
    ["header"],
  );
  assert.ok(!again.some((call) => call.startsWith("download")));
});

void test("budgets leave assets for a later run without guessing their contents", async () => {
  const limited = await scan(scanTargets(listings), new Map(), fakes([]), { maxAssets: 1 });
  assert.equal(limited.report.scanned.length, 1);
  assert.ok(limited.report.unscanned.some((entry) => entry.reason.includes("budget reached")));
  assert.deepEqual(
    limited.report.unscanned.map(({ id, code }) => [id, code]),
    [
      ["header", "asset-budget"],
      ["gitlab", "no-single-asset"],
    ],
  );
  const small = await scan(scanTargets(listings), new Map(), fakes([]), { maxAssetBytes: 5 });
  assert.equal(small.report.scanned.length, 0);
  assert.ok(
    small.report.unscanned.every(
      (entry) => !entry.reason.includes("budget") || entry.reason.includes("exceeds"),
    ),
  );
  // An asset over the per-asset limit is never scanned under these limits, unlike a spent budget.
  assert.deepEqual(
    small.report.unscanned.map(({ code }) => code),
    ["asset-too-large", "asset-too-large", "no-single-asset"],
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
    [{ path: "dir/firmware.bin", size: 1584, member: "./dir/firmware.bin" }],
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

void test("member names that look like options, list files or wildcards are never passed to a lister", async () => {
  const { safeMember } = await import("./release-content-scan.mts");
  assert.ok(safeMember("dir/header.bin"));
  for (const name of [
    "--use-compress-program=sh",
    "-ao",
    "@list.txt",
    "a*.bin",
    "b?.bin",
    "c[1].bin",
  ])
    assert.equal(safeMember(name), false, name);
});

void test("tar listings keep the raw member name for extraction", () => {
  assert.deepEqual(parseTarVerbose("-rw-r--r-- u/g 352 2026-11-07 18:37 ./d/header.bin\n"), [
    { path: "d/header.bin", size: 352, member: "./d/header.bin" },
  ]);
});

void test("failed downloads spend the asset and byte budgets and the deadline stops the run", async () => {
  const failing: ScanDependencies = {
    ...fakes([]),
    async download(asset, file) {
      await writeFile(file, Buffer.alloc(8));
      throw new Error(`transfer of ${asset.name} failed`);
    },
  };
  const spent = await scan(scanTargets(listings), new Map(), failing, { maxAssets: 1 });
  assert.equal(spent.report.scanned.length, 0);
  assert.deepEqual(
    spent.report.unscanned.map((entry) => entry.reason.split(":")[0]),
    [
      "asset Code-1-windows-x64.zip could not be scanned",
      "asset or byte budget reached; scanned in a later run",
      "hints select no single asset in v9",
    ],
  );
  const bytes = await scan(scanTargets(listings), new Map(), failing, { maxTotalBytes: 12 });
  assert.deepEqual(
    bytes.report.unscanned.map((entry) => entry.reason.includes("budget")),
    [false, true, false],
  );
  assert.deepEqual(
    bytes.report.unscanned.map(({ code }) => code),
    ["scan-failed", "asset-budget", "no-single-asset"],
  );
  let now = 0;
  const late = await scan(scanTargets(listings), new Map(), fakes([]), {
    deadline: 1,
    clock: () => now++,
  });
  assert.equal(late.report.scanned.length, 1);
  assert.ok(late.report.unscanned.every((entry) => entry.reason.startsWith("time budget")));
  assert.ok(late.report.unscanned.every(({ code }) => code === "time-budget"));
});

void test("a published digest that differs from the bytes is not scanned", async () => {
  const deps = fakes([]);
  const mismatched: ScanDependencies = {
    ...deps,
    async releases(target) {
      return (await deps.releases(target)).map((release) => ({
        ...release,
        assets: release.assets.map((asset) => ({ ...asset, digest: `sha256:${"0".repeat(64)}` })),
      }));
    },
  };
  const result = await scan(scanTargets(listings), new Map(), mismatched);
  assert.equal(result.report.scanned.length, 0);
  assert.ok(result.report.unscanned.some((entry) => entry.reason.includes("published digest")));
  // The same bytes would differ again: not retried.
  assert.ok(result.report.unscanned.some(({ code }) => code === "digest-mismatch"));
});

void test("the report counts every target and binds the list by digest", async () => {
  const targets = scanTargets(listings);
  const { report } = await scan(targets, new Map(), fakes([]));
  assert.equal(report.format_version, 3);
  assert.equal(report.targets, 3);
  assert.equal(report.targets_sha256, targetsDigest([...targets].reverse()));
  assert.notEqual(report.targets_sha256, targetsDigest(targets.slice(1)));
  assert.equal(
    report.scanned.length + report.reused_targets.length + report.unscanned.length,
    report.targets,
  );
  const empty = await scan([], new Map(), fakes([]));
  assert.equal(empty.report.targets, 0);
});

void test("deterministic failures are persistent codes; transient ones stay deferred", async () => {
  const deps = fakes([]);
  const failing = (overrides: Partial<ScanDependencies>, options = {}) =>
    scan(scanTargets(listings), new Map(), { ...deps, ...overrides }, options).then(({ report }) =>
      report.unscanned.map(({ id, code }) => [id, code]),
    );
  // A redirect, 404 or 410 is the provider's answer for this release; 5xx and 403 may pass.
  assert.deepEqual([301, 302, 404, 410].map(permanentRelease), [true, true, true, true]);
  assert.deepEqual([200, 403, 429, 500, 503].map(permanentRelease), [
    false,
    false,
    false,
    false,
    false,
  ]);
  assert.deepEqual(
    await failing({
      async releases(target) {
        if (target.repository === "up/code")
          throw new ScanError("release-unavailable", "301 from api.github.com");
        if (target.repository === "up/header") throw new Error("fetch failed");
        return deps.releases(target);
      },
    }),
    [
      ["code-only", "release-unavailable"],
      ["header", "release-read-failed"],
      ["gitlab", "no-single-asset"],
    ],
  );
  // A transfer over the per-asset cap is final; one cut by a smaller remaining budget is retried.
  const tooLarge: Partial<ScanDependencies> = {
    async download(_asset, file, maxBytes) {
      await writeFile(file, "x");
      throw new ScanError("asset-too-large", `the transfer exceeds ${maxBytes} bytes`);
    },
  };
  assert.deepEqual(await failing(tooLarge), [
    ["code-only", "asset-too-large"],
    ["header", "asset-too-large"],
    ["gitlab", "no-single-asset"],
  ]);
  assert.deepEqual(
    (await failing(tooLarge, { maxTotalBytes: 50, maxAssetBytes: 1000 })).map(([, code]) => code),
    ["asset-budget", "asset-budget", "no-single-asset"],
  );
  for (const code of ["encrypted-archive", "unlistable"] as const)
    assert.deepEqual(
      await failing({
        async list() {
          throw new ScanError(code, "lister refused");
        },
      }),
      [
        ["code-only", code],
        ["header", code],
        ["gitlab", "no-single-asset"],
      ],
    );
  assert.deepEqual(
    (
      await failing({
        async list() {
          throw new Error("unexpected");
        },
      })
    ).map(([, code]) => code),
    ["scan-failed", "scan-failed", "no-single-asset"],
  );
});

void test("a persistent download failure is remembered and not fetched again for the same release", async () => {
  const calls: string[] = [];
  const deps = fakes(calls);
  const encrypted: ScanDependencies = {
    ...deps,
    async list(file, name, stopAt) {
      if (name === "release_Linux.zip") throw new ScanError("encrypted-archive", "password");
      return deps.list(file, name, stopAt);
    },
  };
  const targets = scanTargets(listings);
  const first = await scan(targets, new Map(), encrypted);
  assert.deepEqual(
    [...first.failures.values()].map(({ code }) => code),
    ["encrypted-archive"],
  );
  calls.length = 0;
  const second = await scan(targets, first.checkpoint, encrypted, { failures: first.failures });
  assert.ok(!calls.includes("download release_Linux.zip"), "not downloaded again");
  assert.deepEqual(
    second.report.unscanned.map(({ id, code }) => [id, code]),
    [
      ["header", "encrypted-archive"],
      ["gitlab", "no-single-asset"],
    ],
  );
  // An unlistable package is persistent for coverage but remembered as a retry, since a
  // lister or environment fault can cause it; re-checks spend only their own allowance.
  assert.deepEqual(
    [...RECORDED_FAILURES],
    ["asset-too-large", "digest-mismatch", "encrypted-archive"],
  );
  let listable = false;
  const unlistable: ScanDependencies = {
    ...deps,
    async list(file, name, stopAt) {
      if (name === "Code-1-windows-x64.zip" && !listable)
        throw new ScanError("unlistable", "lister exited with status 2");
      return deps.list(file, name, stopAt);
    },
  };
  const firstUnlistable = await scan(targets, new Map(), unlistable, { maxAssets: 1 });
  assert.equal(firstUnlistable.failures.size, 0);
  assert.equal(firstUnlistable.retries.size, 1);
  assert.deepEqual(
    firstUnlistable.report.unscanned.map(({ id, code }) => [id, code]),
    [
      ["code-only", "unlistable"],
      ["header", "asset-budget"],
      ["gitlab", "no-single-asset"],
    ],
  );
  calls.length = 0;
  const again = await scan(targets, firstUnlistable.checkpoint, unlistable, {
    failures: firstUnlistable.failures,
    retries: firstUnlistable.retries,
    maxAssets: 1,
  });
  assert.ok(calls.includes("download Code-1-windows-x64.zip"), "re-checked");
  // The re-check never takes the main budget: the other target is scanned, not deferred.
  assert.deepEqual(
    again.report.scanned.map(({ id }) => id),
    ["header"],
  );
  assert.deepEqual(
    again.report.unscanned.map(({ id, code }) => [id, code]),
    [
      ["code-only", "unlistable"],
      ["gitlab", "no-single-asset"],
    ],
  );
  assert.deepEqual([...again.retries], [...firstUnlistable.retries]);
  // A spent allowance defers only the re-check, with its own code.
  const spentRetries = await scan(targets, new Map(), unlistable, {
    retries: firstUnlistable.retries,
    maxRetryAssets: 1,
    maxRetryBytes: 5,
  });
  assert.deepEqual(
    spentRetries.report.unscanned.map(({ id, code }) => [id, code]),
    [
      ["code-only", "retry-budget"],
      ["gitlab", "no-single-asset"],
    ],
  );
  assert.deepEqual([...spentRetries.retries], [...firstUnlistable.retries], "still remembered");
  // A re-check that now lists cleanly becomes an ordinary scanned record.
  listable = true;
  const fixed = await scan(targets, again.checkpoint, unlistable, {
    retries: again.retries,
    maxAssets: 0,
  });
  assert.deepEqual(
    fixed.report.scanned.map(({ id }) => id),
    ["code-only"],
  );
  assert.equal(fixed.retries.size, 0);
  // A transient failure is never remembered.
  const transient = await scan(targets, new Map(), {
    ...deps,
    async list() {
      throw new Error("lister timed out");
    },
  });
  assert.equal(transient.failures.size, 0);
  // An asset over the per-asset limit is retried once the limit is raised.
  const tooLarge = await scan(
    targets,
    new Map(),
    {
      ...deps,
      async download(_asset, file) {
        await writeFile(file, "x");
        throw new ScanError("asset-too-large", "over the limit");
      },
    },
    { maxAssetBytes: 100 },
  );
  calls.length = 0;
  await scan(targets, new Map(), deps, { failures: tooLarge.failures, maxAssetBytes: 100 });
  assert.ok(!calls.some((call) => call.startsWith("download")));
  await scan(targets, new Map(), deps, { failures: tooLarge.failures, maxAssetBytes: 200 });
  assert.ok(calls.some((call) => call.startsWith("download")));
});

void test("a lister that exits non-zero cannot read the archive; a timeout or missing tool is retried", () => {
  const exited = (code: unknown, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error("Command failed"), { code, killed: false, signal: null, ...extra });
  const codeOf = (error: unknown) => (error instanceof ScanError ? error.code : "deferred");
  assert.equal(codeOf(listerFailure(exited(2))), "unlistable");
  assert.equal(
    codeOf(
      listerFailure(
        exited(2, { stderr: "ERROR: a.7z : Cannot open encrypted archive. Wrong password?" }),
        true,
      ),
    ),
    "encrypted-archive",
  );
  // Only 7z's own password message marks an archive encrypted.
  assert.equal(
    codeOf(listerFailure(exited(2, { stderr: "encrypted member" }), false)),
    "unlistable",
  );
  assert.equal(
    codeOf(listerFailure(exited(null, { killed: true, signal: "SIGKILL" }))),
    "deferred",
  );
  assert.equal(codeOf(listerFailure(exited("ENOENT"))), "deferred");
  assert.equal(codeOf(listerFailure(new Error("time budget reached"))), "deferred");
});

void test("records carry the rules version and partial reads", async () => {
  const { RULES_VERSION } = await import("./release-content-signals.mts");
  const { report } = await scan(scanTargets(listings), new Map(), fakes([]));
  for (const record of report.scanned) {
    assert.equal(record.rules, RULES_VERSION);
    assert.ok(record.key.startsWith(`r${RULES_VERSION}|`));
    assert.equal(record.heads_truncated, false);
  }
  assert.equal(report.scanned.find((record) => record.id === "code-only")?.heads_unread, 0);
});

void test("every external call is capped at the run's deadline", async () => {
  const { callTimeout, escapeCommand } = await import("./release-content-scan.mts");
  assert.equal(callTimeout(300_000, 1_000_000, 900_000), 100_000);
  assert.equal(callTimeout(300_000, Number.POSITIVE_INFINITY, 0), 300_000);
  assert.throws(() => callTimeout(300_000, 1000, 1000), /time budget reached/);
  assert.equal(escapeCommand("a%b\r\n::stop-commands::x"), "a%25b%0D%0A::stop-commands::x");
});

void test("a package whose reads the deadline cut is retried instead of recorded as clean", async () => {
  let now = 0;
  const deps = fakes([]);
  const slow: ScanDependencies = {
    ...deps,
    async heads() {
      now = 10;
      return new Map();
    },
    async list() {
      return [{ path: "data.bin", size: 100 }];
    },
  };
  const { report, checkpoint } = await scan(scanTargets(listings), new Map(), slow, {
    deadline: 5,
    clock: () => now,
  });
  assert.equal(report.scanned.length, 0);
  assert.equal(checkpoint.size, 0);
  assert.ok(report.unscanned.some((entry) => entry.reason.includes("cut by the time budget")));
  assert.ok(report.unscanned.some(({ code }) => code === "time-cut"));
});

void test("the hosted release read reports a redirect, 404 or 410 as unavailable without following it", async (context) => {
  const seen: (RequestInit | undefined)[] = [];
  let status = 301;
  context.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    seen.push(init);
    return new Response(status === 200 ? "[]" : null, { status });
  });
  const github = scanTargets(listings)[0]!;
  const gitlab = scanTargets(listings)[2]!;
  const outcome = async (target: typeof github) => {
    try {
      await hostedDependencies("token").releases(target);
      return "ok";
    } catch (error) {
      return error instanceof ScanError ? error.code : "deferred";
    }
  };
  for (const [code, expected] of [
    [301, "release-unavailable"],
    [404, "release-unavailable"],
    [410, "release-unavailable"],
    [500, "release-read-failed"],
    [403, "release-read-failed"],
    [200, "ok"],
  ] as const) {
    status = code;
    assert.equal(await outcome(github), expected, String(code));
  }
  status = 404;
  assert.equal(await outcome(gitlab), "release-unavailable");
  assert.ok(seen.every((init) => init?.redirect === "manual"));
});

void test("a transfer that curl stops at --max-filesize is too large; other transfer failures are retried", async () => {
  const failing = (fields: Record<string, unknown>): Runner =>
    (async () => {
      throw Object.assign(new Error("Command failed: curl"), fields);
    }) as unknown as Runner;
  const asset = { name: "a.zip", url: "https://example.invalid/a.zip", size: null, digest: null };
  const outcome = async (fields: Record<string, unknown>) => {
    try {
      await hostedDependencies(undefined, failing(fields)).download(
        asset,
        "unused",
        10,
        Date.now() + 60_000,
      );
      return "ok";
    } catch (error) {
      return error instanceof ScanError ? error.code : "deferred";
    }
  };
  assert.equal(await outcome({ code: 63, killed: false, signal: null }), "asset-too-large");
  assert.equal(await outcome({ code: 22, killed: false, signal: null }), "deferred");
  assert.equal(await outcome({ code: null, killed: true, signal: "SIGKILL" }), "deferred");
});

void test("the CLI keeps only current, remembered failures and refuses a scan with no targets", async (context) => {
  const { RULES_VERSION } = await import("./release-content-signals.mts");
  const dir = await mkdtemp(path.join(os.tmpdir(), "release-scan-cli-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const checkpoint = path.join(dir, "checkpoint.json");
  const current = `r${RULES_VERSION}|github|up/a|v1|a.zip|10`;
  await writeFile(
    checkpoint,
    JSON.stringify({
      format_version: 1,
      records: [
        { key: current, rules: RULES_VERSION, signals: [] },
        { key: "r0|github|up/a|v1|a.zip|10", rules: 0, signals: [] },
      ],
      retries: [
        { key: `${current}|r`, rules: RULES_VERSION },
        { key: "r0|github|up/a|v1|a.zip|10", rules: 0 },
        { key: `${current}|s`, rules: 0 },
      ],
      failures: [
        { key: current, code: "encrypted-archive", max_asset_bytes: 100 },
        { key: `${current}|b`, code: "unlistable", max_asset_bytes: 100 },
        { key: "r0|github|up/a|v1|a.zip|10", code: "digest-mismatch", max_asset_bytes: 100 },
        { key: `${current}|c`, code: "asset-too-large", max_asset_bytes: "big" },
      ],
    }),
  );
  const loaded = await readCheckpoint(checkpoint);
  assert.deepEqual([...loaded.records.keys()], [current]);
  assert.deepEqual(
    [...loaded.failures.values()].map(({ key, code }) => [key, code]),
    [[current, "encrypted-archive"]],
  );
  assert.deepEqual([...loaded.retries], [`${current}|r`]);
  // A checkpoint from before retries existed still loads.
  const older = path.join(dir, "older.json");
  await writeFile(
    older,
    JSON.stringify({
      format_version: 1,
      records: [{ key: current, rules: RULES_VERSION, signals: [] }],
    }),
  );
  const fromOlder = await readCheckpoint(older);
  assert.deepEqual(
    [fromOlder.records.size, fromOlder.failures.size, fromOlder.retries.size],
    [1, 0, 0],
  );
  const missing = await readCheckpoint(path.join(dir, "absent.json"));
  assert.equal(missing.records.size + missing.failures.size, 0);
  assert.equal((await readCheckpoint("-")).records.size, 0);

  const empty = path.join(dir, "listings.json");
  await writeFile(empty, "{}");
  const output = path.join(dir, "report.json");
  await assert.rejects(
    main(["scan", "--listings", empty, "--checkpoint", "-", "--output", output]),
    /The listings offer no scan targets/u,
  );
  assert.equal(existsSync(output), false, "no report is written");
  // An invalid accounting file fails the scan before anything is read.
  const accounting = path.join(dir, "accounting.json");
  await writeFile(
    accounting,
    JSON.stringify({ format_version: 1, entries: [{ port_id: "absent" }] }),
  );
  await assert.rejects(
    main([
      "scan",
      "--listings",
      empty,
      "--checkpoint",
      "-",
      "--output",
      output,
      "--accounting",
      accounting,
    ]),
    /Invalid release-content accounting/u,
  );
  assert.equal(existsSync(output), false);
});

const accountingEntry = (overrides: Record<string, unknown> = {}) => ({
  port_id: "header",
  platform: "linux-x86-64",
  sha256: "0".repeat(64),
  rules: 2,
  reason: "Synthetic homebrew test cartridge, reviewed as original code.",
  evidence: "https://github.com/boburning/portcove/issues/1",
  ...overrides,
});

void test("accounting entries are validated strictly against the listings", () => {
  const valid = { format_version: 1, entries: [accountingEntry()] };
  assert.equal(readAccounting(valid, listings).length, 1);
  assert.deepEqual(readAccounting({ format_version: 1, entries: [] }, listings), []);
  for (const [label, value] of [
    ["no format", { entries: [] }],
    [
      "missing field",
      { format_version: 1, entries: [{ ...accountingEntry(), reason: undefined }] },
    ],
    ["unknown field", { format_version: 1, entries: [{ ...accountingEntry(), note: "x" }] }],
    ["unknown port", { format_version: 1, entries: [accountingEntry({ port_id: "absent" })] }],
    [
      "upper-case digest",
      { format_version: 1, entries: [accountingEntry({ sha256: "A".repeat(64) })] },
    ],
    ["no rules", { format_version: 1, entries: [accountingEntry({ rules: 0 })] }],
    ["short reason", { format_version: 1, entries: [accountingEntry({ reason: "fine" })] }],
    [
      "foreign evidence",
      {
        format_version: 1,
        entries: [accountingEntry({ evidence: "https://github.com/other/repo/issues/1" })],
      },
    ],
    [
      "evidence not an issue or pull request",
      {
        format_version: 1,
        entries: [accountingEntry({ evidence: "https://github.com/boburning/portcove/commit/1" })],
      },
    ],
    ["duplicate", { format_version: 1, entries: [accountingEntry(), accountingEntry()] }],
  ] as const)
    assert.throws(
      () => readAccounting(value, listings),
      /Invalid release-content accounting/u,
      label,
    );
});

void test("the checked-in accounting file is valid against the catalog listings", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = async (relative: string) =>
    JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8")) as unknown;
  const entries = readAccounting(
    await read("../.github/release-content-accounting.json"),
    await read("../crates/portcove-core/catalog/listings.json"),
  );
  assert.ok(Array.isArray(entries));
});

void test("an accounted finding names its review and raises no warning; a new digest or rules version is not covered", async () => {
  const { RULES_VERSION } = await import("./release-content-signals.mts");
  const targets = scanTargets(listings);
  const first = await scan(targets, new Map(), fakes([]));
  const flagged = first.report.findings[0]!;
  const entry = accountingEntry({ sha256: flagged.sha256, rules: RULES_VERSION });
  const stale = accountingEntry({ sha256: "f".repeat(64), rules: RULES_VERSION });
  const accounted = await scan(targets, new Map(), fakes([]), { accounting: [entry, stale] });
  assert.deepEqual(accounted.report.findings[0]!.accounted, {
    reason: entry.reason,
    evidence: entry.evidence,
  });
  // The checkpoint keeps the plain record: accounting can change without a rescan.
  assert.ok(![...accounted.checkpoint.values()].some((record) => "accounted" in record));
  assert.deepEqual(accounted.report.accounting_unmatched, [
    { port_id: "header", platform: "linux-x86-64", sha256: "f".repeat(64), rules: RULES_VERSION },
  ]);
  // Reused findings are matched too.
  const reused = await scan(targets, accounted.checkpoint, fakes([]), { accounting: [entry] });
  assert.equal(reused.report.findings[0]!.accounted?.evidence, entry.evidence);
  assert.equal(accountingFor([{ ...entry, rules: RULES_VERSION + 1 }], flagged), undefined);
  assert.equal(accountingFor([{ ...entry, platform: "windows-x86-64" }], flagged), undefined);
  const text = summaryMarkdown(accounted.report);
  assert.match(text, /No game-data signals to review\./u);
  assert.match(text, /### Accounted signals \(reviewed false positives\)/u);
  assert.match(text, /### Accounting entries no finding matched/u);
  // Annotations skip accounted findings.
  const dir = await mkdtemp(path.join(os.tmpdir(), "release-scan-annotations-"));
  try {
    const file = path.join(dir, "report.json");
    await writeFile(file, JSON.stringify(accounted.report));
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => (written.push(String(chunk)), true);
    try {
      await main(["annotations", "--report", file]);
      await writeFile(file, JSON.stringify(first.report));
      await main(["annotations", "--report", file]);
    } finally {
      process.stdout.write = original;
    }
    assert.equal(
      written.filter((line) => line.startsWith("::warning")).length,
      1,
      "only the unaccounted run warns",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("each record keeps at most the signal cap, sorted, with the true count", async () => {
  const many = Array.from({ length: SIGNAL_CAP + 5 }, (_, index) => ({
    path: `rom-${String(SIGNAL_CAP + 5 - index).padStart(2, "0")}.z64`,
    kind: "rom-or-disc-image" as const,
    reason: "Nintendo 64 ROM image file",
  }));
  const capped = cappedSignals(many);
  assert.equal(capped.signals.length, SIGNAL_CAP);
  assert.equal(capped.signal_count, SIGNAL_CAP + 5);
  assert.equal(capped.signals[0]!.path, "rom-01.z64");
  assert.deepEqual(cappedSignals([...many].reverse()), capped, "deterministic");
  const deps = fakes([]);
  const { report, checkpoint } = await scan(scanTargets(listings), new Map(), {
    ...deps,
    async list(file, name, stopAt) {
      return name === "Code-1-windows-x64.zip"
        ? many.map(({ path: entry }) => ({ path: entry, size: 10 }))
        : deps.list(file, name, stopAt);
    },
  });
  const record = report.scanned.find(({ id }) => id === "code-only")!;
  assert.equal(record.signals.length, SIGNAL_CAP);
  assert.equal(record.signal_count, SIGNAL_CAP + 5);
  assert.match(summaryMarkdown(report), /\(and 5 more\)/u);
  // A record checkpointed before the cap is capped when reused.
  const legacy = new Map(
    [...checkpoint].map(([key, value]) => {
      const { signal_count: _count, ...rest } = value;
      return [key, { ...rest, signals: value.id === "code-only" ? many : value.signals }];
    }),
  ) as unknown as typeof checkpoint;
  const again = await scan(scanTargets(listings), legacy, deps);
  const reused = again.report.findings.find(({ id }) => id === "code-only")!;
  assert.equal(reused.signals.length, SIGNAL_CAP);
  assert.equal(reused.signal_count, SIGNAL_CAP + 5);
  assert.deepEqual(
    again.report.reused_targets.map(({ id, tag, asset }) => [id, tag, asset]),
    [
      ["code-only", "v1", "Code-1-windows-x64.zip"],
      ["header", "v0.2", "release_Linux.zip"],
    ],
  );
});
