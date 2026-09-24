// Register native scenario callers without running their browser or CLI callbacks.
// This catches missing required context before desktop-verify starts an expensive build.
import { preparationScenarios } from "./desktop-preparation-test.mjs";

await preparationScenarios({
  browser: {},
  invoke: async () => {},
  scenario: async () => {},
  library: "<preflight-library>",
  output: "<preflight-output>",
  artifacts: [],
  cli: "<preflight-cli>",
  tool: "<preflight-tool>",
  confirmNative: async () => {},
  restartApplication: async () => {},
});

console.log("Native scenario context preflight passed.");
