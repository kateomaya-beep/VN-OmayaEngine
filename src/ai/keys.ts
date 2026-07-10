// API keys live ONLY in localStorage and never leave the client except in the
// direct request to the chosen provider (see ТЗ §1, §12).

const PREFIX = 'nf_apikey_';

export function getApiKey(provider: string): string {
  return localStorage.getItem(PREFIX + provider) || '';
}

export function setApiKey(provider: string, key: string): void {
  if (key) localStorage.setItem(PREFIX + provider, key);
  else localStorage.removeItem(PREFIX + provider);
}
