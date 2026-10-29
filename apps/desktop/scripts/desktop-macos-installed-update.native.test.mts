import assert from "node:assert/strict";
import test from "node:test";
import { runDesktopModuleFixture } from "../../../scripts/fixtures/desktop-module-fixture.mts";
type Harness = typeof import("./desktop-installed-update-harness.mts");
type Dependencies = Parameters<Harness["createMacInstalledProcessCleanup"]>[1];
const app = "/Applications/Portcove.app/Contents/MacOS/portcove";
function unexpected(): never {
  throw new Error("Unexpected process boundary call");
}
function cleanup(subject: Harness, overrides: Partial<Dependencies>) {
  return subject.createMacInstalledProcessCleanup(app, {
    processIdentity: unexpected,
    matchingChildIdentity: unexpected,
    childPids: unexpected,
    signal: unexpected,
    waitFor: unexpected,
    ...overrides,
  });
}
function identity(started = "exact-start") {
  return { pid: 42, started, command: "owned helper", state: "T" };
}
// Deliberately malformed foreign/subprocess failures retain their exact identity.
function raiseBoundaryFailure(failure: unknown): never {
  throw failure;
}

function runContract(contract: (subject: Harness) => Promise<void> | void) {
  runDesktopModuleFixture(
    new URL("./desktop-installed-update-harness.mts", import.meta.url),
    `
    const app=${JSON.stringify(app)};
    const unexpected=${unexpected.toString()};
    const cleanup=${cleanup.toString()};
    const identity=${identity.toString()};
    const raiseBoundaryFailure=${raiseBoundaryFailure.toString()};
    const subject=await import(entry);
    try { await (${contract.toString()})(subject); }
    catch(error) {
      if(error?.code==='ERR_ASSERTION')console.error('MAC_CONTRACT_ASSERTION '+error.message);
      throw error;
    }
    `,
  );
}

void test("macOS frozen child capture retains exact first failure after mandatory process cleanup", () =>
  runContract(async (subject) => {
    for (const primary of [undefined, null, false, 0, "", new Error("primary capture error")]) {
      for (const cleanupFails of [false, true]) {
        const signals: [number, string][] = [];
        let waits = 0;
        const owner = cleanup(subject, {
          processIdentity: () => identity(),
          signal: (pid, signal) => {
            signals.push([pid, signal]);
          },
          waitFor: async () => {
            waits += 1;
            if (waits === 1) return Promise.reject(primary);
            if (cleanupFails) throw new Error("secondary cleanup error");
            return true;
          },
        });
        await assert.rejects(
          async () => {
            await owner.freezeCaptureAndStop(42, "helper", "candidate");
          },
          (error: unknown) => Object.is(error, primary),
        );
        assert.deepEqual(
          signals,
          [
            [42, "SIGSTOP"],
            [42, "SIGKILL"],
          ],
          "Mac capture must force stop in finally",
        );
        assert.equal(waits, 2);
      }
    }
    for (const cleanupFailure of [undefined, null, false, 0, ""]) {
      let waits = 0;
      const owner = cleanup(subject, {
        processIdentity: () => identity(),
        signal: () => {},
        childPids: () => [],
        matchingChildIdentity: () => null,
        waitFor: async () => {
          waits += 1;
          if (waits === 2) return Promise.reject(cleanupFailure);
          return true;
        },
      });
      await assert.rejects(
        async () => {
          await owner.freezeCaptureAndStop(42, "helper", "candidate");
        },
        (error: unknown) => Object.is(error, cleanupFailure),
      );
      assert.equal(waits, 2);
    }
  }));

void test("macOS owned cleanup refuses foreign markers and never signals a changed start identity", () =>
  runContract(async (subject) => {
    const marker = { schema_version: 1, process_id: 42, executable: app };
    for (const input of [
      null,
      undefined,
      false,
      0,
      "",
      { ...marker, executable: "/foreign/app" },
      { ...marker, schema_version: 2 },
    ]) {
      let actions = 0;
      const owner = cleanup(subject, {
        processIdentity: () => {
          actions += 1;
          throw Error("must not inspect foreign process");
        },
        signal: () => {
          actions += 1;
        },
      });
      await owner.stopOwned(input, "candidate");
      assert.equal(actions, 0);
    }
    for (const process_id of [0, -1, 1.5, "42", null]) {
      let actions = 0;
      const owner = cleanup(subject, {
        processIdentity: () => {
          actions += 1;
          return null;
        },
        signal: () => {
          actions += 1;
        },
      });
      await assert.rejects(
        owner.stopOwned({ ...marker, process_id }, "candidate"),
        /Invalid owned process marker PID/u,
      );
      assert.equal(actions, 0);
      assert.throws(() => owner.positivePid(process_id), /Invalid owned process marker PID/u);
    }
    const signals: [number, string][] = [];
    let observations = 0;
    const owner = cleanup(subject, {
      processIdentity: () => identity(observations++ === 0 ? "owned-start" : "replacement-start"),
      signal: (pid, signal) => {
        signals.push([pid, signal]);
      },
      waitFor: async (predicate) => {
        if (observations === 1) throw Error("cleanup wait expired");
        if (!(await predicate())) throw Error("replacement process remains live");
        return true;
      },
    });
    await assert.rejects(owner.stopOwned(marker, "candidate"), /replacement process remains live/u);
    assert.deepEqual(signals, [[42, "SIGTERM"]], "Mac changed-start custody rejects forced kill");
  }));

void test("macOS capture freezes before child observation and drains the exact owner", () =>
  runContract(async (subject) => {
    const order: string[] = [];
    let live = true;
    const child = { ...identity("child-start"), pid: 43 };
    const owner = cleanup(subject, {
      processIdentity: (pid, role) => {
        assert.equal(pid, 42);
        assert.equal(role, "helper");
        return live ? identity() : null;
      },
      signal: (pid, signal) => {
        assert.equal(pid, 42);
        order.push(signal);
        if (signal === "SIGKILL") live = false;
      },
      childPids: (pid) => {
        assert.equal(pid, 42);
        order.push("children");
        return [43, 44];
      },
      matchingChildIdentity: (pid, role) => {
        assert.equal(role, "candidate");
        order.push("match:" + pid);
        return pid === 43 ? child : null;
      },
      waitFor: async (read, label, timeout) => {
        assert.equal(timeout, 5000);
        order.push(label);
        assert.equal(await read(), true);
        return true;
      },
    });
    assert.deepEqual(await owner.freezeCaptureAndStop(42, "helper", "candidate"), [child]);
    assert.deepEqual(order, [
      "SIGSTOP",
      "helper stopped for child capture",
      "children",
      "match:43",
      "match:44",
      "SIGKILL",
      "helper forced exit",
    ]);
    assert.equal(live, false);
  }));

void test("macOS process inspection treats only subprocess status one as an absent process", () =>
  runContract((subject) => {
    for (const field of ["lstart", "command", "stat"] as const) {
      assert.equal(
        subject.readMacInstalledProcessField(42, field, (command, args, options) => {
          assert.equal(command, "/bin/ps");
          assert.deepEqual(args, ["-ww", "-p", "42", "-o", `${field}=`]);
          assert.deepEqual(options, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
          return "  retained observation  ";
        }),
        "retained observation",
      );
    }
    for (const failure of [
      undefined,
      null,
      false,
      0,
      "",
      { status: 2 },
      { status: 1 },
      Object.assign(new Error("absent"), { status: 1 }),
    ]) {
      const invoke = (): unknown =>
        subject.readMacInstalledProcessField(42, "lstart", () => raiseBoundaryFailure(failure));
      if (
        failure !== null &&
        typeof failure === "object" &&
        "status" in failure &&
        failure.status === 1
      )
        assert.equal(invoke(), null);
      else assert.throws(invoke, (error: unknown) => Object.is(error, failure));
    }
  }));
