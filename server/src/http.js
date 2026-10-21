/* Roteador HTTP minimo sobre node:http.
 *
 * Sem Express de proposito. Num servico que guarda dinheiro, cada dependencia e
 * uma porta a mais de supply chain attack, e aqui o que Express faria cabe em
 * 150 linhas que dao para ler inteiras.
 *
 * O que ele faz: rotas com parametro (/api/x/:code), JSON, cookies, corpo cru
 * para webhook, limite de taxa e cabecalhos de seguranca.
 */
import { createHash } from 'node:crypto';

export function createRouter() {
  const routes = [];

  const add = (method, pattern, ...handlers) => {
    const names = [];
    const regex = new RegExp('^' + pattern.replace(/:[A-Za-z_]\w*/g, (m) => {
      names.push(m.slice(1));
      return '([^/]+)';
    }) + '/?$');
    routes.push({ method, regex, names, handlers });
  };

  return {
    get:  (p, ...h) => add('GET', p, ...h),
    post: (p, ...h) => add('POST', p, ...h),
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = pathname.match(r.regex);
        if (!m) continue;
        const params = {};
        r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
        return { handlers: r.handlers, params };
      }
      return null;
    },
  };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function serializeCookie(name, value, o = {}) {
  let s = `${name}=${encodeURIComponent(value)}`;
  if (o.path) s += `; Path=${o.path}`;
  if (o.expires) s += `; Expires=${new Date(o.expires).toUTCString()}`;
  if (o.maxAge != null) s += `; Max-Age=${o.maxAge}`;
  if (o.httpOnly) s += '; HttpOnly';
  if (o.secure) s += '; Secure';
  if (o.sameSite) s += `; SameSite=${o.sameSite}`;
  return s;
}

/** Le o corpo com teto de tamanho: sem isto um POST gigante derruba o processo. */
export function readBody(req, limitBytes = 100 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('corpo grande demais'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* Limite de taxa em memoria, por chave (IP+rota, ou e-mail+rota).
 *
 * Serve para um processo so. Com varias instancias, troque por Redis — senao
 * cada instancia conta separado e o limite efetivo vira N vezes maior.
 *
 * CUIDADO ao apertar os limites por IP: no Brasil as operadoras moveis usam
 * CGNAT, entao milhares de pessoas saem pelo mesmo IP. Um limite baixo de
 * cadastro/login por IP bloqueia usuario legitimo em massa. Para forca bruta de
 * senha, limitar por E-MAIL e mais eficaz e nao pune quem divide o IP.
 */
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  if (process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT !== 'on')
    return { ok: true, remaining: max };
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return { ok: true, remaining: max - 1 };
  }
  b.count++;
  return { ok: b.count <= max, remaining: Math.max(0, max - b.count), retryAfter: b.reset - now };
}
// Limpeza periodica: sem isto o Map cresce para sempre e vira vazamento de memoria.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
}, 60_000).unref();

/** Cabecalhos de seguranca — o que o helmet poria. */
export function securityHeaders(res, { csp = true } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');                 // anti-clickjacking
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  if (process.env.NODE_ENV === 'production')
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (csp) {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      // 'unsafe-inline' ainda e preciso: as paginas tem <script> embutido.
      // Ver NOTA-CSP no SECURITY.md para remover.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '));
  }
}

/**
 * Converte para inteiro sem NUNCA lancar.
 *
 * `Number(x)` parece seguro e nao e: com `{toString: "x"}` (toString que e uma
 * string, nao funcao) a conversao para primitivo falha com TypeError. Como isso
 * acontece ANTES de qualquer validacao, bastava mandar esse objeto para
 * derrubar com 500 qualquer rota que lesse um valor — inclusive as de dinheiro.
 *
 * Devolve `null` para tudo que nao for um inteiro seguro, e quem chama trata
 * `null` como entrada invalida.
 */
export function toInt(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!/^-?\d+$/.test(t)) return null;
    const n = Number(t);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;   // objeto, array, boolean, null, undefined: nada disso e um valor
}

export const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
export const mimeFor = (ext) => MIME[ext] || 'application/octet-stream';
export const etagFor = (buf) => '"' + createHash('sha1').update(buf).digest('base64url') + '"';
