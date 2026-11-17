import { useEffect, useId, useRef, useState } from "react";
import { useAppTranslation } from "../localization";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ActionRow } from "./ui/patterns";

export function CreateCleanModSetup({
  runtime,
  locked,
  create,
  onCreated,
}: {
  runtime: string;
  locked: boolean;
  create: (name: string) => Promise<boolean>;
  onCreated: () => void;
}) {
  const { t } = useAppTranslation("gameSettings");
  const nameId = useId();
  const panelId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  return (
    <div className="grid gap-2">
      <ActionRow>
        <Button
          ref={toggle}
          variant="outline"
          disabled={locked}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen(true)}
        >
          {t("mods.clean.open")}
        </Button>
      </ActionRow>
      {open && (
        <form
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
                onCreated();
              }
            });
          }}
        >
          <p className="text-sm">{t("mods.clean.description")}</p>
          <bdi className="text-sm break-all">{runtime}</bdi>
          <ActionRow>
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
            <Button type="submit" disabled={locked || !name.trim()}>
              {t("mods.clean.create")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setOpen(false);
                setName("");
                toggle.current?.focus();
              }}
            >
              {t("mods.clean.cancel")}
            </Button>
          </ActionRow>
        </form>
      )}
    </div>
  );
}
