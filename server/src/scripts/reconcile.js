/**
 * Conferência de caixa sob demanda.
 *
 *   npm run reconcile
 *
 * Sai com código 0 se o caixa fecha e 1 se não fecha, para dar para ligar
 * num monitoramento ou num cron sem interpretar texto.
 */

import { withTransaction, closePool } from '../db/pool.js';
import { reconcile } from '../modules/wallet/ledger.js';
import { formatBRL } from '../lib/money.js';

const result = await withTransaction((client) => reconcile(client));

console.log('\n  Conferência de caixa\n');
console.log(`  Soma de todos os lançamentos: ${result.ledgerSum} centavos ` +
            `(precisa ser 0) ${result.balanced ? '✔' : '✘'}`);

if (result.driftingAccounts.length === 0) {
  console.log('  Nenhuma conta com saldo divergente do razão ✔');
} else {
  console.log(`\n  ${result.driftingAccounts.length} conta(s) DIVERGENTE(S):\n`);
  for (const a of result.driftingAccounts) {
    const nome = a.system_key ?? `carteira ${String(a.user_id).slice(0, 8)}`;
    console.log(`    ${nome}: cache ${formatBRL(a.cached)} vs razão ${formatBRL(a.computed)}`);
  }
  console.log(
    '\n  Divergência significa que alguém escreveu em accounts.balance_cents\n' +
    '  por fora do razão, ou que houve falha parcial numa transação.\n' +
    '  NÃO "corrija" o saldo à mão: investigue a origem primeiro.\n',
  );
}

console.log(result.ok ? '\n  Caixa fecha.\n' : '\n  CAIXA NÃO FECHA — investigue.\n');

await closePool();
process.exit(result.ok ? 0 : 1);
