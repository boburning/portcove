import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readCiMetrics } from "./ci-metrics.mts";
import test from "node:test";
import {
  checkDesktopCommandContract,
  checkDesktopEventContract,
  checkTransportContract,
  checkDesktopExporterParity,
  desktopSchemaExporterCommands,
  extractDeclaredDesktopCommands,
  extractDeclaredDesktopEvents,
  extractExportedDesktopEvents,
  extractFrontendDesktopCommands,
  extractFrontendDesktopEvents,
  extractProducedDesktopEvents,
  extractRegisteredDesktopCommands,
  exportSchemas,
  exportDesktopSchemas,
} from "./check-transport-contract.mts";
import { renderTransportSchemas } from "./transport-schemas.mts";

const schemas = {
  response: {
    type: "object",
    required: ["items"],
    properties: { items: { type: "array", items: { $ref: "#/$defs/Item" } } },
    $defs: {
      Item: {
        type: "object",
        required: ["count"],
        properties: {
          count: { type: ["integer", "null"] as string | string[] },
          state: { enum: ["ready", "held"] },
        },
      },
    },
  },
};

void test("schema fields cannot masquerade as failed exporter timing results", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "portcove-schema-metrics-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const module = new URL("./check-transport-contract.mts", import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { exportSchemas, exportDesktopSchemas } from ${JSON.stringify(module)};
    const schemas = { error: { type: 'object' }, status: { type: 'string' }, signal: { type: 'null' } };
    const execute = (args) => ({status: 0, stderr: '', stdout: JSON.stringify(
      args.includes('--contract') ? {ok: true, command: 'schema.export', data: schemas}
      : {input: schemas, output: schemas, events: schemas, error: schemas.error})});
    assert.deepEqual(exportSchemas('fixture', 'output', execute), schemas);
    assert.deepEqual(exportSchemas('fixture', 'input', execute), schemas);
    assert.deepEqual(exportDesktopSchemas('fixture', true, execute).output, schemas);
    assert.throws(() => exportSchemas('fixture', 'failed', () => ({status: 7, stdout: '', stderr: 'original compiler failure'})),
      error => error.exitCode === 7);
  `,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      env: { ...process.env, PORTCOVE_CI_METRICS_DIR: directory },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const { records } = readCiMetrics(directory);
  assert.equal(records.length, 6);
  assert.deepEqual(
    records
      .filter((record) => record.outcome === "completed")
      .map((record) => record.phase)
      .sort((left, right) => left.localeCompare(right)),
    [
      "transport.core-input",
      "transport.core-output",
      "transport.desktop-headless",
      "transport.desktop-native",
      "transport.desktop-parity",
    ],
  );
  assert.deepEqual(
    records.filter((record) => record.outcome === "failed").map((record) => record.phase),
    ["transport.core-failed"],
  );
});

void test("production exporters report sequential phases separately from their returned contracts", (t) => {
  const stderr: string[] = [];
  const stdout: string[] = [];
  t.mock.method(process.stderr, "write", (value: string) => {
    stderr.push(value);
    return true;
  });
  t.mock.method(process.stdout, "write", (value: string) => {
    stdout.push(value);
    return true;
  });
  const calls: string[][] = [];
  const execute = (args: string[]) => {
    calls.push(args);
    const core = args.includes("--contract");
    return {
      status: 0,
      stderr: "",
      stdout: JSON.stringify(
        core
          ? { ok: true, command: "schema.export", data: schemas }
          : { input: schemas, output: schemas, events: schemas },
      ),
    };
  };
  assert.deepEqual(exportSchemas("fixture", "output", execute), schemas);
  assert.deepEqual(exportSchemas("fixture", "input", execute), schemas);
  assert.deepEqual(exportDesktopSchemas("fixture", true, execute).output, schemas);
  assert.deepEqual(
    calls.map((args) => args.at(-1)),
    ["output", "input", "export_desktop_transport", "export_transport"],
  );
  assert.deepEqual(
    stderr.filter((line) => line.includes("started")),
    [
      "[transport] core-output started\n",
      "[transport] core-input started\n",
      "[transport] desktop-headless started\n",
      "[transport] desktop-native started\n",
      "[transport] desktop-parity started\n",
    ],
  );
  assert.equal(stderr.filter((line) => /completed \(\d+ms\)/u.test(line)).length, 5);
  assert.deepEqual(stdout, ["Headless Desktop contracts match the compiled native host.\n"]);
});

void test("export failures retain phase, diagnostics and exit status; invalid JSON is not completion", (t) => {
  const stderr: string[] = [];
  t.mock.method(process.stderr, "write", (value: string) => {
    stderr.push(value);
    return true;
  });
  assert.throws(
    () =>
      exportSchemas("fixture", "input", () => ({
        status: 7,
        stdout: "",
        stderr: "compiler detail\n",
      })),
    (error: unknown) => {
      assert.ok(error instanceof Error && "exitCode" in error);
      assert.equal(error.exitCode, 7);
      return true;
    },
  );
  assert.match(
    stderr.join(""),
    /core-input started[\s\S]*compiler detail[\s\S]*core-input failed/u,
  );
  stderr.length = 0;
  assert.throws(() =>
    exportSchemas("fixture", "output", () => ({ status: 0, stdout: "invalid", stderr: "" })),
  );
  assert.match(stderr.join(""), /core-output failed/u);
  assert.doesNotMatch(stderr.join(""), /completed/u);
  let calls = 0;
  assert.throws(
    () =>
      exportDesktopSchemas("fixture", true, () => {
        calls += 1;
        return { status: null, stdout: null, stderr: undefined, error: new Error("spawn failed") };
      }),
    /spawn failed/,
  );
  assert.equal(calls, 1);
});

void test("Desktop malformed envelopes and parity drift produce failed phases", (t) => {
  const stderr: string[] = [];
  t.mock.method(process.stderr, "write", (value: string) => {
    stderr.push(value);
    return true;
  });
  assert.throws(
    () => exportDesktopSchemas("fixture", true, () => ({ status: 0, stdout: "{}", stderr: "" })),
    /invalid envelope/,
  );
  assert.match(stderr.join(""), /desktop-headless failed/);
  stderr.length = 0;
  assert.throws(
    () =>
      exportDesktopSchemas("fixture", true, (args) => ({
        status: 0,
        stderr: "",
        stdout: JSON.stringify({
          input: schemas,
          events: schemas,
          output: args.includes("portcove-desktop") ? { different: {} } : schemas,
        }),
      })),
    /differ from/,
  );
  assert.match(stderr.join(""), /desktop-parity started[\s\S]*desktop-parity failed/u);
  assert.doesNotMatch(stderr.join(""), /desktop-parity completed/u);
});

void test("real missing Cargo CLI preserves spawn diagnostics without undefined-stream errors", () => {
  const module = new URL("./check-transport-contract.mts", import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(module)], {
    env: { ...process.env, PATH: "" },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /core-output failed/);
  assert.match(result.stderr, /ENOENT/);
  assert.doesNotMatch(result.stderr, /TypeError|ERR_INVALID_ARG_TYPE/);
  assert.equal(result.stdout, "");
});

void test("headless export retains required Windows native parity and explicit capable-host parity", () => {
  const headless = [
    "run",
    "--locked",
    "--quiet",
    "-p",
    "portcove-cli",
    "--example",
    "export_desktop_transport",
  ];
  const native = [
    "run",
    "--locked",
    "--quiet",
    "-p",
    "portcove-desktop",
    "--example",
    "export_transport",
  ];
  assert.deepEqual(desktopSchemaExporterCommands("linux"), [headless]);
  assert.deepEqual(desktopSchemaExporterCommands("darwin"), [headless]);
  assert.deepEqual(desktopSchemaExporterCommands("win32"), [headless, native]);
  assert.deepEqual(desktopSchemaExporterCommands("linux", true), [headless, native]);
});

void test("native parity compares the complete Rust envelope without depending on key order", () => {
  const contracts = { output: schemas, input: {}, events: { changed: { type: "null" } } };
  assert.deepEqual(
    checkDesktopExporterParity(contracts, { events: contracts.events, input: {}, output: schemas }),
    [],
  );
  for (const section of ["output", "input", "events"] as const) {
    const changed = {
      ...structuredClone(contracts),
      [section]: { ...contracts[section], fixture: { type: "integer" } },
    };
    assert.match(
      fixtureElement(checkDesktopExporterParity(contracts, changed), 0),
      /differ from the compiled native host/,
    );
  }
});

void test("the complete contract is canonical and line-ending independent", () => {
  const rendered = renderTransportSchemas(schemas);
  assert.deepEqual(checkTransportContract(schemas, rendered.replaceAll("\n", "\r\n")), []);
  const reordered = {
    response: Object.fromEntries(Object.entries(schemas.response).reverse()),
  };
  assert.equal(renderTransportSchemas(reordered), rendered);
});

void test("nested types, nullability, required presence, arrays and union drift fail closed", () => {
  for (const mutate of [
    (schema: typeof schemas.response) => {
      schema.$defs.Item.properties.count.type = ["string", "null"];
    },
    (schema: typeof schemas.response) => {
      schema.$defs.Item.properties.count.type = "integer";
    },
    (schema: typeof schemas.response) => {
      schema.$defs.Item.required = [];
    },
    (schema: typeof schemas.response) => {
      schema.properties.items.type = "object";
    },
    (schema: typeof schemas.response) => {
      schema.$defs.Item.properties.state.enum.push("unknown");
    },
  ]) {
    const changed = structuredClone(schemas);
    mutate(changed.response);
    assert.equal(checkTransportContract(schemas, renderTransportSchemas(changed)).length, 1);
  }
});

void test("invalid or absent schema inventories cannot generate an empty passing contract", () => {
  for (const invalid of [null, [], {}, { response: null }])
    assert.throws(() => renderTransportSchemas(invalid), /named JSON schemas/);
  assert.equal(checkTransportContract(schemas, "").length, 1);
});

const registrationSource = `
  .invoke_handler(tauri::generate_handler![
    catalog::get_catalog,
    set_policy,
  ])
`;
const declarationSources = [
  `#[tauri::command]\npub async fn get_catalog() {}`,
  `#[tauri::command]\nfn set_policy() {}`,
];
const frontendSource = `
  import { invoke } from "@tauri-apps/api/core";
  // invoke("commented_out")
  export const api = {
    catalog: () => invoke<Catalog>("get_catalog"),
    policy: () => invoke<void>("set_policy", { value: true }),
  };
`;

void test("desktop command declarations, registrations, and literal frontend bindings agree", () => {
  assert.deepEqual(extractRegisteredDesktopCommands(registrationSource), [
    "get_catalog",
    "set_policy",
  ]);
  assert.deepEqual(extractDeclaredDesktopCommands(declarationSources), [
    "get_catalog",
    "set_policy",
  ]);
  assert.deepEqual(extractFrontendDesktopCommands(frontendSource), ["get_catalog", "set_policy"]);
  assert.deepEqual(
    checkDesktopCommandContract({
      registrationSource,
      declarationSources,
      frontendSources: [frontendSource],
    }),
    [],
  );
});

void test("missing, extra, duplicate, and dynamic desktop exposure fails closed", () => {
  const missingFrontend = frontendSource.replace(
    'policy: () => invoke<void>("set_policy", { value: true }),',
    "",
  );
  assert.match(
    checkDesktopCommandContract({
      registrationSource,
      declarationSources,
      frontendSources: [missingFrontend],
    }).join("\n"),
    /frontend invocations omit registered commands: set_policy/,
  );

  assert.match(
    checkDesktopCommandContract({
      registrationSource,
      declarationSources: [
        ...declarationSources,
        `#[tauri::command]\nfn unregistered_admin_command() {}`,
      ],
      frontendSources: [frontendSource],
    }).join("\n"),
    /Rust declarations expose unregistered commands: unregistered_admin_command/,
  );

  assert.match(
    checkDesktopCommandContract({
      registrationSource: registrationSource.replace("set_policy,", "set_policy, set_policy,"),
      declarationSources,
      frontendSources: [frontendSource],
    }).join("\n"),
    /contains duplicates: set_policy/,
  );

  assert.match(
    checkDesktopCommandContract({
      registrationSource,
      declarationSources,
      frontendSources: [frontendSource.replace('"set_policy"', "selectedCommand")],
    }).join("\n"),
    /direct string literal/,
  );
});

void test("aliased, indirect, and out-of-facade invokes fail alongside a complete inventory", () => {
  for (const hiddenInvoke of [
    "const call = invoke; call(selectedCommand);",
    "invoke.call(null, selectedCommand);",
  ])
    assert.match(
      checkDesktopCommandContract({
        registrationSource,
        declarationSources,
        frontendSources: [frontendSource + hiddenInvoke],
      }).join("\n"),
      /invoke must only be imported and called directly/,
    );

  assert.match(
    checkDesktopCommandContract({
      registrationSource,
      declarationSources,
      frontendSources: [
        frontendSource,
        'import { invoke } from "@tauri-apps/api/core"; invoke("unregistered_window_command");',
      ],
    }).join("\n"),
    /frontend invocations expose unregistered commands: unregistered_window_command/,
  );
  assert.match(
    checkDesktopCommandContract({
      registrationSource,
      declarationSources,
      frontendSources: [frontendSource, 'invoke("get_catalog");'],
    }).join("\n"),
    /invoke calls must use a direct invoke import/,
  );
  assert.match(
    checkDesktopCommandContract({
      registrationSource,
      declarationSources,
      frontendSources: [
        frontendSource,
        `import * as core from "@tauri-apps/api/core";
         core["invoke"](selectedCommand);`,
      ],
    }).join("\n"),
    /Tauri core APIs must use direct named imports/,
  );
  assert.throws(
    () =>
      extractFrontendDesktopCommands(
        frontendSource.replace("{ invoke }", "{ invoke as call }").replaceAll("invoke<", "call<"),
      ),
    /invoke imports must not be aliased/,
  );
});

void test("a coherent registration and frontend rename cannot hide declaration drift", () => {
  const renamedRegistration = registrationSource.replace("get_catalog", "renamed_catalog");
  const renamedFrontend = frontendSource.replace("get_catalog", "renamed_catalog");
  assert.match(
    checkDesktopCommandContract({
      registrationSource: renamedRegistration,
      declarationSources,
      frontendSources: [renamedFrontend],
    }).join("\n"),
    /Rust declarations omit registered commands: renamed_catalog/,
  );
});

void test("unsupported command attributes and unparsed registration syntax fail closed", () => {
  assert.throws(
    () =>
      extractDeclaredDesktopCommands([
        `#[tauri::command(rename_all = "snake_case")]\nfn named() {}`,
      ]),
    /parsed 0 of 1/,
  );
  assert.throws(
    () =>
      extractRegisteredDesktopCommands(
        `.invoke_handler(tauri::generate_handler![catalog::get_catalog, conditional!()])`,
      ),
    /unsupported Tauri command registration/,
  );
});

const eventDeclarationSource = `
pub(crate) const DESKTOP_EVENT_APPLICATION_UPDATE_NOTICE: &str = "portcove://application-update-notice";
pub(crate) const DESKTOP_EVENT_LIBRARY_CHANGED: &str = "portcove://library-changed";
pub(crate) const DESKTOP_EVENT_OPERATION: &str = "portcove://operation";
`;
const eventProducerSources = [
  `use crate::transport::emit_desktop_event;
   emit_desktop_event::<ApplicationUpdateNoticeSnapshot>(&app, DESKTOP_EVENT_APPLICATION_UPDATE_NOTICE, notice);
   emit_desktop_event::<ApplicationUpdateNoticeSnapshot>(app, DESKTOP_EVENT_APPLICATION_UPDATE_NOTICE, cleared);`,
  `use crate::transport::emit_desktop_event;
   emit_desktop_event::<()>(&app, DESKTOP_EVENT_LIBRARY_CHANGED, ());
   emit_desktop_event::<portcove_core::OperationEvent>(app, DESKTOP_EVENT_OPERATION, event);`,
  `use tauri::Emitter;
   fn emit_desktop_event<T>(app: &tauri::AppHandle, event: &'static str, payload: T) {
     app.emit(event, payload);
   }`,
];
const eventExporterSource = `
let events = serde_json::Map::from_iter([
  (DESKTOP_EVENT_APPLICATION_UPDATE_NOTICE.to_owned(), output::<ApplicationUpdateNoticeSnapshot>()),
  (DESKTOP_EVENT_LIBRARY_CHANGED.to_owned(), output::<()>()),
  (DESKTOP_EVENT_OPERATION.to_owned(), output::<portcove_core::OperationEvent>()),
]);
`;
const eventFrontendSources = [
  `import { listenDesktopEvent } from "./desktop-events";
   listenDesktopEvent("portcove://application-update-notice", accept);`,
  `import { listenDesktopEvent } from "./desktop-events";
   listenDesktopEvent("portcove://library-changed", accept);`,
  `import { listenDesktopEvent } from "./desktop-events";
   listenDesktopEvent("portcove://operation", accept);`,
  `import { listen } from "@tauri-apps/api/event";
   export function listenDesktopEvent(name, accept) { return listen(name, (event) => accept(event.payload)); }`,
];

void test("Rust event declarations, Tauri producers, and typed frontend consumers agree", () => {
  const declarations = extractDeclaredDesktopEvents(eventDeclarationSource);
  assert.deepEqual([...declarations.values()].sort(), [
    "portcove://application-update-notice",
    "portcove://library-changed",
    "portcove://operation",
  ]);
  assert.deepEqual(extractProducedDesktopEvents(eventProducerSources, declarations), [
    "portcove://application-update-notice",
    "portcove://library-changed",
    "portcove://operation",
  ]);
  assert.deepEqual(extractExportedDesktopEvents(eventExporterSource, declarations), [
    "portcove://application-update-notice",
    "portcove://library-changed",
    "portcove://operation",
  ]);
  assert.deepEqual(extractFrontendDesktopEvents(eventFrontendSources), [
    "portcove://application-update-notice",
    "portcove://library-changed",
    "portcove://operation",
  ]);
  assert.deepEqual(
    checkDesktopEventContract({
      declarationSource: eventDeclarationSource,
      producerSources: eventProducerSources,
      exporterSource: eventExporterSource,
      frontendSources: eventFrontendSources,
    }),
    [],
  );
});

void test("missing, extra, duplicate, dynamic, and direct desktop event consumers fail closed", () => {
  const withoutLibrary = eventFrontendSources.filter(
    (source) => !source.includes('listenDesktopEvent("portcove://library-changed"'),
  );
  assert.match(
    checkDesktopEventContract({
      declarationSource: eventDeclarationSource,
      producerSources: eventProducerSources,
      exporterSource: eventExporterSource,
      frontendSources: withoutLibrary,
    }).join("\n"),
    /frontend consumers omit declared events: portcove:\/\/library-changed/,
  );
  assert.match(
    checkDesktopEventContract({
      declarationSource: eventDeclarationSource,
      producerSources: eventProducerSources,
      exporterSource: eventExporterSource,
      frontendSources: [
        ...eventFrontendSources,
        `import { listenDesktopEvent } from "./desktop-events";
         listenDesktopEvent("portcove://unknown", accept);`,
      ],
    }).join("\n"),
    /frontend consumers expose undeclared events: portcove:\/\/unknown/,
  );
  assert.throws(
    () =>
      extractFrontendDesktopEvents([
        ...eventFrontendSources,
        `import { listenDesktopEvent } from "./desktop-events";
         listenDesktopEvent(selectedEvent, accept);`,
      ]),
    /direct string literal/,
  );
  assert.throws(
    () =>
      extractFrontendDesktopEvents([
        ...eventFrontendSources,
        `import { listen } from "@tauri-apps/api/event"; listen("portcove://unknown", accept);`,
      ]),
    /exactly one shipped Tauri event adapter/,
  );
  assert.throws(
    () =>
      extractFrontendDesktopEvents(
        eventFrontendSources.map((source: string) =>
          source.includes("@tauri-apps/api/event")
            ? source.replace("{ listen }", "{ listen as hiddenListen }")
            : source,
        ),
      ),
    /must directly import and export listen/,
  );
  assert.throws(
    () =>
      extractFrontendDesktopEvents([
        ...eventFrontendSources,
        fixtureElement(eventFrontendSources, 0),
      ]),
    /contains duplicates/,
  );
});

void test("the independent event fixture rejects a coherent generated rename", () => {
  const renamedDeclaration = eventDeclarationSource.replaceAll(
    "portcove://operation",
    "portcove://renamed-operation",
  );
  const renamedFrontend = eventFrontendSources.map((source: string) =>
    source.replaceAll("portcove://operation", "portcove://renamed-operation"),
  );
  assert.match(
    checkDesktopEventContract({
      declarationSource: renamedDeclaration,
      producerSources: eventProducerSources,
      exporterSource: eventExporterSource,
      frontendSources: renamedFrontend,
    }).join("\n"),
    /independent compatibility fixture omit declared events: portcove:\/\/renamed-operation/,
  );
});

void test("unparsed event constants and Tauri producers fail closed", () => {
  assert.throws(
    () =>
      extractDeclaredDesktopEvents(
        eventDeclarationSource.replace(
          'pub(crate) const DESKTOP_EVENT_OPERATION: &str = "portcove://operation";',
          "const DESKTOP_EVENT_OPERATION: &str = selected_event();",
        ),
      ),
    /parsed 2 of 3/,
  );
  const declarations = extractDeclaredDesktopEvents(eventDeclarationSource);
  assert.throws(
    () =>
      extractProducedDesktopEvents(
        [...eventProducerSources, `use tauri::*; app.emit::<()>("portcove://rogue", ());`],
        declarations,
      ),
    /must route through emit_desktop_event/,
  );
  assert.throws(
    () =>
      extractProducedDesktopEvents(
        [...eventProducerSources, `tauri::Emitter::emit::<()>(&app, "portcove://rogue", ());`],
        declarations,
      ),
    /must route through emit_desktop_event/,
  );
  assert.throws(
    () =>
      extractProducedDesktopEvents(
        [...eventProducerSources, `emit_desktop_event::<()>(&app, DESKTOP_EVENT_OPERATION, ());`],
        declarations,
      ),
    /DESKTOP_EVENT_OPERATION producers must emit portcove_core::OperationEvent, found \(\)/,
  );
  assert.throws(
    () =>
      extractExportedDesktopEvents(
        eventExporterSource.replace("output::<portcove_core::OperationEvent>()", "output::<()>()"),
        declarations,
      ),
    /DESKTOP_EVENT_OPERATION schema must export portcove_core::OperationEvent, found \(\)/,
  );
});

void test("the cheap IPC-only CLI checks actual repository exposure without accepting schema substitutes", () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/check-transport-contract.mts", "--ipc-only"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.match(output, /Desktop command\/event exposure matches Rust/);
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        ["scripts/check-transport-contract.mts", "--ipc-only", "--types", "missing.json"],
        { encoding: "utf8", windowsHide: true, stdio: "pipe" },
      ),
    /cannot write or substitute/,
  );
});

function fixtureElement<T>(values: readonly T[], index: number): T {
  const value = values[index];
  assert.ok(value !== undefined);
  return value;
}
