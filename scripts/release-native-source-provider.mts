/** Shared source-byte verification and retention only. Injected provider data
 * cannot create an actual candidate, report, issuer or native acceptance. */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import {
  nativeCompatibilitySourcePaths,
  nativeSourceDeclarationByteLimit,
  inspectNativeCompatibilitySources,
} from "./release-native-source-contract.mts";

export async function retainNativeSourceDeclarations(
  directory: string,
  read: (pathname: (typeof nativeCompatibilitySourcePaths)[number]) => {
    status?: number;
    body: unknown;
  },
  readBlob?: (sha: string) => { status?: number; body: unknown },
) {
  const files: Record<string, Buffer> = {};
  for (const pathname of nativeCompatibilitySourcePaths) {
    const response = read(pathname);
    let raw = response.body;
    const maximum = nativeSourceDeclarationByteLimit(pathname);
    if (
      response.status !== 200 ||
      !isRecord(raw) ||
      raw.type !== "file" ||
      raw.path !== pathname ||
      typeof raw.size !== "number" ||
      !Number.isSafeInteger(raw.size) ||
      raw.size < 1 ||
      raw.size > maximum ||
      typeof raw.sha !== "string" ||
      !/^[a-f0-9]{40}$/u.test(raw.sha)
    )
      throw new Error("native source provider declaration is incomplete");
    // Contents omits bytes above its inline envelope. Resolve only the exact
    // immutable blob named by this path at the selected source commit.
    if (raw.encoding === "none" && raw.content === "") {
      const blob = readBlob?.(raw.sha);
      if (
        blob?.status !== 200 ||
        !isRecord(blob.body) ||
        blob.body.sha !== raw.sha ||
        blob.body.size !== raw.size ||
        blob.body.encoding !== "base64"
      )
        throw new Error("native immutable source blob differs from selected file");
      raw = { ...raw, encoding: blob.body.encoding, content: blob.body.content };
    }
    if (
      !isRecord(raw) ||
      raw.encoding !== "base64" ||
      typeof raw.content !== "string" ||
      raw.content.length > 2 * maximum
    )
      throw new Error("native source provider encoding is incomplete or oversized");
    const compact = raw.content.replace(/\n/gu, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact))
      throw new Error("native source encoding is invalid");
    const bytes = Buffer.from(compact, "base64");
    if (
      bytes.byteLength !== raw.size ||
      bytes.toString("base64") !== compact ||
      createHash("sha1")
        .update(Buffer.from(`blob ${bytes.length}\0`))
        .update(bytes)
        .digest("hex") !== raw.sha
    )
      throw new Error("native immutable source bytes differ from provider identity");
    files[pathname] = bytes;
    const filename = `native-source-${nativeCompatibilitySourcePaths.indexOf(pathname)}.bin`;
    try {
      const original = await readBoundedPublicBuildInputFile(directory, filename, maximum);
      if (!original.equals(bytes))
        throw new Error("native retained source declaration changed; preserve original input");
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      await writeFile(path.join(directory, filename), bytes, { flag: "wx", mode: 0o600 });
    }
  }
  return inspectNativeCompatibilitySources(files);
}
