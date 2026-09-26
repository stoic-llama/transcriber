import { transcriptFileName } from '../utils/format';

interface Props {
  fileName: string;
  onDownload: () => void;
}

export function TranscriptDownload({ fileName, onDownload }: Props) {
  return (
    <button type="button" className="primary" onClick={onDownload} title={`Save as ${transcriptFileName(fileName)}`}>
      Download TXT
    </button>
  );
}
