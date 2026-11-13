/** One control inventory for keyboard, controller, and top-surface navigation. */
const selector =
  "button, a[href], input, select, textarea, summary, [tabindex], [contenteditable=true], [role=option], [role=menuitem]";
const regionFocus = new WeakMap<HTMLElement, HTMLElement>();

function visibleControl(item: HTMLElement) {
  return (
    (item.tabIndex >= 0 ||
      item.matches("[role=option], [role=menuitem]") ||
      (item.matches("[role=radio], [role=tab]") &&
        Boolean(item.closest("[role=radiogroup], [role=tablist]")))) &&
    !item.matches(":disabled, [aria-disabled=true]") &&
    !item.closest("[inert], [hidden], [aria-hidden=true]") &&
    item.getClientRects().length > 0 &&
    getComputedStyle(item).visibility !== "hidden"
  );
}

export function navigationScope(): HTMLElement | Document {
  const surfaces = [
    ...document.querySelectorAll<HTMLElement>(
      "[role=dialog][aria-modal=true], [data-portcove-focus-scope]:not([data-closed])",
    ),
  ].filter((item) => item.getClientRects().length > 0);
  return surfaces.at(-1) ?? document;
}

export function focusableControls(scope: HTMLElement | Document = navigationScope()) {
  return [...scope.querySelectorAll<HTMLElement>(selector)].filter(visibleControl);
}

export function focusAndReveal(item: HTMLElement | null | undefined) {
  const region = item?.closest<HTMLElement>("[data-focus-region]");
  if (item && region) regionFocus.set(region, item);
  item?.focus({ preventScroll: true });
  item?.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (item) containWithinScroller(item);
}

/**
 * Browsers round scroll positions to whole pixels, which can leave a control with a
 * fractional height clipped by less than a pixel after a "nearest" reveal. Nudge the
 * nearest vertical scroller outward so the revealed control is fully contained.
 */
function containWithinScroller(item: HTMLElement) {
  let scroller = item.parentElement;
  while (scroller && scroller !== document.body) {
    const { overflowY } = getComputedStyle(scroller);
    if (/(auto|scroll|overlay)/u.test(overflowY) && scroller.scrollHeight > scroller.clientHeight)
      break;
    scroller = scroller.parentElement;
  }
  const target = scroller && scroller !== document.body ? scroller : document.scrollingElement;
  if (!target) return;
  const bounds =
    target === document.scrollingElement
      ? { top: 0, bottom: window.innerHeight }
      : target.getBoundingClientRect();
  const visibleTop = bounds.top + (target === document.scrollingElement ? 0 : target.clientTop);
  const visibleBottom = visibleTop + target.clientHeight;
  const rect = item.getBoundingClientRect();
  if (rect.height > target.clientHeight) return;
  // Only a sub-pixel residual is corrected; anything larger belongs to the browser's
  // own reveal or to deliberate scroll restoration and is left untouched.
  const below = rect.bottom - visibleBottom;
  const above = visibleTop - rect.top;
  if (below > 0 && below < 1) target.scrollTop += 1;
  else if (above > 0 && above < 1) target.scrollTop -= 1;
}

export function focusRegion(name: "sidebar" | "workspace") {
  if (navigationScope() !== document) return false;
  const region = document.querySelector<HTMLElement>(`[data-focus-region=${name}]`);
  if (!region) return false;
  const previous = regionFocus.get(region);
  const controls = focusableControls(region);
  const target =
    previous && controls.includes(previous)
      ? previous
      : (controls.find((item) => item.getAttribute("aria-current") === "page") ?? controls[0]);
  focusAndReveal(target);
  return Boolean(target);
}

export function cyclePrimaryNavigation(offset: number, navigate?: (offset: number) => void) {
  if (navigationScope() !== document) return;
  const navigation = document.querySelector<HTMLElement>("nav[aria-label='Primary navigation']");
  if (!navigation) return;
  const items = focusableControls(navigation).filter((item) =>
    item.hasAttribute("data-navigation-destination"),
  );
  // Compact navigation exposes a dialog trigger instead of visible destination
  // controls. Its owning app changes routes through the same callback as clicks.
  if (items.length === 0) {
    navigate?.(offset);
    return;
  }
  const current = items.findIndex((item) => item.getAttribute("aria-current") === "page");
  const target = items[(current + offset + items.length) % items.length];
  if (target) {
    focusAndReveal(target);
    activateControl(target);
  }
}

export function fieldOwnsArrows(target: HTMLElement | null) {
  return Boolean(
    target?.closest(
      "input, textarea, select, [contenteditable=true], [role=combobox], [role=radio], [role=tab], [role=menuitem]",
    ),
  );
}

function activateControl(item: HTMLElement) {
  item.click();
}

export function activateFocusedControl() {
  const scope = navigationScope();
  const focused = document.activeElement;
  if (
    focused instanceof HTMLElement &&
    focused !== scope &&
    scope.contains(focused) &&
    focused.matches(selector) &&
    visibleControl(focused)
  ) {
    activateControl(focused);
  } else {
    focusAndReveal(focusableControls(scope)[0]);
  }
}

export function dismissActiveDialog() {
  const scope = navigationScope();
  if (scope === document) return false;
  const escape = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  scope.dispatchEvent(escape);
  // A top surface owns Back even when it declines Escape dismissal.
  return true;
}
