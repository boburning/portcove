import { useId, useLayoutEffect, useRef, useState } from "react";
import { backgroundObjectPosition } from "../hero-media";
import type { ArtworkFraming } from "../types";
import { Button } from "./ui/button";
import styles from "./Artwork.module.css";

const defaultPoint = { x: 5000, y: 3500 };
const frames = [
  ["wide", "Wide preview"],
  ["narrow", "Narrow preview"],
] as const;
const axes = [
  ["x", "Horizontal"],
  ["y", "Vertical"],
] as const;

export function BackgroundFramingEditor({
  image,
  sourceLabel,
  initialFraming,
  pending,
  stale,
  onApply,
  onCancel,
}: {
  image: string;
  sourceLabel?: string | undefined;
  initialFraming: ArtworkFraming | null;
  pending: boolean;
  stale: boolean;
  onApply: (framing: ArtworkFraming | null) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [framing, setFraming] = useState(initialFraming);
  const [imageFailed, setImageFailed] = useState(false);
  useLayoutEffect(() => {
    if (!heading.current?.closest("[inert], [hidden]")) heading.current?.focus();
  }, []);
  return (
    <form
      className={styles.framingEditor}
      aria-labelledby={`${id}-heading`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending && !stale && !imageFailed) onApply(framing);
      }}
    >
      <h3 id={`${id}-heading`} ref={heading} tabIndex={-1}>
        Review Background
      </h3>
      {sourceLabel && <p>{sourceLabel}</p>}
      <div className={styles.framingPreviews}>
        {frames.map(([layout, label]) => {
          const point = framing?.[layout] ?? defaultPoint;
          return (
            <fieldset
              key={layout}
              className={styles.framingPreview}
              disabled={pending || stale || imageFailed}
            >
              <legend>{label}</legend>
              {!imageFailed && (
                <div className={styles.framingImage} data-layout={layout}>
                  <img
                    src={image}
                    alt=""
                    style={{ objectPosition: backgroundObjectPosition(point) }}
                    onError={() => setImageFailed(true)}
                  />
                </div>
              )}
              {axes.map(([axis, axisLabel]) => (
                <div key={axis} className={styles.framingAxis}>
                  <label htmlFor={`${id}-${layout}-${axis}`}>{axisLabel}</label>
                  <input
                    id={`${id}-${layout}-${axis}`}
                    name={`${layout}-${axis}`}
                    type="range"
                    min={0}
                    max={10000}
                    step={100}
                    value={point[axis]}
                    aria-valuetext={`${point[axis] / 100}%`}
                    onChange={(event) => {
                      const value = event.currentTarget.valueAsNumber;
                      setFraming((current) => ({
                        version: "v1",
                        wide: current?.wide ?? defaultPoint,
                        narrow: current?.narrow ?? defaultPoint,
                        [layout]: { ...(current?.[layout] ?? defaultPoint), [axis]: value },
                      }));
                    }}
                  />
                </div>
              ))}
            </fieldset>
          );
        })}
      </div>
      {stale && <p role="alert">The artwork changed. Cancel and preview the image again.</p>}
      {imageFailed && (
        <p role="alert">The preview could not be displayed. Cancel and choose the image again.</p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending || stale || imageFailed}>
          Apply
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        {framing && (
          <Button
            type="button"
            variant="ghost"
            disabled={pending || stale || imageFailed}
            onClick={() => setFraming(null)}
          >
            Use default framing
          </Button>
        )}
      </div>
    </form>
  );
}
