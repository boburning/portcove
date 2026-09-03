/** One control inventory for keyboard, controller, and modal navigation. */
const selector = "button, a[href], input, select, textarea, summary, [tabindex], [contenteditable=true]";
const regionFocus = new WeakMap<HTMLElement, HTMLElement>();

export function visibleControl(item: HTMLElement) {
  return item.tabIndex >= 0 && !item.matches(":disabled, [aria-disabled=true]")
    && !item.closest("[inert], [hidden], [aria-hidden=true]")
    && item.getClientRects().length > 0 && getComputedStyle(item).visibility !== "hidden";
}

export function navigationScope(): HTMLElement | Document {
  const dialogs = [...document.querySelectorAll<HTMLElement>("[role=dialog][aria-modal=true]")]
    .filter(item => item.getClientRects().length > 0);
  return dialogs.at(-1) ?? document;
}

export function focusableControls(scope: HTMLElement | Document = navigationScope()) {
  return [...scope.querySelectorAll<HTMLElement>(selector)].filter(visibleControl);
}

export function focusAndReveal(item: HTMLElement | null | undefined) {
  const region = item?.closest<HTMLElement>("[data-focus-region]");
  if (item && region) regionFocus.set(region, item);
  item?.focus({ preventScroll: true });
  item?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

export function focusRegion(name: "sidebar" | "workspace") {
  if (navigationScope() !== document) return false;
  const region = document.querySelector<HTMLElement>(`[data-focus-region=${name}]`);
  if (!region) return false;
  const previous = regionFocus.get(region);
  const target = previous && region.contains(previous) && visibleControl(previous) ? previous
    : region.querySelector<HTMLElement>("[aria-current=page]") ?? focusableControls(region)[0];
  focusAndReveal(target);
  return Boolean(target);
}

export function cyclePrimaryNavigation(offset: number) {
  if (navigationScope() !== document) return;
  const navigation = document.querySelector<HTMLElement>("nav[aria-label='Primary navigation']");
  if (!navigation) return;
  const items = focusableControls(navigation);
  const current = items.findIndex(item => item.getAttribute("aria-current") === "page");
  const target = items[(current + offset + items.length) % items.length];
  if (target) { focusAndReveal(target); activateControl(target); }
}

export function fieldOwnsArrows(target: HTMLElement | null) {
  return Boolean(target?.closest("input, textarea, select, [contenteditable=true], [role=combobox]"));
}

export function activateControl(item: HTMLElement) {
  item.click();
}

export function dismissActiveDialog() {
  const scope = navigationScope();
  if (scope === document) return false;
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  scope.dispatchEvent(escape);
  return escape.defaultPrevented;
}
