/**
 * Validação de entrada, pequena e explícita.
 *
 * Toda requisição que chega é hostil até prova em contrário. O objetivo aqui
 * é que nenhum handler receba um campo sem ter passado por uma regra: string
 * com tamanho máximo, inteiro dentro de faixa, enum fechado.
 *
 * O tamanho máximo não é zelo excessivo — é o que impede que alguém mande um
 * `display_name` de 10 MB e empurre isso para o banco e para a tela de todo
 * mundo.
 */

import { badRequest } from './errors.js';

export class ValidationError extends Error {
  constructor(issues) {
    super('Dados inválidos.');
    this.name = 'ValidationError';
    this.statusCode = 400;
    this.code = 'validation_error';
    this.expose = true;
    this.issues = issues;
  }
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/* ------------------------------------------------------------------ */
/* Regras individuais                                                  */
/* ------------------------------------------------------------------ */

export const v = {
  string({ min = 0, max = 500, trim = true, pattern, patternMessage } = {}) {
    return (value, field) => {
      if (typeof value !== 'string') throw `${field} deve ser texto.`;
      const s = trim ? value.trim() : value;
      if (s.length < min) throw `${field} precisa de ao menos ${min} caractere(s).`;
      if (s.length > max) throw `${field} passa de ${max} caracteres.`;
      if (pattern && !pattern.test(s)) throw patternMessage || `${field} está em formato inválido.`;
      return s;
    };
  },

  email() {
    return (value, field) => {
      const s = v.string({ min: 3, max: 254 })(value, field).toLowerCase();
      // Proposital: validação deliberadamente simples. A confirmação real de
      // que um e-mail existe é o e-mail de verificação, não uma regex.
      if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s)) throw `${field} inválido.`;
      return s;
    };
  },

  password() {
    return (value, field) => {
      if (typeof value !== 'string') throw `${field} deve ser texto.`;
      if (value.length < 10) throw 'A senha precisa de pelo menos 10 caracteres.';
      // Limite superior: o scrypt custa CPU proporcional à entrada, então uma
      // senha de 1 MB vira um ataque de negação de serviço barato.
      if (value.length > 200) throw 'A senha é longa demais (máximo 200).';
      return value;
    };
  },

  int({ min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
    return (value, field) => {
      const n = typeof value === 'string' ? Number(value) : value;
      if (!Number.isInteger(n)) throw `${field} deve ser um número inteiro.`;
      if (n < min) throw `${field} deve ser no mínimo ${min}.`;
      if (n > max) throw `${field} deve ser no máximo ${max}.`;
      return n;
    };
  },

  bool() {
    return (value, field) => {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === '1') return true;
      if (value === 'false' || value === '0') return false;
      throw `${field} deve ser verdadeiro ou falso.`;
    };
  },

  enum_(allowed) {
    return (value, field) => {
      if (!allowed.includes(value)) throw `${field} deve ser um de: ${allowed.join(', ')}.`;
      return value;
    };
  },

  uuid() {
    return v.string({
      min: 36,
      max: 36,
      pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      patternMessage: 'identificador inválido.',
    });
  },

  isoDate() {
    return (value, field) => {
      const s = v.string({ min: 10, max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ })(value, field);
      const d = new Date(`${s}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) throw `${field} não é uma data válida.`;
      if (d.getUTCFullYear() < 1900) throw `${field} é antiga demais.`;
      return s;
    };
  },

  optional(rule, fallback = undefined) {
    return (value, field) => {
      if (value === undefined || value === null || value === '') return fallback;
      return rule(value, field);
    };
  },
};

/**
 * Valida um corpo inteiro contra um mapa de regras.
 * Campos não declarados são DESCARTADOS, não repassados — assim um cliente
 * não consegue injetar `is_admin: true` num update de perfil.
 */
export function validate(body, rules) {
  if (!isPlainObject(body)) throw badRequest('Corpo da requisição inválido.');
  const out = {};
  const issues = [];
  for (const [field, rule] of Object.entries(rules)) {
    try {
      const result = rule(body[field], field);
      if (result !== undefined) out[field] = result;
    } catch (message) {
      issues.push({ field, message: typeof message === 'string' ? message : 'inválido.' });
    }
  }
  if (issues.length) throw new ValidationError(issues);
  return out;
}

/* ------------------------------------------------------------------ */
/* Documentos brasileiros                                              */
/* ------------------------------------------------------------------ */

/** Valida CPF pelos dígitos verificadores (a mesma regra do protótipo). */
export function isValidCPF(input) {
  const d = String(input ?? '').replace(/\D/g, '');
  if (d.length !== 11) return false;
  // Rejeita 000.000.000-00, 111.111.111-11 e afins: passam no cálculo mas
  // não são CPFs reais.
  if (/^(\d)\1{10}$/.test(d)) return false;
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i += 1) sum += Number(d[i]) * (len + 1 - i);
    let check = (sum * 10) % 11;
    if (check === 10) check = 0;
    if (check !== Number(d[len])) return false;
  }
  return true;
}

export function cpfDigits(input) {
  return String(input ?? '').replace(/\D/g, '');
}

/** Idade completa em anos, a partir de 'YYYY-MM-DD'. */
export function ageFrom(isoDate, now = new Date()) {
  const [y, m, d] = isoDate.split('-').map(Number);
  let age = now.getUTCFullYear() - y;
  const monthDiff = now.getUTCMonth() + 1 - m;
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < d)) age -= 1;
  return age;
}

/** Normaliza e valida uma chave Pix pelo tipo declarado. */
export function normalizePixKey(type, key) {
  const raw = String(key ?? '').trim();
  switch (type) {
    case 'cpf': {
      const d = cpfDigits(raw);
      if (!isValidCPF(d)) throw badRequest('CPF inválido para chave Pix.');
      return { normalized: d, masked: `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**` };
    }
    case 'email': {
      const e = raw.toLowerCase();
      if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(e)) throw badRequest('E-mail inválido para chave Pix.');
      const [user, domain] = e.split('@');
      const head = user.slice(0, 2);
      return { normalized: e, masked: `${head}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}` };
    }
    case 'phone': {
      const d = raw.replace(/\D/g, '');
      if (d.length < 10 || d.length > 13) throw badRequest('Telefone inválido para chave Pix.');
      return { normalized: `+${d.length <= 11 ? '55' : ''}${d}`, masked: `(**) *****-${d.slice(-4)}` };
    }
    case 'random': {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
        throw badRequest('Chave aleatória inválida.');
      }
      return { normalized: raw.toLowerCase(), masked: `${raw.slice(0, 8)}…${raw.slice(-4)}` };
    }
    default:
      throw badRequest('Tipo de chave Pix inválido.');
  }
}
