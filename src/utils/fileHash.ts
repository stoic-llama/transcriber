/**
 * Lightweight file fingerprint used to recognise the same file when resuming.
 *
 * Tradeoff: hashing a multi-gigabyte video completely would take a long time
 * and read the whole file. Instead we hash the metadata (name, size,
 * lastModified, type) plus three 1 MiB samples from the start, middle and end.
 * This reads at most 3 MiB, is effectively instant, and distinguishes
 * different recordings reliably. It would not detect an edit that changes
 * bytes only outside the sampled regions *and* preserves size and
 * lastModified — an acceptable risk for resume matching.
 *
 * We deliberately do not require the name to match: a renamed copy of the same
 * recording still matches via `fingerprint`, and the UI shows name mismatches.
 */
const SAMPLE_BYTES = 1024 * 1024;

export interface FileLike {
  name: string;
  size: number;
  type: string;
  lastModified: number;
  slice(start?: number, end?: number): Blob;
}

export function sampleRanges(size: number, sampleBytes = SAMPLE_BYTES): Array<[number, number]> {
  if (size <= sampleBytes * 3) return [[0, size]];
  const mid = Math.floor(size / 2 - sampleBytes / 2);
  return [
    [0, sampleBytes],
    [mid, mid + sampleBytes],
    [size - sampleBytes, size],
  ];
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function fingerprintFile(file: FileLike): Promise<string> {
  const header = new TextEncoder().encode(`${file.size}|${file.lastModified}|${file.type}|`);
  const parts: BlobPart[] = [header];
  for (const [start, end] of sampleRanges(file.size)) {
    parts.push(await file.slice(start, end).arrayBuffer());
  }
  const data = await new Blob(parts).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', data);
  return `v1:${file.size}:${toHex(digest)}`;
}
