function parseTokens(block: string) {
  return new Map(
    [...block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)].map(([, name, value]) => [
      `--${name}`,
      value.trim(),
    ]),
  );
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

function tokenValue(tokens, token) {
  const value = tokens.get(token);
  if (!value) throw new Error(`Unknown theme token ${token}`);
  return value;
}

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

export function themeTokenFailures(css: string) {
  const themeBlockPattern =
    /(:root|:root\[data-theme=(?:"light"|'light')\])\s*\{([\s\S]*?)\r?\n\s*\}/g;
  const tokenBlocks = [...css.matchAll(themeBlockPattern)];
  const rootBlock = tokenBlocks.find(([, selector]) => selector === ":root");
  const lightBlock = tokenBlocks.find(([, selector]) => selector.includes("light"));

  if (!rootBlock) return { failures: ["Theme has no :root token block"], results: [] };
  if (!lightBlock) return { failures: ["Theme has no light theme token block"], results: [] };

  const baseTokens = parseTokens(rootBlock[2]);
  const lightOverrides = parseTokens(lightBlock[2]);
  const themes = [
    { name: "dark", tokens: baseTokens },
    { name: "light", tokens: new Map([...baseTokens, ...lightOverrides]) },
  ];
  const failures = [];

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

  for (const theme of themes) failures.push(...semanticReferenceFailures(theme.tokens));
  if (failures.length) return { failures, results: [] };

  const contrastPairs = [
    ["primary text on app background", "--color-text", "--color-bg", 4.5],
    ["primary text on elevated surface", "--color-text", "--color-bg-elevated", 4.5],
    ["secondary text on elevated surface", "--color-text-secondary", "--color-bg-elevated", 4.5],
    ["secondary text on raised surface", "--color-text-secondary", "--color-bg-raised", 4.5],
    ["muted text on app background", "--color-text-muted", "--color-bg", 4.5],
    ["muted text on elevated surface", "--color-text-muted", "--color-bg-elevated", 4.5],
    [
      "interactive text on elevated surface",
      "--color-interactive-text",
      "--color-bg-elevated",
      4.5,
    ],
    ["interactive button label", "--color-text-on-dark", "--color-interactive", 4.5],
    ["interactive hover label", "--color-text-on-dark", "--color-interactive-hover", 4.5],
    ["interactive active label", "--color-text-on-dark", "--color-interactive-active", 4.5],
    ["signature action label", "--color-text-on-dark", "--color-primary-surface", 4.5],
    ["signature action hover label", "--color-text-on-dark", "--color-primary-hover", 4.5],
    ["signature action active label", "--color-text-on-dark", "--color-primary-active", 4.5],
    ["destructive hover label", "--color-text-on-dark", "--color-danger-surface", 4.5],
    ["highlight label", "--color-text-on-highlight", "--color-highlight", 4.5],
    ["staged state on detail hero", "--color-interactive-text", "--color-bg-elevated", 4.5],
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

  return { failures, results };
}
