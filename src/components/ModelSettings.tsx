import { MODELS } from '../transcription/models';

interface Props {
  model: string;
  language: string;
  disabled: boolean;
  onChange: (patch: { model?: string; language?: string }) => void;
}

export function ModelSettings({ model, language, disabled, onChange }: Props) {
  const isKnown = MODELS.some((m) => m.id === model);
  return (
    <details className="card settings">
      <summary>Transcription settings</summary>
      <div className="grid">
        <label>
          Model
          <select
            value={isKnown ? model : '__custom'}
            disabled={disabled}
            onChange={(e) => onChange({ model: e.target.value === '__custom' ? '' : e.target.value })}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            <option value="__custom">Other…</option>
          </select>
        </label>
        {!isKnown && (
          <label>
            Model ID
            <input
              value={model}
              disabled={disabled}
              placeholder="e.g. gpt-transcribe"
              onChange={(e) => onChange({ model: e.target.value.trim() })}
            />
          </label>
        )}
        <label>
          Language (optional)
          <input
            value={language}
            disabled={disabled}
            placeholder="auto-detect, or e.g. en, de, es"
            maxLength={5}
            onChange={(e) => onChange({ language: e.target.value })}
          />
        </label>
      </div>
      <p className="hint">Settings apply to new jobs. A resumed job keeps the model it started with.</p>
    </details>
  );
}
