import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseDocument } from "yaml";
import { isRecord } from "./runtime-values.mts";
import {
  appearedSince,
  awaitNewerFeed,
  defaultFolders,
  isolationMarkers,
  cliData,
  compareVersions,
  decideFeedOffer,
  feedUrls,
  fromReleaseTag,
  holdPortFromCatalogList,
  localeUrl,
  manifestDifferences,
  parseReleaseAssetUrl,
  parseSha256Sums,
  playerDataSeed,
  readFeedOffer,
  releaseAssetUrl,
  sha256,
  updateCopy,
  updatePreferenceBytes,
  verifyAgainstSums,
  windowsAssetNames,
  windowsPathKey,
  type observeFeed,
} from "./hosted-installed-update.mts";

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

void test("versions follow SemVer 2.0.0 precedence, including prereleases", () => {
  const ordered = [
    "0.1.0-alpha",
    "0.1.0-alpha.1",
    "0.1.0-alpha.beta",
    "0.1.0-beta",
    "0.1.0-beta.2",
    "0.1.0-beta.11",
    "0.1.0-preview.2",
    "0.1.0-preview.3",
    "0.1.0-preview.10",
    "0.1.0-rc.1",
    "0.1.0",
    "0.1.1",
    "0.2.0",
    "1.0.0",
  ];
  for (let i = 0; i < ordered.length; i++)
    for (let j = 0; j < ordered.length; j++)
      assert.equal(
        compareVersions(ordered[i]!, ordered[j]!),
        Math.sign(i - j),
        `${ordered[i]} vs ${ordered[j]}`,
      );
  assert.equal(compareVersions("1.0.0+build.1", "1.0.0"), 0);
  for (const invalid of ["v1.0.0", "1.0", "01.0.0", "1.0.0-", "1.0.0-01", "nightly-0.1.0"])
    assert.throws(() => compareVersions(invalid, "1.0.0"), /semantic version/u);
});

void test("release assets and tags derive only this repository's public download URLs", () => {
  assert.deepEqual(windowsAssetNames("0.1.0-preview.2"), {
    installer: "Portcove_0.1.0-preview.2_x64-setup.exe",
    cli: "portcove-cli-0.1.0-preview.2-windows-x86_64.zip",
  });
  assert.equal(
    releaseAssetUrl("v0.1.0-preview.2", "SHA256SUMS"),
    "https://github.com/boburning/portcove/releases/download/v0.1.0-preview.2/SHA256SUMS",
  );
  assert.deepEqual(
    parseReleaseAssetUrl(
      "https://github.com/boburning/portcove/releases/download/nightly-0.1.0-preview.3/Portcove_0.1.0-preview.3_x64-setup.exe",
    ),
    { tag: "nightly-0.1.0-preview.3", asset: "Portcove_0.1.0-preview.3_x64-setup.exe" },
  );
  for (const url of [
    "http://github.com/boburning/portcove/releases/download/v1/a.exe",
    "https://example.com/boburning/portcove/releases/download/v1/a.exe",
    "https://github.com/someone/portcove/releases/download/v1/a.exe",
    "https://github.com/boburning/portcove/releases/download/v1/a.exe?x=1",
    "https://github.com/boburning/portcove/releases/download/v1/dir/a.exe",
    "https://github.com/boburning/portcove/releases/download/v1/..%2Fa.exe",
  ])
    assert.throws(() => parseReleaseAssetUrl(url), url);
  assert.throws(() => releaseAssetUrl("../x", "a"));
  assert.throws(() => releaseAssetUrl("v1", "a/b"));
  assert.equal(fromReleaseTag("0.1.0-preview.2"), "v0.1.0-preview.2");
  assert.equal(fromReleaseTag("0.1.0-preview.3", ""), "v0.1.0-preview.3");
  assert.equal(
    fromReleaseTag("0.1.0-preview.3", "nightly-0.1.0-preview.3"),
    "nightly-0.1.0-preview.3",
  );
  assert.throws(() => fromReleaseTag("latest"));
});

const publishedSums = `ee2dd11427e330303f200e837034a0240317c09f88c67611e007e047792e1a7d  Portcove_0.1.0-preview.2_amd64.AppImage
512919bcc1b241a5109b4f9730d62aa85025747b37d101c24b2079401eded49c  Portcove_0.1.0-preview.2_x64-setup.exe
5228bd7368edf197c1b3a8be766e8c26561765f2eca647ec7d8f0dc78605a996  Portcove_0.1.0-preview.2_x64-setup.exe.sig
97a250535c6ebb960d61fc8224ddce5aab0ed3550867b0b7b73ec1f498d97e07  portcove-cli-0.1.0-preview.2-windows-x86_64.zip
`;

void test("SHA256SUMS is parsed strictly and checks downloaded bytes", () => {
  const sums = parseSha256Sums(publishedSums);
  assert.equal(sums.size, 4);
  assert.equal(
    sums.get("Portcove_0.1.0-preview.2_x64-setup.exe"),
    "512919bcc1b241a5109b4f9730d62aa85025747b37d101c24b2079401eded49c",
  );
  for (const malformed of [
    "",
    "abc  file",
    `${"a".repeat(64)}  ../file`,
    `${"a".repeat(64)}  dir/file`,
    `${"A".repeat(64)}  file`,
    `${"a".repeat(64)}  file\n${"b".repeat(64)}  file`,
  ])
    assert.throws(() => parseSha256Sums(malformed));
  const bytes = Buffer.from("installer bytes");
  const listed = parseSha256Sums(`${sha256(bytes)}  a.exe\n`);
  assert.deepEqual(verifyAgainstSums(listed, "a.exe", bytes), {
    asset: "a.exe",
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
  });
  assert.throws(() => verifyAgainstSums(listed, "a.exe", Buffer.from("tampered")), /differs/u);
  assert.throws(() => verifyAgainstSums(listed, "b.exe", bytes), /does not list/u);
});

const signature = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=";
function feed(version: string, overrides: Record<string, unknown> = {}) {
  return {
    version,
    notes: "notes",
    pub_date: "2026-11-15T02:33:48Z",
    platforms: {
      "windows-x86_64": {
        signature,
        url: `https://github.com/boburning/portcove/releases/download/v${version}/Portcove_${version}_x64-setup.exe`,
      },
    },
    ...overrides,
  };
}

void test("the Tauri feed offer is validated and compared with the installed version", () => {
  const offer = readFeedOffer(feed("0.1.0-preview.3"));
  assert.deepEqual(offer, {
    version: "0.1.0-preview.3",
    pub_date: "2026-11-15T02:33:48Z",
    url: "https://github.com/boburning/portcove/releases/download/v0.1.0-preview.3/Portcove_0.1.0-preview.3_x64-setup.exe",
    tag: "v0.1.0-preview.3",
    asset: "Portcove_0.1.0-preview.3_x64-setup.exe",
    signature_sha256: sha256(Buffer.from(signature)),
  });
  assert.throws(() => readFeedOffer(null));
  assert.throws(() => readFeedOffer(feed("latest")));
  assert.throws(() => readFeedOffer(feed("0.1.0", { platforms: {} })), /does not offer/u);
  assert.throws(() => readFeedOffer(feed("0.1.0", { pub_date: "yesterday" })), /pub_date/u);
  const wrongAsset = feed("0.1.0-preview.3");
  wrongAsset.platforms["windows-x86_64"].url = wrongAsset.platforms["windows-x86_64"].url.replace(
    "preview.3_x64",
    "preview.2_x64",
  );
  assert.throws(() => readFeedOffer(wrongAsset), /does not name version/u);
  const unsigned = feed("0.1.0-preview.3");
  unsigned.platforms["windows-x86_64"].signature = " ";
  assert.throws(() => readFeedOffer(unsigned), /signature/u);

  assert.deepEqual(decideFeedOffer("0.1.0-preview.2", offer), {
    outcome: "offered",
    from_version: "0.1.0-preview.2",
    to_version: "0.1.0-preview.3",
  });
  assert.equal(decideFeedOffer("0.1.0-preview.3", offer).outcome, "not-newer");
  assert.match(
    JSON.stringify(decideFeedOffer("0.1.0", offer)),
    /older than the installed 0\.1\.0/u,
  );
});

void test("feed polling waits for a strictly newer version within the bound", async () => {
  let clock = 0;
  const versions = ["0.1.0-preview.2", "0.1.0-preview.2", "0.1.0-preview.3"];
  const observe = (async () => {
    const version = versions.shift() ?? "0.1.0-preview.3";
    return {
      channel: "preview",
      url: feedUrls.preview,
      fetched_at: new Date(clock).toISOString(),
      sha256: version,
      bytes: Buffer.from(version),
      offer: readFeedOffer(feed(version)),
    };
  }) as typeof observeFeed;
  const sleep = async (ms: number) => {
    clock += ms;
  };
  const offered = await awaitNewerFeed({
    channel: "preview",
    fromVersion: "0.1.0-preview.2",
    waitMinutes: 5,
    observe,
    sleep,
    now: () => clock,
  });
  assert.equal(offered.decision.outcome, "offered");
  assert.equal(offered.attempts.length, 3);

  clock = 0;
  versions.splice(0, versions.length, ...Array<string>(10).fill("0.1.0-preview.2"));
  const stale = await awaitNewerFeed({
    channel: "preview",
    fromVersion: "0.1.0-preview.2",
    waitMinutes: 2,
    observe,
    sleep,
    now: () => clock,
  });
  assert.equal(stale.decision.outcome, "not-newer");
  assert.equal(stale.attempts.length, 3);

  clock = 0;
  const failing = (async () => {
    throw new Error("HTTP 404");
  }) as typeof observeFeed;
  await assert.rejects(
    awaitNewerFeed({
      channel: "preview",
      fromVersion: "0.1.0",
      waitMinutes: 0,
      observe: failing,
      sleep,
      now: () => clock,
    }),
    /feed unavailable: HTTP 404/u,
  );
  await assert.rejects(
    awaitNewerFeed({ channel: "preview", fromVersion: "0.1.0", waitMinutes: 181 }),
  );
});

void test("seeded preferences use the client's exact wire format", () => {
  const preferences: unknown = JSON.parse(updatePreferenceBytes("preview").toString());
  assert.deepEqual(preferences, { channel: "preview", automatic_checks: false });
  // Unknown keys make the client fall back to Beta, so none may be added.
  assert.ok(isRecord(preferences));
  assert.deepEqual(Object.keys(preferences).sort(), ["automatic_checks", "channel"]);
  const source = read("apps/desktop/src-tauri/src/application_update.rs");
  assert.match(source, /PORTCOVE_APPLICATION_UPDATE_PREFERENCES/u);
  assert.match(source, /"channel": "preview", "automatic_checks": true/u);
  for (const channel of ["preview", "beta"] as const)
    assert.ok(source.includes(feedUrls[channel]), `client feed URL ${feedUrls[channel]}`);
});

void test("player data is deterministic and manifests report every difference", () => {
  const first = playerDataSeed();
  const second = playerDataSeed();
  assert.deepEqual(
    first.map((file) => [file.relative, sha256(file.bytes)]),
    second.map((file) => [file.relative, sha256(file.bytes)]),
  );
  assert.ok(first.every((file) => file.relative.startsWith("user/hosted-update-acceptance/")));
  const entries = [
    { path: "a/save.sav", sha256: "1".repeat(64), bytes: 1 },
    { path: "settings.ini", sha256: "2".repeat(64), bytes: 2 },
  ];
  assert.deepEqual(manifestDifferences(entries, structuredClone(entries)), []);
  assert.deepEqual(
    manifestDifferences(entries, [
      { path: "a/save.sav", sha256: "3".repeat(64), bytes: 1 },
      { path: "new.txt", sha256: "4".repeat(64), bytes: 1 },
    ]),
    [
      { path: "a/save.sav", change: "changed" },
      { path: "new.txt", change: "added" },
      { path: "settings.ini", change: "removed" },
    ],
  );
  assert.throws(() => manifestDifferences([entries[0]!, entries[0]!], []), /twice/u);
});

void test("CLI and locale readers accept only successful, complete answers", () => {
  assert.equal(
    holdPortFromCatalogList({ ok: true, data: [{ id: "Bad ID" }, { id: "shipwright" }] }),
    "shipwright",
  );
  assert.throws(() => holdPortFromCatalogList({ ok: false, data: [] }));
  assert.throws(() => holdPortFromCatalogList({ ok: true, data: [] }));
  assert.deepEqual(
    cliData({ ok: true, command: "library.identity", data: { id: "x" } }, "library.identity"),
    {
      id: "x",
    },
  );
  assert.throws(() => cliData({ ok: true, command: "other", data: {} }, "library.identity"));
  const copy = updateCopy(JSON.parse(read("apps/desktop/src/locales/en/applicationUpdate.json")));
  assert.equal(copy.check, "Check for updates");
  assert.equal(copy.install, "Download and restart");
  assert.match(copy.availableTitle, /\{\{version\}\}/u);
  assert.match(copy.libraryInUse, /command line/u);
  assert.throws(() => updateCopy({ status: {} }), /status\.check/u);
  assert.equal(
    localeUrl("v0.1.0-preview.2"),
    "https://raw.githubusercontent.com/boburning/portcove/v0.1.0-preview.2/apps/desktop/src/locales/en/applicationUpdate.json",
  );
  // The refusal copy the acceptance expects is the one the host maps library-in-use to.
  assert.match(
    read("apps/desktop/src/features/application-update/ApplicationUpdates.tsx"),
    /case "library-in-use":\s+return t\("failure\.libraryInUse"\)/u,
  );
});

void test("Windows path keys ignore the extended-length prefix, quotes, separators and case", () => {
  const expected = "d:\\a\\portcove\\work\\scope\\library";
  for (const value of [
    "\\\\?\\D:\\a\\portcove\\work\\scope\\library",
    "D:\\a\\portcove/work/scope/library\\",
    '"D:\\A\\Portcove\\Work\\Scope\\Library"',
  ])
    assert.equal(windowsPathKey(value), expected, value);
  assert.equal(windowsPathKey("\\\\?\\UNC\\server\\share\\x"), "\\\\server\\share\\x");
  assert.equal(windowsPathKey("C:\\"), "c:\\");
  assert.notEqual(windowsPathKey("D:\\a\\library2"), windowsPathKey("D:\\a\\library"));
});

void test("the workflow is manual, read-only and secret-free", () => {
  const raw = read(".github/workflows/hosted-installed-update.yml");
  const document = parseDocument(raw, { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const workflow: unknown = document.toJS();
  assert.ok(isRecord(workflow) && isRecord(workflow.on) && isRecord(workflow.jobs));
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  for (const forbidden of [
    /secrets\./u,
    /github\.token/u,
    /GH_TOKEN|GITHUB_TOKEN/u,
    /\bgh /u,
    /environment:/u,
    /pull_request|schedule:|push:/u,
  ])
    assert.doesNotMatch(raw, forbidden);
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ["feed", "verdict", "windows"]);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.ok(isRecord(job));
    assert.equal(job.permissions, undefined, `${name} must not widen permissions`);
    assert.ok(Number.isInteger(job["timeout-minutes"]), `${name} needs a finite timeout`);
    assert.ok(Array.isArray(job.steps));
    for (const step of job.steps) {
      assert.ok(isRecord(step));
      if (isRecord(step.with) && "persist-credentials" in step.with)
        assert.equal(step.with["persist-credentials"], false);
      if (typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"))
        assert.ok(isRecord(step.with) && step.with["persist-credentials"] === false);
    }
  }
  const windows = workflow.jobs.windows;
  assert.ok(isRecord(windows) && Array.isArray(windows.steps));
  assert.equal(windows["runs-on"], "windows-2022");
  // Tooling must not create a default Portcove location before the fresh-machine check.
  assert.ok(isRecord(windows.env));
  assert.equal(windows.env.PORTCOVE_SHARED_TOOL_CACHE, "${{ github.workspace }}/work/tool-cache");
  assert.equal(windows.if, "needs.feed.outputs.outcome == 'offered'");
  const uses = windows.steps.filter(isRecord).map((step) => step.uses);
  assert.ok(uses.includes("./.github/actions/prepare-hosted-webview"));
  const evidence = windows.steps.filter(isRecord).at(-1);
  assert.ok(isRecord(evidence) && evidence.if === "always()");
  assert.match(String(evidence.uses), /^actions\/upload-artifact@[a-f0-9]{40}$/u);
  assert.match(raw, /node apps\/desktop\/scripts\/desktop-hosted-installed-update\.mts/u);
  assert.match(raw, /node scripts\/hosted-installed-update\.mts feed-gate/u);
  const verdict = workflow.jobs.verdict;
  assert.ok(isRecord(verdict));
  assert.equal(verdict.if, "always()");
  assert.deepEqual(verdict.needs, ["feed", "windows"]);
});

void test("the harness isolates every Portcove location before launch", () => {
  const harness = read("apps/desktop/scripts/desktop-hosted-installed-update.mts");
  for (const name of [
    "PORTCOVE_LIBRARY",
    "PORTCOVE_PREFERENCES",
    "PORTCOVE_APPLICATION_UPDATE_PREFERENCES",
    "PORTCOVE_APPLICATION_RUNTIME_LOCK",
    "PORTCOVE_TEMP_DIR",
    "WEBVIEW2_USER_DATA_FOLDER",
  ])
    assert.match(harness, new RegExp(`\\b${name}:`, "u"), name);
  // The runtime lease defaults beside the default preferences, not the configured ones.
  assert.match(
    read("crates/portcove-core/src/host_preferences.rs"),
    /PORTCOVE_APPLICATION_RUNTIME_LOCK[\s\S]{0,200}sibling_lock_path\(&Self::default_path\(\)\?\)/u,
  );
  // The CLI holds the runtime lease before it reaches any confirmation prompt.
  const cli = read("crates/portcove-cli/src/main.rs");
  assert.ok(
    cli.indexOf("ApplicationRuntimeGuard::acquire") < cli.indexOf("OutputCommand::Reset {"),
  );
});

void test("evidence survives timeouts and failed isolation is a named result", () => {
  const workflow: unknown = parseDocument(
    read(".github/workflows/hosted-installed-update.yml"),
  ).toJS();
  assert.ok(isRecord(workflow) && isRecord(workflow.jobs) && isRecord(workflow.jobs.windows));
  const windows = workflow.jobs.windows;
  assert.ok(Array.isArray(windows.steps));
  const scenario = windows.steps
    .filter(isRecord)
    .find((step) => String(step.run).includes("desktop-hosted-installed-update.mts"));
  assert.ok(isRecord(scenario));
  assert.ok(
    Number(scenario["timeout-minutes"]) < Number(windows["timeout-minutes"]) - 10,
    "the scenario step must stop before the job so the evidence upload runs",
  );
  const harness = read("apps/desktop/scripts/desktop-hosted-installed-update.mts");
  assert.match(
    harness,
    /"taskkill\.exe", \["\/PID", String\(session\.driver\.pid\), "\/T", "\/F"\]/u,
  );
  assert.match(harness, /driver-ports-free-before-/u);
  assert.match(harness, /watchProcesses\(appPid, 50 \* 60\)/u);
  for (const name of [
    "installer-relaunched-app",
    "relaunch-kept-isolation-no-default-locations",
    "run-created-no-default-locations",
    "from-registration-names-isolated-install-root",
    "updated-registration-names-isolated-install-root",
  ])
    assert.ok(harness.includes(`"${name}"`), name);
  // Only the missing release CLI may skip; every other outcome passes or fails.
  assert.deepEqual(
    [...harness.matchAll(/\bskip\(\s*"([^"]+)"/gu)].map((match) => match[1]),
    ["library-identity-unchanged"],
  );
});

void test("isolation is judged by override-sensitive markers against the isolated baseline", () => {
  const local = "C:\\Users\\runner\\AppData\\Local";
  const roaming = "C:\\Users\\runner\\AppData\\Roaming";
  const markers = isolationMarkers(local);
  assert.deepEqual(markers, [
    "C:\\Users\\runner\\AppData\\Local\\Portcove\\Portcove\\config\\preferences.json",
    "C:\\Users\\runner\\AppData\\Local\\Portcove\\Portcove\\config\\.application-runtime.lock",
    "C:\\Users\\runner\\AppData\\Local\\Portcove\\Portcove\\data\\library",
    "C:\\Users\\runner\\AppData\\Local\\io.github.portcove.portcove\\EBWebView",
  ]);
  const tauriFolder = "C:\\Users\\runner\\AppData\\Local\\io.github.portcove.portcove";
  assert.ok(defaultFolders(local, roaming).includes(tauriFolder));
  assert.ok(!markers.includes(tauriFolder), "the bare Tauri folder is not a marker");
  // The runtime lock name and default locations come from Core.
  assert.match(
    read("crates/portcove-core/src/application_runtime.rs"),
    /APPLICATION_RUNTIME_LOCK_FILE: &str = "\.application-runtime\.lock"/u,
  );
  assert.match(
    read("crates/portcove-core/src/host_preferences.rs"),
    /ProjectDirs::from\("io\.github", "Portcove", "Portcove"\)[\s\S]{0,200}config_local_dir\(\)\.join\("preferences\.json"\)/u,
  );
  assert.match(
    read("crates/portcove-core/src/library.rs"),
    /data_local_dir\(\)\.join\("library"\)/u,
  );

  const none = Object.fromEntries(markers.map((marker) => [marker, false]));
  // The isolated session creates only the bare Tauri folder: no marker appears.
  const isolated = { ...none };
  const folders = { [tauriFolder]: true };
  assert.deepEqual(appearedSince({ [tauriFolder]: false }, folders), [tauriFolder]);
  assert.deepEqual(appearedSince(none, isolated), []);
  // A relaunch without its overrides writes default preferences: a failure.
  const relaunched = { ...isolated, [markers[0]!]: true };
  assert.deepEqual(appearedSince(isolated, relaunched), [markers[0]]);
  // Something the isolated baseline already had is not blamed on the relaunch.
  const webview = { ...none, [markers[3]!]: true };
  assert.deepEqual(appearedSince(webview, webview), []);
  assert.deepEqual(appearedSince(none, webview), [markers[3]]);
});
