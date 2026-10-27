import { isRecord } from "./runtime-values.mts";
const ordered = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export interface RustTimingHints {
  format_version: 1;
  default_seconds: number;
  families: [string, string, number][];
  tests: [string, string, number][];
}
export interface RustTestPartition {
  id: number;
  estimated_seconds: number;
  tests: string[];
}

export function parseRustTestIdentity(value: unknown): [string, string, string] {
  if (typeof value !== "string") throw new Error("Invalid Rust test identity");
  const parts: unknown = JSON.parse(value);
  if (
    !Array.isArray(parts) ||
    parts.length !== 3 ||
    !parts.every((part) => typeof part === "string" && part.length > 0 && part.length < 4096) ||
    JSON.stringify(parts) !== value
  )
    throw new Error("Invalid Rust test identity");
  return parts as [string, string, string];
}

export function rustTestIdentities(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100000)
    throw new Error("Rust test identities must be nonempty and bounded");
  const result = value.map((entry) => {
    parseRustTestIdentity(entry);
    return String(entry);
  });
  if (new Set(result).size !== result.length) throw new Error("Duplicate Rust test identity");
  return result;
}

export function validateRustTimingHints(value: unknown): RustTimingHints {
  const positive = (number: unknown) =>
    typeof number === "number" && Number.isFinite(number) && number > 0 && number < 3600;
  if (
    !isRecord(value) ||
    value.format_version !== 1 ||
    !positive(value.default_seconds) ||
    ![value.families, value.tests].every(
      (rows) =>
        Array.isArray(rows) &&
        rows.length < 10000 &&
        rows.every(
          (row: unknown) =>
            Array.isArray(row) &&
            row.length === 3 &&
            typeof row[0] === "string" &&
            typeof row[1] === "string" &&
            positive(row[2]),
        ),
    )
  )
    throw new Error("Invalid bounded Rust scheduling hints");
  return value as unknown as RustTimingHints;
}

/** Hints affect scheduling only; every current selected identity is assigned exactly once. */
export function partitionRustTests(selected: string[], hints: RustTimingHints, maximumWorkers = 8) {
  const tests = rustTestIdentities(selected);
  validateRustTimingHints(hints);
  if (!Number.isInteger(maximumWorkers) || maximumWorkers < 1 || maximumWorkers > 8)
    throw new Error("Windows Rust workers must be between one and eight");
  const exact = new Map(
    hints.tests.map(([binary, name, seconds]) => [JSON.stringify([binary, name]), seconds]),
  );
  const weighted = tests.map((identity) => {
    const [, binary, name] = parseRustTestIdentity(identity);
    const family = hints.families
      .filter(([candidate, prefix]) => candidate === binary && name.startsWith(prefix))
      .sort((left, right) => right[1].length - left[1].length)[0];
    return {
      identity,
      seconds: exact.get(JSON.stringify([binary, name])) ?? family?.[2] ?? hints.default_seconds,
    };
  });
  // Avoid eight runner startups for a small focused change. Broad suites use all eight.
  const count = Math.min(
    maximumWorkers,
    tests.length,
    Math.max(1, Math.ceil(weighted.reduce((total, test) => total + test.seconds, 0) / 180)),
  );
  const partitions: RustTestPartition[] = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    estimated_seconds: 0,
    tests: [],
  }));
  for (const test of weighted.sort(
    (left, right) => right.seconds - left.seconds || ordered(left.identity, right.identity),
  )) {
    const partition = [...partitions].sort(
      (left, right) => left.estimated_seconds - right.estimated_seconds || left.id - right.id,
    )[0];
    if (!partition) throw new Error("Missing Windows Rust partition");
    partition.tests.push(test.identity);
    partition.estimated_seconds += test.seconds;
  }
  return partitions.map((partition) => ({
    ...partition,
    estimated_seconds: Math.round(partition.estimated_seconds * 1000) / 1000,
    tests: partition.tests.sort(ordered),
  }));
}

export function assertSameRustTestIdentities(
  actual: Set<string>,
  expected: readonly string[],
  label: string,
) {
  if (actual.size !== expected.length || expected.some((test) => !actual.has(test)))
    throw new Error(`${label} differs from its complete expected inventory`);
}

export function rustTestIdentityFilter(tests: string[]) {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
  const binaries = new Map<string, string[]>();
  for (const identity of rustTestIdentities(tests)) {
    const [, binary, name] = parseRustTestIdentity(identity);
    const names = binaries.get(binary) ?? [];
    names.push(escape(name));
    binaries.set(binary, names);
  }
  const filter = [...binaries]
    .sort(([left], [right]) => ordered(left, right))
    .map(
      ([binary, names]) =>
        `(binary_id(/^${escape(binary)}$/) & test(/^(?:${names.sort(ordered).join("|")})$/))`,
    )
    .join(" | ");
  return filter;
}

/** Keep the original profile and every resource/timeout override around the bounded filter. */
export function rustPartitionConfig(config: string, tests: string[], profile: string) {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(profile)) throw new Error("Invalid Rust execution profile");
  const header = `[profile.${profile}]`;
  if (config.split(header).length !== 2 || /default-filter\s*=/u.test(config))
    throw new Error("Expected one execution profile and no existing default filter");
  return config.replace(
    header,
    `${header}\ndefault-filter = ${JSON.stringify(rustTestIdentityFilter(tests))}`,
  );
}
