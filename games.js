import { getFreeGames as getEpicGames } from './epicgamesbot.js';
import { getFeedGames } from './lootscraper.js';

// Ordem = prioridade: na duplicata, vale a 1ª (Epic é grátis para todos, Luna exige Prime).
export const ALL_SOURCES = ['epic', 'steam', 'amazon'];

export const SOURCE_LABELS = {
  epic: 'Epic Games',
  steam: 'Steam',
  amazon: 'Amazon Luna (Prime)',
};

/**
 * Normaliza para comparar títulos entre lojas: "DOOM" == "Doom™" == "D.O.O.M".
 * NFD (e não NFKD) de propósito: o NFKD decompõe "™" em "TM" e o título nunca bateria.
 */
const normalizeTitle = (title) =>
  title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * Junta as fontes (já na ordem de prioridade) removendo o mesmo jogo repetido entre lojas.
 * O jogo fica na loja de maior prioridade, com `alsoIn` apontando as outras.
 */
export function mergeGames(results) {
  const byTitle = new Map();
  const current = [];
  const upcoming = [];

  for (const { games } of results) {
    for (const game of games.current) {
      const key = normalizeTitle(game.title);
      const kept = byTitle.get(key);
      if (kept) {
        if (!kept.alsoIn.includes(game.source)) kept.alsoIn.push(game.source);
        continue;
      }
      const entry = { ...game, alsoIn: [] };
      byTitle.set(key, entry);
      current.push(entry);
    }
    upcoming.push(...games.upcoming);
  }
  return { current, upcoming };
}

const defaultFetchers = ({ locale, country, lootscraperBaseUrl, now, log }) => ({
  epic: () => getEpicGames({ locale, country }, { log }),
  steam: async () => ({
    current: await getFeedGames('steam', { baseUrl: lootscraperBaseUrl, now, log }),
    upcoming: [],
  }),
  amazon: async () => ({
    current: await getFeedGames('amazon', { baseUrl: lootscraperBaseUrl, now, log }),
    upcoming: [],
  }),
});

/**
 * Consulta as fontes em paralelo. Uma fonte fora do ar não derruba as outras: ela vira
 * `failedSources` (para o resumo avisar que a lista pode estar incompleta). Só lança erro
 * quando TODAS falham.
 *
 * @returns {Promise<{ current: Game[], upcoming: Game[], failedSources: string[] }>}
 */
export async function getAllGames(options = {}, fetchers = defaultFetchers(options)) {
  const { sources = ALL_SOURCES, log } = options;
  const active = ALL_SOURCES.filter((source) => sources.includes(source));

  const settled = await Promise.allSettled(active.map((source) => fetchers[source]()));

  const results = [];
  const failures = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      results.push({ source: active[i], games: outcome.value });
    } else {
      failures.push({ source: active[i], error: outcome.reason });
      log?.(`fonte "${active[i]}" falhou: ${outcome.reason?.message ?? outcome.reason}`);
    }
  });

  if (results.length === 0) {
    const detail = failures.map((f) => `${SOURCE_LABELS[f.source]}: ${f.error.message}`).join('; ');
    throw new Error(`Nenhuma fonte respondeu (${detail})`, { cause: failures[0]?.error });
  }

  return { ...mergeGames(results), failedSources: failures.map((f) => f.source) };
}
