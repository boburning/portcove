import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Builder } from "selenium-webdriver";

export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { sha256: hash.digest("hex"), bytes: (await stat(file)).size };
}

export async function waitFor(predicate, label, deadlineMs = 60_000) {
  const untilMs = Date.now() + deadlineMs;
  while (Date.now() < untilMs) {
    const result = await predicate().catch(() => null);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label} did not complete within ${deadlineMs} ms`);
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export function startInstalledUpdateDriver(driverPath, nativeDriverPath, options = {}) {
  const output = { driver: null, log: "" };
  output.driver = spawn(
    driverPath,
    ["--port", "45770", "--native-port", "45771", "--native-driver", nativeDriverPath],
    { stdio: ["ignore", "pipe", "pipe"], ...options },
  );
  output.driver.on("error", (error) => {
    output.log += `\nspawn: ${error.message}`;
  });
  for (const stream of [output.driver.stdout, output.driver.stderr])
    stream.on("data", (chunk) => {
      output.log = (output.log + chunk).slice(-1024 * 1024);
    });
  return output;
}

export async function awaitInstalledUpdateDriver(driver, identify = () => true) {
  return waitFor(
    async () => {
      if (driver.exitCode !== null) throw new Error(`tauri-driver exited ${driver.exitCode}`);
      const response = await fetch("http://127.0.0.1:45770/status", {
        signal: AbortSignal.timeout(500),
      });
      return response.ok ? identify(driver.pid) : null;
    },
    "tauri-driver startup",
    10_000,
  );
}

export async function connectInstalledUpdateDriver(application) {
  return new Builder()
    .disableEnvironmentOverrides()
    .usingServer("http://127.0.0.1:45770")
    .withCapabilities({ browserName: "wry", "tauri:options": { application } })
    .build();
}

export async function verifyInstalledUpdateStaging({
  stagingRoot,
  payloadName,
  candidateSha,
  candidateVersion,
  application,
  initialSha,
}) {
  const staged = await hashFile(path.join(stagingRoot, payloadName));
  const staging = await readJson(path.join(stagingRoot, "staging.json"));
  assert.equal(staging.phase, "verified");
  assert.equal(staged.sha256, candidateSha);
  assert.equal(staged.bytes, staging.candidate.release.artifact.bytes);
  assert.equal(staging.candidate.release.version, candidateVersion);
  assert.equal((await hashFile(application)).sha256, initialSha);
  return staged;
}

export async function recordInstalledUpdateFailure(report, error, helperMarker) {
  report.phase = "failed";
  report.failure = String(error.stack ?? error);
  report.helper_failure = await readJson(
    path.join(path.dirname(helperMarker), "helper-failure.json"),
  ).catch(() => null);
}
