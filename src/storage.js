// Snapshots, localStorage primary/backup, settings and JSON import/export.
import { validateState } from './model.js';

export const KEYS = {
  run: 'little_beacon.web.v2.run',
  backup: 'little_beacon.web.v2.backup',
  settings: 'little_beacon.web.v2.settings',
};
const MAX_IMPORT = 1024 * 1024;

export function snapshot(s) {
  return JSON.stringify(s);
}

// Parse and fully validate a save; throws an Error with a readable message.
export function parseSnapshot(text, B) {
  if (typeof text !== 'string' || text.length > MAX_IMPORT) throw new Error('Save is missing or larger than 1 MiB');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Save is not valid JSON'); }
  validateState(data, B);
  return data;
}

function store() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

// Returns true when written; never throws.
export function saveRun(s, B) {
  const ls = store();
  if (!ls) return false;
  try {
    const text = snapshot(s);
    parseSnapshot(text, B);
    const prev = ls.getItem(KEYS.run);
    if (prev) {
      try { parseSnapshot(prev, B); ls.setItem(KEYS.backup, prev); } catch { /* keep the older backup */ }
    }
    ls.setItem(KEYS.run, text);
    return true;
  } catch (e) {
    console.warn('Save failed', e);
    return false;
  }
}

// { state, source: 'primary' | 'backup', error } or { state: null, error }.
export function loadRun(B) {
  const ls = store();
  if (!ls) return { state: null, error: 'Browser storage is unavailable' };
  let primaryError = '';
  for (const [source, k] of [['primary', KEYS.run], ['backup', KEYS.backup]]) {
    let text = null;
    try { text = ls.getItem(k); } catch { return { state: null, error: 'Browser storage is blocked' }; }
    if (!text) continue;
    try { return { state: parseSnapshot(text, B), source, error: primaryError }; } catch (e) {
      if (source === 'primary') primaryError = e.message;
    }
  }
  return { state: null, error: primaryError };
}

export function hasRun() {
  try { return !!store()?.getItem(KEYS.run); } catch { return false; }
}

export function exportRun(s) {
  const blob = new Blob([JSON.stringify(s, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `little-beacon-save-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readImport(file, B) {
  if (file.size > MAX_IMPORT) throw new Error('File is larger than 1 MiB');
  return parseSnapshot(await file.text(), B);
}

export function loadSettings() {
  const def = { reducedMotion: matchMedia?.('(prefers-reduced-motion: reduce)').matches || false };
  try { return { ...def, ...JSON.parse(store()?.getItem(KEYS.settings) || '{}') }; } catch { return def; }
}
export function saveSettings(v) {
  try { store()?.setItem(KEYS.settings, JSON.stringify(v)); } catch { /* in-memory only */ }
}
