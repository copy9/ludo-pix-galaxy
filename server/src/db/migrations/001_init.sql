-- =====================================================================
-- Ludo Pix Galaxy — schema inicial
--
-- Princípios que valem para o arquivo inteiro:
--
--  1. DINHEIRO É SEMPRE BIGINT EM CENTAVOS. Nunca float, nunca numeric
--     solto. O protótipo usava `parseFloat` e somava reais em JavaScript;
--     0.1 + 0.2 não é 0.3 em ponto flutuante e isso vira divergência de
--     caixa. Centavos inteiros eliminam a classe inteira de erro.
--
--  2. O SALDO NÃO É UM CAMPO QUE SE SOBRESCREVE. É a soma de um livro-razão
--     append-only de partidas dobradas. Nada apaga nem edita uma linha do
--     razão. `accounts.balance_cents` existe só como cache, protegido por
--     constraint e atualizado na mesma transação dos lançamentos.
--
--  3. TODA MOVIMENTAÇÃO TEM CHAVE DE IDEMPOTÊNCIA. Webhook repetido, clique
--     duplo e retry de rede não podem pagar duas vezes.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------
-- Usuários e autenticação
-- ---------------------------------------------------------------------

CREATE TYPE kyc_level AS ENUM ('registered', 'personal_data', 'verified');
CREATE TYPE kyc_doc_status AS ENUM ('none', 'pending', 'approved', 'rejected');

CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email            CITEXT NOT NULL UNIQUE,
  -- Hash Argon2id. O protótipo usava SHA-256 com salt de Math.random();
  -- SHA-256 é rápido demais para senha e Math.random() é previsível.
  password_hash    TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  -- Dados pessoais só aparecem depois do cadastro completo (nível 2).
  full_name        TEXT,
  -- CPF guardado só em hash, para checar duplicidade sem armazenar o número.
  -- Os 3 últimos dígitos em claro permitem exibir a máscara ***.***.123-**.
  cpf_hash         TEXT UNIQUE,
  cpf_last3        CHAR(3),
  birth_date       DATE,
  phone            TEXT,
  country          CHAR(2) NOT NULL DEFAULT 'BR',
  city             TEXT,
  uf               CHAR(2),
  kyc_level        kyc_level NOT NULL DEFAULT 'registered',
  doc_status       kyc_doc_status NOT NULL DEFAULT 'none',
  doc_filename     TEXT,
  doc_reviewed_at  TIMESTAMPTZ,
  doc_reviewer_id  UUID REFERENCES users(id),
  doc_reject_reason TEXT,
  is_admin         BOOLEAN NOT NULL DEFAULT FALSE,
  -- Trava de conta por suspeita de fraude. Bloqueia aposta e saque.
  is_frozen        BOOLEAN NOT NULL DEFAULT FALSE,
  frozen_reason    TEXT,
  failed_logins    INT NOT NULL DEFAULT 0,
  locked_until     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Maior de 18 é requisito legal para apostar. Checado no banco também,
  -- não só na tela, porque a tela é do jogador.
  CONSTRAINT adult_only CHECK (
    birth_date IS NULL OR birth_date <= (CURRENT_DATE - INTERVAL '18 years')
  )
);

CREATE INDEX users_kyc_idx ON users (kyc_level) WHERE kyc_level <> 'verified';
CREATE INDEX users_doc_pending_idx ON users (doc_status) WHERE doc_status = 'pending';

-- Sessões em tabela, não em JWT: um JWT roubado vale até expirar e não há
-- como revogar. Aqui o logout e o congelamento de conta matam a sessão na hora.
CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Guardamos só o hash do token. Um dump do banco não dá acesso a sessões.
  token_hash    TEXT NOT NULL UNIQUE,
  csrf_secret   TEXT NOT NULL,
  user_agent    TEXT,
  ip            INET,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- Jogo responsável — limites e autoexclusão
--
-- Estavam no localStorage do protótipo, ou seja, o jogador podia apagar o
-- próprio limite com um clique. Aqui vivem no servidor, e afrouxar um limite
-- tem carência: endurecer vale na hora, afrouxar só depois de 24h.
-- ---------------------------------------------------------------------

CREATE TABLE responsible_gaming (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  deposit_limit_day    BIGINT CHECK (deposit_limit_day   IS NULL OR deposit_limit_day   > 0),
  deposit_limit_week   BIGINT CHECK (deposit_limit_week  IS NULL OR deposit_limit_week  > 0),
  deposit_limit_month  BIGINT CHECK (deposit_limit_month IS NULL OR deposit_limit_month > 0),
  stake_limit_day      BIGINT CHECK (stake_limit_day     IS NULL OR stake_limit_day     > 0),
  -- Alterações que afrouxam só passam a valer nesta data.
  pending_limits       JSONB,
  pending_effective_at TIMESTAMPTZ,
  paused_until         TIMESTAMPTZ,
  self_excluded_until  TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Livro-razão de partidas dobradas
--
-- Cada movimento de dinheiro é uma `ledger_transactions` com duas ou mais
-- `ledger_entries` que SOMAM ZERO. Dinheiro não nasce nem some: ele se move
-- entre contas. Contas de sistema (casa, escrow, mundo externo) podem ficar
-- negativas; carteira de jogador, nunca.
-- ---------------------------------------------------------------------

CREATE TYPE account_kind AS ENUM (
  'user_wallet',   -- saldo de um jogador
  'escrow',        -- apostas travadas durante um desafio
  'house_revenue', -- a comissão de 20%
  'pix_gateway',   -- contrapartida do mundo externo (entradas e saídas Pix)
  'bonus'          -- créditos promocionais
);

CREATE TABLE accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           account_kind NOT NULL,
  user_id        UUID REFERENCES users(id) ON DELETE RESTRICT,
  -- Nome único para as contas de sistema ('house_revenue', 'escrow', ...).
  system_key     TEXT UNIQUE,
  balance_cents  BIGINT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Carteira de jogador tem dono; conta de sistema tem chave.
  CONSTRAINT account_owner CHECK (
    (kind = 'user_wallet' AND user_id IS NOT NULL AND system_key IS NULL)
    OR (kind <> 'user_wallet' AND user_id IS NULL AND system_key IS NOT NULL)
  ),
  -- A regra que impede saldo negativo de jogador. No protótipo o saldo era
  -- um número no navegador; aqui o banco recusa a transação.
  CONSTRAINT no_negative_player_balance CHECK (
    kind <> 'user_wallet' OR balance_cents >= 0
  )
);

CREATE UNIQUE INDEX accounts_user_wallet_idx
  ON accounts (user_id) WHERE kind = 'user_wallet';

CREATE TYPE ledger_reason AS ENUM (
  'deposit',            -- Pix/cartão confirmado entrou
  'withdrawal_hold',    -- saque pedido: sai da carteira e fica retido
  'withdrawal_paid',    -- saque efetivamente pago pelo provedor
  'withdrawal_refund',  -- saque recusado/cancelado: volta para a carteira
  'stake_hold',         -- aposta travada no escrow ao entrar no desafio
  'stake_refund',       -- desafio cancelado/expirado: aposta devolvida
  'prize_payout',       -- prêmio pago ao vencedor
  'house_commission',   -- comissão da plataforma
  'bonus_credit',
  'manual_adjustment'   -- correção administrativa, sempre com justificativa
);

CREATE TABLE ledger_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reason          ledger_reason NOT NULL,
  -- A mesma chave nunca gera dois lançamentos. É isto que torna o webhook
  -- do provedor seguro para repetir: ele pode chegar dez vezes, paga uma.
  idempotency_key TEXT NOT NULL UNIQUE,
  reference_type  TEXT,
  reference_id    TEXT,
  memo            TEXT,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ledger_tx_reference_idx ON ledger_transactions (reference_type, reference_id);
CREATE INDEX ledger_tx_created_idx ON ledger_transactions (created_at DESC);

CREATE TABLE ledger_entries (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id  UUID NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  -- Positivo entra na conta, negativo sai. A soma por transação é zero.
  amount_cents    BIGINT NOT NULL CHECK (amount_cents <> 0),
  balance_after   BIGINT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, id DESC);
CREATE INDEX ledger_entries_tx_idx ON ledger_entries (transaction_id);

-- O razão é imutável. Sem UPDATE e sem DELETE, nem por engano, nem por
-- alguém com acesso ao banco que ache que está "só corrigindo".
CREATE OR REPLACE FUNCTION ledger_is_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'O livro-razão é append-only: use um lançamento de estorno.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_no_update
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();

CREATE TRIGGER ledger_transactions_no_update
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();

-- Ao fechar cada transação, conferimos que os lançamentos somam zero.
-- É a trava contábil: se algum código tentar criar dinheiro do nada, a
-- transação inteira falha em vez de desbalancear o caixa em silêncio.
CREATE OR REPLACE FUNCTION assert_transaction_balanced(tx UUID) RETURNS VOID AS $$
DECLARE
  total BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount_cents), 0) INTO total
    FROM ledger_entries WHERE transaction_id = tx;
  IF total <> 0 THEN
    RAISE EXCEPTION 'Transação % desbalanceada: soma % centavos', tx, total;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- Depósitos e saques
-- ---------------------------------------------------------------------

CREATE TYPE deposit_status AS ENUM ('pending', 'paid', 'expired', 'failed', 'refunded');

CREATE TABLE deposits (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount_cents       BIGINT NOT NULL CHECK (amount_cents > 0),
  status             deposit_status NOT NULL DEFAULT 'pending',
  provider           TEXT NOT NULL,
  -- id da cobrança no provedor; único por provedor para casar o webhook.
  provider_charge_id TEXT,
  pix_qr_code        TEXT,
  pix_copy_paste     TEXT,
  expires_at         TIMESTAMPTZ,
  paid_at            TIMESTAMPTZ,
  ledger_tx_id       UUID REFERENCES ledger_transactions(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX deposits_provider_charge_idx
  ON deposits (provider, provider_charge_id) WHERE provider_charge_id IS NOT NULL;
CREATE INDEX deposits_user_idx ON deposits (user_id, created_at DESC);

CREATE TYPE withdrawal_status AS ENUM (
  'pending_review', 'approved', 'paid', 'rejected', 'failed'
);

CREATE TABLE withdrawals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount_cents       BIGINT NOT NULL CHECK (amount_cents > 0),
  status             withdrawal_status NOT NULL DEFAULT 'pending_review',
  pix_key_type       TEXT NOT NULL,
  -- Chave Pix guardada em hash + sufixo visível, mesma lógica do CPF.
  pix_key_hash       TEXT NOT NULL,
  pix_key_masked     TEXT NOT NULL,
  provider           TEXT,
  provider_payout_id TEXT,
  reviewed_by        UUID REFERENCES users(id),
  reviewed_at        TIMESTAMPTZ,
  reject_reason      TEXT,
  hold_tx_id         UUID REFERENCES ledger_transactions(id),
  settle_tx_id       UUID REFERENCES ledger_transactions(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX withdrawals_user_idx ON withdrawals (user_id, created_at DESC);
CREATE INDEX withdrawals_queue_idx ON withdrawals (created_at)
  WHERE status = 'pending_review';

-- Eventos crus do provedor, gravados antes de qualquer processamento.
-- Serve para idempotência, para auditoria e para reprocessar se der ruim.
CREATE TABLE payment_webhook_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  signature_ok   BOOLEAN NOT NULL,
  payload        JSONB NOT NULL,
  processed_at   TIMESTAMPTZ,
  process_error  TEXT,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

-- ---------------------------------------------------------------------
-- Desafios e partidas
-- ---------------------------------------------------------------------

CREATE TYPE challenge_status AS ENUM (
  'open',       -- criado, esperando adversário
  'staked',     -- os dois pagaram, partida pode começar
  'playing',
  'settled',    -- vencedor definido e prêmio pago
  'cancelled',  -- criador desistiu antes do aceite
  'expired',    -- ninguém entrou a tempo
  'voided'      -- anulado por erro/suspeita: apostas devolvidas
);

CREATE TABLE challenges (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code             TEXT NOT NULL UNIQUE,
  creator_id       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  opponent_id      UUID REFERENCES users(id) ON DELETE RESTRICT,
  stake_cents      BIGINT NOT NULL DEFAULT 0 CHECK (stake_cents >= 0),
  -- Comissão da casa em pontos-base (2000 = 20%), congelada na criação para
  -- que uma mudança de preço não altere desafios já em andamento.
  commission_bps   INT NOT NULL DEFAULT 2000 CHECK (commission_bps BETWEEN 0 AND 5000),
  status           challenge_status NOT NULL DEFAULT 'open',
  creator_country  CHAR(2),
  opponent_country CHAR(2),
  winner_id        UUID REFERENCES users(id),
  payout_tx_id     UUID REFERENCES ledger_transactions(id),
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at       TIMESTAMPTZ,

  -- Ninguém joga contra si mesmo: era o buraco do `sim_bot`, que permitia
  -- apostar, declarar a própria vitória e sacar 1,6x do valor apostado.
  CONSTRAINT no_self_play CHECK (opponent_id IS NULL OR opponent_id <> creator_id)
);

CREATE INDEX challenges_open_idx ON challenges (created_at DESC) WHERE status = 'open';
CREATE INDEX challenges_user_idx ON challenges (creator_id, created_at DESC);
CREATE INDEX challenges_expiry_idx ON challenges (expires_at) WHERE status IN ('open', 'staked', 'playing');

CREATE TYPE match_status AS ENUM ('active', 'finished', 'abandoned', 'voided');

CREATE TABLE matches (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id     UUID NOT NULL UNIQUE REFERENCES challenges(id) ON DELETE RESTRICT,
  status           match_status NOT NULL DEFAULT 'active',
  -- Estado autoritativo da partida. A cópia do navegador é só desenho.
  state            JSONB NOT NULL,
  -- Commit-reveal do dado: o hash é publicado agora, o seed só no fim.
  server_seed      TEXT NOT NULL,
  server_seed_hash TEXT NOT NULL,
  client_seed      TEXT NOT NULL,
  seed_revealed_at TIMESTAMPTZ,
  nonce            INT NOT NULL DEFAULT 0,
  color_by_user    JSONB NOT NULL,
  turn_deadline    TIMESTAMPTZ,
  winner_color     TEXT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ
);

CREATE INDEX matches_active_idx ON matches (turn_deadline) WHERE status = 'active';

-- Log append-only de tudo que aconteceu na partida. É com ele que o servidor
-- reexecuta a partida inteira antes de pagar, e é ele que resolve qualquer
-- reclamação de jogador.
CREATE TABLE match_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  match_id    UUID NOT NULL REFERENCES matches(id) ON DELETE RESTRICT,
  seq         INT NOT NULL,
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL,
  actor_id    UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (match_id, seq)
);

CREATE TRIGGER match_events_no_update
  BEFORE UPDATE OR DELETE ON match_events
  FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();

-- ---------------------------------------------------------------------
-- Auditoria e idempotência de requisições
-- ---------------------------------------------------------------------

CREATE TABLE audit_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    UUID REFERENCES users(id),
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail      JSONB,
  ip          INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_actor_idx ON audit_log (actor_id, created_at DESC);
CREATE INDEX audit_action_idx ON audit_log (action, created_at DESC);

-- Respostas memorizadas por chave de idempotência, para que o retry de uma
-- requisição de dinheiro devolva o mesmo resultado em vez de repetir o efeito.
CREATE TABLE request_idempotency (
  key          TEXT PRIMARY KEY,
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code  INT,
  response     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX request_idempotency_cleanup_idx ON request_idempotency (created_at);

-- ---------------------------------------------------------------------
-- Contas de sistema
-- ---------------------------------------------------------------------

INSERT INTO accounts (kind, system_key) VALUES
  ('escrow',        'escrow'),
  ('house_revenue', 'house_revenue'),
  ('pix_gateway',   'pix_gateway'),
  ('bonus',         'bonus')
ON CONFLICT (system_key) DO NOTHING;
