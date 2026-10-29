/** Decoded foreground presentation only; never changes source pixels or durable artwork choices. */
export interface HeroLogoSurface {
  plate: boolean;
  backing: string;
  tone: "opaque" | "dark" | "light" | "mixed";
}
const SAMPLE_SIZE = 24;
function luminance(r: number, g: number, b: number) {
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return linear(r) * 0.2126 + linear(g) * 0.7152 + linear(b) * 0.0722;
}
function sampleSurface(pixels: Uint8ClampedArray) {
  let opaque = true,
    red = 0,
    green = 0,
    blue = 0,
    edges = 0;
  let alpha = 0,
    light = 0,
    firstY = SAMPLE_SIZE,
    lastY = -1;
  for (let index = 0; index < pixels.length; index += 4) {
    const x = (index / 4) % SAMPLE_SIZE,
      y = Math.floor(index / 4 / SAMPLE_SIZE);
    const weight = pixels[index + 3]! / 255;
    if (pixels[index + 3]! < 245) opaque = false;
    if (x === 0 || y === 0 || x === SAMPLE_SIZE - 1 || y === SAMPLE_SIZE - 1) {
      red += pixels[index]!;
      green += pixels[index + 1]!;
      blue += pixels[index + 2]!;
      edges++;
    }
    if (weight < 0.2) continue;
    alpha += weight;
    light += luminance(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!) * weight;
    firstY = Math.min(firstY, y);
    lastY = Math.max(lastY, y);
  }
  return {
    opaque,
    alpha,
    light: light / alpha,
    glyphHeight: (lastY - firstY + 1) / SAMPLE_SIZE,
    backing: `rgb(${Math.round(red / edges)} ${Math.round(green / edges)} ${Math.round(blue / edges)})`,
  };
}
export function inspectHeroLogo(element: HTMLImageElement): HeroLogoSurface | undefined {
  if (!element.naturalWidth || !element.naturalHeight) return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SAMPLE_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return undefined;
  let pixels: Uint8ClampedArray;
  try {
    context.drawImage(element, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    pixels = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
  } catch {
    return undefined;
  }
  const surface = sampleSurface(pixels);
  const bounds = element.getBoundingClientRect(),
    computed = getComputedStyle(element);
  const height =
    bounds.height - parseFloat(computed.paddingTop) - parseFloat(computed.paddingBottom);
  const width = bounds.width - parseFloat(computed.paddingLeft) - parseFloat(computed.paddingRight);
  if (!surface.alpha || height * surface.glyphHeight < 18 || width < 36) return undefined;
  return {
    plate: surface.opaque,
    backing: surface.backing,
    tone: surface.opaque
      ? "opaque"
      : surface.light < 0.2
        ? "dark"
        : surface.light > 0.28
          ? "light"
          : "mixed",
  };
}

/** Key art must remain an illustration at its actual contained size, rather than a sliver or tiny cache result. */
export function isHeroKeyArtSuitable(element: HTMLImageElement): boolean {
  const naturalShort = Math.min(element.naturalWidth, element.naturalHeight);
  const naturalLong = Math.max(element.naturalWidth, element.naturalHeight);
  const bounds = element.getBoundingClientRect();
  return (
    naturalShort >= 64 &&
    naturalLong >= 96 &&
    Math.min(bounds.width, bounds.height) >= 32 &&
    Math.max(bounds.width, bounds.height) >= 64
  );
}
