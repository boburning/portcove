import { expect } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

/** Follow the visible production navigation at desktop, narrow and enlarged widths. */
export async function navigateTo(destination: "Library" | "Find games" | "Activity" | "Settings") {
  const sheet = page.getByRole("dialog", { name: "Navigation", exact: true });
  const trigger = page.getByRole("button", { name: "Open navigation", exact: true });
  if (!sheet.query() && trigger.query()) await trigger.click();
  await page
    .getByRole("navigation", { name: "Primary navigation", exact: true })
    .getByRole("button", { name: new RegExp(`^${destination}\\b`) })
    .click();
  await expect.element(sheet).not.toBeInTheDocument();
}
