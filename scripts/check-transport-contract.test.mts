import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  checkDesktopCommandContract,
  checkDesktopEventContract,
  checkTransportContract,
  checkDesktopExporterParity,
  buildSchemaExporters,
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

const exporterRoot = path.resolve("fixture");
const exporterPaths = {
  cli: path.resolve("custom Cargo output", "compiled-cli"),
  headless: path.resolve("custom Cargo output", "compiled-headless"),
  native: path.resolve("separate native output", "compiled-native"),
};

function fixtureBuildMessages(native = false): Record<string, unknown>[] {
  const manifest = path.join(
    exporterRoot,
    native ? "apps/desktop/src-tauri/Cargo.toml" : "crates/portcove-cli/Cargo.toml",
  );
  const targets = native
    ? [{ name: "export_transport", kind: "example", executable: exporterPaths.native }]
    : [
        { name: "portcove", kind: "bin", executable: exporterPaths.cli },
        { name: "export_desktop_transport", kind: "example", executable: exporterPaths.headless },
      ];
  return [
    ...targets.map(({ name, kind, executable }, index) => ({
      reason: "compiler-artifact",
      manifest_path: manifest,
      target: { name, kind: [kind] },
      profile: { test: false },
      executable,
      fresh: index === 0,
    })),
    { reason: "build-finished", success: true },
  ];
}

function fixtureExport(executable: string, args: string[]) {
  return {
    status: 0,
    stderr: "",
    stdout:
      executable === "cargo"
        ? fixtureBuildMessages(args.includes("portcove-desktop"))
            .map((message) => JSON.stringify(message))
            .join("\n")
        : JSON.stringify(
            executable === exporterPaths.cli
              ? { ok: true, command: "schema.export", data: schemas }
              : { input: schemas, output: schemas, events: schemas },
          ),
  };
}

void test("exporters build once per package and execute Cargo's exact artifacts with separate timings", (t) => {
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
  const calls: { executable: string; args: string[] }[] = [];
  const execute = (executable: string, args: string[], root: string) => {
    assert.equal(root, exporterRoot);
    calls.push({ executable, args });
    const result = fixtureExport(executable, args);
    if (executable === "cargo") {
      // A dependency with the same target name must not supply our executable.
      const unrelated = {
        ...fixtureElement(fixtureBuildMessages(), 0),
        manifest_path: path.resolve("another-package", "Cargo.toml"),
        executable: path.resolve("stale-executable"),
      };
      result.stdout = `${JSON.stringify(unrelated)}\n${result.stdout}`;
    }
    return result;
  };
  const exporters = buildSchemaExporters(exporterRoot, execute);
  assert.deepEqual(exportSchemas(exporters, "output"), schemas);
  assert.deepEqual(exportSchemas(exporters, "input"), schemas);
  assert.deepEqual(exportDesktopSchemas(exporters, true).output, schemas);
  assert.deepEqual(calls, [
    {
      executable: "cargo",
      args: [
        "build",
        "--locked",
        "--quiet",
        "--message-format=json,json-render-diagnostics",
        "-p",
        "portcove-cli",
        "--bin",
        "portcove",
        "--example",
        "export_desktop_transport",
      ],
    },
    { executable: exporterPaths.cli, args: ["--json", "schema", "export", "--contract", "output"] },
    { executable: exporterPaths.cli, args: ["--json", "schema", "export", "--contract", "input"] },
    { executable: exporterPaths.headless, args: [] },
    {
      executable: "cargo",
      args: [
        "build",
        "--locked",
        "--quiet",
        "--message-format=json,json-render-diagnostics",
        "-p",
        "portcove-desktop",
        "--example",
        "export_transport",
      ],
    },
    { executable: exporterPaths.native, args: [] },
  ]);
  assert.deepEqual(
    stderr.filter((line) => line.includes("started")),
    [
      "[transport] build-core-headless started\n",
      "[transport] core-output started\n",
      "[transport] core-input started\n",
      "[transport] desktop-headless started\n",
      "[transport] build-desktop-native started\n",
      "[transport] desktop-native started\n",
      "[transport] desktop-parity started\n",
    ],
  );
  assert.equal(stderr.filter((line) => /completed \(\d+ms\)/u.test(line)).length, 7);
  assert.deepEqual(stdout, ["Headless Desktop contracts match the compiled native host.\n"]);
});

void test("failed or unconfirmed Cargo builds never supply executable artifacts", (t) => {
  const stderr: string[] = [];
  t.mock.method(process.stderr, "write", (value: string) => {
    stderr.push(value);
    return true;
  });
  for (const status of [0, 17]) {
    assert.throws(
      () =>
        buildSchemaExporters(exporterRoot, () => ({
          status,
          stdout: fixtureBuildMessages()
            .map((message) => JSON.stringify(message))
            .join("\n"),
          stderr: "compiler detail\n",
          ...(status === 0 ? { error: new Error("spawn failed") } : {}),
        })),
      (error: unknown) => {
        assert.ok(error instanceof Error && "exitCode" in error);
        assert.equal(error.exitCode, status === 0 ? 1 : 17);
        return true;
      },
    );
  }
  assert.match(stderr.join(""), /build-core-headless started[\s\S]*compiler detail[\s\S]*failed/u);
  assert.doesNotMatch(stderr.join(""), /completed/u);

  const cases: { name: string; change: (messages: Record<string, unknown>[]) => void }[] = [
    {
      name: "wrong package",
      change: (messages) => {
        fixtureElement(messages, 0).manifest_path = path.resolve("other", "Cargo.toml");
      },
    },
    {
      name: "wrong target kind",
      change: (messages) => {
        fixtureElement(messages, 0).target = { name: "portcove", kind: ["test"] };
      },
    },
    {
      name: "test harness",
      change: (messages) => {
        fixtureElement(messages, 0).profile = { test: true };
      },
    },
    {
      name: "missing executable",
      change: (messages) => {
        fixtureElement(messages, 0).executable = null;
      },
    },
    {
      name: "relative executable",
      change: (messages) => {
        fixtureElement(messages, 0).executable = "target/debug/portcove";
      },
    },
    {
      name: "ambiguous artifact",
      change: (messages) => {
        messages.unshift(fixtureElement(messages, 0));
      },
    },
    {
      name: "missing headless",
      change: (messages) => {
        messages.splice(1, 1);
      },
    },
    {
      name: "missing completion",
      change: (messages) => {
        messages.pop();
      },
    },
    {
      name: "failed completion",
      change: (messages) => {
        fixtureElement(messages, 2).success = false;
      },
    },
    {
      name: "artifact after completion",
      change: (messages) => {
        messages.push(fixtureElement(messages, 0));
      },
    },
  ];
  for (const { name, change } of cases) {
    const messages = fixtureBuildMessages();
    change(messages);
    let calls = 0;
    assert.throws(
      () =>
        buildSchemaExporters(exporterRoot, (executable) => {
          assert.equal(executable, "cargo");
          calls += 1;
          return {
            status: 0,
            stderr: "",
            stdout: messages.map((message) => JSON.stringify(message)).join("\n"),
          };
        }),
      /Cargo /u,
      name,
    );
    assert.equal(calls, 1, name);
  }
  assert.throws(
    () => buildSchemaExporters(exporterRoot, () => ({ status: 0, stdout: "{invalid", stderr: "" })),
    SyntaxError,
  );
});

void test("export failures retain phase, diagnostics and exit status; invalid JSON is not completion", (t) => {
  const stderr: string[] = [];
  t.mock.method(process.stderr, "write", (value: string) => {
    stderr.push(value);
    return true;
  });
  const exporters = buildSchemaExporters(exporterRoot, (executable, args) =>
    executable === "cargo"
      ? fixtureExport(executable, args)
      : {
          status: 7,
          stdout: "",
          stderr: "export detail\n",
        },
  );
  stderr.length = 0;
  assert.throws(
    () => exportSchemas(exporters, "input"),
    (error: unknown) => {
      assert.ok(error instanceof Error && "exitCode" in error);
      assert.equal(error.exitCode, 7);
      return true;
    },
  );
  assert.match(stderr.join(""), /core-input started[\s\S]*export detail[\s\S]*core-input failed/u);
  const invalid = buildSchemaExporters(exporterRoot, (executable, args) =>
    executable === "cargo"
      ? fixtureExport(executable, args)
      : { status: 0, stdout: "invalid", stderr: "" },
  );
  stderr.length = 0;
  assert.throws(() => exportSchemas(invalid, "output"));
  assert.match(stderr.join(""), /core-output failed/u);
  assert.doesNotMatch(stderr.join(""), /completed/u);
  let calls = 0;
  const missing = buildSchemaExporters(exporterRoot, (executable, args) => {
    if (executable === "cargo") return fixtureExport(executable, args);
    calls += 1;
    return { status: null, stdout: null, stderr: undefined, error: new Error("spawn failed") };
  });
  assert.throws(() => exportDesktopSchemas(missing, true), /spawn failed/);
  assert.equal(calls, 1);
});

void test("Desktop malformed envelopes and parity drift produce failed phases", (t) => {
  const stderr: string[] = [];
  t.mock.method(process.stderr, "write", (value: string) => {
    stderr.push(value);
    return true;
  });
  const invalid = buildSchemaExporters(exporterRoot, (executable, args) =>
    executable === "cargo"
      ? fixtureExport(executable, args)
      : { status: 0, stdout: "{}", stderr: "" },
  );
  assert.throws(() => exportDesktopSchemas(invalid, true), /invalid envelope/);
  assert.match(stderr.join(""), /desktop-headless failed/);
  const drifted = buildSchemaExporters(exporterRoot, (executable, args) =>
    executable === "cargo"
      ? fixtureExport(executable, args)
      : {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({
            input: schemas,
            events: schemas,
            output: executable === exporterPaths.native ? { different: {} } : schemas,
          }),
        },
  );
  stderr.length = 0;
  assert.throws(() => exportDesktopSchemas(drifted, true), /differ from/);
  assert.match(stderr.join(""), /desktop-parity started[\s\S]*desktop-parity failed/u);
  assert.doesNotMatch(stderr.join(""), /desktop-parity completed/u);
});

void test("native build or execution failure cannot become successful parity", (t) => {
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
  for (const failBuild of [true, false]) {
    let nativeExecutions = 0;
    const exporters = buildSchemaExporters(exporterRoot, (executable, args) => {
      if (executable === exporterPaths.native) nativeExecutions += 1;
      if (failBuild ? args.includes("portcove-desktop") : executable === exporterPaths.native)
        return { status: 19, stdout: "", stderr: "native failure detail\n" };
      return fixtureExport(executable, args);
    });
    stderr.length = 0;
    assert.throws(
      () => exportDesktopSchemas(exporters, true),
      (error: unknown) => {
        assert.ok(error instanceof Error && "exitCode" in error);
        assert.equal(error.exitCode, 19);
        return true;
      },
    );
    assert.equal(nativeExecutions, failBuild ? 0 : 1);
    assert.match(
      stderr.join(""),
      failBuild ? /build-desktop-native failed/u : /\] desktop-native failed/u,
    );
    assert.match(stderr.join(""), /native failure detail/u);
    assert.doesNotMatch(stderr.join(""), /desktop-parity started/u);
  }
  assert.deepEqual(stdout, []);
});

void test("real missing Cargo CLI preserves spawn diagnostics without undefined-stream errors", () => {
  const module = new URL("./check-transport-contract.mts", import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(module)], {
    env: { ...process.env, PATH: "" },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /build-core-headless failed/);
  assert.match(result.stderr, /ENOENT/);
  assert.doesNotMatch(result.stderr, /TypeError|ERR_INVALID_ARG_TYPE/);
  assert.equal(result.stdout, "");
});

void test("headless export retains required Windows native parity and explicit capable-host parity", (t) => {
  t.mock.method(process.stderr, "write", () => true);
  t.mock.method(process.stdout, "write", () => true);
  for (const [platform, verifyNative, nativeExpected] of [
    ["linux", false, false],
    ["darwin", false, false],
    ["win32", false, true],
    ["linux", true, true],
  ] as const) {
    const calls: { executable: string; args: string[] }[] = [];
    const exporters = buildSchemaExporters(exporterRoot, (executable, args) => {
      calls.push({ executable, args });
      return fixtureExport(executable, args);
    });
    exportDesktopSchemas(exporters, verifyNative, platform);
    assert.equal(
      calls.filter(({ executable }) => executable === "cargo").length,
      nativeExpected ? 2 : 1,
    );
    assert.equal(
      calls.some(({ args }) => args.includes("portcove-desktop")),
      nativeExpected,
    );
    assert.equal(
      calls.some(({ executable }) => executable === exporterPaths.native),
      nativeExpected,
    );
  }
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
