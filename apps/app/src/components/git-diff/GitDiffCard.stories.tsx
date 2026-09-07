import { useEffect, useMemo, useState } from "react";
import {
  builtInThemes,
  defaultAppTheme,
  type BuiltInThemeId,
} from "@bb/domain";
import { cn } from "@bb/shared-ui/lib/utils";
import { Button } from "@bb/shared-ui/button";
import { resolveAppThemeCss } from "@/lib/themes";
import { GitDiffCard } from "@/components/git-diff/GitDiffCard";
import type { DiffPresentation } from "@/components/code/code-rendering";
import { parseGitDiffFiles } from "@/components/git-diff/git-diff-parsing";

export default {
  title: "Git Diff / Themed Panel",
};

const SAMPLE_DIFF = `diff --git a/src/auth/session.ts b/src/auth/session.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -7,9 +7,11 @@ export function createSession(user: User): Session {
 export function createSession(user: User): Session {
   const token = signToken(user.id);
-  const expiresAt = Date.now() + ONE_HOUR;
+  const expiresAt = Date.now() + SESSION_TTL_MS;
+  const refreshToken = signRefreshToken(user.id);
   return {
     token,
+    refreshToken,
     userId: user.id,
     expiresAt,
   };
 }
diff --git a/src/auth/refresh.ts b/src/auth/refresh.ts
new file mode 100644
index 0000000..a1b2c3d
--- /dev/null
+++ b/src/auth/refresh.ts
@@ -0,0 +1,8 @@
+import { signToken } from "./token";
+
+const SESSION_TTL_MS = 60 * 60 * 1000;
+
+export function signRefreshToken(userId: string): string {
+  // Long-lived token used to mint new sessions.
+  return signToken(\`refresh:\${userId}\`);
+}
`;

const STORY_THEME_STYLE_ID = "story-git-diff-theme";

function usePaletteCss(themeId: BuiltInThemeId) {
  useEffect(() => {
    let el = document.getElementById(
      STORY_THEME_STYLE_ID,
    ) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement("style");
      el.id = STORY_THEME_STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = resolveAppThemeCss({
      ...defaultAppTheme,
      themeId,
    });
  }, [themeId]);
  useEffect(
    () => () => document.getElementById(STORY_THEME_STYLE_ID)?.remove(),
    [],
  );
}

const DIFF_PRESENTATION: DiffPresentation = {
  view: "unified",
  overflow: "scroll",
  showLineNumbers: true,
};

function DiffStack() {
  const files = useMemo(() => parseGitDiffFiles(SAMPLE_DIFF), []);
  return (
    <div className="flex flex-col gap-3">
      {files.map((file, index) => (
        <GitDiffCard
          key={`${file.name}-${index}`}
          fileDiff={file}
          presentation={DIFF_PRESENTATION}
        />
      ))}
    </div>
  );
}

function ModePane({ mode }: { mode: "light" | "dark" }) {
  return (
    <div
      className={cn(
        mode,
        "flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-background p-3",
      )}
    >
      <span className="text-[11px] font-medium text-muted-foreground">
        {mode}
      </span>
      <DiffStack />
    </div>
  );
}

export function ThemedDiffPanel() {
  const [themeId, setThemeId] = useState<BuiltInThemeId>("catppuccin");
  usePaletteCss(themeId);

  return (
    <div className="m-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Palette
        </span>
        {builtInThemes.map((theme) => (
          <Button
            key={theme.id}
            size="sm"
            variant={theme.id === themeId ? "default" : "outline"}
            onClick={() => setThemeId(theme.id)}
          >
            {theme.name}
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <ModePane mode="light" />
        <ModePane mode="dark" />
      </div>
    </div>
  );
}
