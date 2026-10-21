/**
 * Executor de migrações.
 *
 * Cada arquivo em `migrations/` roda uma vez, em ordem, dentro de uma
 * transação. Se um falhar no meio, ele volta inteiro — nunca fica um schema
 * pela metade.
 *
 * Um `advisory lock` impede que dois processos subindo ao mesmo tempo (o caso
 * normal num deploy com várias instâncias) rodem a mesma migração em paralelo.
 */

import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTransaction, closePool } from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const LOCK_ID = 918_273_645; // qualquer inteiro fixo serve, desde que só este projeto o use

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

export async function migrate({ verbose = true } = {}) {
  const log = verbose ? console.log : () => {};
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  const client = await pool.connect();
  let applied = 0;
  try {
    // Fila: a segunda instância espera aqui em vez de duplicar o trabalho.
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await ensureTable(client);

    const { rows: done } = await client.query(`SELECT filename, checksum FROM schema_migrations`);
    const seen = new Map(done.map((r) => [r.filename, r.checksum]));

    for (const filename of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');

      if (seen.has(filename)) {
        // Migração já aplicada que MUDOU é quase sempre um erro: alguém
        // editou um arquivo já rodado em vez de criar um novo.
        if (seen.get(filename) !== checksum) {
          throw new Error(
            `A migração ${filename} já foi aplicada mas o arquivo mudou.\n` +
            `Crie uma migração nova em vez de editar uma já aplicada.`,
          );
        }
        continue;
      }

      log(`  → aplicando ${filename}`);
      await withTransaction(async (tx) => {
        await tx.query(sql);
        await tx.query(
          `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)`,
          [filename, checksum],
        );
      });
      applied += 1;
    }

    log(applied ? `  ${applied} migração(ões) aplicada(s).` : '  Banco já está atualizado.');
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

// Permite rodar como script: `npm run migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('\n  Falha na migração:', err.message, '\n');
      await closePool().catch(() => {});
      process.exit(1);
    });
}
