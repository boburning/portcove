import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkRouteFitReport,
  dispositions,
  readRouteFitInputs,
  routeFitReport,
  type Disposition,
  type RouteFitInputs,
  type RouteFitReport,
} from "./catalog-route-fit.mts";
import { parseCatalogSource } from "./catalog-authoring.mts";
import {
  handoffContractVersion,
  handoffContracts,
  handoffPolicyVersion,
  handoffRegistry,
} from "./maintenance-handoffs.mts";
import { isRecord } from "./runtime-values.mts";

/**
 * The derived, read-only program cutover view for the dynamic native ports
 * program (#1422). It projects existing committed facts for operators: the
 * route-fit report (called, never re-derived), title-specific code authorities
 * found mechanically in the repository, the handoff registry and, optionally, a
 * catalog observer report. It writes nothing but an optional output file, reads
 * no network and is not a backlog or status authority: GitHub Projects and the
 * canonical issues keep planning, priority and status.
 *
 * Nothing here names a game. Authority kinds are code shapes with a detector
 * each; the identities a kind covers come from what the detector finds.
 */

export const programViewVersion = "maintenance-program-view/1";

/** Versioned denominator definitions. A change in meaning bumps the version. */
export const denominators = {
  identities: {
    version: "program-view/identities/1",
    definition: "Every catalog identity reported by route fit.",
  },
  inScope: {
    version: "program-view/in-scope/1",
    definition:
      "Catalog identities whose route-fit disposition is not excluded-scummvm (ScummVM onboarding is deferred by engine identity).",
  },
  inScopeEnrolled: {
    version: "program-view/in-scope-enrolled/1",
    definition:
      "In-scope catalog identities with an operational definition or a generated route enrollment (route-fit disposition enrolled).",
  },
  handoffClasses: {
    version: "program-view/handoff-classes/1",
    definition: "Entries of the maintenance handoff registry.",
  },
  observerSources: {
    version: "program-view/observer-sources/1",
    definition: "source_statuses entries of the supplied catalog upstream observer report.",
  },
} as const;

// ---------------------------------------------------------------------------
// Title-specific code authorities.

export interface AuthorityContext {
  /** Every catalog identity. */
  ids: ReadonlySet<string>;
  /** Operational definitions as compiled into the catalog. */
  ports: readonly unknown[];
  /** Catalog listings (id, name, project URL): the dictionary for title-named code. */
  listings?: readonly unknown[];
}

export interface AuthorityFinding {
  /** Repository-relative files where the detector matched. */
  files: string[];
  /** Matched table rows, enum variants or files, by the kind's own unit. */
  entries: number;
  /** Covered identities, or null when the detector cannot derive them. */
  identities: string[] | null;
  /** Expected members (enum, table or file names) found, with their readable rows. */
  members?: Record<string, number>;
  /** Matched entries the detector cannot attribute to identities. */
  unattributed?: string[];
}

export interface AuthorityMember {
  /** An enum, table or file name; never a port identity. */
  name: string;
  /** Declared retired: this member is expected to be absent. */
  retired?: boolean;
}

export interface AuthorityKind {
  kind: string;
  description: string;
  /** The code shape the detector searches, for operators and the rot check. */
  detector: string;
  /** Declared retired: the detector is expected to find nothing. */
  retired: boolean;
  /** Where identities are not derivable, which kind covers them instead. */
  covered_through?: string;
  /** Why an active kind may legitimately cover no catalog identity. */
  no_catalog_consumer?: string;
  /** Each enum, table or file the detector reads; each must be found or retired. */
  members?: readonly AuthorityMember[];
  detect(root: string, context: AuthorityContext): AuthorityFinding;
}

const coreSource = "crates/portcove-core/src";
const typesFile = `${coreSource}/types.rs`;
const historicalArtifactsFile = `${coreSource}/historical-artifacts.json`;
const toolArtifactsFile = "crates/portcove-core/catalog/tool-artifacts.json";
const catalogFile = "crates/portcove-core/catalog/catalog.json";
/** The registry's sections, by name; each is a member the rot check requires. */
const historicalArtifactSections = [
  "dkr",
  "direct",
  "packages",
  "cartridge",
  "forbidden_memories_producer",
] as const;

const toPosix = (path: string) => path.split(sep).join("/");

function walk(root: string, directory: string, accept: (path: string) => boolean): string[] {
  const absolute = join(root, directory);
  let names: string[];
  try {
    names = readdirSync(absolute).toSorted();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = `${directory}/${name}`;
    const stats = statSync(join(root, path));
    if (stats.isDirectory()) return walk(root, path, accept);
    return stats.isFile() && accept(path) ? [path] : [];
  });
}

function readText(root: string, path: string): string | undefined {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return undefined;
  }
}

const sorted = (values: Iterable<string>) => [...new Set(values)].toSorted();
const quotedLiterals = (text: string) =>
  [...text.matchAll(/["'`]([^"'`\n]{1,200})["'`]/gu)].map((match) => match[1]!);

function portRecords(context: AuthorityContext) {
  return context.ports.filter(
    (port): port is Record<string, unknown> => isRecord(port) && typeof port.id === "string",
  );
}

function stringsIn(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === "string") into.add(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, into);
  else if (isRecord(value)) for (const item of Object.values(value)) stringsIn(item, into);
  return into;
}

function releaseRepository(port: Record<string, unknown>) {
  const release = port.release;
  return isRecord(release) && typeof release.repository === "string" && release.repository
    ? release.repository
    : undefined;
}

/**
 * How a `#[cfg(...)]` predicate gates an item: `test` is exactly `cfg(test)`
 * (like a `#[test]` function) and is excluded from every inventory; `feature`
 * is any other predicate that names a Cargo feature (for example
 * `any(test, feature = "...")`) and is inventoried separately; anything else
 * (platform gates, negations) is production code.
 */
export function cfgClass(predicate: string): "test" | "feature" | "production" {
  const trimmed = predicate.trim();
  if (trimmed === "test") return "test";
  if (!/^not\s*\(/u.test(trimmed) && /\bfeature\s*=/u.test(trimmed)) return "feature";
  return "production";
}

interface CfgItem {
  start: number;
  end: number;
  gate: "test" | "feature";
}

/**
 * The end of the item, field, variant or statement that starts at `from`: the
 * first `;` or `,` outside brackets and generics, the brace that closes its own
 * block, or the enclosing block's closing brace (exclusive). String, raw string and character
 * literals and line comments are skipped.
 */
function itemEnd(text: string, from: number): number {
  let depth = 0;
  let angle = 0;
  for (let index = from; index < text.length; index++) {
    const character = text[index];
    const raw = character === "r" ? /^r(#*)"/u.exec(text.slice(index, index + 8)) : null;
    const quoted =
      character === "'" ? /^'(?:\\.|[^\\'\n])'/u.exec(text.slice(index, index + 4)) : null;
    if (raw && !/\w/u.test(text[index - 1] ?? "")) {
      const close = text.indexOf(`"${raw[1]}`, index + raw[0].length);
      index = close === -1 ? text.length : close + raw[1]!.length;
    } else if (quoted) index += quoted[0].length - 1;
    else if (character === '"') {
      for (index++; index < text.length && text[index] !== '"'; index++)
        if (text[index] === "\\") index++;
    } else if (character === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
    } else if (character === "<" && /[\w:]/u.test(text[index - 1] ?? "")) angle++;
    else if (character === ">" && angle > 0 && !/[-=]/u.test(text[index - 1] ?? "")) angle--;
    else if (character === "(" || character === "[" || character === "{") depth++;
    else if (character === ")" || character === "]" || character === "}") {
      if (depth === 0) return index;
      if (--depth === 0 && character === "}") {
        const next = /^\s*[,;]?/u.exec(text.slice(index + 1))![0];
        return (
          index +
          1 +
          (next.trimEnd().endsWith(",") || next.trimEnd().endsWith(";") ? next.length : 0)
        );
      }
    } else if (depth === 0 && (character === ";" || (character === "," && angle === 0)))
      return index + 1;
  }
  return text.length;
}

/** Items attributed `#[test]` or with a test or feature `#[cfg(...)]`. */
function cfgItems(text: string): CfgItem[] {
  const items: CfgItem[] = [];
  const attribute = /#\[(?:cfg\(|test\])/gu;
  for (let match = attribute.exec(text); match; match = attribute.exec(text)) {
    let gate: ReturnType<typeof cfgClass> = "test";
    let after = match.index + match[0].length;
    if (match[0] === "#[cfg(") {
      let depth = 1;
      let close = after;
      for (; close < text.length && depth > 0; close++) {
        if (text[close] === "(") depth++;
        else if (text[close] === ")") depth--;
      }
      gate = cfgClass(text.slice(after, close - 1));
      after = text.indexOf("]", close) + 1;
      if (gate === "production" || after === 0) continue;
    }
    const end = itemEnd(text, after);
    items.push({ start: match.index, end, gate: gate });
    attribute.lastIndex = end;
  }
  return items;
}

/**
 * Splits Rust source into production text and feature-gated text. Pure
 * `#[cfg(test)]` items appear in neither.
 */
export function partitionCfgItems(text: string): { production: string; featureGated: string } {
  let production = "";
  const featureGated: string[] = [];
  let index = 0;
  for (const item of cfgItems(text)) {
    production += text.slice(index, item.start);
    if (item.gate === "feature") featureGated.push(text.slice(item.start, item.end));
    index = item.end;
  }
  return { production: production + text.slice(index), featureGated: featureGated.join("\n") };
}

/** Text with exactly-`#[cfg(test)]` items removed; feature-gated items are kept. */
export function withoutTestItems(text: string): string {
  let result = "";
  let index = 0;
  for (const item of cfgItems(text).filter((entry) => entry.gate === "test")) {
    result += text.slice(index, item.start);
    index = item.end;
  }
  return result + text.slice(index);
}

interface CoreFiles {
  /** Files compiled into production Core. */
  production: string[];
  /** Files compiled only when a non-default Cargo feature is enabled. */
  featureGated: string[];
}

/**
 * Core Rust files by build: test-named files and directories and modules
 * declared under exactly `#[cfg(test)]` are excluded; modules declared under a
 * feature predicate are feature-gated, with everything beneath them.
 */
function coreRustFiles(root: string): CoreFiles {
  const files = walk(root, coreSource, (path) => path.endsWith(".rs"));
  const testNamed = (path: string) =>
    /\/(?:[a-z0-9_]*_)?(?:tests?|testdata)\//u.test(path.slice(coreSource.length)) ||
    /(?:^|[/_])tests?(?:_[a-z0-9_]+)?\.rs$/u.test(path) ||
    /(?:^|\/)test_[a-z0-9_]+\.rs$/u.test(path);
  const gated = new Map<string, "test" | "feature">();
  for (const file of files) {
    const text = readText(root, file) ?? "";
    const base = /(?:^|\/)(?:lib|mod|main)\.rs$/u.test(file)
      ? dirname(file)
      : file.replace(/\.rs$/u, "");
    for (const item of cfgItems(text)) {
      const declaration = /(?:pub(?:\([a-z]+\))?\s+)?mod\s+([a-z0-9_]+)\s*;$/u.exec(
        text.slice(item.start, item.end),
      );
      if (!declaration) continue;
      gated.set(`${base}/${declaration[1]}.rs`, item.gate);
      gated.set(`${base}/${declaration[1]}/`, item.gate);
    }
  }
  const gateOf = (file: string) => {
    let result: "test" | "feature" | undefined;
    for (const [module, gate] of gated)
      if (module.endsWith("/") ? file.startsWith(module) : file === module)
        if (result !== "test") result = gate;
    return result;
  };
  const production: string[] = [];
  const featureGated: string[] = [];
  for (const file of files) {
    if (testNamed(file)) continue;
    const gate = gateOf(file);
    if (gate === undefined) production.push(file);
    else if (gate === "feature") featureGated.push(file);
  }
  return { production, featureGated };
}

const coreIdentityLiterals = (text: string, context: AuthorityContext) =>
  [...text.matchAll(/"([a-z0-9][a-z0-9-]*[a-z0-9])"/gu)]
    .map((match) => match[1]!)
    .filter((literal) => context.ids.has(literal));

interface ParsedEnum {
  variants: { name: string; serialized: string }[];
}

const kebab = (name: string) => name.replace(/(?<!^)([A-Z])/gu, "-$1").toLowerCase();

/** Body of the brace-delimited block opening at or after `from`. */
function braceBlock(text: string, from: number): string {
  const open = text.indexOf("{", from);
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "{") depth++;
    else if (text[index] === "}" && --depth === 0) return text.slice(open + 1, index);
  }
  throw new Error(`Unterminated block at offset ${open}.`);
}

/**
 * Variants of a fieldless `pub enum`, with their serde names. A shape the
 * detector cannot read (another `rename_all`, a variant with fields or a
 * discriminant, an unknown serde attribute) fails loudly instead of dropping
 * variants.
 */
export function parseEnum(text: string, name: string): ParsedEnum | undefined {
  const start = text.search(new RegExp(`pub enum ${name}\\s*\\{`, "u"));
  if (start === -1) return undefined;
  const header = text.slice(Math.max(0, start - 400), start);
  const lastItem = Math.max(header.lastIndexOf("}"), header.lastIndexOf(";"));
  const attributes = header.slice(lastItem + 1);
  const renameAll = /rename_all\s*=\s*"([^"]*)"/u.exec(attributes)?.[1];
  if (renameAll !== undefined && renameAll !== "kebab-case")
    throw new Error(
      `Enum ${name} uses serde rename_all = "${renameAll}", which the authority detector cannot read.`,
    );
  const variants: ParsedEnum["variants"] = [];
  let rename: string | undefined;
  for (const raw of braceBlock(text, start).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    const renamed = /^#\[serde\(rename\s*=\s*"([^"]+)"\)\]$/u.exec(line);
    if (renamed) {
      rename = renamed[1];
      continue;
    }
    if (/^#\[serde\b/u.test(line) || (line.startsWith("#[") && !line.endsWith("]")))
      throw new Error(`Enum ${name} has an attribute the authority detector cannot read: ${line}`);
    if (line.startsWith("#[")) continue;
    const variant = /^([A-Z][A-Za-z0-9]*)\s*,?$/u.exec(line);
    if (!variant)
      throw new Error(
        `Enum ${name} has a variant shape the authority detector cannot read: ${line}`,
      );
    const variantName = variant[1]!;
    variants.push({
      name: variantName,
      serialized: rename ?? (renameAll ? kebab(variantName) : variantName),
    });
    rename = undefined;
  }
  return { variants };
}

function closedEnumKind(
  kind: string,
  enumName: string,
  description: string,
  extra: Pick<AuthorityKind, "no_catalog_consumer"> = {},
): AuthorityKind {
  return {
    kind,
    description,
    detector: `\`pub enum ${enumName}\` variants in ${typesFile}`,
    retired: false,
    members: [{ name: enumName }],
    ...extra,
    detect(root, context) {
      const parsed = parseEnum(readText(root, typesFile) ?? "", enumName);
      if (!parsed) return { files: [], entries: 0, identities: [], members: {} };
      const values = new Set(parsed.variants.map((variant) => variant.serialized));
      const identities = portRecords(context)
        .filter((port) => [...stringsIn(port)].some((value) => values.has(value)))
        .map((port) => port.id as string);
      return {
        files: parsed.variants.length ? [typesFile] : [],
        entries: parsed.variants.length,
        identities: sorted(identities),
        members: { [enumName]: parsed.variants.length },
      };
    },
  };
}

/** Lower-case word tokens of an identifier, file stem or title. */
const words = (value: string) =>
  value
    .replace(/([a-z])([A-Z0-9])/gu, "$1 $2")
    .replace(/([0-9])([A-Za-z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);

/** At most this many identities may share one title key; wider keys are generic. */
const titleKeyIdentityLimit = 6;
/** A family key needs a word used by at most this many Core files. */
const titleWordFileLimit = 3;

interface TitleKeys {
  /** Whole names: an identity, a listing name or a GitHub repository name. */
  whole: Map<string, Set<string>>;
  /** Family keys: contiguous parts of an identity, by their part boundaries. */
  family: Map<string, Map<string, Set<string>>>;
  /** Core files using each word; a family match needs a word rare in Core. */
  coreWordFiles: ReadonlyMap<string, number>;
}

/**
 * Title keys from the catalog itself: each identity, its listing name and its
 * GitHub repository name, plus family keys (contiguous parts of an identity of
 * at least 8 characters). Keys shared by more than `titleKeyIdentityLimit`
 * identities are dropped as generic.
 */
function titleKeys(
  context: AuthorityContext,
  coreWordFiles: ReadonlyMap<string, number>,
): TitleKeys {
  const whole = new Map<string, Set<string>>();
  const family = new Map<string, Map<string, Set<string>>>();
  const add = (key: string, id: string) => {
    if (key.length >= 4) whole.set(key, new Set([...(whole.get(key) ?? []), id]));
  };
  for (const listing of context.listings ?? []) {
    const record = isRecord(listing) && isRecord(listing.listing) ? listing.listing : listing;
    if (!isRecord(record) || typeof record.id !== "string" || !context.ids.has(record.id)) continue;
    const id = record.id;
    add(id.replaceAll("-", ""), id);
    if (typeof record.name === "string") add(words(record.name).join(""), id);
    const repository =
      typeof record.project_url === "string"
        ? /^https:\/\/github\.com\/[^/]+\/([^/#?]+)/u.exec(record.project_url)?.[1]
        : undefined;
    if (repository) add(words(repository.replace(/\.git$/u, "")).join(""), id);
    const parts = id.split("-");
    for (let first = 0; first < parts.length; first++)
      for (let last = first + 1; last <= parts.length; last++) {
        if (first === 0 && last === parts.length) continue;
        const slice = parts.slice(first, last);
        const key = slice.join("");
        if (key.length < 8) continue;
        const variants = family.get(key) ?? new Map<string, Set<string>>();
        const shape = slice.join("-");
        variants.set(shape, new Set([...(variants.get(shape) ?? []), id]));
        family.set(key, variants);
      }
  }
  for (const [key, ids] of whole) if (ids.size > titleKeyIdentityLimit) whole.delete(key);
  for (const [key, variants] of family) {
    const ids = new Set([...variants.values()].flatMap((entry) => [...entry]));
    if (whole.has(key) || ids.size > titleKeyIdentityLimit) family.delete(key);
  }
  return { whole, family, coreWordFiles };
}

const boundaries = (parts: readonly string[]) => {
  const result = new Set<number>();
  let offset = 0;
  for (const part of parts.slice(0, -1)) result.add((offset += part.length));
  return result;
};

/** Production and feature-gated Core Rust text without its test items. */
function coreTitleTexts(root: string) {
  const { production, featureGated } = coreRustFiles(root);
  return new Map(
    [...production, ...featureGated]
      .toSorted()
      .map((file) => [file, withoutTestItems(readText(root, file) ?? "")] as const),
  );
}

/** How many Core files use each word, which keeps common words out of family keys. */
function coreWordFiles(texts: ReadonlyMap<string, string>) {
  const counts = new Map<string, number>();
  for (const text of texts.values())
    for (const word of new Set(words(text))) counts.set(word, (counts.get(word) ?? 0) + 1);
  return counts;
}

/**
 * Identities whose title keys a name spells. A whole key matches any
 * contiguous word group; a family key also needs its part boundaries to fall
 * on word boundaries of the name and a word of the group that is rare in Core,
 * so generic vocabulary does not match.
 */
function titleMatches(name: string, keys: TitleKeys) {
  const parts = words(name);
  const ids = new Set<string>();
  for (let first = 0; first < parts.length; first++)
    for (let last = first + 1; last <= parts.length; last++) {
      const slice = parts.slice(first, last);
      const key = slice.join("");
      for (const id of keys.whole.get(key) ?? []) ids.add(id);
      const variants = keys.family.get(key);
      if (!variants) continue;
      const rare = slice.some(
        (word) =>
          word.length >= 4 &&
          !/^\d+$/u.test(word) &&
          (keys.coreWordFiles.get(word) ?? 0) <= titleWordFileLimit,
      );
      if (!rare) continue;
      const own = boundaries(slice);
      for (const [shape, matched] of variants)
        if ([...boundaries(shape.split("-"))].every((offset) => own.has(offset)))
          for (const id of matched) ids.add(id);
    }
  return ids;
}

/** Variant names of every `enum` in Rust text (depth-one identifiers). */
function enumVariants(text: string): { enumName: string; variant: string }[] {
  const found: { enumName: string; variant: string }[] = [];
  for (const match of text.matchAll(/\benum\s+([A-Z][A-Za-z0-9_]*)\s*(?:<[^>{]*>)?\s*\{/gu)) {
    let depth = 0;
    for (const line of braceBlock(text, match.index).split("\n")) {
      if (line.trim().startsWith("//")) continue;
      const variant = depth === 0 ? /^\s*([A-Z][A-Za-z0-9]*)\b/u.exec(line) : null;
      if (variant) found.push({ enumName: match[1]!, variant: variant[1]! });
      const code = line.replace(/"(?:[^"\\]|\\.)*"/gu, '""').replace(/\/\/.*$/u, "");
      for (const character of code)
        if (character === "{" || character === "(" || character === "[") depth++;
        else if (character === "}" || character === ")" || character === "]") depth--;
    }
  }
  return found;
}

const nativeProfileDirectory = `${coreSource}/native_external_profile`;
const nativeProfileDispatch = `${coreSource}/native_external_profile.rs`;

/** The declared inventory of title-specific authority kinds. */
export const authorityKinds: readonly AuthorityKind[] = [
  {
    kind: "family-generator-script",
    description:
      "Catalog generator or check scripts that select their records by a literal catalog identity or a literal upstream repository of an operational definition.",
    detector:
      "scripts/catalog-*-*.mts (not tests) containing a quoted catalog identity or operational release repository",
    retired: false,
    detect(root, context) {
      const repositories = new Map<string, string[]>();
      for (const port of portRecords(context)) {
        const repository = releaseRepository(port)?.toLowerCase();
        if (repository)
          repositories.set(repository, [
            ...(repositories.get(repository) ?? []),
            port.id as string,
          ]);
      }
      const files: string[] = [];
      const identities = new Set<string>();
      for (const file of walk(
        root,
        "scripts",
        (path) => /^scripts\/catalog-[^/]+-[^/]+\.mts$/u.test(path) && !path.endsWith(".test.mts"),
      )) {
        const found = new Set<string>();
        for (const literal of quotedLiterals(readText(root, file) ?? "")) {
          if (context.ids.has(literal)) found.add(literal);
          const repository = literal
            .replace(/^https:\/\/github\.com\//u, "")
            .replace(/\.git$/u, "")
            .toLowerCase();
          for (const id of repositories.get(repository) ?? []) found.add(id);
        }
        if (found.size) {
          files.push(file);
          for (const id of found) identities.add(id);
        }
      }
      return { files, entries: files.length, identities: sorted(identities) };
    },
  },
  {
    kind: "core-title-literal",
    description:
      "Production Core Rust source that compares or binds a literal catalog identity (exactly-#[cfg(test)] code and feature-gated code excluded).",
    detector: `${coreSource}/**/*.rs production files containing a quoted catalog identity`,
    retired: false,
    detect(root, context) {
      const files: string[] = [];
      const identities = new Set<string>();
      for (const file of coreRustFiles(root).production) {
        const found = coreIdentityLiterals(
          partitionCfgItems(readText(root, file) ?? "").production,
          context,
        );
        if (found.length) {
          files.push(file);
          for (const id of found) identities.add(id);
        }
      }
      return { files, entries: files.length, identities: sorted(identities) };
    },
  },
  {
    kind: "qualification-fixture-title-code",
    description:
      "Core Rust compiled only under a Cargo feature (for example qualification fixtures, including #[cfg(any(test, feature = ...))]) that names a literal catalog identity.",
    detector: `${coreSource}/**/*.rs items or modules gated on a feature predicate containing a quoted catalog identity`,
    retired: false,
    detect(root, context) {
      const { production, featureGated } = coreRustFiles(root);
      const files: string[] = [];
      const identities = new Set<string>();
      const texts = [
        ...production.map(
          (file) => [file, partitionCfgItems(readText(root, file) ?? "").featureGated] as const,
        ),
        ...featureGated.map(
          (file) => [file, withoutTestItems(readText(root, file) ?? "")] as const,
        ),
      ];
      for (const [file, text] of texts) {
        const found = coreIdentityLiterals(text, context);
        if (found.length) {
          files.push(file);
          for (const id of found) identities.add(id);
        }
      }
      return { files, entries: files.length, identities: sorted(identities) };
    },
  },
  {
    kind: "title-named-core-item",
    description:
      "Core enum variants and module files whose names spell a catalog identity, listing name, GitHub repository name or family key (the catalog is the dictionary), so title-specific code stays visible when it binds no literal identity.",
    detector: `enum variant names and *.rs file stems in ${coreSource} (production and feature-gated) matching catalog title keys`,
    retired: false,
    detect(root, context) {
      const texts = coreTitleTexts(root);
      const keys = titleKeys(context, coreWordFiles(texts));
      const files = new Set<string>();
      const identities = new Set<string>();
      let entries = 0;
      for (const [file, text] of texts) {
        const stem = file.slice(file.lastIndexOf("/") + 1).replace(/\.rs$/u, "");
        const names = [stem, ...enumVariants(text).map((entry) => entry.variant)];
        for (const name of names) {
          const matched = titleMatches(name, keys);
          if (!matched.size) continue;
          entries++;
          files.add(file);
          for (const id of matched) identities.add(id);
        }
      }
      return { files: [...files], entries, identities: sorted(identities) };
    },
  },
  closedEnumKind(
    "external-profile-policy",
    "ExternalProfilePolicy",
    "Closed upstream profile resolution variants for managed portable players.",
  ),
  {
    kind: "native-external-profile-module",
    description:
      "Per-runtime native external profile resolver modules, keyed on ExternalProfilePolicy variants.",
    detector: `${nativeProfileDirectory}/*.rs, each keyed on ExternalProfilePolicy in its own text or in a ${nativeProfileDispatch} line that names it`,
    retired: false,
    covered_through: "external-profile-policy",
    detect(root) {
      const files = walk(root, nativeProfileDirectory, (path) => path.endsWith(".rs"));
      const dispatch = (readText(root, nativeProfileDispatch) ?? "").split("\n");
      const unattributed = files.filter((file) => {
        const module = file.slice(file.lastIndexOf("/") + 1).replace(/\.rs$/u, "");
        const own = partitionCfgItems(readText(root, file) ?? "").production;
        return !(
          own.includes("ExternalProfilePolicy") ||
          dispatch.some(
            (line) => line.includes("ExternalProfilePolicy") && line.includes(`${module}::`),
          )
        );
      });
      return { files, entries: files.length, identities: null, unattributed };
    },
  },
  closedEnumKind(
    "managed-initialization",
    "ManagedInitialization",
    "Closed initialization recipes selected by a definition.",
  ),
  closedEnumKind(
    "runtime-data-policy",
    "RuntimeDataPolicy",
    "Closed handling of runtime-owned host credentials selected by a definition.",
  ),
  closedEnumKind(
    "prepared-runtime-settings-contract",
    "PreparedRuntimeSettingsContract",
    "Closed settings contracts for runtimes the player prepares.",
    {
      no_catalog_consumer:
        "Core selects the contract for a player-prepared external runtime; no catalog definition carries its value.",
    },
  ),
  closedEnumKind(
    "prepared-shared-preferences-contract",
    "PreparedSharedPreferencesContract",
    "Closed reviewed shared preference write scopes.",
  ),
  {
    kind: "provider-binding-table",
    description: "Compiled tables binding a port identity to a mod provider's game identity.",
    detector: `\`const *_BINDINGS: &[(&str, ...)]\` tables in ${coreSource}/**/*.rs`,
    retired: false,
    members: [{ name: "COMMUNITY_BINDINGS" }, { name: "GAMEBANANA_BINDINGS" }],
    detect(root, context) {
      const files: string[] = [];
      const identities = new Set<string>();
      const members: Record<string, number> = {};
      let entries = 0;
      for (const file of coreRustFiles(root).production) {
        const text = readText(root, file) ?? "";
        let matched = false;
        for (const table of text.matchAll(
          /const\s+([A-Z0-9_]+_BINDINGS)\s*:\s*&\[\(&str,[^\]]*\]\s*=\s*&\[([\s\S]*?)\];/gu,
        )) {
          matched = true;
          let rows = 0;
          for (const row of table[2]!.matchAll(/\(\s*"([^"]+)"\s*,/gu)) {
            rows++;
            if (context.ids.has(row[1]!)) identities.add(row[1]!);
          }
          members[table[1]!] = (members[table[1]!] ?? 0) + rows;
          entries += rows;
        }
        if (matched) files.push(file);
      }
      return { files, entries, identities: sorted(identities), members };
    },
  },
  {
    kind: "github-mod-source-table",
    description: "Compiled reviewed GitHub mod source rows keyed by runtime repository and game.",
    detector: `\`const SOURCES: &[ReviewedSource]\` rows in ${coreSource}/github_mods.rs`,
    // #8567 moved these rows into each port's `mod_sources` catalog data.
    retired: true,
    members: [{ name: "SOURCES", retired: true }],
    detect(root, context) {
      const file = `${coreSource}/github_mods.rs`;
      const table = /const\s+SOURCES\s*:\s*&\[ReviewedSource\]\s*=\s*&\[([\s\S]*?)\];/u.exec(
        readText(root, file) ?? "",
      );
      if (!table) return { files: [], entries: 0, identities: [], members: {} };
      const rows = [
        ...table[1]!.matchAll(
          /ReviewedSource\s*\{\s*runtime_repository:\s*"([^"]+)",\s*game:\s*"([^"]+)"/gu,
        ),
      ];
      const identities = portRecords(context)
        .filter((port) => {
          const repository = releaseRepository(port)?.toLowerCase();
          const games = stringsIn(port);
          return rows.some((row) => row[1]!.toLowerCase() === repository && games.has(row[2]!));
        })
        .map((port) => port.id as string);
      return {
        files: [file],
        entries: rows.length,
        identities: sorted(identities),
        members: { SOURCES: rows.length },
      };
    },
  },
  {
    kind: "historical-artifact-registry",
    description:
      "Bundled frozen artifact registries read by Core: historical title rows moved out of Rust match arms and the reviewed tool artifacts.",
    detector: `rows of ${historicalArtifactsFile} sections and ${toolArtifactsFile}; a row covers its port_id, projection or catalog release repository, else the catalog title keys its text spells`,
    retired: false,
    members: [
      ...historicalArtifactSections.map((section) => ({
        name: `historical-artifacts.json#${section}`,
      })),
      { name: "tool-artifacts.json" },
    ],
    detect(root, context) {
      const registries: { file: string; member: string; rows: unknown[] }[] = [];
      const historical = readText(root, historicalArtifactsFile);
      if (historical !== undefined) {
        const parsed: unknown = parseCatalogSource(historical);
        if (isRecord(parsed))
          for (const [section, value] of Object.entries(parsed))
            registries.push({
              file: historicalArtifactsFile,
              member: `historical-artifacts.json#${section}`,
              rows: Array.isArray(value) ? value : [value],
            });
      }
      const tools = readText(root, toolArtifactsFile);
      if (tools !== undefined) {
        const parsed: unknown = parseCatalogSource(tools);
        registries.push({
          file: toolArtifactsFile,
          member: "tool-artifacts.json",
          rows: Array.isArray(parsed) ? parsed : [parsed],
        });
      }
      if (!registries.length) return { files: [], entries: 0, identities: [], members: {} };
      const repositories = new Map<string, string[]>();
      // Core binds a historical package by its exact bytes, so a digest that a
      // definition or a port-scoped source contract declares names its subject.
      const digests = new Map<string, Set<string>>();
      const bind = (map: Map<string, Set<string>>, key: string, id: string) =>
        map.set(key, new Set([...(map.get(key) ?? []), id]));
      for (const port of portRecords(context)) {
        const repository = releaseRepository(port)?.toLowerCase();
        if (repository)
          repositories.set(repository, [
            ...(repositories.get(repository) ?? []),
            port.id as string,
          ]);
        for (const value of stringsIn(port)) bind(digests, value.toLowerCase(), port.id as string);
      }
      const catalog = readText(root, catalogFile);
      const scoped = (value: unknown): void => {
        if (Array.isArray(value)) for (const item of value) scoped(item);
        else if (isRecord(value)) {
          if (typeof value.port_id === "string" && context.ids.has(value.port_id))
            for (const text of stringsIn(value)) bind(digests, text.toLowerCase(), value.port_id);
          else for (const item of Object.values(value)) scoped(item);
        }
      };
      if (catalog !== undefined) {
        const parsed: unknown = parseCatalogSource(catalog);
        if (isRecord(parsed)) scoped(parsed.source_catalog);
      }
      let keys: TitleKeys | undefined;
      const identities = new Set<string>();
      const unattributed: string[] = [];
      const members: Record<string, number> = {};
      const files = new Set<string>();
      let entries = 0;
      for (const { file, member, rows } of registries) {
        members[member] = rows.length;
        entries += rows.length;
        if (rows.length) files.add(file);
        // A builder pack is chosen through a definition's admitted projection,
        // not by a title, so an unmatched tool row is counted but names no subject.
        const titleRows = file !== toolArtifactsFile;
        rows.forEach((row, index) => {
          const covered = new Set<string>();
          if (isRecord(row)) {
            for (const field of ["port_id", "projection"])
              if (typeof row[field] === "string" && context.ids.has(row[field]))
                covered.add(row[field]);
            if (typeof row.repository === "string")
              for (const id of repositories.get(row.repository.toLowerCase()) ?? [])
                covered.add(id);
            if (typeof row.sha256 === "string")
              for (const id of digests.get(row.sha256.toLowerCase()) ?? []) covered.add(id);
            if (!covered.size && titleRows) {
              keys ??= titleKeys(context, coreWordFiles(coreTitleTexts(root)));
              for (const value of stringsIn(row))
                for (const id of titleMatches(value, keys)) covered.add(id);
            }
          }
          if (!covered.size && titleRows) unattributed.push(`${member}[${index}]`);
          for (const id of covered) identities.add(id);
        });
      }
      return {
        files: [...files],
        entries,
        identities: sorted(identities),
        members,
        unattributed,
      };
    },
  },
  {
    kind: "external-mod-portals",
    description: "Reviewed per-port external mod portal bindings.",
    detector: "crates/portcove-core/catalog/external-mod-portals.json entries",
    // #8567 moved these bindings into each port's `mod_sources` catalog data.
    retired: true,
    members: [{ name: "external-mod-portals.json", retired: true }],
    detect(root, context) {
      const file = "crates/portcove-core/catalog/external-mod-portals.json";
      const text = readText(root, file);
      if (text === undefined) return { files: [], entries: 0, identities: [], members: {} };
      const rows: unknown = parseCatalogSource(text);
      const entries = Array.isArray(rows) ? rows : [];
      const identities = entries
        .map((entry: unknown) => (isRecord(entry) ? entry.port : undefined))
        .filter((id): id is string => typeof id === "string" && context.ids.has(id));
      return {
        files: entries.length ? [file] : [],
        entries: entries.length,
        identities: sorted(identities),
        members: { "external-mod-portals.json": entries.length },
      };
    },
  },
];

export interface AuthorityReport {
  kind: string;
  description: string;
  detector: string;
  state: "active" | "retired";
  declared_retired: boolean;
  count: number;
  files: string[];
  identities: string[] | null;
  /** Matched entries the detector cannot attribute; any makes the kind's coverage unknown. */
  unattributed: string[];
  covered_through?: string;
  no_catalog_consumer?: string;
  /** Expected members with the rows the detector read; absent members read as null. */
  members?: { name: string; declared_retired: boolean; rows: number | null }[];
  /** Members found that the inventory does not declare. */
  undeclared_members?: string[];
}

export function detectAuthorities(
  root: string,
  context: AuthorityContext,
  kinds: readonly AuthorityKind[] = authorityKinds,
): AuthorityReport[] {
  return kinds.map((kind) => {
    const finding = kind.detect(root, context);
    const found = finding.members ?? {};
    const declared = new Set((kind.members ?? []).map((member) => member.name));
    return {
      kind: kind.kind,
      description: kind.description,
      detector: kind.detector,
      state: finding.entries > 0 ? "active" : "retired",
      declared_retired: kind.retired,
      count: finding.entries,
      files: sorted(finding.files.map(toPosix)),
      identities: finding.identities,
      unattributed: sorted((finding.unattributed ?? []).map(toPosix)),
      ...(kind.covered_through ? { covered_through: kind.covered_through } : {}),
      ...(kind.no_catalog_consumer ? { no_catalog_consumer: kind.no_catalog_consumer } : {}),
      ...(kind.members
        ? {
            members: kind.members.map((member) => ({
              name: member.name,
              declared_retired: member.retired === true,
              rows: found[member.name] ?? null,
            })),
            undeclared_members: sorted(Object.keys(found).filter((name) => !declared.has(name))),
          }
        : {}),
    };
  });
}

/**
 * The inventory cannot rot silently where a detector can tell: a detector that
 * finds nothing must be declared retired, and a kind declared retired must stay
 * empty; an active, derivable kind must cover some identity unless it declares
 * why it has no catalog consumer; and each declared enum, table or file must be
 * found with readable rows or be individually declared retired.
 */
export function authorityInventoryErrors(reports: readonly AuthorityReport[]): string[] {
  const errors: string[] = [];
  const kinds = new Set<string>();
  for (const report of reports) {
    if (kinds.has(report.kind)) errors.push(`Authority kind ${report.kind} is declared twice.`);
    kinds.add(report.kind);
    if (report.state === "retired" && !report.declared_retired)
      errors.push(
        `Authority kind ${report.kind} found nothing (${report.detector}) but is not declared retired; fix the detector or declare the kind retired.`,
      );
    if (report.state === "active" && report.declared_retired)
      errors.push(`Authority kind ${report.kind} is declared retired but its detector matches.`);
    if (report.covered_through && !reports.some((other) => other.kind === report.covered_through))
      errors.push(`Authority kind ${report.kind} names an unknown kind ${report.covered_through}.`);
    if (report.state === "active" && report.identities?.length === 0 && !report.no_catalog_consumer)
      errors.push(
        `Authority kind ${report.kind} matches ${report.count} entries but derives no catalog identity; fix the detector or declare why it has no catalog consumer.`,
      );
    if (report.no_catalog_consumer && report.identities?.length)
      errors.push(
        `Authority kind ${report.kind} declares no catalog consumer but covers ${report.identities.length} identities.`,
      );
    for (const member of report.members ?? []) {
      if (member.rows === null && !member.declared_retired)
        errors.push(
          `Authority kind ${report.kind} cannot find ${member.name}; fix the detector or declare that member retired.`,
        );
      else if (member.rows !== null && member.declared_retired)
        errors.push(
          `Authority kind ${report.kind} member ${member.name} is declared retired but found.`,
        );
      else if (member.rows === 0)
        errors.push(`Authority kind ${report.kind} found ${member.name} but read no rows from it.`);
    }
    for (const name of report.undeclared_members ?? [])
      errors.push(`Authority kind ${report.kind} found undeclared member ${name}; declare it.`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// The view.

export type ProductScope = "in-scope" | "deferred-scummvm";
export const actionClasses = [
  "none",
  "retire-title-authority",
  "resolve-authority-inventory",
  "data-enrollment",
  "observation",
  "bytes-worker",
  "admission",
  "missing-capability",
  "upstream-condition",
  "owner-decision",
] as const;
export type ActionClass = (typeof actionClasses)[number];

const dispositionAction: Record<Exclude<Disposition, "enrolled">, ActionClass> = {
  "data-only": "data-enrollment",
  "needs-bytes-worker": "bytes-worker",
  unobserved: "observation",
  "needs-admission": "admission",
  "missing-capability": "missing-capability",
  "upstream-condition": "upstream-condition",
  "excluded-scummvm": "owner-decision",
};

export interface ProgramSubject {
  id: string;
  scope: ProductScope;
  disposition: Disposition;
  reason: string;
  family: string;
  restrictions: { declared: number; held_operations: string[] };
  /** Title-specific authority kinds that still serve this identity. */
  title_code_paths: string[];
  remaining_action: ActionClass;
}

export interface Ratio {
  numerator: number;
  denominator: { version: string; definition: string; count: number };
  ratio: number | null;
}

export interface CoverageGate extends Ratio {
  gate: string;
  /** `unknown` when a covering authority cannot derive its identities; never passed. */
  state: "passed" | "failed" | "unknown";
  passed: boolean;
  failing: { id: string; detail: string }[];
  /** Identities whose result is unknown; they are not in the numerator. */
  unknown: { id: string; detail: string }[];
  /** Active authority kinds whose covered identities cannot be derived. */
  unknown_kinds: { kind: string; detail: string }[];
}

export type ObserverCoverage =
  | { state: "unknown"; reason: string }
  | {
      state: "reported";
      denominator: Ratio["denominator"];
      by_state: Record<"complete" | "pending" | "partial" | "unavailable" | "failed", number>;
    };

export interface ProgramView {
  format_version: 1;
  view_version: typeof programViewVersion;
  authority: "derived-read-only-projection";
  planning_authority: string;
  inputs: {
    route_fit_format_version: number;
    route_fit_observer_report: "absent" | "applied";
    handoff_policy_version: string;
    handoff_contract_version: string;
    observer_report: "absent" | "applied";
  };
  gates: { fitting: CoverageGate; retired_authority: CoverageGate };
  metrics: {
    by_disposition: {
      denominator: Ratio["denominator"];
      counts: Record<Disposition, number>;
    };
    by_family: {
      denominator: Ratio["denominator"];
      counts: Record<string, number>;
    };
    listing_only_github_packages_windows_x86_64: number;
    restricted_by_operation: {
      denominator: Ratio["denominator"];
      restricted_identities: number;
      held: Record<string, number>;
    };
    handoff_classes: {
      denominator: Ratio["denominator"];
      dispatch: Record<string, number>;
      classes: {
        kind: string;
        source: string;
        authority: string;
        dispatch: string;
        contract: boolean;
      }[];
    };
    observer_coverage: ObserverCoverage;
  };
  remaining_actions: {
    denominator: Ratio["denominator"];
    counts: Record<ActionClass, number>;
  };
  authority_kinds: AuthorityReport[];
  subjects: ProgramSubject[];
}

export interface ProgramViewInputs {
  routeFit: RouteFitReport;
  authorities: readonly AuthorityReport[];
  /** A catalog upstream observer report with `source_statuses`; absent is unknown. */
  observerReport?: unknown;
}

const denominator = (key: keyof typeof denominators, count: number) => ({
  ...denominators[key],
  count,
});

function gate(
  name: string,
  passing: number,
  count: Ratio["denominator"],
  failing: CoverageGate["failing"],
  unknown: CoverageGate["unknown"] = [],
  unknownKinds: CoverageGate["unknown_kinds"] = [],
): CoverageGate {
  const state = failing.length
    ? "failed"
    : unknown.length || unknownKinds.length
      ? "unknown"
      : "passed";
  return {
    gate: name,
    state,
    numerator: passing,
    denominator: count,
    ratio: count.count ? Number((passing / count.count).toFixed(6)) : null,
    passed: state === "passed",
    failing,
    unknown,
    unknown_kinds: unknownKinds,
  };
}

/**
 * Which identities each active authority kind serves, conservatively. A kind
 * with derived identities and no unattributed entries covers them; a kind that
 * cannot derive identities takes them from its `covered_through` kind when that
 * kind is itself fully derived. Anything else is an unknown kind: it may serve
 * any identity, so no identity it could serve counts as retired.
 */
export function authorityCoverage(reports: readonly AuthorityReport[]) {
  const byKind = new Map(reports.map((report) => [report.kind, report]));
  const covering = new Map<string, string[]>();
  const unknownKinds: CoverageGate["unknown_kinds"] = [];
  const known = (report: AuthorityReport | undefined) =>
    report !== undefined && report.identities !== null && report.unattributed.length === 0;
  for (const report of reports) {
    if (report.state !== "active") continue;
    let identities: readonly string[] | undefined;
    if (known(report)) identities = report.identities!;
    else if (report.identities === null && report.unattributed.length === 0) {
      const through = report.covered_through ? byKind.get(report.covered_through) : undefined;
      if (through?.state === "active" && known(through)) identities = through.identities!;
    }
    if (identities === undefined) {
      const reasons = [
        ...(report.unattributed.length
          ? [`cannot attribute ${report.unattributed.join(", ")}`]
          : []),
        ...(report.identities === null && !report.covered_through
          ? ["derives no identities and names no covering kind"]
          : []),
        ...(report.identities === null && report.covered_through
          ? [`its covering kind ${report.covered_through} is not fully derived`]
          : []),
      ];
      unknownKinds.push({ kind: report.kind, detail: `${report.kind} ${reasons.join("; ")}.` });
      continue;
    }
    for (const id of identities) covering.set(id, [...(covering.get(id) ?? []), report.kind]);
  }
  return { covering, unknownKinds };
}

function observerCoverage(report: unknown): ObserverCoverage {
  if (report === undefined)
    return {
      state: "unknown",
      reason: "No observer report was supplied; coverage is unknown, not zero.",
    };
  if (!isRecord(report) || !Array.isArray(report.source_statuses))
    throw new Error("Observer report needs a source_statuses array.");
  const byState = {
    complete: 0,
    pending: 0,
    partial: 0,
    unavailable: 0,
    failed: 0,
  };
  for (const status of report.source_statuses) {
    if (!isRecord(status)) throw new Error("Observer report contains an invalid source status.");
    const kind = isRecord(status.coverage) ? status.coverage.kind : undefined;
    if (kind === "partial" || kind === "unavailable" || kind === "failed") byState[kind]++;
    else if (kind !== undefined)
      throw new Error(`Unknown observer coverage kind ${JSON.stringify(kind)}.`);
    else if (status.current_scope_complete === true) byState.complete++;
    else byState.pending++;
  }
  return {
    state: "reported",
    denominator: denominator("observerSources", report.source_statuses.length),
    by_state: byState,
  };
}

const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** Pure projection; equal inputs serialize byte-identically. */
export function programView(inputs: ProgramViewInputs): ProgramView {
  const errors = authorityInventoryErrors(inputs.authorities);
  if (errors.length) throw new Error(errors.join("\n"));
  const { covering, unknownKinds } = authorityCoverage(inputs.authorities);

  const subjects = inputs.routeFit.identities
    .map((identity): ProgramSubject => {
      const scope: ProductScope =
        identity.disposition === "excluded-scummvm" ? "deferred-scummvm" : "in-scope";
      const paths = sorted(covering.get(identity.id) ?? []);
      const action: ActionClass =
        identity.disposition === "enrolled"
          ? paths.length
            ? "retire-title-authority"
            : unknownKinds.length
              ? "resolve-authority-inventory"
              : "none"
          : dispositionAction[identity.disposition];
      return {
        id: identity.id,
        scope,
        disposition: identity.disposition,
        reason: identity.reason,
        family: `${identity.family.adapter}/${identity.family.provider}`,
        restrictions: {
          declared: identity.restrictions.length,
          held_operations: Object.keys(identity.held_operations).toSorted(),
        },
        title_code_paths: paths,
        remaining_action: action,
      };
    })
    .toSorted((left, right) => compare(left.id, right.id));

  const inScope = subjects.filter((subject) => subject.scope === "in-scope");
  const unfitted = inScope.filter((subject) => subject.disposition === "unobserved");
  const enrolled = inScope.filter((subject) => subject.disposition === "enrolled");
  const titleServed = enrolled.filter((subject) => subject.title_code_paths.length);
  const unresolved = unknownKinds.length
    ? enrolled.filter((subject) => !subject.title_code_paths.length)
    : [];

  const byDisposition = Object.fromEntries(dispositions.map((name) => [name, 0])) as Record<
    Disposition,
    number
  >;
  for (const subject of subjects) byDisposition[subject.disposition]++;
  const byFamily: Record<string, number> = {};
  for (const subject of subjects.toSorted((left, right) => compare(left.family, right.family)))
    byFamily[subject.family] = (byFamily[subject.family] ?? 0) + 1;
  const held: Record<string, number> = {};
  for (const operation of sorted(
    subjects.flatMap((subject) => subject.restrictions.held_operations),
  ))
    held[operation] = subjects.filter((subject) =>
      subject.restrictions.held_operations.includes(operation),
    ).length;
  const actions = Object.fromEntries(actionClasses.map((name) => [name, 0])) as Record<
    ActionClass,
    number
  >;
  for (const subject of subjects) actions[subject.remaining_action]++;
  const dispatch: Record<string, number> = {};
  for (const entry of handoffRegistry)
    dispatch[entry.dispatch] = (dispatch[entry.dispatch] ?? 0) + 1;

  return {
    format_version: 1,
    view_version: programViewVersion,
    authority: "derived-read-only-projection",
    planning_authority:
      "GitHub Projects and the canonical issues own planning, priority and status; this view is an operator projection of committed facts.",
    inputs: {
      route_fit_format_version: inputs.routeFit.format_version,
      route_fit_observer_report: inputs.routeFit.summary.observer_report,
      handoff_policy_version: handoffPolicyVersion,
      handoff_contract_version: handoffContractVersion,
      observer_report: inputs.observerReport === undefined ? "absent" : "applied",
    },
    gates: {
      fitting: gate(
        "fitting",
        inScope.length - unfitted.length,
        denominator("inScope", inScope.length),
        unfitted.map((subject) => ({ id: subject.id, detail: subject.reason })),
      ),
      retired_authority: gate(
        "retired-authority",
        enrolled.length - titleServed.length - unresolved.length,
        denominator("inScopeEnrolled", enrolled.length),
        titleServed.map((subject) => ({
          id: subject.id,
          detail: `Served by ${subject.title_code_paths.join(", ")}.`,
        })),
        unresolved.map((subject) => ({
          id: subject.id,
          detail: `Unknown: ${unknownKinds.map((entry) => entry.kind).join(", ")} cannot derive the identities they serve.`,
        })),
        unknownKinds,
      ),
    },
    metrics: {
      by_disposition: {
        denominator: denominator("identities", subjects.length),
        counts: byDisposition,
      },
      by_family: {
        denominator: denominator("identities", subjects.length),
        counts: byFamily,
      },
      listing_only_github_packages_windows_x86_64:
        inputs.routeFit.summary.listing_only_github_packages_windows_x86_64,
      restricted_by_operation: {
        denominator: denominator("identities", subjects.length),
        restricted_identities: subjects.filter((subject) => subject.restrictions.declared).length,
        held,
      },
      handoff_classes: {
        denominator: denominator("handoffClasses", handoffRegistry.length),
        dispatch,
        classes: handoffRegistry
          .map((entry) => ({
            kind: entry.kind,
            source: entry.source,
            authority: entry.authority,
            dispatch: entry.dispatch,
            contract: entry.kind in handoffContracts,
          }))
          .toSorted((left, right) => compare(left.kind, right.kind)),
      },
      observer_coverage: observerCoverage(inputs.observerReport),
    },
    remaining_actions: {
      denominator: denominator("identities", subjects.length),
      counts: actions,
    },
    authority_kinds: [...inputs.authorities].toSorted((left, right) =>
      compare(left.kind, right.kind),
    ),
    subjects,
  };
}

export function serializeProgramView(view: ProgramView): string {
  return `${JSON.stringify(view, null, 2)}\n`;
}

const percent = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);

export function renderProgramView(view: ProgramView): string {
  const row = (name: string, value: string | number) =>
    `  ${name.padEnd(48)} ${String(value).padStart(10)}`;
  const gateLine = (label: string, value: CoverageGate) =>
    `${label}: ${value.numerator}/${value.denominator.count} (${percent(value.ratio)}) [${value.denominator.version}] ${value.state}${value.failing.length ? `, ${value.failing.length} failing` : ""}${value.unknown.length ? `, ${value.unknown.length} unknown` : ""}${value.unknown_kinds.length ? ` (unknown kinds: ${value.unknown_kinds.map((entry) => entry.kind).join(", ")})` : ""}`;
  const observer = view.metrics.observer_coverage;
  return [
    `Program cutover view (${view.view_version}; read-only projection, not a planning authority)`,
    gateLine("Fitting coverage", view.gates.fitting),
    gateLine("Retired-authority coverage", view.gates.retired_authority),
    "Remaining actions:",
    ...Object.entries(view.remaining_actions.counts).map(([name, count]) => row(name, count)),
    "Title-specific authority kinds:",
    ...view.authority_kinds.map((kind) =>
      row(
        `${kind.kind} (${kind.state})`,
        `${kind.count}${kind.identities ? ` / ${kind.identities.length} ids` : kind.covered_through ? ` via ${kind.covered_through}` : ""}`,
      ),
    ),
    `Handoff classes: ${view.metrics.handoff_classes.denominator.count} (${Object.entries(
      view.metrics.handoff_classes.dispatch,
    )
      .map(([state, count]) => `${count} dispatch ${state}`)
      .join(", ")})`,
    observer.state === "unknown"
      ? "Observer coverage: unknown (no observer report supplied)"
      : `Observer coverage: ${Object.entries(observer.by_state)
          .map(([state, count]) => `${state} ${count}`)
          .join(", ")} of ${observer.denominator.count} sources`,
  ].join("\n");
}

/** Every route-fit identity appears exactly once, in id order. */
export function checkProgramView(view: ProgramView, routeFit: RouteFitReport) {
  const expected = routeFit.identities.map((identity) => identity.id).toSorted(compare);
  if (JSON.stringify(view.subjects.map((subject) => subject.id)) !== JSON.stringify(expected))
    throw new Error("Program view must list every route-fit identity exactly once, in id order.");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function readProgramViewInputs(
  repositoryRoot: string,
  options: { observations?: string; observerReport?: string } = {},
): ProgramViewInputs & { routeFitInputs: RouteFitInputs } {
  const routeFitInputs = readRouteFitInputs(repositoryRoot, options.observations);
  const routeFit = routeFitReport(routeFitInputs);
  checkRouteFitReport(routeFit, routeFitInputs.records);
  const authorities = detectAuthorities(repositoryRoot, {
    ids: new Set(routeFit.identities.map((identity) => identity.id)),
    ports: routeFitInputs.ports,
    listings: routeFitInputs.records,
  });
  return {
    routeFitInputs,
    routeFit,
    authorities,
    ...(options.observerReport === undefined
      ? {}
      : {
          observerReport: parseCatalogSource(readFileSync(options.observerReport, "utf8")),
        }),
  };
}

const usage =
  "Usage: node scripts/maintenance-program-view.mts [--check] [--json] [--output FILE] [--observations LISTING_UPDATES.json] [--observer-report CATALOG_OBSERVER_REPORT.json]";

export function main(argv: readonly string[], repositoryRoot = root): string {
  const options = { check: false, json: false } as {
    check: boolean;
    json: boolean;
    output?: string;
    observations?: string;
    observerReport?: string;
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--json") options.json = true;
    else if (
      argument === "--output" ||
      argument === "--observations" ||
      argument === "--observer-report"
    ) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(usage);
      const key = argument === "--observer-report" ? "observerReport" : argument.slice(2);
      options[key as "output" | "observations" | "observerReport"] = resolve(value);
    } else throw new Error(usage);
  }
  const inputs = readProgramViewInputs(repositoryRoot, options);
  const view = programView(inputs);
  checkProgramView(view, inputs.routeFit);
  const serialized = serializeProgramView(view);
  if (options.check) {
    const again = readProgramViewInputs(repositoryRoot, options);
    if (serializeProgramView(programView(again)) !== serialized)
      throw new Error("Program view is not deterministic.");
  }
  if (options.output) writeFileSync(options.output, serialized);
  return options.json ? serialized : `${renderProgramView(view)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
