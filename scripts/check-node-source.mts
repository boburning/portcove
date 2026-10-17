import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** Parse native TypeScript without executing it or requiring installed dependencies. */
export function checkNodeSource(file: string): void {
  if (!/\.[cm]?ts$/u.test(file)) throw new Error("Expected a native TypeScript source file");
  const javascript = stripTypeScriptTypes(readFileSync(file, "utf8"), {
    mode: "strip",
    sourceUrl: file,
  });
  // Stripping checks TypeScript grammar, but does not reject all JavaScript
  // early errors (for example duplicate lexical declarations). Preserve the
  // original node --check guarantee without executing the checked source.
  const parsed = spawnSync(process.execPath, ["--check", "--input-type=module"], {
    input: javascript,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  if (parsed.error) throw parsed.error;
  if (parsed.status !== 0)
    throw new SyntaxError(`Native syntax check failed for ${file}:\n${parsed.stderr}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error("Usage: check-node-source.mts <literal TypeScript files>...");
  for (const file of files) checkNodeSource(file);
}
