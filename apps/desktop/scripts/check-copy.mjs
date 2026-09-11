import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync, visitorKeys } from "oxc-parser";

const copyAttributes = new Set([
  "title",
  "alt",
  "placeholder",
  "aria-label",
  "aria-description",
  "label",
  "description",
  "message",
  "heading",
  "caption",
]);
const rules = [
  {
    id: "internal-terminology",
    pattern: /\b(?:adapters?|materialization|qualification|persistent data|source profiles?)\b/iu,
    message: "Use player-facing terminology; reserve internal terms for technical details.",
  },
  {
    id: "parenthetical-plural",
    pattern: /\b\p{L}+\((?:s|es)\)/iu,
    message: "Use complete count-aware wording instead of a parenthetical plural.",
  },
  {
    id: "generic-verified",
    pattern: /^verified[.!]?$/iu,
    message: "Name what was checked instead of a generic Verified label.",
  },
];

const jsxEntities = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["nbsp", "\u00a0"],
  ["quot", '"'],
]);

function decodeJsxEntities(value) {
  return value.replace(
    /&(?:#(?<decimal>\d+)|#x(?<hex>[\dA-F]+)|(?<named>[A-Z]+));/giu,
    (...args) => {
      const groups = args.at(-1);
      if (groups.decimal) return String.fromCodePoint(Number.parseInt(groups.decimal, 10));
      if (groups.hex) return String.fromCodePoint(Number.parseInt(groups.hex, 16));
      return jsxEntities.get(groups.named.toLowerCase()) ?? args[0];
    },
  );
}

function sourcePosition(source, offset) {
  const lines = source.slice(0, offset).split(/\r\n|[\n\r]/u);
  return { line: lines.length, column: lines.at(-1).length + 1 };
}

function technicalDisclosure(node) {
  if (node.type !== "JSXElement" || node.openingElement.name.name !== "details") return false;
  const summary = node.children.find(
    (child) => child.type === "JSXElement" && child.openingElement.name.name === "summary",
  );
  const label =
    summary?.children
      .filter((child) => child.type === "JSXText")
      .map((child) => decodeJsxEntities(child.value))
      .join(" ") ?? "";
  return /^(?:view )?technical details$|^full identity and evidence$/iu.test(label.trim());
}

function codeLiteral(node, parent) {
  if (!parent) return false;
  if (parent.key === node && !parent.computed) return true;
  if (parent.source === node) return true;
  if (["TSLiteralType", "SwitchCase"].includes(parent.type)) return true;
  if (parent.type === "BinaryExpression")
    return ["===", "!==", "==", "!="].includes(parent.operator);
  return (
    ["MemberExpression", "OptionalMemberExpression"].includes(parent.type) &&
    parent.property === node
  );
}

function excludedContext(node, ancestors) {
  if (codeLiteral(node, ancestors.at(-1))) return true;
  const attribute = ancestors.findLast((ancestor) => ancestor.type === "JSXAttribute");
  if (attribute && !copyAttributes.has(attribute.name.name)) return true;
  return ancestors.some(technicalDisclosure);
}

function staticText(node, parent) {
  if (node.type === "TemplateElement") return node.value.cooked;
  if (node.type === "JSXText") return decodeJsxEntities(node.value);
  if (node.type !== "Literal" || typeof node.value !== "string") return undefined;
  return parent?.type === "JSXAttribute" ? decodeJsxEntities(node.value) : node.value;
}

function childNodes(node) {
  return (visitorKeys[node.type] ?? []).flatMap((key) => {
    const value = node[key];
    return (Array.isArray(value) ? value : [value]).filter(
      (child) => typeof child?.type === "string",
    );
  });
}

function inspectNode(node, ancestors, source, filename) {
  const text = staticText(node, ancestors.at(-1));
  if (typeof text !== "string" || excludedContext(node, ancestors)) return [];
  const position = sourcePosition(source, node.start);
  return rules
    .filter((rule) => rule.pattern.test(text.trim()))
    .map((rule) => ({
      file: filename,
      line: position.line,
      column: position.column,
      rule: rule.id,
      message: rule.message,
      text: text.trim().replace(/\s+/gu, " ").slice(0, 120),
    }));
}

/** Check static copy, including message literals outside JSX; never execute source. */
export function inspectCopy(source, filename = "fixture.tsx") {
  const result = parseSync(filename, source, {
    sourceType: "module",
    astType: "ts",
    showSemanticErrors: true,
  });
  if (result.errors.length) {
    const diagnostics = result.errors.map((error) => {
      const position = sourcePosition(source, error.labels.at(0)?.start ?? 0);
      return `${filename}:${position.line}:${position.column}: ${error.message}`;
    });
    throw new SyntaxError(`Unable to inspect static copy:\n${diagnostics.join("\n")}`);
  }
  const findings = [];
  const visit = (node, ancestors) => {
    findings.push(...inspectNode(node, ancestors, source, filename));
    for (const child of childNodes(node)) visit(child, [...ancestors, node]);
  };
  visit(result.program, []);
  return findings;
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(filename);
    return /\.(?:ts|tsx)$/u.test(entry.name) &&
      !/\.(?:test|d)\.tsx?$/u.test(entry.name) &&
      entry.name !== "test-fixtures.ts"
      ? [filename]
      : [];
  });
}

export function main() {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const files = sourceFiles(root);
  if (!files.length) throw new Error("Desktop static-copy check discovered no production sources.");
  const findings = files.flatMap((file) =>
    inspectCopy(readFileSync(file, "utf8"), path.relative(root, file)),
  );
  for (const finding of findings)
    console.error(
      `${finding.file}:${finding.line}:${finding.column}: ${finding.rule}: ${finding.message} [${finding.text}]`,
    );
  if (findings.length) process.exitCode = 1;
  else console.log(`Desktop static-copy check passed across ${files.length} source files.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
