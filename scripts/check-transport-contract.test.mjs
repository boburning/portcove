import assert from "node:assert/strict";
import test from "node:test";
import {
  checkDesktopCommandContract,
  checkDesktopEventContract,
  checkTransportContract,
  extractDeclaredDesktopCommands,
  extractDeclaredDesktopEvents,
  extractFrontendDesktopCommands,
  extractFrontendDesktopEvents,
  extractProducedDesktopEvents,
  extractRegisteredDesktopCommands,
} from "./check-transport-contract.mjs";
import { renderTransportSchemas } from "./transport-schemas.mjs";

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
          count: { type: ["integer", "null"] },
          state: { enum: ["ready", "held"] },
        },
      },
    },
  },
};

test("the complete contract is canonical and line-ending independent", () => {
  const rendered = renderTransportSchemas(schemas);
  assert.deepEqual(checkTransportContract(schemas, rendered.replaceAll("\n", "\r\n")), []);
  const reordered = {
    response: Object.fromEntries(Object.entries(schemas.response).reverse()),
  };
  assert.equal(renderTransportSchemas(reordered), rendered);
});

test("nested types, nullability, required presence, arrays and union drift fail closed", () => {
  for (const mutate of [
    (schema) => {
      schema.$defs.Item.properties.count.type = ["string", "null"];
    },
    (schema) => {
      schema.$defs.Item.properties.count.type = "integer";
    },
    (schema) => {
      schema.$defs.Item.required = [];
    },
    (schema) => {
      schema.properties.items.type = "object";
    },
    (schema) => {
      schema.$defs.Item.properties.state.enum.push("unknown");
    },
  ]) {
    const changed = structuredClone(schemas);
    mutate(changed.response);
    assert.equal(checkTransportContract(schemas, renderTransportSchemas(changed)).length, 1);
  }
});

test("invalid or absent schema inventories cannot generate an empty passing contract", () => {
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

test("desktop command declarations, registrations, and literal frontend bindings agree", () => {
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

test("missing, extra, duplicate, and dynamic desktop exposure fails closed", () => {
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

test("aliased, indirect, and out-of-facade invokes fail alongside a complete inventory", () => {
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

test("a coherent registration and frontend rename cannot hide declaration drift", () => {
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

test("unsupported command attributes and unparsed registration syntax fail closed", () => {
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
  `use tauri::Emitter;
   app.emit(DESKTOP_EVENT_APPLICATION_UPDATE_NOTICE, notice);
   app.emit(DESKTOP_EVENT_APPLICATION_UPDATE_NOTICE, cleared);`,
  `use tauri::{Emitter, Manager};
   app.emit(DESKTOP_EVENT_LIBRARY_CHANGED, ());
   app.emit(DESKTOP_EVENT_OPERATION, event);`,
];
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

test("Rust event declarations, Tauri producers, and typed frontend consumers agree", () => {
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
  assert.deepEqual(extractFrontendDesktopEvents(eventFrontendSources), [
    "portcove://application-update-notice",
    "portcove://library-changed",
    "portcove://operation",
  ]);
  assert.deepEqual(
    checkDesktopEventContract({
      declarationSource: eventDeclarationSource,
      producerSources: eventProducerSources,
      frontendSources: eventFrontendSources,
    }),
    [],
  );
});

test("missing, extra, duplicate, dynamic, and direct desktop event consumers fail closed", () => {
  const withoutLibrary = eventFrontendSources.filter(
    (source) => !source.includes('listenDesktopEvent("portcove://library-changed"'),
  );
  assert.match(
    checkDesktopEventContract({
      declarationSource: eventDeclarationSource,
      producerSources: eventProducerSources,
      frontendSources: withoutLibrary,
    }).join("\n"),
    /frontend consumers omit declared events: portcove:\/\/library-changed/,
  );
  assert.match(
    checkDesktopEventContract({
      declarationSource: eventDeclarationSource,
      producerSources: eventProducerSources,
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
        eventFrontendSources.map((source) =>
          source.includes("@tauri-apps/api/event")
            ? source.replace("{ listen }", "{ listen as hiddenListen }")
            : source,
        ),
      ),
    /must directly import and export listen/,
  );
  assert.throws(
    () => extractFrontendDesktopEvents([...eventFrontendSources, eventFrontendSources[0]]),
    /contains duplicates/,
  );
});

test("the independent event fixture rejects a coherent generated rename", () => {
  const renamedDeclaration = eventDeclarationSource.replaceAll(
    "portcove://operation",
    "portcove://renamed-operation",
  );
  const renamedFrontend = eventFrontendSources.map((source) =>
    source.replaceAll("portcove://operation", "portcove://renamed-operation"),
  );
  assert.match(
    checkDesktopEventContract({
      declarationSource: renamedDeclaration,
      producerSources: eventProducerSources,
      frontendSources: renamedFrontend,
    }).join("\n"),
    /independent compatibility fixture omit declared events: portcove:\/\/renamed-operation/,
  );
});

test("unparsed event constants and Tauri producers fail closed", () => {
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
        [...eventProducerSources, `use tauri::Emitter; app.emit(selected_event, payload);`],
        declarations,
      ),
    /emit calls must use a declared event constant/,
  );
  assert.throws(
    () =>
      extractProducedDesktopEvents(
        [
          ...eventProducerSources,
          `use tauri::Emitter as Hidden; app.emit(selected_event, payload);`,
        ],
        declarations,
      ),
    /emit calls must use a declared event constant/,
  );
});
