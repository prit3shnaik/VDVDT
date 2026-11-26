import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'

const VIEWPORT_PAD = 8
const GAP = 8

interface FloatingDropdownProps {
  open: boolean
  onClose: () => void
  anchor: HTMLElement | null
  align?: 'start' | 'end'
  className?: string
  children: ReactNode
}

export function FloatingDropdown({ open, onClose, anchor, align = 'end', className, children }: FloatingDropdownProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })

  const reposition = useCallback(() => {
    const menu = menuRef.current
    if (!menu || !anchor) {
      return
    }

    const anchorRect = anchor.getBoundingClientRect()
    const menuWidth = menu.offsetWidth
    const menuHeight = menu.offsetHeight

    const spaceBelow = window.innerHeight - anchorRect.bottom
    const spaceAbove = anchorRect.top
    const openUp = spaceBelow < menuHeight + GAP && spaceAbove >= menuHeight + GAP

    const top = openUp ? anchorRect.top - menuHeight - GAP : anchorRect.bottom + GAP
    let left = align === 'end' ? anchorRect.right - menuWidth : anchorRect.left

    const clampedTop = Math.max(VIEWPORT_PAD, Math.min(top, window.innerHeight - menuHeight - VIEWPORT_PAD))
    left = Math.max(VIEWPORT_PAD, Math.min(left, window.innerWidth - menuWidth - VIEWPORT_PAD))

    setPosition({ top: clampedTop, left })
  }, [anchor, align])

  useLayoutEffect(() => {
    if (!open) {
      return
    }
    reposition()
    window.addEventListener('resize', reposition)
    return () => window.removeEventListener('resize', reposition)
  }, [open, reposition])

  useEffect(() => {
    if (!open) {
      return
    }

    const closeOnScroll = (event: Event) => {
      const target = event.target
      if (target instanceof Node && menuRef.current?.contains(target)) {
        return
      }
      onClose()
    }
    const closeOnResize = () => onClose()
    const closeOnOutsidePointer = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target)) {
        return
      }
      if (anchor?.contains(target)) {
        return
      }
      onClose()
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('scroll', closeOnScroll, true)
    window.addEventListener('resize', closeOnResize)
    document.addEventListener('mousedown', closeOnOutsidePointer)
    document.addEventListener('touchstart', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('scroll', closeOnScroll, true)
      window.removeEventListener('resize', closeOnResize)
      document.removeEventListener('mousedown', closeOnOutsidePointer)
      document.removeEventListener('touchstart', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open, onClose, anchor])

  if (!open) {
    return null
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{ top: position.top, left: position.left, zIndex: 9999 }}
      className={`fixed ${className ?? ''}`}
    >
      {children}
    </div>,
    document.body,
  )
}
