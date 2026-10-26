import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import type { NodePlatformSkipContract } from "./node-test-suites.mts";

/** Declared platform ownership is separate from the runner's original skip reason. */
export function createNodePlatformSkipInventory(
  requested: readonly string[],
  filters: readonly string[],
  contracts: Readonly<Record<string, NodePlatformSkipContract>>,
  {
    root = process.cwd(),
    platform = process.platform,
  }: { root?: string; platform?: NodeJS.Platform } = {},
) {
  const identity = (file: string) => {
    const absolute = path.resolve(root, file);
    return platform === "win32" ? absolute.toLowerCase() : absolute;
  };
  const selected = new Set(requested.map((file) => identity(path.resolve(file))));
  const files = new Map(
    Object.entries(contracts)
      .filter(([file]) => selected.has(identity(file)))
      .map(
        ([file, contract]) =>
          [identity(file), { file, contract, seen: new Map<string, number>() }] as const,
      ),
  );
  const errors = new Set<string>();
  const problem = (message: string) => {
    if (errors.size < 32) errors.add(message);
  };
  return {
    capture(event: unknown) {
      // Filters cannot prove full family presence; the registry requires an unfiltered owner.
      if (
        filters.length ||
        !isRecord(event) ||
        (event.type !== "test:pass" && event.type !== "test:fail") ||
        !isRecord(event.data) ||
        !isRecord(event.data.details) ||
        event.data.details.type !== "test" ||
        typeof event.data.entryFile !== "string"
      )
        return;
      const data = event.data;
      const owner = files.get(identity(data.entryFile as string));
      if (!owner) return;
      const skipped = data.skip === true || typeof data.skip === "string";
      const deferred = data.todo === true || typeof data.todo === "string";
      const known =
        data.nesting === 0 &&
        typeof data.name === "string" &&
        owner.contract.cases.includes(data.name);
      if (!known) {
        if (skipped || deferred) problem("Unregistered skipped or todo case in " + owner.file);
        return;
      }
      const name = data.name as string;
      owner.seen.set(name, (owner.seen.get(name) ?? 0) + 1);
      if (deferred || skipped !== (platform !== owner.contract.platform))
        problem("Platform skip differs from intended execution route: " + owner.file + ": " + name);
    },
    finish() {
      const rows = [...files.values()].flatMap(({ file, contract, seen }) =>
        contract.cases.map((name) => {
          const observations = seen.get(name) ?? 0;
          if (!filters.length && observations !== 1)
            problem("Declared platform case missing or ambiguous: " + file + ": " + name);
          return {
            file,
            name,
            category: "platform" as const,
            platform: contract.platform,
            prerequisite: contract.prerequisite,
            reason: contract.reason,
            qualification_owner: contract.owner,
            observations,
          };
        }),
      );
      return {
        evaluation: filters.length ? "not_evaluated_filtered_invocation" : "complete_invocation",
        contracts: rows,
        errors: [...errors],
      };
    },
  };
}
