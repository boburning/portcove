import { useEffect, useId, useRef, useState } from "react";
import { useAppTranslation } from "../localization";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ActionRow, Notice } from "./ui/patterns";

export function CreateCleanModSetup({
  runtime,
  locked,
  working,
  error,
  onDismiss,
  create,
  onCreated,
}: {
  runtime: string;
  locked: boolean;
  working: boolean;
  error: string | undefined;
  onDismiss: () => void;
  create: (name: string) => Promise<boolean>;
  onCreated: () => void;
}) {
  const { t } = useAppTranslation("gameSettings");
  const nameId = useId();
  const panelId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  useEffect(() => {
    if (error && form.current?.contains(document.activeElement)) {
      actions.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [error]);

  const dismiss = () => {
    setOpen(false);
    setName("");
    onDismiss();
    toggle.current?.focus();
  };

  return (
    <div className="grid gap-2">
      <ActionRow>
        <Button
          ref={toggle}
          variant="outline"
          disabled={locked}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => (open ? dismiss() : setOpen(true))}
        >
          {t("mods.clean.open")}
        </Button>
      </ActionRow>
      {open && (
        <form
          ref={form}
          id={panelId}
          className="grid gap-2 rounded-pc-md border border-pc-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            const display = name.trim();
            if (locked || !display) return;
            void create(display).then((created) => {
              if (created) {
                setOpen(false);
                setName("");
                if (form.current?.contains(document.activeElement)) onCreated();
              }
            });
          }}
        >
          <p className="text-sm">{t("mods.clean.description")}</p>
          <bdi className="text-sm [overflow-wrap:anywhere] text-pc-muted-foreground">{runtime}</bdi>
          <div className="grid gap-1.5">
            <label htmlFor={nameId} className="text-sm">
              {t("mods.clean.name")}
            </label>
            <Input
              ref={field}
              id={nameId}
              value={name}
              onValueChange={setName}
              className="max-w-64"
            />
          </div>
          <div ref={actions} className="grid gap-2">
            {error && (
              <Notice role="alert" dir="auto" className="[overflow-wrap:anywhere]">
                {error}
              </Notice>
            )}
            <ActionRow>
              <Button
                type="submit"
                disabled={locked || !name.trim()}
                aria-busy={working || undefined}
                focusableWhenDisabled={locked && Boolean(name.trim())}
              >
                {t("mods.clean.create")}
              </Button>
              <Button type="button" variant="outline" disabled={working} onClick={dismiss}>
                {t("mods.clean.cancel")}
              </Button>
            </ActionRow>
          </div>
        </form>
      )}
    </div>
  );
}
