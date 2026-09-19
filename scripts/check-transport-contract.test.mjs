import assert from "node:assert/strict";
import test from "node:test";
import {
  checkDesktopCommandContract,
  checkTransportContract,
  extractDeclaredDesktopCommands,
  extractFrontendDesktopCommands,
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
    /duplicate commands: set_policy/,
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
