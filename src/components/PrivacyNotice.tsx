export function PrivacyNotice() {
  return (
    <section className="privacy">
      <p>
        <strong>Your media is processed in your browser.</strong> The audio chunks required for transcription are
        sent directly from your browser to OpenAI using your API key. This application does not upload your files or
        API key to its own server — it has no server.
      </p>
      <p className="muted">
        Progress and transcripts are saved in this browser (IndexedDB) so you can resume; delete a job to remove
        them. No analytics or tracking.
      </p>
    </section>
  );
}
