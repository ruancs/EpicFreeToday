const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;
// Identifica o job: o feed do LootScraper é infraestrutura pessoal de terceiro.
const USER_AGENT = 'EpicFreeToday/1.0 (bot pessoal; poucas requisicoes por dia)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch com timeout e retry (espera 2s, 4s entre as tentativas).
 * Devolve a Response já validada (res.ok); quem chama decide se lê json() ou text().
 */
export async function fetchWithRetry(
  url,
  { accept = '*/*', log, attempts = MAX_ATTEMPTS, baseDelayMs = 1000 } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept, 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        log?.(`${new URL(url).host}: tentativa ${attempt} falhou (${error.message}), tentando de novo`);
        await sleep(baseDelayMs * 2 ** attempt);
      }
    }
  }
  throw new Error(`Falha ao consultar ${new URL(url).host}: ${lastError.message}`, {
    cause: lastError,
  });
}
