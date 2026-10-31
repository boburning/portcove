import { afterEach, expect, it } from "vite-plus/test";
import getAttribute from "selenium-webdriver/lib/atoms/get-attribute.js";
import isDisplayed from "selenium-webdriver/lib/atoms/is-displayed.js";

afterEach(() => document.body.replaceChildren());

it("Selenium's shipped attribute atom preserves native harness values and absence", () => {
  const input = document.createElement("input");
  input.className = "owned-input";
  input.disabled = true;
  input.setAttribute("aria-label", "Owned library — 日本語");
  input.value = "player value";
  document.body.append(input);
  expect(getAttribute(input, "class")).toBe("owned-input");
  expect(getAttribute(input, "disabled")).toBe("true");
  expect(getAttribute(input, "aria-label")).toBe("Owned library — 日本語");
  expect(getAttribute(input, "value")).toBe("player value");
  expect(getAttribute(input, "missing-attribute")).toBeNull();
});

it("Selenium's shipped display atom distinguishes visible controls and hidden ancestry", () => {
  const parent = document.createElement("div");
  const button = document.createElement("button");
  button.textContent = "Owned action";
  parent.append(button);
  document.body.append(parent);
  expect(isDisplayed(button)).toBe(true);
  button.style.display = "none";
  expect(isDisplayed(button)).toBe(false);
  button.style.display = "";
  button.style.visibility = "hidden";
  expect(isDisplayed(button)).toBe(false);
  button.style.visibility = "";
  parent.hidden = true;
  expect(isDisplayed(button)).toBe(false);
  parent.hidden = false;
  expect(isDisplayed(button)).toBe(true);
});

it("Selenium's shipped attribute atom reads SVG attributes without leaking animated objects", () => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "owned-icon");
  svg.setAttribute("aria-label", "Owned icon — 日本語");
  document.body.append(svg);
  expect(getAttribute(svg, "class")).toBe("owned-icon");
  expect(getAttribute(svg, "aria-label")).toBe("Owned icon — 日本語");
});

it("Selenium's shipped atoms survive WebDriver function serialization in a real DOM", async () => {
  const button = document.createElement("button");
  button.textContent = "Owned serialized action";
  button.setAttribute("aria-label", "Serialized — 日本語");
  document.body.append(button);
  // A separate module executes the shipped function source without its original lexical scope.
  const source = `export const attribute = ${getAttribute.toString()}; export const displayed = ${isDisplayed.toString()};`;
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    const atoms = (await import(/* @vite-ignore */ url)) as {
      attribute: (element: Element, name: string) => unknown;
      displayed: (element: Element) => unknown;
    };
    expect(atoms.attribute(button, "aria-label")).toBe("Serialized — 日本語");
    expect(atoms.displayed(button)).toBe(true);
    button.hidden = true;
    expect(atoms.displayed(button)).toBe(false);
  } finally {
    URL.revokeObjectURL(url);
  }
});
