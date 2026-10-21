/**
 * Montagem da aplicação: middleware, rotas e tratamento de erro.
 *
 * A ordem importa e é deliberada:
 *   1. cabeçalhos de segurança (toda resposta, inclusive as de erro)
 *   2. identificação da sessão
 *   3. checagem de origem e CSRF (antes de qualquer handler que escreve)
 *   4. rate limit geral
 *   5. rota
 *
 * O tratamento de erro no fim converte qualquer exceção em JSON e NUNCA
 * vaza stack trace nem mensagem do Postgres para o cliente.
 */

import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { config, isProd } from '../config.js';
import { withTransaction } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { ValidationError } from '../lib/validate.js';
import { MoneyError } from '../lib/money.js';
import {
  Router, parseCookies, readJsonBody, sendJson, securityHeaders, clientIp,
} from './router.js';
import { limits } from './rate-limit.js';
import { loadSession, verifyCsrf, verifyOrigin, requireAuth, requireAdmin, SESSION_COOKIE } from '../modules/auth/sessions.js';
import { registerAuthRoutes } from '../modules/auth/routes.js';
import { registerWalletRoutes } from '../modules/wallet/routes.js';
import { registerPaymentRoutes } from '../modules/payments/routes.js';
import { registerChallengeRoutes } from '../modules/challenges/routes.js';
import { registerMatchRoutes } from '../modules/matches/routes.js';
import { registerUserRoutes } from '../modules/users/routes.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function createApp({ provider, publicDir }) {
  const router = new Router();

  registerAuthRoutes(router);
  registerUserRoutes(router);
  registerWalletRoutes(router);
  registerPaymentRoutes(router, { provider });
  registerChallengeRoutes(router);
  registerMatchRoutes(router);

  router.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));

  return async function handle(req, res) {
    const headers = securityHeaders({ isProd });
    for (const [k, value] of Object.entries(headers)) res.setHeader(k, value);

    let url;
    try {
      url = new URL(req.url, config.PUBLIC_URL);
    } catch {
      return sendJson(res, 400, { error: 'Requisição inválida.' });
    }
    const pathname = decodeURIComponent(url.pathname);

    // --- arquivos estáticos ---
    if (!pathname.startsWith('/api/')) {
      return serveStatic(req, res, pathname, publicDir);
    }

    const cookies = parseCookies(req.headers.cookie);
    const ctx = {
      req, res, url, pathname,
      method: req.method,
      ip: clientIp(req, config.TRUST_PROXY),
      query: Object.fromEntries(url.searchParams),
      params: {},
      body: {},
      user: null,
      session: null,
      cookiesToSet: [],
      setCookies(list) { this.cookiesToSet.push(...list); },
      requireAuth: () => requireAuth(ctx),
      requireAdmin: () => requireAdmin(ctx),
    };

    try {
      const match = router.match(req.method, pathname);
      if (!match) return sendJson(res, 404, { error: 'Rota não encontrada.', code: 'not_found' });
      if (match.methodNotAllowed) {
        return sendJson(res, 405, { error: 'Método não permitido.', code: 'method_not_allowed' });
      }
      ctx.params = match.params;

      // Sessão antes do corpo: o rate limit de login usa o e-mail do corpo,
      // então o corpo também precisa vir antes dos limitadores dos handlers.
      const token = cookies[SESSION_COOKIE];
      if (token) {
        const session = await withTransaction((client) => loadSession(client, token));
        if (session) {
          ctx.session = session;
          ctx.user = session;
        }
      }

      // O webhook precisa dos BYTES CRUS para conferir a assinatura, então o
      // corpo NÃO pode ser consumido aqui — o handler o lê por conta própria.
      // Ler como JSON antes esvaziaria o fluxo e a assinatura nunca bateria.
      const isWebhook = pathname.startsWith('/api/webhooks/');
      if (!isWebhook && !['GET', 'HEAD'].includes(req.method)) {
        ctx.body = await readJsonBody(req);
      }

      verifyOrigin(ctx);
      verifyCsrf(ctx);
      limits.general(ctx);

      let result;
      for (const handler of match.route.handlers) {
        result = await handler(ctx);
        if (res.writableEnded) return undefined; // handler já respondeu (ex.: SSE)
      }

      const extra = {};
      if (ctx.cookiesToSet.length) extra['Set-Cookie'] = ctx.cookiesToSet;
      return sendJson(res, result?.__status ?? 200, result ?? { ok: true }, extra);
    } catch (err) {
      return handleError(err, ctx, res);
    }
  };
}

function handleError(err, ctx, res) {
  if (res.writableEnded) return undefined;

  if (err instanceof ValidationError) {
    return sendJson(res, 400, { error: err.message, code: err.code, issues: err.issues });
  }
  if (err instanceof MoneyError) {
    return sendJson(res, 400, { error: err.message, code: 'invalid_amount' });
  }
  if (err instanceof AppError) {
    const extra = {};
    if (err.retryAfter) extra['Retry-After'] = String(err.retryAfter);
    return sendJson(
      res,
      err.statusCode,
      {
        // `expose: false` esconde o detalhe do cliente mas mantém no log.
        error: err.expose ? err.message : 'Não foi possível concluir a operação.',
        code: err.code,
        detail: err.expose ? err.detail : undefined,
      },
      extra,
    );
  }

  // Erro não previsto: o cliente recebe uma mensagem genérica e nós
  // registramos o resto. Mensagem do Postgres é material de reconhecimento.
  const ref = Math.random().toString(36).slice(2, 10);
  console.error(`[erro ${ref}] ${ctx?.method} ${ctx?.pathname}:`, err);
  return sendJson(res, 500, {
    error: 'Erro interno. Se persistir, informe o código ao suporte.',
    code: 'internal',
    ref,
  });
}

/** Servidor de arquivos estáticos, restrito ao diretório público. */
async function serveStatic(req, res, pathname, publicDir) {
  if (!['GET', 'HEAD'].includes(req.method)) {
    return sendJson(res, 405, { error: 'Método não permitido.' });
  }

  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  // `normalize` resolve os ".." e a checagem seguinte barra qualquer coisa
  // que ainda tente sair do diretório público.
  rel = normalize(rel);
  if (rel.startsWith('..') || rel.includes('\0')) {
    return sendJson(res, 400, { error: 'Caminho inválido.' });
  }

  const full = join(publicDir, rel);
  if (!full.startsWith(publicDir)) {
    return sendJson(res, 403, { error: 'Acesso negado.' });
  }

  try {
    const info = await stat(full);
    if (info.isDirectory()) return serveStatic(req, res, `${pathname}/index.html`, publicDir);

    const ext = extname(full).toLowerCase();
    const body = await readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': body.length,
      // Sprites têm hash no nome, então podem ser cacheados para sempre.
      // HTML não: precisa refletir um deploy novo na hora.
      'Cache-Control': rel.startsWith('assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    });
    return res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Não encontrado');
  }
}
