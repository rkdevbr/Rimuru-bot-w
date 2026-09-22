import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const authDir = process.env.AUTH_DIR || 'auth';
const stateFile = join(authDir, 'antidelete-consent.json');
let state = { users: {} };

function keyFromJid(jid = '') {
  return String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
}

async function persist() {
  await mkdir(authDir, { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8');
}

export async function initAntiDeleteConsent() {
  try {
    const raw = await readFile(stateFile, 'utf-8');
    const parsed = JSON.parse(raw);
    state = parsed?.users && typeof parsed.users === 'object' ? parsed : { users: {} };
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error('Falha ao carregar consentimentos anti-delete:', error?.message || error);
  }
}

export function antiDeleteStatus(jid) {
  const key = keyFromJid(jid);
  return state.users[key]?.status || 'none';
}

export function hasAntiDeleteConsent(jid) {
  return antiDeleteStatus(jid) === 'active';
}

export async function requestAntiDeleteConsent(jid, requestedBy = '') {
  const key = keyFromJid(jid);
  if (!key) return false;
  state.users[key] = { status: 'pending', requestedBy, requestedAt: Date.now(), updatedAt: Date.now() };
  await persist();
  return true;
}

export async function acceptAntiDeleteConsent(jid) {
  const key = keyFromJid(jid);
  if (!key || state.users[key]?.status !== 'pending') return false;
  state.users[key] = { ...state.users[key], status: 'active', consentedAt: Date.now(), updatedAt: Date.now() };
  await persist();
  return true;
}

export async function declineAntiDeleteConsent(jid) {
  const key = keyFromJid(jid);
  if (!key || state.users[key]?.status !== 'pending') return false;
  state.users[key] = { ...state.users[key], status: 'declined', declinedAt: Date.now(), updatedAt: Date.now() };
  await persist();
  return true;
}

export async function revokeAntiDeleteConsent(jid) {
  const key = keyFromJid(jid);
  if (!key || state.users[key]?.status !== 'active') return false;
  state.users[key] = { ...state.users[key], status: 'revoked', revokedAt: Date.now(), updatedAt: Date.now() };
  await persist();
  return true;
}
