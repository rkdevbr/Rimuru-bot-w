import makeWASocket, {
  DisconnectReason,
  areJidsSameUser,
  downloadContentFromMessage,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';
import webp from 'node-webpmux';
import { config } from './config.js';
import { menuText, adminMenuText } from './commands/menu.js';
import { initNoxRpg, isNoxCommand, handleNoxCommand } from './rpg/nox.js';
import {
  movieInfo,
  seriesInfo,
  synopsis,
  rating,
  cast,
  trailer,
  watchProviders,
  nowPlaying,
  upcoming,
  topMovies,
  topSeries,
  recommend,
  tmdbErrorMessage
} from './services/tmdb.js';

const logger = pino({ level: 'silent' });
const execFileAsync = promisify(execFile);
const authDir = process.env.AUTH_DIR || 'auth';
const groupSettingsFile = join(authDir, 'group-settings.json');
const botStatsFile = join(authDir, 'bot-stats.json');
const stickerMarksFile = join(authDir, 'sticker-marks.json');
const pairingNumber = (process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '');
let pairingCodeRequested = false;

const pendingQuiz = new Map();
const ratings = new Map();
const groupSettings = new Map();
const processedMessages = new Map();
const floodTracker = new Map();
const processedGroupCalls = new Map();
const stickerMarks = new Map();
let botStats = {
  totalCommands: 0,
  byCommand: {},
  firstSeenAt: Date.now()
};
let botStatsSaveTimer = null;
const MESSAGE_DEDUP_TTL_MS = 2 * 60 * 1000;
const FLOOD_LIMIT = 10;
const FLOOD_WINDOW_MS = 6 * 1000;
const GROUP_CALL_DEDUP_TTL_MS = 10 * 60 * 1000;

function isDuplicateMessage(msg) {
  const id = msg?.key?.id;
  const jid = msg?.key?.remoteJid;

  if (!id || !jid) return false;

  const participant =
    msg?.key?.participant ||
    msg?.key?.participantAlt ||
    '';

  const dedupKey = `${jid}:${participant}:${id}`;
  const now = Date.now();
  const seenAt = processedMessages.get(dedupKey);

  if (seenAt && now - seenAt < MESSAGE_DEDUP_TTL_MS) {
    return true;
  }

  processedMessages.set(dedupKey, now);

  if (processedMessages.size > 1000) {
    for (const [key, timestamp] of processedMessages) {
      if (now - timestamp >= MESSAGE_DEDUP_TTL_MS) {
        processedMessages.delete(key);
      }
    }
  }

  return false;
}

async function loadBotStats() {
  try {
    await mkdir(authDir, { recursive: true });
    const raw = await readFile(botStatsFile, 'utf-8');
    const saved = JSON.parse(raw);

    botStats = {
      totalCommands: Number(saved?.totalCommands || 0),
      byCommand:
        saved?.byCommand && typeof saved.byCommand === 'object'
          ? saved.byCommand
          : {},
      firstSeenAt: Number(saved?.firstSeenAt || Date.now())
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error('Falha ao carregar estatísticas do bot:', error?.message || error);
    }
  }
}

async function saveBotStats() {
  await mkdir(authDir, { recursive: true });
  await writeFile(botStatsFile, JSON.stringify(botStats, null, 2), 'utf-8');
}

function scheduleBotStatsSave() {
  if (botStatsSaveTimer) return;

  botStatsSaveTimer = setTimeout(async () => {
    botStatsSaveTimer = null;

    try {
      await saveBotStats();
    } catch (error) {
      console.error('Falha ao salvar estatísticas do bot:', error?.message || error);
    }
  }, 3000);
}

function registerCommandUsage(command) {
  botStats.totalCommands += 1;
  botStats.byCommand[command] = Number(botStats.byCommand[command] || 0) + 1;
  scheduleBotStatsSave();
}

function topCommandName() {
  const entries = Object.entries(botStats.byCommand);

  if (!entries.length) {
    return 'nenhum ainda';
  }

  const [name, total] = entries.sort((a, b) => b[1] - a[1])[0];
  return `!${name} (${total})`;
}

async function loadStickerMarks() {
  try {
    await mkdir(authDir, { recursive: true });
    const raw = await readFile(stickerMarksFile, 'utf-8');
    const saved = JSON.parse(raw);

    for (const [userKey, mark] of Object.entries(saved || {})) {
      if (typeof mark === 'string' && mark.trim()) {
        stickerMarks.set(userKey, mark.trim().slice(0, 40));
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error('Falha ao carregar marcas de figurinha:', error?.message || error);
    }
  }
}

async function saveStickerMarks() {
  await mkdir(authDir, { recursive: true });
  await writeFile(
    stickerMarksFile,
    JSON.stringify(Object.fromEntries(stickerMarks.entries()), null, 2),
    'utf-8'
  );
}

function stickerMarkUserKey(msg) {
  const candidates = [
    msg?.key?.participantAlt,
    msg?.key?.participant,
    msg?.key?.remoteJid
  ].filter(Boolean);

  const raw =
    candidates.find((jid) => !String(jid).endsWith('@lid')) ||
    candidates[0] ||
    '';

  return String(raw).split('@')[0].split(':')[0];
}

function buildStickerExif(packName, publisher) {
  const metadata = Buffer.from(
    JSON.stringify({
      'sticker-pack-id': `edith-l-${Date.now()}`,
      'sticker-pack-name': packName,
      'sticker-pack-publisher': publisher,
      emojis: ['']
    }),
    'utf-8'
  );

  const header = Buffer.from([
    0x49, 0x49, 0x2a, 0x00,
    0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00,
    0x00, 0x00
  ]);

  header.writeUInt32LE(metadata.length, 14);

  return Buffer.concat([header, metadata]);
}

async function applyStickerMark(stickerBuffer, mark) {
  const tempDir = await mkdtemp(join(tmpdir(), 'edith-take-'));
  const inputPath = join(tempDir, 'input.webp');
  const outputPath = join(tempDir, 'output.webp');

  try {
    await writeFile(inputPath, stickerBuffer);

    const image = new webp.Image();
    await image.load(inputPath);
    image.exif = buildStickerExif(
      mark,
      'Edith l • Cine Lounge Club'
    );
    await image.save(outputPath);

    return await readFile(outputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function handleTake(sock, jid, msg) {
  const userKey = stickerMarkUserKey(msg);
  const stickerMessage = getStickerMessage(msg.message);

  if (!stickerMessage) {
    await send(
      sock,
      jid,
      '🏷️ Responda a uma figurinha escrevendo apenas *take*.',
      msg
    );
    return;
  }

  const pushName = String(msg?.pushName || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const mark = (pushName || (userKey ? `@${userKey}` : 'Cine Lounge Club'))
    .slice(0, 40);

  try {
    const stickerBuffer = await downloadMessageBuffer(stickerMessage, 'sticker');
    const markedSticker = await applyStickerMark(stickerBuffer, mark);

    await sock.sendMessage(
      jid,
      { sticker: markedSticker },
      { quoted: msg }
    );
  } catch (error) {
    console.error('Falha no take:', error?.message || error);
    await send(
      sock,
      jid,
      '❌ Não consegui marcar essa figurinha.',
      msg
    );
  }
}

async function loadGroupSettings() {
  try {
    await mkdir(authDir, { recursive: true });
    const raw = await readFile(groupSettingsFile, 'utf-8');
    const saved = JSON.parse(raw);

    for (const [groupJid, settings] of Object.entries(saved)) {
      groupSettings.set(groupJid, {
        antiLink: Boolean(settings?.antiLink),
        antiFlood: Boolean(settings?.antiFlood),
        antiCall: Boolean(settings?.antiCall),
        welcome: Boolean(settings?.welcome),
        autoApproveBrazil: Boolean(settings?.autoApproveBrazil),
        warnings:
          settings?.warnings && typeof settings.warnings === 'object'
            ? settings.warnings
            : {},
        adminLogs: Array.isArray(settings?.adminLogs)
          ? settings.adminLogs.slice(-100)
          : [],
        activity:
          settings?.activity && typeof settings.activity === 'object'
            ? settings.activity
            : {}
      });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error('Falha ao carregar configurações dos grupos:', error?.message || error);
    }
  }
}

async function saveGroupSettings() {
  await mkdir(authDir, { recursive: true });
  const saved = Object.fromEntries(groupSettings.entries());
  await writeFile(groupSettingsFile, JSON.stringify(saved, null, 2), 'utf-8');
}

function getSettings(jid) {
  let settings = groupSettings.get(jid);

  if (!settings) {
    settings = {
      antiLink: false,
      antiFlood: false,
      antiCall: false,
      welcome: false,
      autoApproveBrazil: false,
      warnings: {},
      adminLogs: [],
      activity: {}
    };
    groupSettings.set(jid, settings);
  }

  settings.antiLink = Boolean(settings.antiLink);
  settings.antiFlood = Boolean(settings.antiFlood);
  settings.antiCall = Boolean(settings.antiCall);
  settings.welcome = Boolean(settings.welcome);
  settings.autoApproveBrazil = Boolean(settings.autoApproveBrazil);

  if (!settings.warnings || typeof settings.warnings !== 'object') {
    settings.warnings = {};
  }

  if (!Array.isArray(settings.adminLogs)) {
    settings.adminLogs = [];
  }

  if (!settings.activity || typeof settings.activity !== 'object') {
    settings.activity = {};
  }

  return settings;
}

function brazilPhoneJid(request = {}) {
  const candidates = [
    request.phoneNumber,
    request.jid,
    request.id,
    request.participant
  ].filter(Boolean);

  for (const candidate of candidates) {
    const value = String(candidate);
    if (value.endsWith('@lid')) continue;

    const digits = value.split('@')[0].split(':')[0].replace(/\D/g, '');

    // Brasil: +55 + DDD (2 dígitos) + número (8 ou 9 dígitos)
    if (/^55\d{10,11}$/.test(digits)) {
      return value.includes('@') ? value : `${digits}@s.whatsapp.net`;
    }
  }

  return null;
}

async function processBrazilJoinRequests(sock, jid) {
  const settings = getSettings(jid);
  if (!settings.autoApproveBrazil) {
    return { approved: 0, pending: 0 };
  }

  const requests = await sock.groupRequestParticipantsList(jid);
  const brazilJids = [...new Set(
    (requests || [])
      .map((request) => brazilPhoneJid(request))
      .filter(Boolean)
  )];

  if (!brazilJids.length) {
    return { approved: 0, pending: (requests || []).length };
  }

  const result = await sock.groupRequestParticipantsUpdate(
    jid,
    brazilJids,
    'approve'
  );

  const approved = Array.isArray(result) ? result.length : brazilJids.length;

  for (const requestJid of brazilJids) {
    addAdminLog(
      jid,
      'AUTO_APROVAR_BR',
      null,
      { id: requestJid },
      'solicitação aprovada automaticamente'
    );
  }

  await saveGroupSettings();

  return {
    approved,
    pending: Math.max(0, (requests || []).length - approved)
  };
}

async function setAutoApproveBrazil(sock, jid, msg, args = '') {
  try {
    const info = await requireGroupAdmin(sock, jid, msg);
    if (!info) return;

    const option = args.trim().toLowerCase();

    if (!['on', 'off', 'status'].includes(option)) {
      await send(
        sock,
        jid,
        'Use *!autoaceitar on*, *!autoaceitar off* ou *!autoaceitar status*.',
        msg
      );
      return;
    }

    const settings = getSettings(jid);

    if (option === 'status') {
      await send(
        sock,
        jid,
        `🇧🇷 Auto-aceitar BR: *${settings.autoApproveBrazil ? 'ATIVADO' : 'DESATIVADO'}*.\nApenas números brasileiros identificáveis (+55) são aprovados.`,
        msg
      );
      return;
    }

    const botInfo = findBotParticipant(info.metadata, sock);
    if (option === 'on' && !botInfo?.admin) {
      await send(
        sock,
        jid,
        '🛡️ A Edith l precisa ser administradora para aprovar solicitações.',
        msg
      );
      return;
    }

    settings.autoApproveBrazil = option === 'on';
    await saveGroupSettings();

    if (!settings.autoApproveBrazil) {
      await send(sock, jid, '🇧🇷 Auto-aceitar BR *DESATIVADO*.', msg);
      return;
    }

    let approvedNow = 0;

    try {
      const result = await processBrazilJoinRequests(sock, jid);
      approvedNow = result.approved;
    } catch (error) {
      console.error('Falha ao processar solicitações ao ativar:', error?.message || error);
    }

    await send(
      sock,
      jid,
      `🇧🇷 Auto-aceitar BR *ATIVADO*.\nSomente números +55 serão aprovados automaticamente.${approvedNow ? `\nAprovados agora: *${approvedNow}*` : ''}`,
      msg
    );
  } catch (error) {
    console.error('Falha no !autoaceitar:', error?.message || error);
    await send(sock, jid, '❌ Não consegui alterar o auto-aceitar.', msg);
  }
}

async function pollBrazilJoinRequests(sock) {
  for (const [groupJid, settings] of groupSettings.entries()) {
    if (!settings?.autoApproveBrazil) continue;

    try {
      await processBrazilJoinRequests(sock, groupJid);
    } catch (error) {
      console.error(
        `Falha ao verificar solicitações de ${groupJid}:`,
        error?.message || error
      );
    }
  }
}

let activitySaveTimer = null;

function scheduleActivitySave() {
  if (activitySaveTimer) return;

  activitySaveTimer = setTimeout(async () => {
    activitySaveTimer = null;
    try {
      await saveGroupSettings();
    } catch (error) {
      console.error('Falha ao salvar atividade:', error?.message || error);
    }
  }, 5000);
}

function trackActivity(jid, msg) {
  if (!jid?.endsWith('@g.us')) return;
  if (msg.key.fromMe) return;

  const sender = msg.key.participant || msg.key.participantAlt;
  if (!sender) return;

  const settings = getSettings(jid);
  const current = settings.activity[sender] || { messages: 0, lastActive: 0 };

  current.messages = Number(current.messages || 0) + 1;
  current.lastActive = Date.now();
  settings.activity[sender] = current;

  scheduleActivitySave();
}

function activityForParticipant(settings, participant) {
  const ids = [participant?.id, participant?.phoneNumber, participant?.lid].filter(Boolean);
  let messages = 0;
  let lastActive = 0;

  for (const [storedJid, stats] of Object.entries(settings.activity || {})) {
    const matches = ids.some((jid) => {
      try {
        return areJidsSameUser(storedJid, jid);
      } catch {
        return storedJid === jid;
      }
    });

    if (!matches) continue;

    messages += Number(stats?.messages || 0);
    lastActive = Math.max(lastActive, Number(stats?.lastActive || 0));
  }

  return { messages, lastActive };
}

async function showActivity(sock, jid, msg) {
  if (!jid.endsWith('@g.us')) {
    await send(sock, jid, '🚫 O comando *!atividade* funciona em grupos.', msg);
    return;
  }

  try {
    const metadata = await sock.groupMetadata(jid);
    const target = getTargetParticipant(metadata, msg, true);

    if (!target) {
      await send(sock, jid, '❌ Não consegui identificar esse membro.', msg);
      return;
    }

    const stats = activityForParticipant(getSettings(jid), target);
    const last = stats.lastActive ? formatLogDate(stats.lastActive) : 'sem registro';

    await sock.sendMessage(
      jid,
      {
        text:
          `📊 *ATIVIDADE*\n\n` +
          `Membro: ${mentionLabel(target.id)}\n` +
          `Mensagens: *${stats.messages}*\n` +
          `Última atividade: *${last}*`,
        mentions: [target.id]
      },
      { quoted: msg }
    );
  } catch (error) {
    console.error('Falha no !atividade:', error?.message || error);
    await send(sock, jid, '❌ Não consegui consultar a atividade.', msg);
  }
}

async function showRanking(sock, jid, msg) {
  if (!jid.endsWith('@g.us')) {
    await send(sock, jid, '🚫 O comando *!ranking* funciona em grupos.', msg);
    return;
  }

  try {
    const metadata = await sock.groupMetadata(jid);
    const settings = getSettings(jid);

    const ranking = metadata.participants
      .map((participant) => ({
        participant,
        ...activityForParticipant(settings, participant)
      }))
      .filter((item) => item.messages > 0)
      .sort((a, b) => b.messages - a.messages)
      .slice(0, 10);

    if (!ranking.length) {
      await send(sock, jid, '📊 Ainda não há atividade suficiente para montar o ranking.', msg);
      return;
    }

    await sock.sendMessage(
      jid,
      {
        text:
          `🏆 *RANKING DE ATIVIDADE*\n\n` +
          ranking
            .map(
              (item, index) =>
                `${index + 1}. ${mentionLabel(item.participant.id)} — *${item.messages}*`
            )
            .join('\n'),
        mentions: ranking.map((item) => item.participant.id)
      },
      { quoted: msg }
    );
  } catch (error) {
    console.error('Falha no !ranking:', error?.message || error);
    await send(sock, jid, '❌ Não consegui montar o ranking.', msg);
  }
}

async function showMembers(sock, jid, msg) {
  if (!jid.endsWith('@g.us')) {
    await send(sock, jid, '🚫 O comando *!membros* funciona em grupos.', msg);
    return;
  }

  try {
    const metadata = await sock.groupMetadata(jid);
    const total = metadata.participants.length;
    const admins = metadata.participants.filter((participant) => participant.admin).length;
    const members = total - admins;

    await send(
      sock,
      jid,
      `👥 *MEMBROS*\n\nTotal: *${total}*\nAdmins: *${admins}*\nMembros: *${members}*`,
      msg
    );
  } catch (error) {
    console.error('Falha no !membros:', error?.message || error);
    await send(sock, jid, '❌ Não consegui consultar os membros.', msg);
  }
}

async function showConfig(sock, jid, msg) {
  if (!jid.endsWith('@g.us')) {
    await send(sock, jid, '🚫 O comando *!config* funciona em grupos.', msg);
    return;
  }

  const settings = getSettings(jid);

  await send(
    sock,
    jid,
    `⚙️ *CONFIGURAÇÃO DO GRUPO*\n\n` +
      `Anti-link: *${settings.antiLink ? 'ON' : 'OFF'}*\n` +
      `Anti-flood: *${settings.antiFlood ? 'ON' : 'OFF'}*\n` +
      `Anti-call: *${settings.antiCall ? 'ON' : 'OFF'}*\n` +
      `Boas-vindas: *${settings.welcome ? 'ON' : 'OFF'}*\n` +
      `Auto-aceitar BR: *${settings.autoApproveBrazil ? 'ON' : 'OFF'}*`,
    msg
  );
}

async function sendGroupLink(sock, jid, msg) {
  try {
    const info = await requireGroupAdmin(sock, jid, msg);
    if (!info) return;

    const botInfo = findBotParticipant(info.metadata, sock);
    if (!botInfo?.admin) {
      await send(sock, jid, '🛡️ A Edith l precisa ser administradora para obter o link.', msg);
      return;
    }

    const code = await sock.groupInviteCode(jid);
    await send(sock, jid, `🔗 https://chat.whatsapp.com/${code}`, msg);
  } catch (error) {
    console.error('Falha no !linkgrupo:', error?.message || error);
    await send(sock, jid, '❌ Não consegui obter o link do grupo.', msg);
  }
}

async function setGroupDescription(sock, jid, msg, args = '') {
  try {
    const info = await requireGroupAdmin(sock, jid, msg);
    if (!info) return;

    const description = args.trim();

    if (!description) {
      await send(sock, jid, 'Exemplo: *!setdesc Nova descrição do grupo*', msg);
      return;
    }

    if (description.length > 512) {
      await send(sock, jid, '❌ A descrição ficou muito longa. Use até 512 caracteres.', msg);
      return;
    }

    const botInfo = findBotParticipant(info.metadata, sock);
    if (!botInfo?.admin) {
      await send(sock, jid, '🛡️ A Edith l precisa ser administradora para alterar a descrição.', msg);
      return;
    }

    await sock.groupUpdateDescription(jid, description);
    addAdminLog(jid, 'ALTERAR_DESCRICAO', info.senderInfo, null, description.slice(0, 80));
    await saveGroupSettings();

    await send(sock, jid, '✅ Descrição do grupo atualizada.', msg);
  } catch (error) {
    console.error('Falha no !setdesc:', error?.message || error);
    await send(sock, jid, '❌ Não consegui alterar a descrição do grupo.', msg);
  }
}

function extractLinks(text = '') {
  const matches = text.match(
    /(?:https?:\/\/|www\.)[^\s]+|(?:[a-z0-9-]+\.)+(?:com|com\.br|net|org|io|gg|me|app|br)(?:\/[^\s]*)?/gi
  );

  return matches || [];
}

function normalizeLink(link = '') {
  const cleaned = link
    .trim()
    .replace(/[),.!?;:]+$/g, '');

  if (/^https?:\/\//i.test(cleaned)) {
    return cleaned;
  }

  return `https://${cleaned.replace(/^www\./i, '')}`;
}

function isAllowedMemberLink(link = '') {
  try {
    const url = new URL(normalizeLink(link));
    const host = url.hostname.toLowerCase().replace(/^www\./, '');

    return (
      host === 'instagram.com' ||
      host.endsWith('.instagram.com') ||
      host === 'tiktok.com' ||
      host.endsWith('.tiktok.com')
    );
  } catch {
    return false;
  }
}

function hasBlockedLinkForMember(text = '') {
  const links = extractLinks(text);
  if (links.length === 0) return false;

  return links.some((link) => !isAllowedMemberLink(link));
}

async function getGroupMemberInfo(sock, jid, msg) {
  const metadata = await sock.groupMetadata(jid);
  const sender = msg.key.participant || msg.key.remoteJid;
  const senderAlt = msg.key.participantAlt;
  const senderInfo = metadata.participants.find((participant) =>
    participantMatches(participant, sender, senderAlt)
  );

  return { metadata, sender, senderAlt, senderInfo };
}

async function handleAntiLink(sock, jid, text, msg) {
  if (!jid.endsWith('@g.us')) return false;
  if (!getSettings(jid).antiLink) return false;
  if (msg.key.fromMe) return false;

  const links = extractLinks(text);
  if (links.length === 0) return false;

  try {
    const { senderInfo } = await getGroupMemberInfo(sock, jid, msg);

    if (senderInfo?.admin) {
      return false;
    }

    if (!hasBlockedLinkForMember(text)) {
      return false;
    }

    await sock.sendMessage(jid, { delete: msg.key });
    await send(
      sock,
      jid,
      '🔗 Link bloqueado. Membros podem enviar apenas links do *Instagram* e *TikTok*. Administradores podem enviar qualquer link.',
      msg
    );
    return true;
  } catch (error) {
    console.error('Falha no anti-link:', error?.message || error);
    return false;
  }
}

async function setAntiLink(sock, jid, msg, args = '') {
  if (!jid.endsWith('@g.us')) {
    await send(sock, jid, '🚫 O comando *!antilink* só funciona em grupos.', msg);
    return;
  }

  try {
    const { senderInfo } = await getGroupMemberInfo(sock, jid, msg);

    if (!senderInfo?.admin) {
      await send(sock, jid, '⛔ Apenas administradores podem alterar o anti-link.', msg);
      return;
    }

    const option = args.trim().toLowerCase();

    if (!['on', 'off', 'status'].includes(option)) {
      await send(
        sock,
        jid,
        'Use *!antilink on*, *!antilink off* ou *!antilink status*.',
        msg
      );
      return;
    }

    if (option === 'status') {
      const enabled = getSettings(jid).antiLink;
      await send(
        sock,
        jid,
        `🔗 Anti-link está *${enabled ? 'ATIVADO' : 'DESATIVADO'}*.`,
        msg
      );
      return;
    }

    const enabled = option === 'on';
    const settings = getSettings(jid);
    settings.antiLink = enabled;

    await saveGroupSettings();

    await send(
      sock,
      jid,
      `🔗 Anti-link *${enabled ? 'ATIVADO' : 'DESATIVADO'}*.${enabled ? '\nMembros: apenas Instagram e TikTok.\nAdministradores: qualquer link.' : ''}`,
      msg
    );
  } catch (error) {
    console.error('Falha ao configurar anti-link:', error?.message || error);
    await send(sock, jid, '❌ Não consegui alterar o anti-link agora.', msg);
  }
}


function isProcessedGroupCall(groupJid, callId) {
  if (!groupJid || !callId) return false;

  const key = `${groupJid}:${callId}`;
  const now = Date.now();
  const seenAt = processedGroupCalls.get(key);

  if (seenAt && now - seenAt < GROUP_CALL_DEDUP_TTL_MS) {
    return true;
  }

  processedGroupCalls.set(key, now);

  if (processedGroupCalls.size > 200) {
    for (const [storedKey, timestamp] of processedGroupCalls) {
      if (now - timestamp >= GROUP_CALL_DEDUP_TTL_MS) {
        processedGroupCalls.delete(storedKey);
      }
    }
  }

  return false;
}

async function setAntiCall(sock, jid, msg, args = '') {
  try {
    const info = await requireGroupAdmin(sock, jid, msg);
    if (!info) return;

    const option = args.trim().toLowerCase();

    if (!['on', 'off', 'status'].includes(option)) {
      await send(
        sock,
        jid,
        'Use *!anticall on*, *!anticall off* ou *!anticall status*.',
        msg
      );
      return;
    }

    const settings = getSettings(jid);

    if (option === 'status') {
      await send(
        sock,
        jid,
        `📵 AntiCall de grupo: *${settings.antiCall ? 'ATIVADO' : 'DESATIVADO'}*.`,
        msg
      );
      return;
    }

    if (option === 'on') {
      const botInfo = findBotParticipant(info.metadata, sock);

      if (!botInfo?.admin) {
        await send(
          sock,
          jid,
          '🛡️ A Edith l precisa ser administradora para remover quem iniciar ligações em grupo.',
          msg
        );
        return;
      }
    }

    settings.antiCall = option === 'on';
    addAdminLog(
      jid,
      settings.antiCall ? 'ANTICALL_ON' : 'ANTICALL_OFF',
      info.senderInfo
    );
    await saveGroupSettings();

    await send(
      sock,
      jid,
      settings.antiCall
        ? '📵 *ANTICALL ATIVADO*\n\nLigações em grupo não são permitidas. Quem iniciar uma chamada será identificado e removido automaticamente quando a Edith tiver permissão para isso.'
        : '📵 AntiCall *DESATIVADO*.',
      msg
    );
  } catch (error) {
    console.error('Falha no !anticall:', error?.message || error);
    await send(sock, jid, '❌ Não consegui alterar o AntiCall.', msg);
  }
}

async function handleGroupAntiCall(sock, call) {
  const groupJid =
    call?.groupJid ||
    (String(call?.chatId || '').endsWith('@g.us') ? call.chatId : null);

  if (!groupJid) return;
  if (call?.status !== 'offer') return;
  if (!(call?.isGroup || call?.groupJid)) return;
  if (!getSettings(groupJid).antiCall) return;
  if (isProcessedGroupCall(groupJid, call?.id)) return;

  try {
    if (call?.id && call?.from) {
      await sock.rejectCall(call.id, call.from);
    }
  } catch (error) {
    console.error('AntiCall: falha ao rejeitar chamada:', error?.message || error);
  }

  try {
    const metadata = await sock.groupMetadata(groupJid);
    const botInfo = findBotParticipant(metadata, sock);

    if (!botInfo?.admin) {
      await sock.sendMessage(groupJid, {
        text:
          '📵 *ANTICALL DETECTOU UMA LIGAÇÃO*\n\n' +
          '⚠️ A Edith l precisa ser administradora para remover quem iniciou.'
      });
      return;
    }

    const callerIds = [call?.from, call?.callerPn].filter(Boolean);
    const caller = metadata.participants.find((participant) =>
      participantMatches(participant, ...callerIds)
    );

    if (!caller) {
      await sock.sendMessage(groupJid, {
        text:
          '📵 *ANTICALL*\n\n' +
          'Uma ligação em grupo foi detectada, mas não consegui identificar com segurança quem iniciou.'
      });
      return;
    }

    const botIds = [sock.user?.id, sock.user?.lid].filter(Boolean);
    const isBot = botIds.some((botJid) => participantMatches(caller, botJid));
    if (isBot) return;

    const callType = call?.isVideo ? 'vídeo' : 'voz';

    await sock.groupParticipantsUpdate(groupJid, [caller.id], 'remove');

    addAdminLog(
      groupJid,
      'ANTICALL_REMOVE',
      null,
      caller,
      `iniciou chamada de ${callType}`
    );
    await saveGroupSettings();

    await sock.sendMessage(groupJid, {
      text:
        `📵 *ANTICALL*\n\n` +
        `${mentionLabel(caller.id)} iniciou uma ligação de ${callType} no grupo e foi removido(a).\n\n` +
        '🚫 Ligações em grupo não são permitidas.',
      mentions: [caller.id]
    });
  } catch (error) {
    console.error('Falha no AntiCall de grupo:', error?.message || error);

    try {
      await sock.sendMessage(groupJid, {
        text:
          '⚠️ O AntiCall detectou uma ligação, mas não conseguiu aplicar a remoção. Verifique se a Edith l continua como administradora.'
      });
    } catch {
      // Não deixa um segundo erro derrubar o listener de chamadas.
    }
  }
}

const quizzes = [
  {
    question: 'Qual filme venceu o Oscar de Melhor Filme em 2020?',
    options: ['A) 1917', 'B) Parasita', 'C) Coringa', 'D) Era Uma Vez em... Hollywood'],
    answer: 'B',
    explanation: 'Parasita venceu o Oscar de Melhor Filme na cerimônia de 2020.'
  },
  {
    question: 'Quem dirigiu Interestelar?',
    options: ['A) Christopher Nolan', 'B) Denis Villeneuve', 'C) James Cameron', 'D) Steven Spielberg'],
    answer: 'A',
    explanation: 'Interestelar foi dirigido por Christopher Nolan.'
  },
  {
    question: 'Em qual universo se passa a série The Mandalorian?',
    options: ['A) Star Trek', 'B) Marvel', 'C) Star Wars', 'D) Duna'],
    answer: 'C',
    explanation: 'The Mandalorian faz parte do universo de Star Wars.'
  },
  {
    question: 'Qual destes é um filme de animação do Studio Ghibli?',
    options: ['A) Your Name', 'B) A Viagem de Chihiro', 'C) Akira', 'D) Paprika'],
    answer: 'B',
    explanation: 'A Viagem de Chihiro é uma produção do Studio Ghibli.'
  }
];

const rulesText = `📜 *REGRAS • CINE LOUNGE CLUB*\n\n1. Respeite todos os membros.\n2. Discussões sobre filmes e séries são bem-vindas, ataques pessoais não.\n3. Avise antes de spoilers e evite revelar pontos importantes sem aviso.\n4. Nada de spam, flood ou divulgação sem autorização.\n5. Mantenha o conteúdo relacionado ao propósito do grupo.\n6. Siga as orientações da administração.\n\n🎬 Bom filme e boa conversa!`;

const groupText = `🎬 *CINE LOUNGE CLUB*\n\nComunidade para conversar sobre filmes e séries, trocar recomendações, comentar lançamentos, teorias, curiosidades e descobrir novos títulos.\n\nUse *!menu* para ver os comandos disponíveis.`;

function getText(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    ''
  ).trim();
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function parseCommand(text) {
  const body = text.slice(config.prefix.length).trim();
  const firstSpace = body.indexOf(' ');

  if (firstSpace === -1) {
    return { command: body.toLowerCase(), args: '' };
  }

  return {
    command: body.slice(0, firstSpace).toLowerCase(),
    args: body.slice(firstSpace + 1).trim()
  };
}

async function send(sock, jid, text, msg) {
  await sock.sendMessage(jid, { text }, { quoted: msg });
}

function getContextInfo(message) {
  return (
    message?.extendedTextMessage?.contextInfo ||
    message?.imageMessage?.contextInfo ||
    message?.videoMessage?.contextInfo ||
    message?.documentMessage?.contextInfo ||
    null
  );
}

function participantMatches(participant, ...jids) {
  const participantJids = [
    participant?.id,
    participant?.phoneNumber,
    participant?.lid
  ].filter(Boolean);

  return jids
    .filter(Boolean)
    .some((jid) =>
      participantJids.some((participantJid) =>
        areJidsSameUser(participantJid, jid)
      )
    );
}

function participantKey(participant) {
  return participant?.phoneNumber || participant?.id || participant?.lid || '';
}

function mentionLabel(jid = '') {
  const user = String(jid).split('@')[0].split(':')[0];
  return user ? `@${user}` : '@membro';
}

function findBotParticipant(metadata, sock) {
  const botIds = [sock.user?.id, sock.user?.lid].filter(Boolean);
  return metadata.participants.find((participant) =>
    participantMatches(participant, ...botIds)
  );
}

function getTargetParticipant(metadata, msg, allowSelf = false) {
  const contextInfo = getContextInfo(msg.message);
  const explicitTarget =
    contextInfo?.mentionedJid?.[0] ||
    contextInfo?.participant ||
    contextInfo?.participantAlt;

  if (explicitTarget) {
    return metadata.participants.find((participant) =>
      participantMatches(participant, explicitTarget)
    ) || null;
  }

  if (!allowSelf) return null;

  const sender = msg.key.participant || msg.key.remoteJid;
  const senderAlt = msg.key.participantAlt;

  return metadata.participants.find((participant) =>
    participantMatches(participant, sender, senderAlt)
  ) || null;
}

async function requireGroupAdmin(sock, jid, msg) {
  if (!jid.endsWith('@g.us')) {
    await send(sock, jid, '🚫 Esse comando só funciona em grupos.', msg);
    return null;
  }

  const info = await getGroupMemberInfo(sock, jid, msg);

  if (!info.senderInfo?.admin) {
    await send(sock, jid, '⛔ Apenas administradores podem usar esse comando.', msg);
    return null;
  }

  return info;
}

function addAdminLog(jid, action, actor, target = null, detail = '') {
  const settings = getSettings(jid);
  settings.adminLogs.push({
    action,
    actor: participantKey(actor),
    target: target ? participantKey(target) : '',
    detail,
    at: Date.now()
  });

  if (settings.adminLogs.length > 100) {
    settings.adminLogs = settings.adminLogs.slice(-100);
  }
}

function formatLogDate(timestamp) {
  try {
    return new Date(timestamp).toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return 'data indisponível';
  }
}

async function showWarnings(sock, jid, msg) {
  if (!jid.endsWith('@g.us')) {
    await send(sock, jid, '🚫 O comando *!advs* funciona em grupos.', msg);
    return;
  }

  try {
    const metadata = await sock.groupMetadata(jid);
    const target = getTargetParticipant(metadata, msg, true);

    if (!target) {
      await send(sock, jid, '❌ Não consegui identificar esse membro.', msg);
      return;
    }

    const settings = getSettings(jid);
    const warnings = settings.warnings[participantKey(target)] || [];

    const lines = warnings.length
      ? warnings
          .slice(-10)
          .reverse()
          .map((warning, index) =>
            `${index + 1}. ${warning.reason || 'Sem motivo'} — ${formatLogDate(warning.at)}`
          )
          .join('\n')
      : 'Nenhuma advertência registrada.';

    await sock.sendMessage(
      jid,
      {
        text: `⚠️ *ADVERTÊNCIAS*\n\nMembro: ${mentionLabel(target.id)}\nTotal: *${warnings.length}*\n\n${lines}`,
        mentions: [target.id]
      },
      { quoted: msg }
    );
  } catch (error) {
    console.error('Falha no !advs:', error?.message || error);
    await send(sock, jid, '❌ Não consegui consultar as advertências.', msg);
  }
}

async function clearWarnings(sock, jid, msg) {
  try {
    const info = await requireGroupAdmin(sock, jid, msg);
    if (!info) return;

    const target = getTargetParticipant(info.metadata, msg);

    if (!target) {
      await send(
        sock,
        jid,
        '⚠️ Use *!limparadv @membro* ou responda a mensagem da pessoa com *!limparadv*.',
        msg
      );
      return;
    }

    const settings = getSettings(jid);
    const key = participantKey(target);
    const total = Array.isArray(settings.warnings[key])
      ? settings.warnings[key].length
      : 0;

    delete settings.warnings[key];
    addAdminLog(jid, 'LIMPAR_ADVERTENCIAS', info.senderInfo, target, `${total} removida(s)`);
    await saveGroupSettings();

    await sock.sendMessage(
      jid,
      {
        text: `🧹 Advertências de ${mentionLabel(target.id)} foram limpas.\nRemovidas: *${total}*`,
        mentions: [target.id]
      },
      { quoted: msg }
    );
  } catch (error) {
    console.error('Falha no !limparadv:', error?.message || error);
    await send(sock, jid, '❌ Não consegui limpar as advertências.', msg);
  }
}

async function showAdminLogs(sock, jid, msg) {
  try {
    const info = await requireGroupAdmin(sock, jid, msg);
    if (!info) return;

    const logs = getSettings(jid).adminLogs.slice(-10).reverse();

    if (!logs.length) {
      await send(sock, jid, '📋 Ainda não há ações administrativas registradas.', msg);
      return;
    }

    const mentions = [];
    const lines = logs.map((log, index) => {
      if (log.actor) mentions.push(log.actor);
      if (log.target) mentions.push(log.target);

      const actor = log.actor ? mentionLabel(log.actor) : 'desconhecido';
      const target = log.target ? ` → ${mentionLabel(log.target)}` : '';
      const detail = log.detail ? ` • ${log.detail}` : '';

      return `${index + 1}. *${log.action}* — ${actor}${target}${detail}\n   ${formatLogDate(log.at)}`;
    });

    await sock.sendMessage(
      jid,
      {
        text: `📋 *LOGS ADMINISTRATIVOS*\n\n${lines.join('\n\n')}`,
        mentions: [...new Set(mentions)]
      },
      { quoted: msg }
    );
  } catch (error) {
    console.error('Falha no !logs:', error?.message || error);
    await send(sock, jid, '❌ Não consegui abrir os logs administrativos.', msg);
  }
}


async function clearAdminLogs(sock, jid, msg) {
  try {
    const info = await requireGroupAdmin(sock, jid, msg);
    if (!info) return;

    const settings = getSettings(jid);
    const total = settings.adminLogs.length;

    settings.adminLogs = [];
    await saveGroupSettings();

    await send(
      sock,
      jid,
      `🧹 Logs administrativos limpos.\nRemovidos: *${total}*`,
      msg
    );
  } catch (error) {
    console.error('Falha no !limparlogs:', error?.message || error);
    await send(sock, jid, '❌ Não consegui limpar os logs administrativos.', msg);
  }
}

function cleanWarningReason(args = '') {
  const cleaned = args.replace(/@\d+/g, '').trim();
  return cleaned || 'Sem motivo informado';
}

async function warnMember(sock, jid, msg, args = '') {
  try {
    const info = await requireGroupAdmin(sock, jid, msg);
    if (!info) return;

    const target = getTargetParticipant(info.metadata, msg);

    if (!target) {
      await send(
        sock,
        jid,
        '⚠️ Use *!adv @membro motivo* ou responda a mensagem da pessoa com *!adv motivo*.',
        msg
      );
      return;
    }

    const settings = getSettings(jid);
    const key = participantKey(target);
    const warnings = Array.isArray(settings.warnings[key])
      ? settings.warnings[key]
      : [];

    const reason = cleanWarningReason(args);
    warnings.push({
      reason,
      at: Date.now(),
      by: participantKey(info.senderInfo)
    });

    settings.warnings[key] = warnings;
    addAdminLog(jid, 'ADVERTENCIA', info.senderInfo, target, reason);
    await saveGroupSettings();

    await sock.sendMessage(
      jid,
      {
        text: `⚠️ ${mentionLabel(target.id)} recebeu uma advertência.\nMotivo: *${reason}*\nTotal: *${warnings.length}*`,
        mentions: [target.id]
      },
      { quoted: msg }
    );
  } catch (error) {
    console.error('Falha no !adv:', error?.message || error);
    await send(sock, jid, '❌ Não consegui registrar a advertência.', msg);
  }
}

async function removeWarning(sock, jid, msg) {
  try {
    const info = await requireGroupAdmin(sock, jid, msg);
    if (!info) return;

    const target = getTargetParticipant(info.metadata, msg);

    if (!target) {
      await send(
        sock,
        jid,
        '⚠️ Use *!remadv @membro* ou responda a mensagem da pessoa com *!remadv*.',
        msg
      );
      return;
    }

    const settings = getSettings(jid);
    const key = participantKey(target);
    const warnings = Array.isArray(settings.warnings[key])
      ? settings.warnings[key]
      : [];

    if (!warnings.length) {
      await sock.sendMessage(
        jid,
        {
          text: `${mentionLabel(target.id)} não possui advertências.`,
          mentions: [target.id]
        },
        { quoted: msg }
      );
      return;
    }

    warnings.pop();

    if (warnings.length) {
      settings.warnings[key] = warnings;
    } else {
      delete settings.warnings[key];
    }

    addAdminLog(jid, 'REMOVER_ADVERTENCIA', info.senderInfo, target);
    await saveGroupSettings();

    await sock.sendMessage(
      jid,
      {
        text: `✅ Uma advertência de ${mentionLabel(target.id)} foi removida.\nTotal restante: *${warnings.length}*`,
        mentions: [target.id]
      },
      { quoted: msg }
    );
  } catch (error) {
    console.error('Falha no !remadv:', error?.message || error);
    await send(sock, jid, '❌ Não consegui remover a advertência.', msg);
  }
}

async function changeAdminRole(sock, jid, msg, action) {
  try {
    const info = await requireGroupAdmin(sock, jid, msg);
    if (!info) return;

    const target = getTargetParticipant(info.metadata, msg);

    if (!target) {
      const command = action === 'promote' ? '!promover' : '!rebaixar';
      await send(
        sock,
        jid,
        `👤 Use *${command} @membro* ou responda a mensagem da pessoa com *${command}*.`,
        msg
      );
      return;
    }

    const botInfo = findBotParticipant(info.metadata, sock);

    if (!botInfo?.admin) {
      await send(sock, jid, '🛡️ A Edith l precisa ser administradora para fazer isso.', msg);
      return;
    }

    if (action === 'promote' && target.admin) {
      await send(sock, jid, 'ℹ️ Esse membro já é administrador.', msg);
      return;
    }

    if (action === 'demote' && !target.admin) {
      await send(sock, jid, 'ℹ️ Esse membro já não é administrador.', msg);
      return;
    }

    if (action === 'demote' && participantMatches(target, sock.user?.id, sock.user?.lid)) {
      await send(sock, jid, '🛡️ A Edith l não vai rebaixar a si mesma.', msg);
      return;
    }

    await sock.groupParticipantsUpdate(jid, [target.id], action);

    addAdminLog(
      jid,
      action === 'promote' ? 'PROMOVER' : 'REBAIXAR',
      info.senderInfo,
      target
    );
    await saveGroupSettings();

    await sock.sendMessage(
      jid,
      {
        text:
          action === 'promote'
            ? `🛡️ ${mentionLabel(target.id)} foi promovido(a) a administrador.`
            : `👤 ${mentionLabel(target.id)} foi rebaixado(a) para membro.`,
        mentions: [target.id]
      },
      { quoted: msg }
    );
  } catch (error) {
    console.error('Falha ao alterar cargo no grupo:', error?.message || error);
    await send(sock, jid, '❌ Não consegui alterar o cargo desse membro.', msg);
  }
}

async function listAdmins(sock, jid, msg) {
  if (!jid.endsWith('@g.us')) {
    await send(sock, jid, '🚫 O comando *!admins* só funciona em grupos.', msg);
    return;
  }

  try {
    const metadata = await sock.groupMetadata(jid);
    const admins = metadata.participants.filter((participant) => participant.admin);

    if (!admins.length) {
      await send(sock, jid, 'Não encontrei administradores no grupo.', msg);
      return;
    }

    await sock.sendMessage(
      jid,
      {
        text: `🛡️ *Administradores — ${metadata.subject}*\n\n${admins
          .map((admin, index) => `${index + 1}. ${mentionLabel(admin.id)}`)
          .join('\n')}`,
        mentions: admins.map((admin) => admin.id)
      },
      { quoted: msg }
    );
  } catch (error) {
    console.error('Falha no !admins:', error?.message || error);
    await send(sock, jid, '❌ Não consegui listar os administradores.', msg);
  }
}

async function setGroupChatState(sock, jid, msg, open) {
  try {
    const info = await requireGroupAdmin(sock, jid, msg);
    if (!info) return;

    const botInfo = findBotParticipant(info.metadata, sock);

    if (!botInfo?.admin) {
      await send(sock, jid, '🛡️ A Edith l precisa ser administradora para abrir ou fechar o grupo.', msg);
      return;
    }

    await sock.groupSettingUpdate(
      jid,
      open ? 'not_announcement' : 'announcement'
    );

    await send(
      sock,
      jid,
      open
        ? '🔓 Grupo *ABERTO*. Todos os membros podem enviar mensagens.'
        : '🔒 Grupo *FECHADO*. Apenas administradores podem enviar mensagens.',
      msg
    );
  } catch (error) {
    console.error('Falha ao abrir/fechar grupo:', error?.message || error);
    await send(sock, jid, '❌ Não consegui alterar quem pode enviar mensagens.', msg);
  }
}

async function setAntiFlood(sock, jid, msg, args = '') {
  try {
    const info = await requireGroupAdmin(sock, jid, msg);
    if (!info) return;

    const option = args.trim().toLowerCase();

    if (!['on', 'off', 'status'].includes(option)) {
      await send(sock, jid, 'Use *!antflood on*, *!antflood off* ou *!antflood status*.', msg);
      return;
    }

    const settings = getSettings(jid);

    if (option === 'status') {
      await send(
        sock,
        jid,
        `🚫 Anti-flood está *${settings.antiFlood ? 'ATIVADO' : 'DESATIVADO'}*.\nLimite: *10 mensagens em 6 segundos*.`,
        msg
      );
      return;
    }

    settings.antiFlood = option === 'on';
    floodTracker.clear();
    await saveGroupSettings();

    await send(
      sock,
      jid,
      `🚫 Anti-flood *${settings.antiFlood ? 'ATIVADO' : 'DESATIVADO'}*.${settings.antiFlood ? '\n10 mensagens em até 6 segundos removem o membro automaticamente. Administradores são ignorados.' : ''}`,
      msg
    );
  } catch (error) {
    console.error('Falha ao configurar anti-flood:', error?.message || error);
    await send(sock, jid, '❌ Não consegui alterar o anti-flood.', msg);
  }
}

async function handleAntiFlood(sock, jid, msg) {
  if (!jid?.endsWith('@g.us')) return false;
  if (!getSettings(jid).antiFlood) return false;
  if (msg.key.fromMe) return false;

  const sender = msg.key.participant || msg.key.participantAlt;
  if (!sender) return false;

  const key = `${jid}:${sender}`;
  const now = Date.now();
  const history = (floodTracker.get(key) || [])
    .filter((timestamp) => now - timestamp <= FLOOD_WINDOW_MS);

  history.push(now);
  floodTracker.set(key, history);

  if (history.length < FLOOD_LIMIT) {
    return false;
  }

  floodTracker.delete(key);

  try {
    const info = await getGroupMemberInfo(sock, jid, msg);

    if (!info.senderInfo || info.senderInfo.admin) {
      return false;
    }

    const botInfo = findBotParticipant(info.metadata, sock);

    if (!botInfo?.admin) {
      await send(
        sock,
        jid,
        '🛡️ Anti-flood detectou excesso de mensagens, mas a Edith l precisa ser administradora para remover o membro.',
        msg
      );
      return false;
    }

    await sock.groupParticipantsUpdate(jid, [info.senderInfo.id], 'remove');

    await sock.sendMessage(
      jid,
      {
        text: `🚫 ${mentionLabel(info.senderInfo.id)} foi removido(a) por flood.\nLimite: *10 mensagens em 6 segundos*.`,
        mentions: [info.senderInfo.id]
      },
      { quoted: msg }
    );

    return true;
  } catch (error) {
    console.error('Falha no anti-flood:', error?.message || error);
    return false;
  }
}

async function setWelcome(sock, jid, msg, args = '') {
  try {
    const info = await requireGroupAdmin(sock, jid, msg);
    if (!info) return;

    const option = args.trim().toLowerCase();

    if (!['on', 'off', 'status'].includes(option)) {
      await send(
        sock,
        jid,
        'Use *!boasvindas on*, *!boasvindas off* ou *!boasvindas status*.',
        msg
      );
      return;
    }

    const settings = getSettings(jid);

    if (option === 'status') {
      await send(
        sock,
        jid,
        `👋 Boas-vindas automáticas estão *${settings.welcome ? 'ATIVADAS' : 'DESATIVADAS'}*.`,
        msg
      );
      return;
    }

    settings.welcome = option === 'on';
    await saveGroupSettings();

    await send(
      sock,
      jid,
      `👋 Boas-vindas automáticas *${settings.welcome ? 'ATIVADAS' : 'DESATIVADAS'}*.`,
      msg
    );
  } catch (error) {
    console.error('Falha ao configurar boas-vindas:', error?.message || error);
    await send(sock, jid, '❌ Não consegui alterar as boas-vindas.', msg);
  }
}

function escapeSvgText(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncateProfileText(value = '', max = 26) {
  const text = String(value).trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function getProfileLevel(messages = 0) {
  const total = Math.max(0, Number(messages || 0));
  const milestones = [50, 150, 300, 500, 750, 1050, 1400, 1800, 2250, 2750];

  let levelStart = 0;

  for (let index = 0; index < milestones.length; index += 1) {
    const nextLevelAt = milestones[index];

    if (total < nextLevelAt) {
      return {
        level: index + 1,
        levelStart,
        nextLevelAt,
        progress: total - levelStart,
        required: nextLevelAt - levelStart
      };
    }

    levelStart = nextLevelAt;
  }

  const extraStep = 700;
  const extraLevels = Math.floor((total - levelStart) / extraStep);
  const currentStart = levelStart + extraLevels * extraStep;

  return {
    level: milestones.length + 1 + extraLevels,
    levelStart: currentStart,
    nextLevelAt: currentStart + extraStep,
    progress: total - currentStart,
    required: extraStep
  };
}

function formatProfileActivity(timestamp = 0) {
  if (!timestamp) return 'Sem registro';

  try {
    return new Date(timestamp).toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return 'Sem registro';
  }
}

async function createProfileFallbackAvatar(label = 'Membro') {
  const initial = escapeSvgText(
    String(label).replace(/^@/, '').trim().charAt(0).toUpperCase() || 'M'
  );

  const svg = `
    <svg width="320" height="320" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="avatarBg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#461017"/>
          <stop offset="55%" stop-color="#171923"/>
          <stop offset="100%" stop-color="#0a0b10"/>
        </linearGradient>
      </defs>
      <rect width="320" height="320" rx="160" fill="url(#avatarBg)"/>
      <circle cx="160" cy="160" r="153" fill="none" stroke="#9f2635" stroke-width="6"/>
      <text
        x="160"
        y="190"
        text-anchor="middle"
        font-family="Arial, Helvetica, sans-serif"
        font-size="128"
        font-weight="700"
        fill="#f8fafc"
      >${initial}</text>
    </svg>
  `;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function getMemberProfilePhoto(sock, participant, label) {
  const candidates = [
    participant?.phoneNumber,
    participant?.id,
    participant?.lid
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const photoUrl = await sock.profilePictureUrl(candidate, 'image');
      if (!photoUrl) continue;

      const response = await fetch(photoUrl, { redirect: 'follow' });

      if (!response.ok) continue;

      const buffer = Buffer.from(await response.arrayBuffer());

      if (buffer.length > 0) {
        return buffer;
      }
    } catch {
      // Tenta outra identificação do mesmo membro.
    }
  }

  return createProfileFallbackAvatar(label);
}

async function makeCircularProfilePhoto(photoBuffer, size = 238) {
  const mask = Buffer.from(`
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/>
    </svg>
  `);

  return sharp(photoBuffer)
    .rotate()
    .resize(size, size, { fit: 'cover', position: 'centre' })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

async function buildProfileCard({
  name,
  mention,
  groupName,
  role,
  messages,
  warnings,
  lastActive,
  photoBuffer
}) {
  const width = 1200;
  const height = 675;
  const levelInfo = getProfileLevel(messages);
  const ratio = levelInfo.required > 0
    ? Math.max(0, Math.min(1, levelInfo.progress / levelInfo.required))
    : 1;
  const progressWidth = Math.max(8, Math.round(510 * ratio));
  const remaining = Math.max(0, levelInfo.nextLevelAt - messages);

  const safeName = escapeSvgText(truncateProfileText(name, 28));
  const safeMention = escapeSvgText(truncateProfileText(mention, 30));
  const safeGroup = escapeSvgText(truncateProfileText(groupName, 38));
  const safeRole = escapeSvgText(role);
  const safeLastActive = escapeSvgText(lastActive);

  const roleBadge =
    role === 'Administrador'
      ? '<rect x="374" y="218" width="186" height="40" rx="20" fill="#3a151b" stroke="#8f2633"/><text x="467" y="244" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="17" font-weight="700" fill="#fecdd3">ADMINISTRADOR</text>'
      : '<rect x="374" y="218" width="112" height="40" rx="20" fill="#171b26" stroke="#343b4d"/><text x="430" y="244" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="17" font-weight="700" fill="#cbd5e1">MEMBRO</text>';

  const warningBadge =
    warnings > 0
      ? `<rect x="1015" y="56" width="126" height="42" rx="21" fill="#35151a" stroke="#7f1d2d"/><text x="1078" y="83" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="700" fill="#fda4af">${warnings} ADV</text>`
      : '<rect x="1015" y="56" width="126" height="42" rx="21" fill="#12231c" stroke="#23523d"/><text x="1078" y="83" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="700" fill="#86efac">SEM ADV</text>';

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#07080c"/>
          <stop offset="48%" stop-color="#0e1017"/>
          <stop offset="100%" stop-color="#151019"/>
        </linearGradient>
        <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#6f1723"/>
          <stop offset="55%" stop-color="#bb3446"/>
          <stop offset="100%" stop-color="#f05d6c"/>
        </linearGradient>
        <radialGradient id="glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#7f1d2d" stop-opacity=".34"/>
          <stop offset="100%" stop-color="#7f1d2d" stop-opacity="0"/>
        </radialGradient>
      </defs>

      <rect width="1200" height="675" fill="url(#bg)"/>
      <circle cx="1030" cy="90" r="250" fill="url(#glow)"/>
      <circle cx="90" cy="650" r="240" fill="url(#glow)" opacity=".42"/>

      <rect x="28" y="28" width="1144" height="619" rx="34" fill="#0d1017" fill-opacity=".88" stroke="#292d3a" stroke-width="2"/>
      <rect x="29" y="29" width="8" height="617" rx="4" fill="url(#accent)"/>

      <text x="72" y="85" font-family="Arial, Helvetica, sans-serif" font-size="21" font-weight="700" letter-spacing="2" fill="#efb3ba">EDITH l</text>
      <text x="72" y="116" font-family="Arial, Helvetica, sans-serif" font-size="15" letter-spacing="3" fill="#737b8c">CINE LOUNGE CLUB • PERFIL</text>
      ${warningBadge}

      <circle cx="216" cy="246" r="130" fill="#171a24" stroke="#872232" stroke-width="3"/>
      <circle cx="216" cy="246" r="120" fill="#0b0d13"/>

      <text x="374" y="172" font-family="Arial, Helvetica, sans-serif" font-size="48" font-weight="700" fill="#f8fafc">${safeName}</text>
      <text x="374" y="204" font-family="Arial, Helvetica, sans-serif" font-size="19" fill="#8c95a7">${safeMention}</text>
      ${roleBadge}

      <text x="374" y="305" font-family="Arial, Helvetica, sans-serif" font-size="17" font-weight="700" fill="#a5adbd">NÍVEL</text>
      <text x="374" y="365" font-family="Arial, Helvetica, sans-serif" font-size="58" font-weight="800" fill="#ffffff">${levelInfo.level}</text>
      <text x="462" y="357" font-family="Arial, Helvetica, sans-serif" font-size="18" fill="#a5adbd">${messages} mensagens</text>
      <text x="462" y="383" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="#767f91">${remaining} para o próximo nível</text>

      <rect x="374" y="410" width="510" height="12" rx="6" fill="#242936"/>
      <rect x="374" y="410" width="${progressWidth}" height="12" rx="6" fill="url(#accent)"/>
      <text x="897" y="422" font-family="Arial, Helvetica, sans-serif" font-size="14" fill="#7d8697">${Math.round(ratio * 100)}%</text>

      <rect x="72" y="475" width="250" height="118" rx="22" fill="#131720" stroke="#292f3d"/>
      <text x="98" y="510" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="700" letter-spacing="1" fill="#757f91">MENSAGENS</text>
      <text x="98" y="563" font-family="Arial, Helvetica, sans-serif" font-size="38" font-weight="800" fill="#f8fafc">${messages}</text>

      <rect x="342" y="475" width="250" height="118" rx="22" fill="#131720" stroke="#292f3d"/>
      <text x="368" y="510" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="700" letter-spacing="1" fill="#757f91">ADVERTÊNCIAS</text>
      <text x="368" y="563" font-family="Arial, Helvetica, sans-serif" font-size="38" font-weight="800" fill="${warnings > 0 ? '#fda4af' : '#f8fafc'}">${warnings}</text>

      <rect x="612" y="475" width="488" height="118" rx="22" fill="#131720" stroke="#292f3d"/>
      <text x="638" y="510" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="700" letter-spacing="1" fill="#757f91">ÚLTIMA ATIVIDADE</text>
      <text x="638" y="550" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="700" fill="#e5e7eb">${safeLastActive}</text>
      <text x="638" y="579" font-family="Arial, Helvetica, sans-serif" font-size="15" fill="#6f788a">${safeGroup}</text>
    </svg>
  `;

  const avatar = await makeCircularProfilePhoto(photoBuffer, 238);

  return sharp(Buffer.from(svg))
    .composite([{ input: avatar, left: 97, top: 127 }])
    .png({ compressionLevel: 8 })
    .toBuffer();
}

async function prepareProfileImage(photoBuffer) {
  return sharp(photoBuffer)
    .rotate()
    .resize(720, 720, {
      fit: 'cover',
      position: 'centre'
    })
    .jpeg({ quality: 92 })
    .toBuffer();
}

function normalizeProfileNumber(input = '') {
  let digits = String(input).replace(/\D/g, '');

  // Se vier sem DDI, assume Brasil.
  if (/^\d{10,11}$/.test(digits)) {
    digits = `55${digits}`;
  }

  if (!/^\d{8,15}$/.test(digits)) {
    return null;
  }

  return digits;
}

function formatProfilePhone(digits = '') {
  if (/^55\d{10,11}$/.test(digits)) {
    const local = digits.slice(2);
    const ddd = local.slice(0, 2);
    const number = local.slice(2);

    if (number.length === 9) {
      return `+55 ${ddd} ${number.slice(0, 5)}-${number.slice(5)}`;
    }

    if (number.length === 8) {
      return `+55 ${ddd} ${number.slice(0, 4)}-${number.slice(4)}`;
    }
  }

  return `+${digits}`;
}

async function findPrivateProfileContext(sock, requesterJid, targetJid) {
  for (const groupJid of groupSettings.keys()) {
    try {
      const metadata = await sock.groupMetadata(groupJid);
      const requester = metadata.participants.find((participant) =>
        participantMatches(participant, requesterJid)
      );

      if (!requester?.admin) continue;

      const target = metadata.participants.find((participant) =>
        participantMatches(participant, targetJid)
      );

      if (!target) continue;

      return {
        metadata,
        target,
        settings: getSettings(groupJid)
      };
    } catch {
      // Ignora grupos indisponíveis e continua procurando.
    }
  }

  return null;
}

async function showPrivateNumberProfile(sock, jid, msg, args = '') {
  const digits = normalizeProfileNumber(args);

  if (!digits) {
    await send(
      sock,
      jid,
      'Use *!perfil número*. Exemplo: *!perfil 95991501077*.',
      msg
    );
    return;
  }

  const lookup = await sock.onWhatsApp(digits);
  const account = Array.isArray(lookup)
    ? lookup.find((item) => item?.exists !== false) || lookup[0]
    : null;

  if (!account?.jid) {
    await send(sock, jid, '❌ Não encontrei esse número no WhatsApp.', msg);
    return;
  }

  const targetJid = account.jid;
  const requesterJid = msg.key.remoteJid;
  const privateContext = await findPrivateProfileContext(
    sock,
    requesterJid,
    targetJid
  );

  if (!privateContext) {
    const rawPhoto = await getMemberProfilePhoto(
      sock,
      { id: targetJid },
      formatProfilePhone(digits)
    );
    const profileImage = await prepareProfileImage(rawPhoto);

    await sock.sendMessage(
      jid,
      {
        image: profileImage,
        mimetype: 'image/jpeg',
        caption:
          `╭━━━〔 👤 PERFIL WHATSAPP 〕━━━╮\n` +
          `┃ Número: *${formatProfilePhone(digits)}*\n` +
          `┃ WhatsApp: *Encontrado*\n` +
          `┃ Dados do grupo: *restritos a admins*\n` +
          `╰━━━━━━━━━━━━━━━━━━━━╯`
      },
      { quoted: msg }
    );
    return;
  }

  const { metadata, target, settings } = privateContext;
  const warningKey = participantKey(target);
  const warnings = Array.isArray(settings.warnings[warningKey])
    ? settings.warnings[warningKey]
    : [];
  const activity = activityForParticipant(settings, target);
  const messages = Number(activity.messages || 0);
  const role = target.admin ? 'Administrador' : 'Membro';
  const levelInfo = getProfileLevel(messages);
  const remaining = Math.max(0, levelInfo.nextLevelAt - messages);

  const mention = mentionLabel(
    target.phoneNumber ||
    target.id ||
    target.lid ||
    targetJid
  );

  const name =
    target.notify ||
    target.name ||
    target.verifiedName ||
    mention;

  const rawPhoto = await getMemberProfilePhoto(sock, target, name);
  const profileImage = await prepareProfileImage(rawPhoto);

  const caption =
    `╭━━━〔 👤 PERFIL 〕━━━╮\n` +
    `┃ Nome: *${name}*\n` +
    `┃ Número: *${formatProfilePhone(digits)}*\n` +
    `┃ Grupo: *${metadata.subject || 'Cine Lounge Club'}*\n` +
    `┃ Nível: *${levelInfo.level}*\n` +
    `┃ Mensagens: *${messages}*\n` +
    `┃ Próximo nível: *${remaining} mensagens*\n` +
    `┃ Cargo: *${role}*\n` +
    `┃ Advertências: *${warnings.length}*\n` +
    `┃ Última atividade: *${formatProfileActivity(activity.lastActive)}*\n` +
    `╰━━━━━━━━━━━━━━━━━━╯`;

  await sock.sendMessage(
    jid,
    {
      image: profileImage,
      mimetype: 'image/jpeg',
      caption
    },
    { quoted: msg }
  );
}

async function showProfile(sock, jid, msg, args = '') {
  if (!jid.endsWith('@g.us')) {
    try {
      await showPrivateNumberProfile(sock, jid, msg, args);
    } catch (error) {
      console.error('Falha no !perfil via PV:', error?.message || error);
      await send(sock, jid, '❌ Não consegui consultar esse perfil agora.', msg);
    }
    return;
  }

  try {
    const metadata = await sock.groupMetadata(jid);
    const target = getTargetParticipant(metadata, msg, true);

    if (!target) {
      await send(sock, jid, '❌ Não consegui identificar esse membro.', msg);
      return;
    }

    const settings = getSettings(jid);
    const warningKey = participantKey(target);
    const warnings = Array.isArray(settings.warnings[warningKey])
      ? settings.warnings[warningKey]
      : [];

    const activity = activityForParticipant(settings, target);
    const messages = Number(activity.messages || 0);
    const role = target.admin ? 'Administrador' : 'Membro';
    const levelInfo = getProfileLevel(messages);
    const remaining = Math.max(0, levelInfo.nextLevelAt - messages);

    const targetJid =
      target.phoneNumber ||
      target.id ||
      target.lid;

    const mention = mentionLabel(targetJid);

    const name =
      target.notify ||
      target.name ||
      target.verifiedName ||
      mention;

    const rawPhoto = await getMemberProfilePhoto(sock, target, name);
    const profileImage = await prepareProfileImage(rawPhoto);

    const caption =
      `╭━━━〔 👤 PERFIL 〕━━━╮\n` +
      `┃ Nome: *${name}*\n` +
      `┃ Membro: ${mention}\n` +
      `┃ Nível: *${levelInfo.level}*\n` +
      `┃ Mensagens: *${messages}*\n` +
      `┃ Próximo nível: *${remaining} mensagens*\n` +
      `┃ Cargo: *${role}*\n` +
      `┃ Advertências: *${warnings.length}*\n` +
      `┃ Última atividade: *${formatProfileActivity(activity.lastActive)}*\n` +
      `╰━━━━━━━━━━━━━━━━━━╯`;

    await sock.sendMessage(
      jid,
      {
        image: profileImage,
        mimetype: 'image/jpeg',
        caption,
        mentions: [target.id]
      },
      { quoted: msg }
    );
  } catch (error) {
    console.error('Falha no !perfil:', error?.message || error);
    await send(sock, jid, '❌ Não consegui gerar o perfil agora.', msg);
  }
}

function formatUptime(totalSeconds) {
  const seconds = Math.floor(totalSeconds);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  return [
    days ? `${days}d` : '',
    hours ? `${hours}h` : '',
    minutes ? `${minutes}m` : '',
    `${remainingSeconds}s`
  ].filter(Boolean).join(' ');
}

async function sendStatus(sock, jid, msg) {
  const rawTimestamp = Number(msg.messageTimestamp || 0);
  const sentAtMs = rawTimestamp > 0 ? rawTimestamp * 1000 : Date.now();
  const latency = Math.max(0, Date.now() - sentAtMs);

  const memory = process.memoryUsage();
  const rssMb = memory.rss / 1024 / 1024;
  const heapUsedMb = memory.heapUsed / 1024 / 1024;
  const heapTotalMb = memory.heapTotal / 1024 / 1024;

  const botVersion = process.env.npm_package_version || '0.1.0';
  const railwayDetected = Boolean(
    process.env.RAILWAY_PROJECT_ID ||
    process.env.RAILWAY_ENVIRONMENT_ID ||
    process.env.RAILWAY_SERVICE_ID
  );
  const railwayEnvironment =
    process.env.RAILWAY_ENVIRONMENT_NAME ||
    process.env.RAILWAY_ENVIRONMENT ||
    'produção';
  const railwayService =
    process.env.RAILWAY_SERVICE_NAME ||
    'edith-l-cine-lounge';
  const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID || '';
  const deployShort = deploymentId ? deploymentId.slice(0, 8) : 'n/d';

  let groupLines = '';

  if (jid.endsWith('@g.us')) {
    const settings = getSettings(jid);
    groupLines =
      `\n\n🛡️ *PROTEÇÕES DO GRUPO*\n` +
      `Anti-link: *${settings.antiLink ? 'ON' : 'OFF'}*\n` +
      `Anti-flood: *${settings.antiFlood ? 'ON' : 'OFF'}*\n` +
      `Boas-vindas: *${settings.welcome ? 'ON' : 'OFF'}*\n` +
      `Auto-aceitar BR: *${settings.autoApproveBrazil ? 'ON' : 'OFF'}*`;
  }

  const railwayLines = railwayDetected
    ? `🟢 Railway: *ATIVO*\n` +
      `🌐 Ambiente: *${railwayEnvironment}*\n` +
      `🧩 Serviço: *${railwayService}*\n` +
      `🚀 Deploy: *${deployShort}*`
    : '⚪ Railway: *não detectado neste ambiente*';

  await send(
    sock,
    jid,
    `🤖 *EDITH l • STATUS TÉCNICO*\n\n` +
      `🟢 Bot: *ONLINE*\n` +
      `⚡ Ping: *${latency} ms*\n` +
      `⏱️ Uptime: *${formatUptime(process.uptime())}*\n` +
      `📦 Versão Edith: *v${botVersion}*\n` +
      `⚙️ Node: *${process.version}*\n\n` +
      `💾 *MEMÓRIA*\n` +
      `RAM/RSS: *${rssMb.toFixed(1)} MB*\n` +
      `Heap: *${heapUsedMb.toFixed(1)} / ${heapTotalMb.toFixed(1)} MB*\n\n` +
      `📊 *USO*\n` +
      `Comandos usados: *${botStats.totalCommands}*\n` +
      `Mais usado: *${topCommandName()}*\n\n` +
      `☁️ *INFRAESTRUTURA*\n` +
      railwayLines +
      groupLines,
    msg
  );
}

// COMMUNITY_BANC_V1
function jidMatchesAny(jid, candidates = []) {
  if (!jid) return false;

  return candidates
    .filter(Boolean)
    .some((candidate) => {
      try {
        return areJidsSameUser(jid, candidate);
      } catch {
        return String(jid) === String(candidate);
      }
    });
}

function participantAliases(participant, extra = []) {
  return [
    ...extra,
    participant?.id,
    participant?.phoneNumber,
    participant?.lid
  ].filter(Boolean);
}

function findParticipantByAliases(metadata, aliases = []) {
  return (metadata?.participants || []).find((participant) =>
    participantAliases(participant).some((participantJid) =>
      jidMatchesAny(participantJid, aliases)
    )
  ) || null;
}

function communityRootJid(metadata, fallbackJid = '') {
  if (metadata?.linkedParent) return metadata.linkedParent;
  if (metadata?.isCommunity) return metadata?.id || fallbackJid;
  return null;
}

async function banCommunityMember(sock, jid, msg) {
  if (!jid.endsWith('@g.us')) {
    await send(sock, jid, '🚫 O comando *!banc* só funciona dentro de grupos de uma comunidade.', msg);
    return;
  }

  try {
    const currentMetadata = await sock.groupMetadata(jid);
    const rootJid = communityRootJid(currentMetadata, jid);

    if (!rootJid) {
      await send(
        sock,
        jid,
        '🏘️ Este grupo não está identificado como parte de uma comunidade. O *!banc* não foi executado.',
        msg
      );
      return;
    }

    const rootMetadata =
      rootJid === jid
        ? currentMetadata
        : await sock.groupMetadata(rootJid);

    const sender = msg.key.participant || msg.key.remoteJid;
    const senderAlt = msg.key.participantAlt;
    const senderCurrent = findParticipantByAliases(
      currentMetadata,
      [sender, senderAlt]
    );
    const senderAliases = participantAliases(
      senderCurrent,
      [sender, senderAlt]
    );
    const senderCommunity = findParticipantByAliases(
      rootMetadata,
      senderAliases
    );

    const communityOwnerIds = [
      rootMetadata?.owner,
      rootMetadata?.ownerPn,
      rootMetadata?.ownerLid
    ].filter(Boolean);

    const senderIsCommunityOwner = senderAliases.some((senderJid) =>
      jidMatchesAny(senderJid, communityOwnerIds)
    );

    if (!senderIsCommunityOwner && !senderCommunity?.admin) {
      await send(
        sock,
        jid,
        '⛔ Apenas administradores ou o dono da comunidade podem usar *!banc*.',
        msg
      );
      return;
    }

    const botCommunity = findBotParticipant(rootMetadata, sock);
    if (!botCommunity?.admin) {
      await send(
        sock,
        jid,
        '🛡️ A Rimuru precisa ser administradora da comunidade para executar *!banc*.',
        msg
      );
      return;
    }

    const contextInfo = getContextInfo(msg.message);
    const rawTarget =
      contextInfo?.mentionedJid?.[0] ||
      contextInfo?.participant ||
      contextInfo?.participantAlt;

    if (!rawTarget) {
      await send(
        sock,
        jid,
        '👤 Use *!banc @membro* ou responda à mensagem da pessoa com *!banc*.',
        msg
      );
      return;
    }

    const currentTarget = findParticipantByAliases(
      currentMetadata,
      [rawTarget]
    );

    const targetAliases = participantAliases(
      currentTarget,
      [
        rawTarget,
        contextInfo?.participant,
        contextInfo?.participantAlt,
        ...(contextInfo?.mentionedJid || [])
      ]
    );

    const botIds = [sock.user?.id, sock.user?.lid].filter(Boolean);

    if (targetAliases.some((targetJid) => jidMatchesAny(targetJid, senderAliases))) {
      await send(sock, jid, '⚠️ Você não pode aplicar *!banc* em si mesmo.', msg);
      return;
    }

    if (targetAliases.some((targetJid) => jidMatchesAny(targetJid, botIds))) {
      await send(sock, jid, '⚠️ A Rimuru não pode aplicar *!banc* nela mesma.', msg);
      return;
    }

    if (targetAliases.some((targetJid) => jidMatchesAny(targetJid, communityOwnerIds))) {
      await send(sock, jid, '👑 O dono da comunidade não pode ser removido com *!banc*.', msg);
      return;
    }

    const rootTarget = findParticipantByAliases(rootMetadata, targetAliases);
    if (rootTarget?.admin === 'superadmin') {
      await send(sock, jid, '👑 O dono da comunidade não pode ser removido com *!banc*.', msg);
      return;
    }

    const allGroups = await sock.groupFetchAllParticipating();
    const related = new Map();

    const addRelated = (groupJid, metadata) => {
      const id = metadata?.id || groupJid;
      if (!id || !String(id).endsWith('@g.us')) return;
      related.set(id, metadata);
    };

    addRelated(jid, currentMetadata);
    addRelated(rootJid, rootMetadata);

    for (const [groupJid, metadata] of Object.entries(allGroups || {})) {
      const id = metadata?.id || groupJid;

      if (
        id === rootJid ||
        metadata?.linkedParent === rootJid ||
        (metadata?.isCommunity && id === rootJid)
      ) {
        addRelated(id, metadata);
      }
    }

    const orderedGroups = [...related.entries()].sort(([a], [b]) => {
      if (a === jid) return 1;
      if (b === jid) return -1;
      return 0;
    });

    let removed = 0;
    let skippedNoAdmin = 0;
    let failures = 0;
    let foundIn = 0;

    for (const [groupJid, cachedMetadata] of orderedGroups) {
      let metadata = cachedMetadata;

      try {
        if (!Array.isArray(metadata?.participants)) {
          metadata = await sock.groupMetadata(groupJid);
        }

        const target = findParticipantByAliases(metadata, targetAliases);
        if (!target) continue;

        foundIn += 1;

        const botInfo = findBotParticipant(metadata, sock);
        if (!botInfo?.admin) {
          skippedNoAdmin += 1;
          continue;
        }

        await sock.groupParticipantsUpdate(groupJid, [target.id], 'remove');
        removed += 1;
      } catch (error) {
        failures += 1;
        console.error(
          `[BANC] Falha ao remover de ${groupJid}:`,
          error?.message || error
        );
      }
    }

    const logTarget =
      currentTarget ||
      rootTarget ||
      { id: rawTarget };

    addAdminLog(
      jid,
      'BANC_COMUNIDADE',
      senderCommunity || senderCurrent,
      logTarget,
      `removido em ${removed}; encontrado em ${foundIn}; sem permissão em ${skippedNoAdmin}; falhas ${failures}`
    );
    await saveGroupSettings();

    if (!foundIn) {
      await send(
        sock,
        jid,
        '🔎 Não encontrei esse membro nos grupos da comunidade acessíveis à Rimuru.',
        msg
      );
      return;
    }

    await sock.sendMessage(
      jid,
      {
        text:
          `🚫 *BANC DA COMUNIDADE CONCLUÍDO*\n\n` +
          `Membro: ${mentionLabel(rawTarget)}\n` +
          `Removido de: *${removed}* grupo(s)\n` +
          `Encontrado em: *${foundIn}* grupo(s)` +
          (skippedNoAdmin ? `\nSem permissão da Rimuru: *${skippedNoAdmin}*` : '') +
          (failures ? `\nFalhas: *${failures}*` : ''),
        mentions: [rawTarget]
      },
      { quoted: msg }
    );
  } catch (error) {
    console.error('Falha no comando !banc:', error?.message || error);
    await send(
      sock,
      jid,
      '❌ Não consegui concluir o banimento da comunidade. Verifique se a Rimuru continua como administradora da comunidade.',
      msg
    );
  }
}

async function banMember(sock, jid, msg) {
  if (!jid.endsWith('@g.us')) {
    await send(sock, jid, '🚫 O comando *!ban* só funciona em grupos.', msg);
    return;
  }

  try {
    const metadata = await sock.groupMetadata(jid);

    const sender = msg.key.participant || msg.key.remoteJid;
    const senderAlt = msg.key.participantAlt;
    const senderInfo = metadata.participants.find((participant) =>
      participantMatches(participant, sender, senderAlt)
    );

    if (!senderInfo?.admin) {
      await send(sock, jid, '⛔ Apenas administradores do grupo podem usar *!ban*.', msg);
      return;
    }

    const contextInfo = getContextInfo(msg.message);
    const target =
      contextInfo?.participant ||
      contextInfo?.participantAlt ||
      contextInfo?.mentionedJid?.[0];

    if (!target) {
      await send(
        sock,
        jid,
        '👤 Responda à mensagem da pessoa com *!ban* ou use *!ban @membro*.',
        msg
      );
      return;
    }

    if (
      areJidsSameUser(target, sender) ||
      (senderAlt && areJidsSameUser(target, senderAlt))
    ) {
      await send(sock, jid, '⚠️ Você não pode usar *!ban* em si mesmo.', msg);
      return;
    }

    const targetInfo = metadata.participants.find((participant) =>
      participantMatches(participant, target)
    );

    if (!targetInfo) {
      await send(sock, jid, '🔎 Não encontrei esse membro no grupo.', msg);
      return;
    }

    const botIds = [
      sock.user?.id,
      sock.user?.lid
    ].filter(Boolean);

    const botInfo = metadata.participants.find((participant) =>
      participantMatches(participant, ...botIds)
    );

    if (!botInfo?.admin) {
      console.log('[BAN DEBUG] Não encontrei Edith como admin.', {
        botIds,
        addressingMode: metadata.addressingMode,
        participants: metadata.participants.map((participant) => ({
          id: participant.id,
          phoneNumber: participant.phoneNumber,
          lid: participant.lid,
          admin: participant.admin
        }))
      });

      await send(
        sock,
        jid,
        '🛡️ Não consegui reconhecer a Edith l como administradora. Vou precisar atualizar a identificação do bot neste grupo.',
        msg
      );
      return;
    }

    await sock.groupParticipantsUpdate(jid, [targetInfo.id], 'remove');

    addAdminLog(jid, 'BAN', senderInfo, targetInfo);
    await saveGroupSettings();

    await sock.sendMessage(
      jid,
      {
        text: '🚫 Membro removido do grupo.',
        mentions: [targetInfo.id]
      },
      { quoted: msg }
    );
  } catch (error) {
    console.error('Falha no comando !ban:', error?.message || error);
    await send(sock, jid, '❌ Não consegui remover esse membro. Verifique as permissões de administrador da Edith l.', msg);
  }
}

const SOCIAL_VIDEO_MAX_BYTES = 30 * 1024 * 1024;

function validateSocialVideoUrl(rawUrl = '', platform) {
  const input = rawUrl.trim();
  if (!input) return null;

  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol)) return null;

    const host = url.hostname.toLowerCase().replace(/^www\./, '');

    if (
      platform === 'tiktok' &&
      (host === 'tiktok.com' ||
        host.endsWith('.tiktok.com'))
    ) {
      return url.toString();
    }

    if (
      platform === 'instagram' &&
      (host === 'instagram.com' ||
        host.endsWith('.instagram.com') ||
        host === 'instagr.am')
    ) {
      return url.toString();
    }
  } catch {
    return null;
  }

  return null;
}

async function ensureYtDlp() {
  const toolsDir = join(authDir, 'tools');
  const isWindows = process.platform === 'win32';
  const binaryPath = join(toolsDir, isWindows ? 'yt-dlp.exe' : 'yt-dlp');

  try {
    await access(binaryPath);
    if (!isWindows) await chmod(binaryPath, 0o755);
    return binaryPath;
  } catch {
    // Instala o binário oficial do yt-dlp no volume persistente na primeira utilização.
  }

  await mkdir(toolsDir, { recursive: true });

  let releaseFile;

  if (isWindows) {
    releaseFile = 'yt-dlp.exe';
  } else if (process.arch === 'arm64') {
    releaseFile = 'yt-dlp_linux_aarch64';
  } else {
    releaseFile = 'yt-dlp_linux';
  }

  const releaseUrl =
    `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${releaseFile}`;

  const response = await fetch(releaseUrl, { redirect: 'follow' });

  if (!response.ok) {
    throw new Error(`Falha ao instalar yt-dlp: HTTP ${response.status}`);
  }

  const binary = Buffer.from(await response.arrayBuffer());

  if (binary.length < 1024 * 1024) {
    throw new Error('Download inválido do yt-dlp.');
  }

  await writeFile(binaryPath, binary);

  if (!isWindows) {
    await chmod(binaryPath, 0o755);
  }

  return binaryPath;
}

async function downloadSocialVideo(url, platform) {
  const ytDlpPath = await ensureYtDlp();
  const tempDir = await mkdtemp(join(tmpdir(), `edith-${platform}-`));
  const outputTemplate = join(tempDir, 'video.%(ext)s');

  try {
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--restrict-filenames',
      '--max-filesize',
      '30M',
      '-f',
      'best[ext=mp4]/best',
      '-o',
      outputTemplate,
      url
    ];

    if (ffmpegPath) {
      args.unshift('--ffmpeg-location', ffmpegPath);
    }

    await execFileAsync(
      ytDlpPath,
      args,
      {
        maxBuffer: 20 * 1024 * 1024,
        timeout: 120000
      }
    );

    const files = (await readdir(tempDir))
      .filter((name) => !name.endsWith('.part') && !name.endsWith('.ytdl'));

    if (!files.length) {
      throw new Error('Nenhum vídeo foi baixado.');
    }

    const preferred =
      files.find((name) => name.toLowerCase().endsWith('.mp4')) ||
      files[0];

    const videoPath = join(tempDir, preferred);
    const info = await stat(videoPath);

    if (info.size > SOCIAL_VIDEO_MAX_BYTES) {
      const error = new Error('VIDEO_TOO_LARGE');
      error.code = 'VIDEO_TOO_LARGE';
      throw error;
    }

    return {
      buffer: await readFile(videoPath),
      mimetype: preferred.toLowerCase().endsWith('.mp4')
        ? 'video/mp4'
        : 'video/mp4'
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function sendSocialVideo(sock, jid, msg, args = '', platform) {
  const label = platform === 'tiktok' ? 'TikTok' : 'Instagram';
  const url = validateSocialVideoUrl(args, platform);

  if (!url) {
    await send(
      sock,
      jid,
      `Exemplo: *!${platform === 'tiktok' ? 'tiktok' : 'instagram'} link-do-${label.toLowerCase()}*`,
      msg
    );
    return;
  }

  await send(sock, jid, `⬇️ Baixando vídeo do *${label}*...\nPode levar alguns segundos.`, msg);

  try {
    const video = await downloadSocialVideo(url, platform);

    await sock.sendMessage(
      jid,
      {
        video: video.buffer,
        mimetype: video.mimetype,
        caption: `✅ Vídeo do ${label}`
      },
      { quoted: msg }
    );
  } catch (error) {
    console.error(
      `Falha no downloader de ${label}:`,
      error?.stderr || error?.message || error
    );

    if (error?.code === 'VIDEO_TOO_LARGE' || error?.message === 'VIDEO_TOO_LARGE') {
      await send(
        sock,
        jid,
        '❌ Esse vídeo ficou grande demais para o limite atual da Edith l.',
        msg
      );
      return;
    }

    await send(
      sock,
      jid,
      `❌ Não consegui baixar esse vídeo do ${label}. O link precisa ser público e válido.`,
      msg
    );
  }
}

function getImageMessage(message) {
  if (!message) return null;

  if (message.imageMessage) return message.imageMessage;
  if (message.ephemeralMessage?.message) return getImageMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return getImageMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return getImageMessage(message.viewOnceMessageV2.message);

  const contextInfo =
    message.extendedTextMessage?.contextInfo ||
    message.imageMessage?.contextInfo ||
    message.videoMessage?.contextInfo ||
    message.documentMessage?.contextInfo ||
    message.stickerMessage?.contextInfo;

  if (contextInfo?.quotedMessage) {
    return getImageMessage(contextInfo.quotedMessage);
  }

  return null;
}

function getVideoMessage(message) {
  if (!message) return null;

  if (message.videoMessage) return message.videoMessage;
  if (message.ephemeralMessage?.message) return getVideoMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return getVideoMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return getVideoMessage(message.viewOnceMessageV2.message);

  const contextInfo =
    message.extendedTextMessage?.contextInfo ||
    message.imageMessage?.contextInfo ||
    message.videoMessage?.contextInfo ||
    message.documentMessage?.contextInfo ||
    message.stickerMessage?.contextInfo;

  if (contextInfo?.quotedMessage) {
    return getVideoMessage(contextInfo.quotedMessage);
  }

  return null;
}

function getStickerMessage(message) {
  if (!message) return null;

  if (message.stickerMessage) return message.stickerMessage;
  if (message.ephemeralMessage?.message) return getStickerMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return getStickerMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return getStickerMessage(message.viewOnceMessageV2.message);

  const contextInfo =
    message.extendedTextMessage?.contextInfo ||
    message.imageMessage?.contextInfo ||
    message.videoMessage?.contextInfo ||
    message.documentMessage?.contextInfo ||
    message.stickerMessage?.contextInfo;

  if (contextInfo?.quotedMessage) {
    return getStickerMessage(contextInfo.quotedMessage);
  }

  return null;
}

async function downloadMessageBuffer(mediaMessage, mediaType) {
  const stream = await downloadContentFromMessage(mediaMessage, mediaType);
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

async function imageToStickerBuffer(imageMessage, mode = 'normal') {
  const imageBuffer = await downloadMessageBuffer(imageMessage, 'image');
  const isSquareMode = mode === 'str';

  return sharp(imageBuffer)
    .rotate()
    .resize(
      512,
      512,
      isSquareMode
        ? {
            fit: 'cover',
            position: 'centre'
          }
        : {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          }
    )
    .webp({ quality: 86 })
    .toBuffer();
}

async function videoToStickerBuffer(videoMessage, mode = 'normal') {
  if (!ffmpegPath) {
    throw new Error('FFmpeg não está disponível.');
  }

  const videoBuffer = await downloadMessageBuffer(videoMessage, 'video');
  const tempDir = await mkdtemp(join(tmpdir(), 'edith-sticker-'));
  const inputPath = join(tempDir, 'input.mp4');
  const outputPath = join(tempDir, 'output.webp');

  try {
    await writeFile(inputPath, videoBuffer);

    const videoFilter =
      mode === 'str'
        ? 'fps=12,scale=512:512:force_original_aspect_ratio=increase,crop=512:512,format=rgba'
        : 'fps=12,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba';

    await execFileAsync(
      ffmpegPath,
      [
        '-y',
        '-i', inputPath,
        '-t', '6',
        '-vf', videoFilter,
        '-an',
        '-c:v', 'libwebp',
        '-lossless', '0',
        '-compression_level', '6',
        '-q:v', '58',
        '-loop', '0',
        '-preset', 'picture',
        outputPath
      ],
      { maxBuffer: 10 * 1024 * 1024 }
    );

    return await readFile(outputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function videoToMp3Buffer(videoMessage) {
  if (!ffmpegPath) {
    throw new Error('FFmpeg não está disponível.');
  }

  const videoBuffer = await downloadMessageBuffer(videoMessage, 'video');
  const tempDir = await mkdtemp(join(tmpdir(), 'edith-mp3-'));
  const inputPath = join(tempDir, 'input.mp4');
  const outputPath = join(tempDir, 'audio.mp3');

  try {
    await writeFile(inputPath, videoBuffer);

    await execFileAsync(
      ffmpegPath,
      [
        '-y',
        '-i', inputPath,
        '-vn',
        '-codec:a', 'libmp3lame',
        '-b:a', '192k',
        outputPath
      ],
      { maxBuffer: 10 * 1024 * 1024 }
    );

    return await readFile(outputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function sendToMp3(sock, jid, msg) {
  const videoMessage = getVideoMessage(msg.message);

  if (!videoMessage) {
    await send(
      sock,
      jid,
      '🎵 Responda a um vídeo com *!tomp3* para extrair o áudio.',
      msg
    );
    return;
  }

  try {
    const audio = await videoToMp3Buffer(videoMessage);

    await sock.sendMessage(
      jid,
      {
        audio,
        mimetype: 'audio/mpeg',
        ptt: false,
        fileName: 'edith-audio.mp3'
      },
      { quoted: msg }
    );
  } catch (error) {
    console.error('Falha no !tomp3:', error?.message || error);
    await send(sock, jid, '❌ Não consegui extrair o áudio desse vídeo.', msg);
  }
}

async function stickerToImageBuffer(stickerMessage) {
  const stickerBuffer = await downloadMessageBuffer(stickerMessage, 'sticker');

  return sharp(stickerBuffer, { page: 0, pages: 1 })
    .png()
    .toBuffer();
}

async function sendSticker(sock, jid, msg, args = '') {
  const imageMessage = getImageMessage(msg.message);
  const videoMessage = getVideoMessage(msg.message);

  if (!imageMessage && !videoMessage) {
    await send(
      sock,
      jid,
      '🎞️ Envie ou responda uma *imagem* ou *vídeo* com *!s*.\n\nUse *!s -str* para preencher o formato quadrado.',
      msg
    );
    return;
  }

  try {
    const mode = args.toLowerCase().includes('-str') ? 'str' : 'normal';
    const sticker = imageMessage
      ? await imageToStickerBuffer(imageMessage, mode)
      : await videoToStickerBuffer(videoMessage, mode);

    await sock.sendMessage(jid, { sticker }, { quoted: msg });
  } catch (error) {
    console.error('Falha ao criar figurinha:', error?.message || error);
    await send(sock, jid, '❌ Não consegui transformar esse conteúdo em figurinha.', msg);
  }
}

async function sendToImage(sock, jid, msg) {
  const stickerMessage = getStickerMessage(msg.message);

  if (!stickerMessage) {
    await send(
      sock,
      jid,
      '🖼️ Responda a uma figurinha com *!toimg* para transformar em foto.',
      msg
    );
    return;
  }

  try {
    const image = await stickerToImageBuffer(stickerMessage);

    await sock.sendMessage(
      jid,
      {
        image,
        mimetype: 'image/png',
        caption: '🖼️ Figurinha convertida em foto.'
      },
      { quoted: msg }
    );
  } catch (error) {
    console.error('Falha no comando !toimg:', error?.message || error);
    await send(sock, jid, '❌ Não consegui transformar essa figurinha em foto.', msg);
  }
}

async function handleQuizAnswer(sock, jid, text, msg) {
  const quiz = pendingQuiz.get(jid);
  if (!quiz) return false;

  const answer = text.trim().toUpperCase();
  if (!['A', 'B', 'C', 'D'].includes(answer)) return false;

  pendingQuiz.delete(jid);

  if (answer === quiz.answer) {
    await send(sock, jid, `✅ *Acertou!*\n${quiz.explanation}`, msg);
  } else {
    await send(sock, jid, `❌ Não foi dessa vez. A resposta correta era *${quiz.answer}*.\n${quiz.explanation}`, msg);
  }

  return true;
}

async function runTmdbCommand(sock, jid, msg, action) {
  try {
    const result = await action();
    if (!result) {
      await send(sock, jid, '🔎 Não encontrei esse título. Confira o nome e tente novamente.', msg);
      return;
    }
    await send(sock, jid, result, msg);
  } catch (error) {
    await send(sock, jid, tmdbErrorMessage(error), msg);
  }
}

async function startEdith() {
  await Promise.all([
    loadGroupSettings(),
    loadBotStats(),
    loadStickerMarks(),
    initNoxRpg(authDir)
  ]);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: state,
    logger
  });

  if (!state.creds.registered && pairingNumber && !pairingCodeRequested) {
    pairingCodeRequested = true;
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(pairingNumber);
        console.log(`PAIRING_CODE=${code}`);
      } catch (error) {
        pairingCodeRequested = false;
        console.error('Falha ao gerar código de pareamento:', error?.message || error);
      }
    }, 2000);
  }

  sock.ev.on('creds.update', saveCreds);

  let joinRequestTimer = null;

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      pairingCodeRequested = false;
      console.log(`${config.botName} conectada ao WhatsApp.`);

      if (joinRequestTimer) clearInterval(joinRequestTimer);

      pollBrazilJoinRequests(sock).catch((error) => {
        console.error('Falha na verificação inicial de solicitações:', error?.message || error);
      });

      joinRequestTimer = setInterval(() => {
        pollBrazilJoinRequests(sock).catch((error) => {
          console.error('Falha ao verificar solicitações:', error?.message || error);
        });
      }, 15000);
    }

    if (connection === 'close') {
      if (joinRequestTimer) {
        clearInterval(joinRequestTimer);
        joinRequestTimer = null;
      }
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log('Conexão encerrada.', shouldReconnect ? 'Reconectando...' : 'Sessão desconectada.');
      if (shouldReconnect) startEdith();
    }
  });

  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    if (action !== 'add') return;
    if (!getSettings(id).welcome) return;

    try {
      const metadata = await sock.groupMetadata(id);
      const botIds = [sock.user?.id, sock.user?.lid].filter(Boolean);

      const participantIds = (participants || [])
        .map((participant) => {
          if (typeof participant === 'string') return participant;
          return participant?.phoneNumber || participant?.id || participant?.lid;
        })
        .filter(Boolean)
        .filter((participantJid) =>
          !botIds.some((botJid) => areJidsSameUser(participantJid, botJid))
        );

      if (!participantIds.length) return;

      await sock.sendMessage(id, {
        text:
          `👋 *Bem-vindo(a) ao ${metadata.subject}!*\n\n` +
          `${participantIds.map((participantJid) => mentionLabel(participantJid)).join(', ')}\n` +
          `🎬 Leia *!regras* e use *!menu* para conhecer a Edith l.\n` +
          `👥 Agora somos *${metadata.participants.length} membros*.`,
        mentions: participantIds
      });
    } catch (error) {
      console.error('Falha nas boas-vindas:', error?.message || error);
    }
  });


  sock.ev.on('call', async (calls) => {
    for (const call of calls || []) {
      try {
        await handleGroupAntiCall(sock, call);
      } catch (error) {
        console.error('Erro no listener AntiCall:', error?.message || error);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      if (isDuplicateMessage(msg)) continue;

      const jid = msg.key.remoteJid;
      if (!jid) continue;

      trackActivity(jid, msg);

      if (await handleAntiFlood(sock, jid, msg)) continue;

      const text = getText(msg.message);
      if (!text) continue;

      if (await handleAntiLink(sock, jid, text, msg)) continue;
      if (await handleQuizAnswer(sock, jid, text, msg)) continue;

      if (text.trim().toLowerCase() === 'take') {
        registerCommandUsage('take');
        await handleTake(sock, jid, msg);
        continue;
      }

      if (!text.startsWith(config.prefix)) continue;

      const { command, args } = parseCommand(text);
      if (!command) continue;

      registerCommandUsage(command);

      if (isNoxCommand(command)) {
        await handleNoxCommand(sock, jid, msg, command, args);
        continue;
      }

      switch (command) {
        case 'menu':
        case 'ajuda':
          await send(sock, jid, menuText(), msg);
          break;

        case 'menuadm':
        case 'adm': {
          const info = await requireGroupAdmin(sock, jid, msg);
          if (!info) break;
          await send(sock, jid, adminMenuText(), msg);
          break;
        }

        case 'ping': {
          const rawTimestamp = Number(msg.messageTimestamp || 0);
          const sentAtMs = rawTimestamp > 0 ? rawTimestamp * 1000 : Date.now();
          const latency = Math.max(0, Date.now() - sentAtMs);

          await send(
            sock,
            jid,
            `🏓 *Pong!*\n⚡ Velocidade: *${latency} ms*\n🤖 Edith l está online.`,
            msg
          );
          break;
        }

        case 's':
          await sendSticker(sock, jid, msg, args);
          break;

        case 'toimg':
          await sendToImage(sock, jid, msg);
          break;

        case 'tomp3':
          await sendToMp3(sock, jid, msg);
          break;

        case 'tiktok':
        case 'tktk':
          await sendSocialVideo(sock, jid, msg, args, 'tiktok');
          break;

        case 'instagram':
          await sendSocialVideo(sock, jid, msg, args, 'instagram');
          break;

        case 'perfil':
          await showProfile(sock, jid, msg, args);
          break;

        case 'status':
          await sendStatus(sock, jid, msg);
          break;

        case 'config':
          await showConfig(sock, jid, msg);
          break;

        case 'atividade':
          await showActivity(sock, jid, msg);
          break;

        case 'ranking':
          await showRanking(sock, jid, msg);
          break;

        case 'membros':
          await showMembers(sock, jid, msg);
          break;

        case 'linkgrupo':
          await sendGroupLink(sock, jid, msg);
          break;

        case 'setdesc':
          await setGroupDescription(sock, jid, msg, args);
          break;

        case 'ban':
          await banMember(sock, jid, msg);
          break;

        case 'banc':
          await banCommunityMember(sock, jid, msg);
          break;

        case 'adv':
          await warnMember(sock, jid, msg, args);
          break;

        case 'remadv':
        case 'desadv':
          await removeWarning(sock, jid, msg);
          break;

        case 'advs':
          await showWarnings(sock, jid, msg);
          break;

        case 'limparadv':
          await clearWarnings(sock, jid, msg);
          break;

        case 'logs':
          await showAdminLogs(sock, jid, msg);
          break;

        case 'limparlogs':
          await clearAdminLogs(sock, jid, msg);
          break;

        case 'promover':
          await changeAdminRole(sock, jid, msg, 'promote');
          break;

        case 'rebaixar':
          await changeAdminRole(sock, jid, msg, 'demote');
          break;

        case 'admins':
          await listAdmins(sock, jid, msg);
          break;

        case 'fechar':
          await setGroupChatState(sock, jid, msg, false);
          break;

        case 'abrir':
          await setGroupChatState(sock, jid, msg, true);
          break;

        case 'antflood':
          await setAntiFlood(sock, jid, msg, args);
          break;

        case 'boasvindas':
          await setWelcome(sock, jid, msg, args);
          break;

        case 'autoaceitar':
          await setAutoApproveBrazil(sock, jid, msg, args);
          break;

        case 'anticall':
          await setAntiCall(sock, jid, msg, args);
          break;

        case 'antilink':
          await setAntiLink(sock, jid, msg, args);
          break;

        case 'regras':
          await send(sock, jid, rulesText, msg);
          break;

        case 'grupo':
          await send(sock, jid, groupText, msg);
          break;

        case 'filme':
          if (!args) {
            await send(sock, jid, `Exemplo: *${config.prefix}filme Interestelar*`, msg);
            break;
          }
          await runTmdbCommand(sock, jid, msg, () => movieInfo(args));
          break;

        case 'serie':
          if (!args) {
            await send(sock, jid, `Exemplo: *${config.prefix}serie Dark*`, msg);
            break;
          }
          await runTmdbCommand(sock, jid, msg, () => seriesInfo(args));
          break;

        case 'sinopse':
          if (!args) {
            await send(sock, jid, `Exemplo: *${config.prefix}sinopse Clube da Luta*`, msg);
            break;
          }
          await runTmdbCommand(sock, jid, msg, () => synopsis(args));
          break;

        case 'nota':
          if (!args) {
            await send(sock, jid, `Exemplo: *${config.prefix}nota Parasita*`, msg);
            break;
          }
          await runTmdbCommand(sock, jid, msg, () => rating(args));
          break;

        case 'elenco':
          if (!args) {
            await send(sock, jid, `Exemplo: *${config.prefix}elenco Batman*`, msg);
            break;
          }
          await runTmdbCommand(sock, jid, msg, () => cast(args));
          break;

        case 'trailer':
          if (!args) {
            await send(sock, jid, `Exemplo: *${config.prefix}trailer Oppenheimer*`, msg);
            break;
          }
          await runTmdbCommand(sock, jid, msg, () => trailer(args));
          break;

        case 'ondeassistir':
          if (!args) {
            await send(sock, jid, `Exemplo: *${config.prefix}ondeassistir Duna*`, msg);
            break;
          }
          await runTmdbCommand(sock, jid, msg, () => watchProviders(args));
          break;

        case 'emcartaz':
          await runTmdbCommand(sock, jid, msg, nowPlaying);
          break;

        case 'lancamentos':
          await runTmdbCommand(sock, jid, msg, upcoming);
          break;

        case 'topfilmes':
          await runTmdbCommand(sock, jid, msg, topMovies);
          break;

        case 'topseries':
          await runTmdbCommand(sock, jid, msg, topSeries);
          break;

        case 'recomendar':
          if (!args) {
            await send(sock, jid, `Exemplo: *${config.prefix}recomendar ficção científica*`, msg);
            break;
          }
          try {
            const result = await recommend(args);
            if (result?.error === 'GENRE') {
              await send(sock, jid, '🎭 Gênero não reconhecido. Exemplos: ação, aventura, comédia, drama, fantasia, terror, romance, suspense, animação, documentário ou ficção científica.', msg);
              break;
            }
            await send(sock, jid, result?.text || 'Não encontrei recomendações agora.', msg);
          } catch (error) {
            await send(sock, jid, tmdbErrorMessage(error), msg);
          }
          break;

        case 'quiz': {
          const quiz = randomItem(quizzes);
          pendingQuiz.set(jid, quiz);
          await send(
            sock,
            jid,
            `🎲 *QUIZ CINE LOUNGE*\n\n${quiz.question}\n\n${quiz.options.join('\n')}\n\nResponda somente com *A*, *B*, *C* ou *D*.`,
            msg
          );
          break;
        }

        case 'duelo': {
          const [left, right] = args.split('|').map((item) => item?.trim()).filter(Boolean);
          if (!left || !right) {
            await send(sock, jid, `Exemplo: *${config.prefix}duelo Interestelar | Matrix*`, msg);
            break;
          }

          await send(
            sock,
            jid,
            `⚔️ *DUELO DE FILMES*\n\n🎬 A: *${left}*\n🎬 B: *${right}*\n\nQual vence? Responda com *A* ou *B* e diga o motivo.`,
            msg
          );
          break;
        }

        case 'avaliar': {
          const match = args.match(/^(.*)\s+(10(?:\.0)?|[0-9](?:\.\d)?)$/);
          if (!match) {
            await send(sock, jid, `Exemplo: *${config.prefix}avaliar Interestelar 9.5*`, msg);
            break;
          }

          const title = match[1].trim();
          const score = Number(match[2]);
          if (!title || score < 0 || score > 10) {
            await send(sock, jid, 'A nota precisa estar entre *0 e 10*.', msg);
            break;
          }

          const key = `${jid}:${title.toLowerCase()}`;
          ratings.set(key, { title, score, updatedAt: Date.now() });
          await send(sock, jid, `⭐ Avaliação registrada: *${title}* — *${score}/10*`, msg);
          break;
        }

        case 'bug':
          if (!args) {
            await send(sock, jid, `Exemplo: *${config.prefix}bug o comando quiz não respondeu*`, msg);
            break;
          }
          console.log(`[BUG] jid=${jid} relato=${args}`);
          await send(sock, jid, '🐞 Relato recebido. Obrigado por avisar!', msg);
          break;

        default:
          await send(
            sock,
            jid,
            `Comando *${config.prefix}${command}* ainda não foi ativado. Use *${config.prefix}menu*.`,
            msg
          );
      }
    }
  });
}

startEdith().catch((error) => {
  console.error('Falha ao iniciar Edith l:', error);
  process.exit(1);
});
