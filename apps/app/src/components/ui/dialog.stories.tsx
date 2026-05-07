import { AlertTriangle, Archive, Settings } from "lucide-react";
import { Button } from "./button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog";
import { Input } from "./input";

export default {
  title: "Primitives/Dialog",
};

export function OpenForm() {
  return (
    <div className="min-h-[24rem] p-6">
      <Dialog open={true}>
        <DialogTrigger asChild>
          <Button variant="outline">
            <Settings />
            Project settings
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Project settings</DialogTitle>
            <DialogDescription>
              Configure the default workspace and branch for new threads.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <label className="grid gap-1.5 text-sm font-medium">
              Workspace path
              <Input defaultValue="/Users/michael/src/bb" />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Default branch
              <Input defaultValue="main" />
            </label>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button>Save changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function DestructiveConfirmation() {
  return (
    <div className="min-h-[22rem] p-6">
      <Dialog open={true}>
        <DialogTrigger asChild>
          <Button variant="destructive">
            <Archive />
            Archive thread
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <div className="mb-1 flex size-9 items-center justify-center rounded-md bg-destructive/10 text-destructive">
              <AlertTriangle className="size-4" />
            </div>
            <DialogTitle>Archive this thread?</DialogTitle>
            <DialogDescription>
              The thread moves out of the active list and can be restored from
              archived history.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Keep active</Button>
            </DialogClose>
            <Button variant="destructive">Archive</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
