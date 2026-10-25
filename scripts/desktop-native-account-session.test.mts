import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  NativeAccountClient,
  type NativeAccountLaunch,
} from "./native-qualification-account-client.mts";
import { DesktopNativeAccountSession } from "../apps/desktop/scripts/desktop-native-account-session.mts";

void test(
  "account desktop handoff uses exact job identities, scrubbed environment and one stop",
  { skip: process.platform !== "win32" },
  () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "portcove-account-adapter-"));
    try {
      const work = path.join(root, "work"),
        capture = path.join(root, "capture"),
        profile = path.join(root, "profile");
      for (const directory of [work, capture, profile]) mkdirSync(directory);
      const driver = path.join(work, "driver.exe"),
        app = path.join(work, "app.exe");
      writeFileSync(driver, "inert fixture bytes; never executed");
      const binding = {
        invocation_id: "a".repeat(64),
        configuration_sha256: "b".repeat(64),
        helper_sha256: "c".repeat(64),
        broker_pid: 42,
        broker_created_filetime: "134000000000000000",
        capture_root: capture,
        account_sid: "S-1-5-21-1-2-3-1002",
        profile_root: profile,
        work_root: work,
        controller_root: fileURLToPath(new URL("../", import.meta.url)),
        powershell: { path: process.execPath, sha256: "d".repeat(64) },
        desktop_tools: {
          node: {
            path: process.execPath,
            sha256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
          },
          tauri_driver: {
            path: driver,
            sha256: createHash("sha256").update(readFileSync(driver)).digest("hex"),
          },
          webview_driver: {
            path: driver,
            sha256: createHash("sha256").update(readFileSync(driver)).digest("hex"),
          },
        },
      };
      const identity = { pid: 456, path: driver, started_filetime: "134000000000000001" };
      const application = { pid: 457, path: app, started_filetime: "134000000000000002" };
      class FixtureClient extends NativeAccountClient {
        live = true;
        changed = false;
        stops = 0;
        reads = 0;
        windows = 0;
        launch: NativeAccountLaunch | null = null;
        constructor() {
          super(binding);
        }
        override invoke(
          operation: Parameters<NativeAccountClient["invoke"]>[0],
          _id: string,
          launch: NativeAccountLaunch | null = null,
          target: { pid: number; started_filetime: string } | null = null,
        ) {
          if (operation === "start") {
            this.launch = structuredClone(launch);
            return identity;
          }
          if (operation === "observe")
            return {
              exited: !this.live,
              exit_code: this.live ? null : 125,
              processes: this.live
                ? [
                    {
                      ...identity,
                      started_filetime: this.changed
                        ? "134000000000000999"
                        : identity.started_filetime,
                    },
                    application,
                  ]
                : [],
            };
          if (operation === "window") {
            assert.deepEqual(target, {
              pid: application.pid,
              started_filetime: application.started_filetime,
            });
            this.windows++;
            return { title: "Portcove" };
          }
          if (operation === "stop") {
            this.stops++;
            this.live = false;
          } else if (operation === "readback") this.reads++;
          else throw new Error("Unexpected fixture operation");
          return {
            root_pid: identity.pid,
            root_created_filetime: identity.started_filetime,
            root_exited: true,
            job_empty: true,
            remaining_pids: [],
            exit_code: 125,
          };
        }
      }
      const client = new FixtureClient(),
        session = new DesktopNativeAccountSession(binding, client);
      assert.throws(() => session.environment({ GH_TOKEN: "must-not-cross" }), /Unreviewed/u);
      assert.throws(
        () => session.runtimeRoot(path.join(work, "forged-evidence")),
        /configured root/u,
      );
      const runtime = session.runtimeRoot(path.join(capture, "run-one"));
      mkdirSync(runtime);
      const view = session.start(
        driver,
        ["--port", "4567", "--native-port", "4568", "--native-driver", driver],
        runtime,
        {
          PORTCOVE_LIBRARY: path.join(runtime, "library"),
        },
      );
      assert.equal(view.pid, 456);
      assert.equal(view.exitCode, null);
      assert.equal(view.signalCode, null);
      assert.ok(view.stdout instanceof Readable);
      assert.ok(view.stderr instanceof Readable);
      assert.notEqual(view.stdout, view.stderr, "capture channels remain independent");
      assert.equal(client.launch?.environment.GH_TOKEN, undefined);
      assert.equal(
        client.launch?.sha256,
        createHash("sha256").update("inert fixture bytes; never executed").digest("hex"),
      );
      const snapshot = path.join(capture, "snapshot.json");
      const result = session.observe("Snapshot", snapshot, app);
      assert.equal(result.application_pid, 457);
      assert.equal(result.processes.length, 2);
      assert.equal(session.readOwnedApplicationWindowTitle(application), "Portcove");
      assert.equal(client.windows, 1);
      assert.throws(() =>
        session.readOwnedApplicationWindowTitle({
          ...application,
          started_filetime: "134000000000000003",
        }),
      );
      assert.equal(client.windows, 1, "foreign creation is refused before window observation");
      assert.throws(() => session.observe("Snapshot", snapshot, app), /EEXIST/u);
      client.changed = true;
      assert.throws(() => session.observe("Observe", snapshot, app), /identity changed/u);
      client.changed = false;
      assert.throws(
        () => session.observe("StopApplication", snapshot, app),
        /owner fallback is forbidden/u,
      );
      assert.equal(client.stops, 0);
      session.observe("StopDriver", snapshot, app);
      session.observe("StopDriver", snapshot, app);
      assert.equal(client.stops, 1);
      assert.equal(client.reads, 1);
      assert.equal(view.exitCode, 125);
      assert.equal(view.signalCode, null, "broker exit must not invent a process signal");
      assert.equal(session.observe("Wait", snapshot, app).observed_processes, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
