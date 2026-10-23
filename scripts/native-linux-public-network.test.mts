import { runPythonSuite } from "./python-test-results.mts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

void test("fixed native network policy, real ClientHello and inert namespace models; Linux controlled private relay", (context) => {
  const report = runPythonSuite(
    new URL("../apps/desktop/scripts/native-linux-public-network.test.py", import.meta.url),
    context,
  );
  if (process.platform === "linux")
    assert.ok(
      report.cases.every((item) => item.status !== "skipped"),
      "Linux must execute every platform case",
    );
});

void test(
  "actual Linux fixed outer relay requires its owned stop after clean guest EOF",
  { timeout: 15000 },
  async (context) => {
    if (process.platform !== "linux")
      return context.skip("actual Linux Node stdio/control credentials required");
    const root = await mkdtemp(path.join(tmpdir(), "portcove-public-relay-stop-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const policy = Buffer.from(
      JSON.stringify({
        schema_version: 1,
        nonce: "11111111-2222-3333-4444-555555555555",
        metadata_base_url: "https://boburning.github.io/portcove/application/metadata/",
        targets_base_url: "https://boburning.github.io/portcove/application/targets/",
        addresses: {
          "boburning.github.io": ["185.199.108.153"],
          "github.com": ["140.82.112.3"],
          "release-assets.githubusercontent.com": ["185.199.108.133"],
        },
      }),
    );
    const filename = path.join(root, "policy.json"),
      digest = createHash("sha256").update(policy).digest("hex");
    await writeFile(filename, policy, { flag: "wx", mode: 0o600 });
    for (const selected of [
      { mode: "--outer-controlled", stop: 0, expected: 0 },
      { mode: "--outer-controlled", stop: 1, expected: 1 },
      { mode: "--outer-controlled", stop: null, expected: 1 },
      { mode: "--outer", stop: null, expected: 1 },
    ]) {
      const child = spawn(
        "python3",
        [
          "-I",
          "-S",
          "-B",
          fileURLToPath(
            new URL("../apps/desktop/scripts/native-linux-public-network.py", import.meta.url),
          ),
          selected.mode,
          filename,
          digest,
          "5000",
        ],
        {
          stdio: ["pipe", "pipe", "pipe", "pipe"],
          env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
        },
      );
      const control = child.stdio[3];
      assert.ok(control instanceof Writable);
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      child.stdout.on("data", (data: Buffer) => {
        assert.ok(Buffer.concat(stdout).length + data.length <= 65536);
        stdout.push(data);
      });
      child.stderr.on("data", (data: Buffer) => {
        assert.ok(Buffer.concat(stderr).length + data.length <= 65536);
        stderr.push(data);
      });
      let closed = false;
      const joined = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => {
            closed = true;
            resolve({ code, signal });
          });
        },
      );
      const timer = setTimeout(() => child.kill(), 6000);
      try {
        // No open frame is sent, so this fixture requests no external socket.
        child.stdin.end();
        if (selected.stop !== null) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          assert.equal(closed, false, "clean framing EOF alone cannot complete controlled relay");
          control.end(Buffer.from([selected.stop]));
        }
        const result = await joined;
        assert.deepEqual(result, { code: selected.expected, signal: null });
        assert.equal(Buffer.concat(stdout).length, 0);
        if (selected.expected === 0) assert.equal(Buffer.concat(stderr).length, 0);
        else assert.match(Buffer.concat(stderr).toString("utf8"), /fixed public relay refused/u);
      } finally {
        clearTimeout(timer);
        if (!closed) {
          child.kill();
          await joined;
        }
      }
    }
  },
);
