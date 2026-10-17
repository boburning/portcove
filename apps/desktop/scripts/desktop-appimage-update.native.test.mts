import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { errorCode } from "../../../scripts/runtime-values.mts";

const source = stripTypeScriptTypes(
  await readFile(new URL("./desktop-appimage-update-test.mts", import.meta.url), "utf8"),
  { mode: "strip" },
);
function fragment(start: string, end: string): string {
  const from = source.indexOf(start),
    until = source.indexOf(end, from);
  assert.ok(from >= 0 && until > from);
  return source.slice(from, until);
}

void test("AppImage healthy reconciliation requires actual payload absence, not an inspection failure", async () => {
  const readers = fragment("function object(", "const report");
  const reconciliation = fragment(
    "  const restart = await waitFor(",
    "  report.restart = restart;",
  );
  for (const code of ["ENOENT", "EACCES", "EIO", "ENOTDIR"]) {
    const failure = Object.assign(new Error(code), { code });
    const result: unknown = runInNewContext(
      `(async () => { ${readers} ${reconciliation} return restart; })()`,
      {
        assert,
        errorCode,
        app: "/owned/Portcove.AppImage",
        candidateSha: "a".repeat(64),
        staging: "/owned/staging",
        stageMarker: "/owned/stage.json",
        stagedPayload: "/owned/staging/candidate.payload",
        path: { join: (...parts: string[]) => parts.join("/") },
        readJson: async (file: string) =>
          file.endsWith("stage.json")
            ? { stage: "Tauri setup", process_id: 42 }
            : { intent: null, phase: "reconciled" },
        hashFile: async () => ({ sha256: "a".repeat(64) }),
        stat: () => Promise.reject(failure),
        waitFor: async (predicate: () => Promise<unknown>, label: string, budget: number) => {
          assert.equal(label, "renderer-driven restart and healthy-startup reconciliation");
          assert.equal(budget, 90_000);
          return predicate();
        },
      },
    );
    if (code === "ENOENT") {
      const value = await result;
      assert.ok(value !== null && typeof value === "object" && "marker" in value);
      assert.equal(
        JSON.stringify(value.marker),
        JSON.stringify({ stage: "Tauri setup", process_id: 42 }),
      );
    } else
      await assert.rejects(
        async () => {
          await result;
        },
        (error: unknown) => error === failure,
      );
  }
});

void test("AppImage procfs observation rejects unexpected failures and omits zombies", async () => {
  const inspect = fragment(
    "async function procIdentity(",
    "async function verifiedRelaunchIdentity(",
  );
  const fields = Array<string>(20).fill("0");
  fields[0] = "S";
  fields[19] = "123";
  const raw = `42 (owned command) ${fields.join(" ")}`;
  for (const state of ["S", "Z"]) {
    const result: unknown = runInNewContext(`${inspect} procIdentity(42)`, {
      errorCode,
      readFile: async (file: string) =>
        file.endsWith("/stat")
          ? raw.replace(") S ", `) ${state} `)
          : "/owned/app\0--portcove-apply-update\0",
    });
    const observed = await result;
    if (state === "Z") assert.equal(observed, null);
    else
      assert.equal(
        JSON.stringify(observed),
        JSON.stringify({
          pid: 42,
          start_ticks: "123",
          command: "/owned/app --portcove-apply-update ",
        }),
      );
  }
  for (const code of ["ENOENT", "ESRCH", "EACCES", "EIO"]) {
    const failure = Object.assign(new Error(code), { code });
    const result: unknown = runInNewContext(`${inspect} procIdentity(42)`, {
      errorCode,
      readFile: () => Promise.reject(failure),
    });
    if (code === "ENOENT" || code === "ESRCH") assert.equal(await result, null);
    else
      await assert.rejects(
        async () => {
          await result;
        },
        (error: unknown) => error === failure,
      );
  }
});

void test("AppImage relaunch environment and start ticks must agree before cleanup authority is returned", async () => {
  const verify = fragment(
    "async function verifiedRelaunchIdentity(",
    "async function verifiedHelperIdentity(",
  );
  const app = "/owned/Portcove.AppImage",
    stageMarker = "/owned/stage.json",
    relaunchMarker = "/owned/relaunch.json";
  const environment = [
    `PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_STAGE=${stageMarker}`,
    `PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_RELAUNCH_PROCESS=${relaunchMarker}`,
    "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_EXIT=after-reconciliation",
  ];
  for (const [changedIdentity, missingEnvironment] of [
    [false, false],
    [true, false],
    [false, true],
  ] as const) {
    let reads = 0;
    const result: unknown = runInNewContext(`${verify} verifiedRelaunchIdentity(marker)`, {
      assert,
      app,
      stageMarker,
      relaunchMarker,
      marker: { schema_version: 1, process_id: 42, executable: app },
      procIdentity: async () => ({
        pid: 42,
        start_ticks: changedIdentity && reads++ > 0 ? "replacement" : "123",
        command: app,
      }),
      readFile: async () => (missingEnvironment ? environment.slice(1) : environment).join("\0"),
    });
    if (changedIdentity || missingEnvironment)
      await assert.rejects(async () => {
        await result;
      });
    else {
      const identity = await result;
      assert.ok(identity !== null && typeof identity === "object" && "start_ticks" in identity);
      assert.equal(identity.start_ticks, "123");
    }
  }
});
