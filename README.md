# 🪐 Ludo Pix Galaxy

Jogo de Ludo com tema galáxia, desafios entre amigos e carteira com Pix.

O front continua sendo HTML/CSS/JS puro, sem etapa de build. O que mudou é
que **nada que envolva dinheiro acontece mais no navegador**: saldo, dado,
regras e vencedor são decididos por um servidor que o jogador não controla.

---

## Por que existe um servidor

A versão anterior era um protótipo que decidia tudo no cliente. Com dinheiro
real envolvido, cada um desses pontos era uma forma de perder dinheiro:

| Como era | Como é agora |
|---|---|
| `addBalance(50)` criava saldo do nada pelo console | Livro-razão de partidas dobradas; todo lançamento soma zero |
| Dado viciado em 90% (`SIX_TEST_MODE`, ligado em produção) | Commit–reveal com HMAC-SHA256, auditável pelo jogador |
| Cada jogador votava em quem venceu | O servidor arbitra e reexecuta a partida antes de pagar |
| Apostar contra o `sim_bot` e sacar 1,6x | *Constraint* no banco impede jogar contra si mesmo |
| Senha em SHA-256 com salt de `Math.random()` | scrypt com 64 MB por tentativa |
| Limites de jogo responsável no `localStorage` | No servidor, com carência de 24h para afrouxar |
| Depósito creditado por um `setTimeout` | Crédito só após webhook assinado do provedor |
| Duas carteiras desconectadas (perfil e desafio) | Uma só, no banco |

---

## Subindo o projeto

Requisitos: **Node 22+** e **PostgreSQL 14+**.

```bash
# 1. dependências (uma só: o driver do Postgres)
cd server && npm install

# 2. configuração
cp .env.example .env
#    preencha DATABASE_URL e gere o segredo:
#    openssl rand -hex 32   → SESSION_SECRET

# 3. banco
createdb ludo
npm run migrate

# 4. subir
npm start        # http://localhost:3000
```

O servidor serve o front de `public/` e a API em `/api`. Em desenvolvimento,
`PAYMENT_PROVIDER=mock` gera códigos Pix falsos para você testar o fluxo
inteiro sem cobrar ninguém.

### Testes

```bash
cd server && npm test
```

Os testes de integração precisam de um banco `ludo_test`; sem ele, são
pulados em vez de falhar.

---

## Estrutura

```
shared/ludo-rules.js      Motor de regras. Única fonte de verdade das regras;
                          usado pelo servidor para validar e pelo cliente
                          apenas para desenhar.

server/src/
  config.js               Valida o ambiente no boot e recusa subir se faltar
                          segredo em produção.
  lib/
    money.js              Centavos inteiros. Nenhum valor é float em momento algum.
    rng.js                Dado por commit–reveal.
    passwords.js          scrypt + índice cego para CPF.
    crypto-box.js         AES-256-GCM para a chave Pix (precisa voltar ao claro).
    validate.js           Validação de entrada e documentos brasileiros.
  db/migrations/          Schema. Leia 001_init.sql: os comentários explicam
                          cada decisão de modelagem.
  modules/
    auth/                 Sessões em banco (revogáveis), CSRF, rate limit.
    users/                Perfil, KYC e jogo responsável.
    wallet/ledger.js      O livro-razão. Único lugar que move dinheiro.
    payments/             Provedor plugável, depósitos, saques, webhooks.
    challenges/           Desafio, escrow e liquidação do prêmio.
    matches/              Partida arbitrada pelo servidor + SSE.

public/                   Front. assets/sprites/ tem as imagens extraídas.
```

---

## Trocar de provedor de pagamento

`server/src/modules/payments/providers/mercadopago.js` é a referência.
Para usar Asaas, Efí, ou o PSP do seu banco: copie o arquivo, implemente o
mesmo contrato (`createPixCharge`, `verifyWebhook`, `parsePaymentEvent`,
`sendPixPayout`), registre o nome em `provider.js` e mude `PAYMENT_PROVIDER`
no `.env`. Nada mais no sistema muda.

A chave de API vive **só** no processo do servidor. Ela nunca vai para o
navegador, nunca aparece em log e nunca volta numa resposta de API.

---

## Operação

### Conciliação de caixa

O servidor confere a cada 15 minutos que a soma de todos os lançamentos é
zero e que nenhum saldo divergiu do razão. Se não fechar, o log grita
`ALERTA DE CAIXA`. **Ligue isso ao seu alarme** (`server/src/index.js`,
tarefa `conciliacao`) — divergência de caixa é incidente, não aviso.

Conferência manual:

```bash
cd server && npm run reconcile
```

### Saques

Saques **não são automáticos**. Entram numa fila de revisão
(`GET /api/admin/withdrawals`) e só saem quando um administrador aprova.
Mantenha assim até ter volume e regras antifraude maduras.

Para criar o primeiro administrador:

```sql
UPDATE users SET is_admin = true WHERE email = 'voce@email.com';
```

### Antes de ir para produção

- [ ] `SESSION_SECRET` com 32 bytes aleatórios, diferente do de desenvolvimento
- [ ] `PAYMENT_PROVIDER` diferente de `mock` (o servidor recusa subir com mock)
- [ ] `PUBLIC_URL` em `https://` (o cookie de sessão depende disso)
- [ ] `TRUST_PROXY=true` **somente** se houver proxy reverso de verdade na frente
- [ ] Backup do banco com *point-in-time recovery* — o razão é o seu caixa
- [ ] Alarme ligado na conciliação
- [ ] Rate limit e SSE em Redis se rodar mais de uma instância
      (hoje são em memória; ver os avisos em `rate-limit.js` e `stream.js`)

---

## Limitações conhecidas

- **Rate limit e barramento SSE são em memória.** Com várias instâncias, o
  limite efetivo multiplica pelo número de instâncias e um jogador conectado
  a uma instância não recebe eventos publicados por outra. Troque por Redis
  antes de escalar horizontalmente.
- **Envio do documento de KYC não está implementado.** O campo e os estados
  existem no banco; falta a rota de upload e a tela de revisão.
- **Não há e-mail transacional.** Confirmação de cadastro, recuperação de
  senha e aviso de saque aprovado ainda não existem.
- **Partida só 2 jogadores no modo aposta.** O motor já suporta 3, 4 e
  duplas; o modo livre local usa isso, o modo aposta ainda não.

---

## Aspecto regulatório

Operar jogos valendo dinheiro no Brasil é atividade regulada. A Lei
14.790/2023 e a regulamentação do Ministério da Fazenda estabelecem exigências
de licença, capital, segregação de contas de jogadores, certificação de RNG
por laboratório credenciado, prevenção à lavagem de dinheiro e jogo
responsável.

Este repositório resolve a parte de engenharia — e vários dos controles
técnicos que a regulação cobra, como RNG auditável, livro-razão imutável,
KYC e limites. Não substitui licenciamento nem assessoria jurídica. **Converse
com um advogado especializado antes de operar com dinheiro real.** Não sou
advogado e isto não é orientação jurídica.

---

## Licença

MIT — veja [LICENSE](LICENSE).
