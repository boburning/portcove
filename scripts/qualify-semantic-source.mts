import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { materializeSemanticSource } from "./release-semantic-source.mts";

// Public, already merged source is deliberate: this fixture qualifies the
// credential-free transport, not candidate selection or any semantic decision.
const commit = "f222a053208daba875f7ad5059a294d15e514d53";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
if (process.platform !== "linux" || !process.getuid?.() || !process.env.RUNNER_TEMP)
  throw new Error("ordinary unprivileged Linux source fixture required");
const output = path.join(process.env.RUNNER_TEMP, "semantic-source-fixture");
await mkdir(output, { mode: 0o700 });
const parent = path.join(output, "private-work");
await mkdir(parent, { mode: 0o700 });
let gets = 0;
const api = {
  request(method: string, endpoint: string) {
    if (
      method !== "GET" ||
      !/^repos\/boburning\/portcove\/git\/(?:commits\/[a-f0-9]{40}|trees\/[a-f0-9]{40}\?recursive=1)$/u.test(
        endpoint,
      ) ||
      ++gets > 4
    )
      throw new Error("fixed source fixture GET bound differs");
    const bytes = execFileSync(
      "/usr/bin/curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--tlsv1.2",
        "--max-time",
        "15",
        "--max-filesize",
        "16777216",
        "--header",
        "Accept: application/vnd.github+json",
        `https://api.github.com/${endpoint}`,
      ],
      {
        env: { PATH: "/usr/bin:/bin", HOME: parent, LANG: "C.UTF-8" },
        timeout: 16000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const body: unknown = JSON.parse(bytes.toString("utf8"));
    return { status: 200, body, headers: new Map<string, string>() };
  },
};
const tools = {
  git_sha256: sha(await readFile(await realpath("/usr/bin/git"))),
  python_sha256: sha(await readFile(await realpath("/usr/bin/python3"))),
};
try {
  const raw = api.request("GET", `repos/boburning/portcove/git/commits/${commit}`).body as {
    tree: { sha: string };
  };
  const result = await materializeSemanticSource(
    parent,
    {
      source_commit: commit,
      source_tree: raw.tree.sha,
      base_commit: commit,
      published_object: commit,
    },
    api,
    tools,
  );
  assert.equal(result.evidence_scope, "fixed-public-git-acquisition");
  assert.ok(result.blobs > 0);
  const git = (args: string[]) =>
    execFileSync(
      "/usr/bin/git",
      ["--no-replace-objects", "--git-dir", result.repository, ...args],
      {
        env: {
          PATH: "/usr/bin:/bin",
          GIT_NO_LAZY_FETCH: "1",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        timeout: 15000,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
  assert.equal(git(["for-each-ref"]).length, 0);
  assert.ok(git(["ls-tree", "-r", commit]).length > 0);
  await writeFile(
    path.join(output, "result.json"),
    JSON.stringify({
      schema_version: 1,
      scope: "ordinary-credential-free-semantic-source-only",
      source_commit: commit,
      source_tree: raw.tree.sha,
      tools,
      blobs: result.blobs,
      selected_bytes: result.selected_bytes,
      get_requests: gets,
      outcome: "passed",
      runtime: "not-invoked",
      authority: "none",
    }),
    { flag: "wx" },
  );
} catch (error) {
  await writeFile(
    path.join(output, "failure.json"),
    JSON.stringify({
      schema_version: 1,
      scope: "ordinary-credential-free-semantic-source-only",
      source_commit: commit,
      tools,
      get_requests: gets,
      outcome: "refused",
      message: error instanceof Error ? error.message.slice(0, 2048) : "unknown",
      authority: "none",
    }),
    { flag: "wx" },
  );
  throw error;
}
