import assert from "node:assert/strict";
import test from "node:test";
import { OwnedNativeSession } from "../apps/desktop/scripts/desktop-owned-native-session.mjs";

test("replacement identity failure cannot reuse the former host's exit receipt", () => {
  const session = new OwnedNativeSession();
  session.driver = { pid: 1 };
  session.inventory = "former-host-inventory";
  session.cleanup = { exited: { observed_processes: 3 } };
  const previous = session.requireQuiescence();
  session.beginLaunch(); // Called before spawning the replacement.
  // Spawn succeeded; its subsequent identity capture failed.
  assert.equal(session.cleanup, undefined, "Final cleanup cannot take an old-success shortcut");
  assert.equal(session.inventory, undefined);
  assert.throws(() => session.requireQuiescence(), /Current owned launch identity/);
  assert.equal(previous.exited.observed_processes, 3, "Former receipt stays preserved separately");
  session.driver = { pid: 2 };
  assert.throws(() => session.requireQuiescence(), /Current owned exit inventory/);
  session.inventory = "replacement-host-inventory";
  assert.throws(() => session.requireQuiescence(), /Positive current owned/);
  session.cleanup = { exited: { observed_processes: 4 } };
  assert.equal(session.requireQuiescence().exited.observed_processes, 4);
});
