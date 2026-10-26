/** Dependency data observations only. No original receipt or execution authority. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readlinkSync, realpathSync, type BigIntStats } from "node:fs";
import { opendir } from "node:fs/promises";
import path from "node:path";
import { hashNativeCapturedFile } from "./release-native-capture-files.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { inspectNativeDependencyWorkspace, nativePnpmVersion } from "./release-pnpm-runtime.mts";
import { lockInventory } from "./pnpm-lock-inventory.mts";
import { isRecord } from "./runtime-values.mts";

const roots = ["node_modules", "apps/desktop/node_modules"] as const;
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const noControls = (value: string) => {
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) < 32) return false;
  return true;
};
const identity = (info: BigIntStats) =>
  [info.dev, info.ino, info.mode, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(":");

export async function inspectWindowsNativeDependencyInputs(
  source: string,
  deadline: number,
  check: () => void,
) {
  const active = () => {
    check();
    assert.ok(
      Number.isFinite(deadline) && performance.now() < deadline,
      "original dependency input deadline exhausted",
    );
  };
  const read = async (name: string, maximum: number) => {
    active();
    const observed = await hashNativeCapturedFile(source, name, maximum, deadline);
    const bytes = await readControllerToolFile(path.join(source, name), maximum);
    assert.equal(hash(bytes), observed.sha256, "dependency configuration changed");
    active();
    return bytes;
  };
  for (const directory of ["", "apps/desktop"]) {
    assert.equal(
      lstatSync(path.join(source, directory, ".npmrc"), { throwIfNoEntry: false }),
      undefined,
      "source registry overrides refused",
    );
    const manifest: unknown = JSON.parse(
      (await read(path.join(directory, "package.json"), 65536)).toString("utf8"),
    );
    assert.ok(isRecord(manifest) && manifest.pnpm === undefined);
    assert.ok(
      directory
        ? manifest.packageManager === undefined ||
            manifest.packageManager === `pnpm@${nativePnpmVersion}`
        : manifest.packageManager === `pnpm@${nativePnpmVersion}`,
    );
    for (const kind of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const dependencies = manifest[kind] ?? {};
      assert.ok(isRecord(dependencies) && Object.keys(dependencies).length <= 4096);
      for (const [name, version] of Object.entries(dependencies)) {
        assert.ok(name.length <= 256 && typeof version === "string" && version.length <= 4096);
        assert.ok(!/^(?:file:|link:|git|https?:|ssh:|\.|\/)|^[^@:]+\//u.test(version));
        assert.ok(
          !version.includes(":") ||
            (version.split(":").length === 2 && /^(?:npm|catalog|workspace):/u.test(version)),
        );
        assert.ok(
          !version.startsWith("workspace:") || /^workspace:[*~^0-9][0-9.*~^ -]*$/u.test(version),
        );
      }
    }
  }
  const workspace = inspectNativeDependencyWorkspace(await read("pnpm-workspace.yaml", 65536));
  for (const patch of workspace.patches) await read(patch, 1024 ** 2);
  const lock = await read("pnpm-lock.yaml", 4 * 1024 ** 2);
  const packages = lockInventory(new TextDecoder("utf-8", { fatal: true }).decode(lock));
  assert.ok(packages.size > 0 && packages.size <= 10000);
  assert.ok(
    [...packages].every(([key, value]) => key.startsWith("0:") && value.unsupported === undefined),
    "non-registry or unsupported lock resolution refused",
  );
  active();
  return Object.freeze({
    workspace_sha256: workspace.sha256,
    lock_sha256: hash(lock),
    patches: workspace.patches,
    registry_packages: packages.size,
  });
}

/** Junctions may use the local extended-drive prefix. No UNC/device/ADS or
 * drive-relative interpretation; preserve dot segments for chain resolution. */
export function inspectWindowsNativeDependencyTarget(raw: string) {
  assert.ok(raw.length > 0 && Buffer.byteLength(raw) <= 4096);
  let target = raw.replaceAll("/", "\\");
  if (/^\\\\\?\\[A-Za-z]:\\/u.test(target)) target = target.slice(4);
  assert.ok(
    !target.startsWith("\\") && !/[<>|"?*]/u.test(target) && noControls(target),
    "unsupported Windows dependency target",
  );
  if (/^[A-Za-z]:/u.test(target)) {
    assert.ok(/^[A-Za-z]:\\/u.test(target));
    assert.ok(!target.slice(2).includes(":"));
  } else assert.ok(!target.includes(":"));
  return target;
}

function contained(root: string, filename: string) {
  const relative = path.relative(root, filename);
  assert.ok(
    !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep),
    "dependency target escapes source",
  );
  return relative;
}

function resolveLink(root: string, filename: string, active: () => void) {
  const seen = new Set<string>();
  let current = root,
    pending = contained(root, filename).split(path.sep);
  while (pending.length) {
    active();
    assert.ok(pending.length <= 256);
    const component = pending.shift()!;
    if (!component || component === ".") continue;
    if (component === "..") {
      assert.notEqual(current, root, "dependency chain escapes source");
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, component),
      info = lstatSync(next, { bigint: true });
    if (info.isSymbolicLink()) {
      assert.ok(seen.size < 128 && !seen.has(next), "dependency link resolution cycle");
      seen.add(next);
      const raw = readlinkSync(next);
      const target = process.platform === "win32" ? inspectWindowsNativeDependencyTarget(raw) : raw;
      assert.ok(Buffer.byteLength(target) <= 4096);
      if (path.isAbsolute(target)) {
        // Do not collapse '..' through an unchecked intermediate junction.
        const rootVolume = path.parse(root).root,
          targetVolume = path.parse(target).root;
        const rootParts = root.slice(rootVolume.length).split(path.sep),
          targetParts = target.slice(targetVolume.length).split(path.sep);
        assert.ok(
          targetVolume === rootVolume &&
            rootParts.every((part, index) => targetParts[index] === part),
          "absolute dependency target escapes source",
        );
        pending = [...targetParts.slice(rootParts.length), ...pending];
        current = root;
      } else pending = [...target.split(path.sep), ...pending];
    } else {
      assert.ok(
        info.isDirectory() || (!pending.length && info.isFile()),
        "special dependency target refused",
      );
      assert.equal(realpathSync(next), next, "noncanonical dependency target");
      current = next;
    }
  }
  assert.notEqual(current, root, "dependency link cannot target source root");
  assert.equal(realpathSync(filename), current, "dependency chain changed during resolution");
  return contained(root, current);
}

type DependencyRecord = Readonly<{
  path: string;
  kind: "directory" | "file" | "link";
  identity: string;
  bytes?: number;
  sha256?: string;
  target?: string;
  resolved?: string;
}>;

/** Traverse physical directories once. Ordinary package cycles remain valid;
 * only cyclic/escaping link-resolution chains are refused. */
export async function snapshotWindowsNativeDependencies(
  source: string,
  deadline: number,
  check: () => void,
) {
  const active = () => {
    check();
    assert.ok(
      Number.isFinite(deadline) && performance.now() < deadline,
      "original dependency snapshot deadline exhausted",
    );
  };
  active();
  assert.equal(realpathSync(source), source);
  const sourceInfo = lstatSync(source, { bigint: true });
  assert.ok(sourceInfo.isDirectory() && !sourceInfo.isSymbolicLink());
  const pending = roots.map((name) => path.join(source, ...name.split("/")));
  for (const filename of pending)
    assert.ok(
      lstatSync(filename).isDirectory() && !lstatSync(filename).isSymbolicLink(),
      "fixed dependency root absent or linked",
    );
  const names = new Set<string>(),
    directories = new Set<string>(),
    records: DependencyRecord[] = [];
  let bytes = 0,
    serialized = 2;
  while (pending.length) {
    active();
    assert.ok(records.length + pending.length <= 100000, "dependency inventory exceeds bound");
    const filename = pending.pop()!,
      relative = contained(source, filename),
      before = lstatSync(filename, { bigint: true });
    assert.ok(Buffer.byteLength(relative) <= 4096 && before.dev === sourceInfo.dev);
    const key = relative.toLowerCase();
    assert.ok(!names.has(key), "dependency path alias refused");
    names.add(key);
    const same = identity(before);
    let record: DependencyRecord;
    if (before.isSymbolicLink()) {
      const target = readlinkSync(filename);
      record = {
        path: relative,
        kind: "link",
        identity: same,
        target,
        resolved: resolveLink(source, filename, active),
      };
    } else if (before.isDirectory()) {
      assert.equal(realpathSync(filename), filename);
      const directoryId = `${before.dev}:${before.ino}`;
      assert.ok(!directories.has(directoryId), "dependency directory alias refused");
      directories.add(directoryId);
      record = { path: relative, kind: "directory", identity: same };
      const directory = await opendir(filename);
      for await (const child of directory) {
        active();
        assert.ok(
          !/[<>:"\\|?*]/u.test(child.name) && noControls(child.name) && !/[ .]$/u.test(child.name),
        );
        assert.ok(records.length + pending.length < 100000);
        pending.push(path.join(filename, child.name));
      }
    } else {
      assert.ok(before.isFile() && before.nlink === 1n && before.size <= 128n * 1024n ** 2n);
      const observed = await hashNativeCapturedFile(source, relative, 128 * 1024 ** 2, deadline);
      bytes += observed.bytes;
      assert.ok(bytes <= 2 * 1024 ** 3, "dependency bytes exceed bound");
      record = {
        path: relative,
        kind: "file",
        identity: same,
        bytes: observed.bytes,
        sha256: observed.sha256,
      };
    }
    assert.equal(
      identity(lstatSync(filename, { bigint: true })),
      same,
      "dependency changed during snapshot",
    );
    serialized += Buffer.byteLength(JSON.stringify(record)) + 1;
    assert.ok(serialized <= 64 * 1024 ** 2, "dependency record bytes exceed bound");
    records.push(Object.freeze(record));
  }
  records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const physical = new Set(
    records.filter((record) => record.kind !== "link").map((record) => record.path),
  );
  for (const record of records) {
    active();
    const filename = path.join(source, record.path);
    assert.equal(
      identity(lstatSync(filename, { bigint: true })),
      record.identity,
      "dependency changed after snapshot",
    );
    if (record.kind === "link") {
      assert.ok(
        record.resolved && physical.has(record.resolved),
        "dependency target outside inventoried physical graph",
      );
      assert.equal(readlinkSync(filename), record.target);
      assert.equal(resolveLink(source, filename, active), record.resolved);
    }
  }
  active();
  return Object.freeze({
    records: Object.freeze(records),
    entries: records.length,
    bytes,
    sha256: hash(JSON.stringify(records)),
    authority: "none" as const,
  });
}
