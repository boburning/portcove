import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Parse native TypeScript without executing it or requiring installed dependencies. */
export function checkNodeSource(file: string): void {
  if (!/\.[cm]?ts$/u.test(file)) throw new Error("Expected a native TypeScript source file");
  stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip", sourceUrl: file });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error("Usage: check-node-source.mts <literal TypeScript files>...");
  for (const file of files) checkNodeSource(file);
}
