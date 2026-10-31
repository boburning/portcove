import assert from "node:assert/strict";
import type { WebDriver, WebElement } from "selenium-webdriver";
import { executeBrowserScript } from "./browser-script.mts";

export async function assertReviewFieldPresentation(
  browser: WebDriver,
  field: WebElement,
  label: WebElement,
  dialog: WebElement,
) {
  const fieldPresentation = await executeBrowserScript(
    browser,
    (field, label, dialog) => {
      const fieldStyle = getComputedStyle(field);
      const labelStyle = getComputedStyle(label);
      const dialogStyle = getComputedStyle(dialog);
      return {
        width: fieldStyle.width,
        paddingLeft: fieldStyle.paddingLeft,
        borderStyle: fieldStyle.borderStyle,
        borderWidth: fieldStyle.borderWidth,
        backgroundColor: fieldStyle.backgroundColor,
        dialogBackgroundColor: dialogStyle.backgroundColor,
        color: fieldStyle.color,
        labelColor: labelStyle.color,
        labelFontWeight: labelStyle.fontWeight,
      };
    },
    field,
    label,
    dialog,
  );
  assert.ok(parseFloat(fieldPresentation.width) >= 200, JSON.stringify(fieldPresentation));
  assert.ok(parseFloat(fieldPresentation.paddingLeft) >= 10, JSON.stringify(fieldPresentation));
  assert.equal(fieldPresentation.borderStyle, "solid");
  assert.ok(parseFloat(fieldPresentation.borderWidth) >= 1, JSON.stringify(fieldPresentation));
  assert.notEqual(fieldPresentation.backgroundColor, "rgba(0, 0, 0, 0)");
  assert.notEqual(fieldPresentation.backgroundColor, fieldPresentation.dialogBackgroundColor);
  // Shared Field labels use the approved semibold presentation.
  assert.ok(Number(fieldPresentation.labelFontWeight) >= 600, JSON.stringify(fieldPresentation));
  return fieldPresentation;
}

export function readReviewFieldStyles(
  browser: Pick<WebDriver, "executeScript">,
  ...fields: WebElement[]
) {
  return executeBrowserScript(
    browser,
    (...fields) =>
      fields.map((field) => {
        const style = getComputedStyle(field);
        return {
          width: style.width,
          paddingLeft: style.paddingLeft,
          borderStyle: style.borderStyle,
          borderWidth: style.borderWidth,
          backgroundColor: style.backgroundColor,
          color: style.color,
        };
      }),
    ...fields,
  );
}

/** Observe exact port membership; a grouped card is not an installation identity. */
export function decodeDiscoverPortIds(value: string | null): string[] {
  const ids: unknown = JSON.parse(value ?? "null");
  assert.ok(Array.isArray(ids), "Discover group lost its exact port identities");
  const candidates: unknown[] = ids;
  const validated = candidates.map((id) => {
    assert.ok(
      typeof id === "string" && id.length > 0,
      "Discover group lost its exact port identities",
    );
    return id;
  });
  assert.equal(
    new Set(validated).size,
    validated.length,
    "Discover group repeated a port identity",
  );
  return validated;
}
