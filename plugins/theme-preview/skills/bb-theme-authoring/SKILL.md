---
name: bb-theme-authoring
description: "Create or edit BB color themes and inspect them in the Theme Preview panel."
---

# Authoring a bb theme

A bb theme is one CSS file that overrides the app's CSS custom properties. bb
discovers custom themes on disk and the **Theme Preview** panel shows every
resolved token, its validation state, and an app mock that repaints as you
edit. Work in a split: your agent thread on one side, Theme Preview on the
other. Nothing needs a restart.

Theme Preview is visualization and validation only. It never creates, writes,
forks, repairs, or deletes a theme resource. Create and update `theme.css` from
the separate agent thread; use the existing `bb theme` commands to locate,
inspect, and activate themes. Validation reports inconsistent or inaccessible
results, but it never changes authored values.

## Where themes live

```sh
bb theme dir          # the custom-theme directory, e.g. ~/.bb/theme
```

One directory per theme, one file inside it:

```
<theme dir>/<name>/theme.css
```

`<name>` is the theme id: lowercase, letters, digits and dashes, a single path
segment. Create the directory and the file and it is listed immediately — the
Theme Preview dropdown picks it up on its next catalog refresh while the panel
is open, and `bb theme list` shows it at once.

## File shape

Two top-level blocks. Light values in `:root, .light`, dark values in `.dark`.
Every declaration is a `--token: value;` custom property.

```css
:root, .light {
  --canvas: #f4f4f4;
  --ink: #0a0a0a;
  --primary: #2e6f95;
  --primary-foreground: #ffffff;
}

.dark {
  --canvas: #1a1a1a;
  --ink: #dbd8d1;
  --primary: #9db6c6;
  --primary-foreground: #0a0a0a;
}
```

You only need to declare what you change; everything else derives from bb's
base theme. The anchors that drive the most are `--canvas`, `--ink`,
`--primary` and `--sidebar`.

### Tokens worth knowing

| group | tokens |
| --- | --- |
| Surfaces | `--canvas` `--sidebar` `--card` `--popover` `--secondary` `--muted` `--surface-recessed-solid` `--surface-scrim` |
| Ink | `--ink` (body) `--foreground` `--muted-foreground` `--subtle-foreground` `--readback-foreground` `--sidebar-foreground` |
| Accent and state | `--primary` `--primary-foreground` `--file-accent` `--timeline-accent` `--surface-selected` `--state-hover` `--state-active` `--sidebar-accent` |
| Status | `--success` `--warning` `--warning-text` `--destructive` `--destructive-text` `--pr-merged` `--diff-added` `--diff-removed` |
| Lines | `--border` `--border-hairline` `--border-seam` `--sidebar-border` `--input` `--ring` |
| Type | `--font-sans` `--font-mono` (declare once in `:root`) |

How bb uses them (from bb's own components, so you can predict the result):
sidebar rows hover with `--sidebar-accent`, the open thread's row is
`--state-active`, the default button is `--foreground` on `--background`
(bb has no primary-filled button; `--primary` is links, focus and accents),
the composer sits on the canvas with a 1px `--border`, code blocks and message
bubbles are a faint recessed wash with `--border-seam`.

Element-scoped blocks are allowed — for example `.dark .fixed.bg-sidebar { … }`
to give only the sidebar a different value — but keep palette values in the
two top-level blocks so tooling can read them.

## Apply and iterate

```sh
bb theme set <name>   # activate it app-wide
bb theme show         # what is active now
```

Or activate it from the Theme Preview dropdown and use the adjacent mode
control to check light and dark. Once active, **every save of `theme.css`
repaints the app and the preview automatically** while the panel is open (the
plugin watches the active theme's file and re-applies it). Edit in the agent
thread, glance at the split, edit again.

## Verify before you call it done

In Theme Preview, read the Style sheet measurements:

- **Ink rows show a WCAG ratio** against the surface they sit on; the floor is
  4.5:1 for body text. The ratios are representative measurements, not a theme-level accessibility verdict.
- **Status rows** show their ratio against the tinted surface where they are
  painted.
- **Surfaces** with an amber outline are overridden inside the sidebar scope —
  make sure that is intentional.
- Check both modes with the dropdown, and the Split and Settings views, not
  just Thread.

Treat failures as authoring guidance. Fix them in `theme.css` from the agent
thread; Theme Preview does not block or automatically adjust the theme.

Keep dark-mode text below ~12:1 on near-black surfaces; higher blooms on OLED.

For manifest-contributed themes, read
[references/plugin-themes.md](references/plugin-themes.md).
