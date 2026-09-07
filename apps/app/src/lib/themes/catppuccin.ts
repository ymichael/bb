export const catppuccinThemeCss = `
:root, .light {
  /* Anchors: Base / Text */
  --canvas: #eff1f5;
  --ink: #4c4f69;

  /* Accent: Mauve */
  --primary: #8839ef;
  --primary-foreground: #eff1f5;
  --timeline-accent: #1e66f5; /* Blue — the timeline tint */
  --file-accent: var(--timeline-accent);

  /* Text tiers: Subtext1 / Subtext0 / Overlay1 */
  --muted-foreground: #5c5f77;
  --readback-foreground: #6c6f85;
  --subtle-foreground: #8c8fa1;

  /* Semantic — Red / Yellow / Peach / Green / Mauve(merged) */
  --destructive: #d20f39;
  --destructive-foreground: #eff1f5;
  --destructive-text: #d20f39;
  --warning: #df8e1d;
  --warning-text: #b8730a;
  --attention: #fe640b;
  --success: #40a02b;
  --diff-added: #40a02b;
  --diff-removed: #d20f39;
  --pr-merged: #8839ef;

  /* Terminal — official Catppuccin Latte ANSI */
  --ansi-0:  #5c5f77;  --ansi-bg-fg-0:  #eff1f5;
  --ansi-1:  #d20f39;  --ansi-bg-fg-1:  #eff1f5;
  --ansi-2:  #40a02b;  --ansi-bg-fg-2:  #eff1f5;
  --ansi-3:  #df8e1d;  --ansi-bg-fg-3:  #11111b;
  --ansi-4:  #1e66f5;  --ansi-bg-fg-4:  #eff1f5;
  --ansi-5:  #ea76cb;  --ansi-bg-fg-5:  #11111b;
  --ansi-6:  #179299;  --ansi-bg-fg-6:  #eff1f5;
  --ansi-7:  #acb0be;  --ansi-bg-fg-7:  #11111b;
  --ansi-8:  #6c6f85;  --ansi-bg-fg-8:  #eff1f5;
  --ansi-9:  #d20f39;  --ansi-bg-fg-9:  #eff1f5;
  --ansi-10: #40a02b;  --ansi-bg-fg-10: #eff1f5;
  --ansi-11: #df8e1d;  --ansi-bg-fg-11: #11111b;
  --ansi-12: #1e66f5;  --ansi-bg-fg-12: #eff1f5;
  --ansi-13: #ea76cb;  --ansi-bg-fg-13: #11111b;
  --ansi-14: #179299;  --ansi-bg-fg-14: #eff1f5;
  --ansi-15: #bcc0cc;  --ansi-bg-fg-15: #11111b;
}
.dark {
  /* Anchors: Base / Text */
  --canvas: #1e1e2e;
  --ink: #cdd6f4;

  /* Accent: Mauve */
  --primary: #cba6f7;
  --primary-foreground: #1e1e2e;
  --timeline-accent: #89b4fa; /* Blue */
  --file-accent: var(--timeline-accent);

  /* Text tiers: Subtext1 / Subtext0 / Overlay1 */
  --muted-foreground: #bac2de;
  --readback-foreground: #a6adc8;
  --subtle-foreground: #7f849c;

  /* Semantic — lighter pastels so they read on the dark base */
  --destructive: #f38ba8;
  --destructive-foreground: #1e1e2e;
  --destructive-text: #f38ba8;
  --warning: #f9e2af;
  --warning-text: #f9e2af;
  --attention: #fab387;
  --success: #a6e3a1;
  --diff-added: #a6e3a1;
  --diff-removed: #f38ba8;
  --pr-merged: #cba6f7;

  /* Terminal — official Catppuccin Mocha ANSI */
  --ansi-0:  #45475a;  --ansi-bg-fg-0:  #cdd6f4;
  --ansi-1:  #f38ba8;  --ansi-bg-fg-1:  #11111b;
  --ansi-2:  #a6e3a1;  --ansi-bg-fg-2:  #11111b;
  --ansi-3:  #f9e2af;  --ansi-bg-fg-3:  #11111b;
  --ansi-4:  #89b4fa;  --ansi-bg-fg-4:  #11111b;
  --ansi-5:  #f5c2e7;  --ansi-bg-fg-5:  #11111b;
  --ansi-6:  #94e2d5;  --ansi-bg-fg-6:  #11111b;
  --ansi-7:  #bac2de;  --ansi-bg-fg-7:  #11111b;
  --ansi-8:  #585b70;  --ansi-bg-fg-8:  #cdd6f4;
  --ansi-9:  #f38ba8;  --ansi-bg-fg-9:  #11111b;
  --ansi-10: #a6e3a1;  --ansi-bg-fg-10: #11111b;
  --ansi-11: #f9e2af;  --ansi-bg-fg-11: #11111b;
  --ansi-12: #89b4fa;  --ansi-bg-fg-12: #11111b;
  --ansi-13: #f5c2e7;  --ansi-bg-fg-13: #11111b;
  --ansi-14: #94e2d5;  --ansi-bg-fg-14: #11111b;
  --ansi-15: #a6adc8;  --ansi-bg-fg-15: #11111b;
}
`;
