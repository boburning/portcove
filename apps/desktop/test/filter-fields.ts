import { expect } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

/** Open the actual field, preserving the containing panel and its independent query. */
export async function openFilterField(label: string) {
  const group = globalThis.document.querySelector(`fieldset[aria-label="${label}"]`);
  if (group && group.getBoundingClientRect().height > 0) return;
  const close = [...globalThis.document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => /^Close .+ choices$/.test(node.getAttribute("aria-label") ?? ""),
  );
  if (close) await userEvent.click(close);
  const trigger = page.getByRole("button", { name: new RegExp(`^${label}:`) });
  const rawTrigger = [...globalThis.document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.getAttribute("aria-label")?.startsWith(`${label}:`),
  );
  if (!rawTrigger) throw new Error(`Missing filter field ${label}`);
  const details = rawTrigger.closest("details");
  if (details && !details.open) await userEvent.click(details.querySelector("summary")!);
  await trigger.click();
}

export function filterFieldForChoice(name: string) {
  if (/^(Windows|Linux|Apple silicon|Intel Mac|For this device) \(/.test(name)) return "Target OS";
  if (/^(Stable|Preview|Rolling) \(/.test(name)) return "Release channels";
  if (/^(In my library|Not in my library) \(/.test(name)) return "Library membership";
  if (/^(Available at last check|Matching update staged) \(/.test(name)) return "Observed updates";
  if (/^(Missing game files|Missing BIOS|Missing runtime|Repair needed|Finish setup) \(/.test(name))
    return "Installation attention";
  if (/^Portable upstream package \(/.test(name)) return "Setup methods";
  throw new Error(`No test fixture field registered for ${name}`);
}

export async function filterChoice(name: string) {
  await openFilterField(filterFieldForChoice(name));
  return page.getByRole("checkbox", { name, exact: true });
}

export async function openAdvancedFilters() {
  const close = [...globalThis.document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => /^Close .+ choices$/.test(node.getAttribute("aria-label") ?? ""),
  );
  if (close) await userEvent.click(close);
  const trigger = page.getByRole("button", { name: /^Filters \(\d+\)$/ });
  await expect.element(trigger).toBeVisible();
  if (trigger.element().getAttribute("aria-expanded") !== "true") await trigger.click();
  const advanced = page.getByText("Advanced filters", { exact: true });
  if (!advanced.element().closest("details")?.open) await advanced.click();
}
