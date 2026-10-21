/**
 * Roteador mínimo sobre `node:http`.
 *
 * Substitui o Express e suas ~60 dependências transitivas. Faz o que este
 * projeto precisa e nada além: rotas com parâmetros, middleware, corpo JSON
 * com limite de tamanho, cookies e respostas padronizadas.
 *
 * O que ele deliberadamente NÃO faz: servir diretório arbitrário, interpretar
 * `__proto__` em query string, aceitar corpo sem limite. Cada uma dessas
 * "conveniências" já foi CVE em algum framework.
 */

import { AppError } from '../lib/errors.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export class Router {
  constructor() {
    this.routes = [];
    this.middlewares = [];
  }

  use(fn) {
    this.middlewares.push(fn);
    return this;
  }

  /** Registra uma rota. O caminho aceita `:param`. */
  add(method, path, ...handlers) {
    if (!METHODS.includes(method)) throw new Error(`Método inválido: ${method}`);
    const names = [];
    // Escapamos tudo que é regex e só então trocamos :param por um grupo.
    const source = path
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
        names.push(name);
        return '/([^/]+)';
      });
    this.routes.push({ method, regex: new RegExp(`^${source}/?$`), names, handlers });
    return this;
  }

  get(p, ...h) { return this.add('GET', p, ...h); }
  post(p, ...h) { return this.add('POST', p, ...h); }
  put(p, ...h) { return this.add('PUT', p, ...h); }
  patch(p, ...h) { return this.add('PATCH', p, ...h); }
  delete(p, ...h) { return this.add('DELETE', p, ...h); }

  match(method, pathname) {
    // HEAD é tratado como GET; o Node descarta o corpo sozinho.
    const effective = method === 'HEAD' ? 'GET' : method;
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== effective) continue;
      const params = {};
      route.names.forEach((name, i) => {
        params[name] = safeDecode(m[i + 1]);
      });
      return { route, params };
    }
    // Diferenciar 404 de 405 ajuda quem integra e não vaza nada sensível.
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/* ------------------------------------------------------------------ */
/* Contexto da requisição                                              */
/* ------------------------------------------------------------------ */

const JSON_LIMIT_BYTES = 64 * 1024; // 64 KB: nenhum endpoint nosso precisa de mais

export function parseCookies(header) {
  const out = Object.create(null); // sem protótipo: imune a __proto__
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k || k === '__proto__') continue;
    out[k] = safeDecode(part.slice(eq + 1).trim());
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  parts.push(`Path=${opts.path ?? '/'}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  // SameSite=Lax é a defesa base contra CSRF: o cookie não acompanha
  // requisições POST vindas de outro site. O token de CSRF é a segunda camada.
  parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

export async function readJsonBody(req) {
  const type = req.headers['content-type'] ?? '';
  if (!type.includes('application/json')) {
    if (!req.headers['content-length'] || req.headers['content-length'] === '0') return {};
    throw new AppError('Envie JSON.', { statusCode: 415, code: 'unsupported_media_type' });
  }
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > JSON_LIMIT_BYTES) {
    throw new AppError('Corpo grande demais.', { statusCode: 413, code: 'payload_too_large' });
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    // Checagem no fluxo, não só no header: Content-Length pode mentir.
    if (total > JSON_LIMIT_BYTES) {
      throw new AppError('Corpo grande demais.', { statusCode: 413, code: 'payload_too_large' });
    }
    chunks.push(chunk);
  }
  if (total === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AppError('O corpo deve ser um objeto JSON.', { statusCode: 400 });
    }
    // Remove __proto__ do nível raiz: protege contra poluição de protótipo
    // caso algum handler faça Object.assign com o corpo.
    delete parsed.__proto__;
    return parsed;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('JSON inválido.', { statusCode: 400, code: 'invalid_json' });
  }
}

/** Lê o corpo cru — o webhook precisa dos bytes exatos para conferir assinatura. */
export async function readRawBody(req, limit = 256 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new AppError('Corpo grande demais.', { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------------ */
/* Resposta                                                            */
/* ------------------------------------------------------------------ */

export function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload ?? {});
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

/** Cabeçalhos de segurança aplicados a toda resposta. */
export function securityHeaders({ isProd, connectSrcExtra = '' } = {}) {
  const csp = [
    "default-src 'self'",
    // O front usa estilos inline nos componentes; scripts, não.
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    `connect-src 'self' ${connectSrcExtra}`.trim(),
    "frame-ancestors 'none'",   // ninguém embute o jogo num iframe para clickjacking
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');

  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
    ...(isProd ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

/** IP do cliente, respeitando X-Forwarded-For só quando confiamos no proxy. */
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) {
      // O primeiro da lista é o cliente original; os demais são proxies.
      const first = fwd.split(',')[0].trim();
      if (first) return first;
    }
  }
  return req.socket.remoteAddress ?? '0.0.0.0';
}
