import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

const copyAttributes = new Set(["title", "alt", "placeholder", "aria-label", "aria-description", "label", "description", "message", "heading", "caption"]);
const rules = [
  { id: "internal-terminology", pattern: /\b(?:adapters?|materialization|qualification|persistent data|source profiles?)\b/iu, message: "Use player-facing terminology; reserve internal terms for technical details." },
  { id: "parenthetical-plural", pattern: /\b\p{L}+\((?:s|es)\)/iu, message: "Use complete count-aware wording instead of a parenthetical plural." },
  { id: "generic-verified", pattern: /^verified[.!]?$/iu, message: "Name what was checked instead of a generic Verified label." },
];

function technicalDisclosure(node) {
  if (node.type !== "JSXElement" || node.openingElement.name.name !== "details") return false;
  const summary = node.children.find(child => child.type === "JSXElement" && child.openingElement.name.name === "summary");
  const label = summary?.children.filter(child => child.type === "JSXText").map(child => child.value).join(" ") ?? "";
  return /^(?:view )?technical details$|^full identity and evidence$/iu.test(label.trim());
}

function excludedContext(node, ancestors) {
  const parent = ancestors.at(-1);
  if (parent?.key === node && !parent.computed) return true;
  if (parent?.source === node || parent?.type === "TSLiteralType") return true;
  if (parent?.type === "BinaryExpression" && ["===", "!==", "==", "!="].includes(parent.operator)) return true;
  if (parent?.type === "SwitchCase" || (["MemberExpression", "OptionalMemberExpression"].includes(parent?.type) && parent.property === node)) return true;
  const attribute = ancestors.findLast(ancestor => ancestor.type === "JSXAttribute");
  if (attribute && !copyAttributes.has(attribute.name.name)) return true;
  return ancestors.some(technicalDisclosure);
}

/** Check static copy, including message literals outside JSX; never execute source. */
export function inspectCopy(source, filename = "fixture.tsx") {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"], sourceFilename: filename });
  const findings = [];
  const visit = (node, ancestors) => {
    const text = node.type === "TemplateElement" ? node.value.cooked
      : ["JSXText", "StringLiteral"].includes(node.type) ? node.value : undefined;
    if (typeof text === "string" && !excludedContext(node, ancestors)) {
      for (const rule of rules) {
        if (rule.pattern.test(text.trim())) findings.push({ file: filename, line: node.loc.start.line, column: node.loc.start.column + 1, rule: rule.id, message: rule.message, text: text.trim().replace(/\s+/gu, " ").slice(0, 120) });
      }
    }
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === "object" && typeof child.type === "string") visit(child, [...ancestors, node]);
      }
    }
  };
  visit(ast, []);
  return findings;
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(filename);
    return /\.(?:ts|tsx)$/u.test(entry.name) && !/\.(?:test|d)\.tsx?$/u.test(entry.name) && entry.name !== "test-fixtures.ts" ? [filename] : [];
  });
}

export function main() {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const files = sourceFiles(root);
  const findings = files.flatMap(file => inspectCopy(readFileSync(file, "utf8"), path.relative(root, file)));
  for (const finding of findings) console.error(`${finding.file}:${finding.line}:${finding.column}: ${finding.rule}: ${finding.message} [${finding.text}]`);
  if (findings.length) process.exitCode = 1;
  else console.log(`Desktop static-copy check passed across ${files.length} source files.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
