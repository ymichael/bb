export function withAlpha(color: string, alpha: number): string {
  const clamped = Math.min(1, Math.max(0, alpha));
  const hex = /^#([0-9a-f]{3,8})$/iu.exec(color.trim());
  if (hex) {
    const digits = hex[1] ?? "";
    let r: number;
    let g: number;
    let b: number;
    let a = 1;
    if (digits.length === 3 || digits.length === 4) {
      r = parseInt(digits[0]!.repeat(2), 16);
      g = parseInt(digits[1]!.repeat(2), 16);
      b = parseInt(digits[2]!.repeat(2), 16);
      if (digits.length === 4) a = parseInt(digits[3]!.repeat(2), 16) / 255;
    } else if (digits.length === 6 || digits.length === 8) {
      r = parseInt(digits.slice(0, 2), 16);
      g = parseInt(digits.slice(2, 4), 16);
      b = parseInt(digits.slice(4, 6), 16);
      if (digits.length === 8) a = parseInt(digits.slice(6, 8), 16) / 255;
    } else {
      return color;
    }
    return `rgba(${r}, ${g}, ${b}, ${round(a * clamped)})`;
  }
  const rgb =
    /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+)\s*)?\)$/iu.exec(
      color.trim(),
    );
  if (rgb) {
    const existing = rgb[4] === undefined ? 1 : Number(rgb[4]);
    return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${round(existing * clamped)})`;
  }
  return color;
}

export function blendOver(
  base: string,
  overlay: string,
  alpha: number,
): string {
  const under = parseRgb(base);
  const over = parseRgb(overlay);
  if (!under || !over) return base;
  const t = Math.min(1, Math.max(0, alpha)) * over.a;
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${mix(under.r, over.r)}, ${mix(under.g, over.g)}, ${mix(under.b, over.b)})`;
}

function parseRgb(
  color: string,
): { r: number; g: number; b: number; a: number } | null {
  const hex = /^#([0-9a-f]{3,8})$/iu.exec(color.trim());
  if (hex) {
    const digits = hex[1] ?? "";
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: parseInt(digits[0]!.repeat(2), 16),
        g: parseInt(digits[1]!.repeat(2), 16),
        b: parseInt(digits[2]!.repeat(2), 16),
        a: digits.length === 4 ? parseInt(digits[3]!.repeat(2), 16) / 255 : 1,
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: parseInt(digits.slice(0, 2), 16),
        g: parseInt(digits.slice(2, 4), 16),
        b: parseInt(digits.slice(4, 6), 16),
        a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }
  const rgb =
    /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+)\s*)?\)$/iu.exec(
      color.trim(),
    );
  if (!rgb) return null;
  return {
    r: Number(rgb[1]),
    g: Number(rgb[2]),
    b: Number(rgb[3]),
    a: rgb[4] === undefined ? 1 : Number(rgb[4]),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
