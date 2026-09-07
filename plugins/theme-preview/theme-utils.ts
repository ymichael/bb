type Rgba = readonly [number, number, number, number];

function parseChannel(value: string): number {
  const trimmed = value.trim();
  return trimmed.endsWith("%") ? Number.parseFloat(trimmed) * 2.55 : Number.parseFloat(trimmed);
}

function parseAlpha(value: string | undefined): number {
  if (value === undefined) return 1;
  const trimmed = value.trim();
  return trimmed.endsWith("%") ? Number.parseFloat(trimmed) / 100 : Number.parseFloat(trimmed);
}

function parseRgb(value: string): Rgba | null {
  const match = /rgba?\(([^)]+)\)/.exec(value);
  if (!match) return null;
  const body = match[1].replace(/\s*\/\s*/g, ",");
  const parts = body.includes(",") ? body.split(",") : body.trim().split(/\s+/);
  if (parts.length < 3 || parts.length > 4) return null;
  const channels: Rgba = [parseChannel(parts[0]), parseChannel(parts[1]), parseChannel(parts[2]), parseAlpha(parts[3])];
  return channels.every(Number.isFinite) ? channels : null;
}

function composite(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground[3] + background[3] * (1 - foreground[3]);
  if (alpha === 0) return [0, 0, 0, 0];
  return [
    (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
    alpha,
  ];
}

function luminance(color: Rgba): number {
  const linear = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color[0]) + 0.7152 * linear(color[1]) + 0.0722 * linear(color[2]);
}

/** WCAG contrast after alpha is painted over the surface users actually see. */
export function contrastRatio(foregroundValue: string, backgroundValue: string, backdropValue = "rgb(255, 255, 255)"): number | null {
  const foreground = parseRgb(foregroundValue);
  const background = parseRgb(backgroundValue);
  const backdrop = parseRgb(backdropValue);
  if (!foreground || !background || !backdrop) return null;
  const opaqueBackdrop = backdrop[3] < 1 ? composite(backdrop, [255, 255, 255, 1]) : backdrop;
  const paintedBackground = composite(background, opaqueBackdrop);
  const paintedForeground = composite(foreground, paintedBackground);
  const foregroundLuminance = luminance(paintedForeground);
  const backgroundLuminance = luminance(paintedBackground);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

/** Monotonic gate for RPC calls whose responses may arrive out of order. */
export class LatestRequest {
  #generation = 0;

  begin(): number {
    this.#generation += 1;
    return this.#generation;
  }

  isLatest(generation: number): boolean {
    return generation === this.#generation;
  }
}
