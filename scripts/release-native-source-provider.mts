/** Shared source-byte verification and retention only. Injected provider data
 * cannot create an actual candidate, report, issuer or native acceptance. */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import {
  nativeCompatibilitySourcePaths,
  inspectNativeCompatibilitySources,
} from "./release-native-source-contract.mts";

export async function retainNativeSourceDeclarations(
  directory: string,
  read: (pathname: (typeof nativeCompatibilitySourcePaths)[number]) => {
    status?: number;
    body: unknown;
  },
) {
  const files: Record<string, Buffer> = {};
  for (const pathname of nativeCompatibilitySourcePaths) {
    const response = read(pathname),
      raw = response.body;
    if (
      response.status !== 200 ||
      !isRecord(raw) ||
      raw.type !== "file" ||
      raw.path !== pathname ||
      raw.encoding !== "base64" ||
      typeof raw.size !== "number" ||
      raw.size < 1 ||
      raw.size > 1024 * 1024 ||
      typeof raw.content !== "string" ||
      raw.content.length > 2 * 1024 * 1024 ||
      typeof raw.sha !== "string" ||
      !/^[a-f0-9]{40}$/u.test(raw.sha)
    )
      throw new Error("native source provider declaration is incomplete");
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
      const original = await readBoundedPublicBuildInputFile(directory, filename, 1024 * 1024);
      if (!original.equals(bytes))
        throw new Error("native retained source declaration changed; preserve original input");
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      await writeFile(path.join(directory, filename), bytes, { flag: "wx", mode: 0o600 });
    }
  }
  return inspectNativeCompatibilitySources(files);
}
