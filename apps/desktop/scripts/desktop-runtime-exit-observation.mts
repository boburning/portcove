import assert from "node:assert/strict";
import type { LaunchSessionRecord } from "../src/transport-types.generated.d.ts";
import type { NativeSessionObservations } from "./desktop-owned-native-session.mts";

export async function observeRegisteredRuntimeExit({
  session,
  snapshot,
  native,
  wait,
  route,
}: {
  session: LaunchSessionRecord;
  snapshot: string;
  native: <Mode extends "Observe" | "Wait">(
    mode: Mode,
    snapshot: string,
  ) => NativeSessionObservations[Mode];
  wait: (observe: () => boolean, timeout: number) => Promise<boolean>;
  route: Record<string, unknown>;
}) {
  const exited = await wait(() => {
    const observation = native("Observe", snapshot);
    route.last_operator_exit_observation = observation;
    const game = observation.processes.find((entry) => entry.pid === session.child_pid);
    assert.ok(game);
    assert.equal(`windows-filetime:${game.started_filetime}`, session.child_identity);
    return game.state === "exited";
  }, 300_000);
  assert.equal(exited, true);
  route.observed_game_exit = native("Wait", snapshot);
}
