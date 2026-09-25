import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { getProEntryForMessage } from './pro.js';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 3650;
let stateFile = null;
const vips = new Map();

function digits(value = '') {
  return String(value).replace(/\D/g, '');
}

function normalizePhone(value = '') {
  let phone = digits(value);
  if (!phone) return '';
  if (phone.length === 10 || phone.length === 11) phone = `55${phone}`;
  return /^\d{10,15}$/.test(phone) ? phone : '';
}

function formatPhone(value = '') {
  const phone = normalizePhone(value) || digits(value);
  if (phone.startsWith('55')) {
    const local = phone.slice(2);
    const ddd = local.slice(0, 2);
    const number = local.slice(2);
    if (number.length === 9) return `+55 ${ddd} ${number.slice(0, 5)}-${number.slice(5)}`;
    if (number.length === 8) return `+55 ${ddd} ${number.slice(0, 4)}-${number.slice(4)}`;
  }
  return phone ? `+${phone}` : 'indisponível';
}

function prefix() {
  return String(config.prefix || '!');
}

function isActive(entry) {
  return Boolean(entry && Number(entry.expiresAt || 0) > Date.now());
}

function formatDate(timestamp) {
  try {
    return new Date(timestamp).toLocaleString('pt-BR', {
      timeZone: 'America/Boa_Vista',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return 'data indisponível';
  }
}

async function save() {
  if (!stateFile) return;
  await mkdir(join(stateFile, '..'), { recursive: true }).catch(() => {});
  await writeFile(stateFile, JSON.stringify({ version: 1, vips: Object.fromEntries(vips) }, null, 2), 'utf-8');
}

function purgeExpired() {
  let changed = false;
  for (const [phone, entry] of vips) {
    if (!isActive(entry)) {
      vips.delete(phone);
      changed = true;
    }
  }
  return changed;
}

export async function initVipAccess(authDir) {
  stateFile = join(authDir, 'vip-access.json');
  try {
    const raw = await readFile(stateFile, 'utf-8');
    const saved = JSON.parse(raw);
    vips.clear();
    for (const [phone, entry] of Object.entries(saved?.vips || {})) {
      const normalized = normalizePhone(phone);
      if (!normalized) continue;
      vips.set(normalized, {
        phone: normalized,
        addedAt: Number(entry?.addedAt || Date.now()),
        expiresAt: Number(entry?.expiresAt || 0),
        note: String(entry?.note || '').slice(0, 80)
      });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error('[VIP] Falha ao carregar VIPs:', error?.message || error);
  }
  if (purgeExpired()) await save();
}

async function senderNumbers(sock, msg) {
  const candidates = [msg?.key?.participantPn, msg?.key?.participantAlt, msg?.key?.participant, msg?.key?.remoteJid].filter(Boolean);
  const numbers = new Set();
  for (const candidate of candidates) {
    const value = String(candidate);
    if (!value.endsWith('@g.us') && !value.endsWith('@lid')) {
      const direct = normalizePhone(value.split('@')[0].split(':')[0]);
      if (direct) numbers.add(direct);
    }
    if (value.endsWith('@lid')) {
      try {
        const mapped = await sock.signalRepository?.lidMapping?.getPNForLID?.(value);
        const mappedPhone = normalizePhone(String(mapped || '').split('@')[0].split(':')[0]);
        if (mappedPhone) numbers.add(mappedPhone);
      } catch {}
    }
  }
  return numbers;
}

export async function isVipUser(sock, msg) {
  if (purgeExpired()) await save();
  const numbers = await senderNumbers(sock, msg);
  for (const phone of numbers) {
    if (isActive(vips.get(phone))) return true;
  }
  return false;
}

async function currentVipEntry(sock, msg) {
  const numbers = await senderNumbers(sock, msg);
  for (const phone of numbers) {
    const entry = vips.get(phone);
    if (isActive(entry)) return entry;
  }
  return null;
}

function contextTarget(msg) {
  const info = msg?.message?.extendedTextMessage?.contextInfo || msg?.message?.imageMessage?.contextInfo || msg?.message?.videoMessage?.contextInfo || null;
  return info?.mentionedJid?.[0] || info?.participantAlt || info?.participant || '';
}

async function resolveTargetPhone(sock, msg, raw = '') {
  const first = String(raw || '').trim().split(/\s+/u)[0] || '';
  const direct = normalizePhone(first);
  if (direct) return direct;
  const target = contextTarget(msg);
  if (!target) return '';
  if (!String(target).endsWith('@lid')) return normalizePhone(String(target).split('@')[0].split(':')[0]);
  try {
    const mapped = await sock.signalRepository?.lidMapping?.getPNForLID?.(target);
    return normalizePhone(String(mapped || '').split('@')[0].split(':')[0]);
  } catch {
    return '';
  }
}

function parseDays(raw = '', fallback = DEFAULT_DAYS) {
  const parts = String(raw || '').trim().split(/\s+/u).filter(Boolean);
  const candidate = Number(parts[1] || fallback);
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > MAX_DAYS) return null;
  return candidate;
}

async function send(sock, jid, msg, text) {
  await sock.sendMessage(jid, { text }, { quoted: msg });
}

function planText() {
  const p = prefix();
  return `╭━━━〔 💎 RIMURU VIP 〕━━━╮\n` +
    `┃ O pacote premium completo do bot\n` +
    `╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
    `O VIP libera mídia em alta qualidade, IA avançada, stickers premium, ferramentas pessoais e recursos avançados para administradores de grupos.\n\n` +
    `Também libera o uso dos comandos da Rimuru diretamente no privado.\n\n` +
    `Use *${p}planos* ou *${p}assinar vip* para assinar.\n` +
    `Use *${p}vipstatus* para consultar seu acesso.`;
}

function vipCommandMenu(expiresAt = 0, isOwner = false) {
  const p = prefix();
  const status = isOwner
    ? 'Acesso do dono: *VIP COMPLETO*'
    : expiresAt
      ? `VIP ativo até: *${formatDate(expiresAt)}*`
      : 'VIP: *ATIVO*';

  return `╭━━━〔 💎 RIMURU VIP 〕━━━╮\n` +
    `┃ ${status}\n` +
    `╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
    `🖼️ *MÍDIA & STICKERS*\n` +
    `• *${p}hd* — melhora mídia para alta qualidade\n` +
    `• *${p}melhorar* — melhora nitidez e resolução de imagem\n` +
    `• *${p}stickerhd* — cria figurinha em qualidade superior\n` +
    `• *${p}stickerpack nome* — organiza o pacote de stickers\n` +
    `• *${p}marca nome* — personaliza a marca do sticker\n` +
    `• *${p}stickergif* — sticker animado otimizado\n\n` +
    `🧰 *UTILIDADES PREMIUM*\n` +
    `• *${p}salvarlink* — biblioteca pessoal de links\n` +
    `• *${p}pixqr chave valor* — gera QR Pix\n` +
    `• *${p}compararpreco produto* — compara referências de preço\n` +
    `• *${p}ddd 95* — consulta estado e cidades do DDD\n` +
    `• *${p}historico* — histórico de comandos usados\n\n` +
    `👥 *GRUPOS — VIP*\n` +
    `• *${p}tagativos* — marca apenas membros ativos\n` +
    `• *${p}inativos dias* — identifica membros inativos\n` +
    `• *${p}relatorio* — relatório do grupo\n` +
    `• *${p}relatorio semanal* — relatório dos últimos 7 dias\n` +
    `• *${p}backupgrupo* — salva configurações do grupo\n\n` +
    `📊 *CONTA VIP*\n` +
    `• *${p}vipstatus* — validade do VIP\n` +
    `• *${p}prioridade* — consulta sua prioridade de processamento\n` +
    `• *${p}renovar* — renova o VIP`;
}

export function isVipInfoCommand(text = '') {
  const p = prefix();
  const head = String(text || '').trim().split(/\s+/u)[0].toLowerCase();
  return [`${p}vip`, `${p}vipstatus`, `${p}planovip`].includes(head);
}

export async function handleVipCommand(sock, jid, msg, text = '', { isOwner = false } = {}) {
  const p = prefix();
  const raw = String(text || '').trim();
  if (!raw.startsWith(p)) return false;

  const [head] = raw.split(/\s+/u);
  const command = head.slice(p.length).toLowerCase();
  const args = raw.slice(head.length).trim();

  const publicCommands = new Set(['vip', 'vipstatus', 'planovip']);
  const ownerCommands = new Set(['addvip', 'remvip', 'renovarvip', 'vips']);
  if (!publicCommands.has(command) && !ownerCommands.has(command)) return false;

  if (publicCommands.has(command)) {
    const entry = await currentVipEntry(sock, msg);
    const legacyEntry = entry ? null : await getProEntryForMessage(sock, msg).catch(() => null);
    const activeEntry = entry || legacyEntry;

    if (command === 'vipstatus') {
      await send(
        sock,
        jid,
        msg,
        isOwner
          ? '💎 VIP: *ATIVO*\nAcesso completo do dono da Rimuru.'
          : activeEntry
            ? `💎 VIP: *ATIVO*\nExpira em: *${formatDate(activeEntry.expiresAt)}*`
            : `💎 VIP: *INATIVO*\nUse *${p}vip* para conhecer o plano.`
      );
      return true;
    }

    if (isOwner || activeEntry) {
      await send(sock, jid, msg, vipCommandMenu(activeEntry?.expiresAt || 0, isOwner));
      return true;
    }

    await send(sock, jid, msg, planText());
    return true;
  }

  if (!isOwner) {
    await send(sock, jid, msg, `⛔ *COMANDO NÃO EXECUTADO*\n\nMotivo: *${command}* é exclusivo do dono da Rimuru.`);
    return true;
  }

  if (command === 'vips') {
    if (purgeExpired()) await save();
    const entries = [...vips.values()].sort((a, b) => a.expiresAt - b.expiresAt);
    if (!entries.length) {
      await send(sock, jid, msg, '💎 Nenhum VIP ativo no momento.');
      return true;
    }
    const lines = entries.slice(0, 50).map((entry, index) => `${index + 1}. *${formatPhone(entry.phone)}* — até ${formatDate(entry.expiresAt)}`);
    await send(sock, jid, msg, `💎 *VIPS ATIVOS*\n\n${lines.join('\n')}`);
    return true;
  }

  const phone = await resolveTargetPhone(sock, msg, args);
  if (!phone) {
    await send(sock, jid, msg, `⚠️ Informe o número ou mencione/responda a pessoa.\nEx.: *${p}${command} 5595999999999 30*`);
    return true;
  }

  if (command === 'remvip') {
    const existed = vips.delete(phone);
    await save();
    await send(sock, jid, msg, existed ? `✅ VIP removido de *${formatPhone(phone)}*.` : `ℹ️ *${formatPhone(phone)}* não possui VIP ativo.`);
    return true;
  }

  const days = parseDays(args);
  if (!days) {
    await send(sock, jid, msg, `⚠️ Quantidade de dias inválida. Use de 1 a ${MAX_DAYS}.`);
    return true;
  }

  const existing = vips.get(phone);
  const base = command === 'renovarvip' && isActive(existing) ? existing.expiresAt : Date.now();
  const expiresAt = base + days * 24 * 60 * 60 * 1000;

  vips.set(phone, {
    phone,
    addedAt: existing?.addedAt || Date.now(),
    expiresAt,
    note: existing?.note || ''
  });
  await save();

  await send(
    sock,
    jid,
    msg,
    `✅ *VIP ${command === 'renovarvip' ? 'RENOVADO' : 'ATIVADO'}*\n\n` +
      `Número: *${formatPhone(phone)}*\n` +
      `Período: *${days} dias*\n` +
      `Expira em: *${formatDate(expiresAt)}*`
  );
  return true;
}
