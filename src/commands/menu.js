import { config } from '../config.js';

function withPrimaryPrefix(text) {
  const prefix = String(config.prefix || '!');
  return String(text).replace(/!(?=[A-Za-zÀ-ÿ])/g, prefix);
}

export function menuText() {
  return withPrimaryPrefix(`╭━━━〔 ${config.botName} 〕━━━╮
┃ CENTRAL DE COMANDOS
┃ Prefixo atual: ${config.prefix || '!'}
╰━━━━━━━━━━━━━━━━━━━━━━━━╯

╭─〔 ✦ PAINÉIS 〕────────────────╮
┃ ◆ !adm — administração
┃ ◆ !vip — recursos premium
┃ ◆ !menuapi — pesquisas, utilidades e IA
┃ ◆ !RPG — NOX: Ecos do Último Mundo
╰──────────────────────────────╯

╭─〔 ◇ GERAL 〕──────────────────╮
┃ ◆ !menu / !ajuda
┃ ◆ !ping
┃ ◆ !status — status técnico
┃ ◆ !config — proteções ativas
┃ ◆ !regras
┃ ◆ !grupo
┃ ◆ !perfil [número]
┃ ◆ !atividade @membro
┃ ◆ !ranking
┃ ◆ !membros
╰──────────────────────────────╯

╭─〔 ◇ FIGURINHAS & MÍDIA 〕────╮
┃ ◆ !s [-str]
┃ ◆ take — sem prefixo
┃ ◆ !toimg
┃ ◆ !tomp3
┃ ◆ !tiktok link
┃ ◆ !instagram link
╰──────────────────────────────╯

╭─〔 ◇ CINEMA & SÉRIES 〕───────╮
┃ ◆ !filme nome
┃ ◆ !serie nome
┃ ◆ !recomendar tema
┃ ◆ !ondeassistir nome
┃ ◆ !lancamentos / !emcartaz
┃ ◆ !topfilmes / !topseries
┃ ◆ !trailer / !elenco / !nota / !sinopse
┃ ◆ !quiz / !duelo / !avaliar
╰──────────────────────────────╯

┌─〔 ATALHOS 〕
│ VIP → !vip
│ NOX → !RPG
│ Administração → !adm
└──────────────────────────────`);
}

export function adminMenuText() {
  return withPrimaryPrefix(`╭━━━〔 ${config.botName} • ADMIN 〕━━━╮
┃ CENTRAL DE ADMINISTRAÇÃO
┃ Gerenciamento e proteção do grupo
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯

╭─〔 ✦ MODERAÇÃO 〕──────────────╮
┃ ◆ !d — apaga a mensagem respondida
┃ ◆ !ban — remove membro
┃ ◆ !adv @membro motivo
┃ ◆ !advs @membro
┃ ◆ !remadv @membro / !desadv @membro
┃ ◆ !limparadv @membro
┃ ◆ !promover / !rebaixar
┃ ◆ !admins
╰──────────────────────────────╯

╭─〔 ✦ PROTEÇÕES 〕──────────────╮
┃ ◆ !antilink on/off/status
┃ ◆ !antflood on/off/status
┃ ◆ !anticall on/off/status
┃ ◆ !boasvindas on/off/status
┃ ◆ !autoaceitar on/off/status — somente +55
╰──────────────────────────────╯

╭─〔 ✦ CONTROLE DO GRUPO 〕─────╮
┃ ◆ !fechar / !abrir
┃ ◆ !linkgrupo
┃ ◆ !setdesc Nova descrição
┃ ◆ !streaming on/off/status
╰──────────────────────────────╯

╭─〔 ✦ REGISTROS 〕──────────────╮
┃ ◆ !logs
┃ ◆ !limparlogs
╰──────────────────────────────╯

┌─〔 ACESSO 〕
│ Abra novamente com *!adm*
└──────────────────────────────`);
}
