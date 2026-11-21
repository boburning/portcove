import {
  defaultRangeExtractor,
  useVirtualizer,
  useWindowVirtualizer,
} from "@tanstack/react-virtual";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  registerCollectionNavigation,
  type CollectionDestination,
} from "../../collection-navigation";
import { focusAndReveal, focusableControls, fieldOwnsArrows, navigationScope } from "../../focus";
import { useAppTranslation } from "../../localization";
import { workspaceScrollOwner, scrollWorkspaceTo } from "../../workspace-scroll";
import type { CollectionLayout } from "./use-collection-layout";
import type { GameGroup } from "./original-game";
import {
  discoverDestinationIndex,
  discoverRows,
  resolvedGridColumns,
} from "./virtual-discover-model";

type Anchor = {
  groupKey: string;
  top: number;
  focus:
    | {
        groupKey: string;
        originKey: string | undefined;
        controlKey: string | undefined;
        control: number;
        group: boolean;
      }
    | undefined;
};

/** One measured visual row preserves shared tracks, layout and collection navigation. */
export function VirtualCollectionRows({
  ready = true,
  queryKey = "",
  groups,
  layout,
  generation,
  overlayPin,
  children,
  label,
  collection = "catalog",
  onMountDestination,
}: {
  ready?: boolean | undefined;
  queryKey?: string | undefined;
  groups: readonly GameGroup[];
  layout: CollectionLayout;
  generation: number | undefined;
  overlayPin: string | undefined;
  children: (group: GameGroup, index: number) => ReactNode;
  label: string;
  collection?: "catalog" | "library";
  onMountDestination?: ((group: GameGroup, target: CollectionDestination) => void) | undefined;
}) {
  // TanStack's mutable adapter must remain outside compiler memoization. Keep its
  // instance and derived range local; remove this boundary when its API is reactive.
  // https://react.dev/reference/react-compiler/directives/use-no-memo#third-party-library-integration
  "use no memo";
  const root = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const { i18n } = useAppTranslation("browsing");
  const [geometry, setGeometry] = useState({
    columns: 1,
    width: 0,
    margin: 0,
    gap: 0,
    font: "",
    measurementEpoch: 0,
    owner: null as HTMLElement | null,
  });
  const [focusedPin, setFocusedPin] = useState<string>();
  const [destinationPin, setDestinationPin] = useState<string>();
  const rows = useMemo(() => discoverRows(groups, geometry.columns), [groups, geometry.columns]);
  const structure = JSON.stringify([
    generation,
    layout,
    geometry.columns,
    rows.map(({ key }) => key),
  ]);
  const mounted = useRef(true);
  const hasAccepted = useRef(ready);
  if (ready) hasAccepted.current = true;
  const intent = useRef(0);
  const model = useRef({
    structure,
    groups,
    rows,
    ready,
    queryKey,
    generation,
    onMountDestination,
  });
  model.current = { structure, groups, rows, ready, queryKey, generation, onMountDestination };
  const reading = useRef<Anchor | undefined>(undefined);
  const lastAccepted = useRef({ structure, queryKey, generation, layout });
  const regroup = useRef<Anchor | undefined>(undefined);
  const restoringRegroup = useRef<{ anchor: Anchor; token: number } | undefined>(undefined);
  const measurementPending = useRef(true);
  const measurementEpoch = useRef(0);
  // Reflect this owner's existing work for observers that must reveal a target
  // only after responsive anchor restoration has finished. React does not own
  // these attributes; publication follows the actual measurement/work tokens.
  const publishLayoutPending = useCallback(() => {
    if (root.current)
      root.current.dataset.collectionLayoutPending = String(
        measurementPending.current ||
          regroup.current !== undefined ||
          restoringRegroup.current !== undefined,
      );
  }, []);
  const work = useRef(0);
  const mounting = useRef(0);
  const tabPending = useRef<{ origin: HTMLElement; direction: number } | undefined>(undefined);
  const workspace = () =>
    root.current?.closest<HTMLElement>("[data-focus-region=workspace]") ?? null;
  const documentOwner =
    typeof document !== "undefined" &&
    (geometry.owner === document.scrollingElement || geometry.owner === document.documentElement);
  const pins = useMemo(
    () =>
      [focusedPin, overlayPin, destinationPin].flatMap((key) => {
        const index = rows.findIndex((row) => row.groups.some((group) => group.id === key));
        return index < 0 ? [] : [index];
      }),
    [rows, focusedPin, overlayPin, destinationPin],
  );
  const rangeExtractor = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) =>
      [...new Set([...defaultRangeExtractor(range), ...pins])].sort((a, b) => a - b),
    [pins],
  );
  const options = {
    count: rows.length,
    estimateSize: () => (layout === "rows" ? 150 : 560),
    getItemKey: (index: number) => `${layout}:${geometry.columns}:${rows[index]!.key}`,
    overscan: 2,
    gap: geometry.gap,
    scrollMargin: geometry.margin,
    rangeExtractor,
    useAnimationFrameWithResizeObserver: true,
    initialRect: { width: 0, height: 800 },
  };
  // oxlint-disable-next-line react/incompatible-library -- Explicit compiler opt-out above; range reads are not memoized or passed to memoized children.
  const elementVirtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    ...options,
    getScrollElement: () => geometry.owner,
    enabled: Boolean(geometry.owner) && !documentOwner,
  });
  const windowVirtualizer = useWindowVirtualizer<HTMLDivElement>({
    ...options,
    enabled: Boolean(geometry.owner) && documentOwner,
  });
  const virtualizer = documentOwner ? windowVirtualizer : elementVirtualizer;
  const latest = useRef({ virtualizer, geometry });
  latest.current = { virtualizer, geometry };

  const retainRegroupAnchor = useCallback(() => {
    const restoring = restoringRegroup.current;
    const retained = restoring?.token === work.current ? restoring.anchor : undefined;
    // A second layout change can invalidate a regroup before its focus returns.
    // Reuse its original anchor, while leaving other navigation in charge.
    if (!mounting.current || retained) regroup.current ??= retained ?? reading.current;
  }, []);

  const capture = useCallback(() => {
    const element = root.current;
    if (!element) return;
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && element.contains(active) ? active : undefined;
    const owner = workspaceScrollOwner(workspace());
    const bounds =
      owner === document.scrollingElement
        ? { top: 0, bottom: innerHeight }
        : owner?.getBoundingClientRect();
    const visible = (item: HTMLElement) => {
      const rect = item.getBoundingClientRect();
      return rect.bottom > (bounds?.top ?? 0) && rect.top < (bounds?.bottom ?? innerHeight);
    };
    const focusedCard = focused?.closest<HTMLElement>("[data-detail-return-group]");
    const card =
      focusedCard && visible(focusedCard)
        ? focusedCard
        : [...element.querySelectorAll<HTMLElement>("[data-detail-return-group]")].find(visible);
    if (!card) {
      reading.current = undefined;
      return;
    }
    reading.current = {
      groupKey: card.dataset.detailReturnGroup!,
      top: card.getBoundingClientRect().top,
      focus:
        focusedCard && focused
          ? {
              groupKey: focusedCard.dataset.detailReturnGroup!,
              group: focused === focusedCard,
              originKey: focused.dataset.detailOrigin,
              controlKey: focused.dataset.collectionControl,
              control: focusableControls(focusedCard, { includeAriaDisabled: true }).indexOf(
                focused,
              ),
            }
          : undefined,
    };
  }, []);

  useLayoutEffect(() => {
    const element = root.current;
    const sizing = probe.current;
    if (!element || !sizing) return;
    mounted.current = true;
    const measure = () => {
      const epoch = ++measurementEpoch.current;
      measurementPending.current = true;
      publishLayoutPending();
      const owner = workspaceScrollOwner(workspace()) ?? document.documentElement;
      const style = getComputedStyle(sizing);
      const columns = layout === "rows" ? 1 : resolvedGridColumns(style.gridTemplateColumns);
      const rect = element.getBoundingClientRect();
      const ownerTop =
        owner === document.scrollingElement
          ? 0
          : owner.getBoundingClientRect().top + owner.clientTop;
      const next = {
        measurementEpoch: epoch,
        columns,
        font: style.fontSize,
        width: rect.width,
        owner,
        gap: layout === "rows" ? 0 : parseFloat(style.rowGap) || 0,
        margin: rect.top - ownerTop + owner.scrollTop,
      };
      element.dataset.collectionLayoutWidth = String(next.width);
      setGeometry((previous) => {
        if (
          previous.columns === next.columns &&
          previous.width === next.width &&
          previous.owner === next.owner &&
          Math.abs(previous.margin - next.margin) < 0.5 &&
          previous.gap === next.gap &&
          previous.font === next.font
        ) {
          if (measurementEpoch.current === epoch) measurementPending.current = false;
          publishLayoutPending();
          return previous;
        }
        if (
          previous.width &&
          (previous.columns !== next.columns ||
            previous.width !== next.width ||
            previous.owner !== next.owner ||
            previous.font !== next.font ||
            Math.abs(previous.margin - next.margin) >= 0.5)
        )
          retainRegroupAnchor();
        return next;
      });
    };
    const focus = () => {
      const active = document.activeElement;
      // A new owner can focus a search field or a dialog programmatically.
      // Yield restoration just as for pointer/keyboard intent, while allowing
      // focus lost to body during structural unmount to retain its anchor.
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        active !== document.documentElement &&
        !element.contains(active)
      )
        userIntent();
      const card =
        active instanceof HTMLElement && element.contains(active)
          ? active.closest<HTMLElement>("[data-detail-return-group]")
          : null;
      setFocusedPin(card?.dataset.detailReturnGroup);
      capture();
    };
    const userIntent = (event?: Event) => {
      if (event instanceof KeyboardEvent && event.repeat) return;
      intent.current++;
      latest.current.virtualizer.cancelScroll();
      regroup.current = undefined;
      restoringRegroup.current = undefined;
      publishLayoutPending();
    };
    const scroll = () => {
      // A responsive owner switch can emit a scroll before the measured rows
      // move to the new owner. Keep the anchor from the last committed layout.
      const owner = workspaceScrollOwner(workspace()) ?? document.documentElement;
      if (owner !== latest.current.geometry.owner) return;
      capture();
    };
    let measurementFrame = 0;
    const observer = new ResizeObserver(() => {
      measurementEpoch.current++;
      measurementPending.current = true;
      publishLayoutPending();
      if (measurementFrame) return;
      measurementFrame = requestAnimationFrame(() => {
        measurementFrame = 0;
        measure();
      });
    });
    observer.observe(element);
    if (sizing.firstElementChild) observer.observe(sizing.firstElementChild);
    const shell = workspace();
    const feedback = shell?.querySelector("[data-workspace-feedback]");
    const tools = shell?.querySelector(".library-query-tools");
    if (feedback) observer.observe(feedback);
    if (tools) observer.observe(tools);
    measure();
    document.addEventListener("focusin", focus, true);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", measure);
    for (const name of ["pointerdown", "keydown", "wheel", "touchstart"])
      document.addEventListener(name, userIntent, { capture: true, passive: true });
    return () => {
      mounted.current = false;
      measurementPending.current = false;
      userIntent();
      observer.disconnect();
      cancelAnimationFrame(measurementFrame);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", measure);
      for (const name of ["pointerdown", "keydown", "wheel", "touchstart"])
        document.removeEventListener(name, userIntent, true);
    };
  }, [layout, capture, retainRegroupAnchor, publishLayoutPending]);

  useLayoutEffect(() => {
    intent.current++;
    regroup.current = undefined;
    restoringRegroup.current = undefined;
    reading.current = undefined;
    publishLayoutPending();
    capture();
  }, [generation, queryKey, capture, publishLayoutPending]);

  // Retain size estimates within the same layout/column identity until each row
  // can be measured at its current geometry. Clearing offscreen measurements
  // would change the total height above another reading owner. Query/structural
  // changes clear historical keys, bounding the cache to the current row cohort.
  const measuredOwner = useRef({ structure, queryKey });
  useLayoutEffect(() => {
    virtualizer.cancelScroll();
    if (
      measuredOwner.current.structure !== structure ||
      measuredOwner.current.queryKey !== queryKey
    ) {
      measuredOwner.current = { structure, queryKey };
      virtualizer.measure();
    }
    for (const row of root.current?.querySelectorAll<HTMLDivElement>("[data-collection-row]") ?? [])
      virtualizer.measureElement(row);
  }, [
    virtualizer,
    geometry.width,
    geometry.owner,
    geometry.font,
    layout,
    i18n.language,
    generation,
    structure,
    queryKey,
  ]);

  const mount = useCallback(async (target: CollectionDestination, current: () => boolean) => {
    const element = root.current;
    if (!element) return false;
    const epoch = intent.current;
    const token = ++work.current;
    mounting.current = token;
    const requested = model.current;
    setDestinationPin(undefined);
    latest.current.virtualizer.cancelScroll();
    const eligible = () =>
      mounted.current &&
      token === work.current &&
      epoch === intent.current &&
      requested.generation === model.current.generation &&
      requested.queryKey === model.current.queryKey &&
      current();
    while (eligible() && !model.current.ready)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (!eligible()) {
      if (mounting.current === token) mounting.current = 0;
      return false;
    }
    const accepted = model.current;
    const valid = () => eligible() && accepted.structure === model.current.structure;
    const index = discoverDestinationIndex(accepted.groups, target);
    if (index < 0 && (target.originKey || target.portId || target.groupKey)) {
      if (target.scrollTop !== undefined) scrollWorkspaceTo(workspace(), target.scrollTop);
      if (mounting.current === token) mounting.current = 0;
      return valid();
    }
    if (index >= 0) accepted.onMountDestination?.(accepted.groups[index]!, target);
    const rowIndex = index < 0 ? undefined : Math.floor(index / latest.current.geometry.columns);
    setDestinationPin(index < 0 ? undefined : accepted.groups[index]!.id);
    // A retained viewport anchor already specifies the desired position. Pin and
    // measure it first; an intermediate index reveal can move a pointer target
    // between press and release during ordinary focus/layout feedback.
    if (rowIndex !== undefined) {
      if (target.viewportTop === undefined)
        latest.current.virtualizer.scrollToIndex(rowIndex, { align: "auto" });
    } else if (target.scrollTop !== undefined) scrollWorkspaceTo(workspace(), target.scrollTop);
    // Acknowledge only a connected, measured row. The route owner rechecks its token afterwards.
    try {
      while (valid()) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (!valid()) break;
        const row =
          rowIndex === undefined
            ? undefined
            : element.querySelector<HTMLDivElement>(`[data-collection-row="${rowIndex}"]`);
        if (rowIndex !== undefined && !row) continue;
        const measuredRows = new Set(
          element.querySelectorAll<HTMLDivElement>("[data-collection-row]"),
        );
        for (const mountedRow of measuredRows)
          latest.current.virtualizer.measureElement(mountedRow);
        latest.current.virtualizer.cancelScroll();
        // Measurement changes TanStack's model before React commits the matching
        // row position. Read the anchor only after that measured commit.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (!valid()) break;
        if (row && !row.isConnected) continue;
        let aligned: (() => boolean) | undefined;
        if (target.viewportTop !== undefined && row) {
          const card = [...row.querySelectorAll<HTMLElement>("[data-detail-return-group]")].find(
            (item) => item.dataset.detailReturnGroup === accepted.groups[index]?.id,
          );
          const anchor =
            (target.originKey
              ? [...(card?.querySelectorAll<HTMLElement>("[data-detail-origin]") ?? [])].find(
                  (item) => item.dataset.detailOrigin === target.originKey,
                )
              : undefined) ?? card;
          const owner = latest.current.geometry.owner;
          if (anchor && owner) {
            const viewportTop = target.viewportTop;
            const desired = owner.scrollTop + anchor.getBoundingClientRect().top - viewportTop;
            owner.scrollTo({ top: desired });
            aligned = () => {
              if (!anchor.isConnected || latest.current.geometry.owner !== owner) return false;
              const delta = anchor.getBoundingClientRect().top - viewportTop;
              const destination = owner.scrollTop + delta;
              const limit = Math.max(0, owner.scrollHeight - owner.clientHeight);
              return (
                Math.abs(delta) < 0.5 ||
                (destination < 0 && owner.scrollTop === 0) ||
                (destination > limit && Math.abs(owner.scrollTop - limit) < 0.5)
              );
            };
          }
        } else if (target.scrollTop !== undefined) scrollWorkspaceTo(workspace(), target.scrollTop);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (!valid()) break;
        // Scrolling can mount estimated neighbors above a reading card but
        // inside the viewport, where default edge anchoring will not compensate
        // their first measurements. Wait for the whole mounted window's actual
        // sizes and React positions before acknowledging the specific anchor.
        const { virtualizer, geometry } = latest.current;
        const items = new Map(virtualizer.getVirtualItems().map((item) => [item.index, item]));
        const measuredWindow = [
          ...element.querySelectorAll<HTMLDivElement>("[data-collection-row]"),
        ].every((mountedRow) => {
          const item = items.get(Number(mountedRow.dataset.collectionRow));
          return (
            measuredRows.has(mountedRow) &&
            item !== undefined &&
            item.size === mountedRow.offsetHeight &&
            Math.abs(parseFloat(mountedRow.style.top) - (item.start - geometry.margin)) < 0.5
          );
        });
        if (measuredWindow && (!row || row.isConnected) && (!aligned || aligned())) return true;
      }
      return false;
    } finally {
      if (mounting.current === token) mounting.current = 0;
      if (work.current === token) latest.current.virtualizer.cancelScroll();
      requestAnimationFrame(() => {
        if (mounted.current && work.current === token) setDestinationPin(undefined);
      });
    }
  }, []);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    return registerCollectionNavigation(element, {
      mount,
      capture: () => {
        capture();
        return reading.current
          ? { groupKey: reading.current.groupKey, viewportTop: reading.current.top }
          : undefined;
      },
      prepareMove(origin, direction, current) {
        if (direction === "left" || direction === "right") return;
        const card = origin.closest<HTMLElement>("[data-detail-return-group]");
        const index = model.current.groups.findIndex(
          ({ id }) => id === card?.dataset.detailReturnGroup,
        );
        if (index < 0) {
          const entry =
            direction === "down" ? model.current.groups[0] : model.current.groups.at(-1);
          if (
            !entry ||
            element.querySelector(`[data-detail-return-group="${CSS.escape(entry.id)}"]`)
          )
            return;
          return mount({ groupKey: entry.id }, current);
        }
        const row =
          Math.floor(index / latest.current.geometry.columns) + (direction === "down" ? 1 : -1);
        const next = model.current.rows[row]?.groups[0];
        if (!next || element.querySelector(`[data-collection-row="${row}"]`)) return;
        return mount({ groupKey: next.id }, current);
      },
    });
  }, [mount, capture]);

  // Accepted reordering can replace a complete row without changing its geometry.
  // Reuse the reading/focus anchor captured before that commit, scoped to the same
  // query and generation. The existing mount token yields to any newer intent.
  useLayoutEffect(() => {
    if (!ready) return;
    const before = lastAccepted.current;
    lastAccepted.current = { structure, queryKey, generation, layout };
    if (
      before.structure !== structure &&
      before.queryKey === queryKey &&
      before.generation === generation &&
      before.layout === layout
    )
      retainRegroupAnchor();
  }, [ready, structure, queryKey, generation, layout, retainRegroupAnchor]);

  useLayoutEffect(() => {
    if (geometry.measurementEpoch === measurementEpoch.current) measurementPending.current = false;
    const anchor = regroup.current;
    if (!anchor || !geometry.owner) {
      publishLayoutPending();
      capture();
      return;
    }
    regroup.current = undefined;
    const epoch = intent.current;
    const restoring = { anchor, token: work.current + 1 };
    restoringRegroup.current = restoring;
    publishLayoutPending();
    const current = () =>
      restoringRegroup.current === restoring &&
      epoch === intent.current &&
      latest.current.geometry === geometry &&
      (workspaceScrollOwner(workspace()) ?? document.documentElement) === geometry.owner;
    void mount({ groupKey: anchor.groupKey, viewportTop: anchor.top }, current)
      .then((accepted) => {
        if (!current() || work.current !== restoring.token) return;
        if (!accepted) return;
        const card = [
          ...(root.current?.querySelectorAll<HTMLElement>("[data-detail-return-group]") ?? []),
        ].find((item) => item.dataset.detailReturnGroup === anchor.groupKey);
        if (!card) return;
        const focusedCard = [
          ...(root.current?.querySelectorAll<HTMLElement>("[data-detail-return-group]") ?? []),
        ].find((item) => item.dataset.detailReturnGroup === anchor.focus?.groupKey);
        // Pending actions can retain DOM focus while refusing activation. Navigation
        // still excludes them; restoration must preserve that exact existing origin.
        const controls = focusedCard
          ? focusableControls(focusedCard, { includeAriaDisabled: true })
          : [];
        const control = anchor.focus?.group
          ? focusedCard
          : anchor.focus
            ? (controls.find((item, index) =>
                anchor.focus!.originKey
                  ? item.dataset.detailOrigin === anchor.focus!.originKey
                  : anchor.focus!.controlKey
                    ? item.dataset.collectionControl === anchor.focus!.controlKey
                    : index === anchor.focus!.control,
              ) ?? controls[0])
            : undefined;
        const owner = latest.current.geometry.owner;
        owner?.scrollTo({ top: owner.scrollTop + card.getBoundingClientRect().top - anchor.top });
        control?.focus({ preventScroll: true });
        capture();
      })
      .finally(() => {
        if (restoringRegroup.current !== restoring) return;
        restoringRegroup.current = undefined;
        publishLayoutPending();
      });
  }, [geometry, structure, ready, capture, mount, publishLayoutPending]);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        navigationScope() !== document
      )
        return;
      const origin = event.target instanceof HTMLElement ? event.target : null;
      if (fieldOwnsArrows(origin)) return;
      if (event.key === "Home" || event.key === "End") {
        if (!workspace()?.contains(origin)) return;
        const end = event.key === "End";
        const group = end ? groups.at(-1) : groups[0];
        if (!group) return;
        event.preventDefault();
        const epoch = intent.current;
        void mount({ groupKey: group.id }, () => epoch === intent.current).then((valid) => {
          if (valid) {
            if (end) latest.current.virtualizer.scrollToEnd();
            else scrollWorkspaceTo(workspace(), 0);
          }
        });
        return;
      }
      if (event.key !== "Tab" || !origin) return;
      const card = origin.closest<HTMLElement>("[data-detail-return-group]");
      const direction = event.shiftKey ? -1 : 1;
      if (
        event.repeat &&
        tabPending.current &&
        tabPending.current.origin === origin &&
        tabPending.current.direction === direction
      ) {
        event.preventDefault();
        return;
      }
      let destination: GameGroup | undefined;
      if (card && element.contains(card)) {
        const controls = focusableControls(card);
        if (origin !== (direction > 0 ? controls.at(-1) : controls[0])) return;
        const index = groups.findIndex(({ id }) => id === card.dataset.detailReturnGroup);
        destination = groups[index + direction];
        if (
          !destination ||
          element.querySelector(`[data-detail-return-group="${CSS.escape(destination.id)}"]`)
        )
          return;
      } else {
        const controls = focusableControls(document);
        const next = controls[controls.indexOf(origin) + direction];
        if (!next || !element.contains(next)) return;
        destination = direction > 0 ? groups[0] : groups.at(-1);
        if (
          !destination ||
          next.closest<HTMLElement>("[data-detail-return-group]")?.dataset.detailReturnGroup ===
            destination.id
        )
          return;
      }
      event.preventDefault();
      const epoch = intent.current;
      const move = { origin, direction };
      tabPending.current = move;
      void mount(
        { groupKey: destination.id },
        () => epoch === intent.current && document.activeElement === origin,
      )
        .then((valid) => {
          if (!valid) return;
          const target = element.querySelector<HTMLElement>(
            `[data-detail-return-group="${CSS.escape(destination.id)}"]`,
          );
          const controls = target ? focusableControls(target) : [];
          focusAndReveal(direction > 0 ? controls[0] : controls.at(-1));
        })
        .finally(() => {
          if (tabPending.current === move) tabPending.current = undefined;
        });
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [groups, rows.length, mount]);

  const items = virtualizer.getVirtualItems();
  const fallback =
    items.length === 0 && !geometry.owner
      ? rows.slice(0, 4).map((row, index) => ({ key: row.key, index, start: index * 560 }))
      : [];
  const Container = collection === "library" ? "div" : "section";
  return (
    <Container
      ref={root}
      aria-label={label}
      role={collection === "library" ? "list" : undefined}
      data-focus-group
      data-virtual-collection={collection}
      className={`port-grid ${collection === "catalog" ? `discover-grid discover-${layout}` : ""} collection-${layout} virtual-discover @container/collection w-full`}
      style={{
        height: hasAccepted.current ? virtualizer.getTotalSize() || fallback.length * 560 : 0,
      }}
    >
      <div
        ref={probe}
        className={`virtual-discover-probe ${collection === "catalog" ? "discover-grid" : ""} collection-${layout}`}
        aria-hidden="true"
      >
        <span className="virtual-discover-typography" />
      </div>
      {(hasAccepted.current ? (items.length ? items : fallback) : []).map((item) => (
        <div
          key={item.key}
          data-index={item.index}
          data-collection-row={item.index}
          ref={virtualizer.measureElement}
          className={`virtual-discover-row ${collection === "catalog" ? "discover-grid" : ""} collection-${layout}`}
          style={{ top: item.start - geometry.margin }}
        >
          {rows[item.index]!.groups.map((group, column) =>
            children(group, item.index * geometry.columns + column),
          )}
        </div>
      ))}
    </Container>
  );
}
