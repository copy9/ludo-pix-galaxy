/**
 * Limitação de taxa por janela deslizante, em memória.
 *
 * Protege três coisas distintas, com orçamentos distintos:
 *   • login e cadastro → força bruta de senha
 *   • criação de cobrança e saque → abuso de custo no provedor de pagamento
 *   • API geral → ruído e varredura
 *
 * AVISO OPERACIONAL: o estado vive na memória do processo. Com mais de uma
 * instância, cada uma conta separado e o limite efetivo multiplica pelo número
 * de instâncias. Ao escalar horizontalmente, troque o `MemoryStore` por um
 * store em Redis — a interface é de dois métodos de propósito.
 */

import { tooMany } from '../lib/errors.js';

export class MemoryStore {
  constructor() {
    this.hits = new Map();
    // Limpeza periódica para que chaves antigas não vazem memória.
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref?.();
  }

  /** Registra um acesso e devolve quantos houve na janela. */
  bump(key, windowMs, now = Date.now()) {
    const cutoff = now - windowMs;
    const times = this.hits.get(key)?.filter((t) => t > cutoff) ?? [];
    times.push(now);
    this.hits.set(key, times);
    return times;
  }

  peek(key, windowMs, now = Date.now()) {
    const cutoff = now - windowMs;
    return this.hits.get(key)?.filter((t) => t > cutoff) ?? [];
  }

  reset(key) {
    this.hits.delete(key);
  }

  sweep(now = Date.now()) {
    const horizon = now - 3_600_000; // uma hora cobre a maior janela que usamos
    for (const [key, times] of this.hits) {
      const kept = times.filter((t) => t > horizon);
      if (kept.length === 0) this.hits.delete(key);
      else this.hits.set(key, kept);
    }
  }

  stop() {
    clearInterval(this.timer);
  }
}

export const defaultStore = new MemoryStore();

/**
 * Cria um limitador.
 *
 * @param {number} max        acessos permitidos na janela
 * @param {number} windowMs   tamanho da janela
 * @param {function} keyFn    como identificar o cliente (IP, usuário, e-mail)
 * @param {string} message    o que dizer ao bloquear
 */
export function rateLimiter({ max, windowMs, keyFn, message, store = defaultStore }) {
  return (ctx) => {
    const key = `${keyFn(ctx)}`;
    const times = store.bump(key, windowMs);
    if (times.length > max) {
      const oldest = times[0];
      const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - Date.now()) / 1000));
      const err = tooMany(message ?? 'Muitas tentativas. Espere um pouco.');
      err.retryAfter = retryAfter;
      throw err;
    }
    return { remaining: max - times.length };
  };
}

/* ------------------------------------------------------------------ */
/* Limites usados pela aplicação                                       */
/* ------------------------------------------------------------------ */

export const limits = {
  /** API geral: generoso, só corta varredura. */
  general: rateLimiter({
    max: 300,
    windowMs: 60_000,
    keyFn: (c) => `gen:${c.ip}`,
  }),

  /**
   * Login: a chave combina IP E e-mail. Só por IP, uma rede compartilhada
   * (escola, operadora móvel) bloquearia inocentes; só por e-mail, um atacante
   * distribuído passaria livre.
   */
  loginByIp: rateLimiter({
    max: 20,
    windowMs: 15 * 60_000,
    keyFn: (c) => `login-ip:${c.ip}`,
    message: 'Muitas tentativas de login deste endereço. Tente de novo em alguns minutos.',
  }),
  loginByAccount: rateLimiter({
    max: 8,
    windowMs: 15 * 60_000,
    keyFn: (c) => `login-acct:${c.body?.email ?? 'desconhecido'}`,
    message: 'Muitas tentativas nesta conta. Tente de novo em alguns minutos.',
  }),

  signup: rateLimiter({
    max: 5,
    windowMs: 60 * 60_000,
    keyFn: (c) => `signup:${c.ip}`,
    message: 'Muitas contas criadas deste endereço.',
  }),

  /** Cada cobrança criada custa uma chamada ao provedor — e dinheiro. */
  createDeposit: rateLimiter({
    max: 10,
    windowMs: 10 * 60_000,
    keyFn: (c) => `dep:${c.user?.id ?? c.ip}`,
    message: 'Você criou muitas cobranças seguidas. Pague ou cancele as pendentes.',
  }),

  /** Saque é a operação mais sensível: ritmo apertado de propósito. */
  withdraw: rateLimiter({
    max: 5,
    windowMs: 60 * 60_000,
    keyFn: (c) => `wd:${c.user?.id ?? c.ip}`,
    message: 'Limite de pedidos de saque por hora atingido.',
  }),

  /** Evita que um jogador entupa o servidor criando desafios. */
  createChallenge: rateLimiter({
    max: 30,
    windowMs: 10 * 60_000,
    keyFn: (c) => `ch:${c.user?.id ?? c.ip}`,
  }),

  /**
   * Ações dentro da partida. Alto porque o jogo é rápido, mas existe: sem
   * limite, um cliente modificado inunda o servidor com lances por segundo.
   */
  gameAction: rateLimiter({
    max: 240,
    windowMs: 60_000,
    keyFn: (c) => `game:${c.user?.id ?? c.ip}`,
  }),
};
