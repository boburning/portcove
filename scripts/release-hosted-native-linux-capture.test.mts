import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import { runPythonSuite } from "./python-test-results.mts";
import { hostedNativeProofFixture } from "./fixtures/hosted-native-proof-fixture.mts";
import { prepareHostedNativeStageRequest } from "./release-native-stage-capture.mts";
import { isRecord } from "./runtime-values.mts";
import {
  hostedLinuxCaptureLifetime,
  captureActualHostedNativeLinuxInvocation,
  requireActualHostedNativeLinuxCapture,
} from "./release-hosted-native-linux-capture.mts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
void test("original hosted lifetime reserves recovery and rejects exhausted or renewed bounds", () => {
  const wall = Date.parse("2026-10-24T12:00:00.000Z");
  const prepared = hostedLinuxCaptureLifetime(1000000, 1000, wall);
  assert.equal(prepared.timeout_seconds, 819);
  assert.equal(prepared.deadline_utc, new Date(wall + 969000).toISOString());
  for (const deadline of [NaN, Infinity, 0, 241000, 2000000])
    assert.throws(() => hostedLinuxCaptureLifetime(deadline, 1000, wall));
});
void test("copied/imported requests and captures cannot create a child or private provenance", async () => {
  const request = Object.freeze({ kind: "hosted-native-linux-request", authority: "none" });
  await assert.rejects(
    captureActualHostedNativeLinuxInvocation(request),
    /original active hosted Linux request/u,
  );
  await assert.rejects(
    captureActualHostedNativeLinuxInvocation(request),
    /one original Linux capture/u,
  );
  await assert.rejects(
    requireActualHostedNativeLinuxCapture({ kind: "actual-hosted-linux-capture" }),
    /original active hosted Linux capture/u,
  );
});
void test("fixed inventory code tests actual bounded readers without sudo or candidate execution", (context) => {
  runPythonSuite(
    new URL("./release-hosted-native-linux-capture.test.py", import.meta.url),
    context,
    30000,
  );
});

for (const captureStage of ["payload-signing", "release-publication"] as const)
  void test(
    `default original-request ${captureStage} capture composition preserves identity, refusal, lifetime and byte custody`,
    { skip: process.platform !== "linux" },
    async (t) => {
      // Private builtin/module substitution only in this test process. No public
      // factory dependency injection, real issuer, sudo, account or candidate.
      const filesystem = await import("node:fs/promises");
      const scheduler = await import("./release-native-scheduler.mts");
      const resource = await import("./resource-command.mts");
      const child = await import("node:child_process");
      const { PassThrough } = await import("node:stream");
      const { EventEmitter } = await import("node:events");
      const realTimer = setTimeout;
      t.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) =>
        realTimer(callback, [1000, 3000, 20000].includes(delay) ? 20 : delay),
      );
      const fixture = hostedNativeProofFixture("linux-x86_64", captureStage);
      fixture.host.account.broker = String(process.getuid!());
      fixture.host.account.qualification = String(process.getuid!() + 5000);
      const qualification = Number(fixture.host.account.qualification);
      const prepared = prepareHostedNativeStageRequest(
        fixture.request,
        fixture.authorities,
        fixture.host,
      );
      const parentReceipt = Object.freeze({ fixture: "parent" });
      type State = {
        request: object;
        actual: object;
        parent: object;
        directory: string;
        fault: string;
        probes: number;
        runs: number;
        expired: boolean;
        checks: number;
        released: number;
      };
      let state: State;
      const now = performance.now.bind(performance);
      const check = () => {
        state.checks++;
        if (state.expired) throw new Error("original parent expired");
      };
      t.mock.module("./release-hosted-native-linux-request.mts", {
        namedExports: {
          requireActualHostedNativeLinuxRequest: async (receipt: object) => {
            assert.equal(receipt, state.request);
            check();
            return state.actual;
          },
        },
      });
      t.mock.module("./release-hosted-native-parent.mts", {
        namedExports: {
          requireActualHostedNativeParentSource: async (receipt: object) => {
            assert.equal(receipt, parentReceipt);
            check();
            return state.parent;
          },
        },
      });
      t.mock.module("node:fs/promises", {
        namedExports: {
          ...filesystem,
          realpath: async (filename: string) =>
            filename === process.execPath ? "/broker-only/runtime/node" : filename,
          lstat: async (filename: string) =>
            filename.startsWith("/broker-only")
              ? {
                  uid: process.getuid!() + (state.fault === "node-custody" ? 1 : 0),
                  mode: state.fault === "node-writable" ? 0o100777 : 0o100755,
                  isSymbolicLink: () => false,
                }
              : filename === "/" || filename.startsWith("/usr/") || filename === "/usr"
                ? { uid: 0, mode: 0o100755, isSymbolicLink: () => false }
                : filesystem.lstat(filename),
        },
      });
      t.mock.module("./release-native-scheduler.mts", {
        namedExports: { ...scheduler, readNativeSchedulerToolDigest: async () => "e".repeat(64) },
      });
      const fixed = {
        python: "/usr/bin/python3",
        git: "/usr/bin/git",
        bwrap: "/usr/bin/bwrap",
        systemd_run: "/usr/bin/systemd-run",
        systemctl: "/usr/bin/systemctl",
        node: "/home/portcove-native/portcove-native/tools/node",
        driver: "/home/portcove-native/portcove-native/tools/tauri-driver",
        webkit_driver: "/usr/bin/WebKitWebDriver",
        xvfb: "/usr/bin/Xvfb",
      };
      t.mock.module("node:child_process", {
        namedExports: {
          ...child,
          spawn: (command: string, args: string[], options: { env: object; stdio: string[] }) => {
            state.probes++;
            assert.equal(command, "/usr/bin/sudo");
            assert.deepEqual(args.slice(0, 6), [
              "-n",
              "-H",
              "-u",
              "portcove-native",
              "--",
              "/usr/bin/python3",
            ]);
            assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "LANG", "PATH"]);
            assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
            const expected = prepared.request.expected.producer;
            assert.deepEqual(args.slice(-4), [
              expected.source_commit,
              expected.source_tree,
              expected.harness.path,
              expected.harness.sha256,
            ]);
            class InventoryChild extends EventEmitter {
              stdout = new PassThrough();
              stderr = new PassThrough();
              kill() {
                if (state.fault !== "inventory-nonclosing")
                  queueMicrotask(() => {
                    this.stdout.end();
                    this.stderr.end();
                    this.emit("close", 1);
                  });
                return true;
              }
            }
            const original = new InventoryChild();
            queueMicrotask(() => {
              if (state.fault === "inventory-nonclosing") return;
              if (state.fault === "inventory-overflow") {
                original.stdout.write(Buffer.alloc(65537));
                return;
              }
              if (state.fault === "inventory-refusal") {
                original.stdout.end();
                original.stderr.end("fixed inventory refused");
                original.emit("close", 1);
                return;
              }
              original.stdout.end(
                Buffer.from(
                  JSON.stringify({
                    schema_version: 1,
                    authority: "none",
                    children_settled: true,
                    source_commit: expected.source_commit,
                    source_tree:
                      state.fault === "wrong-source" ? "9".repeat(40) : expected.source_tree,
                    uid: Number(fixture.host.account.qualification),
                    gid: qualification,
                    source_pins: {
                      ...Object.fromEntries(
                        ["supervisor", "support", "driver", "transfer", "init"].map((name) => [
                          name,
                          "e".repeat(64),
                        ]),
                      ),
                      harness: expected.harness.sha256,
                    },
                    tools: Object.fromEntries(
                      Object.entries(fixed).map(([name, filename]) => [
                        name,
                        { path: filename, sha256: "e".repeat(64) },
                      ]),
                    ),
                  }),
                ),
              );
              original.stderr.end();
              original.emit("close", 0);
            });
            return original;
          },
        },
      });
      type Lease = { release: () => Promise<void> };
      type Guard = { acquireLock: (metadata: unknown, admission: unknown) => Promise<Lease> };
      const rust = await import("./run-rust-tests.mts");
      t.mock.module("./run-rust-tests.mts", {
        namedExports: {
          ...rust,
          runRustTests: async (_args: string[], options: Guard) => {
            const lease = await options.acquireLock({}, {});
            await lease.release();
            return 0;
          },
        },
      });
      t.mock.module("./resource-command.mts", {
        namedExports: {
          ...resource,
          runResourceCommand: async (
            _profile: string,
            executable: string,
            args: string[],
            options: {
              environment: object;
              queueDeadline: number;
              supervise: (args: string[], options: Guard) => Promise<number>;
            },
          ) => {
            assert.equal(executable, process.execPath);
            assert.equal(
              args[0],
              fileURLToPath(new URL("./release-hosted-native-linux-driver.mts", import.meta.url)),
            );
            assert.deepEqual(Object.keys(options.environment).sort(), [
              "HOME",
              "LANG",
              "PATH",
              "TMPDIR",
            ]);
            assert.ok(options.queueDeadline > now());
            if (state.fault === "admission-expiry") state.expired = true;
            await options.supervise([], {
              acquireLock: async () => ({
                release: async () => {
                  state.released++;
                },
              }),
            });
            state.runs++;
            const outer = await readFile(path.join(state.directory, "native-request.json"));
            const plan: unknown = JSON.parse(
              await readFile(path.join(state.directory, "native-plan.json"), "utf8"),
            );
            const invocation = prepared.request.invocation_id;
            assert.ok(
              isRecord(plan) &&
                isRecord(plan.binding) &&
                isRecord(plan.binding.controller) &&
                isRecord(plan.binding.application),
            );
            assert.equal(
              plan.binding.controller.source_commit,
              prepared.request.expected.producer.source_commit,
            );
            assert.equal(plan.binding.application.filename, undefined);
            const host = {
              ...fixture.host,
              schema_version: 1,
              invocation_id: invocation,
              qualification_uid: Number(fixture.host.account.qualification),
              qualification_gid: qualification,
              os_release: 'ID=ubuntu\nVERSION_ID="24.04"\n',
              kernel_release: "6.8.0-fixture",
              architecture: "x86_64",
              authority: "none",
            };
            // Only the host transport fields, not projection/account metadata.
            const hostBytes = Buffer.from(
              JSON.stringify(
                Object.fromEntries(
                  Object.entries(host).filter(
                    ([key]) => !["account", "qualification_profile"].includes(key),
                  ),
                ),
              ),
            );
            for (const side of ["before", "after"])
              await writeFile(path.join(state.directory, `host-${side}.stdout.bin`), hostBytes);
            const data = Buffer.from("inert retained observation\n");
            const wire = Buffer.concat([
              Buffer.from(
                JSON.stringify({
                  schema_version: 1,
                  invocation_id: invocation,
                  path: "fixture.json",
                  bytes: data.length,
                  sha256: hash(data),
                }) + "\n",
              ),
              data,
              Buffer.from(
                JSON.stringify({
                  schema_version: 1,
                  invocation_id: invocation,
                  complete: true,
                  count: 1,
                  authority: "none",
                }) + "\n",
              ),
            ]);
            await writeFile(path.join(state.directory, "native-capture.stdout.bin"), wire);
            await writeFile(
              path.join(state.directory, "hosted-linux-capture-summary.json"),
              JSON.stringify({
                schema_version: 1,
                invocation_id: invocation,
                request_sha256: hash(outer),
                stage_request_sha256: prepared.request_sha256,
                operation_children_settled: true,
                status: state.fault === "failed-but-settled" ? 1 : 0,
                failure: state.fault === "failed-but-settled" ? "actual fixture failure" : null,
                readback: {
                  invocation_id: state.fault === "wrong-readback" ? "9".repeat(64) : invocation,
                  request_sha256: hash(outer),
                  cgroup_empty: state.fault !== "ambiguous",
                  unit_settled: true,
                },
                host_before_sha256: hash(hostBytes),
                host_after_sha256: hash(hostBytes),
                capture_wire: path.join(state.directory, "native-capture.stdout.bin"),
              }),
            );
            if (state.fault === "expiry") state.expired = true;
            return 0;
          },
        },
      });
      const module = (await import(
        `./release-hosted-native-linux-capture.mts?composition=${Date.now()}`
      )) as typeof import("./release-hosted-native-linux-capture.mts");
      for (const fault of [
        "none",
        "failed-but-settled",
        "inventory-refusal",
        "inventory-overflow",
        "inventory-nonclosing",
        "node-custody",
        "node-writable",
        "admission-expiry",
        "wrong-source",
        "wrong-readback",
        "ambiguous",
        "expiry",
      ])
        await t.test(fault, async (context) => {
          const directory = disposableDirectory(
            context,
            path.join(os.tmpdir(), "hosted-capture-composition-"),
          );
          await mkdir(directory, { recursive: true });
          const request = Object.freeze({ fixture: fault });
          state = {
            request,
            directory,
            fault,
            probes: 0,
            runs: 0,
            expired: false,
            checks: 0,
            released: 0,
            actual: {
              directory,
              package_path: path.join(directory, "package.bin"),
              predecessor:
                captureStage === "release-publication" &&
                fixture.report.journey &&
                "predecessor" in fixture.report.journey
                  ? {
                      path: path.join(directory, "predecessor.bin"),
                      ...fixture.report.journey.predecessor.package,
                      version: "0.0.1",
                    }
                  : null,
              payload_crypto:
                captureStage === "release-publication" && fixture.report.journey
                  ? {
                      file: "native-payload-result.json",
                      sha256: "1".repeat(64),
                      signed_context_sha256: fixture.report.journey.signed_context_sha256,
                      signatures_sha256: fixture.report.journey.signatures_sha256,
                    }
                  : null,
              parent_source: parentReceipt,
              prepared,
              host: {
                projection: fixture.host,
                observed: {
                  qualification_gid: qualification,
                  machine_id_sha256: fixture.host.machine_id_sha256,
                },
              },
            },
            parent: {
              stage: captureStage,
              platform_label: "linux-x86_64",
              deadline: now() + 1000000,
              producer: { controller_revision: "7".repeat(40) },
              configuration: fixture.authorities,
              recheck: check,
            },
          };
          // Real runner UID is independently observed; use that in the fixture projection.
          const actual = state.actual as { host: { projection: { account: { broker: string } } } };
          actual.host = structuredClone(actual.host);
          actual.host.projection.account.broker = String(process.getuid!());
          const pending = module.captureActualHostedNativeLinuxInvocation(request);
          await assert.rejects(
            module.captureActualHostedNativeLinuxInvocation(request),
            /one original Linux capture/u,
          );
          if (!["none", "failed-but-settled"].includes(fault)) {
            await assert.rejects(pending, /hosted Linux capture refused/u);
            assert.ok(
              (await readFile(path.join(directory, "hosted-linux-capture-refusal.json"))).length >
                0,
            );
            if (
              fault.startsWith("inventory-") ||
              fault.startsWith("node-") ||
              fault === "wrong-source" ||
              fault === "admission-expiry"
            )
              assert.equal(state.runs, 0);
            else
              assert.equal(
                state.runs,
                1,
                "the intended post-launch refusal must actually be reached",
              );
          } else {
            const receipt = await pending;
            const captured = await module.requireActualHostedNativeLinuxCapture(receipt);
            assert.equal(captured.authority, "none");
            assert.equal(captured.native_acceptance, "not-established");
            assert.equal(captured.retained_capture?.entries.length, 1);
            await writeFile(path.join(directory, "native-capture/fixture.json"), "changed");
            await assert.rejects(module.requireActualHostedNativeLinuxCapture(receipt));
            await assert.rejects(
              module.requireActualHostedNativeLinuxCapture(receipt),
              /original active hosted Linux capture/u,
            );
          }
          assert.equal(state.probes, fault.startsWith("node-") ? 0 : 1);
          await assert.rejects(
            module.captureActualHostedNativeLinuxInvocation(request),
            /one original Linux capture/u,
          );
          assert.ok(state.runs <= 1);
          if (state.runs === 1 || fault === "admission-expiry") assert.equal(state.released, 1);
        });
    },
  );
