import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAppRegistrationStore,
  createCheckpointSigningStore,
  createHostedNativeProofStore,
} from "./release-owned-capture-store.mts";

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

void test(
  "native proof custody admits the exact capture allowance and complete bounded exchange without widening other stores",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await mkdtemp(path.join(os.homedir(), ".portcove-native-proof-store-inert-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = path.join(root, "proof");
    const store = await createHostedNativeProofStore(directory);
    await store.write("capture.json", Buffer.alloc(128 * 1024 + 1));
    await assert.rejects(store.write("transition.json", Buffer.alloc(128 * 1024 + 1)), /boundary/);
    await assert.rejects(store.write("capture.json", Buffer.from("replace")), /EEXIST/);
    for (const [name, bytes] of [
      ["report.json", 65536],
      ["subject.json", 16384],
      ["bundle.json", 65536],
      ["fulcio-response.body", 65536],
      ["rekor-response.body", 65536],
      ["rekor-request.body", 65536],
      ["metadata.json", 24576],
      ["padding.json", 24576],
    ] as const)
      await store.write(name, Buffer.alloc(bytes));
    await assert.rejects(store.write("overflow.json", Buffer.from("x")), /boundary/);
    assert.equal((await readFile(path.join(directory, "capture.json"))).length, 131073);
  },
);
