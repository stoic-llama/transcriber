import { useState } from 'react';
import { maskApiKey } from '../utils/format';

interface Props {
  apiKey: string;
  remembered: boolean;
  onSave: (key: string, remember: boolean) => void;
  onClear: () => void;
}

export function ApiKeyInput({ apiKey, remembered, onSave, onClear }: Props) {
  const [draft, setDraft] = useState('');
  const [remember, setRemember] = useState(false);

  if (apiKey) {
    return (
      <section className="card">
        <h2>OpenAI API key</h2>
        <div className="row">
          <code className="masked" aria-label="Saved API key (masked)">
            {maskApiKey(apiKey)}
          </code>
          <button type="button" onClick={onClear}>
            Clear API key
          </button>
        </div>
        <p className="hint">
          {remembered
            ? 'Remembered in this browser’s local storage until you clear it.'
            : 'Kept in memory only — it is forgotten when you close or reload this tab.'}
        </p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>OpenAI API key</h2>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const key = draft.trim();
          if (!key) return;
          onSave(key, remember);
          setDraft('');
        }}
      >
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-…"
          aria-label="OpenAI API key"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" disabled={!draft.trim()}>
          Save key
        </button>
      </form>
      <label className="checkbox">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Remember on this device (stored unencrypted in this browser’s local storage)
      </label>
      <p className="hint">
        The key is yours. Your browser uses it to call OpenAI directly; it is never sent anywhere else. Usage is
        billed to your OpenAI account.
      </p>
    </section>
  );
}
