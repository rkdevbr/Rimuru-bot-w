import { readFile, writeFile } from 'node:fs/promises';

const indexPath = new URL('../src/index.js', import.meta.url);
const runtimePath = new URL('../dist/v2/runtime.js', import.meta.url);

let indexSource = await readFile(indexPath, 'utf8');
let runtimeSource = await readFile(runtimePath, 'utf8');

// 1) Em grupo não autorizado, o runtime V2 deve bloquear membros comuns,
// mas nunca engolir os comandos enviados por um dono.
const runtimeNewGate = 'if (isGroup && !ctx.isGroupAllowed && !ctx.isOwner)\n        return true;';
const runtimeOldGatePattern = /if\s*\(\s*isGroup\s*&&\s*!ctx\.isGroupAllowed\s*\)\s*return\s+true\s*;/u;
const runtimeNewGatePattern = /if\s*\(\s*isGroup\s*&&\s*!ctx\.isGroupAllowed\s*&&\s*!ctx\.isOwner\s*\)\s*return\s+true\s*;/u;

if (runtimeOldGatePattern.test(runtimeSource)) {
  runtimeSource = runtimeSource.replace(runtimeOldGatePattern, runtimeNewGate);
} else if (!runtimeNewGatePattern.test(runtimeSource)) {
  throw new Error('[ROUTING FIX] Gate V2 de grupo não encontrado.');
}

// 2) O comando TAKE é oficialmente sem prefixo, mas também aceita o prefixo atual.
// Em grupos não autorizados, apenas dono pode usar até o TAKE sem prefixo.
const ownerGateOld = `        const ownerPrefix = text ? getCommandPrefix(text) : '';
        const ownerCanUseCommand = ownerPrefix && messageOwner;`;
const ownerGateNew = `        const ownerPrefix = text ? getCommandPrefix(text) : '';
        const ownerTake = String(text || '').trim().toLowerCase() === 'take';
        const ownerCanUseCommand = (ownerPrefix || ownerTake) && messageOwner;`;

if (indexSource.includes(ownerGateOld)) {
  indexSource = indexSource.replace(ownerGateOld, ownerGateNew);
} else if (!indexSource.includes('const ownerTake =')) {
  throw new Error('[ROUTING FIX] Gate final de dono não encontrado.');
}

const prefixGate = '      if (!getCommandPrefix(text)) continue;';
const takeBlock = `      // TAKE_PREFIXLESS_ROUTING_V1
      if (text.trim().toLowerCase() === 'take') {
        if (!jid.endsWith('@g.us') && !messageOwner && !messageVip) {
          await send(
            sock,
            jid,
            '💎 *ACESSO VIP NECESSÁRIO*\\n\\nNo PV, o comando *take* é exclusivo para donos e VIPs ativos.\\nUse *' + config.prefix + 'vip* para ver o plano.',
            msg
          );
          continue;
        }

        registerCommandUsage('take');
        await handleTake(sock, jid, msg);
        continue;
      }

`;

if (!indexSource.includes('TAKE_PREFIXLESS_ROUTING_V1')) {
  if (!indexSource.includes(prefixGate)) {
    throw new Error('[ROUTING FIX] Gate de prefixo não encontrado.');
  }
  indexSource = indexSource.replace(prefixGate, takeBlock + prefixGate);
}

// BANC_ROUTE_PRESERVE_V1
// O !banc é injetado no src/index.js antes deste patch de roteamento.
// Não altere/remova o case 'banc' ao aplicar os ajustes abaixo.
if (!indexSource.includes("case 'banc':")) {
  throw new Error('[ROUTING FIX] Comando !banc ausente antes do roteamento final.');
}

// 3) O start antigo transformava o default do roteador em silêncio.
// Recupera um retorno claro para qualquer comando inexistente digitado com o prefixo correto.
if (!indexSource.includes('COMMAND_NOT_FOUND_FEEDBACK_V1')) {
  const silentDefault = `        default:
          break;`;
  const oldDefault = `        default:
          await send(
            sock,
            jid,
            \`Comando *\${config.prefix}\${command}* ainda não foi ativado. Use *\${config.prefix}menu*.\`,
            msg
          );`;
  const feedbackDefault = `        default:
          // COMMAND_NOT_FOUND_FEEDBACK_V2
          // Grupo não autorizado: membro comum deve ficar em silêncio; dono mantém acesso.
          if (jid.endsWith('@g.us') && !isGroupAllowed && !messageOwner) break;
          await send(
            sock,
            jid,
            \`❓ *COMANDO NÃO ENCONTRADO*\\n\\nO comando *\${config.prefix}\${command}* não existe ou foi digitado errado.\\nUse *\${config.prefix}menu* para ver os comandos disponíveis.\`,
            msg
          );`;

  const silentIndex = indexSource.lastIndexOf(silentDefault);
  if (silentIndex !== -1) {
    indexSource =
      indexSource.slice(0, silentIndex) +
      feedbackDefault +
      indexSource.slice(silentIndex + silentDefault.length);
  } else if (indexSource.includes(oldDefault)) {
    indexSource = indexSource.replace(oldDefault, feedbackDefault);
  } else {
    throw new Error('[ROUTING FIX] Default do roteador de comandos não encontrado.');
  }
}

await writeFile(runtimePath, runtimeSource, 'utf8');
await writeFile(indexPath, indexSource, 'utf8');

console.log('[ROUTING FIX] TAKE sem prefixo + TAKE com prefixo + feedback de comando inválido aplicados.');
