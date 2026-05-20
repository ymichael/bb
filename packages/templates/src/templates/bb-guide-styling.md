---
kind: instruction
title: bb Guide - Styling
summary: Styling reference for manager status surfaces rendered inside bb.
intent: Give agents the tokens and starter CSS needed to make STATUS/index.html or STATUS.html match the bb UI.
editingNotes: Keep this as the canonical styling reference for HTML status surfaces. Manager prompts should point here instead of inlining tokens.
---
Status styling

`STATUS/index.html` and `STATUS.html` render in an unsandboxed iframe in the bb
secondary panel. External resources such as Google Fonts, Tailwind CDN, remote
images, and stylesheets load normally. For local assets, use the folder form:
put `index.html` plus any local images, CSS, JS, or fonts inside `STATUS/`, then
reference them with relative URLs like `style.css`, `app.js`, or `logo.png`.
The dashboard auto-refreshes when resolved STATUS content changes.

Unless the user asks for a different visual direction, make the HTML status
surface look like bb: dense, minimal, and built from the same tokens. Use
Tailwind for layout, spacing, grids, flex rows, responsive behavior, and small
utility styling, then use the bb CSS variables below for colors, fonts, borders,
radius, and shadows.

Load Tailwind and bb's app fonts with:

```html
<script src="https://cdn.tailwindcss.com"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet">
```

bb's app dark mode is class-based on the parent app root. The iframe does not
inherit that `.dark` class, so an HTML status document that wants light and dark
rendering should use `@media (prefers-color-scheme: dark)` as the closest
available signal for the user's OS theme.

Paste this starter block into `STATUS/index.html` or `STATUS.html` so the page
uses bb's actual design tokens:

```html
<style>
:root {
  color-scheme: light;
  --background: oklch(0.9551 0 0);
  --foreground: oklch(0.3211 0 0);
  --card: oklch(0.9702 0 0);
  --card-foreground: oklch(0.3211 0 0);
  --popover: oklch(0.9702 0 0);
  --popover-foreground: oklch(0.3211 0 0);
  --primary: oklch(0.4891 0 0);
  --primary-foreground: oklch(1 0 0);
  --secondary: oklch(0.9067 0 0);
  --secondary-foreground: oklch(0.3211 0 0);
  --muted: oklch(0.8853 0 0);
  --muted-foreground: oklch(0.5103 0 0);
  --accent: oklch(0.9 0 0);
  --accent-foreground: oklch(0.3211 0 0);
  --state-hover: oklch(0.92 0 0);
  --state-active: oklch(0.88 0 0);
  --destructive: oklch(0.5594 0.19 25.8625);
  --destructive-foreground: oklch(1 0 0);
  --attention: oklch(0.74 0.15 80);
  --attention-foreground: oklch(0.3211 0 0);
  --warning: oklch(0.7 0.16 50);
  --warning-foreground: oklch(0.3211 0 0);
  --success: oklch(0.7 0.15 155);
  --success-foreground: oklch(0.3211 0 0);
  --diff-added: oklch(0.5 0.13 163);
  --diff-removed: oklch(0.5 0.17 28);
  --border: oklch(0.8576 0 0);
  --input: oklch(0.9067 0 0);
  --ring: oklch(0.4891 0 0);
  --chart-1: oklch(0.4891 0 0);
  --chart-2: oklch(0.4863 0.0361 196.0278);
  --chart-3: oklch(0.6534 0 0);
  --chart-4: oklch(0.7316 0 0);
  --chart-5: oklch(0.8078 0 0);
  --sidebar: oklch(0.937 0 0);
  --sidebar-foreground: oklch(0.3211 0 0);
  --sidebar-primary: oklch(0.4891 0 0);
  --sidebar-primary-foreground: oklch(1 0 0);
  --sidebar-accent: oklch(0.8078 0 0);
  --sidebar-accent-foreground: oklch(0.3211 0 0);
  --sidebar-border: oklch(0.8576 0 0);
  --sidebar-ring: oklch(0.4891 0 0);
  --font-sans: "Inter Variable", Inter, sans-serif;
  --font-serif: Georgia, serif;
  --font-mono: "Fira Code", monospace;
  --radius: 0.35rem;
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --bb-sidebar-row-height: 1.75rem;
  --bb-sidebar-row-height-coarse: 2.5rem;
  --shadow-x: 0px;
  --shadow-y: 2px;
  --shadow-blur: 0px;
  --shadow-spread: 0px;
  --shadow-opacity: 0.15;
  --shadow-color: hsl(0 0% 20% / 0.1);
  --shadow-2xs: 0px 2px 0px 0px hsl(0 0% 20% / 0.07);
  --shadow-xs: 0px 2px 0px 0px hsl(0 0% 20% / 0.07);
  --shadow-sm:
    0px 2px 0px 0px hsl(0 0% 20% / 0.15), 0px 1px 2px -1px hsl(0 0% 20% / 0.15);
  --shadow:
    0px 2px 0px 0px hsl(0 0% 20% / 0.15), 0px 1px 2px -1px hsl(0 0% 20% / 0.15);
  --shadow-md:
    0px 2px 0px 0px hsl(0 0% 20% / 0.15), 0px 2px 4px -1px hsl(0 0% 20% / 0.15);
  --shadow-lg:
    0px 2px 0px 0px hsl(0 0% 20% / 0.15), 0px 4px 6px -1px hsl(0 0% 20% / 0.15);
  --shadow-xl:
    0px 2px 0px 0px hsl(0 0% 20% / 0.15), 0px 8px 10px -1px hsl(0 0% 20% / 0.15);
  --shadow-2xl: 0px 2px 0px 0px hsl(0 0% 20% / 0.38);
  --tracking-normal: 0em;
  --spacing: 0.25rem;
  --icon-stroke-width: 1.75;
  --text-sm: 0.8125rem;
  --text-base: 0.9375rem;
  --text-base--line-height: 1.375rem;
  --ansi-0: #000000;
  --ansi-1: #a11616;
  --ansi-2: #13704a;
  --ansi-3: #7f6a00;
  --ansi-4: #1f5ca6;
  --ansi-5: #8a2f8a;
  --ansi-6: #0b6f88;
  --ansi-7: #3d3d3d;
  --ansi-8: #3a3a3a;
  --ansi-9: #d32f2f;
  --ansi-10: #197c52;
  --ansi-11: #a35f00;
  --ansi-12: #2666b0;
  --ansi-13: #9b349b;
  --ansi-14: #0f7798;
  --ansi-15: #1f1f1f;
  --ansi-bg-fg-0: #ffffff;
  --ansi-bg-fg-1: #ffffff;
  --ansi-bg-fg-2: #ffffff;
  --ansi-bg-fg-3: #ffffff;
  --ansi-bg-fg-4: #ffffff;
  --ansi-bg-fg-5: #ffffff;
  --ansi-bg-fg-6: #ffffff;
  --ansi-bg-fg-7: #ffffff;
  --ansi-bg-fg-8: #ffffff;
  --ansi-bg-fg-9: #ffffff;
  --ansi-bg-fg-10: #ffffff;
  --ansi-bg-fg-11: #ffffff;
  --ansi-bg-fg-12: #ffffff;
  --ansi-bg-fg-13: #ffffff;
  --ansi-bg-fg-14: #ffffff;
  --ansi-bg-fg-15: #ffffff;
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --background: oklch(0.195 0 0);
    --foreground: oklch(0.8853 0 0);
    --card: oklch(0.2435 0 0);
    --card-foreground: oklch(0.8853 0 0);
    --popover: oklch(0.2435 0 0);
    --popover-foreground: oklch(0.8853 0 0);
    --primary: oklch(0.7058 0 0);
    --primary-foreground: oklch(0.2178 0 0);
    --secondary: oklch(0.3092 0 0);
    --secondary-foreground: oklch(0.8853 0 0);
    --muted: oklch(0.285 0 0);
    --muted-foreground: oklch(0.66 0 0);
    --accent: oklch(0.285 0 0);
    --accent-foreground: oklch(0.8853 0 0);
    --state-hover: oklch(0.255 0 0);
    --state-active: oklch(0.305 0 0);
    --destructive: oklch(0.56 0.19 22.1703);
    --destructive-foreground: oklch(1 0 0);
    --attention: oklch(0.8 0.15 80);
    --attention-foreground: oklch(0.2178 0 0);
    --warning: oklch(0.75 0.16 50);
    --warning-foreground: oklch(0.2178 0 0);
    --success: oklch(0.74 0.15 155);
    --success-foreground: oklch(0.2178 0 0);
    --diff-added: oklch(0.77 0.17 163);
    --diff-removed: oklch(0.72 0.19 22);
    --border: oklch(0.329 0 0);
    --input: oklch(0.3092 0 0);
    --ring: oklch(0.7058 0 0);
    --chart-1: oklch(0.7058 0 0);
    --chart-2: oklch(0.6714 0.0339 206.3482);
    --chart-3: oklch(0.5452 0 0);
    --chart-4: oklch(0.4604 0 0);
    --chart-5: oklch(0.3715 0 0);
    --sidebar: oklch(0.24 0 0);
    --sidebar-foreground: oklch(0.8853 0 0);
    --sidebar-primary: oklch(0.7058 0 0);
    --sidebar-primary-foreground: oklch(0.2178 0 0);
    --sidebar-accent: oklch(0.32 0 0);
    --sidebar-accent-foreground: oklch(0.8853 0 0);
    --sidebar-border: oklch(0.32 0 0);
    --sidebar-ring: oklch(0.7058 0 0);
    --font-sans: "Inter Variable", Inter, sans-serif;
    --font-serif: Georgia, serif;
    --font-mono: "Fira Code", monospace;
    --radius: 0.35rem;
    --shadow-x: 0px;
    --shadow-y: 2px;
    --shadow-blur: 0px;
    --shadow-spread: 0px;
    --shadow-opacity: 0.15;
    --shadow-color: hsl(0 0% 20% / 0.1);
    --shadow-2xs: 0px 2px 0px 0px hsl(0 0% 20% / 0.07);
    --shadow-xs: 0px 2px 0px 0px hsl(0 0% 20% / 0.07);
    --shadow-sm:
      0px 2px 0px 0px hsl(0 0% 20% / 0.15), 0px 1px 2px -1px hsl(0 0% 20% / 0.15);
    --shadow:
      0px 2px 0px 0px hsl(0 0% 20% / 0.15), 0px 1px 2px -1px hsl(0 0% 20% / 0.15);
    --shadow-md:
      0px 2px 0px 0px hsl(0 0% 20% / 0.15), 0px 2px 4px -1px hsl(0 0% 20% / 0.15);
    --shadow-lg:
      0px 2px 0px 0px hsl(0 0% 20% / 0.15), 0px 4px 6px -1px hsl(0 0% 20% / 0.15);
    --shadow-xl:
      0px 2px 0px 0px hsl(0 0% 20% / 0.15), 0px 8px 10px -1px hsl(0 0% 20% / 0.15);
    --shadow-2xl: 0px 2px 0px 0px hsl(0 0% 20% / 0.38);
    --ansi-0: #858585;
    --ansi-1: #d85e5e;
    --ansi-2: #0dbc79;
    --ansi-3: #e5e510;
    --ansi-4: #3c88dc;
    --ansi-5: #c85ac8;
    --ansi-6: #11a8cd;
    --ansi-7: #e5e5e5;
    --ansi-8: #9a9a9a;
    --ansi-9: #ff6f6f;
    --ansi-10: #23d18b;
    --ansi-11: #f5f543;
    --ansi-12: #5aaaf2;
    --ansi-13: #d670d6;
    --ansi-14: #29b8db;
    --ansi-15: #ffffff;
    --ansi-bg-fg-0: #000000;
    --ansi-bg-fg-1: #000000;
    --ansi-bg-fg-2: #000000;
    --ansi-bg-fg-3: #000000;
    --ansi-bg-fg-4: #000000;
    --ansi-bg-fg-5: #000000;
    --ansi-bg-fg-6: #000000;
    --ansi-bg-fg-7: #000000;
    --ansi-bg-fg-8: #000000;
    --ansi-bg-fg-9: #000000;
    --ansi-bg-fg-10: #000000;
    --ansi-bg-fg-11: #000000;
    --ansi-bg-fg-12: #000000;
    --ansi-bg-fg-13: #000000;
    --ansi-bg-fg-14: #000000;
    --ansi-bg-fg-15: #000000;
  }
}

html,
body {
  margin: 0;
  min-height: 100%;
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
  font-size: var(--text-base);
  line-height: var(--text-base--line-height);
}

body {
  padding: 1rem;
}

.card {
  background: var(--card);
  color: var(--card-foreground);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
}
</style>
```

Keep the design dense and minimal so it feels native to bb: small text,
hairline borders, subtle shadows, and semantic color only for status pills such
as success, attention, or destructive. Use the same shapes as the app: cards on
`--card`, `1px` borders using `--border`, and `--radius` with `--shadow-sm`.
