const TOKEN_KEY = 'panelToken'

// chrome.storage is absent when the panel is opened with `vite dev` outside the extension.
const hasChromeStorage = typeof chrome !== 'undefined' && !!chrome.storage?.local

export async function loadToken(): Promise<string> {
  if (hasChromeStorage) return ((await chrome.storage.local.get(TOKEN_KEY))[TOKEN_KEY] as string) ?? ''
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

export async function saveToken(token: string): Promise<void> {
  if (hasChromeStorage) await chrome.storage.local.set({ [TOKEN_KEY]: token })
  else localStorage.setItem(TOKEN_KEY, token)
}
