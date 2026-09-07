import { useCallback, useRef } from "react";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";

interface RenameDialogAutoFocus {
  inputRef: React.RefObject<HTMLInputElement | null>;
  handleOpenAutoFocus: (event: Event) => void;
}

export function useRenameDialogAutoFocus(): RenameDialogAutoFocus {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isPointerCoarse = usePointerCoarse();
  const handleOpenAutoFocus = useCallback(
    (event: Event) => {
      event.preventDefault();
      if (isPointerCoarse) return;

      const input = inputRef.current;
      if (input) {
        input.focus();
        input.select();
      }
    },
    [isPointerCoarse],
  );
  return { inputRef, handleOpenAutoFocus };
}
