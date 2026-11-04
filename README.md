<div align="center">

# 🎮 Epic Free Today

**Um bot de Telegram que avisa todo dia, às 10:00, quais jogos estão de graça na Epic Games Store, na Steam e no Amazon Luna.**

![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2020.12-339933?logo=nodedotjs&logoColor=white)
![Telegram](https://img.shields.io/badge/Telegram-Bot-26A5E4?logo=telegram&logoColor=white)
![Dependências](https://img.shields.io/badge/depend%C3%AAncias-2-brightgreen)
![Fuso](https://img.shields.io/badge/fuso-America%2FSao__Paulo-orange)

</div>

---

## ✨ O que ele faz

- 📅 **Envio automático todo dia às 10:00** (horário de Brasília), sem você precisar lembrar.
- 🛒 **Três lojas num resumo só**: Epic Games, Steam e Amazon Luna (Prime Gaming), sem repetir o mesmo jogo.
- 🖼️ **Uma foto por jogo**, com nome, loja, até quando está grátis e link para resgatar.
- ⏭️ **Seção "Em breve"** com os próximos jogos da Epic.
- 🗂️ **Histórico em arquivo**: cada dia consultado fica salvo e pode ser revisto pelo bot.
- 🛡️ **Uma loja fora do ar não derruba as outras**: o resumo sai com um aviso de que a lista pode estar incompleta.
- ⚡ **Simples de rodar**: poucos arquivos, duas dependências (`node-cron` e `fast-xml-parser`) e nenhum banco de dados.

Cada jogo vai como uma **foto com legenda** (a imagem é a capa oficial da loja).

## 🛒 De onde vêm os jogos

| Loja | Fonte | Data de término |
| --- | --- | --- |
| **Epic Games** | API pública que a própria página `/free-games` consome | **Exata**, com início e fim |
| **Steam** | Feed do [LootScraper](https://github.com/eikowagenknecht/lootscraper) | **Exata** (a Steam vira às 10:00 do Pacífico) |
| **Amazon Luna** | Feed do [LootScraper](https://github.com/eikowagenknecht/lootscraper) | **Aproximada**: a Luna só mostra "termina em 3 dias", e o erro pode chegar a 1 dia. Aparece como `até ~04/11/2026 (data aproximada)` e exige Amazon Prime |

Se o mesmo jogo aparece em mais de uma loja, ele fica na de maior prioridade (Epic, depois Steam, depois Amazon) com a linha `Também em: ...`.

## 🤖 Comandos

| Comando | O que faz |
| --- | --- |
| `/start` | Se inscreve no envio diário das 10:00 |
| `/stop` | Cancela a inscrição |
| `/hoje` | Consulta as lojas agora e mostra os jogos grátis |
| `/historico` | Mostra botões com os últimos 14 dias registrados |
| `/dia ontem` | Mostra os jogos de ontem |
| `/dia 29/10` | Mostra um dia específico (também aceita `29/10/2026` e `2026-10-29`) |
| `/ajuda` | Lista os comandos |

## 🚀 Começando

### Requisitos

- [Node.js](https://nodejs.org) **20.12 ou superior**
- Um bot do Telegram (passo 1 abaixo)

### 1. Crie o bot

1. No Telegram, abra o [@BotFather](https://t.me/BotFather) e envie `/newbot`.
2. Siga as instruções e copie o **token** que ele devolver.

### 2. Instale e configure

```bash
git clone https://github.com/<seu-usuario>/EpicFreeToday.git
cd EpicFreeToday
npm install
cp .env.example .env        # no Windows (cmd): copy .env.example .env
```

Abra o `.env` e preencha `TELEGRAM_BOT_TOKEN` com o token do passo anterior.

### 3. Suba o bot e se inscreva

```bash
npm start
```

No Telegram, abra o seu bot e envie `/start`. Pronto: a partir de agora você recebe os jogos grátis todo dia às 10:00.

**Não há lista de ids para editar.** Qualquer pessoa que enviar `/start` ao bot é cadastrada sozinha e fica salva em `data/subscribers.json`. Quem enviar `/stop` sai da lista, e quem bloquear o bot é removido automaticamente no próximo envio.

> O bot é aberto: quem achar o `@usuario` dele pode se inscrever. Isso é inofensivo (ele só lista jogos grátis), mas se preferir manter o bot só para você e amigos, não divulgue o nome dele.

## 🧪 Testando

| Comando | O que faz |
| --- | --- |
| `npm test` | Roda os testes automáticos (usam feeds reais salvos em `test/fixtures`, sem acesso à rede) |
| `npm run dry` | Consulta as lojas e imprime o resumo no console. **Não usa o Telegram** nem precisa de token |
| `npm run once` | Consulta as lojas, manda o resumo aos inscritos uma vez e encerra |
| `npm start` | Sobe o bot: responde aos comandos e dispara todo dia às 10:00 |

Para testar o agendamento sem esperar até as 10:00, coloque no `.env`:

```
CRON_SCHEDULE=*/2 * * * *
```

O bot passa a enviar o resumo a cada 2 minutos. Apague a linha quando terminar, e o padrão (10:00) volta.

## ⚙️ Configuração

Tudo é configurado pelo arquivo `.env`:

| Variável | Obrigatória | Descrição |
| --- | :---: | --- |
| `TELEGRAM_BOT_TOKEN` | ✅ | Token do bot, criado no @BotFather |
| `CRON_SCHEDULE` | não | Expressão cron do envio. Padrão: `0 10 * * *` |
| `SOURCES` | não | Lojas ativas, separadas por vírgula. Padrão: `epic,steam,amazon`. Ex.: `SOURCES=epic` desliga Steam e Amazon |
| `LOOTSCRAPER_BASE_URL` | não | Servidor dos feeds de Steam e Amazon. Padrão: `https://feed.eikowagenknecht.com` (dá para apontar para uma instância sua) |
| `HISTORY_FILE` | não | Caminho do arquivo de histórico. Padrão: `data/history.json` |
| `SUBSCRIBERS_FILE` | não | Caminho do arquivo de inscritos. Padrão: `data/subscribers.json` |

O fuso do agendamento é fixo em `America/Sao_Paulo`, independente do fuso do servidor.

## 🔍 Como funciona

```
  10:00 (cron)
       │
       ▼
  ┌─────────────────────── games.js ───────────────────────┐
  │  consulta as 3 fontes em paralelo, junta e tira repetidos │
  └───────┬───────────────────┬───────────────────┬────────┘
          ▼                   ▼                   ▼
   epicgamesbot.js      lootscraper.js      lootscraper.js
   API da Epic          feed da Steam       feed da Amazon
          └───────────────────┴───────────────────┘
                              │  (http.js: timeout + 3 tentativas)
              ┌───────────────┴───────────────┐
              ▼                               ▼
   data/history.json                 Telegram (fotos + legenda)
   (um registro por dia)             /hoje · /historico · /dia
```

Alguns detalhes que importam:

- **Epic sem scraping.** O bot usa o mesmo JSON que a página da Epic consome, que é mais estável do que ler HTML.
- **Steam e Amazon via feed.** Não existe API pública para elas, então o bot lê os feeds Atom do LootScraper, que já fazem o scraping. Isso é uma dependência de terceiro (veja as limitações).
- **"Grátis" na Epic é `discountPercentage === 0`.** A Epic representa o desconto de 100% como `0`, que é o percentual que o cliente **paga**. Promoções de 20%, 40% ou 70% são ignoradas.
- **Classificação por data, não pela lista da API.** O endpoint da Epic fica atrás de um CDN, e logo após uma promoção começar o JSON pode ainda listá-la como "em breve". O parser compara as datas com o horário atual. O mesmo vale para os feeds: uma oferta que já terminou pode continuar no feed por um tempo, então ela é descartada pela data.
- **Falha isolada por loja.** Cada fonte tenta 3 vezes (com espera entre elas). Se uma continuar fora do ar, o resumo sai com `⚠️ Fontes indisponíveis: ...` e as outras seguem. Só dá erro quando **todas** falham, e então o bot avisa no chat.
- **Resultado parcial não apaga o dia.** Se o `/hoje` rodar com uma loja fora do ar, ele não sobrescreve no histórico um registro mais completo do mesmo dia.
- **Histórico seguro.** O arquivo é gravado em um arquivo temporário e renomeado, então não fica corrompido se o processo cair no meio da gravação.

## 📁 Estrutura

```
EpicFreeToday/
├── bot.js              # bot do Telegram, agendamento, inscritos e histórico
├── games.js            # junta as fontes, tira repetidos, isola falhas
├── epicgamesbot.js     # consulta e interpretação da API da Epic
├── lootscraper.js      # leitura dos feeds de Steam e Amazon
├── http.js             # fetch com timeout e retry
├── test/               # testes (com feeds reais salvos em test/fixtures)
├── data/
│   ├── history.json     # histórico por dia (gerado automaticamente)
│   └── subscribers.json # chats inscritos (gerado automaticamente)
├── .env.example        # modelo de configuração
└── package.json
```

## 🖥️ Rodando como serviço (pm2)

Para deixar o bot rodando em um servidor e sobrevivendo a reinicializações:

```bash
npm install -g pm2
pm2 start bot.js --name epic-free
pm2 save
pm2 startup        # siga a instrução que ele imprimir
```

Comandos úteis: `pm2 logs epic-free`, `pm2 restart epic-free`, `pm2 stop epic-free`.

## ⚠️ Limitações

- **Servidor desligado às 10:00:** se a máquina estiver fora do ar nesse horário, o envio do dia não acontece. Use `/hoje` para recuperar.
- **Dados locais:** o histórico e os inscritos ficam só em `data/`. Faça backup dessa pasta se eles forem importantes para você.
- **Steam e Amazon dependem de um terceiro:** o feed do LootScraper é mantido por uma pessoa, sem garantia de disponibilidade nem termos escritos. Se ele cair ou mudar de formato, só essas duas lojas param (com aviso no resumo) e a Epic segue normal. Use `SOURCES=epic` para desligá-las, ou `LOOTSCRAPER_BASE_URL` para apontar para uma instância sua. O bot faz poucas requisições por dia, justamente para não pesar nessa infraestrutura.
- **Amazon: data aproximada e só para assinantes Prime.** A Luna não informa a hora de término, e o jogo precisa ser resgatado com uma conta Prime. Como as ofertas duram cerca de um mês, os mesmos jogos aparecem em vários resumos seguidos.
- **Região fixa:** os preços e links da Epic vêm da loja brasileira (`pt-BR` / `BR`). Para outra região, altere `LOCALE` e `COUNTRY` no topo do [bot.js](bot.js).
- **Sem recuperação de dias perdidos:** o histórico só registra os dias em que o bot rodou ou em que alguém usou `/hoje`.

## 🔒 Segurança

- **Nunca** suba o `.env` para o GitHub. Ele já está no `.gitignore`, junto com `data/` e `node_modules/`.
- Se o token vazar, gere outro no @BotFather com `/revoke`.

---

## 📄 Licença

Distribuído sob a licença [MIT](LICENSE).

<div align="center">

Feito para nunca mais perder um jogo grátis. 🎁

</div>
