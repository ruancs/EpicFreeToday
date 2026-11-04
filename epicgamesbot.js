import { fetchWithRetry } from './http.js';

const ENDPOINT =
  'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions';

const STORE_BASE = 'https://store.epicgames.com';

/**
 * Busca o JSON que a própria página /free-games consome.
 * Mais estável (e barato) do que renderizar a página e fazer scraping de HTML.
 */
export async function fetchPayload({ locale, country }, { log } = {}) {
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({
    locale,
    country,
    allowCountries: country,
  }).toString();

  const res = await fetchWithRetry(url, { accept: 'application/json', log });
  return res.json();
}

/**
 * Pegadinha da API: o endpoint devolve TODAS as promoções (inclusive 20%, 70% off etc.).
 * Uma promoção é "grátis" quando discountPercentage === 0 — a Epic representa o
 * desconto de 100% como 0 (é o percentual que o cliente PAGA, não o desconto).
 */
const isFreeWindow = (window) => window?.discountSetting?.discountPercentage === 0;

const windowsOf = (groups) =>
  (groups ?? []).flatMap((group) => group.promotionalOffers ?? []);

const IMAGE_PRIORITY = ['OfferImageWide', 'DieselStoreFrontWide', 'Thumbnail', 'OfferImageTall'];
const isHttp = (url) => /^https?:\/\//.test(url ?? '');

function pickImage(keyImages = []) {
  for (const type of IMAGE_PRIORITY) {
    const found = keyImages.find((img) => img.type === type && isHttp(img.url));
    if (found) return found.url;
  }
  // heroCarouselVideo vem como com.epicgames.video://..., não serve como imagem
  return keyImages.find((img) => isHttp(img.url))?.url ?? null;
}

function buildUrl(element, locale) {
  const slug =
    element.offerMappings?.[0]?.pageSlug ??
    element.catalogNs?.mappings?.[0]?.pageSlug ??
    element.productSlug?.replace(/\/home$/, '') ??
    element.urlSlug;
  return slug ? `${STORE_BASE}/${locale}/p/${slug}` : `${STORE_BASE}/${locale}/free-games`;
}

function toGame(element, window, locale, status) {
  return {
    id: element.id,
    title: element.title,
    status, // 'current' | 'upcoming'
    source: 'epic',
    image: pickImage(element.keyImages),
    url: buildUrl(element, locale),
    startDate: window.startDate,
    endDate: window.endDate,
    endApprox: false,
    originalPrice: element.price?.totalPrice?.fmtPrice?.originalPrice ?? null,
    requires: null,
  };
}

/**
 * @returns {{ current: Game[], upcoming: Game[] }}
 */
export function parseFreeGames(payload, { now = new Date(), locale = 'pt-BR' } = {}) {
  const elements = payload?.data?.Catalog?.searchStore?.elements;
  if (!Array.isArray(elements)) {
    throw new Error('Resposta da Epic em formato inesperado (data.Catalog.searchStore.elements)');
  }

  const current = [];
  const upcoming = [];
  const seen = new Set();

  for (const element of elements) {
    if (!element?.promotions || seen.has(element.id)) continue;

    // Classificamos pelas DATAS, não pelo "balde" (promotionalOffers x upcoming...)
    // em que a Epic colocou a janela: o endpoint é cacheado em CDN, então logo após
    // o início de uma promoção o JSON pode ainda listá-la como "upcoming".
    const freeWindows = [
      ...windowsOf(element.promotions.promotionalOffers),
      ...windowsOf(element.promotions.upcomingPromotionalOffers),
    ].filter(isFreeWindow);

    const active = freeWindows.find(
      (w) => new Date(w.startDate) <= now && now < new Date(w.endDate),
    );
    if (active) {
      seen.add(element.id);
      current.push(toGame(element, active, locale, 'current'));
      continue;
    }

    const next = freeWindows
      .filter((w) => new Date(w.startDate) > now)
      .sort((a, b) => new Date(a.startDate) - new Date(b.startDate))[0];
    if (next) {
      seen.add(element.id);
      upcoming.push(toGame(element, next, locale, 'upcoming'));
    }
  }

  // Desempate por título: mesma data de início não pode gerar saída dependente
  // da ordem que a API devolveu (saída determinística = diff/teste estáveis).
  const byStartThenTitle = (a, b) =>
    new Date(a.startDate) - new Date(b.startDate) || a.title.localeCompare(b.title);
  return {
    current: current.sort(byStartThenTitle),
    upcoming: upcoming.sort(byStartThenTitle),
  };
}

export async function getFreeGames({ locale, country }, { log } = {}) {
  const payload = await fetchPayload({ locale, country }, { log });
  return parseFreeGames(payload, { locale });
}
