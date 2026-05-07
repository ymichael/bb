import { Archive, Info, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "./button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

export default {
  title: "Primitives/Tooltip",
};

export function Sides() {
  return (
    <TooltipProvider delayDuration={0}>
      <div className="grid min-h-80 place-items-center p-6">
        <div className="grid grid-cols-3 items-center gap-6">
          <div />
          <Tooltip open={true}>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Refresh">
                <RefreshCw />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Refresh</TooltipContent>
          </Tooltip>
          <div />

          <Tooltip open={true}>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Archive">
                <Archive />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Archive</TooltipContent>
          </Tooltip>
          <Tooltip open={true}>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Details">
                <Info />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Details</TooltipContent>
          </Tooltip>
          <Tooltip open={true}>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Delete">
                <Trash2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Delete</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
}

export function LongContent() {
  return (
    <TooltipProvider delayDuration={0}>
      <div className="min-h-48 p-6">
        <Tooltip open={true}>
          <TooltipTrigger asChild>
            <Button variant="outline">Workspace status</Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-64">
            Dev server is running on localhost and accepting browser sessions.
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
