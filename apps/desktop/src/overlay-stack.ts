export type OverlayBackAction = "close-palette" | "close-adoption" | "close-detail" | undefined;

export function overlayBackAction(state: {
  paletteOpen: boolean;
  adoptionOpen: boolean;
  detailOpen: boolean;
}): OverlayBackAction {
  if (state.paletteOpen) return "close-palette";
  if (state.adoptionOpen) return "close-adoption";
  if (state.detailOpen) return "close-detail";
  return undefined;
}
