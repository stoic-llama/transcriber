import { useCallback, useState } from 'react';
import { DEFAULT_MODEL } from './transcription/models';

const KEY_STORAGE = 'transcriber.openaiApiKey';
const PREFS_STORAGE = 'transcriber.prefs';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode etc.) — memory only
  }
}

interface Prefs {
  model: string;
  language: string;
}

function readPrefs(): Prefs {
  try {
    const parsed = JSON.parse(read(PREFS_STORAGE) ?? '{}') as Partial<Prefs>;
    return { model: parsed.model || DEFAULT_MODEL, language: parsed.language ?? '' };
  } catch {
    return { model: DEFAULT_MODEL, language: '' };
  }
}

/**
 * The API key lives in React state (memory) by default. It is written to
 * localStorage only if the user explicitly ticks "Remember on this device".
 * It is never logged or sent anywhere except api.openai.com.
 */
export function useSettings() {
  const [apiKey, setApiKey] = useState<string>(() => read(KEY_STORAGE) ?? '');
  const [remembered, setRemembered] = useState<boolean>(() => read(KEY_STORAGE) !== null);
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);

  const saveKey = useCallback((key: string, remember: boolean) => {
    setApiKey(key);
    setRemembered(remember);
    write(KEY_STORAGE, remember ? key : null);
  }, []);

  const clearKey = useCallback(() => {
    setApiKey('');
    setRemembered(false);
    write(KEY_STORAGE, null);
  }, []);

  const updatePrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      write(PREFS_STORAGE, JSON.stringify(next));
      return next;
    });
  }, []);

  return { apiKey, remembered, saveKey, clearKey, prefs, updatePrefs };
}
