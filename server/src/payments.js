/* Entrada e saida de dinheiro pelo gateway.
 *
 * Divisao de responsabilidade — o ponto que mais confunde:
 *   O GATEWAY move dinheiro de verdade (cobra o Pix, paga o saque).
 *   NOS mantemos o saldo. O gateway nao sabe quanto cada jogador tem.
 *
 * Por isso o credito NUNCA vem do navegador dizendo "paguei". Vem do webhook
 * assinado do gateway, e so depois de conferirmos a assinatura.
 *
 * Fluxo do deposito:
 *   1. cliente pede deposito        -> criamos payment 'pending' e cobranca no gateway
 *   2. cliente paga o Pix           -> nada acontece aqui ainda
 *   3. gateway chama nosso webhook  -> conferimos assinatura, marcamos 'paid',
 *                                      creditamos no razao (idempotente)
 *
 * O passo 3 e o unico que mexe em saldo.
 */
import { db, audit } from './db.js';
import { postTransaction, userAccount, balanceOf, EXTERNAL_PSP } from './money.js';
import { randomUUID, timingSafeEqual, createHmac } from 'node:crypto';

export const MIN_DEPOSIT_CENTS = 500;        // R$ 5,00
export const MAX_DEPOSIT_CENTS = 1000000;    // R$ 10.000,00
export const MIN_WITHDRAW_CENTS = 1000;      // R$ 10,00

/* ------------------------------------------------- adaptador do gateway
 * Troque esta implementacao pela do seu provedor. O resto do servidor so
 * conhece esta interface, entao mudar de gateway nao encosta no razao.
 */
export const gateway = {
  name: process.env.PSP_NAME || 'mock',

  /** Cria a cobranca Pix e devolve { ref, pixCode, qrImage, expiresAt }. */
  async createPixCharge({ amountCents, userId, paymentId }) {
    if (!process.env.PSP_API_KEY) {
      // Modo de desenvolvimento: nao chama ninguem e nao move dinheiro real.
      return {
        ref: `mock_${paymentId}`,
        pixCode: `00020126MOCK-NAO-PAGAVEL-${paymentId}`,
        qrImage: null,
        expiresAt: Date.now() + 30 * 60 * 1000,
      };
    }
    throw new Error('adaptador do gateway nao implementado: preencha createPixCharge');
  },

  /** Dispara o saque. Devolve { ref }. */
  async createPayout({ amountCents, userId, paymentId, pixKey }) {
    if (!process.env.PSP_API_KEY) return { ref: `mock_payout_${paymentId}` };
    throw new Error('adaptador do gateway nao implementado: preencha createPayout');
  },

  /**
   * Confere a assinatura do webhook.
   * Quase todo gateway assina com HMAC-SHA256 do corpo CRU da requisicao.
   * Tem de ser o corpo cru: se voce usar o JSON ja reserializado, a assinatura
   * nao bate, porque a ordem das chaves e os espacos mudam.
   */
  verifyWebhook({ rawBody, signature }) {
    const secret = process.env.PSP_WEBHOOK_SECRET;
    /* Falha FECHADA: sem segredo configurado, nada e aceito.
       Antes isto devolvia `true` fora de producao — ou seja, em dev/staging
       qualquer POST nao assinado era tratado como evento legitimo do gateway,
       e como o proprio cliente recebe o `ref` da cobranca ao pedir o deposito,
       bastava ele forjar o evento para creditar o valor que quisesse.
       Produção já recusava subir sem o segredo, mas "permitir" nunca pode ser o
       padrao silencioso de uma verificacao de assinatura. */
    if (!secret) {
      console.warn('[webhook] PSP_WEBHOOK_SECRET nao definido: todos os eventos serao recusados.');
      return false;
    }
    if (!signature) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(signature).replace(/^sha256=/, ''), 'utf8');
    // Comparacao em tempo constante, pelo mesmo motivo da senha.
    return a.length === b.length && timingSafeEqual(a, b);
  },

  /** Normaliza o corpo do webhook para o formato que usamos internamente. */
  parseEvent(body) {
    return {
      id: body.id || body.event_id,
      type: body.type || body.event,          // payment.paid | payment.failed | payout.paid ...
      ref: body.data?.id || body.charge_id,
      amountCents: body.data?.amount ?? body.amount,
      status: body.data?.status || body.status,
    };
  },
};

/* --------------------------------------------------------- limites */

/**
 * Soma depositada numa janela de tempo, para os limites de jogo responsavel.
 *
 * Conta `paid` E `pending`. Contar so o que ja foi pago parece certo e nao e:
 * o limite e conferido na CRIACAO do deposito, e o credito acontece depois, no
 * webhook. Entao bastava criar varias cobrancas abaixo do limite — nenhuma
 * delas `paid` ainda, todas passando na checagem — e pagar todas em seguida.
 * Com limite diario de R$100 dava para entrar com R$270.
 *
 * Cobranca pendente expira no gateway; se nao virar `paid`, o status deve ser
 * atualizado para `failed` pelo webhook e ela sai desta conta.
 */
export function depositedSince(userId, sinceMs) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_cents),0) AS total FROM payments
    WHERE user_id=? AND direction='in' AND status IN ('paid','pending') AND created_at >= ?`)
    .get(userId, sinceMs);
  return row.total;
}

export function depositLimitProblem(user, amountCents) {
  const DAY = 86400000;
  const checks = [
    [user.deposit_limit_day_cents, DAY, 'diario'],
    [user.deposit_limit_week_cents, 7 * DAY, 'semanal'],
    [user.deposit_limit_month_cents, 30 * DAY, 'mensal'],
  ];
  for (const [limit, window, label] of checks) {
    if (limit == null) continue;
    if (depositedSince(user.id, Date.now() - window) + amountCents > limit)
      return `Isso passa do seu limite ${label} de deposito.`;
  }
  return null;
}

/* -------------------------------------------------------- deposito */

export async function startDeposit({ user, amountCents, method = 'pix' }) {
  if (!Number.isSafeInteger(amountCents) || amountCents < MIN_DEPOSIT_CENTS || amountCents > MAX_DEPOSIT_CENTS)
    throw Object.assign(new Error('valor fora dos limites'), { code: 'BAD_AMOUNT' });

  const now = Date.now();
  if (user.excluded_until > now)
    throw Object.assign(new Error('conta em autoexclusao'), { code: 'SELF_EXCLUDED' });

  const limitMsg = depositLimitProblem(user, amountCents);
  if (limitMsg) throw Object.assign(new Error(limitMsg), { code: 'LIMIT' });

  const id = randomUUID();
  db.prepare(`INSERT INTO payments
    (id,user_id,direction,amount_cents,status,provider,method,created_at,updated_at)
    VALUES (?,?,'in',?,'pending',?,?,?,?)`)
    .run(id, user.id, amountCents, gateway.name, method, now, now);

  const charge = await gateway.createPixCharge({ amountCents, userId: user.id, paymentId: id });
  db.prepare('UPDATE payments SET provider_ref=?, updated_at=? WHERE id=?').run(charge.ref, Date.now(), id);
  audit(user.id, 'deposit.started', { id, amountCents });

  return { paymentId: id, ...charge };
}

/* ----------------------------------------------------------- saque */

export async function requestWithdrawal({ user, amountCents, pixKey }) {
  if (!Number.isSafeInteger(amountCents) || amountCents < MIN_WITHDRAW_CENTS)
    throw Object.assign(new Error('valor abaixo do minimo'), { code: 'BAD_AMOUNT' });

  // Saque exige conta verificada. E a trava que impede alguem depositar com um
  // cartao roubado e sacar na conta propria antes de o estorno chegar.
  if (user.kyc_level < 3)
    throw Object.assign(new Error('verifique sua conta antes de sacar'), { code: 'KYC_REQUIRED' });

  if (balanceOf(userAccount(user.id)) < amountCents)
    throw Object.assign(new Error('saldo insuficiente'), { code: 'INSUFFICIENT_FUNDS' });

  const id = randomUUID();
  const now = Date.now();

  /* O debito acontece JUNTO com a criacao do registro, numa transacao so.
     Se debitasse depois, duas requisicoes simultaneas passariam as duas pela
     checagem de saldo acima e sacariam o dobro do que existe. */
  db.transaction(() => {
    db.prepare(`INSERT INTO payments
      (id,user_id,direction,amount_cents,status,provider,method,created_at,updated_at)
      VALUES (?,?,'out',?,'pending',?,'pix',?,?)`)
      .run(id, user.id, amountCents, gateway.name, now, now);
    postTransaction({
      kind: 'withdrawal',
      idempotencyKey: `withdrawal:${id}`,
      memo: 'saque solicitado',
      entries: [
        { account: userAccount(user.id), amount_cents: -amountCents },
        { account: EXTERNAL_PSP, amount_cents: +amountCents },
      ],
    });
  })();

  try {
    const { ref } = await gateway.createPayout({ amountCents, userId: user.id, paymentId: id, pixKey });
    db.prepare('UPDATE payments SET provider_ref=?, updated_at=? WHERE id=?').run(ref, Date.now(), id);
  } catch (err) {
    // O gateway recusou: devolvemos o valor. Sem este estorno o jogador ficaria
    // sem o dinheiro e sem o saque.
    db.transaction(() => {
      postTransaction({
        kind: 'refund',
        idempotencyKey: `withdrawal-failed:${id}`,
        memo: 'saque recusado pelo gateway',
        entries: [
          { account: EXTERNAL_PSP, amount_cents: -amountCents },
          { account: userAccount(user.id), amount_cents: +amountCents },
        ],
      });
      db.prepare(`UPDATE payments SET status='failed', updated_at=? WHERE id=?`).run(Date.now(), id);
    })();
    throw err;
  }

  audit(user.id, 'withdrawal.requested', { id, amountCents });
  return { paymentId: id, status: 'pending' };
}

/* --------------------------------------------------------- webhook */

/**
 * Processa um evento do gateway. Idempotente por (provider, event_id):
 * gateways reenviam o mesmo evento quando nao recebem 200 rapido o bastante,
 * e sem esta trava o mesmo deposito seria creditado varias vezes.
 */
export const handleWebhookEvent = db.transaction(({ rawBody, event }) => {
  /* Normaliza ANTES de tocar no banco.
     O driver do SQLite recusa `undefined` como parametro e lanca excecao — um
     evento sem `ref` (ou com tipo inesperado) derrubava a rota com 500. E 500
     faz o gateway reenviar o mesmo evento indefinidamente, porque ele entende
     que nao conseguimos processar. Aqui tudo vira string ou null. */
  const eventId = event.id == null ? null : String(event.id);
  const ref     = event.ref == null ? null : String(event.ref);
  const type    = event.type == null ? '' : String(event.type);
  const status  = event.status == null ? '' : String(event.status);
  if (!eventId) return { ignored: 'evento sem id' };

  const already = db.prepare('SELECT 1 FROM webhook_events WHERE provider=? AND event_id=?')
    .get(gateway.name, eventId);
  if (already) return { duplicate: true };

  db.prepare('INSERT INTO webhook_events (provider,event_id,received_at,payload) VALUES (?,?,?,?)')
    .run(gateway.name, eventId, Date.now(), String(rawBody));

  if (!ref) return { ignored: 'evento sem referencia de cobranca' };

  const pay = db.prepare('SELECT * FROM payments WHERE provider=? AND provider_ref=?')
    .get(gateway.name, ref);
  if (!pay) return { ignored: 'pagamento desconhecido' };

  const paid   = /paid|succeeded|approved|completed/i.test(type + ' ' + status);
  const failed = /failed|refused|cancel|expired|chargeback/i.test(type + ' ' + status);

  if (pay.direction === 'in' && paid && pay.status !== 'paid') {
    /* Confere o valor: nunca credite o que o evento disser sem comparar com o
       que foi cobrado. Evento adulterado ou trocado creditaria valor errado.
       Comparacao estrita e com Number(): "5000" (string) nao pode bater com
       5000 por acidente, mas tambem nao pode ser recusado por diferenca de tipo
       quando o gateway manda o valor como texto. Qualquer coisa que nao seja um
       inteiro e tratada como divergencia. */
    if (event.amountCents != null) {
      const got = Number(event.amountCents);
      if (!Number.isSafeInteger(got) || got !== pay.amount_cents)
        return { ignored: 'valor divergente', expected: pay.amount_cents, got: event.amountCents };
    }

    postTransaction({
      kind: 'deposit',
      idempotencyKey: `deposit:${pay.id}`,
      memo: 'deposito confirmado pelo gateway',
      entries: [
        { account: EXTERNAL_PSP, amount_cents: -pay.amount_cents },
        { account: userAccount(pay.user_id), amount_cents: +pay.amount_cents },
      ],
    });
    db.prepare(`UPDATE payments SET status='paid', updated_at=? WHERE id=?`).run(Date.now(), pay.id);
    audit(pay.user_id, 'deposit.paid', { id: pay.id, amountCents: pay.amount_cents });
    return { credited: pay.amount_cents };
  }

  if (pay.direction === 'out' && failed && pay.status === 'pending') {
    postTransaction({
      kind: 'refund',
      idempotencyKey: `withdrawal-reversed:${pay.id}`,
      memo: 'saque falhou no gateway',
      entries: [
        { account: EXTERNAL_PSP, amount_cents: -pay.amount_cents },
        { account: userAccount(pay.user_id), amount_cents: +pay.amount_cents },
      ],
    });
    db.prepare(`UPDATE payments SET status='failed', updated_at=? WHERE id=?`).run(Date.now(), pay.id);
    return { reversed: pay.amount_cents };
  }

  if (paid || failed) {
    db.prepare('UPDATE payments SET status=?, updated_at=? WHERE id=?')
      .run(paid ? 'paid' : 'failed', Date.now(), pay.id);
  }
  return { ok: true };
});
