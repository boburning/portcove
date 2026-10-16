export function observeCompletionReturnFocus() {
  const origin = document.querySelector('[data-detail-origin="game-file-libraries-setup"]');
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
