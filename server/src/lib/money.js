/**
 * Dinheiro — sempre inteiro, sempre em centavos.
 *
 * O protótipo fazia `parseFloat(input.value)` e somava reais em ponto
 * flutuante. Isso produz 0.1 + 0.2 === 0.30000000000000004, e com volume vira
 * divergência de caixa impossível de reconciliar. Aqui nenhum valor monetário
 * existe como float em momento algum: entra como texto, vira inteiro, e só
 * volta a ser decimal na hora de desenhar na tela.
 */

export const CENTS = 100;

/** Erro de valor monetário inválido, com mensagem pronta para o usuário. */
export class MoneyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MoneyError';
    this.statusCode = 400;
    this.expose = true;
  }
}

/**
 * Converte entrada do usuário ("12,50", "12.50", 12.5) em centavos inteiros.
 * Rejeita o que não for dinheiro de verdade em vez de arredondar em silêncio.
 */
export function parseAmountToCents(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyError('Valor inválido.');
    // Aceitamos número só se tiver no máximo 2 casas; 12.555 é erro de quem
    // chamou, não algo para arredondar por conta própria.
    const cents = Math.round(input * CENTS);
    if (Math.abs(input * CENTS - cents) > 1e-6) {
      throw new MoneyError('Valor com mais de duas casas decimais.');
    }
    return cents;
  }
  if (typeof input !== 'string') throw new MoneyError('Valor inválido.');

  const raw = input.trim().replace(/\s/g, '').replace(/^R\$/i, '');
  // Aceita "1234", "1234.56" e "1234,56". Separador de milhar não entra:
  // "1.234" é ambíguo entre mil e um e um e vinte e três centavos.
  const match = /^(-?)(\d+)(?:[.,](\d{1,2}))?$/.exec(raw);
  if (!match) throw new MoneyError('Informe um valor como 10 ou 10,50.');
  const [, sign, whole, frac = ''] = match;
  const cents = BigInt(whole) * BigInt(CENTS) + BigInt(frac.padEnd(2, '0'));
  const signed = sign === '-' ? -cents : cents;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyError('Valor alto demais.');
  return Number(signed);
}

/** Exige um valor positivo dentro de uma faixa, em centavos. */
export function requirePositiveCents(input, { min = 1, max = Number.MAX_SAFE_INTEGER, label = 'valor' } = {}) {
  const cents = parseAmountToCents(input);
  if (!Number.isSafeInteger(cents)) throw new MoneyError(`O ${label} é inválido.`);
  if (cents < min) throw new MoneyError(`O ${label} mínimo é ${formatBRL(min)}.`);
  if (cents > max) throw new MoneyError(`O ${label} máximo é ${formatBRL(max)}.`);
  return cents;
}

/** Formata centavos como moeda brasileira. */
export function formatBRL(cents) {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const text = `${Math.floor(abs / CENTS)},${String(abs % CENTS).padStart(2, '0')}`;
  const withThousands = text.replace(/\B(?=(\d{3})+(?!\d),)/g, '.');
  return `${negative ? '-' : ''}R$ ${withThousands}`;
}

/**
 * Divide o pote entre prêmio e comissão, em centavos inteiros.
 *
 * A comissão arredonda PARA BAIXO, então o centavo da divisão inexata vai
 * para o jogador, não para a casa. Prêmio + comissão sempre é igual ao pote
 * exato — nunca sobra nem falta um centavo no caixa.
 */
export function splitPot(potCents, commissionBps) {
  if (!Number.isSafeInteger(potCents) || potCents < 0) {
    throw new MoneyError('Pote inválido.');
  }
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 5000) {
    throw new MoneyError('Comissão inválida.');
  }
  const commission = Math.floor((potCents * commissionBps) / 10000);
  const prize = potCents - commission;
  return { prizeCents: prize, commissionCents: commission };
}
