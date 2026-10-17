import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Reporter } from "vite-plus/test/node";
import { resolvePhysicalPath } from "./dev-storage.mts";

/** One invocation owns one namespace; previous failures never share its names. */
export function createBrowserTraceRun(root: string, requestedNamespace?: string) {
  const traceRoot = path.resolve(root, "work/bt");
  const physicalRoot = resolvePhysicalPath(root);
  const physicalTraceRoot = resolvePhysicalPath(traceRoot);
  const relative = path.relative(physicalRoot, physicalTraceRoot);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
    throw new Error("Browser trace root resolves outside the checkout");
  const parent = requestedNamespace ? path.resolve(requestedNamespace) : traceRoot;
  const physicalParent = resolvePhysicalPath(parent);
  if (
    requestedNamespace &&
    (path.dirname(physicalParent) !== physicalTraceRoot ||
      !/^run-[A-Za-z0-9-]+$/u.test(path.basename(parent)))
  )
    throw new Error("Browser trace namespace must be an owned run below the trace root");
  const directory = path.join(parent, `run-${randomUUID()}`);
  const physicalDirectory = path.join(physicalParent, path.basename(directory));
  if (existsSync(directory)) throw new Error("Browser trace namespace already exists");
  const reporter = {
    onTestRunEnd(_modules, _errors, reason) {
      if (reason !== "passed" || !existsSync(directory)) return;
      // Recheck physical identity immediately before deleting this invocation's
      // successful raw resources. Keep failed retries even if the run passed.
      if (
        resolvePhysicalPath(parent) !== physicalParent ||
        resolvePhysicalPath(directory) !== physicalDirectory
      )
        throw new Error("Browser trace namespace changed physical identity");
      if (
        readdirSync(directory, { recursive: true, withFileTypes: true }).some(
          (file) =>
            file.isFile() &&
            (file.name.endsWith(".zip") ||
              path.relative(directory, file.parentPath).split(path.sep)[0] === "screenshots"),
        )
      )
        return;
      rmSync(directory, { recursive: true });
    },
  } satisfies Reporter;
  return { directory, reporter };
}
