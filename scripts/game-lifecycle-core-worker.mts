import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileIdentity } from "./development-evidence.mts";
import { executeGameLifecycle } from "./game-lifecycle-execution.mts";
import { launchAndCloseVerifiedWindowsGame } from "./game-lifecycle-native.mts";
import type { ExpectedGameLifecycle } from "./game-lifecycle-receipt.mts";
import type { OutputSuccessorEvidencePreparation } from "../apps/desktop/src/transport-types.generated.d.ts";
import { isRecord } from "./runtime-values.mts";

const execute = promisify(execFile);
export interface MaterializedGameLifecycleWork {
  preparation: OutputSuccessorEvidencePreparation;
  preparation_json: string;
  predecessor_library: string;
  successor_library: string;
  predecessor_active: { install_id: string };
  successor_library_active: { install_id: string };
  successor_executable: { relative_path: string; sha256: string };
}
type Job = Pick<ExpectedGameLifecycle, "run_id" | "run_attempt" | "job_id" | "platform">;

function installation(result: unknown, tag: unknown, artifact: unknown) {
  if (
    !isRecord(result) ||
    !isRecord(result.artifact) ||
    typeof result.id !== "string" ||
    typeof result.path !== "string" ||
    result.version !== tag ||
    result.artifact.sha256 !== artifact ||
    typeof result.selected_executable !== "string" ||
    result.verified !== true
  )
    throw new Error("Managed lifecycle phase did not retain the planned installation");
  return result;
}

/** Uses Core's ordinary locked acquisition and immutable status APIs after
 * the materializer authenticates both independent definitions and originals. */
export async function runMaterializedGameLifecycle(
  job: Job,
  work: MaterializedGameLifecycleWork,
  cli: { path: string; sha256: string },
  output: string,
  environment: NodeJS.ProcessEnv,
) {
  const reviewed = work.preparation;
  const previous = reviewed.predecessor;
  const next = reviewed.successor;
  const id = next.definition.stable_id;
  if ((await fileIdentity(cli.path)).sha256 !== cli.sha256)
    throw new Error("Native lifecycle Core executable changed");

  async function call(library: string, command: string, args: string[]) {
    const { stdout } = await execute(
      cli.path,
      ["--library", library, "--json", "--non-interactive", command, ...args],
      {
        env: environment,
        timeout: command === "install" ? 180000 : 30000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
      },
    );
    const answer: unknown = JSON.parse(stdout);
    if (
      !isRecord(answer) ||
      answer.ok !== true ||
      answer.command !== command ||
      !isRecord(answer.data)
    )
      throw new Error(`Game lifecycle Core command did not succeed: ${command}`);
    return answer.data;
  }
  async function active(library: string, tag: unknown, artifact: unknown) {
    const status = await call(library, "status", [id]);
    return installation(status.active, tag, artifact);
  }
  async function verify(library: string, installId: unknown) {
    const result = await call(library, "verify", [id]);
    if (
      result.install_id !== installId ||
      result.valid !== true ||
      !Number.isSafeInteger(result.checked_files) ||
      Number(result.checked_files) < 1 ||
      result.unknown_file_count !== 0 ||
      !Array.isArray(result.failures) ||
      result.failures.length !== 0
    )
      throw new Error("Managed lifecycle verification did not pass for the exact active install");
    return { install_id: installId, checked_files: result.checked_files };
  }
  const before = await active(work.successor_library, previous.tag, previous.artifact_sha256);
  if (before.id !== work.successor_library_active.install_id)
    throw new Error("Test library no longer has the reviewed predecessor active");
  await verify(work.successor_library, before.id);
  let successorInstallId: string | undefined;
  return executeGameLifecycle(job, {
    preparation: Buffer.from(work.preparation_json, "utf8"),
    executable_sha256: work.successor_executable.sha256,
    output,
    phases: {
      async "acquire-exact-successor"() {
        const acquired = installation(
          await call(work.successor_library, "install", [id, "--channel", next.channel, "--stage"]),
          next.tag,
          next.artifact_sha256,
        );
        if (acquired.staged !== true || acquired.id === before.id)
          throw new Error("Core did not stage the exact successor alongside the predecessor");
        const selected = installation(
          await call(work.successor_library, "activate", [id]),
          next.tag,
          next.artifact_sha256,
        );
        if (selected.id !== acquired.id) throw new Error("A different stage became active");
        successorInstallId = String(selected.id);
        return {
          outcome: "passed",
          predecessor_install_id: before.id,
          successor_install_id: selected.id,
          artifact_sha256: next.artifact_sha256,
        };
      },
      async "verify-package-and-install"() {
        return { outcome: "passed", ...(await verify(work.successor_library, successorInstallId)) };
      },
      async "launch-and-close"() {
        const selected = await active(work.successor_library, next.tag, next.artifact_sha256);
        if (
          selected.id !== successorInstallId ||
          selected.selected_executable !== work.successor_executable.relative_path
        )
          throw new Error("The exact selected executable or active installation changed");
        const executable = await realpath(
          path.join(String(selected.path), String(selected.selected_executable)),
        );
        const installed = await realpath(String(selected.path));
        const relative = path.relative(installed, executable);
        if (
          !relative ||
          relative.startsWith("..") ||
          path.isAbsolute(relative) ||
          !(await lstat(executable)).isFile()
        )
          throw new Error("Native game executable is outside the managed install");
        const result = await launchAndCloseVerifiedWindowsGame(
          {
            cli: cli.path,
            cli_sha256: cli.sha256,
            library: work.successor_library,
            port_id: id,
            executable,
            executable_sha256: work.successor_executable.sha256,
            output,
          },
          environment,
        );
        return { ...result, outcome: "passed" };
      },
      async "retain-and-reopen-predecessor"() {
        const rollback = installation(
          await call(work.successor_library, "rollback", [id]),
          previous.tag,
          previous.artifact_sha256,
        );
        if (rollback.id !== before.id)
          throw new Error("Rollback did not select the original retained install");
        const original = await active(
          work.predecessor_library,
          previous.tag,
          previous.artifact_sha256,
        );
        if (original.id !== work.predecessor_active.install_id)
          throw new Error("Historical baseline changed");
        await verify(work.predecessor_library, original.id);
        return { outcome: "passed", ...(await verify(work.successor_library, rollback.id)) };
      },
    },
  });
}
