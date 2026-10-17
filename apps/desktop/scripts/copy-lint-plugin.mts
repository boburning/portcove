import type { ESTree } from "vite-plus/lint/plugins";
import { definePlugin, defineRule } from "vite-plus/lint/plugins";
type Node = ESTree.Node;

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

function decodeJsxEntities(value: string) {
  return value.replace(
    /&(?:#(?<decimal>\d+)|#x(?<hex>[\dA-F]+)|(?<named>[A-Z]+));/giu,
    (
      match: string,
      decimal: string | undefined,
      hex: string | undefined,
      named: string | undefined,
    ) => {
      if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      return jsxEntities.get(named?.toLowerCase() ?? "") ?? match;
    },
  );
}

function technicalDisclosure(node: Node) {
  if (
    node.type !== "JSXElement" ||
    node.openingElement.name.type !== "JSXIdentifier" ||
    node.openingElement.name.name !== "details"
  )
    return false;
  const summary = node.children.find(
    (child): child is ESTree.JSXElement =>
      child.type === "JSXElement" &&
      child.openingElement.name.type === "JSXIdentifier" &&
      child.openingElement.name.name === "summary",
  );
  const label =
    summary?.children
      .filter((child) => child.type === "JSXText")
      .map((child) => decodeJsxEntities(child.value))
      .join(" ") ?? "";
  return /^(?:view )?technical details$|^full identity and evidence$/iu.test(label.trim());
}

function codeLiteral(node: Node, parent: Node | null | undefined) {
  if (!parent) return false;
  if ("key" in parent && parent.key === node && !("computed" in parent && parent.computed))
    return true;
  if ("source" in parent && parent.source === node) return true;
  if (["TSLiteralType", "SwitchCase"].includes(parent.type)) return true;
  if (parent.type === "BinaryExpression")
    return ["===", "!==", "==", "!="].includes(parent.operator);
  return (
    ["MemberExpression", "OptionalMemberExpression"].includes(parent.type) &&
    "property" in parent &&
    parent.property === node
  );
}

function excludedContext(node: Node, ancestors: readonly Node[]) {
  if (codeLiteral(node, ancestors.at(-1))) return true;
  const attribute = ancestors.findLast((ancestor) => ancestor.type === "JSXAttribute");
  if (
    attribute &&
    (attribute.name.type !== "JSXIdentifier" || !copyAttributes.has(attribute.name.name))
  )
    return true;
  return ancestors.some(technicalDisclosure);
}

function staticText(node: Node, parent: Node | null | undefined) {
  if (node.type === "TemplateElement") return node.value.cooked;
  if (node.type === "JSXText") return decodeJsxEntities(node.value);
  if (node.type !== "Literal" || typeof node.value !== "string") return undefined;
  return parent?.type === "JSXAttribute" ? decodeJsxEntities(node.value) : node.value;
}

const playerCopy = defineRule({
  meta: {
    type: "problem",
    schema: [],
    messages: Object.fromEntries(rules.map((rule) => [rule.id, rule.message])),
  },
  create(context) {
    function inspect(node: Node) {
      // The pinned getAncestors declaration uses an unbound global Node.
      // Follow the same parent chain as its implementation with ESTree types.
      const ancestors: Node[] = [];
      for (let ancestor = node.parent; ancestor !== null; ancestor = ancestor.parent)
        ancestors.push(ancestor);
      ancestors.reverse();
      const text = staticText(node, ancestors.at(-1));
      if (typeof text !== "string" || excludedContext(node, ancestors)) return;
      for (const rule of rules)
        if (rule.pattern.test(text.trim())) context.report({ node, messageId: rule.id });
    }
    return { Literal: inspect, JSXText: inspect, TemplateElement: inspect };
  },
});
const themeUtilities = defineRule({
  meta: {
    type: "problem",
    schema: [],
    messages: {
      ambiguous: "Specify length: for a text size token; Tailwind otherwise emits a color.",
      raw: "Shared controls must use semantic colors instead of raw color utilities.",
      dynamic: "Use complete static utility names instead of interpolated class fragments.",
    },
  },
  create(context) {
    const sharedControl = /[/\\]components[/\\]ui[/\\](?:button|dialog|select)\.tsx$/u.test(
      context.filename,
    );
    function inspect(node: Node) {
      const text = staticText(node, node.parent);
      if (typeof text !== "string") return;
      if (/text-\[var\(--text-[a-z0-9-]+\)\]/u.test(text))
        context.report({ node, messageId: "ambiguous" });
      if (sharedControl && /(?:bg|text|border|ring)-\[?(?:#|rgba?\(|hsla?\()/iu.test(text))
        context.report({ node, messageId: "raw" });
    }
    return {
      Literal: inspect,
      TemplateElement: inspect,
      JSXAttribute(node) {
        if (
          sharedControl &&
          node.name.name === "className" &&
          node.value?.type === "JSXExpressionContainer" &&
          node.value.expression.type === "TemplateLiteral" &&
          node.value.expression.expressions.length
        )
          context.report({ node, messageId: "dynamic" });
      },
    };
  },
});
export default definePlugin({
  meta: { name: "portcove" },
  rules: { "player-copy": playerCopy, "theme-utilities": themeUtilities },
});
