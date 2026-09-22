import { describe, expect, it } from "vitest";
import { foundationSourceFailures, semanticReferenceFailures } from "./check-theme.mjs";

const validSources = {
  css: `
    @custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));
    @theme inline { --color-pc-signature: var(--color-accent-surface); }
    :root { --font-ui: "Geist Variable", system-ui; --color-accent-surface: #a92b25; }
  `,
  button: `
    const variants = {
      default: "focus-visible:ring-pc-ring forced-colors:focus-visible:outline-2 aria-busy:opacity-70 h-(--control-height-md)",
      primary: "h-(--control-height-lg) active:bg-pc-signature-active",
      selected: "h-(--control-height-sm)",
      destructive: "text-pc-danger hover:bg-pc-danger-surface",
    };
  `,
  dialog: `const classes = "bg-pc-scrim left-1/2 end-2 max-h-[calc(100dvh-2rem)] overflow-y-auto";`,
  main: `document.documentElement.dir = "ltr"; <DirectionProvider direction="ltr" />;`,
  select: `const classes = "pe-2 ps-2 end-2";`,
  builtCss:
    ".bg-pc-signature{}.bg-pc-scrim{}.active\\:bg-pc-signature-active{}.hover\\:bg-pc-danger-surface{}.focus-visible\\:ring-pc-ring{}[data-theme=dark]{}",
};

describe("theme foundation source contract", () => {
  it("accepts the reviewed semantic, theme, direction, and production mappings", () => {
    expect(foundationSourceFailures(validSources)).toEqual([]);
  });

  it.each([
    ["runtime marker", { css: validSources.css.replace('[data-theme="dark"]', ".dark") }],
    ["raw shared-control color", { dialog: `${validSources.dialog} bg-[#000]` }],
    ["dynamic utility fragment", { select: "const classes = `pe-${size}`;" }],
    ["broad transition", { button: `${validSources.button} transition-all` }],
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
