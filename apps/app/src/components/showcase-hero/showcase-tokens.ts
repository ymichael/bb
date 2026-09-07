export function accentTint(token: string, percent: number): string {
  return `color-mix(in oklab, var(${token}) ${percent}%, var(--canvas))`;
}

export function accentInk(token: string, percent: number): string {
  return `color-mix(in oklab, var(${token}) ${percent}%, var(--ink))`;
}

export function neutral(percent: number): string {
  return `color-mix(in oklch, var(--ink) ${percent}%, var(--canvas))`;
}
