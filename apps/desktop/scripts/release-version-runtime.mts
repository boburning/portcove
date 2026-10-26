import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireFromPolicy = createRequire(import.meta.url);
export function semverRuntime(): typeof import("semver") {
  return requireFromPolicy(fileURLToPath(import.meta.resolve("semver"))) as typeof import("semver");
}
