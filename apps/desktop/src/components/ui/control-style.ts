import { cn } from "cn";

// Preserve Base UI's state resolver as well as its render/ref/event composition.
export function controlClassName<State>(
  base: string,
  className: string | ((state: State) => string | undefined) | undefined,
) {
  return typeof className === "function"
    ? (state: State) => cn(base, className(state))
    : cn(base, className);
}

export const controlFocus =
  "outline-none focus-visible:outline-solid focus-visible:outline-3 focus-visible:outline-pc-ring focus-visible:outline-offset-3 controller-focus:outline-solid controller-focus:outline-3 controller-focus:outline-pc-ring controller-focus:outline-offset-3 forced-colors:focus-visible:outline-[Highlight] forced-colors:controller-focus:outline-[Highlight]";

export const controlMotion =
  "duration-(--duration-normal) ease-(--ease-standard) motion-reduce:transition-none";

export const floatingMotion =
  "transition-[opacity,scale] duration-(--duration-slow) ease-(--ease-standard) data-starting-style:opacity-0 data-starting-style:scale-95 data-ending-style:opacity-0 data-ending-style:scale-95 motion-reduce:transition-none";
