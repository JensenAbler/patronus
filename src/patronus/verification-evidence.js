// Challenge-only evidence writer. The supplied encoder must crop the given frame in RAM.
// It has no browser/network/input capability. Unknown or absent panels are never
// persisted as screenshots, preventing accidental application-form retention.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createEvidenceWriter({ directory, attemptId, encodeCrop, utc }) {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(attemptId)) throw Error('INVALID_ATTEMPT_ID');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let sequence = 0;
  return async function preserve(frame, phase) {
    if (!/^[A-Za-z0-9:_-]{1,100}$/.test(phase)) throw Error('INVALID_PHASE');
    const stem = `${attemptId}-${String(++sequence).padStart(3, '0')}-${phase.replaceAll(':', '_')}`;
    const metadata = { utc: utc(), phase, sequence, panelPresent: frame.panelPresent === true,
      session: frame.session, imageHash: frame.imageHash, anchorHash: frame.anchorHash,
      controlHash: frame.controlHash, control: ['Skip', 'Next', 'Verify'].includes(frame.controlLabel) ? frame.controlLabel : null };
    if (frame.panelPresent === true && frame.anchorVerified === true) {
      for (const [name, rectangle] of [['panel', frame.panelRectangle], ['control', frame.controlRectangle]]) {
        if (!rectangle || !Number.isInteger(rectangle.x) || !Number.isInteger(rectangle.y)
          || !Number.isInteger(rectangle.width) || !Number.isInteger(rectangle.height)
          || rectangle.x < 0 || rectangle.y < 0 || rectangle.width <= 0 || rectangle.height <= 0)
          throw Error('INVALID_CROP');
        const data = await encodeCrop(frame, rectangle);
        const file = `${stem}-${name}.jpg`;
        writeFileSync(join(directory, file), data, { mode: 0o600, flag: 'wx' });
        metadata[name + 'File'] = file;
      }
    }
    writeFileSync(join(directory, `${stem}.json`), JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return metadata;
  };
}
