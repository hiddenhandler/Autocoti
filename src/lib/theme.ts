export type ThemePref = 'system' | 'light' | 'dark'

export function getThemePref(): ThemePref {
  try {
    return (localStorage.getItem('barberngo.theme') as ThemePref) || 'dark'
  } catch {
    return 'dark'
  }
}

export function setThemePref(p: ThemePref) {
  try {
    localStorage.setItem('barberngo.theme', p)
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
