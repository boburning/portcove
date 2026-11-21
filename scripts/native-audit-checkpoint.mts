import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorCode, isRecord } from "./runtime-values.mts";

export async function writeNativeAuditCheckpoint(
  record: unknown,
  primary: string,
  fallback?: string,
  createDirectory = mkdir,
) {
  if (
    !isRecord(record) ||
    !Number.isSafeInteger(record.issue) ||
    Number(record.issue) < 1 ||
    ![record.build, record.launch_id].some(
      (value) => typeof value === "string" && value.trim().length > 0,
    ) ||
    typeof record.evidence_path !== "string" ||
    !path.isAbsolute(record.evidence_path) ||
    typeof record.resume_condition !== "string" ||
    !record.resume_condition.trim()
  ) {
    throw new Error(
      "Checkpoint requires an issue, build or launch ID, absolute evidence path and resume condition",
    );
  }
  if (!path.isAbsolute(primary) || (fallback !== undefined && !path.isAbsolute(fallback)))
    throw new Error("Checkpoint directories must be absolute");

  const bytes = JSON.stringify(record, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > 64 * 1024) throw new Error("Checkpoint exceeds 64 KiB");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const persist = async (directory: string) => {
    const destination = path.join(directory, `issue-${String(record.issue)}-${sha256}.json`);
    const staged = path.join(directory, `.${randomUUID()}.pending`);
    await createDirectory(directory, { recursive: true });
    let stagedOwned = false;
    try {
      const handle = await open(staged, "wx", 0o600);
      stagedOwned = true;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if ((await readFile(staged, "utf8")) !== bytes)
        throw new Error("Checkpoint staging readback differed");
      await rename(staged, destination);
      stagedOwned = false;
      if ((await readFile(destination, "utf8")) !== bytes)
        throw new Error("Published checkpoint readback differed");
      return { path: destination, sha256 };
    } finally {
      if (stagedOwned) await rm(staged, { force: true });
    }
  };
  try {
    return { ...(await persist(primary)), storage: "primary" };
  } catch (error) {
    if (!fallback || !["ENOSPC", "EDQUOT"].includes(errorCode(error) ?? "")) throw error;
    return { ...(await persist(fallback)), storage: "fallback" };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, primary, fallback, ...extra] = process.argv.slice(2);
  if (!input || !primary || extra.length)
    throw new Error(
      "usage: native-audit-checkpoint.mts INPUT.json PRIMARY_DIRECTORY [FALLBACK_DIRECTORY]",
    );
  const info = await lstat(input);
  if (!info.isFile() || info.size > 64 * 1024)
    throw new Error("Checkpoint input must be a regular file up to 64 KiB");
  const record: unknown = JSON.parse(await readFile(input, "utf8"));
  console.log(JSON.stringify(await writeNativeAuditCheckpoint(record, primary, fallback)));
}
