/** Fixed same-job upload coordination only. These files never create a private
 * publication receipt; the actual producer independently verifies provider bytes. */
import path from "node:path";
import { appendFile, lstat, realpath, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { isRecord } from "./runtime-values.mts";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const markerName = "publication-controller-output.json";
async function json(filename: string, maximum: number): Promise<unknown> {
  return JSON.parse((await readControllerToolFile(filename, maximum)).toString("utf8"));
}
export async function inspectPublicationUploadHandoff(root: string) {
  if (!path.isAbsolute(root)) throw new Error("fixed runner temporary root required");
  const marker = await json(path.join(root, markerName), 4096);
  if (
    !isRecord(marker) ||
    Object.keys(marker).sort().join(",") !== "directory,report_sha256" ||
    typeof marker.directory !== "string" ||
    !/^[a-f0-9]{64}$/u.test(String(marker.report_sha256))
  )
    throw new Error("publication upload routing differs");
  const directory = path.resolve(marker.directory),
    relative = path.relative(path.resolve(root), directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("publication upload escaped owned runner root");
  for (let current = directory; ; current = path.dirname(current)) {
    const stat = await lstat(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      path.resolve(await realpath(current)) !== current
    )
      throw new Error("publication upload directory is not direct owned storage");
    if (current === path.resolve(root)) break;
  }
  const ready = await json(path.join(directory, "result-ready.json"), 4096);
  if (
    !isRecord(ready) ||
    Object.keys(ready).sort().join(",") !== "authority,files,name,pending,report_sha256" ||
    ready.authority !== "none" ||
    ready.report_sha256 !== marker.report_sha256 ||
    JSON.stringify(ready.files) !== '["immutable-release-result.json"]' ||
    ready.name !==
      `trusted-immutable-release-result-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}` ||
    !isRecord(ready.pending) ||
    Object.keys(ready.pending).sort().join(",") !== "checkpoint,operation_id" ||
    !/^[a-f0-9]{40}$/u.test(String(ready.pending.checkpoint)) ||
    !/^[a-f0-9]{64}$/u.test(String(ready.pending.operation_id))
  )
    throw new Error("publication upload pending route differs");
  const report = path.join(directory, "upload", "immutable-release-result.json");
  if (sha(await readControllerToolFile(report, 65536)) !== marker.report_sha256)
    throw new Error("publication upload report changed");
  return {
    directory,
    report,
    name: String(ready.name),
    report_sha256: String(marker.report_sha256),
  };
}

export async function publicationUploadCommand(
  mode: string,
  root: string,
  deadline: number,
  artifact?: { id: number; sha256: string },
) {
  if (!["--ready", "--uploaded", "--predicate"].includes(mode) || !Number.isFinite(deadline))
    throw new Error("fixed publication handoff mode required");
  while (performance.now() < deadline) {
    try {
      const ended = await json(path.join(root, "publication-controller-process-ended.json"), 4096);
      if (!isRecord(ended) || ended.exit_code !== 0)
        throw new Error("publication producer refused");
      if (mode !== "--predicate")
        throw new Error("publication producer already ended before handoff");
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
    let route: Awaited<ReturnType<typeof inspectPublicationUploadHandoff>>;
    try {
      route = await inspectPublicationUploadHandoff(root);
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      await delay(Math.min(100, Math.max(1, deadline - performance.now())));
      continue;
    }
    if (mode === "--uploaded") {
      if (
        !artifact ||
        Object.keys(artifact).sort().join(",") !== "id,sha256" ||
        !Number.isSafeInteger(artifact.id) ||
        artifact.id < 1 ||
        !/^[a-f0-9]{64}$/u.test(artifact.sha256)
      )
        throw new Error("fixed uploaded artifact locator required");
      await writeFile(
        path.join(route.directory, "result-uploaded.json"),
        JSON.stringify(artifact),
        { flag: "wx", mode: 0o600 },
      );
      return { authority: "none" };
    }
    let predicate: string | undefined;
    if (mode === "--predicate") {
      try {
        const ended = await json(
          path.join(root, "publication-controller-process-ended.json"),
          4096,
        );
        if (!isRecord(ended) || ended.exit_code !== 0)
          throw new Error("publication producer did not settle");
        predicate = path.join(route.directory, "immutable-release-result-predicate.json");
        await readControllerToolFile(predicate, 65536);
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
        await delay(Math.min(100, Math.max(1, deadline - performance.now())));
        continue;
      }
    }
    if (!process.env.GITHUB_OUTPUT) throw new Error("fixed workflow output channel unavailable");
    const values =
      mode === "--ready"
        ? { report: route.report, name: route.name, report_sha256: route.report_sha256 }
        : { predicate };
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== "string" || /[\r\n]/u.test(value))
        throw new Error("publication output is not a fixed single line");
      await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
    return { authority: "none" };
  }
  throw new Error("publication upload handoff deadline exhausted; retain original pending");
}
