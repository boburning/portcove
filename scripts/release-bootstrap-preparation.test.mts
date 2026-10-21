import assert from "node:assert/strict";
import test from "node:test";
import { inspectPublicationAuthorities } from "./release-authority-configuration.mts";

function publication() {
  const pin = (path: string) => ({ path, bytes: 123, sha256: "a".repeat(64) });
  return {
    public_source: {
      commit: "b".repeat(40),
      root: pin("public/root.json"),
      offline_targets: pin("public/targets.json"),
      payload_key_registry: pin("public/payload.json"),
      initial_site_preimage: { ...pin("public/initial-site.json"), sha256: "d".repeat(64) },
    },
    setup_plan_sha256: "c".repeat(64),
    initial_site_preimage_sha256: "d".repeat(64),
  };
}
void test("only schema2 can locate the exact historical owner-ratified setup preimage", () => {
  const value = publication();
  assert.deepEqual(inspectPublicationAuthorities(value, 2), value);
  assert.throws(() => inspectPublicationAuthorities(value), /schema2/);
  assert.throws(() => inspectPublicationAuthorities(value, 1), /schema2/);
  for (const pin of [
    { ...value.public_source.initial_site_preimage, sha256: "0".repeat(64) },
    { ...value.public_source.initial_site_preimage, path: value.public_source.root.path },
    { ...value.public_source.initial_site_preimage, path: "../initial.json" },
    { ...value.public_source.initial_site_preimage, bytes: 1048577 },
  ])
    assert.throws(() =>
      inspectPublicationAuthorities(
        { ...value, public_source: { ...value.public_source, initial_site_preimage: pin } },
        2,
      ),
    );
  const { initial_site_preimage: _initial, ...oldSource } = value.public_source;
  const legacy = { ...value, public_source: oldSource };
  assert.deepEqual(inspectPublicationAuthorities(legacy), legacy);
  assert.deepEqual(inspectPublicationAuthorities(legacy, 2), legacy);
});
