import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { replaceJsonFileSync, replacePreparedFile } from "../prepared-file-replacement.mts";

export async function exerciseWindowsReaderSharing(t: TestContext) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  mkdirSync(path.join(root, "work"), { recursive: true });
  const state = mkdtempSync(path.join(root, "work/discovery-sharing-fixture-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const target = path.join(state, "budget.json");
  const script = path.join(state, "hold.ps1");
  writeFileSync(
    script,
    'param([string]$Target,[int]$Hold)\n$stream=[IO.File]::Open($Target,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)\ntry { [Console]::Out.WriteLine("held"); Start-Sleep -Milliseconds $Hold } finally {$stream.Dispose()}',
  );
  for (const asynchronous of [false, true]) {
    for (const milliseconds of [300, 1800]) {
      writeFileSync(target, "old");
      const child = spawn("pwsh", ["-NoProfile", "-File", script, target, String(milliseconds)], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = once(child, "exit");
      try {
        const signal: unknown[] = await once(child.stdout, "data");
        const ready = signal[0];
        assert.ok(Buffer.isBuffer(ready));
        assert.match(ready.toString("utf8"), /held/);
        const probe = path.join(state, "probe.next");
        writeFileSync(probe, "probe");
        assert.throws(() => renameSync(probe, target), { code: "EPERM" });
        const started = performance.now();
        if (milliseconds === 300) {
          // Exercise the production writer; old implementation fails at this same boundary.
          if (asynchronous) {
            writeFileSync(probe, JSON.stringify({ requests: 134 }));
            await replacePreparedFile(probe, target);
          } else replaceJsonFileSync(target, { requests: 134 });
          assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { requests: 134 });
        } else {
          if (asynchronous) {
            writeFileSync(probe, JSON.stringify({ requests: 135 }));
            await assert.rejects(replacePreparedFile(probe, target), { code: "EPERM" });
            assert.deepEqual(JSON.parse(readFileSync(probe, "utf8")), { requests: 135 });
          } else
            assert.throws(() => replaceJsonFileSync(target, { requests: 135 }), {
              code: "EPERM",
            });
          assert.equal(readFileSync(target, "utf8"), "old");
          const pending = asynchronous
            ? "probe.next"
            : readdirSync(state).find(
                (name) => name.startsWith("budget.json.") && name.endsWith(".next"),
              );
          assert.ok(pending);
          assert.deepEqual(JSON.parse(readFileSync(path.join(state, pending), "utf8")), {
            requests: 135,
          });
        }
        assert.ok(
          performance.now() - started < 1600,
          "state replacement must retain its finite wait",
        );
      } finally {
        assert.deepEqual(await exited, [0, null]);
      }
    }
  }
}
