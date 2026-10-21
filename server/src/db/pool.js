/**
 * Pool de conexões e helper de transação.
 *
 * Tudo que mexe em dinheiro passa por `withTransaction`. Se qualquer passo
 * lançar, a transação inteira volta atrás — não existe estado meio pago.
 */

import pg from 'pg';
import { config, isProd } from '../config.js';

// BIGINT (int8) chega como string no driver para não perder precisão acima de
// 2^53. Nossos valores em centavos cabem com folga em Number, então
// convertemos — mas de forma explícita e verificada, não por acidente.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`Valor BIGINT fora da faixa segura de JavaScript: ${value}`);
  }
  return n;
});

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  ssl: config.DATABASE_SSL ? { rejectUnauthorized: true } : false,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // Uma query presa não pode segurar uma conexão para sempre.
  statement_timeout: 15_000,
});

pool.on('error', (err) => {
  console.error('[db] erro em conexão ociosa:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

/**
 * Executa `fn` dentro de uma transação.
 *
 * `isolation` padrão é READ COMMITTED; para operações de dinheiro que leem e
 * depois escrevem o mesmo saldo usamos SELECT ... FOR UPDATE, que já serializa
 * a linha. Onde isso não basta, passe 'serializable'.
 */
export async function withTransaction(fn, { isolation } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (isolation === 'serializable') {
      await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] falha no rollback:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Repete uma transação que falhou por conflito de serialização.
 * Sob concorrência o Postgres aborta uma das transações (40001); repetir é o
 * comportamento correto, não um erro para mostrar ao usuário.
 */
export async function withRetryableTransaction(fn, { attempts = 3, isolation = 'serializable' } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await withTransaction(fn, { isolation });
    } catch (err) {
      const retryable = err?.code === '40001' || err?.code === '40P01'; // serialization / deadlock
      if (!retryable) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 25 * 2 ** i + Math.random() * 25));
    }
  }
  throw lastErr;
}

export async function closePool() {
  await pool.end();
}

if (!isProd) {
  // Em desenvolvimento, avisa se o banco não responde logo no boot.
  pool
    .query('SELECT 1')
    .catch((err) => console.error('[db] não consegui conectar:', err.message));
}
