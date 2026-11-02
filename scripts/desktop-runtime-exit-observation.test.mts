import test from "node:test";
import { runDesktopModuleFixture } from "./fixtures/desktop-module-fixture.mts";

const helper = new URL(
  "../apps/desktop/scripts/desktop-runtime-exit-observation.mts",
  import.meta.url,
);

void test("runtime exit observation retains identity, finite wait and positive closure without inventing close intent", () => {
  runDesktopModuleFixture(
    helper,
    `
    const { observeRegisteredRuntimeExit } = await import(entry);
    const session = { child_pid: 11, child_identity: 'windows-filetime:123' };
    const route = {}; const calls = []; let reads = 0;
    await observeRegisteredRuntimeExit({ session, snapshot: 'owned-game.json', route,
      native: (mode, snapshot) => {
        assert.equal(snapshot, 'owned-game.json'); calls.push(mode);
        if (mode === 'Observe') return { processes: [{ pid: 11, started_filetime: '123', state: ++reads === 1 ? 'running' : 'exited' }] };
        assert.equal(mode, 'Wait'); return { observed_processes: 1, exited_at: 'fixture' };
      },
      wait: async (observe, timeout) => { assert.equal(timeout, 300000); assert.equal(observe(), false); return observe(); }
    });
    assert.deepEqual(calls, ['Observe', 'Observe', 'Wait']);
    assert.equal(route.observed_game_exit.observed_processes, 1);
    assert.equal('ordinary_game_close' in route, false);
    assert.equal('rendering' in route, false);
  `,
  );
});

void test("runtime exit observation refuses another process or recycled identity before any closure claim", () => {
  runDesktopModuleFixture(
    helper,
    `
    const { observeRegisteredRuntimeExit } = await import(entry);
    const session = { child_pid: 11, child_identity: 'windows-filetime:123' };
    for (const processes of [[], [{ pid: 12, started_filetime: '123', state: 'exited' }], [{ pid: 11, started_filetime: '999', state: 'exited' }]]) {
      const route = {}; const calls = [];
      await assert.rejects(() => observeRegisteredRuntimeExit({ session, snapshot: 'bound', route,
        native: mode => { calls.push(mode); assert.equal(mode, 'Observe'); return { processes }; },
        wait: async observe => observe()
      }));
      assert.deepEqual(calls, ['Observe']);
      assert.equal('observed_game_exit' in route, false);
    }
  `,
  );
});

void test("runtime observation keeps timeout and positive-exit failures visible", () => {
  runDesktopModuleFixture(
    helper,
    `
    const { observeRegisteredRuntimeExit } = await import(entry);
    const session = { child_pid: 11, child_identity: 'windows-filetime:123' };
    const route = {};
    await assert.rejects(() => observeRegisteredRuntimeExit({ session, snapshot: 'bound', route,
      native: mode => { assert.equal(mode, 'Observe'); return { processes: [{ pid: 11, started_filetime: '123', state: 'running' }] }; },
      wait: async observe => { assert.equal(observe(), false); throw Error('finite observation expired'); }
    }), /finite observation expired/);
    assert.equal('observed_game_exit' in route, false);
    await assert.rejects(() => observeRegisteredRuntimeExit({ session, snapshot: 'bound', route: {},
      native: mode => { if (mode === 'Wait') throw Error('positive join failed'); return { processes: [{ pid: 11, started_filetime: '123', state: 'exited' }] }; },
      wait: async observe => observe()
    }), /positive join failed/);
  `,
  );
});
