import { Separator } from "./separator";

export default {
  title: "Primitives/Separator",
};

export function Orientations() {
  return (
    <div className="grid max-w-2xl gap-8 p-6">
      <div className="space-y-3">
        <p className="text-sm font-medium">Horizontal</p>
        <div className="rounded-md border border-border p-4">
          <p className="text-sm">Project settings</p>
          <Separator className="my-4" />
          <p className="text-sm text-muted-foreground">Agent defaults</p>
        </div>
      </div>
      <div className="space-y-3">
        <p className="text-sm font-medium">Vertical</p>
        <div className="flex h-20 items-center rounded-md border border-border p-4 text-sm">
          <span>Ready</span>
          <Separator orientation="vertical" className="mx-4" />
          <span className="text-muted-foreground">2 threads</span>
        </div>
      </div>
    </div>
  );
}

export function DecorativeAndSemantic() {
  return (
    <div className="grid max-w-lg gap-4 p-6">
      <Separator />
      <Separator decorative={false} aria-label="Section break" />
      <Separator className="bg-destructive/50" />
    </div>
  );
}
