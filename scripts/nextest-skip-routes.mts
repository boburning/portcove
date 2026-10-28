import { readFileSync } from "node:fs";
import { isRecord } from "./runtime-values.mts";
import { runnableNextestTests } from "./nextest-outcomes.mts";

export interface NextestSkipRoute {
  package: string;
  test: string;
  source: string;
  platforms: string[];
  reason: string;
  category: "supervised-parent" | "explicit-acceptance";
  parents?: string[];
  requires_qualification_fixtures?: true;
}

function assertNextestSkipRoute(item: unknown): asserts item is NextestSkipRoute {
  if (
    !isRecord(item) ||
    typeof item.package !== "string" ||
    !/^[a-z0-9-]+$/u.test(item.package) ||
    typeof item.test !== "string" ||
    !/^[a-z0-9_]+$/u.test(item.test) ||
    typeof item.source !== "string" ||
    !/^(crates|apps\/desktop\/src-tauri)\/[a-zA-Z0-9_./-]+\.rs$/u.test(item.source) ||
    item.source.includes("..") ||
    typeof item.reason !== "string" ||
    !item.reason.trim() ||
    item.reason.length > 2048 ||
    !Array.isArray(item.platforms) ||
    !item.platforms.length ||
    item.platforms.some(
      (p: unknown) => typeof p !== "string" || !["linux", "darwin", "win32"].includes(p),
    ) ||
    new Set(item.platforms).size !== item.platforms.length ||
    (item.category !== "supervised-parent" && item.category !== "explicit-acceptance") ||
    (item.requires_qualification_fixtures !== undefined &&
      item.requires_qualification_fixtures !== true)
  )
    throw new Error("Invalid Rust skip route");
  const parents: unknown = item.parents;
  if (item.category === "supervised-parent") {
    if (
      !Array.isArray(parents) ||
      !parents.length ||
      parents.some((p: unknown) => typeof p !== "string" || !/^[a-z0-9_]+$/u.test(p)) ||
      new Set(parents).size !== parents.length
    )
      throw new Error("Supervised Rust skip route requires exact parent cases");
  } else if (parents !== undefined)
    throw new Error("Explicit Rust acceptance cannot imply a supervised parent");
}

export function parseNextestSkipRoutes(value: unknown): NextestSkipRoute[] {
  if (!Array.isArray(value) || !value.length) throw new Error("Rust skip routes are missing");
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    assertNextestSkipRoute(item);
    const key = JSON.stringify([item.package, item.test]);
    if (seen.has(key)) throw new Error("Duplicate Rust skip route");
    seen.add(key);
    return item;
  });
}

export function readNextestSkipRoutes() {
  const value: unknown = JSON.parse(
    readFileSync(new URL("../.config/rust-test-impact.json", import.meta.url), "utf8"),
  );
  return parseNextestSkipRoutes(isRecord(value) ? value.ignored_routes : undefined);
}

/** Route declarations describe intended execution; they never execute ignored cases. */
export function nextestSkipRouteInventory(
  inventory: unknown,
  routes: readonly NextestSkipRoute[],
  {
    platform = process.platform,
    excludeCore = false,
  }: { platform?: string; excludeCore?: boolean } = {},
) {
  runnableNextestTests(inventory);
  if (!isRecord(inventory) || !isRecord(inventory["rust-suites"]))
    throw new Error("Rust skip inventory is incomplete");
  const cases: { package: string; binary: string; name: string; ignored: boolean }[] = [];
  const packages = new Set<string>();
  for (const [binary, suite] of Object.entries(inventory["rust-suites"])) {
    if (!isRecord(suite) || !isRecord(suite.testcases) || typeof suite["package-name"] !== "string")
      throw new Error("Rust skip suite is incomplete");
    packages.add(suite["package-name"]);
    for (const [name, detail] of Object.entries(suite.testcases)) {
      if (!isRecord(detail) || typeof detail.ignored !== "boolean")
        throw new Error("Rust skip case is incomplete");
      cases.push({ package: suite["package-name"], binary, name, ignored: detail.ignored });
    }
  }
  const errors = new Set<string>();
  const problem = (message: string) => {
    if (errors.size < 32) errors.add(message);
  };
  const matches = (packageName: string, name: string) =>
    cases.filter((c) => c.package === packageName && c.name.split("::").at(-1) === name);
  const key = (packageName: string, name: string) => JSON.stringify([packageName, name]);
  for (const packageName of new Set(routes.map((route) => route.package))) {
    if (excludeCore && packageName === "portcove-core") continue;
    if (!packages.has(packageName)) problem("Rust skip package scope disappeared: " + packageName);
  }
  const contracts = routes.flatMap((route) => {
    if ((excludeCore && route.package === "portcove-core") || !packages.has(route.package))
      return [];
    const observed = matches(route.package, route.test);
    if (!route.platforms.includes(platform)) {
      if (observed.length)
        problem(
          "Rust platform skip appeared outside its declared route: " +
            key(route.package, route.test),
        );
      return [];
    }
    if (!observed.length && route.requires_qualification_fixtures)
      return [
        {
          ...route,
          observation: "not_evaluated_feature",
          identity: null,
          intended_parents: [] as string[],
        },
      ];
    if (observed.length !== 1 || !observed[0]?.ignored)
      problem(
        "Declared Rust skip is missing, ambiguous or no longer ignored: " +
          key(route.package, route.test),
      );
    const intendedParents = (route.parents ?? []).flatMap((parent) => {
      const found = matches(route.package, parent);
      if (
        found.length !== 1 ||
        (found[0]?.ignored &&
          !routes.some(
            (r) =>
              r.package === route.package &&
              r.test === parent &&
              r.category === "explicit-acceptance",
          ))
      )
        problem(
          "Rust skip parent route is missing, ambiguous or unowned: " + key(route.package, parent),
        );
      return found.map((c) => JSON.stringify([c.package, c.binary, c.name]));
    });
    return [
      {
        ...route,
        observation:
          observed.length === 1 && observed[0]?.ignored ? "declared_ignored" : "missing_or_changed",
        identity: observed[0]
          ? JSON.stringify([observed[0].package, observed[0].binary, observed[0].name])
          : null,
        intended_parents: intendedParents,
      },
    ];
  });
  for (const c of cases) {
    if (
      c.ignored &&
      !routes.some((r) => r.package === c.package && r.test === c.name.split("::").at(-1))
    )
      problem("Unregistered Rust skip: " + JSON.stringify([c.package, c.binary, c.name]));
  }
  return { evaluation: "compiled_current_platform_package_scope", contracts, errors: [...errors] };
}
