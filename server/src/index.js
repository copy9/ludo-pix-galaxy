/* API do Ludo Pix Galaxy. Zero dependencias: só o que vem com o Node 22+. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { db, audit } from './db.js';
import {
  hashPassword, verifyPassword, passwordProblem, createSession, destroySession,
  destroyAllSessions, createUser, findByEmail, userFromToken,
  SESSION_COOKIE, sessionCookieOptions,
} from './auth.js';
import { balanceOf, userAccount, statement, auditIntegrity } from './money.js';
import * as Match from './match.js';
import * as Pay from './payments.js';
import * as Profile from './profile.js';
import {
  createRouter, parseCookies, serializeCookie, readBody,
  rateLimit, securityHeaders, json, mimeFor, etagFor, toInt,
} from './http.js';
export { rateLimit };

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const router = createRouter();

/* --------------------------------------------------------- utilidades */

const fail = (res, err) => {
  const map = {
    INSUFFICIENT_FUNDS: [400, 'Saldo insuficiente.'],
    BAD_AMOUNT:  [400, 'Valor invalido.'],
    BAD_STAKE:   [400, 'Valor de aposta invalido.'],
    NOT_FOUND:   [404, 'Nao encontrado.'],
    FORBIDDEN:   [403, 'Sem permissao.'],
    NOT_YOUR_TURN: [409, 'Nao e a sua vez.'],
    ILLEGAL_MOVE: [400, 'Jogada ilegal.'],
    STALE:       [409, 'Estado desatualizado, recarregue.'],
    NOT_OPEN:    [409, 'Desafio nao esta aberto.'],
    SELF_ACCEPT: [400, 'Voce nao pode aceitar o proprio desafio.'],
    EXPIRED:     [410, 'Desafio expirado.'],
    KYC_REQUIRED:[403, 'Verifique sua conta antes de sacar.'],
    SELF_EXCLUDED:[403, 'Conta em autoexclusao.'],
    LIMIT:       [403, err.message],
    ALREADY_ROLLED: [409, 'Dado ja rolado.'],
    NO_DICE:     [409, 'Role o dado antes.'],
    GAME_OVER:   [409, 'Partida encerrada.'],
    NOT_PLAYING: [409, 'Partida nao esta em andamento.'],
    TOO_LARGE:   [413, 'Corpo grande demais.'],
    BAD_PROFILE: [400, err.message],
    UNDERAGE:    [403, err.message],
    CPF_TAKEN:   [409, err.message],
    LIMIT_COOLDOWN: [409, err.message],
  };
  const [status, msg] = map[err.code] || [500, 'Erro interno.'];
  // Erro inesperado nao vaza stack para o cliente — vai so para o log.
  if (status === 500) console.error('[erro]', err);
  json(res, status, { error: err.code || 'internal', message: msg });
};

/** Exige sessao valida; devolve o usuario ou null (ja tendo respondido). */
function auth(ctx) {
  const user = userFromToken(ctx.cookies[SESSION_COOKIE]);
  if (!user) { json(ctx.res, 401, { error: 'nao_autenticado' }); return null; }
  if (user.status === 'blocked') { json(ctx.res, 403, { error: 'conta_bloqueada' }); return null; }
  return user;
}

/** Bloqueia quem esta em pausa ou autoexclusao. So vale para apostar. */
function playable(ctx, user) {
  const now = Date.now();
  if (user.excluded_until > now) { json(ctx.res, 403, { error: 'autoexcluido', until: user.excluded_until }); return false; }
  if (user.paused_until > now)   { json(ctx.res, 403, { error: 'em_pausa', until: user.paused_until }); return false; }
  return true;
}

function limited(ctx, name, max, windowMs = 15 * 60 * 1000) {
  const r = rateLimit(`${name}:${ctx.ip}`, max, windowMs);
  if (!r.ok) {
    ctx.res.setHeader('Retry-After', Math.ceil(r.retryAfter / 1000));
    json(ctx.res, 429, { error: 'muitas_tentativas' });
    return false;
  }
  return true;
}

const setSession = (ctx, userId) => {
  const { token, expiresAt } = createSession(userId, { userAgent: ctx.req.headers['user-agent'], ip: ctx.ip });
  ctx.res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, token, sessionCookieOptions(expiresAt)));
};

/* ------------------------------------------------------------- contas */

router.post('/api/auth/register', async (ctx) => {
  // 40/hora por IP: folgado o bastante para nao derrubar quem esta atras de
  // CGNAT, apertado o bastante para atrapalhar criacao de conta em massa.
  if (!limited(ctx, 'register', Number(process.env.RL_REGISTER) || 40, 3600_000)) return;
  const email = String(ctx.body.email || '').trim().toLowerCase();
  const name  = String(ctx.body.name || '').trim().slice(0, 40);
  const pass  = String(ctx.body.password || '');

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(ctx.res, 400, { error: 'email_invalido' });
  if (name.length < 2) return json(ctx.res, 400, { error: 'nome_curto' });
  const pwErr = passwordProblem(pass);
  if (pwErr) return json(ctx.res, 400, { error: 'senha_fraca', message: pwErr });

  // Resposta deliberadamente vaga: dizer "e-mail ja cadastrado" permite a
  // qualquer um descobrir quem tem conta aqui, so testando e-mails.
  if (findByEmail(email)) return json(ctx.res, 409, { error: 'nao_foi_possivel' });

  const { salt, hash } = await hashPassword(pass);
  const user = createUser({ email, name, passHash: hash, passSalt: salt });
  setSession(ctx, user.id);
  json(ctx.res, 200, { id: user.id, name: user.name, email: user.email, kycLevel: user.kyc_level });
});

router.post('/api/auth/login', async (ctx) => {
  const email = String(ctx.body.email || '').trim().toLowerCase();
  const pass  = String(ctx.body.password || '');

  /* Dois limites, de proposito:
     - por E-MAIL: e o que realmente trava forca bruta contra uma conta, e nao
       pune quem divide o IP com outras mil pessoas via CGNAT;
     - por IP: folgado, so para conter varredura de muitas contas de uma vez. */
  const byEmail = rateLimit(`login-email:${email}`, Number(process.env.RL_LOGIN_EMAIL) || 10, 900_000);
  if (!byEmail.ok) {
    ctx.res.setHeader('Retry-After', Math.ceil(byEmail.retryAfter / 1000));
    audit(null, 'login.throttled', { email }, ctx.ip);
    return json(ctx.res, 429, { error: 'muitas_tentativas' });
  }
  if (!limited(ctx, 'login-ip', Number(process.env.RL_LOGIN_IP) || 100, 900_000)) return;

  const user = findByEmail(email);

  /* Mesmo sem usuario, gastamos o mesmo tempo verificando. Sem isso, o tempo de
     resposta denuncia quais e-mails existem no banco. */
  const ok = user
    ? await verifyPassword(pass, user.pass_salt, user.pass_hash)
    : await verifyPassword(pass, 'dummy', '00'.repeat(64));

  if (!user || !ok) {
    audit(user?.id, 'login.failed', { email }, ctx.ip);
    return json(ctx.res, 401, { error: 'credenciais_invalidas' });
  }
  if (user.status === 'blocked') return json(ctx.res, 403, { error: 'conta_bloqueada' });

  setSession(ctx, user.id);
  audit(user.id, 'login.ok', null, ctx.ip);
  json(ctx.res, 200, { id: user.id, name: user.name, email: user.email, kycLevel: user.kyc_level });
});

router.post('/api/auth/logout', (ctx) => {
  destroySession(ctx.cookies[SESSION_COOKIE]);
  ctx.res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { path: '/', maxAge: 0 }));
  json(ctx.res, 200, { ok: true });
});

router.get('/api/me', (ctx) => {
  const u = auth(ctx); if (!u) return;
  json(ctx.res, 200, {
    id: u.id, name: u.name, email: u.email, kycLevel: u.kyc_level,
    balanceCents: balanceOf(userAccount(u.id)),
    excludedUntil: u.excluded_until, pausedUntil: u.paused_until,
  });
});

router.post('/api/me/password', async (ctx) => {
  const u = auth(ctx); if (!u) return;
  if (!limited(ctx, 'pwchange', 10)) return;

  if (!await verifyPassword(String(ctx.body.current || ''), u.pass_salt, u.pass_hash))
    return json(ctx.res, 401, { error: 'senha_atual_incorreta' });
  const pwErr = passwordProblem(String(ctx.body.next || ''));
  if (pwErr) return json(ctx.res, 400, { error: 'senha_fraca', message: pwErr });

  const { salt, hash } = await hashPassword(String(ctx.body.next));
  db.prepare('UPDATE users SET pass_hash=?, pass_salt=?, updated_at=? WHERE id=?')
    .run(hash, salt, Date.now(), u.id);
  // Trocar a senha derruba as outras sessoes: se alguem tinha acesso, perde agora.
  destroyAllSessions(u.id);
  setSession(ctx, u.id);
  audit(u.id, 'password.changed', null, ctx.ip);
  json(ctx.res, 200, { ok: true });
});

/* ------------------------------------------------- perfil e limites */

router.get('/api/me/profile', (ctx) => {
  const u = auth(ctx); if (!u) return;
  json(ctx.res, 200, { ...Profile.publicProfile(u), balanceCents: balanceOf(userAccount(u.id)) });
});

router.post('/api/me/profile', (ctx) => {
  const u = auth(ctx); if (!u) return;
  try { json(ctx.res, 200, Profile.publicProfile(Profile.updateProfile(u, ctx.body))); }
  catch (err) { fail(ctx.res, err); }
});

router.post('/api/me/limits', (ctx) => {
  const u = auth(ctx); if (!u) return;
  try { json(ctx.res, 200, Profile.publicProfile(Profile.setLimits(u, ctx.body))); }
  catch (err) { fail(ctx.res, err); }
});

router.post('/api/me/pause', (ctx) => {
  const u = auth(ctx); if (!u) return;
  try { json(ctx.res, 200, { pausedUntil: Profile.pause(u, ctx.body.days) }); }
  catch (err) { fail(ctx.res, err); }
});

router.post('/api/me/self-exclude', (ctx) => {
  const u = auth(ctx); if (!u) return;
  try { json(ctx.res, 200, { excludedUntil: Profile.selfExclude(u, ctx.body.days) }); }
  catch (err) { fail(ctx.res, err); }
});

router.post('/api/me/kyc', (ctx) => {
  const u = auth(ctx); if (!u) return;
  try { json(ctx.res, 200, Profile.submitKyc(u, ctx.body)); }
  catch (err) { fail(ctx.res, err); }
});

/* ----------------------------------------------------------- carteira */

router.get('/api/wallet', (ctx) => {
  const u = auth(ctx); if (!u) return;
  json(ctx.res, 200, {
    balanceCents: balanceOf(userAccount(u.id)),
    // Math.max: no SQLite, LIMIT -1 significa "sem limite", entao ?limit=-1
    // devolvia o extrato inteiro de uma vez.
    entries: statement(u.id, Math.max(1, Math.min(100, toInt(ctx.query.get('limit')) || 50))),
  });
});

router.post('/api/wallet/deposit', async (ctx) => {
  const u = auth(ctx); if (!u) return;
  if (!limited(ctx, 'deposit', 20)) return;
  try { json(ctx.res, 200, await Pay.startDeposit({ user: u, amountCents: toInt(ctx.body.amountCents) })); }
  catch (err) { fail(ctx.res, err); }
});

router.post('/api/wallet/withdraw', async (ctx) => {
  const u = auth(ctx); if (!u) return;
  if (!limited(ctx, 'withdraw', 10)) return;
  try {
    json(ctx.res, 200, await Pay.requestWithdrawal({
      user: u, amountCents: toInt(ctx.body.amountCents), pixKey: String(ctx.body.pixKey || ''),
    }));
  } catch (err) { fail(ctx.res, err); }
});

/* ----------------------------------------------------------- desafios */

router.post('/api/challenges', (ctx) => {
  const u = auth(ctx); if (!u || !playable(ctx, u)) return;
  if (!limited(ctx, 'challenge', 30)) return;
  try {
    /* Campo ausente = desafio gratis. Campo PRESENTE mas invalido e erro, nao
       zero: tratar lixo como "gratis" esconde bug do cliente e faz o jogador
       achar que apostou quando nao apostou. */
    const raw = ctx.body.stakeCents;
    let stakeCents = 0;
    if (raw !== undefined && raw !== null && raw !== '') {
      stakeCents = toInt(raw);
      if (stakeCents === null)
        return json(ctx.res, 400, { error: 'BAD_STAKE', message: 'Valor de aposta invalido.' });
    }
    const ch = Match.createChallenge({ userId: u.id, stakeCents });
    json(ctx.res, 200, { code: ch.code, stakeCents: ch.stake_cents, status: ch.status });
  } catch (err) { fail(ctx.res, err); }
});

router.post('/api/challenges/:code/accept', (ctx) => {
  const u = auth(ctx); if (!u || !playable(ctx, u)) return;
  if (!limited(ctx, 'accept', 30)) return;
  try {
    const ch = Match.acceptChallenge({ code: ctx.params.code.toUpperCase(), userId: u.id });
    json(ctx.res, 200, { code: ch.code, status: ch.status });
  } catch (err) { fail(ctx.res, err); }
});

router.post('/api/challenges/:code/cancel', (ctx) => {
  const u = auth(ctx); if (!u) return;
  try { json(ctx.res, 200, Match.cancelChallenge({ code: ctx.params.code.toUpperCase(), userId: u.id })); }
  catch (err) { fail(ctx.res, err); }
});

router.get('/api/challenges/:code', (ctx) => {
  const u = auth(ctx); if (!u) return;
  try {
    const code = ctx.params.code.toUpperCase();
    const ch = db.prepare('SELECT * FROM challenges WHERE code = ?').get(code);
    if (!ch) return json(ctx.res, 404, { error: 'NOT_FOUND' });
    const m = Match.loadMatch(code);
    if (!m) {
      return json(ctx.res, 200, {
        code: ch.code, status: ch.status, stakeCents: ch.stake_cents,
        isCreator: ch.creator_id === u.id, yourColor: Match.colorOf(ch, u.id),
      });
    }
    json(ctx.res, 200, Match.publicState(ch, m, u.id));
  } catch (err) { fail(ctx.res, err); }
});

router.post('/api/challenges/:code/forfeit', (ctx) => {
  const u = auth(ctx); if (!u) return;
  try { json(ctx.res, 200, Match.forfeit({ code: ctx.params.code.toUpperCase(), userId: u.id })); }
  catch (err) { fail(ctx.res, err); }
});

router.post('/api/challenges/:code/roll', (ctx) => {
  const u = auth(ctx); if (!u) return;
  if (!limited(ctx, 'roll', 600)) return;
  try {
    json(ctx.res, 200, Match.rollDice({
      code: ctx.params.code.toUpperCase(), userId: u.id, version: ctx.body.version,
    }));
  } catch (err) { fail(ctx.res, err); }
});

router.post('/api/challenges/:code/move', (ctx) => {
  const u = auth(ctx); if (!u) return;
  if (!limited(ctx, 'move', 600)) return;
  try {
    json(ctx.res, 200, Match.makeMove({
      code: ctx.params.code.toUpperCase(), userId: u.id,
      tokenIdx: toInt(ctx.body.tokenIdx), version: ctx.body.version,
    }));
  } catch (err) { fail(ctx.res, err); }
});

/* -------------------------------------------------------- manutencao */

router.get('/api/health', (ctx) => json(ctx.res, 200, { ok: true, ts: Date.now() }));

router.get('/api/_audit', (ctx) => {
  // Em producao exige token de admin; sem ADMIN_TOKEN definido, so responde em dev.
  if (process.env.ADMIN_TOKEN) {
    if (ctx.req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN)
      return json(ctx.res, 403, { error: 'forbidden' });
  } else if (process.env.NODE_ENV === 'production') {
    return json(ctx.res, 403, { error: 'forbidden' });
  }
  json(ctx.res, 200, auditIntegrity());
});

/* --------------------------------------------------- arquivos do front */

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';

  // Normaliza e confere que o caminho final continua DENTRO da raiz: sem isto,
  // "../../etc/passwd" sairia do diretorio e serviria arquivo do sistema.
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    res.writeHead(403); return res.end('forbidden');
  }
  // Nunca servir o servidor, o banco ou o .git pela web.
  if (/^(server|\.git|node_modules)(\/|$)/.test(path.relative(ROOT, abs))) {
    res.writeHead(404); return res.end('nao encontrado');
  }

  let file = abs;
  if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('nao encontrado');
  }

  const buf = fs.readFileSync(file);
  const etag = etagFor(buf);
  if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }

  securityHeaders(res);
  res.writeHead(200, {
    'Content-Type': mimeFor(path.extname(file)),
    'ETag': etag,
    'Cache-Control': /\.(webp|png|jpg|svg|woff2)$/.test(file) ? 'public, max-age=86400' : 'no-cache',
  });
  res.end(buf);
}

/* ------------------------------------------------------- servidor */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ip = (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for']?.split(',')[0].trim())
    || req.socket.remoteAddress || 'desconhecido';

  try {
    /* Webhook primeiro, e com o corpo CRU: a assinatura HMAC e calculada sobre
       os bytes exatos que o gateway enviou. Reserializar o JSON muda espacos e
       ordem de chaves, e a assinatura nunca mais bate. */
    if (req.method === 'POST' && url.pathname === '/api/webhooks/psp') {
      const raw = await readBody(req, 1024 * 1024);
      const rawBody = raw.toString('utf8');
      const signature = req.headers['x-signature'] || req.headers['x-hub-signature-256'] || req.headers['signature'];

      if (!Pay.gateway.verifyWebhook({ rawBody, signature })) {
        audit(null, 'webhook.bad_signature', { ip }, ip);
        return json(res, 401, { error: 'assinatura_invalida' });
      }
      let event;
      try { event = Pay.gateway.parseEvent(JSON.parse(rawBody)); }
      catch { return json(res, 400, { error: 'corpo_invalido' }); }
      if (!event.id) return json(res, 400, { error: 'evento_sem_id' });

      try {
        // 200 sempre que o evento foi aceito: devolver erro faz o gateway
        // reenviar em laco. Problema de negocio vai para o log, nao para o status.
        return json(res, 200, { ok: true, ...Pay.handleWebhookEvent({ rawBody, event }) });
      } catch (err) {
        console.error('[webhook]', err);
        return json(res, 500, { error: 'erro_interno' });
      }
    }

    const hit = router.match(req.method, url.pathname);

    if (!hit) {
      if (req.method === 'GET') return serveStatic(req, res, url.pathname);
      return json(res, 404, { error: 'rota_nao_encontrada' });
    }

    securityHeaders(res, { csp: false });

    const ctx = { req, res, ip, params: hit.params, query: url.searchParams, body: {}, cookies: parseCookies(req.headers.cookie) };

    if (req.method === 'POST') {
      /* Anti-CSRF: so aceitamos POST vindo da nossa propria origem.
         O cookie de sessao e SameSite=Lax, o que ja barra a maioria dos casos;
         conferir Origin fecha o resto. */
      const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
      const origin = req.headers.origin;
      const referer = req.headers.referer;
      const temSessao = !!parseCookies(req.headers.cookie)[SESSION_COOKIE];

      const okOrigem = (valor) => {
        try {
          const u = new URL(valor);
          return u.host === req.headers.host || allowed.includes(u.origin);
        } catch { return false; }
      };

      if (origin) {
        if (!okOrigem(origin)) return json(res, 403, { error: 'origem_nao_permitida' });
      } else if (temSessao) {
        /* Sem `Origin`, antes a checagem era simplesmente PULADA — a defesa
           virava apenas o SameSite=Lax do cookie. Numa requisicao que carrega
           sessao, ausencia de origem e sinal de que ela nao veio da nossa
           pagina, entao exigimos ao menos um Referer nosso. */
        if (!referer || !okOrigem(referer))
          return json(res, 403, { error: 'origem_ausente' });
      }
      const raw = await readBody(req);
      if (raw.length) {
        try { ctx.body = JSON.parse(raw.toString('utf8')); }
        catch { return json(res, 400, { error: 'json_invalido' }); }
      }
    }

    for (const h of hit.handlers) {
      await h(ctx);
      if (res.writableEnded) break;
    }
    if (!res.writableEnded) json(res, 204, {});
  } catch (err) {
    if (!res.writableEnded) fail(res, err);
  }
});

/* Faxina periodica. Sem ela, dinheiro fica preso:
   - expireStale: desafio que ninguem aceitou -> devolve ao criador;
   - forfeitIdle: partida comecada e abandonada -> W.O. ou reembolso.
   Roda a cada minuto porque o segundo caso envolve dinheiro de DOIS jogadores
   parado, e ninguem deve esperar dez minutos para receber o que e seu. */
setInterval(() => {
  try { Match.expireStale(); } catch (e) { console.error('[faxina] expireStale', e); }
  try { Match.forfeitIdle(); } catch (e) { console.error('[faxina] forfeitIdle', e); }
}, 60 * 1000).unref();

if (process.env.NODE_ENV === 'production') {
  for (const v of ['PSP_API_KEY', 'PSP_WEBHOOK_SECRET']) {
    if (!process.env[v]) { console.error(`[fatal] ${v} nao definido`); process.exit(1); }
  }
}

const PORT = Number(process.env.PORT) || 3000;
if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => console.log(`Ludo Pix Galaxy — API em http://localhost:${PORT}`));
}

export default server;
