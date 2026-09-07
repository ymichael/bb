import { useRef, type RefObject } from "react";

export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  // oxlint-disable-next-line react/refs
  ref.current = value;
  return ref;
}
