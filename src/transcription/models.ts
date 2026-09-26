/**
 * Known OpenAI transcription models (September 2026).
 *
 * - gpt-transcribe: OpenAI's recommended model for file transcription
 *   (announced July 2026). Default.
 * - gpt-4o-transcribe / gpt-4o-mini-transcribe: previous generation; reject
 *   inputs longer than 1500 s.
 * - whisper-1: legacy; the only one that returns segment timestamps
 *   (response_format=verbose_json).
 *
 * The user can also type any other model ID; unknown models get conservative
 * settings (json response, no context prompt, preferred chunk length).
 */
export interface ModelInfo {
  id: string;
  label: string;
  /** Hard input-duration limit if the model has one, in seconds. */
  maxAudioSeconds?: number;
  /** Accepts the `prompt` parameter (used for cross-chunk context). */
  supportsPrompt: boolean;
  /** Returns timestamped segments via response_format=verbose_json. */
  supportsSegments: boolean;
}

export const MODELS: ModelInfo[] = [
  {
    id: 'gpt-transcribe',
    label: 'gpt-transcribe (recommended)',
    supportsPrompt: false,
    supportsSegments: false,
  },
  {
    id: 'gpt-4o-transcribe',
    label: 'gpt-4o-transcribe',
    maxAudioSeconds: 1500,
    supportsPrompt: true,
    supportsSegments: false,
  },
  {
    id: 'gpt-4o-mini-transcribe',
    label: 'gpt-4o-mini-transcribe (cheaper)',
    maxAudioSeconds: 1500,
    supportsPrompt: true,
    supportsSegments: false,
  },
  {
    id: 'whisper-1',
    label: 'whisper-1 (legacy, timestamps)',
    supportsPrompt: true,
    supportsSegments: true,
  },
];

export const DEFAULT_MODEL = MODELS[0].id;

export function getModelInfo(id: string): ModelInfo {
  return (
    MODELS.find((m) => m.id === id) ?? {
      id,
      label: id,
      supportsPrompt: false,
      supportsSegments: false,
    }
  );
}
