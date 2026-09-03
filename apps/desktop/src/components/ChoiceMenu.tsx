import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "../dialog";
import { NavigationHints } from "./ui";

export function ChoiceMenu<T extends string>({ label, value, options, disabled, onChange }: {
  label: string; value: T; options: readonly { value: T; label: string }[]; disabled?: boolean; onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const title = useId();
  const dialog = useDialogFocus(() => setOpen(false), open);
  return <>
    <button data-focusable className="choice-trigger" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => setOpen(true)}>
      <span>{label}</span><strong>{options.find(option => option.value === value)?.label}</strong>
    </button>
    {open && createPortal(<div className="scrim choice-scrim" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section ref={dialog} className="choice-menu" role="dialog" aria-modal="true" aria-labelledby={title}>
        <h2 id={title}>{label}</h2>
        <div className="choice-options">{options.map(option => <button data-focusable data-autofocus={option.value === value ? true : undefined} key={option.value} aria-pressed={option.value === value}
          onClick={() => { onChange(option.value); setOpen(false); }}>{option.label}</button>)}</div>
        <button data-focusable className="secondary" onClick={() => setOpen(false)}>Cancel</button>
        <NavigationHints />
      </section>
    </div>, document.body)}
  </>;
}
