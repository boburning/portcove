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

/** Declared identities cover top-level cases or one named suite; deeper trees remain unregistered. */
export function nodeCaseSelected(
  name: string,
  arguments_: readonly string[],
  suite?: string,
): boolean | null {
  const include: RegExp[] = [],
    exclude: RegExp[] = [];
  try {
    for (let index = 0; index < arguments_.length; index++) {
      const argument = arguments_[index] ?? "";
      const option = argument.match(/^--test-(name|skip)-pattern(?:=(.*))?$/u);
      if (!option) continue;
      const value = option[2] ?? arguments_[++index];
      if (value === undefined) return null;
      const literal = value.match(/^\/(.*)\/([a-z]*)$/u);
      const flags = literal?.[2] ?? "";
      if (/[gy]/u.test(flags)) return null;
      const pattern = new RegExp(literal?.[1] ?? value, flags);
      (option[1] === "name" ? include : exclude).push(pattern);
    }
  } catch {
    return null;
  }
  const names = suite === undefined ? [name] : [name, suite, `${suite} ${name}`];
  const matches = (pattern: RegExp) => names.some((candidate) => pattern.test(candidate));
  return (!include.length || include.some(matches)) && !exclude.some(matches);
}

/** Declared routes remain separate from original outcomes and prerequisite authority. */
export function createNodePlatformSkipInventory(
  requested: readonly string[],
  filters: readonly string[],
  contracts: Readonly<Record<string, NodePlatformSkipContract | NodePlatformSkipContract[]>>,
  {
    root = process.cwd(),
    platform = process.platform,
    registered = Object.keys(contracts),
    environment = process.env,
    uid = process.getuid?.(),
  }: {
    root?: string;
    platform?: NodeJS.Platform;
    registered?: readonly string[];
    environment?: Readonly<Record<string, string | undefined>>;
    uid?: number;
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
    typeof contract.platform === "string"
      ? contract.platform === platform
      : contract.platform.some((target) => target === platform);
  const errors = new Set<string>();
  const problem = (message: string) => {
    if (errors.size < 32) errors.add(message);
  };
  return {
    capture(event: unknown) {
      // Filters can select declared top-level names, never prove the whole family.
      const observed = terminalNodeEvent(event);
      if (!observed) return;
      const { data, details } = observed;
      const owner = files.get(identity(observed.entryFile));
      if (!owner) return;
      if (typeof data.name !== "string") return;
      const skipped = data.skip === true || typeof data.skip === "string";
      const deferred = data.todo === true || typeof data.todo === "string";
      if (details.type === "suite") {
        if (skipped || deferred) problem("Unregistered skipped or todo suite in " + owner.file);
        return;
      }
      if (details.type !== "test") return;
      const route = owner.routes.find(
        (contract) =>
          contract.cases.includes(data.name as string) &&
          (contract.suite === undefined
            ? data.nesting === 0
            : data.nesting === 1 && details.classname === contract.suite),
      );
      if (!route) {
        if (skipped || deferred) problem("Unregistered skipped or todo case in " + owner.file);
        return;
      }
      const name = data.name;
      owner.seen.set(name, (owner.seen.get(name) ?? 0) + 1);
      owner.reasons.set(name, typeof data.skip === "string" ? data.skip : null);
      // A forced acceptance with missing prerequisites must retain its actual failure.
      if (observed.failed && !skipped && !deferred) return;
      const category = route.category ?? "platform";
      const missingPrerequisite =
        category === "explicit-acceptance" &&
        route.required_environment?.some((key) => !environment[key]?.trim());
      const missingOwner = route.requires_non_root === true && (uid === undefined || uid === 0);
      const expectedSkip = !eligible(route) || missingPrerequisite || missingOwner;
      const admittedPrerequisiteSkip =
        eligible(route) &&
        category !== "platform" &&
        !route.requires_non_root &&
        !route.required_environment?.length &&
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
            const selected = nodeCaseSelected(name, filters, contract.suite);
            if (selected === true && observations !== 1)
              problem("Declared platform case missing or ambiguous: " + file + ": " + name);
            return {
              file,
              name,
              ...(contract.suite === undefined ? {} : { suite: contract.suite }),
              category: contract.category ?? "platform",
              platform: contract.platform,
              prerequisite: contract.prerequisite,
              reason: contract.reason,
              qualification_owner: contract.owner,
              intended_route: contract.intended_route ?? contract.owner,
              required_environment: contract.required_environment ?? [],
              original_skip_reason: reasons.get(name) ?? null,
              selected,
              requires_non_root: contract.requires_non_root ?? false,
              observations,
            };
          }),
        ),
      );
      return {
        evaluation: filters.length ? "not_evaluated_filtered_invocation" : "complete_invocation",
        declared_route_evaluation: rows.some((row) => row.selected === null)
          ? "not_evaluated_unsupported_filter"
          : "evaluated_selected_declared_routes",
        contracts: rows,
        errors: [...errors],
      };
    },
  };
}
