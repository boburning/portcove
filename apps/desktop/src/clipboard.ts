function captureTextSelection() {
  const selection = document.getSelection();
  if (!selection?.anchorNode || !selection.focusNode || !selection.rangeCount) return;
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  const { startContainer, startOffset, endContainer, endOffset } = selection.getRangeAt(0);
  const text = selection.toString();

  return () => {
    if (!anchorNode.isConnected || !focusNode.isConnected) return;
    // Live Range clones can retarget after edits. Check the original boundaries.
    const unchanged = document.createRange();
    unchanged.setStart(startContainer, startOffset);
    unchanged.setEnd(endContainer, endOffset);
    if (unchanged.toString() === text) {
      selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
    }
  };
}

function captureInputSelection(focused: Element | null) {
  if (!(focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement)) return;
  const { value, selectionStart, selectionEnd, selectionDirection } = focused;
  if (selectionStart === null || selectionEnd === null) return;

  return () => {
    if (focused.isConnected && focused.value === value) {
      focused.setSelectionRange(selectionStart, selectionEnd, selectionDirection ?? undefined);
    }
  };
}

function restoreCopyFocus(focused: Element | null, restoreSelection: (() => void) | undefined) {
  try {
    if (
      focused instanceof HTMLElement &&
      focused.isConnected &&
      document.activeElement !== focused
    ) {
      focused.focus({ preventScroll: true });
    }
    restoreSelection?.();
  } catch {
    // A changed selection or control cannot change the original copy outcome.
  }
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const focused = document.activeElement;
  const restoreSelection = captureInputSelection(focused) ?? captureTextSelection();
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.tabIndex = -1;
  field.style.position = "fixed";
  field.style.opacity = "0";
  try {
    document.body.append(field);
    field.select();
    if (!document.execCommand("copy")) throw new Error("Clipboard access is unavailable.");
  } finally {
    // A copy handler may deliberately move focus. Only undo this field's own handoff.
    const restore = document.activeElement === field || document.activeElement === focused;
    field.remove();
    if (restore) restoreCopyFocus(focused, restoreSelection);
  }
}
