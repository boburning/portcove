import assert from "node:assert/strict";
import test from "node:test";
import { restartedNativePreparation } from "./container-recovery.mts";

function fixture() {
  const run = "11111111-1111-4111-8111-111111111111";
  const host = {
    observed_at: "2026-10-17T18:24:18Z",
    desktop: { Status: "running", SessionID: run },
    engine: { os: "linux", kernel: "microsoft-standard-WSL2" },
    disk: { physical: "E:\\Docker\\data.vhdx" },
  };
  return {
    state: {
      run,
      tool: "build-v1",
      build_name: `portcove-build-${run}`,
      created_at: "2026-10-17T18:24:19Z",
      status: "incomplete",
      error: "export deadline",
      execution_status: null,
      export_complete: false,
      capacity_phase: "image-build",
      host,
      source: { commit: "a".repeat(40), tree: "b".repeat(40) },
      failed_command: {
        command: "docker",
        status: 100,
        args: [
          "--context",
          "desktop-linux",
          "build",
          `BUILDKIT_BUILD_NAME=portcove-build-${run}`,
          `SOURCE_COMMIT=${"a".repeat(40)}`,
          `SOURCE_TREE=${"b".repeat(40)}`,
        ],
      },
    },
    observation: {
      ...host,
      observed_at: "2026-10-17T19:12:00Z",
      desktop: { ...host.desktop, SessionID: "22222222-2222-4222-8222-222222222222" },
    },
    dispatch: '#0 building with "desktop-linux" instance using docker driver\n',
    terminal: [{ at: "2026-10-17T18:57:17Z", status: "incomplete", export_complete: false }],
    lifecycle: [
      {
        component: "init",
        level: "info",
        msg: "dockerd stopped gracefully after 25.913211ms",
        time: "2026-10-17T19:09:01.516795542Z",
      },
      {
        component: "init",
        level: "info",
        msg: 'starting /bin/sh -c export LISTEN_PID="$$"; exec /usr/local/bin/dockerd --config-file /run/config/docker/daemon.json',
        time: "2026-10-17T19:09:22.241201504Z",
      },
    ],
  };
}
void test("native daemon replacement after terminal failure proves only quiescence", () => {
  const input = fixture(),
    before = JSON.stringify(input.state);
  const proof = restartedNativePreparation(input);
  assert.equal(proof?.kind, "native-daemon-restarted");
  assert.equal(proof?.run, input.state.run);
  assert.equal(JSON.stringify(input.state), before);
});
void test("unknown, live, foreign and insufficient restart evidence stays blocked", () => {
  const mutations: Array<(input: ReturnType<typeof fixture>) => void> = [
    (x) => {
      x.dispatch = `unrelated first line\n${x.dispatch}`;
    },
    (x) => {
      x.state.tool = "invalid";
      x.state.build_name = `invalid-${x.state.run}`;
      x.state.failed_command.args[3] = `BUILDKIT_BUILD_NAME=${x.state.build_name}`;
    },
    (x) => {
      x.state.status = "passed";
    },
    (x) => {
      x.state.capacity_phase = "container-start";
    },
    (x) => {
      Object.assign(x.state, { container: "runtime" });
    },
    (x) => {
      x.state.failed_command.status = 0;
    },
    (x) => {
      x.state.failed_command.command = "other";
    },
    (x) => {
      x.state.failed_command.args[1] = "remote";
    },
    (x) => {
      x.state.failed_command.args.pop();
    },
    (x) => {
      x.state.build_name = "foreign";
    },
    (x) => {
      x.dispatch = x.dispatch.replace("docker driver", "docker-container driver");
    },
    (x) => {
      x.dispatch += x.dispatch;
    },
    (x) => {
      x.lifecycle = [];
    },
    (x) => {
      x.observation.desktop.SessionID = x.state.host.desktop.SessionID;
    },
    (x) => {
      x.observation.disk = { physical: "D:\\different.vhdx" };
    },
    (x) => {
      x.observation.engine.os = "remote";
    },
    (x) => {
      x.observation.engine.kernel = "linux";
    },
    (x) => {
      x.terminal = [];
    },
    (x) => {
      x.terminal.push(x.terminal[0]!);
    },
    (x) => {
      x.terminal[0]!.at = "invalid";
    },
    (x) => {
      x.lifecycle[0]!.time = "2026-10-17T18:30:00Z";
    }, // Restart before failure cannot stop this build.
    (x) => {
      x.lifecycle[1]!.time = "2026-10-17T19:09:00Z";
    },
    (x) => {
      x.lifecycle[1]!.time = "2026-10-17T19:13:00Z";
    },
    (x) => {
      x.lifecycle[0]!.msg = "someone says dockerd stopped gracefully after 1s";
    },
    (x) => {
      x.lifecycle[0]!.component = "unrelated";
    },
    (x) => {
      x.lifecycle[1]!.msg += "; echo fake";
    },
    (x) => {
      x.lifecycle.push({ ...x.lifecycle[0]!, time: "2026-10-17T19:10:00Z" });
    },
  ];
  for (const mutate of mutations) {
    const input = fixture();
    mutate(input);
    assert.equal(restartedNativePreparation(input), null, mutate.toString());
  }
});
