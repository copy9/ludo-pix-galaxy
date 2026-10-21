/**
 * Configuração — validada na partida, não na primeira requisição.
 *
 * Se faltar um segredo, o servidor se recusa a subir. É preferível a subir
 * "funcionando" e descobrir na primeira cobrança que o webhook não tinha
 * chave de assinatura e vinha aceitando qualquer requisição forjada.
 *
 * As variáveis vêm de `node --env-file=.env` (nativo no Node 22) ou do
 * ambiente real em produção.
 */

const problems = [];

function read(name, { required = false, fallback } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    if (required) problems.push(`${name}: obrigatória.`);
    return fallback;
  }
  return raw;
}

function readInt(name, { min, max, fallback, required = false } = {}) {
  const raw = read(name, { required });
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    problems.push(`${name}: precisa ser um número inteiro (recebi "${raw}").`);
    return fallback;
  }
  if (min !== undefined && n < min) problems.push(`${name}: mínimo ${min}.`);
  if (max !== undefined && n > max) problems.push(`${name}: máximo ${max}.`);
  return n;
}

function readBool(name, fallback = false) {
  const raw = read(name);
  if (raw === undefined) return fallback;
  if (['true', '1', 'yes'].includes(raw.toLowerCase())) return true;
  if (['false', '0', 'no'].includes(raw.toLowerCase())) return false;
  problems.push(`${name}: use true ou false.`);
  return fallback;
}

function readEnum(name, allowed, fallback) {
  const raw = read(name) ?? fallback;
  if (!allowed.includes(raw)) {
    problems.push(`${name}: deve ser um de ${allowed.join(', ')}.`);
    return fallback;
  }
  return raw;
}

const NODE_ENV = readEnum('NODE_ENV', ['development', 'test', 'production'], 'development');
const isProduction = NODE_ENV === 'production';

const cfg = {
  NODE_ENV,
  PORT: readInt('PORT', { min: 1, max: 65535, fallback: 3000 }),
  PUBLIC_URL: read('PUBLIC_URL', { fallback: 'http://localhost:3000' }),

  DATABASE_URL: read('DATABASE_URL', { required: NODE_ENV !== 'test' }),
  DATABASE_SSL: readBool('DATABASE_SSL', isProduction),

  // Gere com: openssl rand -hex 32
  SESSION_SECRET: read('SESSION_SECRET', { required: isProduction, fallback: 'dev-only-secret-não-use-em-producao-0123456789' }),
  SESSION_TTL_HOURS: readInt('SESSION_TTL_HOURS', { min: 1, max: 24 * 30, fallback: 72 }),

  PAYMENT_PROVIDER: readEnum('PAYMENT_PROVIDER', ['mock', 'mercadopago'], 'mock'),
  PAYMENT_API_KEY: read('PAYMENT_API_KEY'),
  PAYMENT_WEBHOOK_SECRET: read('PAYMENT_WEBHOOK_SECRET'),

  // Regras de negócio — ajustáveis sem tocar no código.
  COMMISSION_BPS: readInt('COMMISSION_BPS', { min: 0, max: 5000, fallback: 2000 }),
  MIN_DEPOSIT_CENTS: readInt('MIN_DEPOSIT_CENTS', { min: 1, fallback: 500 }),
  MAX_DEPOSIT_CENTS: readInt('MAX_DEPOSIT_CENTS', { min: 1, fallback: 500_000 }),
  MIN_WITHDRAWAL_CENTS: readInt('MIN_WITHDRAWAL_CENTS', { min: 1, fallback: 1000 }),
  MIN_STAKE_CENTS: readInt('MIN_STAKE_CENTS', { min: 1, fallback: 100 }),
  MAX_STAKE_CENTS: readInt('MAX_STAKE_CENTS', { min: 1, fallback: 100_000 }),
  CHALLENGE_TTL_MINUTES: readInt('CHALLENGE_TTL_MINUTES', { min: 1, fallback: 30 }),
  TURN_TIMEOUT_SECONDS: readInt('TURN_TIMEOUT_SECONDS', { min: 15, fallback: 90 }),

  TRUST_PROXY: readBool('TRUST_PROXY', isProduction),
};

// --- regras que só valem em produção ---
if (isProduction) {
  if (cfg.PAYMENT_PROVIDER === 'mock') {
    problems.push('PAYMENT_PROVIDER: "mock" credita saldo sem cobrar ninguém. Nunca em produção.');
  }
  if (!cfg.PAYMENT_API_KEY) problems.push('PAYMENT_API_KEY: obrigatória em produção.');
  if (!cfg.PAYMENT_WEBHOOK_SECRET) {
    problems.push('PAYMENT_WEBHOOK_SECRET: sem ela o webhook aceitaria qualquer requisição forjada.');
  }
  if (!cfg.PUBLIC_URL.startsWith('https://')) {
    problems.push('PUBLIC_URL: em produção precisa ser HTTPS — o cookie de sessão depende disso.');
  }
  if (!cfg.SESSION_SECRET || cfg.SESSION_SECRET.length < 32) {
    problems.push('SESSION_SECRET: precisa de ao menos 32 caracteres aleatórios.');
  }
  if (cfg.SESSION_SECRET?.startsWith('dev-only')) {
    problems.push('SESSION_SECRET: ainda está com o valor de desenvolvimento.');
  }
}

if (cfg.MIN_DEPOSIT_CENTS > cfg.MAX_DEPOSIT_CENTS) problems.push('MIN_DEPOSIT_CENTS está acima do máximo.');
if (cfg.MIN_STAKE_CENTS > cfg.MAX_STAKE_CENTS) problems.push('MIN_STAKE_CENTS está acima do máximo.');

if (problems.length) {
  console.error('\n  Configuração inválida — o servidor não vai subir:\n');
  for (const p of problems) console.error(`   • ${p}`);
  console.error('\n  Copie server/.env.example para server/.env e preencha.\n');
  process.exit(1);
}

export const config = Object.freeze(cfg);
export const isProd = isProduction;
