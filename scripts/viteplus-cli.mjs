import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Resolve the installed package's declared executable, never PATH or a download. */
export function vitePlusCommand(cwd) {
  const require = createRequire(path.join(path.resolve(cwd), "package.json"));
  const packageFile = require.resolve("vite-plus/package.json");
  const manifest = JSON.parse(readFileSync(packageFile, "utf8"));
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.vp;
  if (manifest.name !== "vite-plus" || typeof bin !== "string")
    throw new Error("Installed Vite+ does not declare its vp executable");
  const directory = path.dirname(packageFile);
  const executable = path.resolve(directory, bin);
  const relative = path.relative(directory, executable);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  )
    throw new Error("Installed Vite+ executable escapes its package");
  if (!statSync(executable).isFile()) throw new Error("Installed Vite+ executable is not a file");
  const header = Buffer.alloc(128);
  const file = openSync(executable, "r");
  let length;
  try {
    length = readSync(file, header);
  } finally {
    closeSync(file);
  }
  const node = /^#![^\r\n]*\bnode(?:\s|$)/u.test(header.subarray(0, length).toString("utf8"));
  return {
    command: node ? process.execPath : executable,
    args: node ? [executable] : [],
    executable,
    version: manifest.version,
    packageFile,
  };
}
