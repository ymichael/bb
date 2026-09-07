import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "theme.css"),
  "utf8",
);
function modeBlock(scheme: "light" | "dark", source = css): string {
  const at = source.indexOf(`color-scheme: ${scheme};`);
  if (at === -1) throw new Error(`no ${scheme} block in theme.css`);
  return source.slice(source.lastIndexOf("{", at) + 1, source.indexOf("}", at));
}

function rampSteps(block: string): Map<string, number> {
  const re =
    /--([a-z-]+):\s*color-mix\(in okl(?:ch|ab), var\(--ink\) ([\d.]+)%, (?:var\(--canvas\)|transparent)\);/g;
  const steps = new Map<string, number>();
  for (const match of block.matchAll(re)) {
    steps.set(match[1], Number(match[2]));
  }
  return steps;
}

const REQUIRED_RAMP_TOKENS = [
  "secondary",
  "accent",
  "muted",
  "state-hover",
  "state-active",
  "border",
  "border-hairline",
  "border-seam",
  "input",
  "sidebar",
  "sidebar-accent",
  "sidebar-border",
] as const;

const MODES = ["light", "dark"] as const;

interface OklchColor {
  lightness: number;
  chroma: number;
  hueDegrees: number;
}

interface LinearRgb {
  blue: number;
  green: number;
  red: number;
}

function variableValue(block: string, token: string): string {
  const re = new RegExp(`--${token}:\\s*([^;]+);`);
  const match = block.match(re);
  const value = match?.[1];
  if (value === undefined) {
    throw new Error(`--${token} not defined`);
  }
  return value.trim();
}

function parseOklch(value: string): OklchColor {
  const match = value.match(/^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/);
  const lightness = match?.[1];
  const chroma = match?.[2];
  const hueDegrees = match?.[3];
  if (
    lightness === undefined ||
    chroma === undefined ||
    hueDegrees === undefined
  ) {
    throw new Error(`expected oklch() value, got ${value}`);
  }
  return {
    lightness: Number(lightness),
    chroma: Number(chroma),
    hueDegrees: Number(hueDegrees),
  };
}

function oklchToLinearRgb(color: OklchColor): LinearRgb {
  const hueRadians = (color.hueDegrees * Math.PI) / 180;
  const a = color.chroma * Math.cos(hueRadians);
  const b = color.chroma * Math.sin(hueRadians);

  const l = color.lightness + 0.3963377774 * a + 0.2158037573 * b;
  const m = color.lightness - 0.1055613458 * a - 0.0638541728 * b;
  const s = color.lightness - 0.0894841775 * a - 1.291485548 * b;

  const l3 = l * l * l;
  const m3 = m * m * m;
  const s3 = s * s * s;

  return {
    red: 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    green: -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    blue: -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  };
}

function relativeLuminance(color: OklchColor): number {
  const rgb = oklchToLinearRgb(color);
  return 0.2126 * rgb.red + 0.7152 * rgb.green + 0.0722 * rgb.blue;
}

function contrastRatio(foreground: OklchColor, background: OklchColor): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("theme.css neutral ramp", () => {
  it("backs selected sticky sidebar rows with an opaque sidebar layer", () => {
    const rule = css.match(
      /\[data-sidebar-sticky-tier\]\.bb-sidebar-selected-row\s*\{([^}]*)\}/s,
    )?.[1];

    expect(rule).toContain(
      "linear-gradient(var(--state-active), var(--state-active))",
    );
    expect(rule).toContain("linear-gradient(var(--sidebar), var(--sidebar))");
  });

  it("resolves the open-in-split thread tint to an opaque sidebar color", () => {
    const rule = css.match(
      /\.bb-sidebar-open-in-split-row\s*\{([^}]*)\}/s,
    )?.[1];

    expect(rule).toContain("color-mix(");
    expect(rule).toContain("in oklch");
    expect(rule).toContain("var(--sidebar-accent) 50%");
    expect(rule).toContain("var(--sidebar)");
    expect(rule).not.toContain("transparent");

    const stickyRule = css.match(
      /\[data-sidebar-sticky-tier\]\.bb-sidebar-open-in-split-row\s*\{([^}]*)\}/s,
    )?.[1];
    expect(stickyRule).toContain("background-image: linear-gradient(");
    expect(
      stickyRule?.match(/var\(--bb-sidebar-open-in-split-background\)/g),
    ).toHaveLength(2);

    const interactiveRule = css.match(
      /\[data-sidebar-sticky-tier\]\.bb-sidebar-open-in-split-row:is\([^{]+\)\s*\{([^}]*)\}/s,
    )?.[1];
    expect(interactiveRule).toContain("background-image: linear-gradient(");
    expect(interactiveRule?.match(/var\(--sidebar-accent\)/g)).toHaveLength(2);
  });

  for (const mode of MODES) {
    describe(mode, () => {
      const block = modeBlock(mode);
      const steps = rampSteps(block);
      const step = (token: string): number => {
        const value = steps.get(token);
        if (value === undefined) throw new Error(`--${token} not derived`);
        return value;
      };

      it("defines the canvas and ink anchors", () => {
        expect(block).toMatch(/--canvas:\s*oklch\(/);
        expect(block).toMatch(/--ink:\s*oklch\(/);
      });

      it("derives every neutral-ramp token from the anchors", () => {
        for (const token of REQUIRED_RAMP_TOKENS) {
          expect(
            steps.has(token),
            `--${token} must derive from var(--ink)/var(--canvas), not a literal`,
          ).toBe(true);
        }
      });

      it("uses one seam value for every app-shell boundary", () => {
        expect(block).toMatch(
          /--border-seam-vertical:\s*var\(--border-seam\);/,
        );
      });

      it("keeps card and popover flush with the background", () => {
        expect(steps.has("card")).toBe(false);
        expect(steps.has("popover")).toBe(false);
        expect(block).toMatch(/--card:\s*var\(--canvas\);/);
        expect(block).toMatch(/--popover:\s*var\(--canvas\);/);
      });

      it("orders fills below borders below input", () => {
        for (const fill of ["secondary", "accent", "muted", "state-hover"]) {
          expect(step(fill)).toBeLessThan(step("border"));
        }
        expect(step("border")).toBeLessThanOrEqual(step("input"));
      });

      it("makes the pressed/selected fill stronger than hover", () => {
        expect(step("state-active")).toBeGreaterThan(step("state-hover"));
        expect(step("sidebar-accent")).toBeGreaterThan(step("sidebar"));
      });

      it("keeps the sidebar a quiet chrome lift below the fills", () => {
        expect(step("sidebar")).toBeLessThan(step("secondary"));
      });
    });
  }

  it("defines the same ramp tokens in light and dark", () => {
    const light = [...rampSteps(modeBlock("light")).keys()].sort();
    const dark = [...rampSteps(modeBlock("dark")).keys()].sort();
    expect(light).toEqual(dark);
  });

  it("derives translucent (transparent-mixed) tokens in oklab, not oklch", () => {
    const offenders = [
      ...css.matchAll(/color-mix\(\s*in oklch\b[^;]*?\btransparent\b/g),
    ].map((match) => match[0].replace(/\s+/g, " "));
    expect(offenders).toEqual([]);
  });
});

describe("theme.css Cadence text tokens", () => {
  it("registers Cadence color and type utilities with Tailwind", () => {
    expect(css).toMatch(
      /--color-readback-foreground:\s*var\(--readback-foreground\);/,
    );
    expect(css).toMatch(/--color-timeline-accent:\s*var\(--timeline-accent\);/);
    expect(css).toMatch(
      /--color-destructive-text:\s*var\(--destructive-text\);/,
    );
    expect(css).toMatch(/--text-2xs:\s*0\.625rem;/);
    expect(css).toMatch(/--text-2xs--line-height:\s*0\.875rem;/);
  });

  for (const mode of MODES) {
    it(`keeps ${mode} Cadence text tokens above the AA text floor`, () => {
      const block = modeBlock(mode);
      const canvas = parseOklch(variableValue(block, "canvas"));
      const readbackForeground = parseOklch(
        variableValue(block, "readback-foreground"),
      );
      const timelineAccent = parseOklch(
        variableValue(block, "timeline-accent"),
      );
      const destructiveText = parseOklch(
        variableValue(block, "destructive-text"),
      );

      expect(contrastRatio(readbackForeground, canvas)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(timelineAccent, canvas)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(destructiveText, canvas)).toBeGreaterThanOrEqual(
        4.5,
      );
    });
  }
});

describe("theme.css semantic update surfaces", () => {
  it("registers the attention surface utility with Tailwind", () => {
    expect(css).toMatch(
      /--color-surface-attention:\s*var\(--surface-attention\);/,
    );
  });

  for (const mode of MODES) {
    it(`derives the ${mode} attention surface from the semantic color in a hue-safe space`, () => {
      expect(variableValue(modeBlock(mode), "surface-attention")).toMatch(
        /^color-mix\(in oklab, var\(--attention\) [\d.]+%, transparent\)$/,
      );
    });
  }
});

describe("theme.css desktop portal hit testing", () => {
  it("carves portaled overlays out of native window drag regions", () => {
    const rule = css.match(/\[data-bb-portaled-overlay\]\s*\{([^}]*)\}/)?.[1];

    expect(rule).toBeDefined();
    expect(rule).toMatch(/(?:^|\s)app-region:\s*no-drag;/);
    expect(rule).toMatch(/-webkit-app-region:\s*no-drag;/);
  });
});

describe("theme.css sidebar width registration", () => {
  it("registers --sidebar-width as a non-inherited length", () => {
    const rule = css.match(/@property --sidebar-width\s*\{([^}]*)\}/)?.[1];

    expect(rule).toBeDefined();
    expect(rule).toMatch(/syntax:\s*"<length>";/);
    expect(rule).toMatch(/inherits:\s*false;/);
    expect(rule).toMatch(/initial-value:\s*\d+px;/);
  });
});

describe("theme.css shimmer and scroll-anchor paint scope", () => {
  function ruleBody(selector: string, source = css): string {
    const at = source.indexOf(`${selector} {`);
    if (at === -1) throw new Error(`no ${selector} rule in theme.css`);
    return source.slice(at, source.indexOf("}", at));
  }

  it("promotes shimmering elements to their own layer only while active", () => {
    expect(ruleBody("  .animate-shine")).toMatch(/will-change:\s*transform;/);
    expect(ruleBody("  .animate-shine-icon")).toMatch(
      /will-change:\s*transform;/,
    );
  });

  it("pauses the sweep and releases the layer under inert or aria-hidden hosts", () => {
    const rule = css.match(
      /\[inert\] \.animate-shine,\s*\[inert\] \.animate-shine-icon,\s*\[aria-hidden="true"\] \.animate-shine,\s*\[aria-hidden="true"\] \.animate-shine-icon \{([^}]*)\}/,
    )?.[1];
    expect(rule).toBeDefined();
    expect(rule).toMatch(/animation-play-state:\s*paused;/);
    expect(rule).toMatch(/will-change:\s*auto;/);
  });

  it("excludes the bottom-anchored wrapper without a universal descendant rule", () => {
    expect(css).not.toMatch(/\.scroll-bottom-anchor-content\s*\*/);
    expect(ruleBody(".scroll-bottom-anchor-content")).toMatch(
      /overflow-anchor:\s*none;/,
    );
    expect(ruleBody(".scroll-bottom-anchor")).toMatch(
      /overflow-anchor:\s*auto;/,
    );
  });
});
