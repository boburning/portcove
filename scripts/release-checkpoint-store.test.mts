import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAppRegistrationStore,
  createCheckpointSigningStore,
} from "./release-app-registration-capture.mts";

for (const checkpoint of [false, true]) {
  void test(
    `native Linux ${checkpoint ? "checkpoint" : "App"} custody keeps ordinary file/storage limits`,
    { skip: process.platform !== "linux" },
    async (t) => {
      const root = await mkdtemp(path.join(os.homedir(), ".portcove-checkpoint-store-inert-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const store = await (checkpoint ? createCheckpointSigningStore : createAppRegistrationStore)(
        path.join(root, "capture"),
      );
      await assert.rejects(store.write("arbitrary.json", Buffer.alloc(128 * 1024 + 1)), /boundary/);
      await assert.rejects(store.write("transition.body", Buffer.alloc(1024 * 1024)), /boundary/);
      if (checkpoint) {
        await store.write("transition.json", Buffer.alloc(1024 * 1024, 97));
        assert.equal(
          (await readFile(path.join(root, "capture", "transition.json"))).length,
          1024 * 1024,
        );
        await assert.rejects(store.write("transition.json", Buffer.from("replace")), /EEXIST/);
      } else
        await assert.rejects(store.write("transition.json", Buffer.alloc(1024 * 1024)), /boundary/);
      for (const name of ["first.json", "second.json", "third.json"])
        await store.write(name, Buffer.alloc(128 * 1024));
      await assert.rejects(store.write("fourth.json", Buffer.from("x")), /boundary/);
    },
  );
}
