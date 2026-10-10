export const SOFT_KICKER = 'X trends'
export const SOFT_TITLE = 'Chrono Flash · News Soft (X trends)'

/** Short SHA painted on Soft home/footer. Must match the shipped tip. */
export function shortTipSha(raw: string | undefined): string {
  const sha = (raw ?? '').trim()
  if (!sha) return 'unknown'
  return sha.slice(0, 7)
}

export const SOFT_TIP = shortTipSha(import.meta.env?.VITE_GIT_SHA)
