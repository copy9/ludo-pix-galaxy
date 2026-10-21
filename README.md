# 🪐 Ludo Pix Galaxy

Jogo de Ludo com tema galáxia, carteira e desafios entre amigos valendo aposta.

Front em HTML/CSS/JS puro, sem build. Servidor em Node, **sem nenhuma
dependência de terceiros** — só o que vem no Node 22+.

> ⚠️ **Leia o [SECURITY.md](SECURITY.md) antes de aceitar dinheiro de verdade.**
> Ele lista o que ainda falta e por quê. A lista não é formalidade.

---

## Rodando

```bash
cd server
npm start           # http://localhost:3000
```

Não existe `npm install`: o projeto não tem dependências. Requer **Node 22.5+**
(usa `node:sqlite`).

O servidor também serve o front, então abra `http://localhost:3000` e pronto.

```bash
npm test            # 54 testes
```

### Abrir só o front

O modo livre (sem aposta) funciona com qualquer servidor estático:

```bash
python3 -m http.server 8000
```

Abrir o `index.html` direto do disco (`file://`) funciona, mas o mascote cai no
modo `<img>`: o Chrome recusa usar imagem de `file://` como textura WebGL. Tudo
o mais funciona igual.

---

## Páginas

| Arquivo | O que é |
|---|---|
| `index.html` | Início: cena animada, música e menu |
| `jogo.html` | Tabuleiro. Modo livre (2–4 jogadores, duplas) e modo aposta (`?match=CÓDIGO`) |
| `desafio.html` | Criar e acompanhar desafio entre amigos (`?c=CÓDIGO`) |
| `perfil.html` | Conta, verificação, carteira e limites de jogo responsável |

## Estrutura

```
assets/
  api.js        cliente da API — a única porta por onde o front fala de dinheiro
  mascot.js     motor de animação do mascote (WebGL + física de mola)
  music.js      trilha e efeitos via Web Audio
  sprites.js    manifesto dos sprites
  sprites/      18 arquivos .webp
server/
  src/
    index.js    rotas HTTP
    http.js     roteador mínimo sobre node:http
    db.js       esquema SQLite + transações aninhadas
    money.js    livro-razão de partidas dobradas
    auth.js     senha (scrypt) e sessões
    match.js    desafios, dado provably fair, liquidação
    payments.js gateway, depósito, saque, webhook
    ludo.js     regras do Ludo (versão autoritativa)
    profile.js  cadastro, CPF, maioridade, limites
  test/         54 testes
```

**Duas implementações das regras do Ludo, de propósito:** `jogo.html` tem uma
cópia para o modo livre (offline, onde trapacear só prejudica o próprio
jogador); `server/src/ludo.js` é a que vale quando há dinheiro. Mudou uma regra,
mude as duas — há testes cobrindo a do servidor.

---

## Como o dinheiro anda

```
depósito    external:psp  →  user:A          (só pelo webhook assinado do gateway)
apostar     user:A        →  escrow:CÓDIGO
            user:B        →  escrow:CÓDIGO
pagar       escrow:CÓDIGO →  user:vencedor + house:rake
cancelar    escrow:CÓDIGO →  devolve a cada um
saque       user:A        →  external:psp
```

Tudo em **centavos inteiros**, num livro-razão onde cada lançamento soma zero.
`GET /api/_audit` confere a integridade.

---

## Configuração

Variáveis de ambiente (nenhuma obrigatória em desenvolvimento):

| Variável | Para que serve |
|---|---|
| `PORT` | porta (padrão 3000) |
| `DATA_DIR` | onde fica o banco (padrão `server/data`) |
| `NODE_ENV` | `production` exige as chaves do gateway e liga o HSTS |
| `PSP_API_KEY` | chave do gateway. **Sem ela, pagamento é simulado** |
| `PSP_WEBHOOK_SECRET` | segredo para conferir a assinatura do webhook |
| `ADMIN_TOKEN` | protege `GET /api/_audit` |
| `ALLOWED_ORIGINS` | origens extras permitidas em POST (anti-CSRF) |
| `TRUST_PROXY` | `1` quando houver proxy/CDN na frente |

---

## API

```
POST /api/auth/register      {email, name, password}
POST /api/auth/login         {email, password}
POST /api/auth/logout
GET  /api/me
POST /api/me/password        {current, next}

GET  /api/me/profile
POST /api/me/profile         {fullName, cpf, birth, phone, country}
POST /api/me/limits          {dayCents, weekCents, monthCents}
POST /api/me/pause           {days}
POST /api/me/self-exclude    {days}
POST /api/me/kyc             {docType}

GET  /api/wallet
POST /api/wallet/deposit     {amountCents}
POST /api/wallet/withdraw    {amountCents, pixKey}

POST /api/challenges                 {stakeCents}
GET  /api/challenges/:code
POST /api/challenges/:code/accept
POST /api/challenges/:code/cancel
POST /api/challenges/:code/roll      {version}
POST /api/challenges/:code/move      {tokenIdx, version}

POST /api/webhooks/psp       (assinado pelo gateway)
GET  /api/health
GET  /api/_audit             (integridade do livro-razão)
```

Valores em campos `...Cents` são **centavos inteiros**.

Note o que **não** existe: nenhuma rota aceita um saldo vindo do cliente, e
nenhuma rota declara vencedor. Isso é intencional.

---

## Integrando um gateway

1. Preencha `createPixCharge`, `createPayout` e `parseEvent` em
   `server/src/payments.js`.
2. Confirme o formato da assinatura do webhook na documentação do gateway e
   ajuste `verifyWebhook`.
3. Aponte o webhook do gateway para `https://seudominio/api/webhooks/psp`.
4. Para cartão, monte os *hosted fields* do gateway no lugar marcado em
   `perfil.html` — **não** colete número de cartão na sua página (veja o
   SECURITY.md).

Em desenvolvimento, sem `PSP_API_KEY`, as cobranças são simuladas e não movem
dinheiro.

---

## Aviso

🔞 Apenas para maiores de 18 anos. Jogue com responsabilidade.
