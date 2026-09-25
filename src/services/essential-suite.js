import { isProUser } from '../pro.js';
import { isVipUser } from '../vip.js';
import { initEssentialState, essentialUser, essentialUserKey, recordEssentialCommand, usageAllowed } from './essential-state.js';
import { ESSENTIAL_MEDIA_COMMANDS, handleEssentialMedia } from './essential-media.js';
import { ESSENTIAL_AI_COMMANDS, handleEssentialAi } from './essential-ai.js';
import { ESSENTIAL_UTILITY_COMMANDS, handleEssentialUtility } from './essential-utils.js';
import { ESSENTIAL_GROUP_COMMANDS, handleEssentialGroup, observeEssentialMessage as observeGroupMessage, handleEssentialParticipantUpdate as participantGroupUpdate } from './essential-groups.js';
import { ESSENTIAL_ENTERTAINMENT_COMMANDS, handleEssentialEntertainment } from './essential-entertainment.js';
import { ESSENTIAL_COMMERCE_COMMANDS, handleEssentialCommerce } from './essential-commerce.js';

const GATE_ONLY_COMMANDS = new Set(['inativos', 'limpargrupo']);

// Removidos do VIP: dependiam de APIs externas, eram entretenimento
// ou podiam alterar/remover conteúdo do grupo de forma ampla.
const REMOVED_VIP_COMMANDS = new Set([
  'resumiraudio', 'imagem', 'analisar', 'pdfia', 'ocr', 'semfundo',
  'seguiranime', 'listafilmes',
  'automod', 'limpargrupo', 'restaurargrupo', 'personalizarbot',
  'meuslimites'
]);

const VIP_COMMANDS = new Set([
  'hd', 'melhorar', 'semfundo', 'stickerhd', 'stickerpack', 'marca', 'stickergif',
  'resumiraudio', 'imagem', 'analisar', 'pdfia', 'flashcards', 'salvarlink', 'pixqr',
  'ocr', 'compararpreco', 'seguiranime', 'listafilmes', 'tagativos', 'inativos',
  'relatorio', 'historico', 'limpargrupo', 'automod', 'backupgrupo', 'restaurargrupo',
  'personalizarbot', 'ddd'
]);

const PUBLIC_PRIVATE_COMMANDS = new Set([
  'planos', 'assinar', 'pix', 'pagamento', 'cupom', 'teste', 'indicar', 'creditos',
  'comprarcreditos', 'upgrade', 'renovar', 'presentear'
]);

const FREE_AI_COMMANDS = new Set(['ia', 'resumir', 'explicar', 'corrigir', 'traduzir', 'transcrever', 'estudar', 'redacao', 'recomendaranime', 'comparar', 'curiosidade']);
const FREE_MEDIA_COMMANDS = new Set(['compress', 'audio', 'mp3', 'gif', 'removeaudio', 'scan', 'pdf', 'stickertexto', 'stickeremoji']);

export const ESSENTIAL_COMMANDS = new Set([
  ...ESSENTIAL_MEDIA_COMMANDS,
  ...ESSENTIAL_AI_COMMANDS,
  ...ESSENTIAL_UTILITY_COMMANDS,
  ...ESSENTIAL_GROUP_COMMANDS,
  ...ESSENTIAL_ENTERTAINMENT_COMMANDS,
  ...ESSENTIAL_COMMERCE_COMMANDS,
  ...GATE_ONLY_COMMANDS
]);

export function isEssentialCommand(command = '') {
  return ESSENTIAL_COMMANDS.has(String(command).toLowerCase());
}

export async function initEssentialSuite(authDir) {
  await initEssentialState(authDir);
  console.log('[ESSENTIAL] Free/VIP command suite initialized.');
}

async function send(sock, jid, msg, text) {
  await sock.sendMessage(jid, { text }, { quoted: msg });
}

async function resolveAccess(sock, msg, isOwner, hintedVip = false) {
  if (isOwner) return { tier: 'vip', isVip: true };

  // Compatibilidade silenciosa: antigos usuários PRO continuam recebendo
  // acesso VIP até a expiração do registro legado, sem existir um plano PRO novo.
  const legacyPro = await isProUser(sock, msg);
  const vip = hintedVip || legacyPro || await isVipUser(sock, msg);
  return { tier: vip ? 'vip' : 'free', isVip: vip };
}

export async function observeEssentialMessage(input) {
  return observeGroupMessage(input);
}

export async function handleEssentialParticipantUpdate(input) {
  return participantGroupUpdate(input);
}

export async function handleEssentialCommand(input) {
  const command = String(input.command || '').toLowerCase();
  if (!isEssentialCommand(command)) return false;

  // Consome silenciosamente comandos retirados para impedir que módulos
  // legados/V2 executem versões antigas deles depois desta camada.
  if (REMOVED_VIP_COMMANDS.has(command)) return true;

  // Preserva o comando !evento do RPG. O módulo de grupos só assume subcomandos de evento explícitos.
  if (command === 'evento' && !/^(criar|listar|status|remover|cancelar|del)\b/i.test(String(input.args || '').trim())) return false;

  const { sock, jid, msg, args = '', isOwner = false, isGroupAllowed = true } = input;
  if (jid.endsWith('@g.us') && !isGroupAllowed && !isOwner) return true;

  const access = await resolveAccess(sock, msg, isOwner, Boolean(input.isVip));
  const userKey = await essentialUserKey(sock, msg);
  const user = essentialUser(userKey);
  const ctx = { ...input, command, args, userKey, user, isVip: access.isVip, tier: access.tier };

  if (!jid.endsWith('@g.us') && access.tier === 'free' && !PUBLIC_PRIVATE_COMMANDS.has(command)) {
    await send(sock, jid, msg, '💎 *ACESSO VIP NECESSÁRIO*\n\nNo privado, os recursos da Rimuru são liberados para VIP. Use *!planos* para ver o plano.');
    return true;
  }

  if (VIP_COMMANDS.has(command) && access.tier !== 'vip') {
    await send(
      sock,
      jid,
      msg,
      `💎 *RECURSO VIP*\n\nO comando *!${command}* é exclusivo do VIP. Use *!planos* para ver os benefícios.`
    );
    return true;
  }

  if (access.tier === 'free' && FREE_AI_COMMANDS.has(command) && !usageAllowed(userKey, 'free_ai', 5)) {
    await send(sock, jid, msg, '⏳ Você atingiu o limite FREE de *5 usos de IA por dia*. VIP possui limite muito maior. Use *!planos*.');
    return true;
  }

  if (access.tier === 'free' && FREE_MEDIA_COMMANDS.has(command) && !usageAllowed(userKey, 'free_media', 15)) {
    await send(sock, jid, msg, '⏳ Você atingiu o limite FREE de *15 processamentos de mídia por dia*. Use *!planos* para aumentar o limite.');
    return true;
  }

  recordEssentialCommand(userKey, command);

  // Gate-only: a implementação existente do V2 continua sendo usada depois que o VIP é validado.
  if (GATE_ONLY_COMMANDS.has(command)) return false;

  if (ESSENTIAL_COMMERCE_COMMANDS.has(command)) return handleEssentialCommerce(ctx);
  if (ESSENTIAL_MEDIA_COMMANDS.has(command)) return handleEssentialMedia(ctx);
  if (ESSENTIAL_AI_COMMANDS.has(command)) return handleEssentialAi(ctx);
  if (ESSENTIAL_UTILITY_COMMANDS.has(command)) return handleEssentialUtility(ctx);
  if (ESSENTIAL_ENTERTAINMENT_COMMANDS.has(command)) return handleEssentialEntertainment(ctx);
  if (ESSENTIAL_GROUP_COMMANDS.has(command)) return handleEssentialGroup(ctx);
  return false;
}
