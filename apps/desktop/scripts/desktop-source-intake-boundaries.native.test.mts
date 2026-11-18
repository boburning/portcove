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
      const [original, other, foreign, changed, moved, caseVariant, snapshot, refused] = inertTransportReply.map(item => item.value);
      for (const mode of ['original', 'other', 'lost-response', 'owned-case', 'foreign', 'read-refused',
                          'generation-changed', 'root-changed', 'loading', 'stale-renderer']) {
        const current = mode === 'original' ? original : mode === 'foreign' ? foreign
          : mode === 'owned-case' ? caseVariant : other;
        const after = mode === 'generation-changed' ? changed : mode === 'root-changed' ? moved : current;
        const unowned = mode === 'foreign' || (mode === 'owned-case' && process.platform !== 'win32');
        let rendererGeneration = mode === 'lost-response' ? original.generation : current.generation;
        let refreshes = 0, samples = 0, waits = 0, bootstrapReads = 0;
        const calls = [];
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
            return {ok:true, value:++bootstrapReads < 3 ? current : after};
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
        assert.equal(waits, unowned || ['read-refused', 'generation-changed', 'root-changed'].includes(mode) ? 0 : 1);
        assert.deepEqual(calls.map(call => call.command), unowned ? ['get_bootstrap_status']
          : ['get_bootstrap_status', 'get_bootstrap_status', 'get_workspace_snapshot',
             ...(mode === 'read-refused' ? [] : ['get_bootstrap_status']),
             ...(accepted ? ['get_bootstrap_status'] : [])]);
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
      {
        command: "desktop_desktop_error",
        value: { code: "conflict", details: {}, message: "owned read refusal" },
      },
    ],
  );
});

void test("workspace observation retries only explicit stale reads at one unchanged scope and finite budget", () => {
  const bootstrap = {
    ready: true,
    error: null,
    generation: 7,
    library_root: "owned",
    selection: null,
  };
  const refusal = (
    details: Record<string, unknown>,
    key = "selection_changed",
    code = "conflict",
  ) => ({
    code,
    details,
    message: "owned refusal retained",
    presentation: {
      mutation_state: "unknown",
      phase: null,
      presentation_key: key,
      recovery_actions: ["review_current_state"],
      summary: "Owned fixture refusal",
      technical_context: {},
      technical_message: "owned refusal retained",
      tone: "error",
    },
  });
  runDesktopModuleFixture(
    new URL("./desktop-review-observation.mts", import.meta.url),
    `
      const {readWorkspaceSnapshotObservation: observe} = await import(entry);
      const [bootstrap, changed, moved, workspace, stale, notRetryable, booleanSignal,
             busy, unrelated, wrongCode] = inertTransportReply.map(item => item.value);
      let now = 0;
      mock.method(Date, 'now', () => now);
      for (const mode of ['success', 'one-stale', 'persistent', 'not-retryable', 'boolean-signal',
                          'busy', 'stale-generation-refusal', 'wrong-code', 'generation', 'root', 'transport',
                          'expired-stale', 'late-success', 'caller-binding-change']) {
        now = 0;
        let reads = 0, scopeReads = 0, release, started, settled = false;
        const held = new Promise(resolve => {release = resolve;});
        const reading = new Promise(resolve => {started = resolve;});
        const original = Error('Owned transport refusal');
        const binding = {generation:bootstrap.generation, library_root:bootstrap.library_root};
        const calls = [], records = [];
        const failures = {'not-retryable':notRetryable, 'boolean-signal':booleanSignal,
          busy, 'stale-generation-refusal':unrelated, 'wrong-code':wrongCode};
        const invoke = async (command, args) => {
          calls.push({command, args});
          if (command === 'get_bootstrap_status') {
            scopeReads++;
            return {ok:true, value:scopeReads > 1 && mode === 'generation' ? changed
              : scopeReads > 1 && mode === 'root' ? moved : bootstrap};
          }
          assert.equal(command, 'get_workspace_snapshot', 'no action or mutation may be replayed');
          assert.deepEqual(args, {generation:7});
          reads++;
          if (mode === 'transport') throw original;
          if (mode === 'caller-binding-change') {binding.generation = 99; binding.library_root = 'foreign';}
          if (mode === 'late-success') {started(); await held; return {ok:true, value:workspace};}
          if (mode === 'expired-stale') now = 60_001;
          if (failures[mode]) return {ok:false, error:failures[mode]};
          if (['persistent','generation','root','expired-stale'].includes(mode)
              || (mode === 'one-stale' && reads === 1)) return {ok:false, error:stale};
          return {ok:true, value:workspace};
        };
        const pending = observe(invoke, binding, records);
        void pending.then(() => {settled = true;}, () => {settled = true;});
        if (mode === 'late-success') {
          await reading;
          assert.equal(settled, false);
          now = 60_001;
          await Promise.resolve();
          assert.equal(settled, false, 'a deadline must not detach the owned pending read');
          release();
        }
        if (['success','one-stale','caller-binding-change'].includes(mode))
          assert.equal(await pending, workspace);
        else if (mode === 'transport') await assert.rejects(pending, error => error === original);
        else await assert.rejects(pending, mode === 'persistent' ? /3 read attempts/
          : ['expired-stale','late-success'].includes(mode) ? /60-second budget/
          : mode === 'generation' ? /generation changed/ : mode === 'root' ? /root changed/ : undefined);
        assert.equal(reads, mode === 'persistent' ? 3 : mode === 'one-stale' ? 2 : 1);
        assert.equal(records.length, reads);
        for (const call of calls)
          assert.deepEqual(call.args, call.command === 'get_workspace_snapshot' ? {generation:7} : undefined);
        if (['one-stale','persistent','generation','root','expired-stale'].includes(mode))
          assert.equal(records[0].error, stale, 'preserve every actual structured refusal');
        if (mode === 'late-success') {
          assert.equal(records[0].elapsed_ms, 60_001);
          assert.equal(scopeReads, 1, 'no continuation after late settlement');
        }
      }
    `,
    undefined,
    [
      { command: "desktop_bootstrap_status", value: bootstrap },
      { command: "desktop_bootstrap_status", value: { ...bootstrap, generation: 8 } },
      { command: "desktop_bootstrap_status", value: { ...bootstrap, library_root: "foreign" } },
      {
        command: "desktop_workspace_snapshot",
        value: { statuses: [], sources: [], activities: {} },
      },
      {
        command: "desktop_desktop_error",
        value: refusal({ workspace_snapshot_stale: "true", retryable: "true" }),
      },
      {
        command: "desktop_desktop_error",
        value: refusal({ workspace_snapshot_stale: "true", retryable: "false" }),
      },
      {
        command: "desktop_desktop_error",
        value: refusal({ workspace_snapshot_stale: true, retryable: "true" }),
      },
      { command: "desktop_desktop_error", value: refusal({}, "target_busy") },
      { command: "desktop_desktop_error", value: refusal({}) },
      {
        command: "desktop_desktop_error",
        value: refusal(
          { workspace_snapshot_stale: "true", retryable: "true" },
          "fixture_state",
          "state",
        ),
      },
    ],
  );
});
