import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Builder, By, Key, until } from "selenium-webdriver";
import { assertDesignCompatibility } from "../scripts/desktop-design-compatibility-assertions.mjs";

const application = process.env.PORTCOVE_NATIVE_COMPATIBILITY_APP;
const evidenceDirectory = process.env.PORTCOVE_NATIVE_COMPATIBILITY_EVIDENCE;
if (!application || !path.isAbsolute(application)) {
  throw new Error("PORTCOVE_NATIVE_COMPATIBILITY_APP must be an absolute binary path");
}
if (!evidenceDirectory || !path.isAbsolute(evidenceDirectory)) {
  throw new Error("PORTCOVE_NATIVE_COMPATIBILITY_EVIDENCE must be an absolute directory path");
}
await mkdir(evidenceDirectory, { recursive: true });
const applicationBytes = await readFile(application);
const applicationStat = await stat(application);
const artifactIdentity = {
  file: path.basename(application),
  sha256: createHash("sha256").update(applicationBytes).digest("hex"),
  size: applicationStat.size,
};
const port = 4445;
const applicationProcess = spawn(application, [], {
  env: { ...process.env, TAURI_WEBDRIVER_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let applicationOutput = "";
applicationProcess.stdout.setEncoding("utf8");
applicationProcess.stderr.setEncoding("utf8");
applicationProcess.stdout.on("data", (chunk) => (applicationOutput += chunk));
applicationProcess.stderr.on("data", (chunk) => (applicationOutput += chunk));
let spawnError;
applicationProcess.on("error", (error) => (spawnError = error));
const applicationExit = new Promise((resolve) => {
  applicationProcess.once("exit", (code, signal) => resolve({ code, signal }));
});
async function waitForApplicationExit(timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      applicationExit,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`qualification application did not exit within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

let browser;
let result = {
  artifact: artifactIdentity,
  revision: process.env.PORTCOVE_NATIVE_COMPATIBILITY_REVISION ?? null,
  status: "failed",
};
let failure;
try {
  const readyDeadline = Date.now() + 60_000;
  while (Date.now() < readyDeadline) {
    if (spawnError) throw spawnError;
    if (applicationProcess.exitCode !== null) {
      throw new Error(
        `qualification application exited before WebDriver startup: ${applicationOutput}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) break;
    } catch {
      // The bounded loop preserves the complete application output on failure.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (Date.now() >= readyDeadline) {
    throw new Error(`embedded WebDriver did not become ready: ${applicationOutput}`);
  }
  browser = await new Builder()
    .usingServer(`http://127.0.0.1:${port}`)
    .withCapabilities({ browserName: "tauri" })
    .build();
  const environment = await assertDesignCompatibility({ browser, By, Key, until });
  await writeFile(
    path.join(evidenceDirectory, "design-compatibility-environment.json"),
    `${JSON.stringify(
      {
        ...environment,
        hostArchitecture: process.arch,
        hostPlatform: process.platform,
        revision: process.env.PORTCOVE_NATIVE_COMPATIBILITY_REVISION ?? null,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  await writeFile(
    path.join(evidenceDirectory, "design-compatibility.png"),
    await browser.takeScreenshot(),
    "base64",
  );
  result = { ...result, status: "passed" };
  console.log(`Native compatibility evidence: ${evidenceDirectory}`);
} catch (error) {
  failure = error;
  result = {
    ...result,
    error: error instanceof Error ? error.message : String(error),
  };
} finally {
  try {
    if (browser) await browser.quit();
  } catch (error) {
    failure ??= error;
    result = {
      ...result,
      cleanupError: error instanceof Error ? error.message : String(error),
      status: "failed",
    };
  }
  if (applicationProcess.exitCode === null && applicationProcess.signalCode === null) {
    applicationProcess.kill();
  }
  let exit;
  try {
    exit = await waitForApplicationExit(10_000);
  } catch (error) {
    failure ??= error;
    result = {
      ...result,
      cleanupError: error instanceof Error ? error.message : String(error),
      status: "failed",
    };
    applicationProcess.kill("SIGKILL");
    try {
      exit = await waitForApplicationExit(5_000);
    } catch (forcedExitError) {
      failure ??= forcedExitError;
      result = {
        ...result,
        cleanupError:
          forcedExitError instanceof Error ? forcedExitError.message : String(forcedExitError),
        status: "failed",
      };
      exit = { code: null, observed: false, signal: null };
    }
  }
  await writeFile(path.join(evidenceDirectory, "application.log"), applicationOutput);
  await writeFile(
    path.join(evidenceDirectory, "result.json"),
    `${JSON.stringify({ ...result, applicationExit: exit }, null, 2)}\n`,
    { flag: "wx" },
  );
}
if (failure) throw failure;
