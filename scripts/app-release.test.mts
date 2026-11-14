import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  addWithdrawn,
  assertNewerThanTags,
  buildFeed,
  classifyRelease,
  compareVersions,
  isWithdrawn,
  nextPreviewVersion,
  nightlyPreview,
  parseWithdrawnList,
  publishedReleases,
  readWorkspaceVersion,
  selectReplacement,
  stampVersion,
  tagRelease,
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

function nightlyRunner(state: { pointsAt?: string; describe?: string | null }) {
  const head = "c".repeat(40);
  const calls: string[][] = [];
  const run: Runner = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "rev-parse") return head;
    if (args[0] === "tag" && args[1] === "--points-at") return state.pointsAt ?? "";
    if (args[0] === "tag" && args[1] === "--list") return existingTags.join("\n");
    if (args[0] === "describe") {
      if (state.describe === null) throw new Error("fatal: No names found");
      return state.describe ?? "v0.1.0-alpha.2";
    }
    if (args[0] === "log") return "- Fix saves (abc1234)\n- Add a port (def5678)";
    return "";
  };
  return { run, calls, head };
}

void test("the nightly preview tags a CI-green untagged main once and lists its new commits", () => {
  const ok = nightlyRunner({});
  const result = nightlyPreview("0.1.0", (sha) => (sha === ok.head ? "success" : ""), ok.run);
  assert.deepEqual(result, {
    tag: "v0.1.0-preview.1",
    version: "0.1.0-preview.1",
    commit: ok.head,
  });
  assert.equal(ok.calls.find((call) => call[1] === "log")!.at(-1), `v0.1.0-alpha.2..${ok.head}`);
  const tag = ok.calls.find((call) => call[1] === "tag" && call[2] === "-a")!;
  assert.deepEqual(tag.slice(1), [
    "tag",
    "-a",
    "--cleanup=verbatim",
    "v0.1.0-preview.1",
    "-m",
    "Portcove 0.1.0-preview.1 (nightly)\n\nChanges since v0.1.0-alpha.2:\n\n- Fix saves (abc1234)\n- Add a port (def5678)\n",
    ok.head,
  ]);
  assert.deepEqual(ok.calls.at(-1), ["git", "push", "origin", "refs/tags/v0.1.0-preview.1"]);

  const first = nightlyRunner({ describe: null });
  nightlyPreview("0.1.0", () => "success", first.run);
  assert.equal(first.calls.find((call) => call[1] === "log")!.at(-1), first.head);

  const skips: [ReturnType<typeof nightlyRunner>, string, RegExp][] = [
    [
      nightlyRunner({ pointsAt: "v0.1.0-preview.1" }),
      "success",
      /already tagged v0\.1\.0-preview\.1/u,
    ],
    [nightlyRunner({}), "", /has not succeeded \(got 'none'\)/u],
    [nightlyRunner({}), "failure", /has not succeeded \(got 'failure'\)/u],
  ];
  for (const [fake, ci, reason] of skips) {
    const skipped = nightlyPreview("0.1.0", () => ci, fake.run);
    assert.ok("skipped" in skipped);
    assert.match(skipped.skipped, reason);
    assert.ok(!fake.calls.some((call) => call[1] === "push" || call[2] === "-a"));
  }
  const offMain: Runner = (_command, args) =>
    args[0] === "rev-parse" ? (args[1] === "HEAD" ? "a".repeat(40) : "b".repeat(40)) : "";
  assert.throws(() => nightlyPreview("0.1.0", () => "success", offMain), /origin\/main/u);
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

const release = (id: number, version: string, draft = false): FakeRelease => ({
  id,
  tag_name: `v${version}`,
  draft,
  prerelease: version.includes("-"),
  body: `Notes for ${version}`,
  published_at: `2026-11-${String(10 + id)}T00:00:00Z`,
});

void test("withdraw replacements are the newest published, non-withdrawn release per channel", () => {
  const releases = publishedReleases([
    release(1, "0.1.0-alpha.2"),
    release(2, "0.1.0-preview.1"),
    release(3, "0.1.0"),
    release(4, "0.1.1-preview.1"),
    release(5, "0.1.1"),
    release(6, "0.1.2", true),
    release(7, "1.0.0"),
    release(8, "1.0.1-preview.1"),
  ]);
  assert.deepEqual(
    releases.map((entry) => entry.version),
    ["0.1.0-preview.1", "0.1.0", "0.1.1-preview.1", "0.1.1", "1.0.0", "1.0.1-preview.1"],
  );
  const pick = (channel: Channel, withdrawn: string[]) =>
    selectReplacement(channel, releases, withdrawn)?.version ?? null;
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

function fakeWithdrawApi(releases: FakeRelease[], latest: string | null) {
  const edits: [number, { body?: string; make_latest?: string }][] = [];
  const signed: string[] = [];
  let current = latest;
  const api: WithdrawApi = {
    releases: () => Promise.resolve(releases.map((entry) => ({ ...entry }))),
    latestTag: () => Promise.resolve(current),
    signatures: async (tag, dir) => {
      signed.push(tag);
      const version = tag.slice(1);
      for (const suffix of ["_x64-setup.exe", "_amd64.AppImage", "_universal.app.tar.gz"])
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
  await assert.rejects(attempt("0.1.1"), /v0\.1\.1 is not a published release/u);
  await assert.rejects(attempt("0.1.2"), /v0\.1\.2 is not a published release/u);
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
