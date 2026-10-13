import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export function captureCheckoutContext(root, { git = execFileSync, read = readFileSync } = {}) {
  const invoke = (args) =>
    git("git", args, { cwd: root, encoding: "utf8", timeout: 15000, windowsHide: true }).trim();
  const catalog = path.join(root, "crates/portcove-core/catalog/catalog.json");
  const configuration = path.join(root, ".github/roadmap.json");
  const digest = (file) => createHash("sha256").update(read(file)).digest("hex");
  return {
    root: path.resolve(invoke(["rev-parse", "--show-toplevel"])),
    head: invoke(["rev-parse", "HEAD"]),
    branch: invoke(["rev-parse", "--abbrev-ref", "HEAD"]),
    catalog,
    catalog_sha256: digest(catalog),
    configuration_sha256: digest(configuration),
    input_dirty: Boolean(
      invoke([
        "status",
        "--porcelain",
        "--",
        "crates/portcove-core/catalog/catalog.json",
        ".github/roadmap.json",
      ]),
    ),
  };
}

export function assertCheckoutContext(context, expectedHead) {
  if (expectedHead !== undefined) {
    if (!/^[a-f0-9]{40}$/u.test(expectedHead))
      throw new Error("--expected-head must be a full lowercase Git SHA");
    if (context.head !== expectedHead)
      throw new Error(
        `Checkout mismatch: expected ${expectedHead}, observed ${context.head}; Project drift was not assessed`,
      );
    if (context.input_dirty)
      throw new Error("Guarded Roadmap inputs are modified; Project drift was not assessed");
  }
}

export function assertCheckoutUnchanged(before, after) {
  for (const key of ["root", "head", "catalog_sha256", "configuration_sha256", "input_dirty"])
    if (before[key] !== after[key])
      throw new Error("Checkout inputs changed during Roadmap doctor; no stable result claimed");
}

export async function checkContextualDoctor({ capture, check, expectedHead, report = () => {} }) {
  const context = capture();
  report(context);
  assertCheckoutContext(context, expectedHead);
  const result = await check();
  assertCheckoutUnchanged(context, capture());
  return { context, result };
}
