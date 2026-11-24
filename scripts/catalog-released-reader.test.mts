import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireCatalogReleasedReader,
  credentialFree,
  pagesWorktreeRevision,
  requireCatalogReleaseAttestation,
  requireCurrentCatalogReaderSelection,
  selectedPreview,
} from "./catalog-released-reader.mts";
import { fixtureReleasedReaderSources } from "./fixtures/released-reader-fixture.mts";
import type { ReleasedReaderFixture } from "./fixtures/released-reader-fixture.mts";

function temporary(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(path.join(tmpdir(), "portcove-released-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

void test("the official reader follows the protected feed across releases and respects withdrawal", () => {
  const feed = (version: string, tag: string, repository = "boburning/portcove") => ({
    version,
    platforms: {
      "linux-x86_64": {
        url: `https://github.com/${repository}/releases/download/${tag}/Portcove_${version}_amd64.AppImage`,
      },
    },
  });
  assert.deepEqual(selectedPreview(feed("0.1.0-preview.14", "nightly-0.1.0-preview.14"), []), {
    version: "0.1.0-preview.14",
    tag: "nightly-0.1.0-preview.14",
  });
  assert.deepEqual(selectedPreview(feed("0.1.0", "v0.1.0"), []), {
    version: "0.1.0",
    tag: "v0.1.0",
  });
  assert.throws(() => selectedPreview(feed("0.1.0", "v0.1.0"), ["0.1.0"]), /withdrawn/u);
  assert.throws(() => selectedPreview(feed("0.1.0", "v0.1.0", "fork/portcove"), []), /link/u);
  assert.throws(() => selectedPreview(feed("0.1.0", "v0.1.1"), []), /link/u);
  assert.throws(() => selectedPreview(feed("0.1.0", "nightly-0.1.0"), []), /link/u);
  assert.throws(() => selectedPreview(feed("0.1.0-beta.1", "v0.1.0-beta.1"), []), /version/u);
  assert.throws(() => selectedPreview(feed("0.1.0", "v0.1.0"), [1]), /withdrawal inventory/u);
});

void test("the verified release statement binds the exact tag object, release, archive and manifest", () => {
  const tag = "nightly-0.1.0-preview.14";
  const purl = `pkg:github/boburning/portcove@${tag}`;
  const subject = [
    { uri: purl, digest: { sha1: "tag-object" } },
    { name: "cli.tar.gz", digest: { sha256: "archive" } },
    { name: "SHA256SUMS", digest: { sha256: "manifest" } },
  ];
  const predicate = {
    tag,
    databaseId: "1",
    repository: "boburning/portcove",
    repositoryId: "1354613114",
    ownerId: "43177418",
    purl,
  };
  const statement = {
    predicateType: "https://in-toto.io/attestation/release/v0.2",
    predicate,
    subject,
  };
  const expected = {
    tag,
    tagObject: "tag-object",
    subjects: { "cli.tar.gz": "archive", SHA256SUMS: "manifest" },
  };
  assert.equal(requireCatalogReleaseAttestation(statement, expected), 1);
  assert.throws(
    () => requireCatalogReleaseAttestation(statement, { ...expected, tag: "v0.1.0" }),
    /identity/u,
  );
  for (const [field, value] of [
    ["repositoryId", "other"],
    ["ownerId", "other"],
    ["repository", "other"],
    ["databaseId", "0"],
    ["databaseId", 1],
  ] as const)
    assert.throws(
      () =>
        requireCatalogReleaseAttestation(
          { ...statement, predicate: { ...predicate, [field]: value } },
          expected,
        ),
      /identity/u,
    );
  assert.throws(
    () =>
      requireCatalogReleaseAttestation(
        { ...statement, predicateType: "https://in-toto.io/attestation/release/v0.1" },
        expected,
      ),
    /identity/u,
  );
  assert.throws(
    () => requireCatalogReleaseAttestation(statement, { ...expected, tagObject: "another" }),
    /subject/u,
  );
  assert.throws(
    () =>
      requireCatalogReleaseAttestation(statement, {
        ...expected,
        subjects: { SHA256SUMS: "another" },
      }),
    /subject/u,
  );
  subject.push({ name: "cli.tar.gz", digest: { sha256: "archive" } });
  assert.throws(() => requireCatalogReleaseAttestation(statement, expected), /subject/u);
});

void test("automatic acquisition verifies every release fact before unpacking the reader", async (t) => {
  const root = temporary(t);
  const binary = Buffer.from(`#!${process.execPath}\nprocess.exit(0);\n`);
  const acquire = (options: Omit<ReleasedReaderFixture, "binary" | "version"> = {}) => {
    const fixture = fixtureReleasedReaderSources({ ...options, binary, version: "0.1.0" });
    return {
      fixture,
      result: acquireCatalogReleasedReader(root, fixture.sources),
    };
  };
  const { fixture, result } = acquire();
  const acquired = await result;
  assert.deepEqual(readFileSync(acquired.cli), binary);
  assert.equal(acquired.version, "0.1.0");
  assert.equal(acquired.receipt.tag, "v0.1.0");
  assert.equal(acquired.receipt.tag_object, "a".repeat(40));
  assert.equal(acquired.receipt.source, "c".repeat(40));
  assert.equal(acquired.receipt.release_id, 77);
  // The archive is downloaded only after its attested identity verifies.
  assert.deepEqual(fixture.requests, [
    "pages:updates/preview/latest.json",
    "pages:updates/withdrawn.json",
    "tag:v0.1.0",
    "download:SHA256SUMS",
    `attestations:${acquired.receipt.archive_sha256 as string}`,
    `download:${fixture.archiveName}`,
  ]);
  const cases: [string, Omit<ReleasedReaderFixture, "binary" | "version">, RegExp][] = [
    ["withdrawn", { withdrawn: ["0.1.0"] }, /withdrawn/u],
    ["untagged", { mutate: (value) => void (value.tagObject = "short") }, /immutable tag object/u],
    [
      "retagged to another commit",
      { mutate: (value) => void (value.peeled = "d".repeat(40)) },
      /protected main/u,
    ],
    ["unprotected", { mutate: (value) => void (value.ancestor = false) }, /protected main/u],
    [
      "checksums",
      {
        mutate: (value) => {
          value.checksums = Buffer.from(`${"0".repeat(64)}  other.tar.gz\n`);
        },
      },
      /checksum manifest lacks/u,
    ],
    [
      "unattested checksums",
      {
        mutate: (value) => {
          value.checksums = Buffer.concat([value.checksums, Buffer.from("\n")]);
        },
      },
      /attestation subject differs/u,
    ],
    [
      "substituted archive",
      {
        mutate: (value) => {
          value.archive = Buffer.concat([value.archive, Buffer.from("x")]);
        },
      },
      /differs from its attested identity/u,
    ],
    [
      "unattested tag",
      { mutate: (value) => void (value.tagObject = "b".repeat(40)) },
      /attestation subject differs/u,
    ],
    [
      "another release",
      {
        mutate: (value) => {
          (value.statement.predicate as Record<string, unknown>).tag = "v0.1.1";
        },
      },
      /attestation identity differs/u,
    ],
    [
      "unsigned",
      {
        mutate: (value) => {
          value.statement = {};
        },
      },
      /attestation identity differs/u,
    ],
  ];
  for (const [name, options, expected] of cases)
    await assert.rejects(acquire(options).result, expected, name);
});

void test("selection reads no credential and strips tokens from child environments", () => {
  const cleaned = credentialFree({
    PATH: "/bin",
    HOME: "/home",
    GH_TOKEN: "x",
    GITHUB_TOKEN: "x",
    PORTCOVE_GITHUB_TOKEN: "x",
    ACTIONS_RUNTIME_TOKEN: "x",
    NPM_CONFIG_PASSWORD: "x",
  });
  assert.deepEqual(cleaned, { PATH: "/bin", HOME: "/home" });
});

void test("a Pages push retry refuses a reader withdrawn after preparation", (t) => {
  const dir = temporary(t);
  const upstream = path.join(dir, "upstream");
  const publisher = path.join(dir, "publisher");
  mkdirSync(upstream);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
      { stdio: "pipe" },
    );
  const put = (root: string, file: string, value: unknown) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), JSON.stringify(value));
  };
  git(upstream, "init", "--initial-branch=gh-pages");
  const version = "0.1.0-preview.14";
  const tag = `nightly-${version}`;
  put(upstream, "updates/preview/latest.json", {
    version,
    platforms: {
      "linux-x86_64": {
        url: `https://github.com/boburning/portcove/releases/download/${tag}/Portcove_${version}_amd64.AppImage`,
      },
    },
  });
  git(upstream, "add", ".");
  git(upstream, "commit", "-m", "Select capable reader");
  git(upstream, "config", "receive.denyCurrentBranch", "updateInstead");
  git(dir, "clone", upstream, publisher);
  const prepared = { version, tag };
  assert.doesNotThrow(() => requireCurrentCatalogReaderSelection(prepared, publisher));
  put(publisher, "catalog/timestamp", "candidate");
  git(publisher, "add", ".");
  git(publisher, "commit", "-m", "Publish candidate");
  put(upstream, "updates/withdrawn.json", [version]);
  git(upstream, "add", ".");
  git(upstream, "commit", "-m", "Withdraw reader");
  assert.throws(() => git(publisher, "push", "origin", "HEAD:refs/heads/gh-pages"));
  git(publisher, "fetch", "origin", "gh-pages");
  git(publisher, "checkout", "--detach", "origin/gh-pages");
  assert.throws(() => requireCurrentCatalogReaderSelection(prepared, publisher), /withdrawn/u);
  assert.throws(
    () => requireCurrentCatalogReaderSelection({ version: "0.1.0", tag: "v0.1.0" }, upstream),
    /withdrawn|selection changed/u,
  );
});

void test("the attestation read retries only rate limits and server errors within its budget", async () => {
  const { attestationRetryDelaysMs, retryUnavailableApi } =
    await import("./catalog-released-reader.mts");
  assert.deepEqual([...attestationRetryDelaysMs], [5_000, 15_000, 45_000]);
  const run = async (failures: string[]) => {
    const waits: number[] = [];
    let calls = 0;
    const result = await retryUnavailableApi(
      () => {
        const failure = failures[calls++];
        return failure ? Promise.reject(new Error(failure)) : Promise.resolve("ok");
      },
      attestationRetryDelaysMs,
      (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    ).catch((error: Error) => error.message);
    return { result, calls, waits };
  };
  const unavailable = (status: number) =>
    `Public Portcove API attestations unavailable (${status})`;
  // A transient refusal recovers on a later attempt.
  assert.deepEqual(await run([unavailable(403), unavailable(503)]), {
    result: "ok",
    calls: 3,
    waits: [5_000, 15_000],
  });
  // The budget is finite; the last refusal is returned unchanged.
  assert.deepEqual(await run(Array.from({ length: 5 }, () => unavailable(429))), {
    result: unavailable(429),
    calls: 4,
    waits: [5_000, 15_000, 45_000],
  });
  // Other failures are not retried.
  for (const failure of [unavailable(404), "Verified release attestation identity differs"])
    assert.deepEqual(await run([failure]), { result: failure, calls: 1, waits: [] });
});

void test("live selection reads the Pages worktree's checked-out commit, not a remote-tracking ref", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "portcove-pages-revision-"));
  try {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.invalid",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.invalid",
        },
      }).trim();
    const checkout = path.join(scratch, "checkout");
    mkdirSync(checkout);
    git(checkout, "init", "--quiet", "-b", "main");
    git(checkout, "commit", "--quiet", "--allow-empty", "-m", "source");
    git(checkout, "checkout", "--quiet", "--orphan", "gh-pages");
    mkdirSync(path.join(checkout, "catalog"));
    writeFileSync(path.join(checkout, "catalog", "marker"), "pages");
    git(checkout, "add", "catalog/marker");
    git(checkout, "commit", "--quiet", "-m", "pages");
    const pagesCommit = git(checkout, "rev-parse", "HEAD");
    git(checkout, "checkout", "--quiet", "main");
    git(checkout, "worktree", "add", "--quiet", "--detach", "site", pagesCommit);
    // A remote-tracking ref moved elsewhere must not change what is read.
    git(checkout, "update-ref", "refs/remotes/origin/gh-pages", git(checkout, "rev-parse", "main"));
    const site = path.join(checkout, "site");
    assert.equal(pagesWorktreeRevision(checkout, path.join(site, "catalog")), pagesCommit);
    assert.equal(pagesWorktreeRevision(checkout, site), pagesCommit);
    assert.throws(() => pagesWorktreeRevision(checkout, checkout), /requires a Pages worktree/u);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
