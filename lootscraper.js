import { XMLParser } from 'fast-xml-parser';
import { fetchWithRetry } from './http.js';

/**
 * Steam e Amazon Luna não têm API pública: lemos os feeds Atom do LootScraper
 * (https://github.com/eikowagenknecht/lootscraper), que já fazem o scraping.
 *
 * O que cada feed garante sobre a data de término ("Offer valid to", sempre em UTC):
 * - steam:  data exata (a Steam vira às 10:00 do Pacífico).
 * - amazon: palpite do LootScraper (a Luna só mostra "termina em 3 dias"), com erro de até 1 dia.
 *
 * "Offer valid from" é quando o LootScraper viu a oferta pela 1ª vez, não o início
 * oficial, então NÃO é usado como startDate.
 */
export const FEEDS = {
  steam: { file: 'lootscraper_steam_game.xml', endApprox: false, requires: null },
  amazon: { file: 'lootscraper_amazon_game.xml', endApprox: true, requires: 'Amazon Prime' },
};

export const DEFAULT_BASE_URL = 'https://feed.eikowagenknecht.com';

const APPROX_GRACE_MS = 24 * 3600 * 1000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  stopNodes: ['feed.entry.content'], // o XHTML do <content> chega como string
  isArray: (name) => name === 'entry',
});

const decode = (s) => s.replace(/&amp;/g, '&');

// A Amazon serve "...ORfML._FMwebp_.jpg" como WebP de verdade (apesar do .jpg), que o
// sendPhoto do Telegram pode recusar. Sem o modificador ela devolve o JPEG original.
const jpegUrl = (url) => url.replace('._FMwebp_', '');

// "Steam (Game, PC) - Hexologic" -> "Hexologic"
const cleanTitle = (raw) => String(raw).replace(/^[^(]+\([^)]*\)\s+-\s+/, '').trim();

const contentOf = (entry) =>
  typeof entry.content === 'string' ? entry.content : (entry.content?.['#text'] ?? '');

const hrefOf = (entry) => [].concat(entry.link ?? [])[0]?.['@_href'] ?? null;

function parseEndDate(html) {
  const m = html.match(/Offer valid to:<\/b>\s*(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/);
  if (!m) return null;
  const date = new Date(`${m[1]}T${m[2]}:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * @param {string} xml feed Atom
 * @param {'steam'|'amazon'} source
 * @returns {Game[]} só ofertas ainda válidas, ordenadas por término
 */
export function parseFeed(xml, source, { now = new Date() } = {}) {
  const feed = FEEDS[source];
  const entries = parser.parse(xml)?.feed?.entry;
  if (entries === undefined) {
    if (!/<feed[\s>]/.test(xml)) throw new Error(`Feed ${source} em formato inesperado`);
    return []; // feed válido, sem ofertas
  }

  const games = [];
  for (const entry of entries) {
    const title = cleanTitle(entry.title ?? '');
    const url = hrefOf(entry);
    if (!title || !url) continue;

    const html = contentOf(entry);
    const end = parseEndDate(html);

    // Termina "de verdade" na data exata; se a data é só um palpite, dá 24h de folga:
    // melhor mostrar algo que acabou de expirar do que esconder um jogo ainda resgatável.
    if (end && now.getTime() >= end.getTime() + (feed.endApprox ? APPROX_GRACE_MS : 0)) continue;

    games.push({
      id: `${source}:${String(entry.id).split('/').pop()}`,
      title,
      status: 'current',
      source,
      image: jpegUrl(decode(html.match(/<img src="([^"]+)"/)?.[1] ?? '')) || null,
      url,
      startDate: null,
      endDate: end ? end.toISOString() : null,
      endApprox: Boolean(end) && feed.endApprox,
      originalPrice: null,
      requires: feed.requires,
    });
  }

  // Sem data de término por último; empate por título (saída determinística).
  const endKey = (g) => (g.endDate ? new Date(g.endDate).getTime() : Infinity);
  return games.sort((a, b) => endKey(a) - endKey(b) || a.title.localeCompare(b.title));
}

export async function getFeedGames(source, { baseUrl = DEFAULT_BASE_URL, now, log } = {}) {
  const url = new URL(FEEDS[source].file, `${baseUrl.replace(/\/$/, '')}/`);
  const res = await fetchWithRetry(url, { accept: 'application/atom+xml, application/xml', log });
  return parseFeed(await res.text(), source, { now });
}
