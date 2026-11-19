export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const focused = document.activeElement;
  const input =
    focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused : null;
  const inputSelection =
    input && input.selectionStart !== null && input.selectionEnd !== null
      ? {
          value: input.value,
          start: input.selectionStart,
          end: input.selectionEnd,
          direction: input.selectionDirection,
        }
      : null;
  const selection = document.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const selectedText =
    selection?.anchorNode && selection.focusNode && range
      ? {
          anchor: selection.anchorNode,
          anchorOffset: selection.anchorOffset,
          focus: selection.focusNode,
          focusOffset: selection.focusOffset,
          start: range.startContainer,
          startOffset: range.startOffset,
          end: range.endContainer,
          endOffset: range.endOffset,
          text: selection.toString(),
        }
      : null;
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
    // A copy handler may deliberately move focus; only undo this field's own handoff.
    const restore = document.activeElement === field || document.activeElement === focused;
    field.remove();
    if (restore) {
      try {
        if (focused instanceof HTMLElement && focused.isConnected) {
          if (document.activeElement !== focused) focused.focus({ preventScroll: true });
          if (input && inputSelection && input.value === inputSelection.value)
            input.setSelectionRange(
              inputSelection.start,
              inputSelection.end,
              inputSelection.direction ?? undefined,
            );
        }
        if (!inputSelection && selectedText?.anchor.isConnected && selectedText.focus.isConnected) {
          // Rebuild from the original boundaries; live Range clones can retarget after edits.
          const unchanged = document.createRange();
          unchanged.setStart(selectedText.start, selectedText.startOffset);
          unchanged.setEnd(selectedText.end, selectedText.endOffset);
          if (unchanged.toString() === selectedText.text)
            selection?.setBaseAndExtent(
              selectedText.anchor,
              selectedText.anchorOffset,
              selectedText.focus,
              selectedText.focusOffset,
            );
        }
      } catch {
        // A changed selection or control cannot change the original copy outcome.
      }
    }
  }
}
