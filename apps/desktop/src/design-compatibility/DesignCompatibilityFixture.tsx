import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import "./design-compatibility.css";

type Theme = "dark" | "light";

export function DesignCompatibilityFixture() {
  const [theme, setTheme] = useState<Theme>("dark");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectOpen, setSelectOpen] = useState(false);
  const selectOpenRef = useRef(false);
  const selectDismissal = useRef(false);
  const [channel, setChannel] = useState("stable");
  const [reduceMotion, setReduceMotion] = useState(false);

  return (
    <main
      className={`design-compatibility-fixture${theme === "dark" ? " dark" : ""}`}
      data-theme={theme}
      data-reduced-motion={reduceMotion}
      data-dialog-open={dialogOpen}
      data-select-open={selectOpen}
    >
      <header className="design-compatibility-heading">
        <img
          src="/brand/icons/portcove-mascot-head-256.png"
          alt=""
          width="56"
          height="56"
          data-offline-asset
        />
        <div>
          <p className="eyebrow">Native compatibility fixture</p>
          <h1>Installation review foundation</h1>
          <p>Generated Base Nova controls use Portcove semantic tokens and bundled assets only.</p>
        </div>
      </header>

      <section className="design-compatibility-controls" aria-label="Fixture controls">
        <div role="group" aria-label="Theme">
          <Button
            id="fixture-theme-dark"
            variant={theme === "dark" ? "default" : "outline"}
            aria-pressed={theme === "dark"}
            onClick={() => setTheme("dark")}
          >
            Dark theme
          </Button>
          <Button
            id="fixture-theme-light"
            variant={theme === "light" ? "default" : "outline"}
            aria-pressed={theme === "light"}
            onClick={() => setTheme("light")}
          >
            Light theme
          </Button>
        </div>
        <Button
          id="fixture-reduced-motion"
          variant="outline"
          aria-pressed={reduceMotion}
          onClick={() => setReduceMotion((value) => !value)}
        >
          {reduceMotion ? "Reduced motion preview on" : "Preview reduced motion"}
        </Button>
      </section>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open, eventDetails) => {
          const nestedEscape =
            eventDetails.reason === "escape-key" &&
            (selectOpenRef.current || selectDismissal.current);
          if (!open && nestedEscape) {
            selectOpenRef.current = false;
            selectDismissal.current = false;
            setSelectOpen(false);
            eventDetails.cancel();
            requestAnimationFrame(() =>
              document.querySelector<HTMLElement>("#fixture-channel")?.focus(),
            );
            return;
          }
          selectOpenRef.current = false;
          selectDismissal.current = false;
          setDialogOpen(open);
        }}
      >
        <DialogTrigger render={<Button id="fixture-open-dialog" />}>Review install</DialogTrigger>
        <DialogContent aria-describedby="fixture-dialog-description">
          <DialogHeader>
            <DialogTitle>Review installation</DialogTitle>
            <DialogDescription id="fixture-dialog-description">
              Select a release channel before continuing. No download or installation runs in this
              fixture.
            </DialogDescription>
          </DialogHeader>

          <label className="design-compatibility-field" htmlFor="fixture-channel">
            <span>Release channel</span>
            <Select
              open={selectOpen}
              onOpenChange={(open, eventDetails) => {
                if (open) {
                  selectOpenRef.current = true;
                }
                if (!open) {
                  if (eventDetails.reason === "escape-key") {
                    eventDetails.event.stopPropagation();
                    eventDetails.event.stopImmediatePropagation();
                    selectDismissal.current = true;
                  }
                }
                setSelectOpen(open);
              }}
              onOpenChangeComplete={(open) => {
                if (!open) {
                  selectOpenRef.current = false;
                  selectDismissal.current = false;
                }
              }}
              value={channel}
              onValueChange={(value) => setChannel(value ?? "stable")}
            >
              <SelectTrigger id="fixture-channel" aria-label="Release channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stable">Stable</SelectItem>
                <SelectItem value="preview">Preview</SelectItem>
                <SelectItem value="nightly">Nightly</SelectItem>
              </SelectContent>
            </Select>
          </label>

          <p id="fixture-selection" role="status">
            {channel === "stable" ? "Stable" : channel === "preview" ? "Preview" : "Nightly"}
            {" channel selected"}
          </p>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" id="fixture-cancel" />}>
              Cancel
            </DialogClose>
            <DialogClose render={<Button id="fixture-confirm" />}>Continue</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
