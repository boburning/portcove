import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { maximumApplicationSourceCommits } from "./release-source-changes.mts";

/** GitHub REST normalizes unsigned Git timestamps. Retrieve the exact inert
 * commit bytes with the maintained pre-parse Git launcher and cross-check every
 * returned provider commit against those bytes. No checkout or credentials. */
export async function readApplicationSourceCommitObjects(
  base: string,
  source: string,
  deadline: number,
) {
  assert.ok(
    process.platform === "linux" && process.getuid?.(),
    "fixed application source Git requires an ordinary Linux job",
  );
  const oid = /^[a-f0-9]{40}$/u;
  assert.match(base, oid);
  assert.match(source, oid);
  const parent = await mkdtemp(path.join(tmpdir(), "portcove-application-commits-"));
  try {
    const repository = path.join(parent, "source.git");
    const git_sha256 = createHash("sha256")
      .update(await readBoundedPublicBuildInputFile("/usr/bin", "git", 64 * 1024 ** 2))
      .digest("hex");
    const expires_at = Date.now() + Math.floor(deadline - performance.now());
    const launcher = fileURLToPath(new URL("semantic-source-git.py", import.meta.url));
    const run = async (
      phase: "init" | "application-commits" | "application-history" | "application-commit-batch",
      oids: string[],
      maximum: number,
      input?: string,
    ) => {
      const remaining = () => Math.min(30000, Math.floor(deadline - performance.now()));
      const timeout_ms = remaining();
      assert.ok(timeout_ms > 0, "application Git source deadline exhausted");
      const request = path.join(parent, `${phase}.json`);
      await writeFile(
        request,
        JSON.stringify({
          schema_version: 1,
          repository,
          home: parent,
          oids,
          phase,
          git_sha256,
          timeout_ms,
          expires_at,
        }),
        { flag: "wx", mode: 0o600 },
      );
      const timeout = remaining();
      assert.ok(timeout > 0, "application Git source deadline exhausted");
      return execFileSync("/usr/bin/python3", ["-I", "-S", "-B", launcher, request], {
        env: { PATH: "/usr/bin:/bin", HOME: parent, LANG: "C.UTF-8" },
        timeout,
        maxBuffer: maximum,
        ...(input === undefined ? {} : { input }),
      });
    };
    await run("init", [], 256 * 1024);
    await run("application-commits", [...new Set([base, source])], 256 * 1024);
    const history = (await run("application-history", [source, base], 256 * 1024))
      .toString("utf8")
      .split("\n")
      .filter(Boolean);
    assert.ok(
      history.length <= maximumApplicationSourceCommits && history.every((id) => oid.test(id)),
      "application Git source history exceeds its exact bound",
    );
    const selected = [...new Set([base, source, ...history])];
    const batch = await run(
      "application-commit-batch",
      [],
      32 * 1024 ** 2,
      selected.join("\n") + "\n",
    );
    const objects = new Map<string, Buffer>();
    let offset = 0;
    for (const id of selected) {
      const headerEnd = batch.indexOf(0x0a, offset);
      assert.ok(
        headerEnd > offset && headerEnd - offset < 80,
        "application Git object header differs",
      );
      const match = /^([a-f0-9]{40}) commit ([1-9][0-9]*)$/u.exec(
        batch.toString("ascii", offset, headerEnd),
      );
      assert.equal(match?.[1], id, "application Git commit identity differs");
      const size = Number(match?.[2]);
      const start = headerEnd + 1;
      const end = start + size;
      assert.ok(
        size <= 128 * 1024 && batch[end] === 0x0a,
        "application Git object exceeds its exact bound",
      );
      objects.set(id, batch.subarray(start, end));
      offset = end + 1;
    }
    assert.equal(offset, batch.length, "unexpected application Git batch bytes");
    return objects;
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}
