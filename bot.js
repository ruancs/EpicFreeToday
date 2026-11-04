import cron from 'node-cron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ALL_SOURCES, SOURCE_LABELS, getAllGames } from './games.js';
import { DEFAULT_BASE_URL } from './lootscraper.js';

try {
  process.loadEnvFile(join(import.meta.dirname, '.env'));
} catch {
  // sem .env: usa só as variáveis do ambiente
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org';
const CRON_SCHEDULE = process.env.CRON_SCHEDULE ?? '0 10 * * *';
const HISTORY_FILE = process.env.HISTORY_FILE ?? join(import.meta.dirname, 'data', 'history.json');
const SUBSCRIBERS_FILE =
  process.env.SUBSCRIBERS_FILE ?? join(import.meta.dirname, 'data', 'subscribers.json');
const HOJE_CACHE_MS = 5 * 60 * 1000; // /hoje repetido não precisa bater nas fontes toda vez
// SOURCES=epic,steam,amazon deixa desligar uma fonte sem mexer no código
const SOURCES = (process.env.SOURCES ?? ALL_SOURCES.join(','))
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const LOOTSCRAPER_BASE_URL = process.env.LOOTSCRAPER_BASE_URL ?? DEFAULT_BASE_URL;
const TZ = 'America/Sao_Paulo';
const LOCALE = 'pt-BR';
const COUNTRY = 'BR';
const HISTORY_BUTTONS = 14;

const ONCE = process.argv.includes('--once');
const DRY = process.argv.includes('--dry'); // imprime no console em vez de mandar ao Telegram

const log = (...args) => console.log(new Date().toISOString(), ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// ---------- datas (sempre no fuso de Brasília) ----------

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }); // YYYY-MM-DD
const whenFormat = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const dayKey = (date = new Date()) => dayFormat.format(date);

function fmtWhen(iso) {
  const p = Object.fromEntries(whenFormat.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month} às ${p.hour}:${p.minute}`;
}

const fmtDay = (key) => key.split('-').reverse().join('/');

// Data aproximada (Amazon): o feed dá "2026-11-04 00:00" UTC, que é um palpite. Converter
// para Brasília daria "03/11 21:00", uma precisão que não existe, então mostramos só o dia em UTC.
const fmtApproxDay = (iso) => iso.slice(0, 10).split('-').reverse().join('/');

/** Aceita: ontem | AAAA-MM-DD | DD/MM | DD/MM/AAAA. Devolve AAAA-MM-DD ou null. */
function parseDayArg(arg) {
  const text = arg.trim().toLowerCase();
  if (text === 'ontem') return dayKey(new Date(Date.now() - 24 * 3600 * 1000));
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const m = text.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
  if (!m) return null;
  const year = m[3] ?? dayKey().slice(0, 4);
  return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// ---------- armazenamento (arquivos JSON em data/) ----------

let fileLock = Promise.resolve(); // evita corrida entre o cron e comandos simultâneos

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

/** Lê, aplica `mutate` (devolve o novo valor) e regrava, um de cada vez. */
function updateJson(file, fallback, mutate) {
  const run = fileLock.then(async () => {
    const next = mutate(await readJson(file, fallback));
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2));
    await rename(tmp, file); // troca atômica: nunca deixa o arquivo pela metade
  });
  fileLock = run.catch(() => {});
  return run;
}

// histórico: um registro por dia, chaveado por AAAA-MM-DD
const loadHistory = () => readJson(HISTORY_FILE, {});

const saveDay = (key, games) =>
  updateJson(HISTORY_FILE, {}, (history) => {
    // Um resultado parcial (fonte fora do ar) não sobrescreve um registro mais completo do dia.
    const previous = history[key];
    const failed = (g) => g?.failedSources?.length ?? 0;
    if (previous && failed(games) > failed(previous)) return history;
    return { ...history, [key]: { fetchedAt: new Date().toISOString(), ...games } };
  });

// inscritos: lista de chat ids que recebem o envio diário
const loadSubscribers = () => readJson(SUBSCRIBERS_FILE, []);

async function subscribe(chatId) {
  let added = false;
  await updateJson(SUBSCRIBERS_FILE, [], (list) => {
    added = !list.includes(chatId);
    return added ? [...list, chatId] : list;
  });
  return added;
}

async function unsubscribe(chatId) {
  let removed = false;
  await updateJson(SUBSCRIBERS_FILE, [], (list) => {
    removed = list.includes(chatId);
    return list.filter((id) => id !== chatId);
  });
  return removed;
}

const todayCache = { key: null, at: 0, games: null };

async function refreshToday({ maxAgeMs = 0 } = {}) {
  const key = dayKey();
  if (todayCache.key === key && Date.now() - todayCache.at < maxAgeMs) return todayCache.games;
  const games = await getAllGames({
    sources: SOURCES,
    locale: LOCALE,
    country: COUNTRY,
    lootscraperBaseUrl: LOOTSCRAPER_BASE_URL,
    log,
  });
  await saveDay(key, games);
  // resultado parcial não entra no cache: o próximo /hoje deve tentar de novo
  if (games.failedSources.length === 0) Object.assign(todayCache, { key, at: Date.now(), games });
  return games;
}

// ---------- Telegram ----------

async function tg(method, body = {}, timeoutMs = 15_000) {
  const res = await fetch(`${API}/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => null);
  if (!json?.ok) throw new Error(`Telegram ${method}: ${json?.description ?? `HTTP ${res.status}`}`);
  return json.result;
}

async function sendText(chatId, html, extra = {}) {
  if (DRY) return console.log(`\n[${chatId}] ${html.replace(/<[^>]+>/g, '')}`);
  await tg('sendMessage', {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

const labelOf = (source) => SOURCE_LABELS[source ?? 'epic'] ?? source; // registros antigos não têm `source`

function whenText(game) {
  if (game.status === 'upcoming') return `grátis de ${fmtWhen(game.startDate)} até ${fmtWhen(game.endDate)}`;
  if (!game.endDate) return 'grátis (sem data de término informada)';
  if (game.endApprox) return `grátis até ~${fmtApproxDay(game.endDate)} (data aproximada)`;
  return `grátis até ${fmtWhen(game.endDate)}`;
}

function caption(game) {
  const label = labelOf(game.source);
  // jogo free-to-play vem com preço "0": "(de 0)" não informa nada
  const price = /[1-9]/.test(game.originalPrice ?? '') ? ` (de ${esc(game.originalPrice)})` : '';
  const lines = [`<b>${esc(game.title)}</b>`, `${esc(label)} — ${whenText(game)}${price}`];
  if (game.requires) lines.push(`Requer ${esc(game.requires)}`);
  if (game.alsoIn?.length) lines.push(`Também em: ${game.alsoIn.map((s) => esc(labelOf(s))).join(', ')}`);
  lines.push(`<a href="${esc(game.url)}">Abrir em ${esc(label)}</a>`);
  return lines.join('\n');
}

async function sendGame(chatId, game) {
  const text = caption(game);
  if (DRY) return console.log(`\n[${chatId}] 🖼  ${game.image}\n${text.replace(/<[^>]+>/g, '')}`);
  if (game.image) {
    try {
      await tg('sendPhoto', { chat_id: chatId, photo: game.image, caption: text, parse_mode: 'HTML' });
      return;
    } catch (error) {
      log(`sendPhoto falhou para "${game.title}", mandando só texto:`, error.message);
    }
  }
  await sendText(chatId, text);
}

async function sendDay(chatId, key, entry) {
  const { current = [], upcoming = [], failedSources = [] } = entry;
  await sendText(chatId, `🎁 <b>Hora do grátis! — ${fmtDay(key)}</b>`);
  if (failedSources.length > 0) {
    // sem o aviso, um resumo sem jogos da Steam pareceria "não há nada hoje"
    const names = failedSources.map((s) => esc(labelOf(s))).join(', ');
    await sendText(chatId, `🙈 Não consegui falar com: ${names}. A lista pode estar incompleta, não me culpem.`);
  }
  if (current.length === 0) await sendText(chatId, '🦗 Nenhum jogo grátis neste dia. Só grilos por aqui.');
  for (const game of current) await sendGame(chatId, game);
  if (upcoming.length > 0) {
    await sendText(chatId, '⏭ <b>Vem aí (anota na agenda)</b>');
    for (const game of upcoming) await sendGame(chatId, game);
  }
}

async function broadcast(fn) {
  const targets = DRY ? ['dry'] : await loadSubscribers();
  if (targets.length === 0) log('Nenhum inscrito ainda: mande /start ao bot para se cadastrar.');
  for (const chatId of targets) {
    try {
      await fn(chatId);
    } catch (error) {
      log(`falha ao enviar para ${chatId}:`, error.message);
      // quem bloqueou o bot ou saiu do grupo não deve ficar na lista
      if (/Forbidden|chat not found/i.test(error.message)) {
        await unsubscribe(chatId);
        log(`${chatId} removido dos inscritos`);
      }
    }
  }
}

async function dailyJob() {
  log('Rodando a verificação diária...');
  try {
    const games = await refreshToday();
    await broadcast((chatId) => sendDay(chatId, dayKey(), games));
    log(`OK: ${games.current.length} grátis agora, ${games.upcoming.length} em breve.`);
  } catch (error) {
    log('ERRO na verificação diária:', error);
    await broadcast((chatId) => sendText(chatId, `💥 Tropecei ao consultar as lojas hoje: ${esc(error.message)}`));
  }
}

// ---------- comandos do bot ----------

const HELP = [
  '🎮 <b>O que eu sei fazer</b>',
  `Todo dia às 10:00 (Brasília) eu farejo ${SOURCES.map(labelOf).join(', ')} e te entrego o que está de graça.`,
  '',
  '/hoje — fareja as lojas agora mesmo',
  '/historico — o que já achei nos outros dias',
  '/dia ontem — ou /dia 29/10, /dia 2026-10-29',
  '/stop — pede para eu sumir (sem ressentimentos)',
].join('\n');

const WELCOME = [
  '🌽 <b>Bem-vindo ao Bot Catamilho Games!</b>',
  'Eu cato os jogos que estão de graça e te aviso antes que a promoção acabe. Você já está na lista: todo dia às 10:00 eu apareço por aqui.',
].join('\n');

async function showDay(chatId, key) {
  const history = await loadHistory();
  if (!history[key]) return sendText(chatId, `📭 Não guardei nada de ${fmtDay(key)}. Dá uma olhada no /historico.`);
  return sendDay(chatId, key, history[key]);
}

async function showHistory(chatId) {
  const days = Object.keys(await loadHistory()).sort().reverse().slice(0, HISTORY_BUTTONS);
  if (days.length === 0) return sendText(chatId, '📭 Meu caderninho ainda está vazio. Manda um /hoje para eu começar a anotar.');
  const buttons = days.map((key) => ({ text: fmtDay(key).slice(0, 5), callback_data: `day:${key}` }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
  return sendText(chatId, '📅 Escolha um dia (viagem no tempo, versão grátis):', { reply_markup: { inline_keyboard: rows } });
}

async function handleCommand(chatId, text, from) {
  const [rawCommand, ...rest] = text.trim().split(/\s+/);
  const command = rawCommand.toLowerCase().replace(/@.*$/, ''); // /hoje@meubot -> /hoje
  const arg = rest.join(' ');

  switch (command) {
    case '/start': {
      if (!(await subscribe(chatId))) {
        log(`/start de quem já está inscrito: ${chatId} (${from?.first_name ?? '?'})`);
        return sendText(
          chatId,
          '😏 Calma, você já está na lista! Não esqueci de você.\n' +
            'Os jogos grátis chegam todo dia às 10:00. Se a ansiedade bater, manda /hoje. /ajuda mostra o resto.',
        );
      }
      log(`novo inscrito: ${chatId} (${from?.first_name ?? '?'})`);
      return sendText(chatId, `${WELCOME}\n\n${HELP}`);
    }
    case '/stop': {
      const removed = await unsubscribe(chatId);
      if (removed) log(`inscrição cancelada: ${chatId}`);
      return sendText(
        chatId,
        removed
          ? '😢 Ok, parei de te mandar mensagem. Vou ficar aqui sozinho, olhando as promoções... /start se mudar de ideia.'
          : '🤔 Você nem estava na lista, não tenho o que cancelar. /start para entrar.',
      );
    }
    case '/ajuda':
    case '/help':
      return sendText(chatId, HELP);
    case '/hoje': {
      const games = await refreshToday({ maxAgeMs: HOJE_CACHE_MS });
      return sendDay(chatId, dayKey(), games);
    }
    case '/historico':
      return showHistory(chatId);
    case '/dia': {
      const key = parseDayArg(arg);
      if (!key) return sendText(chatId, '🤨 Essa data eu não entendi. Tenta: /dia ontem, /dia 29/10 ou /dia 2026-10-29');
      return showDay(chatId, key);
    }
    default:
      return sendText(chatId, '🤷 Essa eu não sei fazer. Manda /ajuda que eu mostro o que sei.');
  }
}

async function handleUpdate(update) {
  const callback = update.callback_query;
  const chatId = String(callback?.message?.chat.id ?? update.message?.chat.id ?? '');
  if (!chatId) return;
  log(`recebido do chat ${chatId}: ${callback ? `botão ${callback.data}` : (update.message?.text ?? '(sem texto)')}`);

  try {
    if (callback) {
      await tg('answerCallbackQuery', { callback_query_id: callback.id });
      const key = callback.data?.match(/^day:(\d{4}-\d{2}-\d{2})$/)?.[1];
      if (key) await showDay(chatId, key);
    } else if (update.message?.text?.startsWith('/')) {
      await handleCommand(chatId, update.message.text, update.message.from);
    }
  } catch (error) {
    log('erro ao tratar update:', error.message);
    await sendText(chatId, `💥 Deu ruim: ${esc(error.message)}`).catch(() => {});
  }
}

let running = true;

async function pollUpdates() {
  let offset = 0;
  let failures = 0;
  while (running) {
    try {
      const updates = await tg(
        'getUpdates',
        { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] },
        45_000,
      );
      failures = 0;
      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (error) {
      if (!running) break;
      failures++;
      // "fetch failed" não diz nada; a causa real (ECONNRESET, ETIMEDOUT, ENOTFOUND...) fica em error.cause
      const cause = error.cause?.code ?? error.cause?.message;
      const waitMs = Math.min(1000 * 2 ** (failures - 1), 30_000); // 1s, 2s, 4s... até 30s
      // uma queda isolada é normal (conexão ociosa derrubada pela rede); o contador mostra se persiste
      log(`getUpdates falhou (${failures}x): ${error.message}${cause ? ` [${cause}]` : ''}. Nova tentativa em ${waitMs / 1000}s`);
      await sleep(waitMs);
    }
  }
}

// ---------- main ----------

async function main() {
  if (!TOKEN && !DRY) {
    console.error('Defina TELEGRAM_BOT_TOKEN no .env (ou use --dry para testar sem Telegram).');
    process.exit(1);
  }

  const unknown = SOURCES.filter((s) => !ALL_SOURCES.includes(s));
  if (unknown.length > 0 || SOURCES.length === 0) {
    console.error(`SOURCES inválido (${unknown.join(', ') || 'vazio'}). Use: ${ALL_SOURCES.join(', ')}`);
    process.exit(1);
  }

  if (ONCE) {
    await dailyJob();
    return;
  }

  if (DRY) {
    console.error('--dry só funciona junto com --once.');
    process.exit(1);
  }
  if (!cron.validate(CRON_SCHEDULE)) {
    console.error(`CRON_SCHEDULE inválido: ${CRON_SCHEDULE}`);
    process.exit(1);
  }

  const me = await tg('getMe');
  await tg('deleteWebhook'); // webhook ativo bloqueia getUpdates
  await tg('setMyCommands', {
    commands: [
      { command: 'start', description: 'Se inscrever no envio diário' },
      { command: 'stop', description: 'Cancelar o envio diário' },
      { command: 'hoje', description: 'Consulta as lojas agora' },
      { command: 'historico', description: 'Dias já registrados' },
      { command: 'dia', description: 'Ver um dia: /dia ontem ou /dia 29/10' },
      { command: 'ajuda', description: 'Ajuda' },
    ],
  });

  // texto mostrado na tela inicial do bot, antes do /start; é só enfeite, então uma falha não derruba o bot
  const stores = SOURCES.map(labelOf).join(', ');
  await tg('setMyDescription', {
    description: `Bem-vindo ao Bot Catamilho Games! Todo dia às 10:00 eu aviso quais jogos estão de graça em: ${stores}. Mande /start para entrar na lista.`,
  }).catch((error) => log('setMyDescription falhou:', error.message));
  await tg('setMyShortDescription', {
    short_description: `Cata os jogos grátis de ${stores} todo dia.`,
  }).catch((error) => log('setMyShortDescription falhou:', error.message));

  cron.schedule(CRON_SCHEDULE, dailyJob, { timezone: TZ });
  const subscribers = await loadSubscribers();
  log(`Bot @${me.username} no ar. Envio diário: "${CRON_SCHEDULE}" (${TZ}). Inscritos: ${subscribers.length}`);

  const stop = () => {
    running = false;
    log('Encerrando...');
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await pollUpdates();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
