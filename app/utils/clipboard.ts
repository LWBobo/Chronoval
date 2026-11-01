/** Copy on HTTPS with the Clipboard API, falling back to selection-based copying on HTTP. */
export async function writeClipboard(text: string): Promise<void> {
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // Permission or browser policy can also reject the modern API on HTTPS.
  }

  if (typeof document === 'undefined' || !document.body) {
    throw new Error('Clipboard unavailable')
  }

  const active = document.activeElement as HTMLElement | null
  const input = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
    ? active
    : null
  const inputSelection = input && input.selectionStart !== null
    ? { start: input.selectionStart, end: input.selectionEnd!, direction: input.selectionDirection ?? undefined }
    : null
  const selection = document.getSelection()
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    : []
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  Object.assign(area.style, {
    position: 'fixed', top: '0', left: '0', width: '1px', height: '1px', opacity: '0',
  })

  // Keep the temporary field inside the active modal's focus trap.
  const host = active?.closest('[role="dialog"], dialog')
    || document.querySelector('dialog[open], [role="dialog"][data-state="open"]')
    || document.body
  try {
    host.appendChild(area)
    area.focus({ preventScroll: true })
    area.select()
    area.setSelectionRange(0, text.length)
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable')
  } finally {
    area.remove()
    try {
      active?.focus({ preventScroll: true })
      if (input && inputSelection) {
        input.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction)
      }
      if (selection) {
        selection.removeAllRanges()
        for (const range of ranges) selection.addRange(range)
      }
    } catch {
      // The original element or selection may have been removed in the meantime.
    }
  }
}
