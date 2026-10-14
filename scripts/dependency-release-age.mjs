import { parseAllDocuments } from "yaml";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { renovateSecurityIntent } from "./renovate-fast-lane.mjs";
import { renderBoundedSummary } from "./report-summary.mjs";

const cooldown = 3 * 24 * 60 * 60 * 1000;

// The packages table owns registry artifacts; snapshots add peer contexts only.
export function lockInventory(text) {
  const documents = parseAllDocuments(text, { uniqueKeys: true });
  if (!documents.length) throw new Error("Empty pnpm lock");
  const inventory = new Map();
  for (const [index, document] of documents.entries()) {
    if (document.errors.length)
      throw new Error(`Malformed pnpm lock: ${document.errors[0].message}`);
    const lock = document.toJS();
    if (
      String(lock?.lockfileVersion) !== "9.0" ||
      !lock.packages ||
      typeof lock.packages !== "object" ||
      Array.isArray(lock.packages)
    )
      throw new Error("Unsupported pnpm lock schema");
    for (const [key, record] of Object.entries(lock.packages)) {
      const identity = key.match(
        /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\([^\r\n]*\))?$/u,
      );
      const resolution = record?.resolution;
      const supported =
        identity &&
        resolution &&
        typeof resolution.integrity === "string" &&
        /^sha(?:1|256|384|512)-[A-Za-z0-9+/]+=*$/u.test(resolution.integrity) &&
        Object.keys(resolution).every((field) => field === "integrity");
      inventory.set(
        `${index}:${key}`,
        supported
          ? { name: identity[1], version: identity[2], integrity: resolution.integrity }
          : { unsupported: key, record },
      );
    }
    for (const [importer, sections] of Object.entries(lock.importers ?? {})) {
      for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
        for (const [name, record] of Object.entries(sections?.[section] ?? {})) {
          if (
            [record?.version, record?.specifier].some(
              (value) =>
                typeof value === "string" &&
                /^(?:link:|file:|workspace:|git(?:\+|:)|https?:|github:|gitlab:|bitbucket:)/u.test(
                  value,
                ),
            )
          ) {
            const key = `${index}:importer:${importer}:${section}:${name}`;
            inventory.set(key, { unsupported: key, record });
          }
        }
      }
    }
  }
  return inventory;
}

export function introducedPackages(base, candidate) {
  const before = lockInventory(base),
    after = lockInventory(candidate);
  const known = new Set(
    [...before.values()]
      .filter((r) => !r.unsupported)
      .map((r) => `${r.name}@${r.version}:${r.integrity}`),
  );
  const changes = new Map();
  for (const [key, record] of after) {
    if (record.unsupported) {
      if (!before.has(key) || JSON.stringify(before.get(key)) !== JSON.stringify(record))
        changes.set(key, record);
    } else if (!known.has(`${record.name}@${record.version}:${record.integrity}`))
      changes.set(`${record.name}@${record.version}`, record);
  }
  return [...changes.values()].sort((a, b) =>
    (a.name ?? a.unsupported).localeCompare(b.name ?? b.unsupported),
  );
}

export async function registryTimes(name) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    signal: AbortSignal.timeout(20000),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
  const metadata = await response.json();
  if (!metadata.time || typeof metadata.time !== "object")
    throw new Error("Registry publication times missing");
  return metadata.time;
}

export async function auditReleaseAge({
  baseLock,
  candidateLock,
  observedAt = new Date().toISOString(),
  timestamps = registryTimes,
  securityIntent = false,
}) {
  const now = Date.parse(observedAt);
  if (!Number.isFinite(now)) throw new Error("Invalid observation time");
  let packages;
  try {
    packages = introducedPackages(baseLock, candidateLock);
  } catch (error) {
    return {
      observedAt,
      minimumAgeDays: 3,
      state: "unknown",
      route: "controlled-review-required",
      findings: [{ state: "unknown", reason: error.message }],
    };
  }
  const cache = new Map(),
    findings = [];
  for (const item of packages) {
    if (item.unsupported) {
      findings.push({
        ...item,
        state: "unknown",
        reason: "Unsupported artifact source or resolution",
      });
      continue;
    }
    try {
      if (!cache.has(item.name))
        cache.set(
          item.name,
          Promise.resolve().then(() => timestamps(item.name)),
        );
      const publishedAt = (await cache.get(item.name))?.[item.version];
      const published =
        typeof publishedAt === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(publishedAt)
          ? Date.parse(publishedAt)
          : NaN;
      if (!Number.isFinite(published))
        throw new Error("Required publication timestamp missing or invalid");
      const eligibleAt = new Date(published + cooldown).toISOString();
      findings.push({
        ...item,
        publishedAt,
        eligibleAt,
        state: now >= published + cooldown ? "eligible" : "young",
      });
    } catch (error) {
      findings.push({ ...item, state: "unknown", reason: error.message });
    }
  }
  const state = findings.some((f) => f.state === "unknown")
    ? "unknown"
    : findings.some((f) => f.state === "young")
      ? "waiting"
      : "eligible";
  return {
    observedAt,
    minimumAgeDays: 3,
    state,
    securityIntent,
    route:
      state === "eligible"
        ? "ordinary"
        : securityIntent
          ? "advisory-backed-controlled-review-required"
          : state === "waiting"
            ? "wait-for-release-age"
            : "controlled-review-required",
    findings,
  };
}

export async function auditGitReleaseAge({ root, base, head, securityIntent = false, ...options }) {
  for (const revision of [base, head])
    if (!/^[a-f0-9]{40}$/u.test(revision ?? ""))
      throw new Error("Age audit requires exact base and head SHAs");
  const read = (revision) =>
    execFileSync("git", ["show", `${revision}:pnpm-lock.yaml`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
  return {
    base,
    head,
    ...(await auditReleaseAge({
      baseLock: read(base),
      candidateLock: read(head),
      securityIntent,
      ...options,
    })),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== "--base" || args[2] !== "--head")
      throw new Error("Usage: dependency-release-age.mjs --base SHA --head SHA");
    const event = process.env.GITHUB_EVENT_PATH
      ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
      : {};
    const securityIntent = renovateSecurityIntent(event.pull_request ?? {});
    const report = await auditGitReleaseAge({
      root: process.cwd(),
      base: args[1],
      head: args[3],
      securityIntent,
    });
    const directory = path.resolve("work/dependency-age");
    mkdirSync(directory, { recursive: true });
    const reference = path.join(directory, `${randomUUID()}.json`);
    writeFileSync(reference, JSON.stringify(report), { flag: "wx" });
    console.log(
      renderBoundedSummary(
        `Locked dependency age: ${report.state}; ${report.route}`,
        report.findings.map(
          (f) =>
            `${f.name ?? f.unsupported}@${f.version ?? "unknown"}: ${f.state}; ${f.eligibleAt ?? f.reason}`,
        ),
        { reference },
      ).text,
    );
    if (report.state !== "eligible" && !securityIntent) process.exitCode = 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
