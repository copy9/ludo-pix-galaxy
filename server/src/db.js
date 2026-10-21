/* Esquema e conexao com o banco.
 *
 * Usa o `node:sqlite` embutido no Node 22+ — nenhuma dependencia externa.
 * Para um sistema que mexe com dinheiro isso e vantagem, nao limitacao:
 * cada pacote de terceiros e uma porta a mais para supply chain attack, e o
 * driver do banco e o lugar onde isso doeria mais.
 *
 * A API e sincrona de proposito: uma transacao inteira acontece dentro de uma
 * funcao, sem `await` no meio. Isso elimina toda uma classe de bug de
 * concorrencia em codigo que movimenta saldo.
 *
 * O esquema e SQL padrao o bastante para migrar a Postgres depois; o que muda
 * e o shim de transacao abaixo.
 */
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const DATA_DIR = process.env.DATA_DIR
  || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const raw = new DatabaseSync(path.join(DATA_DIR, 'ludopix.db'));

raw.exec('PRAGMA journal_mode = WAL');
raw.exec('PRAGMA foreign_keys = ON');
// Sem isto o SQLite confirma a escrita antes de ela chegar ao disco: numa queda
// de energia o ultimo commit pode evaporar. Para dinheiro, nao vale a troca.
raw.exec('PRAGMA synchronous = FULL');
// Em vez de devolver SQLITE_BUSY na hora, espera o lock por ate 5s.
raw.exec('PRAGMA busy_timeout = 5000');

/* ------------------------------------------------------- transacoes
 * Recria o `db.transaction(fn)` do better-sqlite3 sobre o node:sqlite.
 *
 * Suporta aninhamento via SAVEPOINT, que e essencial aqui: createChallenge()
 * e uma transacao e por dentro chama postTransaction(), que tambem e. Sem
 * savepoint, o COMMIT de dentro fecharia a transacao de fora no meio do
 * caminho e um erro posterior deixaria gravado o que deveria ter sido desfeito.
 */
let depth = 0;
function transaction(fn) {
  return function (...args) {
    const top = depth === 0;
    const sp = `sp_${depth}`;
    raw.exec(top ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    depth++;
    try {
      const out = fn.apply(this, args);
      depth--;
      raw.exec(top ? 'COMMIT' : `RELEASE ${sp}`);
      return out;
    } catch (err) {
      depth--;
      try { raw.exec(top ? 'ROLLBACK' : `ROLLBACK TO ${sp}`); } catch { /* ja desfeito */ }
      throw err;
    }
  };
}

export const db = {
  prepare: (sql) => raw.prepare(sql),
  exec: (sql) => raw.exec(sql),
  transaction,
  close: () => raw.close(),
  raw,
};

db.exec(`
-- ---------------------------------------------------------------- contas
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  pass_hash    TEXT NOT NULL,          -- scrypt, ver auth.js
  pass_salt    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',  -- active | blocked
  kyc_level    INTEGER NOT NULL DEFAULT 1,      -- 1 criada, 2 dados completos, 3 verificada
  full_name    TEXT, cpf TEXT, birth TEXT, phone TEXT, country TEXT,
  excluded_until INTEGER NOT NULL DEFAULT 0,
  paused_until   INTEGER NOT NULL DEFAULT 0,
  deposit_limit_day_cents   INTEGER,
  deposit_limit_week_cents  INTEGER,
  deposit_limit_month_cents INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
-- CPF unico, mas so entre quem preencheu (varios NULL sao permitidos).
CREATE UNIQUE INDEX IF NOT EXISTS users_cpf_uniq ON users(cpf) WHERE cpf IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,         -- guardamos o HASH, nunca o token em si
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- ------------------------------------------------------- livro-razao
-- Partidas dobradas: toda movimentacao e um tx com pernas que somam ZERO.
-- Dinheiro nunca "aparece" nem "some" — ele muda de conta.
--   user:<id>      carteira de um jogador
--   escrow:<code>  valor preso num desafio em andamento
--   house:rake     comissao da plataforma
--   external:psp   mundo exterior (entrou/saiu pelo gateway)
-- Saldo de qualquer conta = SUM(amount_cents). Valores SEMPRE em centavos
-- inteiros: ponto flutuante perde centavo (0.1+0.2 !== 0.3).
CREATE TABLE IF NOT EXISTS ledger_tx (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,      -- deposit | withdrawal | stake | payout | rake | refund | adjustment
  idempotency_key TEXT UNIQUE,        -- repetir a mesma chave NAO duplica o lancamento
  memo            TEXT,
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_entry (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id        TEXT NOT NULL REFERENCES ledger_tx(id),
  account      TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,      -- positivo credita, negativo debita
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_entry_account ON ledger_entry(account, id);
CREATE INDEX IF NOT EXISTS ledger_entry_tx ON ledger_entry(tx_id);

-- O razao e append-only. Corrigir erro se faz com lancamento de estorno,
-- nunca apagando historico: o extrato precisa bater com o que aconteceu.
CREATE TRIGGER IF NOT EXISTS ledger_entry_no_update
BEFORE UPDATE ON ledger_entry
BEGIN SELECT RAISE(ABORT, 'livro-razao e imutavel: use um lancamento de estorno'); END;
CREATE TRIGGER IF NOT EXISTS ledger_entry_no_delete
BEFORE DELETE ON ledger_entry
BEGIN SELECT RAISE(ABORT, 'livro-razao e imutavel: use um lancamento de estorno'); END;

-- Cache do saldo. A verdade e o razao; isto evita somar a tabela inteira a cada
-- leitura e e atualizado DENTRO da mesma transacao que grava as pernas.
CREATE TABLE IF NOT EXISTS balances (
  account       TEXT PRIMARY KEY,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

-- ------------------------------------------------------------- desafios
CREATE TABLE IF NOT EXISTS challenges (
  code        TEXT PRIMARY KEY,
  creator_id  TEXT NOT NULL REFERENCES users(id),
  opponent_id TEXT REFERENCES users(id),
  stake_cents INTEGER NOT NULL DEFAULT 0,
  rake_bps    INTEGER NOT NULL DEFAULT 2000,   -- 2000 = 20,00%
  status      TEXT NOT NULL,   -- waiting | both_staked | resolved | cancelled | expired
  winner_id   TEXT REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS challenges_creator ON challenges(creator_id);
CREATE INDEX IF NOT EXISTS challenges_status  ON challenges(status);

-- Estado da partida. Mora no servidor: o navegador so desenha o que vem daqui.
CREATE TABLE IF NOT EXISTS matches (
  code        TEXT PRIMARY KEY REFERENCES challenges(code),
  state_json  TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 0,   -- trava otimista contra jogada dupla
  updated_at  INTEGER NOT NULL
);

-- Cada rolagem fica registrada com a semente, para auditar depois que o dado
-- nao foi escolhido a dedo (provably fair).
CREATE TABLE IF NOT EXISTS dice_rolls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL REFERENCES challenges(code),
  user_id     TEXT NOT NULL REFERENCES users(id),
  value       INTEGER NOT NULL,
  server_seed TEXT NOT NULL,
  nonce       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS dice_rolls_code ON dice_rolls(code);

-- --------------------------------------------------------- pagamentos
CREATE TABLE IF NOT EXISTS payments (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  direction     TEXT NOT NULL,     -- in (deposito) | out (saque)
  amount_cents  INTEGER NOT NULL,
  status        TEXT NOT NULL,     -- pending | paid | failed | cancelled
  provider      TEXT NOT NULL,
  provider_ref  TEXT,              -- id da cobranca no gateway
  method        TEXT,              -- pix | card
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_user ON payments(user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_ref
  ON payments(provider, provider_ref) WHERE provider_ref IS NOT NULL;

-- Gateways reenviam webhook. Guardar o id do evento e o que impede creditar
-- o mesmo deposito duas vezes.
CREATE TABLE IF NOT EXISTS webhook_events (
  provider    TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  payload     TEXT NOT NULL,
  PRIMARY KEY (provider, event_id)
);

-- Trilha de auditoria de tudo que for sensivel.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT,
  action     TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_user ON audit_log(user_id, created_at);
`);

export function audit(userId, action, detail, ip) {
  db.prepare('INSERT INTO audit_log (user_id,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(userId || null, action, detail ? JSON.stringify(detail) : null, ip || null, Date.now());
}

export default db;
