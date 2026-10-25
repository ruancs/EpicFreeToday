<div align="center">

# 🎮 Epic Free Today

**Um bot de Telegram que avisa todo dia, às 10:00, quais jogos estão de graça na Epic Games Store.**

![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2020.12-339933?logo=nodedotjs&logoColor=white)
![Telegram](https://img.shields.io/badge/Telegram-Bot-26A5E4?logo=telegram&logoColor=white)
![Dependências](https://img.shields.io/badge/depend%C3%AAncias-1-brightgreen)
![Fuso](https://img.shields.io/badge/fuso-America%2FSao__Paulo-orange)

</div>

---

## ✨ O que ele faz

- 📅 **Envio automático todo dia às 10:00** (horário de Brasília), sem você precisar lembrar.
- 🖼️ **Uma foto por jogo**, com nome, até quando está grátis, preço original e link da loja.
- ⏭️ **Seção "Em breve"** com o próximo jogo que vai ficar grátis.
- 🗂️ **Histórico em arquivo**: cada dia consultado fica salvo e pode ser revisto pelo bot.
- ⚡ **Simples de rodar**: um arquivo de bot, uma dependência (`node-cron`) e nenhum banco de dados.


Cada jogo vai como uma **foto com legenda** (a imagem é a capa oficial da Epic).

## 🤖 Comandos

| Comando | O que faz |
| --- | --- |
| `/start` | Se inscreve no envio diário das 10:00 |
| `/stop` | Cancela a inscrição |
| `/hoje` | Consulta a Epic agora e mostra os jogos grátis |
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
| `npm run dry` | Consulta a Epic e imprime o resumo no console. **Não usa o Telegram** nem precisa de token |
| `npm run once` | Consulta a Epic, manda o resumo ao Telegram uma vez e encerra |
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
| `HISTORY_FILE` | não | Caminho do arquivo de histórico. Padrão: `data/history.json` |
| `SUBSCRIBERS_FILE` | não | Caminho do arquivo de inscritos. Padrão: `data/subscribers.json` |

O fuso do agendamento é fixo em `America/Sao_Paulo`, independente do fuso do servidor.

## 🔍 Como funciona

```
                ┌──────────────────────────┐
  10:00 (cron)  │  freeGamesPromotions     │   endpoint público que a própria
  ───────────►  │  (API da Epic)           │   página /free-games consome
                └────────────┬─────────────┘
                             │ JSON
                             ▼
                ┌──────────────────────────┐
                │  epicgamesbot.js         │   filtra o que é grátis e separa
                │  (parser)                │   "agora" de "em breve"
                └────────────┬─────────────┘
                             │
              ┌──────────────┴───────────────┐
              ▼                              ▼
   data/history.json                  Telegram (fotos + legenda)
   (um registro por dia)              /hoje · /historico · /dia
```

Alguns detalhes que importam:

- **Sem scraping.** O bot usa o mesmo JSON que a página da Epic consome, que é mais estável do que ler HTML.
- **"Grátis" é `discountPercentage === 0`.** A Epic representa o desconto de 100% como `0`, que é o percentual que o cliente **paga**. Promoções de 20%, 40% ou 70% são ignoradas.
- **Classificação por data, não pela lista da API.** O endpoint fica atrás de um CDN, e logo após uma promoção começar o JSON pode ainda listá-la como "em breve". O parser compara as datas com o horário atual.
- **Falha não passa em silêncio.** Se a consulta falhar, o bot tenta 3 vezes (com espera entre elas) e, se ainda falhar, avisa no chat.
- **Histórico seguro.** O arquivo é gravado em um arquivo temporário e renomeado, então não fica corrompido se o processo cair no meio da gravação.

## 📁 Estrutura

```
EpicFreeToday/
├── bot.js              # bot do Telegram, agendamento e histórico
├── epicgamesbot.js     # consulta e interpretação da API da Epic
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
- **Região fixa:** os preços e links vêm da loja brasileira (`pt-BR` / `BR`). Para outra região, altere `LOCALE` e `COUNTRY` no topo do [bot.js](bot.js).
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
