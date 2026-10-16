import { spawn } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Observe only this harness's driver descendants. No application launch, probe,
// policy change or process termination is performed by the PowerShell observer.
export async function observeStartup({ driver, driverPath, profile, output, attempt }) {
  const prefix = path.join(output, `session-startup-${attempt}`);
  const trace = `${prefix}.jsonl`;
  const stop = `${prefix}.stop`;
  const log = `${prefix}.log`;
  const child = spawn(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      fileURLToPath(new URL("./native-startup-observation.ps1", import.meta.url)),
      "-DriverProcessId",
      String(driver.pid),
      "-DriverPath",
      driverPath,
      "-ProfilePath",
      profile,
      "-OutputPath",
      trace,
      "-StopPath",
      stop,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let diagnostics = "";
  let ready;
  const readiness = new Promise((resolve) => {
    ready = resolve;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-64 * 1024);
    });
  child.stdout.on("data", (chunk) => {
    if (String(chunk).includes("ready")) ready();
  });
  const completion = new Promise((resolve) => {
    child.on("error", (error) => {
      diagnostics += error.message;
      ready();
      resolve({ error: error.message });
    });
    child.on("close", (code, signal) => {
      ready();
      resolve({ code, signal });
    });
  });
  const watchdog = setTimeout(() => child.kill(), 80_000);
  await readiness;
  return async () => {
    await writeFile(stop, "session creation completed\n", { flag: "wx" });
    const result = await completion;
    clearTimeout(watchdog);
    await writeFile(
      log,
      JSON.stringify(
        {
          result,
          diagnostics,
          driver_exit_code: driver.exitCode,
          driver_signal: driver.signalCode,
          limitations:
            "One-second sampling can miss short-lived processes. Attached application exit codes and application stderr are not observed.",
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    const traceExists = await access(trace).then(
      () => true,
      () => false,
    );
    return {
      artifacts: [...(traceExists ? [trace] : []), log],
      successful: result.code === 0 && traceExists,
    };
  };
}
