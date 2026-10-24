import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { readCiMetrics } from "../../../scripts/ci-metrics.mts";

const desktop = fileURLToPath(new URL("../", import.meta.url));
for (const [mode, status, operations, phases] of [
  ["success", 0, ["install", "launch", "close"], ["cache", "install", "launch", "ready", "close"]],
  [
    "shell-present",
    0,
    ["install", "launch", "close"],
    ["cache", "install", "launch", "ready", "close"],
  ],
  [
    "shell-outside",
    0,
    ["install", "launch", "close"],
    ["cache", "install", "launch", "ready", "close"],
  ],
  [
    "registry-unknown",
    0,
    ["install", "launch", "close"],
    ["cache", "install", "launch", "ready", "close"],
  ],
  ["install-failure", 23, ["install"], ["cache", "install"]],
  ["install-signal", 1, ["install"], ["cache", "install"]],
  ["launch-failure", 1, ["install", "launch"], ["cache", "install", "launch"]],
  [
    "close-failure",
    1,
    ["install", "launch", "close"],
    ["cache", "install", "launch", "ready", "close"],
  ],
] as const) {
  test(
    `browser bootstrap retains ${mode} and records only reached phases`,
    { timeout: 180_000 },
    () => {
      const temp = mkdtempSync(path.join(os.tmpdir(), "portcove-bootstrap-control-"));
      try {
        if (mode === "shell-present" || mode === "shell-outside") {
          const directory = path.join(
            temp,
            mode === "shell-present" ? "work/browser-cache/owned-shell-control" : "foreign",
          );
          mkdirSync(directory, { recursive: true });
          writeFileSync(path.join(directory, "chrome.exe"), "owned regular-file presence control");
        }
        const result = spawnSync(
          process.execPath,
          [
            "--experimental-test-module-mocks",
            "--import",
            new URL("../test/browser-bootstrap-control.mts", import.meta.url).href,
            "scripts/browser-runtime.mts",
            "bootstrap",
          ],
          {
            cwd: desktop,
            encoding: "utf8",
            timeout: 120_000,
            windowsHide: true,
            env: {
              ...process.env,
              PORTCOVE_BOOTSTRAP_CONTROL: mode,
              PORTCOVE_BOOTSTRAP_CONTROL_ROOT: temp,
              PORTCOVE_CI_METRICS_DIR: temp,
            },
          },
        );
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        assert.equal(result.status, status, result.stderr);
        assert.deepEqual(
          result.stdout
            .split(/\r?\n/u)
            .filter((line) => line.startsWith("Browser bootstrap control: "))
            .map((line) => line.slice("Browser bootstrap control: ".length)),
          operations,
        );
        const { records } = readCiMetrics(temp);
        assert.deepEqual(
          records.map((record) => record.phase).sort((a, b) => a.localeCompare(b)),
          phases.map((phase) => `browser-bootstrap:${phase}`).sort((a, b) => a.localeCompare(b)),
        );
        const cache = records.find((record) => record.phase === "browser-bootstrap:cache");
        assert.ok(cache);
        if (mode === "registry-unknown" || mode === "shell-outside") {
          assert.equal(cache.cache_outcome, "unknown");
          assert.equal(cache.fingerprint, undefined);
          assert.equal(cache.groups, undefined);
        } else {
          assert.equal(
            cache.cache_outcome,
            mode === "shell-present" ? "executable-present" : "executable-absent",
          );
          assert.equal(typeof cache.fingerprint, "string");
          assert.ok(cache.fingerprint);
          assert.match(cache.fingerprint, /^[a-f0-9]{64}$/u);
          assert.ok(cache.groups);
          assert.ok(cache.groups.includes("executable=owned-shell-control/chrome.exe"));
          assert.ok(
            cache.groups.some((group: string) => /^playwright=\d+\.\d+\.\d+$/u.test(group)),
          );
        }
        for (const record of records)
          if (record.elapsed_ms !== undefined)
            assert.ok(Number.isSafeInteger(record.elapsed_ms) && record.elapsed_ms >= 0);
        const failed = records.filter((record) => record.outcome === "failed");
        assert.equal(
          failed.length,
          mode === "success" ||
            mode === "registry-unknown" ||
            mode === "shell-present" ||
            mode === "shell-outside"
            ? 0
            : 1,
        );
        if (mode === "launch-failure" || mode === "close-failure")
          assert.match(result.stderr, /OWNED_BROWSER_(?:LAUNCH|CLOSE)_FAILURE/u);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );
}

test(
  "unavailable bootstrap diagnostics preserve successful readiness and cleanup",
  { timeout: 180_000 },
  () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "portcove-bootstrap-sink-"));
    try {
      const sink = path.join(temp, "not-a-directory");
      writeFileSync(sink, "owned diagnostic sink control");
      const result = spawnSync(
        process.execPath,
        [
          "--experimental-test-module-mocks",
          "--import",
          new URL("../test/browser-bootstrap-control.mts", import.meta.url).href,
          "scripts/browser-runtime.mts",
          "bootstrap",
        ],
        {
          cwd: desktop,
          encoding: "utf8",
          timeout: 120_000,
          windowsHide: true,
          env: {
            ...process.env,
            PORTCOVE_BOOTSTRAP_CONTROL: "success",
            PORTCOVE_BOOTSTRAP_CONTROL_ROOT: temp,
            PORTCOVE_CI_METRICS_DIR: sink,
          },
        },
      );
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Browser ready: Chromium headless owned-control-version/u);
      assert.match(result.stdout, /Browser bootstrap control: close/u);
      assert.match(result.stderr, /\[ci-metrics\] diagnostics unavailable/u);
      assert.equal(readFileSync(sink, "utf8"), "owned diagnostic sink control");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);
