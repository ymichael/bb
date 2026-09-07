import { useLayoutEffect, useRef } from "react";

export function useResetPickerScroll<T extends HTMLElement>(query: string) {
  const scrollRef = useRef<T>(null);

  useLayoutEffect(() => {
    if (scrollRef.current !== null) {
      scrollRef.current.scrollTop = 0;
    }
  }, [query]);

  return scrollRef;
}
