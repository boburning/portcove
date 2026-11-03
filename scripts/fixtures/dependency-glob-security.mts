// Resolve the real development consumers without loading their signing/network entrypoints.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../runtime-values.mts";
type ReadDirectory = (
  directory: fs.PathLike,
  options: { withFileTypes: true },
  callback: (error: unknown, entries?: fs.Dirent[]) => void,
) => void;
type Glob = (
  pattern: string,
  options: { cwd: string; signal?: AbortSignal; fs?: { readdir: ReadDirectory } },
) => Promise<string[]>;
type MatchOptions = { nocase?: boolean; optimizationLevel?: number; braceExpandMax?: number };
type Matcher = { set: unknown[]; match(value: string): boolean };
type MatcherConstructor = new (pattern: string, options: MatchOptions) => Matcher;
function installedVersion(loader: NodeJS.Require, name: string): string {
  const metadata: unknown = loader(name + "/package.json");
  assert.ok(isRecord(metadata) && typeof metadata.version === "string");
  assert.match(metadata.version, /^\d+\.\d+\.\d+$/u);
  return metadata.version;
}

const require = createRequire(import.meta.url);
assert.equal(process.argv.length, 4);
assert.equal(process.argv[2], "--consumer");
const consumer = process.argv[3];
assert.ok(consumer === "signing-cache" || consumer === "localization-cli");
let resolver: NodeJS.Require;
if (consumer === "signing-cache") {
  const signing = createRequire(require.resolve("@sigstore/sign"));
  const fetch = createRequire(signing.resolve("make-fetch-happen"));
  resolver = createRequire(fetch.resolve("cacache"));
} else {
  const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
  const desktop = createRequire(path.join(projectRoot, "apps/desktop/package.json"));
  resolver = createRequire(desktop.resolve("i18next-cli"));
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "portcove-glob-security-"));
const observations = [];

try {
  for (const name of ["left/one.txt", "left/nested/two.txt", "right/three.txt"]) {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, "fixture");
  }
  {
    const globPath = resolver.resolve("glob");
    const globRequire = createRequire(globPath);
    const globVersion = installedVersion(globRequire, "glob");
    const minimatchVersion = installedVersion(globRequire, "minimatch");
    const [globMajor, globMinor, globPatch] = globVersion.split(".").map(Number);
    const [matchMajor, matchMinor, matchPatch] = minimatchVersion.split(".").map(Number);
    assert.ok(globMajor !== undefined && globMinor !== undefined && globPatch !== undefined);
    assert.ok(matchMajor !== undefined && matchMinor !== undefined && matchPatch !== undefined);
    assert.ok(globMajor > 14 || (globMajor === 14 && (globMinor > 0 || globPatch >= 2)));
    assert.ok(matchMajor > 11 || (matchMajor === 11 && (matchMinor > 0 || matchPatch >= 1)));
    const globModule: unknown = globRequire(globPath);
    const matcherModule: unknown = globRequire("minimatch");
    assert.ok(isRecord(globModule) && typeof globModule.glob === "function");
    assert.ok(
      isRecord(matcherModule) &&
        typeof matcherModule.minimatch === "function" &&
        typeof matcherModule.Minimatch === "function",
    );
    const glob = globModule.glob as Glob;
    const minimatch = matcherModule.minimatch as (
      value: string,
      pattern: string,
      options?: MatchOptions,
    ) => boolean;
    const Minimatch = matcherModule.Minimatch as MatcherConstructor;
    if (consumer === "localization-cli") {
      assert.equal(resolver.resolve("minimatch"), globRequire.resolve("minimatch"));
    }

    assert.ok(minimatch("src/file.ts", "src/*.{js,ts}"));
    assert.ok(!minimatch("src/.hidden.ts", "src/*.ts"));
    assert.ok(minimatch("SRC/FILE.TS", "src/*.ts", { nocase: true }));
    const small = new Minimatch("**/../a/b/**/../c/d", { optimizationLevel: 2 });
    assert.equal(small.set.length, 4);
    assert.ok(small.match("../a/b/../c/d"));
    assert.ok(small.match("x/a/b/y/c/d"));
    // Eight splits are bounded even on the old implementation (256 rows), not a large PoC.
    const capped = new Minimatch(Array<string>(8).fill("**/../a/b").join("/"), {
      optimizationLevel: 2,
      braceExpandMax: 8,
    });
    assert.equal(capped.set.length, 8);

    assert.deepEqual((await glob("**/*.txt", { cwd: root })).sort(), [
      "left/nested/two.txt",
      "left/one.txt",
      "right/three.txt",
    ]);
    const controller = new AbortController();
    const reason = new Error("controlled traversal cancellation");
    let reads = 0;
    const observedFs = {
      ...fs,
      readdir(
        directory: fs.PathLike,
        options: { withFileTypes: true },
        callback: (error: unknown, entries?: fs.Dirent[]) => void,
      ) {
        reads++;
        queueMicrotask(() => {
          let entries;
          try {
            entries = fs.readdirSync(directory, options);
          } catch (error) {
            callback(error);
            return;
          }
          if (reads === 1) controller.abort(reason);
          callback(null, entries);
        });
      },
    };
    await assert.rejects(
      glob("**/*.txt", {
        cwd: root,
        signal: controller.signal,
        fs: observedFs,
      }),
      (error) => error === reason,
    );
    // The controlled filesystem schedules only microtasks; drain them before the absence check.
    for (let i = 0; i < 32; i++) await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(reads, 1, "cancellation must not enumerate child directories");
    observations.push({
      consumer,
      globVersion,
      minimatchVersion,
      cappedRows: capped.set.length,
      reads,
    });
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ observations }));
