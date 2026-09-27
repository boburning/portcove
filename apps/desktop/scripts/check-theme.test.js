import { describe, expect, it } from "vitest";
import {
  ambiguousTextSizeFailures,
  foundationSourceFailures,
  semanticReferenceFailures,
} from "./check-theme.mjs";

const validSources = {
  css: `
    @custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));
    @theme inline { --color-pc-signature: var(--color-accent-surface); }
    :root { --font-ui: "Geist Variable", system-ui; --color-accent-surface: #a92b25; }
    .palette-command {}
    .palette-command:active:not(:disabled) {}
    .port-card {}
    .port-card-selectable:active {}
  `,
  button: `
    const variants = {
      default: "focus-visible:ring-pc-ring forced-colors:focus-visible:outline-2 aria-busy:opacity-70 h-(--control-height-md)",
      primary: "h-(--control-height-lg) active:bg-pc-signature-active",
      selected: "h-(--control-height-sm)",
      destructive: "bg-pc-danger-subtle text-pc-danger-strong hover:bg-pc-danger-surface",
    };
  `,
  dialog: `const classes = "bg-pc-scrim left-1/2 end-2 max-h-[calc(100dvh-2rem)] overflow-y-auto";`,
  main: `document.documentElement.dir = "ltr"; <DirectionProvider direction="ltr" />;`,
  select: `const classes = "pe-2 ps-2 end-2";`,
  updateCenter: `
    const updateRowClass = "grid-cols-[42px_minmax(180px,1fr)_minmax(214px,284px)_90px] max-[65rem]:grid-cols-[2.625rem_minmax(11rem,1fr)_minmax(8rem,1fr)_5.625rem] active:translate-y-px active:shadow-[var(--shadow-pressed)]";
    const activityRowClass = "grid-cols-[1.5rem_minmax(0,1fr)_max-content_max-content] max-[65rem]:grid-cols-[1.5rem_minmax(0,1fr)_4.5rem]";
  `,
  builtCss:
    ".bg-pc-signature{}.bg-pc-scrim{}.active\\:bg-pc-signature-active{}.hover\\:bg-pc-danger-surface{}.text-pc-danger-strong{}.focus-visible\\:ring-pc-ring{}[data-theme=dark]{}",
};

describe("theme foundation source contract", () => {
  it("rejects an ambiguous token utility that Tailwind emits as text color", () => {
    const ambiguous = ["text-[", "var(--text-2xs)]"].join("");
    expect(ambiguousTextSizeFailures(`className="${ambiguous}"`, "Card.tsx")).toEqual([
      `Card.tsx:1: ${ambiguous} compiles as a color; use an explicit length type`,
    ]);
    expect(
      ambiguousTextSizeFailures('className="text-[length:var(--text-2xs)]"', "Card.tsx"),
    ).toEqual([]);
  });

  it("accepts the reviewed semantic, theme, direction, and production mappings", () => {
    expect(foundationSourceFailures(validSources)).toEqual([]);
  });

  it.each([
    ["runtime marker", { css: validSources.css.replace('[data-theme="dark"]', ".dark") }],
    ["raw shared-control color", { dialog: `${validSources.dialog} bg-[#000]` }],
    ["dynamic utility fragment", { select: "const classes = `pe-${size}`;" }],
    [
      "legacy raw-button fallback",
      { css: `${validSources.css} button:not([data-slot="button"]) { color: inherit; }` },
    ],
    [
      "missing specialized owner",
      {
        updateCenter: validSources.updateCenter.replace(
          "active:shadow-[var(--shadow-pressed)]",
          "",
        ),
      },
    ],
    [
      "missing specialized pressed state",
      { css: validSources.css.replace(".palette-command:active:not(:disabled) {}", "") },
    ],
    ["broad transition", { button: `${validSources.button} transition-all` }],
    [
      "weak destructive foreground",
      { button: validSources.button.replace("text-pc-danger-strong", "text-pc-danger") },
    ],
    [
      "missing Tailwind alias target",
      {
        css: validSources.css.replace("var(--color-accent-surface)", "var(--color-does-not-exist)"),
      },
    ],
    ["production variant", { builtCss: ".bg-pc-signature{}.bg-pc-scrim{}" }],
  ])("rejects a missing or unsafe %s contract", (_label, override) => {
    expect(foundationSourceFailures({ ...validSources, ...override })).not.toEqual([]);
  });

  it("rejects missing and cyclic semantic token references", () => {
    expect(
      semanticReferenceFailures(
        new Map([
          ["--color-one", "var(--color-two)"],
          ["--color-two", "var(--color-one)"],
          ["--color-three", "var(--color-missing)"],
        ]),
      ),
    ).toEqual([
      "--color-one contains a cycle through --color-one",
      "--color-two contains a cycle through --color-two",
      "--color-three references missing token --color-missing",
    ]);
  });
});
