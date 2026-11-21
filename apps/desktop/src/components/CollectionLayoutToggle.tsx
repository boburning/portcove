import { LayoutGrid, List } from "lucide-react";
import { Icon } from "./ui";
import { Button } from "./ui/button";

export function CollectionLayoutToggle({
  layout,
  onChange,
  labels = {
    group: "Collection view",
    view: "View",
    covers: "Covers",
    rows: "Rows",
    rowsName: "Compact rows",
  },
}: {
  layout: "covers" | "rows";
  onChange: (layout: "covers" | "rows") => void;
  labels?: { group: string; view: string; covers: string; rows: string; rowsName: string };
}) {
  return (
    <div
      role="group"
      data-collection-layout
      aria-label={labels.group}
      className="ms-auto flex flex-wrap gap-1"
    >
      <span className="self-center text-xs text-pc-muted-foreground">{labels.view}</span>
      {(["covers", "rows"] as const).map((nextLayout) => (
        <Button
          key={nextLayout}
          variant={layout === nextLayout ? "selected" : "ghost"}
          size="sm"
          aria-pressed={layout === nextLayout}
          aria-label={nextLayout === "rows" ? labels.rowsName : labels.covers}
          data-focusable
          onClick={() => onChange(nextLayout)}
        >
          <Icon glyph={nextLayout === "covers" ? LayoutGrid : List} size="sm" />
          <span className="collection-layout-label">{labels[nextLayout]}</span>
        </Button>
      ))}
    </div>
  );
}
