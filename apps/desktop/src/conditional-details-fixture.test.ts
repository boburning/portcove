import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  conditionalDetailsFixture,
  type ConditionalDetailsConfiguration,
} from "../test/conditional-details-fixture";
import { transportValue } from "../scripts/transport-values.mts";

const configurations: ConditionalDetailsConfiguration[] = ["output", "carried-small"];
for (const configuration of configurations) {
  test(`${configuration} binds actual current catalog identities and coherent recorded state`, async () => {
    const fixture = conditionalDetailsFixture(configuration);
    try {
      const snapshot = fixture.handlers.get_workspace_snapshot({
        generation: 1,
        knownCatalogDigest: null,
      });
      assert.doesNotThrow(() => transportValue("desktop_workspace_snapshot", snapshot));
      assert.equal(snapshot.catalog.ports[0]?.id, fixture.port.id);
      assert.equal(snapshot.statuses[0]?.port_id, fixture.port.id);
      assert.equal(snapshot.statuses[0]?.active?.port_id, fixture.port.id);
      assert.equal(snapshot.statuses[0]?.active?.id, fixture.status.active?.id);
      assert.ok(snapshot.catalog.source_catalog);
      assert.ok(Array.isArray(snapshot.catalog.source_catalog.identities));
      assert.ok(Array.isArray(snapshot.catalog.source_profiles));
      if (fixture.port.source_profile) {
        assert.ok(
          snapshot.catalog.source_catalog.identities.some(
            (identity) => identity.id === fixture.port.source_profile,
          ),
        );
        assert.equal(snapshot.catalog.source_profiles[0]?.id, fixture.port.source_profile);
      } else assert.equal(snapshot.catalog.source_profiles.length, 0);
      assert.deepEqual(snapshot.sources, []);
      assert.deepEqual(snapshot.pending_setups, []);
      if (configuration === "carried-small") {
        const outcome = snapshot.statuses[0]?.carried_files?.outcome;
        assert.deepEqual(outcome?.carried, ["extra.ini"]);
        assert.equal(outcome?.carried_bytes, 20);
        assert.deepEqual(outcome?.counts, {
          carried: 1,
          removed: 0,
          kept_separately: 0,
          source_unreadable: 0,
          new_version_ships_file: 0,
        });
      }
      // A consumer cannot mutate the next read through a returned fixture object.
      snapshot.statuses.length = 0;
      assert.equal(fixture.snapshot().statuses.length, 1);
    } finally {
      await fixture.dispose();
    }
  });

  test(`${configuration} preserves current reply schemas and output suitability distinctions`, async () => {
    const fixture = conditionalDetailsFixture(configuration);
    const h = fixture.handlers;
    const args = { portId: fixture.port.id, generation: 1 };
    try {
      assert.doesNotThrow(() => transportValue("mod_setups_view", h.get_mod_setups(args)));
      assert.doesNotThrow(() =>
        transportValue("port_capability_report", h.get_port_capabilities(args)),
      );
      assert.equal(
        h.get_runtime_prerequisites({ ...args, installId: fixture.status.active!.id }),
        null,
      );
      assert.doesNotThrow(() =>
        transportValue("backup_inventory", h.get_backups({ portId: fixture.port.id })),
      );
      for (const slot of ["cover", "detail", "landscape"] as const)
        assert.doesNotThrow(() =>
          transportValue("artwork_state", h.get_artwork({ ...args, slot })),
        );
      assert.doesNotThrow(() =>
        transportValue("port_output_location", h.get_output_location(args)),
      );
      assert.equal(h.get_output_relocation_status(args), null);
      for (const mode of ["safe", "invalid", "full", "unknown"] as const) {
        fixture.setOutputMode(mode);
        for (const path of [null, "F:/Synthetic review only"]) {
          const reply = h.preview_output_location({ ...args, path });
          assert.doesNotThrow(() => transportValue("output_destination_preview", reply));
          assert.equal(reply.reset_to_default, path === null);
          assert.equal(reply.moves_existing_install, false);
          assert.equal(reply.ownership === "invalid", mode === "invalid");
          assert.equal(reply.availability === "full", mode === "full");
          assert.equal(reply.available_bytes === null, mode === "unknown");
          assert.equal(reply.affected_installs[0]?.install_id, fixture.status.active!.id);
        }
      }
      const plan = h.plan_output_relocation({ ...args, path: "F:/Synthetic relocation only" });
      assert.doesNotThrow(() => transportValue("output_relocation_plan", plan));
      assert.equal(plan.required_bytes, 0);
      assert.deepEqual(plan.installs[0]?.copy.files, []);
      assert.equal(plan.installs[0]?.copy.total_bytes, 0);
      assert.equal(plan.sources_will_move, false);
      assert.equal(plan.user_data_will_move, false);
      assert.equal(plan.backups_will_move, false);
    } finally {
      await fixture.dispose();
    }
  });
}

test("exact argument guards refuse wrong identity, generation, absent null and unexpected fields", async () => {
  const fixture = conditionalDetailsFixture("output");
  const h = fixture.handlers;
  const args = { portId: fixture.port.id, generation: 1 };
  try {
    assert.throws(() => h.get_workspace_snapshot({ generation: 1 }), /unexpected exact/);
    assert.throws(
      () => h.get_workspace_snapshot({ generation: 2, knownCatalogDigest: null }),
      /unexpected exact/,
    );
    assert.throws(() => h.get_output_location({ ...args, portId: "other" }), /unexpected exact/);
    assert.throws(() => h.get_output_location({ ...args, generation: 2 }), /unexpected exact/);
    assert.throws(() => h.get_output_location({ ...args, extra: null }), /unexpected exact/);
    assert.throws(() => h.preview_output_location(args), /Explicit output path or null/);
    assert.throws(
      () => h.set_output_location({ ...args, path: "F:/Synthetic", expectedPreview: "wrong" }),
      /unexpected exact/,
    );
    assert.deepEqual(fixture.pending(), []);
    for (let count = 0; count < 2; count++)
      assert.equal(
        h.get_runtime_prerequisites({ ...args, installId: fixture.status.active!.id }),
        null,
      );
    assert.deepEqual(fixture.pending(), []);
    assert.throws(() => fixture.forbidden("relocateOutput"), /Unpermitted real-effect/);
    assert.deepEqual(fixture.forbiddenCalls, ["relocateOutput"]);
  } finally {
    await fixture.dispose();
  }
});

test("future apply remains pending until explicit refusal and cleanup joins an interrupted reset", async () => {
  const fixture = conditionalDetailsFixture("output");
  const args = { portId: fixture.port.id, generation: 1, expectedPreview: "a".repeat(64) };
  try {
    const pending = fixture.handlers.set_output_location({
      ...args,
      path: "F:/Synthetic future only",
    });
    const rejected = assert.rejects(pending, /Synthetic future-folder setting refused/);
    assert.deepEqual(fixture.pending(), ["output-apply"]);
    assert.throws(() => fixture.handlers.reset_output_location(args), /Duplicate pending/);
    fixture.releaseApply();
    await rejected;
    assert.deepEqual(fixture.pending(), []);
    assert.throws(fixture.releaseApply, /No held output apply/);
  } finally {
    await fixture.dispose();
  }
  const interrupted = conditionalDetailsFixture("output");
  const pending = interrupted.handlers.reset_output_location(args);
  const rejected = assert.rejects(pending, /Synthetic reset refused/);
  await interrupted.dispose();
  await rejected;
  assert.deepEqual(interrupted.pending(), []);
  await interrupted.dispose();
});
