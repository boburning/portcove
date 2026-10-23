import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export interface GuardedCheckoutContext {
  root: string;
  head: string;
  catalog_sha256: string;
  configuration_sha256: string;
  input_dirty: boolean;
}

export function captureCheckoutContext(
  root: string,
  {
    git = execFileSync,
    read = readFileSync,
  }: { git?: typeof execFileSync; read?: typeof readFileSync } = {},
) {
  const invoke = (args: readonly string[]) =>
    git("git", args, { cwd: root, encoding: "utf8", timeout: 15000, windowsHide: true }).trim();
  const catalog = path.join(root, "crates/portcove-core/catalog/catalog.json");
  const configuration = path.join(root, ".github/roadmap.json");
  const digest = (file: string) => createHash("sha256").update(read(file)).digest("hex");
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

function assertCheckoutContext(context: GuardedCheckoutContext, expectedHead?: string) {
  if (expectedHead !== undefined) {
    if (!/^[a-f0-9]{40}$/u.test(expectedHead))
      throw new Error("--expected-head must be a full lowercase Git SHA");
    if (context.head !== expectedHead)
      throw Object.assign(
        new Error(
          `Checkout mismatch: expected ${expectedHead}, observed ${context.head}; Project drift was not assessed`,
        ),
        { code: "checkout_context" },
      );
    if (context.input_dirty)
      throw Object.assign(
        new Error("Guarded Roadmap inputs are modified; Project drift was not assessed"),
        { code: "checkout_context" },
      );
  }
}

function assertCheckoutUnchanged(before: GuardedCheckoutContext, after: GuardedCheckoutContext) {
  for (const key of [
    "root",
    "head",
    "catalog_sha256",
    "configuration_sha256",
    "input_dirty",
  ] as const)
    if (before[key] !== after[key])
      throw Object.assign(
        new Error("Checkout inputs changed during Roadmap doctor; no stable result claimed"),
        { code: "checkout_context" },
      );
}

export async function checkContextualDoctor<Result, Context extends GuardedCheckoutContext>({
  capture,
  check,
  expectedHead,
  report = () => {},
}: {
  capture: () => Context;
  check: () => Result | Promise<Result>;
  expectedHead?: string | undefined;
  report?: (context: Context) => void;
}) {
  const context = capture();
  report(context);
  assertCheckoutContext(context, expectedHead);
  const result = await check();
  assertCheckoutUnchanged(context, capture());
  return { context, result };
}
