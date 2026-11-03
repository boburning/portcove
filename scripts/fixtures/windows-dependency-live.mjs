import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { inspectWindowsDependencyPreparationInventory } from "../release-hosted-native-windows-source.mts";
import { snapshotWindowsNativeDependencies } from "../release-hosted-native-windows-dependency-files.mts";

const cases = [];
for (const mode of [
  "live-link",
  "settled",
  "root",
  "EACCES",
  "EPERM",
  "EIO",
  "file",
  "initial-lstat",
  "hardlink",
  "expired",
  "count",
  "link-bytes",
  "missing-root",
]) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pc-dependency-live-"));
  fs.mkdirSync(path.join(base, "root/source/apps/desktop/node_modules"), { recursive: true });
  fs.mkdirSync(path.join(base, "root/source/node_modules/staging"), { recursive: true });
  fs.mkdirSync(path.join(base, "outside"));
  fs.writeFileSync(path.join(base, "outside/sentinel"), "must not traverse");
  const root = fs.realpathSync(path.join(base, "root"));
  const source = fs.realpathSync(path.join(root, "source"));
  const outside = fs.realpathSync(path.join(base, "outside"));
  const child = path.join(source, "node_modules/staging");
  const target = mode === "root" ? root : child;
  const originalRead = fs.readdirSync;
  const originalStat = fs.lstatSync;
  const expired = new Error("original preparation expired");
  let armed = true;
  let outsideReads = 0;
  let statCalls = 0;
  try {
    if (mode === "hardlink") {
      fs.writeFileSync(path.join(child, "file"), "fixture");
      fs.linkSync(path.join(child, "file"), path.join(child, "hardlink"));
    }
    if (mode === "missing-root") fs.rmSync(root, { recursive: true });
    fs.lstatSync = (...args) => {
      statCalls++;
      const filename = String(args[0]);
      if (mode === "initial-lstat" && filename === child)
        throw Object.assign(new Error("controlled initial stat"), { code: "EBUSY" });
      const info = originalStat(...args);
      // Exercise refreshed byte accounting without allocating a multi-GiB file.
      if (mode === "link-bytes" && filename === child && info?.isSymbolicLink())
        return Object.create(info, { size: { value: 2 * 1024 ** 3 + 1 } });
      return info;
    };
    fs.readdirSync = (...args) => {
      const filename = String(args[0]);
      if (filename === outside || filename.startsWith(outside + path.sep)) {
        outsideReads++;
        throw new Error("link target traversal forbidden");
      }
      if (mode === "count" && filename === root) return Array(100000).fill("entry");
      if (
        filename === target &&
        armed &&
        !["initial-lstat", "hardlink", "expired", "count", "missing-root"].includes(mode)
      ) {
        armed = false;
        fs.rmSync(target, { recursive: true });
        if (mode === "file") fs.writeFileSync(target, "replacement");
        else fs.symlinkSync(outside, target, process.platform === "win32" ? "junction" : "dir");
        throw Object.assign(new Error("controlled directory enumeration"), {
          code: ["EACCES", "EPERM", "EIO"].includes(mode) ? mode : "EBUSY",
        });
      }
      if (filename === target && !armed) throw new Error("replacement leaf was traversed");
      return originalRead(...args);
    };
    syncBuiltinESMExports();
    const active = () => {
      if (mode === "expired") throw expired;
    };
    const scan = () =>
      inspectWindowsDependencyPreparationInventory(root, source, active, mode !== "settled");
    if (mode === "live-link") {
      const observed = scan();
      assert.equal(armed, false);
      assert.equal(outsideReads, 0);
      // A normal link leaf and a resampled one have the same entry accounting.
      const baseline = inspectWindowsDependencyPreparationInventory(root, source, active);
      assert.equal(observed.entries, baseline.entries);
      assert.ok(observed.bytes >= baseline.bytes);
      assert.ok(observed.bytes >= originalStat(child).size);
      fs.readdirSync = originalRead;
      fs.lstatSync = originalStat;
      syncBuiltinESMExports();
      await assert.rejects(
        snapshotWindowsNativeDependencies(source, performance.now() + 5000, () => {}),
        /dependency target escapes source/,
      );
    } else if (mode === "expired") {
      assert.throws(scan, (error) => error === expired);
      assert.equal(statCalls, 0);
    } else if (["hardlink", "count", "link-bytes"].includes(mode)) {
      assert.throws(scan, /inventory exceeded|inventory.*bound/);
    } else if (mode === "missing-root") {
      assert.throws(scan, /required dependency preparation root disappeared/);
    } else {
      assert.throws(
        scan,
        (error) => error.code === (["EACCES", "EPERM", "EIO"].includes(mode) ? mode : "EBUSY"),
      );
    }
    assert.equal(outsideReads, 0);
    cases.push(mode);
  } finally {
    fs.readdirSync = originalRead;
    fs.lstatSync = originalStat;
    syncBuiltinESMExports();
    fs.rmSync(base, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ cases }));
