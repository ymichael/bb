import { useRef, useCallback, useEffect, useState } from "react"

const SCROLL_THRESHOLD = 40

function getScrollAnimationBehavior(): ScrollBehavior {
  if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return "auto"
  }
  return "smooth"
}

export function useAutoScroll(dep: unknown, resetDep?: unknown) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(null)
  const stickRef = useRef(true)

  const setContainerRef = useCallback((element: HTMLDivElement | null) => {
    containerRef.current = element
    setContainerElement((currentElement) =>
      currentElement === element ? currentElement : element)
  }, [])

  const scrollToBottomIfSticking = useCallback(() => {
    const el = containerRef.current
    if (!el || !stickRef.current) return
    el.scrollTo({
      top: el.scrollHeight,
      behavior: getScrollAnimationBehavior(),
    })
  }, [])

  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickRef.current = distanceFromBottom < SCROLL_THRESHOLD
  }, [])

  useEffect(() => {
    scrollToBottomIfSticking()
  }, [containerElement, dep, scrollToBottomIfSticking])

  useEffect(() => {
    const el = containerElement
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
  }, [containerElement, scrollToBottomIfSticking])

  useEffect(() => {
    if (resetDep === undefined) return
    stickRef.current = true
    const el = containerRef.current
    if (el) {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: getScrollAnimationBehavior(),
      })
    }
  }, [containerElement, resetDep])

  return { containerRef, containerElement, setContainerRef, handleScroll }
}
