/** Fixed held workflow entrypoint; no candidate arguments, role key or publisher. */
import { appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildControllerTools } from "./release-controller-tool-build.mts";
import { prepareControllerToolPredicate } from "./release-controller-tool-admission.mts";
import { isRecord } from "./runtime-values.mts";
import { controllerOidcSubject } from "./assembler-job-identity.mts";
const project = fileURLToPath(new URL("..", import.meta.url));
const mode = process.argv[2];
try {
  if (
    process.argv.length !== 3 ||
    (mode !== "build" && mode !== "bind-upload") ||
    !process.env.RUNNER_TEMP ||
    !path.isAbsolute(process.env.RUNNER_TEMP)
  )
    throw new Error("fixed bootstrap operation required");
  for (const key of Object.keys(process.env))
    if (
      /^(?:TAURI_|AWS_|AZURE_|PORTCOVE_(?:CONTROL_APP_TOKEN|SIGNING_|ROOT_KEY|RELEASE_TOKEN))/u.test(
        key,
      )
    )
      throw new Error("role credentials cannot enter controller bootstrap");
  const commit = process.env.PORTCOVE_CONTROLLER_REVISION;
  if (!commit || !/^[a-f0-9]{40}$/u.test(commit))
    throw new Error("independently fixed controller revision required");
  if (mode === "build") {
    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)
      throw new Error("no GitHub read/write credential is needed during compilation");
    const tree = execFileSync("git", ["rev-parse", `${commit}^{tree}`], {
      cwd: project,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 1024,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
      },
    }).trim();
    const built = await buildControllerTools(project, process.env.RUNNER_TEMP, { commit, tree });
    if (!process.env.GITHUB_OUTPUT) throw new Error("fixed bootstrap output channel unavailable");
    await appendFile(process.env.GITHUB_OUTPUT, `tools=${built.tools}\nsource_tree=${tree}\n`);
  } else {
    const policy: unknown = JSON.parse(process.env.PORTCOVE_CONTROLLER_ADMISSION ?? "null");
    if (!isRecord(policy))
      throw new Error("ratified controller actor/ref configuration unavailable");
    const binding = await prepareControllerToolPredicate(
      process.env.RUNNER_TEMP,
      {
        controller_revision: commit,
        source_tree: process.env.PORTCOVE_CONTROLLER_TREE ?? "",
        controller_ref: process.env.PORTCOVE_CONTROLLER_REF ?? "",
        run_id: process.env.GITHUB_RUN_ID ?? "",
        run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        artifact_id: Number(process.env.PORTCOVE_TOOL_ARTIFACT_ID),
        sha256: process.env.PORTCOVE_TOOL_ARTIFACT_SHA256 ?? "",
      },
      {
        audience: "portcove-controller-tool-bootstrap",
        subject: controllerOidcSubject(process.env.PORTCOVE_CONTROLLER_REF ?? ""),
        controller_revision: commit,
        controller_ref: process.env.PORTCOVE_CONTROLLER_REF,
        actor_id: policy.actor_id,
        run_id: process.env.GITHUB_RUN_ID,
        run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      },
    );
    if (!process.env.GITHUB_OUTPUT) throw new Error("fixed predicate output channel unavailable");
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `predicate=${JSON.stringify(binding.predicate)}\nmanifest_sha256=${binding.manifest_sha256}\n`,
    );
  }
} catch {
  console.error(
    "fixed controller bootstrap refused; retain private build/acquisition evidence; no automatic retry",
  );
  process.exitCode = 2;
}
