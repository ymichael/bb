import { EventCodeBlock } from "./event-content";

export default {
  title: "Primitives/EventCodeBlock",
};

export function Tones() {
  return (
    <div className="grid max-w-3xl gap-4 p-6">
      <EventCodeBlock>{`pnpm exec turbo run typecheck --filter=@bb/app

Tasks: 13 successful, 13 total`}</EventCodeBlock>
      <EventCodeBlock tone="danger">{`Error: failed to parse manifest
  at loadFixtureBundle (load.ts:42)`}</EventCodeBlock>
    </div>
  );
}

export function LongContent() {
  return (
    <div className="max-w-xl p-6">
      <EventCodeBlock>{`diff --git a/apps/app/src/components/ui/event-content.tsx b/apps/app/src/components/ui/event-content.tsx
index 1234567..89abcde 100644
--- a/apps/app/src/components/ui/event-content.tsx
+++ b/apps/app/src/components/ui/event-content.tsx
@@ -1,4 +1,4 @@
-const tone = "default";
+const tone = "danger";`}</EventCodeBlock>
    </div>
  );
}
