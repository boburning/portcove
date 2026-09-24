// Kept free of browser and driver dependencies so repository-tool tests can
// reject incomplete scenario wiring on hosts that do not install Selenium.
export function assertSteamEntryContext(context) {
  for (const member of [
    "browser",
    "invoke",
    "scenario",
    "output",
    "artifacts",
    "command",
    "seed",
    "open",
    "confirmNative",
  ]) {
    const value = context?.[member];
    const valid =
      member === "output"
        ? typeof value === "string"
        : member === "artifacts"
          ? Array.isArray(value)
          : member === "browser"
            ? value && typeof value === "object"
            : typeof value === "function";
    if (!valid) throw new TypeError(`Steam review scenario requires context.${member}`);
  }
}
