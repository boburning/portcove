/** Whole public signer, real owned files and simulated monotonic time.
 * No signing key, worker, provider or protected authority is available here. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import children from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";

const forbidden = () => {
  throw new Error("Uncontrolled TUF fixture process/network work is forbidden");
};
globalThis.fetch = forbidden;
process.kill = forbidden;
for (const [name, value] of Object.entries(children))
  if (typeof value === "function") Reflect.set(children, name, forbidden);
syncBuiltinESMExports();
mock.module("node:child_process", {
  namedExports: Object.fromEntries(Object.entries(children)),
  defaultExport: children,
});

let clock = 59000;
Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const contextFiles = await import("../release-signing-context.mts");
const toolFiles = await import("../release-controller-tools.mts");
let reads: string[] | undefined;
const readHashes = new Map<string, string>();
mock.module(new URL("../release-signing-context.mts", import.meta.url).href, {
  namedExports: {
    ...contextFiles,
    readBoundedReleaseContextFiles: async (
      ...args: Parameters<typeof contextFiles.readBoundedReleaseContextFiles>
    ) => {
      const files = await contextFiles.readBoundedReleaseContextFiles(...args);
      if (reads) {
        reads.push(`read:${args[0]}`);
        const context = files.get("context.json");
        if (context) readHashes.set(args[0], hash(context));
        clock = 61000;
      }
      return files;
    },
  },
});
mock.module(new URL("../release-controller-tools.mts", import.meta.url).href, {
  namedExports: {
    ...toolFiles,
    readControllerToolFile: async (
      ...args: Parameters<typeof toolFiles.readControllerToolFile>
    ) => {
      const bytes = await toolFiles.readControllerToolFile(...args);
      if (reads) {
        reads.push(`read:${args[0]}`);
        readHashes.set(args[0], hash(bytes));
        clock = 61000;
      }
      return bytes;
    },
  },
});
const entry = new URL("../release-tuf-signing.mts", import.meta.url);
entry.searchParams.set("portcove-prekey", "actual");
type Subject = Pick<typeof import("../release-tuf-signing.mts"), "signIsolatedTufRole">;
function subject(value: unknown): Subject {
  assert.ok(value && typeof value === "object");
  assert.equal(typeof Reflect.get(value, "signIsolatedTufRole"), "function");
  return value as Subject;
}
const { signIsolatedTufRole } = subject(await import(entry.href));
type Mode =
  | "guard"
  | "deadline"
  | "context"
  | "public-context"
  | "tool"
  | "staged-tool"
  | "dependency";
async function scenario(mode: Mode, role: "releases" | "snapshot") {
  reads = undefined;
  readHashes.clear();
  clock = 59000;
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-tuf-prekey-"));
  const input = path.join(root, "inputs"),
    output = path.join(root, "output"),
    tool = path.join(root, "tool"),
    publicRoot = path.join(output, "public-inputs"),
    scratch = path.join(output, "private-work"),
    stagedTool = path.join(
      scratch,
      process.platform === "win32" ? "release-tools.exe" : "release-tools",
    );
  const context = Buffer.from(
    '{"schema_version":1,"generated_at":"2026-10-20T00:00:00Z","versions":{"releases":9007199254740993},"expires":{},"trusted_root":"trusted-root.json","offline_targets":"offline-targets.json","payload_key_registry":"payload.json","reconstructed_records":"records","previous_repository":"prior"}',
  );
  const toolBytes = Buffer.from("disposable inert TUF tool");
  const events: string[] = [],
    guards: number[] = [];
  let keys = 0;
  try {
    await mkdir(input);
    await writeFile(path.join(input, "context.json"), context);
    await writeFile(tool, toolBytes);
    const signed_roles = [];
    for (const dependency of role === "snapshot" ? ["releases", "preview", "stable"] : []) {
      const filename = `${dependency}.json`,
        bytes = Buffer.from(`inert ${dependency} envelope`),
        file = path.join(root, filename);
      await writeFile(file, bytes);
      signed_roles.push({ filename, path: file, bytes: bytes.length, sha256: hash(bytes) });
    }
    const changed = {
      context: path.join(input, "context.json"),
      "public-context": path.join(publicRoot, "context.json"),
      tool,
      "staged-tool": stagedTool,
      dependency: path.join(output, "signed-inputs", "releases.json"),
    };
    await assert.rejects(
      signIsolatedTufRole(
        {
          role,
          context_directory: input,
          output,
          tool: { path: tool, sha256: hash(toolBytes) },
          signed_roles,
        },
        {
          deadline: 115000,
          beforeKey: async () => {
            guards.push(clock);
            events.push("guard");
            if (guards.length === 1) {
              reads = events;
              if (mode !== "guard" && mode !== "deadline")
                await writeFile(changed[mode], "changed custody");
            } else if (mode === "deadline") clock = 116000;
            else if (mode === "guard") throw new Error("original controls expired");
          },
          keyMaterial: async () => {
            keys++;
            events.push("key");
            throw new Error("Unexpected TUF fixture key request");
          },
        },
      ),
      /isolated TUF role refused; public evidence retained/u,
    );
    // Assertions stay outside the production catch: an assertion thrown inside
    // beforeKey would itself become the expected public refusal.
    reads = undefined;
    assert.equal(keys, 0, `TUF_PREKEY_NO_KEY:${mode}:${role}`);
    if (mode === "guard" || mode === "deadline") {
      assert.deepEqual(guards, [59000, 61000], `TUF_PREKEY_GUARDS:${mode}:${role}`);
      assert.equal(events[0], "guard", `TUF_PREKEY_FIRST_GUARD:${mode}:${role}`);
      assert.equal(events.at(-1), "guard", `TUF_PREKEY_FINAL_GUARD:${mode}:${role}`);
      assert.deepEqual(
        events.slice(1, -1).sort(),
        [
          `read:${input}`,
          `read:${publicRoot}`,
          `read:${tool}`,
          `read:${stagedTool}`,
          ...signed_roles.map(
            (file) => `read:${path.join(output, "signed-inputs", file.filename)}`,
          ),
        ].sort(),
        `TUF_PREKEY_CUSTODY_READS:${mode}:${role}`,
      );
      assert.equal(clock, mode === "deadline" ? 116000 : 61000);
    } else {
      assert.deepEqual(guards, [59000], `TUF_PREKEY_CHANGED_INPUT:${mode}:${role}`);
      const changedRead =
        mode === "context" ? input : mode === "public-context" ? publicRoot : changed[mode];
      assert.equal(
        events.filter((event) => event === `read:${changedRead}`).length,
        1,
        `TUF_PREKEY_CHANGED_READ:${mode}:${role}`,
      );
      assert.equal(
        readHashes.get(changedRead),
        hash(Buffer.from("changed custody")),
        `TUF_PREKEY_CHANGED_BYTES:${mode}:${role}`,
      );
    }
    const refusal: unknown = JSON.parse(await readFile(path.join(output, "refusal.json"), "utf8"));
    const { releaseCanonicalDigest } = await import("../release-canonical.mts");
    assert.deepEqual(
      refusal,
      {
        schema_version: 1,
        phase: "fresh-controls-before-key",
        role,
        input_inventory_sha256: releaseCanonicalDigest([
          { filename: "context.json", bytes: context.length, sha256: hash(context) },
        ]),
        tool_sha256: hash(toolBytes),
        partial_envelope: null,
        authority: "none",
      },
      `TUF_PREKEY_REFUSAL:${mode}:${role}`,
    );
    assert.deepEqual(
      (await readdir(output)).sort(),
      role === "snapshot"
        ? ["public-inputs", "refusal.json", "signed-inputs"]
        : ["public-inputs", "refusal.json"],
      `TUF_PREKEY_SCRATCH_REMOVED:${mode}:${role}`,
    );
  } finally {
    reads = undefined;
    await rm(root, { recursive: true, force: true });
  }
}
if (process.argv[2] === "guards") {
  for (const role of ["releases", "snapshot"] as const)
    for (const mode of ["guard", "deadline"] as const) await scenario(mode, role);
} else if (process.argv[2] === "custody") {
  for (const mode of ["context", "public-context", "tool", "staged-tool", "dependency"] as const)
    await scenario(mode, mode === "dependency" ? "snapshot" : "releases");
} else throw new Error("TUF fixture scenario must be explicitly selected");
console.log(`actual TUF pre-key ${process.argv[2]} PASS; disposable files, no signing authority`);
