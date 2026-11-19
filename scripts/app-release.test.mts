import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { parse } from "yaml";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { fixtureGitHub } from "./fixtures/github-sdk-fixtures.mts";
import { execFileSync } from "node:child_process";
import {
  addWithdrawn,
  appReleaseMatrix,
  appReleaseProfile,
  assertAppReleaseAssets,
  assertNewerThanTags,
  assertVersionUnclaimed,
  buildFeed,
  classifyRelease,
  collectAppReleaseBundles,
  findRelease,
  listReleases,
  readReleaseById,
  compareVersions,
  isWithdrawn,
  nextPreviewVersion,
  newestConclusions,
  nightlyLookback,
  nightlyPreview,
  parseWithdrawnList,
  publishedReleases,
  quietMentions,
  readWorkspaceVersion,
  renderAppReleaseDownloadSection,
  replacementCandidates,
  stampVersion,
  tagRelease,
  tagVersion,
  verifyReleaseInputs,
  withdrawRelease,
  type Channel,
  type Runner,
  type WithdrawApi,
} from "./app-release.mts";

void test("tags map to the owner-approved channels and environments", () => {
  assert.deepEqual(classifyRelease("0.1.0-preview.1"), {
    version: "0.1.0-preview.1",
    channel: "preview",
    prerelease: true,
    environment: "release",
    feeds: ["preview"],
  });
  assert.equal(classifyRelease("0.1.0").channel, "beta");
  assert.deepEqual(classifyRelease("0.2.3").feeds, ["beta", "preview"]);
  const stable = classifyRelease("1.0.0");
  assert.equal(stable.channel, "stable");
  assert.equal(stable.environment, "release-stable");
  assert.equal(stable.prerelease, false);
  for (const bad of ["0.1", "v0.1.0", "0.1.0-alpha.3", "0.1.0-preview", "01.0.0", "1.0.0-rc.1"])
    assert.throws(() => classifyRelease(bad));
});

void test("SemVer precedence orders previews below their release and above older releases", () => {
  const ordered = [
    "0.1.0-alpha.2",
    "0.1.0-preview.1",
    "0.1.0-preview.2",
    "0.1.0-preview.10",
    "0.1.0",
    "0.1.1",
    "0.2.0-preview.1",
    "0.2.0",
    "1.0.0",
  ];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.equal(
      compareVersions(ordered[i]!, ordered[i + 1]!),
      -1,
      `${ordered[i]} < ${ordered[i + 1]}`,
    );
    assert.equal(compareVersions(ordered[i + 1]!, ordered[i]!), 1);
  }
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
});

void test("stamping rewrites exactly the three build version sources", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "app-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "apps/desktop/src-tauri"), { recursive: true });
  await writeFile(
    path.join(root, "Cargo.toml"),
    '[workspace]\nmembers = []\n\n[workspace.package]\nversion = "0.1.0"\nedition = "2024"\n\n[workspace.dependencies]\nx = { version = "1.2.3" }\n',
  );
  await writeFile(path.join(root, "apps/desktop/package.json"), '{"name":"d","version":"0.1.0"}\n');
  await writeFile(
    path.join(root, "apps/desktop/src-tauri/tauri.conf.json"),
    '{"productName":"Portcove","version":"0.1.0"}\n',
  );
  stampVersion(root, "0.1.1");
  const cargo = await readFile(path.join(root, "Cargo.toml"), "utf8");
  assert.match(cargo, /\[workspace\.package\]\nversion = "0\.1\.1"/u);
  assert.match(cargo, /x = \{ version = "1\.2\.3" \}/u);
  for (const file of ["apps/desktop/package.json", "apps/desktop/src-tauri/tauri.conf.json"])
    assert.equal(
      (JSON.parse(await readFile(path.join(root, file), "utf8")) as { version: string }).version,
      "0.1.1",
    );
  assert.throws(() => stampVersion(root, "not-a-version"));
});

void test("the feed binds every platform to its signed asset and refuses a missing signature", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "app-release-feed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const v = "0.1.0";
  for (const name of [
    `Portcove_${v}_x64-setup.exe`,
    `Portcove_${v}_amd64.AppImage`,
    `Portcove_${v}_universal.app.tar.gz`,
  ]) {
    await writeFile(path.join(dir, name), "payload");
    await writeFile(path.join(dir, `${name}.sig`), `sig-of-${name}\n`);
  }
  const base = "https://github.com/boburning/portcove/releases/download/v0.1.0";
  const feed = buildFeed({
    version: v,
    notes: "n",
    pubDate: "2026-11-13T00:00:00Z",
    assetsDir: dir,
    downloadBase: base,
  });
  assert.deepEqual(Object.keys(feed.platforms).sort(), [
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-x86_64",
    "windows-x86_64",
  ]);
  assert.deepEqual(feed.platforms["windows-x86_64"], {
    signature: `sig-of-Portcove_${v}_x64-setup.exe`,
    url: `${base}/Portcove_${v}_x64-setup.exe`,
  });
  assert.equal(feed.platforms["darwin-x86_64"]!.url, feed.platforms["darwin-aarch64"]!.url);
  await rm(path.join(dir, `Portcove_${v}_amd64.AppImage.sig`));
  assert.throws(
    () => buildFeed({ version: v, notes: "n", pubDate: "x", assetsDir: dir, downloadBase: base }),
    /missing signed updater asset Portcove_0\.1\.0_amd64\.AppImage/u,
  );
});

void test("a release must be newer than every existing release tag, ignoring non-release tags", () => {
  const tags = [
    "v0.1.0-alpha.1",
    "v0.1.0-alpha.2",
    "v0.0.0-rehearsal.41788540335.1",
    "vnot-semver",
  ];
  assertNewerThanTags("0.1.0-preview.1", tags);
  assertNewerThanTags("0.1.0", [...tags, "v0.1.0"]);
  assert.throws(
    () => assertNewerThanTags("0.0.9", tags),
    /greater than existing v0\.1\.0-alpha\.1/u,
  );
  assert.throws(() => assertNewerThanTags("0.1.5", [...tags, "v0.2.0"]), /v0\.2\.0/u);
  // Nightly previews also name versions: an owner release must pass them too.
  const nightly = [...tags, "nightly-0.1.0-preview.3"];
  assertNewerThanTags("0.1.0", nightly);
  assert.throws(
    () => assertNewerThanTags("0.1.0-preview.3", nightly),
    /greater than existing nightly-0\.1\.0-preview\.3/u,
  );
  assert.throws(() => assertNewerThanTags("0.1.0-preview.2", nightly), /nightly-0\.1\.0/u);
  assertNewerThanTags("0.1.0-preview.4", [...nightly, "nightly-not-semver", "nightly-"]);
  assert.equal(tagVersion("nightly-0.1.0-preview.3"), "0.1.0-preview.3");
  assert.equal(tagVersion("v0.1.0"), "0.1.0");
  assert.equal(tagVersion("portcove-production-controller-r1"), null);
  // Any writer can create nightly-* tags; only preview versions count, so a stray
  // Beta- or Stable-looking nightly tag cannot block owner releases or nightlies.
  for (const stray of [
    "nightly-9.9.9",
    "nightly-0.1.0",
    "nightly-1.0.0-rc.1",
    "nightly-0.2.0-alpha.1",
  ])
    assert.equal(tagVersion(stray), null, stray);
  assertNewerThanTags("0.1.0", [...tags, "nightly-9.9.9", "nightly-0.1.0"]);
  assert.equal(
    nextPreviewVersion([...tags, "nightly-9.9.9", "nightly-0.1.0", "nightly-0.1.1"], "0.1.0"),
    "0.1.0-preview.1",
  );
});

void test("publishing refuses a version that another remote tag already names", () => {
  const remote =
    (refs: string[]): Runner =>
    (_command, args) => {
      assert.deepEqual(args, [
        "ls-remote",
        "--tags",
        "origin",
        "refs/tags/v*",
        "refs/tags/nightly-*",
      ]);
      return refs.map((ref, i) => `${String(i).repeat(40)}\trefs/tags/${ref}`).join("\n");
    };
  assertVersionUnclaimed(
    "0.1.0-preview.1",
    "nightly-0.1.0-preview.1",
    remote([
      "v0.1.0-alpha.2",
      "nightly-0.1.0-preview.1",
      "nightly-0.1.0-preview.1^{}",
      "nightly-0.1.0",
    ]),
  );
  assertVersionUnclaimed("0.1.0", "v0.1.0", remote(["v0.1.0", "v0.1.0^{}", "nightly-0.1.0"]));
  assert.throws(
    () =>
      assertVersionUnclaimed(
        "0.1.0-preview.1",
        "nightly-0.1.0-preview.1",
        remote(["nightly-0.1.0-preview.1", "v0.1.0-preview.1"]),
      ),
    /v0\.1\.0-preview\.1 already names 0\.1\.0-preview\.1; nightly-0\.1\.0-preview\.1 is not published/u,
  );
  assert.throws(
    () =>
      assertVersionUnclaimed(
        "0.1.0-preview.1",
        "v0.1.0-preview.1",
        remote(["v0.1.0-preview.1", "nightly-0.1.0-preview.1"]),
      ),
    /nightly-0\.1\.0-preview\.1 already names/u,
  );
  assert.throws(
    () => assertVersionUnclaimed("0.1.0", "v0.1.0", remote([])),
    /v0\.1\.0 is not on the remote/u,
  );
});

void test("shared build inputs must match the version's channel, tag and signing environment", () => {
  const commit = "d".repeat(40);
  const valid = {
    tag: "nightly-0.1.0-preview.1",
    version: "0.1.0-preview.1",
    prerelease: "true",
    feeds: "preview",
    environment: "release",
    commit,
  };
  assert.equal(verifyReleaseInputs(valid).channel, "preview");
  assert.equal(verifyReleaseInputs({ ...valid, tag: "v0.1.0-preview.1" }).channel, "preview");
  assert.equal(
    verifyReleaseInputs({
      tag: "v1.0.0",
      version: "1.0.0",
      prerelease: "false",
      feeds: "stable beta preview",
      environment: "release-stable",
      commit,
    }).environment,
    "release-stable",
  );
  const refusals: [Partial<typeof valid>, RegExp][] = [
    [
      { tag: "nightly-0.1.0", version: "0.1.0", prerelease: "false", feeds: "beta preview" },
      /does not name/u,
    ],
    [{ tag: "v0.1.0-preview.2" }, /does not name/u],
    [{ tag: "refs/tags/v0.1.0-preview.1" }, /does not name/u],
    [{ environment: "release-stable" }, /environment/u],
    [{ feeds: "beta preview" }, /feeds/u],
    [{ prerelease: "false" }, /prerelease/u],
    [{ commit: "main" }, /full SHA/u],
  ];
  for (const [change, message] of refusals)
    assert.throws(() => verifyReleaseInputs({ ...valid, ...change }), message);
  // A Stable version can never be signed in the Preview/Beta environment.
  assert.throws(
    () =>
      verifyReleaseInputs({
        tag: "v1.0.0",
        version: "1.0.0",
        prerelease: "false",
        feeds: "stable beta preview",
        environment: "release",
        commit,
      }),
    /environment/u,
  );
});

function fakeRunner(state: {
  head?: string;
  main?: string;
  dirty?: string;
  tags?: string[];
  ci?: string;
}) {
  const calls: string[][] = [];
  const run: Runner = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "rev-parse")
      return args[1] === "HEAD" ? (state.head ?? "a".repeat(40)) : (state.main ?? "a".repeat(40));
    if (args[0] === "status") return state.dirty ?? "";
    if (args[0] === "tag" && args[1] === "--list")
      return (state.tags ?? ["v0.1.0-alpha.2"]).join("\n");
    return "";
  };
  const ci = (sha: string) =>
    sha === (state.head ?? "a".repeat(40)) ? (state.ci ?? "success") : "";
  return { run, ci, calls };
}

void test("the release command tags and pushes only an exact, clean, CI-green main commit", () => {
  const ok = fakeRunner({});
  assert.deepEqual(tagRelease("0.1.0-preview.1", "notes.md", ok.ci, ok.run), {
    tag: "v0.1.0-preview.1",
    channel: "preview",
    commit: "a".repeat(40),
  });
  const tagCall = ok.calls.find((call) => call[1] === "tag" && call[2] === "-a")!;
  assert.deepEqual(tagCall.slice(1), [
    "tag",
    "-a",
    "--cleanup=verbatim",
    "v0.1.0-preview.1",
    "-F",
    "notes.md",
    "a".repeat(40),
  ]);
  assert.deepEqual(ok.calls.at(-1), ["git", "push", "origin", "refs/tags/v0.1.0-preview.1"]);

  const refusals: [Parameters<typeof fakeRunner>[0], RegExp][] = [
    [{ main: "b".repeat(40) }, /HEAD must equal origin\/main/u],
    [{ dirty: " M Cargo.toml" }, /uncommitted changes/u],
    [{ tags: ["v0.1.0"] }, /greater than existing v0\.1\.0/u],
    [{ tags: ["v0.1.0-preview.1"] }, /already exists/u],
    [{ tags: ["nightly-0.1.0-preview.1"] }, /greater than existing nightly-0\.1\.0-preview\.1/u],
    [{ ci: "" }, /CI has not succeeded/u],
    [{ ci: "failure" }, /CI has not succeeded/u],
  ];
  for (const [state, message] of refusals) {
    const fake = fakeRunner(state);
    assert.throws(() => tagRelease("0.1.0-preview.1", undefined, fake.ci, fake.run), message);
    assert.ok(!fake.calls.some((call) => call[1] === "push"), "a refused release never pushes");
  }
});

void test("verbatim tag cleanup keeps Markdown headings in the release notes", async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "app-release-notes-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
      { encoding: "utf8" },
    );
  git("init", "--quiet");
  git("commit", "--quiet", "--allow-empty", "-m", "base");
  await writeFile(path.join(repo, "notes.md"), "Portcove 0.1.0\n\n## Fixes\n\n- Saves are kept\n");
  git("tag", "-a", "--cleanup=verbatim", "v0.1.0", "-F", path.join(repo, "notes.md"));
  const body = git(
    "for-each-ref",
    "refs/tags/v0.1.0",
    "--format=%(contents:subject)%0a%0a%(contents:body)",
  );
  assert.match(body, /## Fixes/u);
});

void test("the compare command exits 0 only for a newer candidate or a missing feed", () => {
  const compare = (...args: string[]) => {
    try {
      execFileSync(process.execPath, [
        path.join(import.meta.dirname, "app-release.mts"),
        "compare",
        ...args,
      ]);
      return 0;
    } catch (error) {
      return (error as { status: number }).status;
    }
  };
  assert.equal(compare("--candidate", "0.1.1"), 0);
  assert.equal(compare("--candidate", "0.1.1", "--current", "0.1.0"), 0);
  assert.equal(compare("--candidate", "0.1.0", "--current", "0.1.0"), 1);
  assert.equal(compare("--candidate", "0.1.0-preview.3", "--current", "0.1.0"), 1);
});

const existingTags = ["v0.1.0-alpha.1", "v0.1.0-alpha.2", "v0.0.0-rehearsal.41788540335.1"];

void test("the next nightly preview follows the newest release, the workspace and earlier previews", () => {
  // Today's tags: alpha and rehearsal tags are not releases and do not block 0.1.0-preview.1.
  assert.equal(nextPreviewVersion(existingTags, "0.1.0"), "0.1.0-preview.1");
  assert.equal(nextPreviewVersion([], "0.1.0"), "0.1.0-preview.1");
  assert.equal(
    nextPreviewVersion([...existingTags, "v0.1.0-preview.1", "v0.1.0-preview.2"], "0.1.0"),
    "0.1.0-preview.3",
  );
  assert.equal(
    nextPreviewVersion([...existingTags, "v0.1.0-preview.9", "v0.1.0-preview.10"], "0.1.0"),
    "0.1.0-preview.11",
  );
  // After 0.1.0 ships, previews move to the next patch, whatever the workspace still says.
  const released = [...existingTags, "v0.1.0-preview.4", "v0.1.0"];
  assert.equal(nextPreviewVersion(released, "0.1.0"), "0.1.1-preview.1");
  assert.equal(nextPreviewVersion([...released, "v0.1.1-preview.1"], "0.1.0"), "0.1.1-preview.2");
  assert.equal(nextPreviewVersion([...released, "v0.1.1"], "0.1.0"), "0.1.2-preview.1");
  // A workspace bump above the next patch wins and starts N again at 1.
  assert.equal(nextPreviewVersion([...released, "v0.1.1-preview.1"], "0.2.0"), "0.2.0-preview.1");
  assert.equal(nextPreviewVersion(released, "0.1.1"), "0.1.1-preview.1");
  // Nightly tags count as previews; they never count as releases.
  assert.equal(
    nextPreviewVersion(
      [...existingTags, "nightly-0.1.0-preview.1", "nightly-0.1.0-preview.2"],
      "0.1.0",
    ),
    "0.1.0-preview.3",
  );
  assert.equal(
    nextPreviewVersion([...existingTags, "v0.1.0-preview.4", "nightly-0.1.0-preview.5"], "0.1.0"),
    "0.1.0-preview.6",
  );
  assert.equal(
    nextPreviewVersion([...released, "nightly-0.1.1-preview.7"], "0.1.0"),
    "0.1.1-preview.8",
  );
  // Pre-release workspace versions and versions below an existing tag are refused.
  assert.throws(() => nextPreviewVersion([], "0.1.0-dev.1"), /must be X\.Y\.Z/u);
  assert.throws(
    () => nextPreviewVersion([...existingTags, "v0.2.0-preview.1"], "0.1.0"),
    /greater than existing v0\.2\.0-preview\.1/u,
  );
});

void test("the workspace version is read from Cargo.toml's workspace.package section", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "app-release-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "Cargo.toml"),
    '[workspace]\nmembers = []\n\n[workspace.package]\nversion = "0.1.0"\n\n[workspace.dependencies]\nx = { version = "9.9.9" }\n',
  );
  assert.equal(readWorkspaceVersion(root), "0.1.0");
});

function nightlyRunner(state: {
  pointsAt?: string;
  describe?: string | null;
  history?: string[];
  tagged?: Record<string, string>;
  preProfile?: string[];
  workspace?: string;
}) {
  const head = "c".repeat(40);
  const history = state.history ?? [head, "d".repeat(40), "e".repeat(40)];
  const calls: string[][] = [];
  const shown: string[] = [];
  const run: Runner = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "rev-parse") return head;
    if (args[0] === "rev-list") return history.join("\n");
    if (args[0] === "show") {
      const spec = args[1]!;
      if (spec.endsWith(":scripts/app-release.mts")) {
        return state.preProfile?.some((sha) => spec.startsWith(sha))
          ? 'command === "stamp"'
          : 'command === "build-matrix"; command === "collect-bundles"';
      }
      shown.push(spec);
      return `[workspace]\nmembers = []\n\n[workspace.package]\nversion = "${state.workspace ?? "0.1.0"}"\n`;
    }
    if (args[0] === "tag" && args[1] === "--points-at")
      return args[2] === head ? (state.pointsAt ?? "") : (state.tagged?.[args[2]!] ?? "");
    if (args[0] === "tag" && args[1] === "--list") return existingTags.join("\n");
    if (args[0] === "describe") {
      if (state.describe === null) throw new Error("fatal: No names found");
      return state.describe ?? "v0.1.0-alpha.2";
    }
    if (args[0] === "log")
      return "- Fix saves (abc1234)\n- Bump @types/node for @boburning (def5678)";
    return "";
  };
  return { run, calls, head, history, shown };
}

const conclusions =
  (map: Record<string, string>) =>
  (sha: string): Promise<string> =>
    Promise.resolve(map[sha] ?? "");

void test("a green pre-profile ancestor cannot strand a nightly preview tag", async () => {
  const old = "d".repeat(40);
  const fake = nightlyRunner({ preProfile: [old] });
  const result = await nightlyPreview(conclusions({ [old]: "success" }), fake.run);
  assert.ok("skipped" in result);
  assert.match(result.skipped, /ddddddddd predates the release profile/u);
  assert.ok(!fake.calls.some((call) => call[1] === "push" || call[2] === "-a"));
});

void test("the nightly preview tags a CI-green untagged main once and lists its new commits", async () => {
  const ok = nightlyRunner({});
  const result = await nightlyPreview(conclusions({ [ok.head]: "success" }), ok.run);
  assert.deepEqual(result, {
    tag: "nightly-0.1.0-preview.1",
    version: "0.1.0-preview.1",
    commit: ok.head,
  });
  assert.deepEqual(ok.calls.find((call) => call[1] === "rev-list")!.slice(1), [
    "rev-list",
    "--first-parent",
    "-n",
    String(nightlyLookback),
    ok.head,
  ]);
  assert.deepEqual(
    ok.calls.find((call) => call[1] === "tag" && call[2] === "--points-at")!.slice(1),
    ["tag", "--points-at", ok.head, "--list", "v*", "nightly-*"],
  );
  assert.deepEqual(ok.calls.find((call) => call[1] === "tag" && call[2] === "--list")!.slice(1), [
    "tag",
    "--list",
    "v*",
    "nightly-*",
  ]);
  assert.deepEqual(ok.calls.find((call) => call[1] === "describe")!.slice(1), [
    "describe",
    "--tags",
    "--abbrev=0",
    "--match",
    "v*",
    "--match",
    "nightly-*",
    ok.head,
  ]);
  assert.equal(ok.calls.find((call) => call[1] === "log")!.at(-1), `v0.1.0-alpha.2..${ok.head}`);
  const tag = ok.calls.find((call) => call[1] === "tag" && call[2] === "-a")!;
  assert.deepEqual(tag.slice(1), [
    "tag",
    "-a",
    "--cleanup=verbatim",
    "nightly-0.1.0-preview.1",
    "-m",
    // A full-width at sign keeps commit subjects from mentioning anyone.
    "Portcove 0.1.0-preview.1 (nightly)\n\nChanges since v0.1.0-alpha.2:\n\n- Fix saves (abc1234)\n- Bump ＠types/node for ＠boburning (def5678)\n",
    ok.head,
  ]);
  assert.ok(!tag.join(" ").includes("@"));
  assert.equal(quietMentions("a@b"), "a＠b");
  assert.deepEqual(ok.calls.at(-1), ["git", "push", "origin", "refs/tags/nightly-0.1.0-preview.1"]);

  const first = nightlyRunner({ describe: null });
  await nightlyPreview(() => Promise.resolve("success"), first.run);
  assert.equal(first.calls.find((call) => call[1] === "log")!.at(-1), first.head);

  const skips: [ReturnType<typeof nightlyRunner>, Record<string, string>, RegExp][] = [
    [nightlyRunner({ pointsAt: "v0.1.0-preview.1" }), {}, /already tagged v0\.1\.0-preview\.1/u],
    [
      nightlyRunner({ pointsAt: "nightly-0.1.0-preview.1" }),
      {},
      /already tagged nightly-0\.1\.0-preview\.1/u,
    ],
    [nightlyRunner({}), {}, /any of the latest 3 main commits \(ccccccccc got 'none'; d+ got/u],
    [
      nightlyRunner({ tagged: { ["d".repeat(40)]: "nightly-0.1.0-preview.1" } }),
      { ["d".repeat(40)]: "success", ["e".repeat(40)]: "success" },
      /no CI-green main commit is newer than nightly-0\.1\.0-preview\.1 \(ccccccccc got 'none'\)/u,
    ],
  ];
  for (const [fake, ci, reason] of skips) {
    const skipped = await nightlyPreview(conclusions(ci), fake.run);
    assert.ok("skipped" in skipped);
    assert.match(skipped.skipped, reason);
    assert.ok(!fake.calls.some((call) => call[1] === "push" || call[2] === "-a"));
  }
  // A stray non-preview nightly-* tag on HEAD does not suppress the nightly.
  const stray = nightlyRunner({ pointsAt: "nightly-9.9.9" });
  assert.equal(
    (
      (await nightlyPreview(() => Promise.resolve("success"), stray.run)) as {
        tag: string;
      }
    ).tag,
    "nightly-0.1.0-preview.1",
  );
  const offMain: Runner = (_command, args) =>
    args[0] === "rev-parse" ? (args[1] === "HEAD" ? "a".repeat(40) : "b".repeat(40)) : "";
  await assert.rejects(
    nightlyPreview(() => Promise.resolve("success"), offMain),
    /origin\/main/u,
  );
});

void test("a busy main tags the newest CI-green commit and stops querying CI there", async () => {
  const fake = nightlyRunner({});
  const [head, older, oldest] = fake.history as [string, string, string];
  const asked: string[] = [];
  const result = await nightlyPreview((sha) => {
    asked.push(sha);
    return Promise.resolve(sha === head ? "" : "success");
  }, fake.run);
  assert.deepEqual(result, {
    tag: "nightly-0.1.0-preview.1",
    version: "0.1.0-preview.1",
    commit: older,
  });
  assert.deepEqual(asked, [head, older]);
  assert.ok(!asked.includes(oldest));
  assert.equal(fake.calls.find((call) => call[1] === "describe")!.at(-1), older);
  assert.equal(fake.calls.find((call) => call[1] === "log")!.at(-1), `v0.1.0-alpha.2..${older}`);
  assert.equal(fake.calls.find((call) => call[1] === "tag" && call[2] === "-a")!.at(-1), older);
  // The version follows the chosen commit's workspace, not HEAD's.
  assert.deepEqual(fake.shown, [`${older}:Cargo.toml`]);
  const bumped = nightlyRunner({ workspace: "0.2.0" });
  assert.equal(
    ((await nightlyPreview(() => Promise.resolve("success"), bumped.run)) as { version: string })
      .version,
    "0.2.0-preview.1",
  );
  // A failed newer CI run does not block an older green commit either.
  const failed = nightlyRunner({});
  const picked = await nightlyPreview(
    conclusions({ [failed.head]: "failure", [failed.history[1]!]: "success" }),
    failed.run,
  );
  assert.equal((picked as { commit: string }).commit, failed.history[1]);
});

void test("each main commit takes the conclusion of its newest CI run and attempt", () => {
  const run = (id: number, sha: string, conclusion: string | null, attempt = 1, name = "CI") => ({
    id,
    head_sha: sha,
    conclusion,
    run_attempt: attempt,
    name,
  });
  const result = newestConclusions([
    run(3, "a", "cancelled"),
    run(1, "b", "success"),
    run(2, "b", "failure"),
    run(4, "c", "failure", 1),
    run(4, "c", "success", 2),
    run(5, "d", "success", 1, "Upstream health"),
    run(6, "e", null),
  ]);
  assert.deepEqual(Object.fromEntries(result), {
    a: "cancelled",
    b: "failure",
    c: "success",
    e: "",
  });
});

void test("the withdrawn list is a sorted unique version array that the feed publisher honours", () => {
  assert.deepEqual(parseWithdrawnList(null), []);
  assert.deepEqual(addWithdrawn(["0.1.1"], "0.1.0-preview.2"), ["0.1.0-preview.2", "0.1.1"]);
  assert.deepEqual(addWithdrawn(["0.1.0-preview.2", "0.1.1"], "0.1.1"), [
    "0.1.0-preview.2",
    "0.1.1",
  ]);
  assert.equal(isWithdrawn("0.1.1", '["0.1.0","0.1.1"]'), true);
  assert.equal(isWithdrawn("0.1.2", '["0.1.0","0.1.1"]'), false);
  assert.equal(isWithdrawn("0.1.1", null), false);
  for (const bad of ["{}", '["v0.1.0"]', "[1]", "not json"])
    assert.throws(() => isWithdrawn("0.1.1", bad));
});

void test("the withdrawn command prints true or false and fails on an unreadable list", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "app-release-withdrawn-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const list = path.join(dir, "withdrawn.json");
  const withdrawn = (file: string) =>
    execFileSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "app-release.mts"),
        "withdrawn",
        "--version",
        "0.1.1",
        "--file",
        file,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  assert.equal(withdrawn(list), "false");
  await writeFile(list, '["0.1.1"]\n');
  assert.equal(withdrawn(list), "true");
  await writeFile(list, "{");
  assert.throws(() => withdrawn(list));
});

type FakeRelease = {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  body: string;
  published_at: string;
};

const release = (id: number, version: string, draft = false, prefix = "v"): FakeRelease => ({
  id,
  tag_name: `${prefix}${version}`,
  draft,
  prerelease: version.includes("-"),
  body: `Notes for ${version}`,
  published_at: `2026-11-${String(10 + id)}T00:00:00Z`,
});

void test("withdraw replacements are the newest published, non-withdrawn release per channel", () => {
  const releases = publishedReleases([
    release(1, "0.1.0-alpha.2"),
    release(2, "0.1.0-preview.1", false, "nightly-"),
    release(3, "0.1.0"),
    release(4, "0.1.1-preview.1"),
    release(5, "0.1.1"),
    release(6, "0.1.2", true),
    release(7, "1.0.0"),
    release(8, "1.0.1-preview.1"),
    // A nightly-* tag never names a Beta or Stable release.
    release(9, "1.0.2", false, "nightly-"),
  ]);
  assert.deepEqual(
    releases.map((entry) => entry.tag),
    [
      "nightly-0.1.0-preview.1",
      "v0.1.0",
      "v0.1.1-preview.1",
      "v0.1.1",
      "v1.0.0",
      "v1.0.1-preview.1",
    ],
  );
  const pick = (channel: Channel, withdrawn: string[]) =>
    replacementCandidates(channel, releases, withdrawn)[0]?.version ?? null;
  assert.deepEqual(
    replacementCandidates("beta", releases, []).map((entry) => entry.version),
    ["1.0.0", "0.1.1", "0.1.0"],
  );
  assert.equal(pick("preview", ["1.0.1-preview.1"]), "1.0.0");
  assert.equal(pick("beta", ["1.0.0"]), "0.1.1");
  assert.equal(pick("stable", ["1.0.0"]), null);
  assert.equal(pick("beta", ["1.0.0", "0.1.1"]), "0.1.0");
  assert.equal(pick("preview", ["1.0.1-preview.1", "1.0.0", "0.1.1"]), "0.1.1-preview.1");
  assert.equal(pick("beta", ["1.0.0", "0.1.1", "0.1.0"]), null);
});

const gitIdentity = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"];

async function pagesRepository(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "app-release-withdraw-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...gitIdentity, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const clone = path.join(root, "clone");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "gh-pages", origin]);
  execFileSync("git", ["init", "--quiet", "-b", "gh-pages", seed]);
  for (const channel of ["preview", "beta"]) {
    await mkdir(path.join(seed, "updates", channel), { recursive: true });
    await writeFile(
      path.join(seed, "updates", channel, "latest.json"),
      `${JSON.stringify({ version: "0.1.1", platforms: {} })}\n`,
    );
  }
  await writeFile(path.join(seed, ".nojekyll"), "");
  git(seed, "add", "--all");
  git(seed, "commit", "--quiet", "-m", "seed");
  git(seed, "push", "--quiet", origin, "gh-pages");
  execFileSync("git", ["clone", "--quiet", origin, clone]);
  const run: Runner = (command, args) =>
    execFileSync(command, [...gitIdentity, ...args], { encoding: "utf8" }).trim();
  const show = (file: string) => {
    try {
      return git(origin, "show", `gh-pages:${file}`);
    } catch {
      return null;
    }
  };
  return { root, clone, run, show, git, origin };
}

function fakeWithdrawApi(releases: FakeRelease[], latest: string | null, unsigned: string[] = []) {
  const edits: [number, { body?: string; make_latest?: string }][] = [];
  const signed: string[] = [];
  let current = latest;
  const api: WithdrawApi = {
    releases: () => Promise.resolve(releases.map((entry) => ({ ...entry }))),
    latestTag: () => Promise.resolve(current),
    signatures: async (tag, dir) => {
      signed.push(tag);
      const version = tagVersion(tag)!;
      // An unsigned release lacks its AppImage signature.
      const suffixes = unsigned.includes(tag)
        ? ["_x64-setup.exe", "_universal.app.tar.gz"]
        : ["_x64-setup.exe", "_amd64.AppImage", "_universal.app.tar.gz"];
      for (const suffix of suffixes)
        await writeFile(
          path.join(dir, `Portcove_${version}${suffix}.sig`),
          `sig ${version}${suffix}\n`,
        );
    },
    editRelease: (id, fields) => {
      edits.push([id, { ...fields }]);
      const edited = releases.find((entry) => entry.id === id)!;
      if (fields.body !== undefined) edited.body = fields.body;
      if (fields.make_latest === "true") current = edited.tag_name;
      if (fields.make_latest === "false" && current === edited.tag_name) current = null;
      return Promise.resolve();
    },
  };
  return { api, edits, signed };
}

void test("withdraw repoints every feed serving the version, records it and marks the release", async (t) => {
  const repo = await pagesRepository(t);
  const releases = [
    release(1, "0.1.0-preview.1"),
    release(2, "0.1.0"),
    release(3, "0.1.1-preview.1"),
    release(4, "0.1.1"),
  ];
  const fake = fakeWithdrawApi(releases, "v0.1.1");
  const sleeps: number[] = [];
  const options = {
    version: "0.1.1",
    note: "Install 0.1.0 until 0.1.2 ships.",
    repoDir: repo.clone,
    workDir: path.join(repo.root, "work"),
    api: fake.api,
    run: repo.run,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
  const result = await withdrawRelease(options);
  assert.deepEqual(result.feeds, { preview: "0.1.1-preview.1", beta: "0.1.0" });
  assert.equal(result.pushed, true);
  assert.deepEqual(JSON.parse(repo.show("updates/withdrawn.json")!), ["0.1.1"]);
  const preview = JSON.parse(repo.show("updates/preview/latest.json")!) as {
    version: string;
    notes: string;
    pub_date: string;
    platforms: Record<string, { signature: string; url: string }>;
  };
  assert.equal(preview.version, "0.1.1-preview.1");
  assert.equal(preview.notes, "Notes for 0.1.1-preview.1");
  assert.equal(preview.pub_date, "2026-11-13T00:00:00Z");
  assert.deepEqual(preview.platforms["windows-x86_64"], {
    signature: "sig 0.1.1-preview.1_x64-setup.exe",
    url: "https://github.com/boburning/portcove/releases/download/v0.1.1-preview.1/Portcove_0.1.1-preview.1_x64-setup.exe",
  });
  const version = (file: string) => (JSON.parse(repo.show(file)!) as { version: string }).version;
  assert.equal(version("updates/beta/latest.json"), "0.1.0");
  assert.equal(repo.show("updates/stable/latest.json"), null);
  assert.equal(repo.show(".nojekyll"), "");
  assert.deepEqual(fake.signed.sort(), ["v0.1.0", "v0.1.1-preview.1"]);
  // The withdrawn release is marked and loses Latest to the newest eligible release.
  assert.equal(fake.edits[0]![0], 4);
  assert.equal(fake.edits[0]![1].make_latest, "false");
  assert.equal(
    fake.edits[0]![1].body,
    "⚠️ Withdrawn — do not install. Install 0.1.0 until 0.1.2 ships.\n\n---\n\nNotes for 0.1.1",
  );
  assert.deepEqual(fake.edits[1], [2, { make_latest: "true" }]);
  assert.equal(result.latestAfter, "v0.1.0");
  assert.deepEqual(sleeps, []);

  // A re-run changes no feed and does not add the notice twice.
  const commits = repo.git(repo.origin, "rev-list", "--count", "gh-pages");
  const again = await withdrawRelease(options);
  assert.equal(again.pushed, false);
  assert.equal(repo.git(repo.origin, "rev-list", "--count", "gh-pages"), commits);
  assert.deepEqual(fake.edits[2], [4, { make_latest: "false" }]);
  assert.equal(fake.edits.length, 3);

  // Withdrawing the only remaining Beta removes the Beta feed and leaves Latest unset.
  const last = await withdrawRelease({ ...options, version: "0.1.0", note: "" });
  assert.deepEqual(last.feeds, { beta: "removed" });
  assert.equal(repo.show("updates/beta/latest.json"), null);
  assert.equal(version("updates/preview/latest.json"), "0.1.1-preview.1");
  assert.deepEqual(JSON.parse(repo.show("updates/withdrawn.json")!), ["0.1.0", "0.1.1"]);
  assert.equal(releases[1]!.body, "⚠️ Withdrawn — do not install.\n\n---\n\nNotes for 0.1.0");
  assert.equal(last.latest, null);
});

void test("withdraw accepts nightly releases and skips replacements without every signature", async (t) => {
  const repo = await pagesRepository(t);
  const releases = [
    release(1, "0.1.0"),
    release(2, "0.1.1-preview.1", false, "nightly-"),
    release(3, "0.1.1-preview.2", false, "nightly-"),
    release(4, "0.1.1-preview.3", false, "nightly-"),
  ];
  // The preview feed serves the nightly being withdrawn; the newest older nightly is unsigned.
  const writer = path.join(repo.root, "writer");
  execFileSync("git", ["clone", "--quiet", "-b", "gh-pages", repo.origin, writer]);
  await writeFile(
    path.join(writer, "updates/preview/latest.json"),
    `${JSON.stringify({ version: "0.1.1-preview.3", platforms: {} })}\n`,
  );
  await writeFile(
    path.join(writer, "updates/beta/latest.json"),
    `${JSON.stringify({ version: "0.1.0", platforms: {} })}\n`,
  );
  repo.git(writer, "commit", "--quiet", "--all", "-m", "nightly feed");
  repo.git(writer, "push", "--quiet", "origin", "gh-pages");
  const fake = fakeWithdrawApi(releases, "v0.1.0", ["nightly-0.1.1-preview.2"]);
  const logs: string[] = [];
  const options = {
    version: "0.1.1-preview.3",
    note: "",
    repoDir: repo.clone,
    workDir: path.join(repo.root, "work"),
    api: fake.api,
    run: repo.run,
    log: (message: string) => logs.push(message),
  };
  const result = await withdrawRelease(options);
  assert.equal(result.tag, "nightly-0.1.1-preview.3");
  assert.deepEqual(result.feeds, { preview: "0.1.1-preview.1" });
  assert.deepEqual(fake.signed, ["nightly-0.1.1-preview.2", "nightly-0.1.1-preview.1"]);
  assert.match(
    logs.join("\n"),
    /nightly-0\.1\.1-preview\.2 cannot replace a feed: missing signed/u,
  );
  const preview = JSON.parse(repo.show("updates/preview/latest.json")!) as {
    version: string;
    platforms: Record<string, { url: string }>;
  };
  assert.equal(
    preview.platforms["linux-x86_64"]!.url,
    "https://github.com/boburning/portcove/releases/download/nightly-0.1.1-preview.1/Portcove_0.1.1-preview.1_amd64.AppImage",
  );
  // Beta does not serve the nightly and stays; a pre-release never loses or gains Latest.
  assert.equal(
    (JSON.parse(repo.show("updates/beta/latest.json")!) as { version: string }).version,
    "0.1.0",
  );
  assert.deepEqual(
    fake.edits.map(([id, fields]) => [id, Object.keys(fields)]),
    [[4, ["body"]]],
  );
  assert.equal(result.latestAfter, "v0.1.0");

  // When no candidate has every signature, the feed is removed rather than blocking.
  const none = fakeWithdrawApi(releases, "v0.1.0", ["nightly-0.1.1-preview.2", "v0.1.0"]);
  const removed = await withdrawRelease({ ...options, version: "0.1.1-preview.1", api: none.api });
  assert.deepEqual(removed.feeds, { preview: "removed" });
  assert.equal(repo.show("updates/preview/latest.json"), null);
});

void test("withdraw refuses a version without a published release and changes nothing", async (t) => {
  const repo = await pagesRepository(t);
  const fake = fakeWithdrawApi([release(1, "0.1.0"), release(2, "0.1.1", true)], null);
  const attempt = (version: string) =>
    withdrawRelease({
      version,
      note: "",
      repoDir: repo.clone,
      workDir: path.join(repo.root, "work"),
      api: fake.api,
      run: repo.run,
    });
  await assert.rejects(attempt("0.1.1"), /^Error: 0\.1\.1 is not a published release/u);
  await assert.rejects(attempt("0.1.2"), /^Error: 0\.1\.2 is not a published release/u);
  await assert.rejects(attempt("0.1.0-alpha.1"), /only -preview\.N/u);
  await assert.rejects(attempt("v0.1.0"), /not a SemVer version/u);
  assert.equal(repo.show("updates/withdrawn.json"), null);
  assert.deepEqual(fake.edits, []);
});

void test("withdraw retries a rejected gh-pages push on top of the newer branch", async (t) => {
  const repo = await pagesRepository(t);
  const fake = fakeWithdrawApi([release(1, "0.1.0"), release(2, "0.1.1")], null);
  let rejected = false;
  const run: Runner = (command, args) => {
    if (!rejected && args.includes("push")) {
      rejected = true;
      // Another publisher moves gh-pages first.
      const other = path.join(repo.root, "other");
      execFileSync("git", ["clone", "--quiet", "-b", "gh-pages", repo.origin, other]);
      repo.git(other, "commit", "--quiet", "--allow-empty", "-m", "other");
      repo.git(other, "push", "--quiet", "origin", "gh-pages");
      throw new Error("rejected");
    }
    return repo.run(command, args);
  };
  const sleeps: number[] = [];
  const result = await withdrawRelease({
    version: "0.1.1",
    note: "",
    repoDir: repo.clone,
    workDir: path.join(repo.root, "work"),
    api: fake.api,
    run,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  assert.deepEqual(sleeps, [5000]);
  assert.equal(result.pushed, true);
  assert.equal(repo.git(repo.origin, "log", "-1", "--format=%s", "gh-pages~1"), "other");
  assert.deepEqual(result.feeds, { preview: "0.1.0", beta: "0.1.0" });
});

type WorkflowStep = {
  "timeout-minutes"?: number;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
};
type WorkflowJob = {
  if?: string;
  strategy?: { matrix?: string };
  uses?: string;
  secrets?: string | Record<string, string>;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  environment?: string | { name?: string; url?: string; deployment?: boolean };
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};
type Workflow = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

const workflowsDirectory = path.join(import.meta.dirname, "..", ".github", "workflows");
const readWorkflow = async (name: string) =>
  parse(await readFile(path.join(workflowsDirectory, name), "utf8")) as Workflow;

void test("the release requires every desktop bundle, signature and standalone CLI archive", async () => {
  const version = "0.1.0-preview.7";
  const names = [
    "Portcove_0.1.0-preview.7_x64-setup.exe",
    "Portcove_0.1.0-preview.7_x64-setup.exe.sig",
    "Portcove_0.1.0-preview.7_amd64.AppImage",
    "Portcove_0.1.0-preview.7_amd64.AppImage.sig",
    "Portcove_0.1.0-preview.7_universal.app.tar.gz",
    "Portcove_0.1.0-preview.7_universal.app.tar.gz.sig",
    "Portcove_0.1.0-preview.7_universal.dmg",
    "portcove-cli-0.1.0-preview.7-windows-x86_64.zip",
    "portcove-cli-0.1.0-preview.7-linux-x86_64.tar.gz",
    "portcove-cli-0.1.0-preview.7-macos-aarch64.tar.gz",
    "portcove-cli-0.1.0-preview.7-macos-x86_64.tar.gz",
    "SHA256SUMS",
  ];
  const section = await renderAppReleaseDownloadSection(`nightly-${version}`, version, names);
  assert.match(section, /Channel: Nightly Preview/u);
  assert.match(section, /Linux x86-64.*AppImage.*run directly/u);
  assert.match(section, /Apple Silicon and Intel.*Desktop disk image/u);
  assert.match(section, /universal\.app\.tar\.gz.*is for the macOS updater/u);
  assert.match(section, /SHA256SUMS.*nightly-0\.1\.0-preview\.7/u);
  assert.match(section, /\.\/portcove --json capabilities/u);
  assert.match(section, /schema_version/u);
  for (const name of names.filter((name) => !name.endsWith(".sig"))) {
    assert.ok(section.includes(`/releases/download/nightly-${version}/${name}`));
  }
  await assert.rejects(
    renderAppReleaseDownloadSection("nightly-0.1.0-preview.6", version, names),
    /tag and version disagree/u,
  );
  await assert.rejects(
    renderAppReleaseDownloadSection(
      `v${version}`,
      version,
      names.filter((name) => !name.includes("cli-")),
    ),
    /missing:.*portcove-cli/u,
  );
  await assertAppReleaseAssets(version, names);
  for (const missing of names) {
    await assert.rejects(
      assertAppReleaseAssets(
        version,
        names.filter((name) => name !== missing),
      ),
      (error: Error) => error.message.includes(`missing: ${missing}; unexpected: none`),
    );
  }
  await assert.rejects(
    assertAppReleaseAssets(version, [...names, "stale.zip"]),
    /unexpected: stale.zip/u,
  );
});

void test("collects the universal bundle and preserves a one-platform CLI inventory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-app-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const version = "0.1.0-preview.7";
  const dist = path.join(root, "dist");
  const bundle = path.join(root, "target/universal-apple-darwin/release/bundle");
  await mkdir(path.join(bundle, "macos"), { recursive: true });
  await mkdir(path.join(bundle, "dmg"));
  await writeFile(path.join(bundle, "macos/Portcove.app.tar.gz"), "archive");
  const dmg = `Portcove_${version}_universal.dmg`;
  const updater = `Portcove_${version}_universal.app.tar.gz`;
  await writeFile(path.join(bundle, "dmg", dmg), "disk image");
  assert.throws(
    () => collectAppReleaseBundles(root, dist, "macos-universal", version),
    /Portcove\.app\.tar\.gz\.sig/u,
  );
  const signaturePath = path.join(bundle, "macos/Portcove.app.tar.gz.sig");
  await writeFile(signaturePath, "  \n");
  assert.throws(
    () => collectAppReleaseBundles(root, dist, "macos-universal", version),
    /missing signed updater asset signature/u,
  );
  await writeFile(signaturePath, "signature");
  collectAppReleaseBundles(root, dist, "macos-universal", version);
  assert.deepEqual((await readdir(dist)).sort(), [dmg, updater, `${updater}.sig`].sort());

  const mac = appReleaseProfile.find(({ label }) => label === "macos-universal")!;
  const feed = buildFeed({
    version,
    notes: "",
    pubDate: "",
    assetsDir: dist,
    downloadBase: "https://example.test",
    profile: [mac],
  });
  assert.deepEqual(feed.platforms, {
    "darwin-aarch64": { signature: "signature", url: `https://example.test/${updater}` },
    "darwin-x86_64": { signature: "signature", url: `https://example.test/${updater}` },
  });

  const profile = appReleaseProfile.map((target) =>
    target.label === "windows-x86_64" ? target : { ...target, cliTargets: {} },
  );
  const names = [
    dmg,
    updater,
    `${updater}.sig`,
    "SHA256SUMS",
    `portcove-cli-${version}-windows-x86_64.zip`,
    `Portcove_${version}_x64-setup.exe`,
    `Portcove_${version}_x64-setup.exe.sig`,
    `Portcove_${version}_amd64.AppImage`,
    `Portcove_${version}_amd64.AppImage.sig`,
  ];
  const notes = await renderAppReleaseDownloadSection(`v${version}`, version, names, profile);
  assert.equal(notes.match(/Standalone CLI \(extract and run\)/gu)?.length, 1);
  assert.match(notes, /Standalone CLI.*windows-x86_64\.zip/u);
  assert.match(notes, /Apple Silicon and Intel.*Desktop disk image/u);
  await assert.rejects(
    assertAppReleaseAssets(
      version,
      [...names, `portcove-cli-${version}-linux-x86_64.tar.gz`],
      profile,
    ),
    /unexpected:/u,
  );
});

void test("the Linux AppImage build checks its WebKitGTK floor before bundling", async () => {
  const workflow = await readWorkflow("app-release-build.yml");
  const build = workflow.jobs.build!;
  assert.equal(
    appReleaseMatrix().include.find(({ label }) => label === "linux-x86_64")?.os,
    "ubuntu-24.04",
  );
  assert.equal(build.strategy?.matrix, "${{ fromJSON(needs.plan.outputs.matrix) }}");
  assert.match(workflow.jobs.plan!.steps!.at(-1)?.run ?? "", /app-release\.mts build-matrix/u);
  assert.match(
    build.steps!.find(({ name }) => name === "Collect release assets")?.run ?? "",
    /collect-bundles/u,
  );
  const steps = build.steps!;
  const prerequisites = steps.findIndex(
    (step) => step.name === "Install Linux desktop prerequisites",
  );
  const bundle = steps.findIndex((step) => step.run?.includes("pnpm tauri build"));
  assert.ok(prerequisites >= 0 && prerequisites < bundle);
  assert.equal(steps[prerequisites]?.if, "runner.os == 'Linux'");
  assert.equal(steps[prerequisites]?.["timeout-minutes"], 28);
  assert.match(
    steps[prerequisites]?.run ?? "",
    /install-linux-desktop-prerequisites\.sh --prefer-archive-mirror --install-timeout-seconds=600/u,
  );
  assert.match(
    steps[prerequisites]?.run ?? "",
    /pkg-config --atleast-version=2\.52\.6 webkit2gtk-4\.1/u,
  );
});

void test("release workflows keep the signing key behind owner tags and main", async () => {
  const release = await readWorkflow("app-release.yml");
  const build = await readWorkflow("app-release-build.yml");
  const nightly = await readWorkflow("nightly-preview.yml");
  const withdraw = await readWorkflow("withdraw-release.yml");
  // Owner v* tags are the only trigger of the tag path; nothing dispatches it.
  assert.deepEqual(Object.keys(release.on), ["push"]);
  assert.deepEqual(release.on.push, { tags: ["v*"] });
  assert.equal(release.jobs.plan!.if, "startsWith(github.ref, 'refs/tags/v')");
  assert.deepEqual(release.jobs.release!.with, {
    version: "${{ needs.plan.outputs.version }}",
    tag: "${{ github.ref_name }}",
    prerelease: "${{ needs.plan.outputs.prerelease }}",
    feeds: "${{ needs.plan.outputs.feeds }}",
    environment: "${{ needs.plan.outputs.environment }}",
    commit: "${{ github.sha }}",
  });
  // The plan's environment is release-stable for Stable and release otherwise.
  for (const [version, environment] of [
    ["0.1.0-preview.1", "release"],
    ["0.1.0", "release"],
    ["1.0.0", "release-stable"],
  ] as const)
    assert.equal(classifyRelease(version).environment, environment);

  // The nightly signs only from main, always in release, and only for previews.
  assert.deepEqual(Object.keys(nightly.on).sort(), ["schedule", "workflow_dispatch"]);
  assert.equal(nightly.jobs.prepare!.if, "github.ref == 'refs/heads/main'");
  assert.equal(nightly.jobs.release!.uses, "./.github/workflows/app-release-build.yml");
  // GitHub gives a called workflow its environment's secrets only when the
  // caller passes them; without that the signing key is empty (v0.1.0-preview.1).
  assert.equal(nightly.jobs.release!.secrets, "inherit");
  assert.equal(release.jobs.release!.secrets, "inherit");
  assert.equal(nightly.jobs.release!.with!.environment, "release");
  assert.deepEqual(nightly.jobs.release!.permissions, { contents: "write" });

  // The shared jobs check their inputs before the signing step runs.
  assert.deepEqual(Object.keys(build.on), ["workflow_call"]);
  const buildSteps = build.jobs.build!.steps!;
  assert.deepEqual(build.jobs.build!.environment, {
    name: "${{ inputs.environment }}",
    deployment: false,
  });
  const verify = buildSteps.findIndex((step) =>
    step.run?.includes("app-release.mts verify-inputs"),
  );
  const sign = buildSteps.findIndex((step) => step.run?.includes("pnpm tauri build"));
  assert.ok(verify >= 0 && verify < sign);
  assert.equal(build.jobs.build!.permissions!.contents, "read");
  // The signing job restores no package cache that another workflow on main could write.
  const buildNode = buildSteps.find((step) => step.uses?.startsWith("actions/setup-node@"))!;
  assert.equal(buildNode.with?.["package-manager-cache"], false);
  assert.equal(buildNode.with?.cache, undefined);
  // The updater key reaches only the signing step's environment, never a job or other step.
  const signStep = buildSteps[sign]!;
  assert.deepEqual(Object.keys(signStep.env ?? {}).sort(), [
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  ]);
  const withoutSigningEnv = structuredClone(build);
  delete withoutSigningEnv.jobs.build!.steps![sign]!.env;
  assert.doesNotMatch(JSON.stringify(withoutSigningEnv), /\bsecrets\b/u);
  const buildSource = await readFile(
    path.join(workflowsDirectory, "app-release-build.yml"),
    "utf8",
  );
  assert.equal(buildSource.match(/secrets\.TAURI_SIGNING_/gu)?.length, 2);

  // Withdrawal is an owner process guard.
  assert.equal(
    withdraw.jobs.withdraw!.if,
    "github.actor_id == '43177418' && github.triggering_actor == 'boburning' && github.ref == 'refs/heads/main'",
  );

  // Installs skip lifecycle scripts, except the desktop build that needs allowed ones,
  // and checkouts keep no credentials unless the job pushes.
  const pushing = new Set([
    "app-release-build.yml:publish",
    "nightly-preview.yml:prepare",
    "withdraw-release.yml:withdraw",
  ]);
  for (const [name, workflow] of [
    ["app-release.yml", release],
    ["app-release-build.yml", build],
    ["nightly-preview.yml", nightly],
    ["withdraw-release.yml", withdraw],
  ] as const)
    for (const [id, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.run?.includes("pnpm install") && `${name}:${id}` !== "app-release-build.yml:build")
          assert.match(step.run, /--frozen-lockfile --ignore-scripts/u, `${name}:${id}`);
        if (step.uses?.startsWith("actions/checkout@"))
          assert.equal(
            step.with?.["persist-credentials"],
            pushing.has(`${name}:${id}`) ? undefined : false,
            `${name}:${id}`,
          );
      }
    }

  // Only the shared jobs select an updater-key environment, and only the two
  // release workflows call them.
  // External reusable workflows are refused outright: their environment selection
  // is not visible here, so every job-level `uses` must be a local workflow.
  const names = (await readdir(workflowsDirectory)).filter((name) => /\.ya?ml$/u.test(name));
  assert.ok(names.includes("app-release-build.yml"));
  for (const name of names) {
    const workflow = await readWorkflow(name);
    for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
      if (job.uses !== undefined)
        assert.match(job.uses, /^\.\/\.github\/workflows\/[\w.-]+\.ya?ml$/u, `${name}:${id}`);
      const environment =
        typeof job.environment === "object" && job.environment !== null
          ? String(job.environment.name ?? "")
          : String(job.environment ?? "");
      if (name !== "app-release-build.yml")
        assert.ok(
          !/^(?:release|release-stable)$/u.test(environment) &&
            !/'release(?:-stable)?'/u.test(environment) &&
            !/^\$\{\{\s*(?:inputs|needs|vars|github)\.[\w.-]+\s*\}\}$/u.test(environment),
          `${name}:${id} must not select a release signing environment`,
        );
      if (job.uses?.includes("app-release-build.yml"))
        assert.ok(["app-release.yml", "nightly-preview.yml"].includes(name), `${name}:${id}`);
    }
  }
});

void test("lists the complete provider inventory at 999, 1000 and 1001 releases", async () => {
  for (const count of [999, 1000, 1001]) {
    const releases = Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      tag_name: `v0.0.${index + 1}`,
      draft: index === count - 1,
      assets: [],
    }));
    const fallback = (status: number) =>
      new Response(JSON.stringify({ message: "fixture" }), {
        status,
        headers: { "content-type": "application/json" },
      });
    const endpoint = "https://api.github.com/repositories/1354613114/releases";
    const endpoints: string[] = [];
    let interrupt = false;
    const api = await fixtureGitHub(({ endpoint: route }) => {
      endpoints.push(route);
      if (route.includes("/tags/")) return route.endsWith("v0.0.1") ? releases[0] : fallback(404);
      if (route.endsWith(`/releases/${count}`)) return releases.at(-1);
      const page = Number(new URL(route, "https://api.github.com").searchParams.get("page") ?? 1);
      if (interrupt && page === 2) return fallback(500);
      const more = page * 100 < releases.length;
      return new Response(JSON.stringify(releases.slice((page - 1) * 100, page * 100)), {
        headers: {
          "content-type": "application/json",
          ...(more ? { link: `<${endpoint}?per_page=100&page=${page + 1}>; rel="next"` } : {}),
        },
      });
    });
    assert.equal((await findRelease(api, "v0.0.1"))?.id, 1);
    assert.equal(endpoints.length, 1, "published lookup reads the exact tag");
    assert.equal((await listReleases(api)).length, count);
    assert.equal((await findRelease(api, `v0.0.${count}`))?.draft, true);
    assert.equal(await findRelease(api, "absent"), null);
    interrupt = true;
    await assert.rejects(findRelease(api, "absent"), /inventory is incomplete/u);
    const observed = endpoints.length;
    assert.equal((await readReleaseById(api, count, `v0.0.${count}`)).id, count);
    assert.equal(endpoints.length - observed, 1, "retry reads the known ID directly");
  }
});

void test("nightly reporter isolates issue permissions and replays the triggering attempt", async () => {
  const monitor = await readWorkflow("nightly-failure-report.yml");
  assert.deepEqual(monitor.on.workflow_run, {
    workflows: ["Nightly preview"],
    types: ["completed"],
    branches: ["main"],
  });
  assert.deepEqual(monitor.permissions, {});
  const job = monitor.jobs.report!;
  assert.deepEqual(job.permissions, { actions: "read", checks: "read", issues: "write" });
  assert.match(job.if ?? "", /head_repository\.full_name == github\.repository/u);
  const step = job.steps?.[0];
  assert.equal(job.steps?.length, 1);
  assert.ok(step);
  assert.match(step.uses ?? "", /^actions\/github-script@[a-f0-9]{40}$/u);
  const script = step.with?.script;
  assert.ok(typeof script === "string");
  assert.doesNotMatch(script, /secrets\.|actions\/checkout|publish --tag/u);
  const execute = new Script(`(async () => {\n${script}\n})()`);

  const run = {
    id: 44324930784,
    run_number: 7,
    run_attempt: 2,
    path: ".github/workflows/nightly-preview.yml",
    head_repository: { full_name: "boburning/portcove", owner: { id: 43177418 } },
    head_branch: "main",
    status: "completed",
    conclusion: "cancelled",
    event: "schedule",
    head_sha: "a".repeat(40),
    created_at: "2026-11-18T14:30:00Z",
    updated_at: "2026-11-18T15:00:00Z",
  };
  const oldBody = "<!-- portcove-nightly-failure-run:44324930784 -->\nOriginal incident.";
  const issue = { number: 8176, state: "closed", body: oldBody, user: { id: 43177418 } };
  const forgedIssue = { ...issue, number: 123, user: { id: 42 } };
  const forgedComment = {
    body: "<!-- portcove-nightly-failure-attempt:44324930784:2 -->",
    user: { id: 42 },
  };
  const comments: Array<{ body: string; user: { id: number } }> = [];
  const warnings: string[] = [];
  let existing = true;
  let reopenCount = 0;
  let created: { body: string; assignees: string[] } | undefined;
  let botIssue:
    | { number: number; body: string; user: { id: number }; assignees: Array<{ login: string }> }
    | undefined;
  let jobsAvailable = true;
  let assignmentAvailable = false;
  const github = {
    paginate: (route: string, params: { attempt_number?: number; issue_number?: number }) => {
      switch (route) {
        case "issues":
          if (existing) return [forgedIssue, issue];
          return botIssue ? [forgedIssue, botIssue] : [forgedIssue];
        case "comments":
          assert.equal(params.issue_number, 8176);
          return [forgedComment, ...comments];
        case "jobs":
          assert.equal(params.attempt_number, 2);
          if (!jobsAvailable) throw new Error("Job lookup unavailable");
          return [
            {
              id: 134874555631,
              name: "release / Build macos-universal",
              conclusion: "cancelled",
              steps: [],
            },
            {
              id: 134874555632,
              name: "release / Build windows-x86_64",
              conclusion: "failure",
              steps: [{ name: "Build bundles", conclusion: "failure" }],
            },
          ];
        case "annotations":
          return [
            { annotation_level: "warning", message: "Do not publish raw annotations" },
            {
              annotation_level: "failure",
              message:
                "The job was not acquired by Runner of type hosted even after multiple attempts",
            },
          ];
        default:
          throw new Error("Unexpected route " + route);
      }
    },
    rest: {
      actions: { listJobsForWorkflowRunAttempt: "jobs" },
      checks: { listAnnotations: "annotations" },
      issues: {
        listForRepo: "issues",
        listComments: "comments",
        update: (params: { issue_number: number; state: string }) => {
          assert.equal(params.issue_number, 8176);
          assert.equal(params.state, "open");
          reopenCount++;
        },
        createComment: (params: { issue_number: number; body: string }) => {
          assert.equal(params.issue_number, 8176);
          comments.push({ body: params.body, user: { id: 41898282 } });
        },
        create: (params: { body: string; assignees: string[] }) => {
          created = params;
          botIssue = { number: 8183, body: params.body, user: { id: 41898282 }, assignees: [] };
          return { data: botIssue };
        },
        addAssignees: (params: { issue_number: number; assignees: string[] }) => {
          assert.equal(params.issue_number, 8183);
          assert.equal(params.assignees.join(","), "boburning");
          if (!assignmentAvailable) throw new Error("Assignment temporarily unavailable");
          assert.ok(botIssue);
          botIssue.assignees.push({ login: "boburning" });
          return { data: botIssue };
        },
      },
    },
  };
  const replay = async () => {
    await execute.runInNewContext({
      github,
      context: { repo: { owner: "boburning", repo: "portcove" }, payload: { workflow_run: run } },
      core: {
        warning: (message: string) => warnings.push(message),
        summary: { addRaw: () => ({ write: async () => {} }) },
      },
      process: { env: { GITHUB_SERVER_URL: "https://github.com" } },
    });
  };

  await replay();
  await replay();
  assert.equal(reopenCount, 1);
  assert.equal(comments.length, 1);
  assert.equal(issue.body, oldBody);
  assert.match(comments[0]!.body, /\/attempts\/2/u);
  assert.match(comments[0]!.body, /never acquired a hosted runner.*\/job\/134874555631/u);
  assert.match(comments[0]!.body, /Build bundles.*\/job\/134874555632/u);
  assert.doesNotMatch(comments[0]!.body, /Do not publish raw annotations/u);

  existing = false;
  jobsAvailable = false;
  await assert.rejects(replay(), /Assignment temporarily unavailable/u);
  assert.equal(warnings.length, 1);
  assert.equal(created?.assignees.join(","), "boburning");
  assert.match(created?.body ?? "", /GitHub did not provide job metadata/u);
  assignmentAvailable = true;
  await replay();
  assert.deepEqual(botIssue?.assignees, [{ login: "boburning" }]);
  assert.equal(warnings.length, 1);
  assert.equal(comments.length, 1);
});
