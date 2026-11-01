export { createClientId as createUploadId } from './client-id'

export async function putUploadPart(file: File, url: string, progress: (percentage: number) => void, signal: AbortSignal) {
  const destination = new URL(url, window.location.origin)
  if (destination.origin !== window.location.origin || !/^\/api\/uploads\/sessions\/[a-f0-9]{32}\/parts\/[a-f0-9]{32}$/.test(destination.pathname)) throw new Error('Invalid upload destination')
  const { token } = await $fetch<{ token: string }>('/api/auth/csrf')
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const abort = () => xhr.abort()
    signal.addEventListener('abort', abort, { once: true })
    xhr.open('PUT', destination.pathname)
    xhr.setRequestHeader('X-CSRF-Token', token)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.upload.onprogress = event => { if (event.lengthComputable) progress(Math.round(event.loaded * 100 / event.total)) }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { progress(100); resolve(); return }
      let message = `HTTP ${xhr.status}`
      try { const data = JSON.parse(xhr.responseText); message = data.message || data.statusMessage || message } catch {}
      reject(new Error(message))
    }
    xhr.onerror = () => reject(new Error('Upload network error'))
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
    xhr.onloadend = () => signal.removeEventListener('abort', abort)
    xhr.send(file)
  })
}
