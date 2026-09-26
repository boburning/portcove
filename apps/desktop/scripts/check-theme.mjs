import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cssPath = fileURLToPath(new URL("../src/styles.css", import.meta.url));
const buttonPath = fileURLToPath(new URL("../src/components/ui/button.tsx", import.meta.url));
const dialogPath = fileURLToPath(new URL("../src/components/ui/dialog.tsx", import.meta.url));
const selectPath = fileURLToPath(new URL("../src/components/ui/select.tsx", import.meta.url));
const mainPath = fileURLToPath(new URL("../src/main.tsx", import.meta.url));
const css = readFileSync(cssPath, "utf8");
const foundationSources = {
  button: readFileSync(buttonPath, "utf8"),
  dialog: readFileSync(dialogPath, "utf8"),
  main: readFileSync(mainPath, "utf8"),
  select: readFileSync(selectPath, "utf8"),
};
const themeBlockPattern = /(:root|\[data-theme=(?:"light"|'light')\])\s*\{([\s\S]*?)\r?\n\}/g;
const tokenBlocks = [...css.matchAll(themeBlockPattern)];
const rootBlock = tokenBlocks.find(([, selector]) => selector === ":root");
const lightBlock = tokenBlocks.find(([, selector]) => selector.includes("light"));

if (!rootBlock) throw new Error("Theme check failed: styles.css has no :root token block.");
if (!lightBlock) throw new Error("Theme check failed: styles.css has no light theme token block.");

function parseTokens(block) {
  return new Map(
    [...block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)].map(([, name, value]) => [
      `--${name}`,
      value.trim(),
    ]),
  );
}

const baseTokens = parseTokens(rootBlock[2]);
const lightOverrides = parseTokens(lightBlock[2]);
const themes = [
  { name: "dark", tokens: baseTokens },
  { name: "light", tokens: new Map([...baseTokens, ...lightOverrides]) },
];
const failures = [];

function expectSource(failures, condition, message) {
  if (!condition) failures.push(message);
}

function checkCssSource(css, failures) {
  expectSource(
    failures,
    css.includes('@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));'),
    "Tailwind dark variants must use the runtime data-theme marker",
  );
  expectSource(
    failures,
    !/@custom-variant\s+dark[^;]*\.dark/.test(css),
    "Tailwind dark variants must not use .dark",
  );
  expectSource(
    failures,
    /--font-ui:\s*"Geist Variable"/.test(css),
    "the bundled Geist font must lead the UI font stack",
  );
  expectSource(
    failures,
    !/\[data-slot=(?:"button"|'button')\]\[data-variant=/.test(css),
    "Button variants must not depend on unlayered legacy CSS overrides",
  );
  expectSource(
    failures,
    !css.includes('button:not([data-slot="button"])'),
    "ordinary buttons must not retain the legacy raw-button styling fallback",
  );
  expectSource(
    failures,
    [
      ".palette-command {",
      ".palette-command:active:not(:disabled) {",
      ".port-card {",
      ".port-card-selectable:active {",
      ".update-row {",
      ".update-row:active {",
    ].every((selector) => css.includes(selector)),
    "intentional composite buttons must retain explicit product-owned styles",
  );
  failures.push(...semanticReferenceFailures(parseTokens(css)));
}

function checkButtonSource(button, failures) {
  for (const variant of ["default", "primary", "selected", "destructive"]) {
    expectSource(
      failures,
      button.includes(`${variant}:`),
      `Button source is missing the ${variant} variant`,
    );
  }
  for (const size of ["--control-height-sm", "--control-height-md", "--control-height-lg"]) {
    expectSource(failures, button.includes(size), `Button source is missing ${size}`);
  }
  expectSource(
    failures,
    !button.includes("transition-all"),
    "Button must transition only intentional properties",
  );
  expectSource(
    failures,
    button.includes("aria-busy:"),
    "Button must own its pending interaction state",
  );
  expectSource(
    failures,
    button.includes("forced-colors:focus-visible:outline"),
    "Button must retain a forced-colors focus signal",
  );
  expectSource(
    failures,
    button.includes("focus-visible:ring-pc-ring"),
    "Button variants must retain the shared semantic focus ring",
  );
  expectSource(
    failures,
    !/destructive:[\s\S]*?focus-visible:(?:border|ring)-pc-danger/.test(button),
    "destructive Button must not replace the shared focus signal",
  );
  expectSource(
    failures,
    button.includes("active:bg-pc-signature-active"),
    "primary Button must own its signature active state",
  );
  expectSource(
    failures,
    button.includes("hover:bg-pc-danger-surface"),
    "destructive Button hover must use the contrast-safe danger surface",
  );
  expectSource(
    failures,
    button.includes("bg-pc-danger-subtle text-pc-danger-strong"),
    "destructive Button default must use the contrast-safe strong danger foreground",
  );
}

function checkDialogSource(dialog, failures) {
  expectSource(failures, dialog.includes("bg-pc-scrim"), "Dialog must use the semantic scrim");
  expectSource(
    failures,
    !dialog.includes("backdrop-blur"),
    "Dialog must not blur its backdrop by default",
  );
  expectSource(
    failures,
    dialog.includes("max-h-[calc(100dvh-2rem)]") && dialog.includes("overflow-y-auto"),
    "Dialog must own bounded scrolling geometry",
  );
  expectSource(
    failures,
    dialog.includes("left-1/2") && dialog.includes("end-2"),
    "Dialog must center on the invariant axis and use logical edge positioning",
  );
}

function checkDirectionSources(main, select, failures) {
  expectSource(
    failures,
    select.includes("pe-2") && select.includes("ps-2") && select.includes("end-2"),
    "Select spacing and positioning must use logical utilities",
  );
  expectSource(
    failures,
    main.includes("DirectionProvider") && main.includes('document.documentElement.dir = "ltr"'),
    "the document and Base UI must share an explicit direction owner",
  );
}

function sharedControlSourceFailures(source) {
  const sourceFailures = [];
  const literal = source.match(/(?:bg|text|border|ring)-\[?(?:#|rgba?\(|hsla?\()/i);
  if (literal)
    sourceFailures.push(`shared control source contains raw color utility ${literal[0]}`);
  if (/className\s*=\s*\{?`[^`]*\$\{[^}]+\}[^`]*`/.test(source))
    sourceFailures.push("shared control source contains a dynamic utility fragment");
  return sourceFailures;
}

function checkProductionCss(builtCss, failures) {
  if (builtCss === undefined) return;
  expectSource(failures, builtCss.length > 0, "production CSS output is empty");
  expectSource(
    failures,
    builtCss.includes("[data-theme=dark]"),
    "production CSS omits the data-theme dark variant",
  );
  for (const selector of [
    ".bg-pc-signature",
    ".bg-pc-scrim",
    ".active\\:bg-pc-signature-active",
    ".hover\\:bg-pc-danger-surface",
    ".text-pc-danger-strong",
    ".focus-visible\\:ring-pc-ring",
  ]) {
    expectSource(
      failures,
      builtCss.includes(selector),
      `production CSS omits required selector ${selector}`,
    );
  }
}

export function foundationSourceFailures({ css, button, dialog, main, select, builtCss }) {
  const sourceFailures = [];
  checkCssSource(css, sourceFailures);
  checkButtonSource(button, sourceFailures);
  checkDialogSource(dialog, sourceFailures);
  checkDirectionSources(main, select, sourceFailures);
  sourceFailures.push(
    ...[button, dialog, select].flatMap((source) => sharedControlSourceFailures(source)),
  );
  checkProductionCss(builtCss, sourceFailures);
  return sourceFailures;
}

const distAssets = fileURLToPath(new URL("../dist/assets", import.meta.url));
let builtCss;
try {
  builtCss = readdirSync(distAssets)
    .filter((entry) => entry.endsWith(".css"))
    .map((entry) => readFileSync(path.join(distAssets, entry), "utf8"))
    .join("\n");
} catch {
  // A standalone source check remains useful before a production build exists.
}
failures.push(...foundationSourceFailures({ css, ...foundationSources, builtCss }));
const requiredAliases = [
  "--color-bg",
  "--color-bg-elevated",
  "--color-bg-hover",
  "--color-text",
  "--color-text-secondary",
  "--color-text-muted",
  "--color-border",
  "--color-border-strong",
  "--color-interactive",
  "--color-interactive-hover",
  "--color-interactive-active",
  "--color-focus",
  "--color-success",
  "--color-warning",
  "--color-highlight",
  "--color-danger",
  "--color-loading",
];

for (const theme of themes) {
  for (const token of requiredAliases) {
    if (!theme.tokens.has(token))
      failures.push(`${theme.name} theme is missing required semantic alias ${token}`);
  }
}

const requiredLightOverrides = [
  "--color-bg",
  "--color-bg-elevated",
  "--color-text",
  "--color-text-muted",
  "--color-border",
  "--color-interactive-text",
  "--color-focus",
  "--color-success",
  "--color-warning",
  "--color-danger",
  "--color-loading",
  "--shadow-raised",
];

for (const token of requiredLightOverrides) {
  if (!lightOverrides.has(token)) failures.push(`light theme must explicitly override ${token}`);
}
for (const token of lightOverrides.keys()) {
  if (token.startsWith("--n64-"))
    failures.push(`light theme redefines primitive ${token}; override semantic aliases instead`);
}

const expectedPrimitives = {
  "--n64-red-100": "#f9d8d5",
  "--n64-red-300": "#ef8179",
  "--n64-red-500": "#e23b32",
  "--n64-red-700": "#a92b25",
  "--n64-blue-100": "#d8e2f2",
  "--n64-blue-300": "#7697ca",
  "--n64-blue-500": "#2d5da8",
  "--n64-blue-700": "#214579",
  "--n64-green-100": "#d5ecdf",
  "--n64-green-300": "#73bd91",
  "--n64-green-500": "#27995b",
  "--n64-green-700": "#1d7044",
  "--n64-yellow-100": "#fbf0c8",
  "--n64-yellow-300": "#f6d978",
  "--n64-yellow-500": "#f2c94c",
  "--n64-yellow-700": "#b69228",
  "--n64-black": "#191a1d",
  "--n64-graphite": "#24252a",
  "--n64-white": "#f5f3ee",
  "--n64-controller-blue": "#4958a7",
};

for (const [token, expected] of Object.entries(expectedPrimitives)) {
  const actual = baseTokens.get(token)?.toLowerCase();
  if (actual !== expected)
    failures.push(`${token} must remain ${expected}, found ${actual ?? "missing"}`);
}

const componentCss = css.replace(themeBlockPattern, "");
const literalColor = componentCss.match(/#[0-9a-f]{3,8}\b|rgba?\s*\(|hsla?\s*\(/i);
if (literalColor)
  failures.push(`component CSS contains literal color ${literalColor[0]}; use a semantic alias`);
if (/var\(\s*--n64-/i.test(componentCss))
  failures.push("component CSS references an N64 primitive directly");
if (/(?:linear|radial|conic)-gradient\s*\(/i.test(css))
  failures.push("theme contains a gradient without an approved design reason");

function tokenValue(tokens, token) {
  const value = tokens.get(token);
  if (!value) throw new Error(`Unknown theme token ${token}`);
  return value;
}

export function semanticReferenceFailures(tokens) {
  const referenceFailures = [];
  for (const token of tokens.keys()) {
    if (!token.startsWith("--color-")) continue;
    const visited = new Set([token]);
    let value = tokens.get(token);
    while (value?.startsWith("var(")) {
      const nextToken = value.slice(4, -1).trim();
      if (!tokens.has(nextToken)) {
        referenceFailures.push(`${token} references missing token ${nextToken}`);
        break;
      }
      if (visited.has(nextToken)) {
        referenceFailures.push(`${token} contains a cycle through ${nextToken}`);
        break;
      }
      visited.add(nextToken);
      value = tokens.get(nextToken);
    }
  }
  return referenceFailures;
}

for (const theme of themes) failures.push(...semanticReferenceFailures(theme.tokens));

function resolveColor(tokens, token) {
  let value = tokenValue(tokens, token);
  const visited = new Set([token]);
  while (value.startsWith("var(")) {
    const nextToken = value.slice(4, -1).trim();
    if (visited.has(nextToken)) throw new Error(`Circular theme token reference at ${nextToken}`);
    visited.add(nextToken);
    value = tokenValue(tokens, nextToken);
  }
  if (!/^#[0-9a-f]{6}$/i.test(value))
    throw new Error(`${token} does not resolve to a solid hex color: ${value}`);
  return value;
}

function luminance(hex) {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

const contrastPairs = [
  ["primary text on app background", "--color-text", "--color-bg", 4.5],
  ["primary text on elevated surface", "--color-text", "--color-bg-elevated", 4.5],
  ["secondary text on elevated surface", "--color-text-secondary", "--color-bg-elevated", 4.5],
  ["secondary text on raised surface", "--color-text-secondary", "--color-bg-raised", 4.5],
  ["muted text on app background", "--color-text-muted", "--color-bg", 4.5],
  ["muted text on elevated surface", "--color-text-muted", "--color-bg-elevated", 4.5],
  ["interactive text on elevated surface", "--color-interactive-text", "--color-bg-elevated", 4.5],
  ["interactive button label", "--color-text-on-dark", "--color-interactive", 4.5],
  ["interactive hover label", "--color-text-on-dark", "--color-interactive-hover", 4.5],
  ["interactive active label", "--color-text-on-dark", "--color-interactive-active", 4.5],
  ["signature action label", "--color-text-on-dark", "--color-accent-surface", 4.5],
  ["signature action hover label", "--color-text-on-dark", "--color-accent-hover", 4.5],
  ["signature action active label", "--color-text-on-dark", "--color-accent-active", 4.5],
  ["destructive hover label", "--color-text-on-dark", "--color-danger-surface", 4.5],
  ["highlight label", "--color-text-on-highlight", "--color-highlight", 4.5],
  ["staged state on artwork", "--color-art-staged-text", "--color-art-blue", 4.5],
  ["success text", "--color-success-text", "--color-bg-elevated", 4.5],
  ["warning text", "--color-warning-text", "--color-bg-elevated", 4.5],
  ["danger text", "--color-danger-text", "--color-bg-elevated", 4.5],
  ["success text on raised surface", "--color-success-text-raised", "--color-bg-raised", 4.5],
  ["warning text on raised surface", "--color-warning-text", "--color-bg-raised", 4.5],
  ["success text on subtle surface", "--color-success-text", "--color-success-subtle", 4.5],
  ["warning text on subtle surface", "--color-warning-text", "--color-warning-subtle", 4.5],
  ["danger text on subtle surface", "--color-danger-text", "--color-danger-subtle", 4.5],
  [
    "interactive text on subtle surface",
    "--color-interactive-text",
    "--color-interactive-subtle",
    4.5,
  ],
  [
    "selected interactive text on subtle surface",
    "--color-interactive-text-strong",
    "--color-interactive-subtle",
    4.5,
  ],
  [
    "strong interactive text on raised surface",
    "--color-interactive-text-strong",
    "--color-bg-raised",
    4.5,
  ],
  ["focus on app background", "--color-focus", "--color-bg", 3],
  ["focus on elevated surface", "--color-focus", "--color-bg-elevated", 3],
  ["focus on raised surface", "--color-focus", "--color-bg-raised", 3],
  ["control border on inset surface", "--color-control-border", "--color-bg-inset", 3],
  [
    "interactive border on elevated surface",
    "--color-interactive-border",
    "--color-bg-elevated",
    3,
  ],
  ["success indicator on app background", "--color-success", "--color-bg", 3],
  ["warning indicator on app background", "--color-warning", "--color-bg", 3],
  ["danger indicator on app background", "--color-danger", "--color-bg", 3],
  ["loading indicator on app background", "--color-loading", "--color-bg", 3],
];

const results = [];
for (const theme of themes) {
  for (const [label, foregroundToken, backgroundToken, minimum] of contrastPairs) {
    const foreground = resolveColor(theme.tokens, foregroundToken);
    const background = resolveColor(theme.tokens, backgroundToken);
    const ratio = contrast(foreground, background);
    results.push({ theme: theme.name, label, ratio, minimum });
    if (ratio + Number.EPSILON < minimum)
      failures.push(`${theme.name}: ${label} is ${ratio.toFixed(2)}:1; needs ${minimum}:1`);
  }
}

if (failures.length > 0) {
  console.error("N64 theme contract failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  const summaries = themes.map((theme) => {
    const themeResults = results.filter((result) => result.theme === theme.name);
    const lowestText = Math.min(
      ...themeResults.filter((result) => result.minimum === 4.5).map((result) => result.ratio),
    );
    const lowestControl = Math.min(
      ...themeResults.filter((result) => result.minimum === 3).map((result) => result.ratio),
    );
    return `${theme.name}: text ${lowestText.toFixed(2)}:1, controls ${lowestControl.toFixed(2)}:1`;
  });
  console.log(
    `N64 theme contract passed (${contrastPairs.length} pairs per theme; 5 foundation sources${builtCss === undefined ? "" : " plus production CSS"}; ${summaries.join("; ")}).`,
  );
}
