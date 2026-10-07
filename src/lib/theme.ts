export type ThemePref = 'system' | 'light' | 'dark'

export function getThemePref(): ThemePref {
  try {
    return (localStorage.getItem('autocoti.theme') as ThemePref) || 'system'
  } catch {
    return 'system'
  }
}

export function setThemePref(p: ThemePref) {
  try {
    localStorage.setItem('autocoti.theme', p)
  } catch {
    /* storage unavailable */
  }
  applyStoredTheme()
}

export function applyStoredTheme() {
  const p = getThemePref()
  if (p === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', p)
}
