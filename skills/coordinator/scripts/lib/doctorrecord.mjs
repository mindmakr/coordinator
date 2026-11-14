// The last online plugin version check, kept on disk for the PC's "Waiting on you"
// (lib/waiting.mjs): ~/.coordinator/doctor.json (COORDINATOR_HOME moves the folder), written by
// doctor.mjs only when it compared the plugin with the latest release. The dashboard reads it and
// never calls the network itself. Holds { checkedAt, mine, latest }: two versions and a time, no text.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { registryHome } from './registry.mjs';
import { withLock, writeJson } from './store.mjs';

export const DOCTOR_FILE = 'doctor.json';
export const doctorFile = (home = registryHome()) => join(home, DOCTOR_FILE);

// "1.6.1" or "v1.6.1" as [1, 6, 1]; anything else as [].
export const semver = (s) => (/^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(s ?? '').trim()) ?? []).slice(1).map(Number);
// True when version a is newer than b (both as semver arrays).
export const newer = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
const plain = (v) => (semver(v).length === 3 ? semver(v).join('.') : null);

// The record to keep from doctor's checks: only when the version check reached the release tags.
export function doctorRecord(checks, at = new Date().toISOString()) {
  const v = (checks ?? []).find((c) => c?.id === 'version');
  const mine = plain(v?.mine); const latest = plain(v?.latest);
  return mine && latest ? { checkedAt: at, mine, latest } : null;
}

export function saveDoctorRecord(rec, home = registryHome()) {
  const file = doctorFile(home);
  withLock(file, () => writeJson(file, rec));
  return file;
}

// The stored record, or null when there is none or it does not read as one.
export function readDoctorRecord(home = registryHome()) {
  try {
    const d = JSON.parse(readFileSync(doctorFile(home), 'utf8'));
    const mine = plain(d?.mine); const latest = plain(d?.latest);
    return mine && latest && typeof d.checkedAt === 'string' && !Number.isNaN(Date.parse(d.checkedAt)) ? { checkedAt: d.checkedAt, mine, latest } : null;
  } catch { return null; }
}
