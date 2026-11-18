import test from "node:test";
import { runDesktopModuleFixture } from "../../../scripts/fixtures/desktop-module-fixture.mts";

void test("preliminary review copy retains the structural check and non-exact-edition explanation", () => {
  runDesktopModuleFixture(
    new URL("./desktop-source-dialog-test.mts", import.meta.url),
    `
      const {assertPreliminarySourceReviewExplanation: check} = await import(entry);
      for (const apostrophe of ["’", "'"])
        check("Basic file checks passed.\\nThese checks alone don" + apostrophe +
          "t identify the edition.  Check which files this port needs.");
      for (const text of [
        "Validation has not run.", "Admitted · structural checks",
        "Basic file checks passed. These checks identify the edition.",
        "These checks alone don’t identify the edition. Check which files this port needs.",
        "Basic file checks passed. These checks alone don’t identify the edition.",
        "The project’s setup tool accepted these files. This check alone doesn’t identify the edition.",
      ]) assert.throws(() => check(text));
    `,
  );
});

void test("source restoration requires a settled current owned workspace through a read-only precondition", () => {
  const bootstrap = (generation: number, library_root: string) => ({
    ready: true,
    error: null,
    generation,
    library_root,
    selection: null,
  });
  const workspace = {
    statuses: [],
    sources: [],
    activities: {
      records: [],
      current_activity_ids: [],
      attention_required_activity_ids: [],
      recovery_required_activity_ids: [],
      active_and_actionable_complete: true,
      terminal_history_limit: 0,
      terminal_history_count: 0,
      terminal_history_complete: true,
    },
  };
  runDesktopModuleFixture(
    new URL("./desktop-source-intake-boundaries-test.mts", import.meta.url),
    `
      import {runInNewContext} from 'node:vm';
      const {waitForSourceIntakeRestoration: ready} = await import(entry);
      const [original, other, foreign, changed, moved, caseVariant, snapshot] = inertTransportReply.map(item => item.value);
      for (const mode of ['original', 'other', 'lost-response', 'owned-case', 'foreign', 'read-refused',
                          'generation-changed', 'root-changed', 'loading', 'stale-renderer']) {
        const current = mode === 'original' ? original : mode === 'foreign' ? foreign
          : mode === 'owned-case' ? caseVariant : other;
        const after = mode === 'generation-changed' ? changed : mode === 'root-changed' ? moved : current;
        const unowned = mode === 'foreign' || (mode === 'owned-case' && process.platform !== 'win32');
        let rendererGeneration = mode === 'lost-response' ? original.generation : current.generation;
        let refreshes = 0, samples = 0, waits = 0, bootstrapReads = 0;
        const calls = [], refused = {code:'conflict', detail:'owned read refusal'};
        let release, started;
        const held = new Promise(resolve => {release = resolve;});
        const reading = new Promise(resolve => {started = resolve;});
        const browser = {
          navigate: () => ({refresh: async () => { refreshes++; rendererGeneration = current.generation; }}),
          executeScript: async callback => {
            const loading = ++samples === 2 || mode === 'loading';
            const generation = mode === 'stale-renderer' && samples > 1 ? original.generation : rendererGeneration;
            return runInNewContext('(' + callback.toString() + ')()', {document: {
              querySelector: selector => selector === 'main[data-workspace-continuity-scope]'
                ? {getAttribute: () => JSON.stringify([generation, 'library', null, false])}
                : selector === 'nav[aria-label="Primary navigation"]' ? {}
                : selector === '.loading-state' && loading ? {} : null,
            }}, {timeout:1000});
          },
          wait: async (predicate, timeout, message) => {
            waits++; assert.equal(timeout, 60_000); assert.match(message, /before library restoration/);
            assert.equal(await predicate(), false, 'a matching nav alone is not settled');
            if (!await predicate()) throw Error('Controlled unsettled workspace');
          },
        };
        const invoke = async (command, args) => {
          calls.push({command, args});
          if (command === 'get_bootstrap_status')
            return {ok:true, value:++bootstrapReads === 1 ? current : after};
          assert.equal(command, 'get_workspace_snapshot', 'readiness must not mutate the library');
          assert.deepEqual(args, {generation:current.generation});
          started();
          await held;
          return mode === 'read-refused' ? {ok:false, error:refused} : {ok:true, value:snapshot};
        };
        const check = ready(browser, invoke, ['owned-original', 'owned-other']);
        if (!unowned) {
          await reading;
          assert.equal(waits, 0, 'do not accept renderer readiness before the actual read settles');
          release();
        }
        const accepted = ['original', 'other', 'lost-response'].includes(mode)
          || (mode === 'owned-case' && process.platform === 'win32');
        if (accepted) {
          const result = await check;
          assert.deepEqual(result, {generation:current.generation, library_root:current.library_root});
        } else await assert.rejects(check);
        assert.equal(refreshes, mode === 'lost-response' ? 1 : 0);
        assert.equal(waits, unowned || mode === 'read-refused' ? 0 : 1);
        assert.deepEqual(calls.map(call => call.command), unowned ? ['get_bootstrap_status']
          : ['get_bootstrap_status', 'get_workspace_snapshot',
             ...(['read-refused', 'loading', 'stale-renderer'].includes(mode) ? [] : ['get_bootstrap_status'])]);
      }
    `,
    undefined,
    [
      { command: "desktop_bootstrap_status", value: bootstrap(1, "owned-original") },
      { command: "desktop_bootstrap_status", value: bootstrap(2, "owned-other") },
      { command: "desktop_bootstrap_status", value: bootstrap(2, "foreign-library") },
      { command: "desktop_bootstrap_status", value: bootstrap(3, "owned-other") },
      { command: "desktop_bootstrap_status", value: bootstrap(2, "owned-original") },
      { command: "desktop_bootstrap_status", value: bootstrap(2, "OWNED-OTHER") },
      { command: "desktop_workspace_snapshot", value: workspace },
    ],
  );
});
