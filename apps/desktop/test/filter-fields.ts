import { expect } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

/** Open the actual field, preserving the containing panel and its independent query. */
export async function openFilterField(label: string) {
  const selected = page.getByRole("button", { name: new RegExp(`^${label}:`) });
  const group = globalThis.document.querySelector(`fieldset[aria-label="${label}"]`);
  if (
    group &&
    group.getBoundingClientRect().height > 0 &&
    selected.element().getAttribute("aria-expanded") === "true"
  )
    return;
  await closeOpenFilterField();
  const trigger = page.getByRole("button", { name: new RegExp(`^${label}:`) });
  const rawTrigger = [...globalThis.document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.getAttribute("aria-label")?.startsWith(`${label}:`),
  );
  if (!rawTrigger) throw new Error(`Missing filter field ${label}`);
  const details = rawTrigger.closest("details");
  if (details && !details.open) await userEvent.click(details.querySelector("summary")!);
  await trigger.click();
}

function filterFieldForChoice(name: string) {
  if (/^(Windows|Linux|Apple silicon|Intel Mac|For this device) \(/.test(name)) return "Target OS";
  if (/^(Stable|Preview|Rolling) \(/.test(name)) return "Release channels";
  if (/^(In my library|Not in my library) \(/.test(name)) return "Library membership";
  if (/^(Available at last check|Matching update staged) \(/.test(name)) return "Observed updates";
  if (/^(Missing game files|Missing BIOS|Missing runtime|Repair needed|Finish setup) \(/.test(name))
    return "Installation attention";
  if (/^(Portable upstream package|Original disc referenced at launch) \(/.test(name))
    return "Setup methods";
  if (
    /^(Compatible complete files available|Files missing|Needs checking|No files to add in Portcove|Unavailable context) \(/.test(
      name,
    )
  )
    return "Game files";
  throw new Error(`No test fixture field registered for ${name}`);
}

export async function filterChoice(name: string) {
  await openFilterField(filterFieldForChoice(name));
  return page.getByRole("checkbox", { name, exact: true });
}

export async function openAdvancedFilters() {
  await closeOpenFilterField();
  const trigger = page.getByRole("button", { name: /^Filters \(\d+\)$/ });
  await expect.element(trigger).toBeVisible();
  if (trigger.element().getAttribute("aria-expanded") !== "true") await trigger.click();
  const advanced = page.getByText("Advanced filters", { exact: true });
  if (!advanced.element().closest("details")?.open) await advanced.click();
}

async function closeOpenFilterField() {
  const trigger = globalThis.document.querySelector<HTMLButtonElement>(
    '.catalog-filter-panel button[aria-haspopup="dialog"][aria-expanded="true"]',
  );
  if (!trigger) return;
  const label = trigger.getAttribute("aria-label")!.split(":")[0];
  await page.getByRole("button", { name: `Close ${label} choices`, exact: true }).click();
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  await expect.element(trigger).toHaveFocus();
}

export async function closeFilterPanel() {
  const field = globalThis.document.querySelector<HTMLButtonElement>(
    '.catalog-filter-panel button[aria-haspopup="dialog"][aria-expanded="true"]',
  );
  if (field) await userEvent.keyboard("{Escape}");
  await expect
    .poll(() =>
      globalThis.document.querySelector(
        '.catalog-filter-panel button[aria-haspopup="dialog"][aria-expanded="true"]',
      ),
    )
    .toBeNull();
  await expect.poll(() => field === null || globalThis.document.activeElement === field).toBe(true);
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("region", { name: "Filter options", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: /^Filters \(\d+\)$/, exact: true }))
    .toHaveFocus();
}
