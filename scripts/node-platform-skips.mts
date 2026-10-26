import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import type { NodePlatformSkipContract } from "./node-test-suites.mts";

function terminalNodeEvent(event: unknown) {
  if (
    !isRecord(event) ||
    (event.type !== "test:pass" && event.type !== "test:fail") ||
    !isRecord(event.data) ||
    !isRecord(event.data.details) ||
    typeof event.data.entryFile !== "string"
  )
    return null;
  return {
    data: event.data,
    details: event.data.details,
    entryFile: event.data.entryFile,
    failed: event.type === "test:fail",
  };
}

/** Declared platform ownership is separate from the runner's original skip reason. */
export function createNodePlatformSkipInventory(
  requested: readonly string[],
  filters: readonly string[],
  contracts: Readonly<Record<string, NodePlatformSkipContract | NodePlatformSkipContract[]>>,
  {
    root = process.cwd(),
    platform = process.platform,
    registered = Object.keys(contracts),
    environment = process.env,
  }: {
    root?: string;
    platform?: NodeJS.Platform;
    registered?: readonly string[];
    environment?: Readonly<Record<string, string | undefined>>;
  } = {},
) {
  const identity = (file: string) => {
    const absolute = path.resolve(root, file);
    return platform === "win32" ? absolute.toLowerCase() : absolute;
  };
  const selected = new Set(requested.map((file) => identity(path.resolve(file))));
  const files = new Map(
    [...new Set([...registered, ...Object.keys(contracts)])]
      .filter((file) => selected.has(identity(file)))
      .map((file) => {
        const value = contracts[file];
        const routes = Array.isArray(value) ? value : value ? [value] : [];
        return [
          identity(file),
          {
            file,
            routes,
            seen: new Map<string, number>(),
            reasons: new Map<string, string | null>(),
          },
        ] as const;
      }),
  );
  const eligible = (contract: NodePlatformSkipContract) =>
    contract.platform === "any" ||
    contract.platform === platform ||
    (contract.platform === "posix" && platform !== "win32");
  const errors = new Set<string>();
  const problem = (message: string) => {
    if (errors.size < 32) errors.add(message);
  };
  return {
    capture(event: unknown) {
      // Filters cannot prove full family presence; the registry requires an unfiltered owner.
      if (filters.length) return;
      const observed = terminalNodeEvent(event);
      if (!observed) return;
      const { data, details } = observed;
      const owner = files.get(identity(observed.entryFile));
      if (!owner) return;
      const skipped = data.skip === true || typeof data.skip === "string";
      const deferred = data.todo === true || typeof data.todo === "string";
      if (details.type === "suite") {
        if (skipped || deferred) problem("Unregistered skipped or todo suite in " + owner.file);
        return;
      }
      if (details.type !== "test") return;
      const route =
        data.nesting === 0 && typeof data.name === "string"
          ? owner.routes.find((contract) => contract.cases.includes(data.name as string))
          : undefined;
      if (!route) {
        if (skipped || deferred) problem("Unregistered skipped or todo case in " + owner.file);
        return;
      }
      const name = data.name as string;
      owner.seen.set(name, (owner.seen.get(name) ?? 0) + 1);
      owner.reasons.set(name, typeof data.skip === "string" ? data.skip : null);
      // A forced acceptance with missing prerequisites must retain its actual failure.
      if (observed.failed && !skipped && !deferred) return;
      const category = route.category ?? "platform";
      const missingPrerequisite =
        category === "explicit-acceptance" &&
        route.required_environment?.some((key) => !environment[key]?.trim());
      const expectedSkip = !eligible(route) || missingPrerequisite;
      const admittedPrerequisiteSkip =
        eligible(route) &&
        category === "prerequisite" &&
        skipped &&
        typeof data.skip === "string" &&
        typeof route.skip_reason_prefix === "string" &&
        data.skip.startsWith(route.skip_reason_prefix);
      if (deferred || (skipped !== Boolean(expectedSkip) && !admittedPrerequisiteSkip))
        problem("Platform skip differs from intended execution route: " + owner.file + ": " + name);
    },
    finish() {
      const rows = [...files.values()].flatMap(({ file, routes, seen, reasons }) =>
        routes.flatMap((contract) =>
          contract.cases.map((name) => {
            const observations = seen.get(name) ?? 0;
            if (!filters.length && observations !== 1)
              problem("Declared platform case missing or ambiguous: " + file + ": " + name);
            return {
              file,
              name,
              category: contract.category ?? "platform",
              platform: contract.platform,
              prerequisite: contract.prerequisite,
              reason: contract.reason,
              qualification_owner: contract.owner,
              intended_route: contract.intended_route ?? contract.owner,
              required_environment: contract.required_environment ?? [],
              original_skip_reason: reasons.get(name) ?? null,
              observations,
            };
          }),
        ),
      );
      return {
        evaluation: filters.length ? "not_evaluated_filtered_invocation" : "complete_invocation",
        contracts: rows,
        errors: [...errors],
      };
    },
  };
}
