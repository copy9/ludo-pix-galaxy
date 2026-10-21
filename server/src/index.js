/**
 * Ponto de entrada.
 *
 * Sobe o HTTP, roda as migrações, carrega o provedor de pagamento e liga as
 * tarefas periódicas. Encerra com elegância ao receber SIGTERM, para que um
 * deploy não corte uma transação de dinheiro no meio.
 */

import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, isProd } from './config.js';
import { pool, closePool, withTransaction } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createApp } from './http/app.js';
import { loadProvider } from './modules/payments/provider.js';
import { expireStaleDeposits } from './modules/payments/deposits.js';
import { expireStaleChallenges } from './modules/challenges/challenges.js';
import { sweepTimeouts } from './modules/matches/matches.js';
import { flushPendingLimits } from './modules/users/responsible-gaming.js';
import { purgeExpiredSessions } from './modules/auth/sessions.js';
import { reconcile } from './modules/wallet/ledger.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');

async function main() {
  console.log(`\n  Ludo Pix Galaxy — ${config.NODE_ENV}`);

  console.log('  Migrando o banco…');
  await migrate({ verbose: true });

  const provider = await loadProvider(config);
  console.log(`  Provedor de pagamento: ${provider.name}`);
  if (provider.name === 'mock') {
    console.warn('  ATENÇÃO: provedor simulado — credita saldo sem cobrar ninguém.');
  }

  const app = createApp({ provider, publicDir: PUBLIC_DIR });
  const server = http.createServer(app);

  // Um cliente lento não pode segurar um socket para sempre.
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  // SSE precisa de conexão longa; 0 desliga o limite de keep-alive ocioso.
  server.keepAliveTimeout = 65_000;

  // `listen` emite 'error' em vez de rejeitar; sem este tratamento, uma porta
  // ocupada derruba o processo com um stack trace em vez de uma mensagem útil.
  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`A porta ${config.PORT} já está em uso. Pare o outro processo ou mude PORT.`));
      } else if (err.code === 'EACCES') {
        reject(new Error(`Sem permissão para usar a porta ${config.PORT}. Portas abaixo de 1024 exigem privilégio.`));
      } else {
        reject(err);
      }
    });
    server.listen(config.PORT, resolve);
  });
  console.log(`  Ouvindo em ${config.PUBLIC_URL} (porta ${config.PORT})\n`);

  const timers = startBackgroundJobs();

  /* ---------------- encerramento elegante ---------------- */
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n  ${signal} recebido; encerrando…`);

    for (const t of timers) clearInterval(t);
    // Para de aceitar conexão nova, mas deixa as em andamento terminarem —
    // é o que evita cortar uma transação de pagamento no meio do deploy.
    server.close();

    const force = setTimeout(() => {
      console.error('  Conexões não encerraram a tempo; saindo à força.');
      process.exit(1);
    }, 15_000);
    force.unref();

    try { await closePool(); } catch { /* já estava fechado */ }
    console.log('  Encerrado.\n');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Uma exceção não tratada deixa o processo num estado desconhecido. Com
  // dinheiro envolvido, sair e deixar o supervisor reiniciar é mais seguro
  // do que seguir adiante fingindo que está tudo bem.
  process.on('unhandledRejection', (reason) => {
    console.error('  Promessa rejeitada sem tratamento:', reason);
    if (isProd) shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    console.error('  Exceção não capturada:', err);
    shutdown('uncaughtException');
  });
}

function startBackgroundJobs() {
  const every = (ms, name, fn) => {
    const timer = setInterval(() => {
      fn().catch((err) => console.error(`[job:${name}]`, err.message));
    }, ms);
    timer.unref();
    return timer;
  };

  return [
    // Turno estourado: impede que alguém trave uma partida valendo dinheiro
    // simplesmente fechando o navegador.
    every(10_000, 'turnos', async () => { await sweepTimeouts(); }),

    every(60_000, 'desafios', async () => { await expireStaleChallenges(); }),

    every(60_000, 'cobrancas', async () => {
      await withTransaction((client) => expireStaleDeposits(client));
    }),

    every(300_000, 'limites', async () => {
      await withTransaction((client) => flushPendingLimits(client));
    }),

    every(3_600_000, 'sessoes', async () => {
      await withTransaction((client) => purgeExpiredSessions(client));
    }),

    // Conciliação de caixa. Se um dia não fechar, você descobre por aqui e
    // não por um jogador reclamando.
    every(900_000, 'conciliacao', async () => {
      const result = await withTransaction((client) => reconcile(client));
      if (!result.ok) {
        console.error(
          '  ALERTA DE CAIXA: o razão não fecha.',
          `soma=${result.ledgerSum}`,
          `contas divergentes=${result.driftingAccounts.length}`,
        );
        // Ligue aqui o seu alarme (PagerDuty, Sentry, e-mail). Divergência
        // de caixa é incidente, não aviso.
      }
    }),
  ];
}

main().catch(async (err) => {
  console.error('\n  Falha ao subir o servidor:', err);
  await closePool().catch(() => {});
  process.exit(1);
});
