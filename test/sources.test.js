import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it, mock } from 'node:test';
import { parseFreeGames } from '../epicgamesbot.js';
import { getAllGames, mergeGames } from '../games.js';
import { fetchWithRetry } from '../http.js';
import { parseFeed } from '../lootscraper.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const steamXml = fixture('steam.xml'); // feeds reais capturados em 31/10/2026
const amazonXml = fixture('amazon.xml');

const at = (iso) => ({ now: new Date(iso) });
const titles = (games) => games.map((g) => g.title);

describe('feed da Steam', () => {
  it('lê título, link, imagem e término exato (UTC)', () => {
    const [hexologic, asleep] = parseFeed(steamXml, 'steam', at('2026-10-31T16:00:00Z'));
    assert.equal(hexologic.title, 'Hexologic');
    assert.equal(hexologic.url, 'https://store.steampowered.com/app/785890');
    assert.match(hexologic.image, /^https:\/\/.*\/apps\/785890\/header\.jpg/);
    assert.equal(hexologic.endDate, '2026-10-31T17:00:00.000Z');
    assert.equal(hexologic.endApprox, false);
    assert.equal(hexologic.requires, null);
    assert.equal(hexologic.startDate, null); // "valid from" é quando o LootScraper viu, não o início
    assert.equal(asleep.title, 'Asleep: Act 1');
  });

  it('descarta a oferta no instante em que ela termina', () => {
    // caso real: o feed ainda listava o Hexologic minutos depois das 17:00 UTC
    assert.deepEqual(titles(parseFeed(steamXml, 'steam', at('2026-10-31T16:59:59Z'))), ['Hexologic', 'Asleep: Act 1']);
    assert.deepEqual(titles(parseFeed(steamXml, 'steam', at('2026-10-31T17:00:00Z'))), ['Asleep: Act 1']);
  });
});

describe('feed da Amazon Luna', () => {
  it('lê as 10 ofertas, decodifica entidades e marca o término como aproximado', () => {
    const games = parseFeed(amazonXml, 'amazon', at('2026-10-31T12:00:00Z'));
    assert.equal(games.length, 10);
    const fnaf = games.find((g) => g.title.startsWith('Five Nights'));
    assert.equal(fnaf.title, "Five Nights at Freddy's: Into the Pit"); // &#039; decodificado
    assert.match(fnaf.url, /^https:\/\/luna\.amazon\.com\/claims\/.*[?]ingress=amzn&ref_=/); // &amp; decodificado
    assert.equal(fnaf.endApprox, true);
    assert.equal(fnaf.requires, 'Amazon Prime');
  });

  it('troca a imagem WebP disfarçada de .jpg pelo JPEG original', () => {
    const [first] = parseFeed(amazonXml, 'amazon', at('2026-10-31T12:00:00Z'));
    assert.ok(first.image.endsWith('.jpg'));
    assert.ok(!first.image.includes('_FMwebp_'));
  });

  it('dá 24h de folga depois do término aproximado, e não mais que isso', () => {
    const has = (iso, title) => titles(parseFeed(amazonXml, 'amazon', at(iso))).includes(title);
    assert.ok(has('2026-11-04T23:59:00Z', 'DOOM')); // fim palpitado: 04/11 00:00 UTC
    assert.ok(!has('2026-11-05T00:00:00Z', 'DOOM'));
    assert.ok(has('2026-11-05T00:00:00Z', 'Conarium')); // fim em 11/11
  });

  it('mantém oferta sem data de término, sem inventar uma', () => {
    const xml = amazonXml.replace(/<li><b>Offer valid to:<\/b>[^<]*<\/li>/, '');
    const games = parseFeed(xml, 'amazon', at('2026-10-31T12:00:00Z'));
    assert.equal(games.length, 10);
    const semFim = games.find((g) => g.endDate === null);
    assert.ok(semFim);
    assert.equal(semFim.endApprox, false);
    assert.equal(games.at(-1), semFim); // sem data fica por último
  });

  it('feed vazio vale, mas texto que não é feed é erro', () => {
    const vazio = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>';
    assert.deepEqual(parseFeed(vazio, 'steam'), []);
    assert.throws(() => parseFeed('<html>Bad gateway</html>', 'steam'), /formato inesperado/);
  });
});

describe('Epic (parser existente com os campos novos)', () => {
  const element = (id, title, percent, start, end) => ({
    id,
    title,
    keyImages: [{ type: 'Thumbnail', url: 'https://img/x.png' }],
    offerMappings: [{ pageSlug: id }],
    price: { totalPrice: { fmtPrice: { originalPrice: 'R$ 10,00' } } },
    promotions: {
      promotionalOffers: [{ promotionalOffers: [{ startDate: start, endDate: end, discountSetting: { discountPercentage: percent } }] }],
      upcomingPromotionalOffers: [],
    },
  });
  const payload = (...els) => ({ data: { Catalog: { searchStore: { elements: els } } } });

  it('marca source "epic", término exato e ignora desconto parcial', () => {
    const { current } = parseFreeGames(
      payload(
        element('a', 'Grátis', 0, '2026-10-30T15:00:00.000Z', '2026-11-06T15:00:00.000Z'),
        element('b', '20% off', 20, '2026-10-30T15:00:00.000Z', '2026-11-06T15:00:00.000Z'),
      ),
      at('2026-10-31T12:00:00Z'),
    );
    assert.deepEqual(titles(current), ['Grátis']);
    assert.equal(current[0].source, 'epic');
    assert.equal(current[0].endApprox, false);
  });
});

describe('junção de fontes', () => {
  const game = (source, title) => ({ id: `${source}:${title}`, title, source, status: 'current', endDate: null });
  const result = (source, ...names) => ({ source, games: { current: names.map((n) => game(source, n)), upcoming: [] } });

  it('mantém o jogo na loja de maior prioridade e lista as outras em alsoIn', () => {
    const merged = mergeGames([result('epic', 'Doom™'), result('steam', 'Other'), result('amazon', 'DOOM', 'Other')]);
    assert.deepEqual(merged.current.map((g) => [g.source, g.title, g.alsoIn]), [
      ['epic', 'Doom™', ['amazon']],
      ['steam', 'Other', ['amazon']],
    ]);
  });

  it('não confunde títulos diferentes', () => {
    const merged = mergeGames([result('epic', 'Doom'), result('amazon', 'Doom Eternal')]);
    assert.equal(merged.current.length, 2);
  });
});

describe('getAllGames: falha isolada por fonte', () => {
  const ok = (source, ...names) => async () => ({
    current: names.map((title) => ({ id: title, title, source, status: 'current', endDate: null })),
    upcoming: [],
  });
  const boom = (msg) => async () => {
    throw new Error(msg);
  };

  it('uma fonte fora do ar vira failedSources e as outras seguem', async () => {
    const logs = [];
    const out = await getAllGames(
      { log: (m) => logs.push(m) },
      { epic: ok('epic', 'A'), steam: boom('HTTP 503'), amazon: ok('amazon', 'B') },
    );
    assert.deepEqual(titles(out.current), ['A', 'B']);
    assert.deepEqual(out.failedSources, ['steam']);
    assert.match(logs[0], /steam.*HTTP 503/);
  });

  it('sem falhas, failedSources vem vazio', async () => {
    const out = await getAllGames({}, { epic: ok('epic'), steam: ok('steam'), amazon: ok('amazon') });
    assert.deepEqual(out.failedSources, []);
  });

  it('só lança erro quando todas falham', async () => {
    await assert.rejects(
      getAllGames({}, { epic: boom('e'), steam: boom('s'), amazon: boom('a') }),
      /Nenhuma fonte respondeu/,
    );
  });

  it('respeita a lista de fontes ativas (SOURCES)', async () => {
    const out = await getAllGames(
      { sources: ['steam'] },
      { epic: boom('não deveria rodar'), steam: ok('steam', 'S'), amazon: boom('não deveria rodar') },
    );
    assert.deepEqual(titles(out.current), ['S']);
    assert.deepEqual(out.failedSources, []);
  });
});

describe('fetchWithRetry', () => {
  afterEach(() => mock.restoreAll());

  it('tenta de novo depois de falha e devolve a resposta', async () => {
    let calls = 0;
    mock.method(globalThis, 'fetch', async () => {
      calls++;
      return calls < 3 ? new Response('x', { status: 503 }) : new Response('ok');
    });
    const res = await fetchWithRetry('https://example.test/feed', { baseDelayMs: 1 });
    assert.equal(await res.text(), 'ok');
    assert.equal(calls, 3);
  });

  it('desiste depois das tentativas e diz de qual host', async () => {
    let calls = 0;
    mock.method(globalThis, 'fetch', async () => {
      calls++;
      return new Response('x', { status: 500 });
    });
    await assert.rejects(fetchWithRetry('https://example.test/feed', { baseDelayMs: 1 }), /example\.test.*HTTP 500/);
    assert.equal(calls, 3);
  });
});
