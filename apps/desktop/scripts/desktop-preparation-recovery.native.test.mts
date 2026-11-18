import test from "node:test";
import { runDesktopModuleFixture } from "../../../scripts/fixtures/desktop-module-fixture.mts";

void test("recovery evidence retains the asserted scope and hashes a large full workspace without embedding its catalog", () => {
  runDesktopModuleFixture(
    new URL("./desktop-preparation-recovery-test.mts", import.meta.url),
    `
      import {createHash} from 'node:crypto';
      const {preparationWorkspaceEvidence: project} = await import(entry);
      const {portStatus} = await import(new URL('../src/test-fixtures.ts', entry));
      const bootstrap = {ready:true, error:null, generation:7, library_root:'owned-library',
        selection:{root:'owned-library', source:'saved'}};
      const status = {...portStatus(), port_id:'opengoal-jak3'};
      const activity = {id:'owned-operation', target_id:status.port_id, target_kind:'port',
        operation:'prepare', status:'succeeded', started_at:1, finished_at:2,
        cancellation:null, failure:null, message:'owned completion'};
      const workspace = {
        catalog:{schema_version:1, ports:[], unrelated_catalog_fixture:'é'.repeat(7 * 1024 * 1024)},
        statuses:[status, {...status, port_id:'unrelated-port'}], sources:[],
        activities:{records:[activity, {...activity, id:'unrelated-operation'}],
          current_activity_ids:[], attention_required_activity_ids:[], recovery_required_activity_ids:[],
          active_and_actionable_complete:true, terminal_history_complete:true,
          terminal_history_count:2, terminal_history_limit:50},
      };
      const full = JSON.stringify(workspace);
      assert.ok(Buffer.byteLength(full) > 12 * 1024 * 1024);
      const report = project(bootstrap, workspace, status, activity);
      assert.equal(report.report_kind, 'asserted-preparation-workspace-projection');
      assert.equal(report.bootstrap, bootstrap);
      assert.equal(report.bootstrap.generation, 7);
      assert.equal(report.bootstrap.library_root, 'owned-library');
      assert.equal(report.port_id, status.port_id);
      assert.equal(report.operation_id, activity.id);
      assert.equal(report.status, status);
      assert.equal(report.activity, activity);
      assert.equal(report.full_snapshot.sha256, createHash('sha256').update(full).digest('hex'));
      assert.equal(report.full_snapshot.json_bytes, Buffer.byteLength(full));
      assert.notEqual(report.full_snapshot.json_bytes, full.length, 'hash and count UTF-8 bytes');
      assert.match(report.full_snapshot.representation, /full validated workspace, not raw wire bytes/);
      const retained = JSON.stringify(report);
      assert.ok(Buffer.byteLength(retained) < 16 * 1024, 'retain a bounded report, not the unrelated catalog');
      assert.ok(!retained.includes('unrelated_catalog_fixture'));
      assert.ok(!retained.includes('unrelated-port'));
      assert.ok(!retained.includes('unrelated-operation'));
      assert.equal(JSON.stringify(workspace), full, 'reporting must not alter the validated snapshot');
    `,
  );
});
