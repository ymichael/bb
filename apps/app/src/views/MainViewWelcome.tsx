import { Button } from "@/components/ui/button.js";
import { PageShell } from "@/components/ui/page-shell.js";

export interface MainViewWelcomeProps {
  isCreating: boolean;
  onCreate: () => void;
}

export function MainViewWelcome({
  isCreating,
  onCreate,
}: MainViewWelcomeProps) {
  return (
    <PageShell
      maxWidthClassName="max-w-3xl"
      contentClassName="min-h-full py-10"
    >
      <div className="flex flex-1 items-center justify-center">
        <div className="flex w-full max-w-md flex-col items-center gap-6 text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            Welcome
          </h2>
          <p className="text-base text-foreground">
            bb is a workspace for coding agents.
          </p>
          <ul className="list-inside list-disc space-y-1.5 text-left text-sm text-muted-foreground marker:text-muted-foreground/50">
            <li>Your agents can use bb too.</li>
            <li>
              Teach a manager how you work — then delegate the repetitive
              parts.
            </li>
            <li>Pass work back and forth with a manager.</li>
          </ul>
          <Button
            onClick={onCreate}
            disabled={isCreating}
            size="lg"
            className="mt-4"
          >
            {isCreating ? "Creating..." : "Create your first project"}
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
