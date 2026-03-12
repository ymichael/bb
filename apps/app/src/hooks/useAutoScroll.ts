import { useRef, useCallback, useEffect, useLayoutEffect, useState } from "react"
import {
  DEFAULT_SCROLL_STICK_THRESHOLD_PX,
} from "@beanbag/ui-core";

function shouldShowScrollToBottom(el: HTMLDivElement): boolean {
  const maxScrollOffset = el.scrollHeight - el.clientHeight
  if (maxScrollOffset <= DEFAULT_SCROLL_STICK_THRESHOLD_PX) {
    return false
  }
  const distanceFromBottom = maxScrollOffset - el.scrollTop
  return distanceFromBottom > DEFAULT_SCROLL_STICK_THRESHOLD_PX
}

export function useAutoScroll(dep: unknown, resetDep?: unknown) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(null)
  const [isStickingToBottom, setIsStickingToBottom] = useState(true)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const stickRef = useRef(true)

  const setContainerRef = useCallback((element: HTMLDivElement | null) => {
    containerRef.current = element
    setContainerElement((currentElement) =>
      currentElement === element ? currentElement : element)
  }, [])

  const setStickyState = useCallback((nextValue: boolean) => {
    stickRef.current = nextValue
    setIsStickingToBottom((currentValue) =>
      currentValue === nextValue ? currentValue : nextValue)
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    // Manual/programmatic scroll requests should restore sticky-bottom mode.
    // Use an immediate jump so follow-up renders can't outrun a smooth animation.
    setStickyState(true)
    el.scrollTop = el.scrollHeight
    setShowScrollToBottom(false)
  }, [setStickyState])

  const scrollToBottomIfSticking = useCallback(() => {
    const el = containerRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [])

  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const nextStickyState = distanceFromBottom <= DEFAULT_SCROLL_STICK_THRESHOLD_PX
    setStickyState(nextStickyState)
    setShowScrollToBottom(shouldShowScrollToBottom(el))
  }, [setStickyState])

  useEffect(() => {
    scrollToBottomIfSticking()
    if (containerElement) {
      setShowScrollToBottom(shouldShowScrollToBottom(containerElement))
    }
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
        setShowScrollToBottom(shouldShowScrollToBottom(el))
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
        attributes: true,
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

  useLayoutEffect(() => {
    if (resetDep === undefined) return
    scrollToBottom()

    if (typeof window === "undefined") {
      return
    }

    const frameId = window.requestAnimationFrame(() => {
      scrollToBottom()
    })

    return () => {
      window.cancelAnimationFrame(frameId)
    }
  }, [containerElement, resetDep, scrollToBottom])

  return {
    containerRef,
    containerElement,
    setContainerRef,
    handleScroll,
    scrollToBottom,
    isStickingToBottom,
    showScrollToBottom,
  }
}
