export function observeCompletionReturnFocus(originKey = "game-file-libraries-setup") {
  const origin = [...document.querySelectorAll<HTMLElement>("[data-detail-origin]")].find(
    (element) => element.dataset.detailOrigin === originKey,
  );
  const continuation = origin?.querySelector('[aria-label="Continue to a game"]');
  const control = document.activeElement;
  if (!origin || !continuation || !control) return false;
  if (
    ![
      origin?.isConnected,
      continuation?.isConnected,
      control?.isConnected,
      origin?.contains(control),
    ].every(Boolean)
  )
    return false;
  const available = (element: Element) =>
    ![
      element.matches(":disabled, [aria-disabled=true]"),
      Boolean(element.closest("[hidden], [inert], [aria-hidden=true]")),
      element.getClientRects().length === 0,
      getComputedStyle(element).visibility === "hidden",
    ].some(Boolean);
  if (![origin, continuation, control].every(available)) return false;
  if (
    ![
      control === origin,
      control.matches("button, a[href], input, select, textarea, summary, [tabindex]"),
    ].some(Boolean)
  )
    return false;
  return { tag: control.tagName, id: control.id, origin: control === origin };
}

// Serialized by the native driver: keep the observation independent of module scope.
export function observeCompletionResultFocus(name: string) {
  const detail = document.querySelector("[data-detail-workspace]");
  const control = document.activeElement;
  const selectedDetail = document.querySelector("#port-detail-title")?.textContent?.trim() === name;
  const settled = document.querySelector('[aria-labelledby="preparation-review-title"]') === null;
  const belongs = [control?.isConnected, detail?.contains(control)].every(Boolean);
  if (!control || ![selectedDetail, settled, belongs].every(Boolean)) return false;
  const actionable = control.matches(
    "button, a[href], input, select, textarea, summary, [tabindex]",
  );
  const blocked = [
    control.matches(":disabled, [aria-disabled=true]"),
    Boolean(control.closest("[hidden], [inert], [aria-hidden=true]")),
    control.getClientRects().length === 0,
    getComputedStyle(control).visibility === "hidden",
  ].some(Boolean);
  if (!actionable || blocked) return false;
  return {
    tag: control.tagName,
    id: control.id,
    text: control.textContent?.trim(),
    ariaLabel: control.getAttribute("aria-label"),
  };
}
