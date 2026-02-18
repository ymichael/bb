import { useCallback, type RefObject } from "react"

const MIN_HEIGHT = 60
const MAX_HEIGHT = 160

interface UseAutoGrowOptions {
  minHeight?: number
  maxHeight?: number
}

export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  {
    minHeight = MIN_HEIGHT,
    maxHeight = MAX_HEIGHT,
  }: UseAutoGrowOptions = {}
) {
  const resize = useCallback((textarea?: HTMLTextAreaElement | null) => {
    const element = textarea ?? ref.current
    if (!element) return
    element.style.height = "auto"
    element.style.height = `${Math.min(
      Math.max(element.scrollHeight, minHeight),
      maxHeight
    )}px`
  }, [maxHeight, minHeight, ref])

  return resize
}
