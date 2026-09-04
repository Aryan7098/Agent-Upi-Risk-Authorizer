// Same-origin API calls (FastAPI serves this app in production; Vite proxies in dev).
export async function api(path, options = {}) {
  const { headers, ...rest } = options
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    ...rest,
  })
  if (!res.ok) {
    let detail
    try {
      detail = (await res.json()).detail
    } catch {
      /* ignore */
    }
    throw new Error(detail || `${res.status} ${res.statusText}`)
  }
  return res.json()
}

export const rupees = (paise) =>
  '₹' + (Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })
