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
  assert.ok(Number(fieldPresentation.labelFontWeight) >= 700, JSON.stringify(fieldPresentation));
  return fieldPresentation;
}
