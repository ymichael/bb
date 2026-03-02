import { useRef, useCallback, useEffect } from "react"

const SCROLL_THRESHOLD = 40

export function useAutoScroll(dep: unknown, resetDep?: unknown) {
  const containerRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  const scrollToBottomIfSticking = useCallback(() => {
    const el = containerRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [])

  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickRef.current = distanceFromBottom < SCROLL_THRESHOLD
  }, [])

  useEffect(() => {
    scrollToBottomIfSticking()
  }, [dep, scrollToBottomIfSticking])

  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof window === "undefined") return

    let frameId: number | null = null
    const schedule = () => {
      if (frameId !== null) return
      frameId = window.requestAnimationFrame(() => {
        frameId = null
        scrollToBottomIfSticking()
      })
    }

    let mutationObserver: MutationObserver | undefined
    if (typeof MutationObserver !== "undefined") {
      mutationObserver = new MutationObserver(() => {
        schedule()
      })
      mutationObserver.observe(el, {
        subtree: true,
        childList: true,
        characterData: true,
      })
    }

    let resizeObserver: ResizeObserver | undefined
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        schedule()
      })
      resizeObserver.observe(el)
    }

    window.addEventListener("resize", schedule)

    return () => {
      mutationObserver?.disconnect()
      resizeObserver?.disconnect()
      window.removeEventListener("resize", schedule)
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId)
      }
    }
  }, [scrollToBottomIfSticking])

  useEffect(() => {
    if (resetDep === undefined) return
    stickRef.current = true
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [resetDep])

  return { containerRef, handleScroll }
}
