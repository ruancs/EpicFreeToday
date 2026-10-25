import cron from 'node-cron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getFreeGames } from './epicgamesbot.js';

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
const HOJE_CACHE_MS = 5 * 60 * 1000; // /hoje repetido não precisa bater na Epic toda vez
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
  updateJson(HISTORY_FILE, {}, (history) => ({
    ...history,
    [key]: { fetchedAt: new Date().toISOString(), ...games },
  }));

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
  const games = await getFreeGames({ locale: LOCALE, country: COUNTRY });
  await saveDay(key, games);
  Object.assign(todayCache, { key, at: Date.now(), games });
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

function caption(game) {
  const when =
    game.status === 'current'
      ? `Grátis até ${fmtWhen(game.endDate)}`
      : `Grátis de ${fmtWhen(game.startDate)} até ${fmtWhen(game.endDate)}`;
  const price = game.originalPrice ? ` (de ${esc(game.originalPrice)})` : '';
  return `<b>${esc(game.title)}</b>\n${when}${price}\n<a href="${esc(game.url)}">Abrir na Epic</a>`;
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
  const { current = [], upcoming = [] } = entry;
  await sendText(chatId, `🎮 <b>Jogos grátis da Epic — ${fmtDay(key)}</b>`);
  if (current.length === 0) await sendText(chatId, 'Nenhum jogo grátis neste dia.');
  for (const game of current) await sendGame(chatId, game);
  if (upcoming.length > 0) {
    await sendText(chatId, '⏭ <b>Em breve</b>');
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
    await broadcast((chatId) => sendText(chatId, `⚠️ Não consegui consultar a Epic hoje: ${esc(error.message)}`));
  }
}

// ---------- comandos do bot ----------

const HELP = [
  '🎮 <b>Jogos grátis da Epic</b>',
  'Eu mando os jogos grátis todo dia às 10:00 da manhã (Brasília).',
  '',
  '/stop — parar de receber o envio diário',
  '/hoje — consulta a Epic agora',
  '/historico — dias já registrados',
  '/dia ontem — ou /dia 29/10, /dia 2026-10-29',
].join('\n');

async function showDay(chatId, key) {
  const history = await loadHistory();
  if (!history[key]) return sendText(chatId, `Sem registro para ${fmtDay(key)}. Veja /historico.`);
  return sendDay(chatId, key, history[key]);
}

async function showHistory(chatId) {
  const days = Object.keys(await loadHistory()).sort().reverse().slice(0, HISTORY_BUTTONS);
  if (days.length === 0) return sendText(chatId, 'Ainda não há histórico. Use /hoje.');
  const buttons = days.map((key) => ({ text: fmtDay(key).slice(0, 5), callback_data: `day:${key}` }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
  return sendText(chatId, '📅 Escolha um dia:', { reply_markup: { inline_keyboard: rows } });
}

async function handleCommand(chatId, text, from) {
  const [rawCommand, ...rest] = text.trim().split(/\s+/);
  const command = rawCommand.toLowerCase().replace(/@.*$/, ''); // /hoje@meubot -> /hoje
  const arg = rest.join(' ');

  switch (command) {
    case '/start': {
      if (await subscribe(chatId)) log(`novo inscrito: ${chatId} (${from?.first_name ?? '?'})`);
      return sendText(chatId, `✅ Inscrição feita! Você vai receber os jogos grátis todo dia às 10:00.\n\n${HELP}`);
    }
    case '/stop': {
      const removed = await unsubscribe(chatId);
      if (removed) log(`inscrição cancelada: ${chatId}`);
      return sendText(chatId, removed ? 'Pronto, você não vai mais receber o envio diário. /start para voltar.' : 'Você não estava inscrito. /start para se inscrever.');
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
      if (!key) return sendText(chatId, 'Use: /dia ontem, /dia 29/10 ou /dia 2026-10-29');
      return showDay(chatId, key);
    }
    default:
      return sendText(chatId, 'Não entendi. Veja /ajuda.');
  }
}

async function handleUpdate(update) {
  const callback = update.callback_query;
  const chatId = String(callback?.message?.chat.id ?? update.message?.chat.id ?? '');
  if (!chatId) return;

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
    await sendText(chatId, `⚠️ Deu erro: ${esc(error.message)}`).catch(() => {});
  }
}

let running = true;

async function pollUpdates() {
  let offset = 0;
  while (running) {
    try {
      const updates = await tg(
        'getUpdates',
        { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] },
        45_000,
      );
      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (error) {
      if (!running) break;
      log('getUpdates falhou, tentando de novo em 5s:', error.message);
      await sleep(5000);
    }
  }
}

// ---------- main ----------

async function main() {
  if (!TOKEN && !DRY) {
    console.error('Defina TELEGRAM_BOT_TOKEN no .env (ou use --dry para testar sem Telegram).');
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
      { command: 'hoje', description: 'Consulta a Epic agora' },
      { command: 'historico', description: 'Dias já registrados' },
      { command: 'dia', description: 'Ver um dia: /dia ontem ou /dia 29/10' },
      { command: 'ajuda', description: 'Ajuda' },
    ],
  });

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
