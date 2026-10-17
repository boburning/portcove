import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import type { Context, RunningCodeInNewContextOptions } from "node:vm";
import { executeBrowserScript } from "../apps/desktop/scripts/browser-script.mts";
import { errorCode, errorMessage } from "./runtime-values.mts";

/** Source-slice tests execute the same erased JavaScript that native Node loads. */
export function runTypeScriptInNewContext(
  source: string,
  context: Context = {},
  options?: RunningCodeInNewContextOptions,
): unknown {
  for (const [name, value] of Object.entries({ executeBrowserScript, errorCode, errorMessage }))
    if (!Object.hasOwn(context, name)) context[name] = value;
  return runInNewContext(stripTypeScriptTypes(source, { mode: "strip" }), context, options);
}
