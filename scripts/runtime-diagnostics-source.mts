// Records the runtime diagnostics fixture source manifest shared by the Windows
// partitions and the Linux diagnostics replay. One list keeps both lanes equal.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const runtimeDiagnosticsSourceFiles = Object.freeze([
  "Cargo.toml",
  "Cargo.lock",
  "crates/portcove-diagnostics/Cargo.toml",
  "crates/portcove-diagnostics/src/lib.rs",
  "crates/portcove-diagnostics/src/sessions.rs",
  "crates/portcove-diagnostics/src/sessions/tests.rs",
  "crates/portcove-diagnostics/src/tests.rs",
  "crates/portcove-diagnostics/src/writer.rs",
  "crates/portcove-diagnostics/src/writer_tests.rs",
  "crates/portcove-diagnostics/src/events.rs",
  "crates/portcove-diagnostics/src/events_tests.rs",
  "apps/desktop/src-tauri/src/diagnostics.rs",
  "apps/desktop/src-tauri/src/host_startup.rs",
  "apps/desktop/src-tauri/src/lib.rs",
  "crates/portcove-cli/src/main.rs",
  "crates/portcove-cli/src/startup.rs",
  "crates/portcove-cli/tests/host_diagnostics.rs",
  "crates/portcove-cli/tests/desktop_host_diagnostics.rs",
  "crates/portcove-core/src/host_preferences.rs",
  "crates/portcove-core/src/database.rs",
  "crates/portcove-core/src/support_bundle_export.rs",
  "crates/portcove-core/src/support_bundle_export_tests.rs",
  "apps/desktop/src-tauri/src/frontend_diagnostics.rs",
  "crates/portcove-core/src/runtime_diagnostics.rs",
  "crates/portcove-core/src/operation.rs",
  "crates/portcove-core/src/support_bundle.rs",
  "crates/portcove-core/src/service.rs",
  "crates/portcove-core/src/preparation_execution.rs",
  "crates/portcove-core/src/tool_process.rs",
  "crates/portcove-cli/tests/runtime_diagnostics.rs",
]);

/** Build the unchanged `format_version: 1` manifest from repository bytes. */
export function runtimeDiagnosticsSource(
  root: string,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const source_sha256 = Object.fromEntries(
    runtimeDiagnosticsSourceFiles.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(path.join(root, file)))
        .digest("hex"),
    ]),
  );
  return {
    format_version: 1,
    source_revision: environment.PORTCOVE_DIAGNOSTICS_SOURCE_REVISION,
    runner_os: environment.RUNNER_OS,
    runner_arch: environment.RUNNER_ARCH,
    run_id: environment.GITHUB_RUN_ID,
    run_attempt: environment.GITHUB_RUN_ATTEMPT,
    source_sha256,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.env.PORTCOVE_DIAGNOSTICS_EVIDENCE_DIR;
  if (!directory) throw new Error("PORTCOVE_DIAGNOSTICS_EVIDENCE_DIR is required");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const manifest = runtimeDiagnosticsSource(root, process.env);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "source.json"), JSON.stringify(manifest, null, 2) + "\n");
}
