/* Dados cadastrais, verificacao e jogo responsavel.
 *
 * Tudo isto era validado so no navegador. Validacao no cliente serve para dar
 * resposta rapida ao usuario; ela NAO e protecao, porque quem quiser e so
 * mandar o POST direto. Por isso toda regra abaixo roda de novo aqui.
 */
import { db, audit } from './db.js';

const DAY = 86400000;

/** Valida CPF de verdade: formato, repeticao e os dois digitos verificadores. */
export function validCPF(value) {
  const d = String(value || '').replace(/\D/g, '');
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false;        // 111.111.111-11 e afins
  for (let t = 9; t < 11; t++) {
    let sum = 0;
    for (let i = 0; i < t; i++) sum += Number(d[i]) * ((t + 1) - i);
    let check = (sum * 10) % 11;
    if (check === 10) check = 0;
    if (check !== Number(d[t])) return false;
  }
  return true;
}

/** Idade em anos a partir de uma data ISO (YYYY-MM-DD). */
export function ageOf(iso) {
  const b = new Date(iso);
  if (Number.isNaN(b.getTime())) return -1;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age;
}

export function updateProfile(user, data) {
  const fullName = String(data.fullName || '').trim();
  const cpf = String(data.cpf || '').replace(/\D/g, '');
  const birth = String(data.birth || '').trim();
  const phone = String(data.phone || '').replace(/\D/g, '');
  const country = String(data.country || '').trim().toUpperCase().slice(0, 2);

  if (fullName.split(/\s+/).filter(Boolean).length < 2)
    throw Object.assign(new Error('Informe nome e sobrenome.'), { code: 'BAD_PROFILE' });
  if (!validCPF(cpf))
    throw Object.assign(new Error('CPF invalido.'), { code: 'BAD_PROFILE' });

  /* Maioridade conferida no servidor. Antes isto era so um `if` no navegador,
     que qualquer um contornava — e e a trava mais importante da plataforma. */
  const age = ageOf(birth);
  if (age < 18)
    throw Object.assign(new Error('E preciso ter 18 anos ou mais.'), { code: 'UNDERAGE' });
  if (age > 120)
    throw Object.assign(new Error('Data de nascimento invalida.'), { code: 'BAD_PROFILE' });
  if (phone.length < 10)
    throw Object.assign(new Error('Telefone invalido.'), { code: 'BAD_PROFILE' });
  if (!country)
    throw Object.assign(new Error('Informe o pais.'), { code: 'BAD_PROFILE' });

  // Um CPF por conta: impede a mesma pessoa abrir varias contas para burlar
  // limites de deposito ou uma autoexclusao.
  const taken = db.prepare('SELECT id FROM users WHERE cpf = ? AND id != ?').get(cpf, user.id);
  if (taken) throw Object.assign(new Error('Este CPF ja esta em uso.'), { code: 'CPF_TAKEN' });

  const level = user.kyc_level >= 3 ? 3 : 2;
  db.prepare(`UPDATE users SET full_name=?, cpf=?, birth=?, phone=?, country=?, kyc_level=?, updated_at=?
              WHERE id=?`)
    .run(fullName, cpf, birth, phone, country, level, Date.now(), user.id);
  audit(user.id, 'profile.updated', { country });
  return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
}

export function setLimits(user, { dayCents, weekCents, monthCents }) {
  const norm = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0) throw Object.assign(new Error('Limite invalido.'), { code: 'BAD_AMOUNT' });
    return n;
  };
  const d = norm(dayCents), w = norm(weekCents), m = norm(monthCents);
  if (d != null && w != null && d > w)
    throw Object.assign(new Error('O limite diario nao pode passar do semanal.'), { code: 'BAD_AMOUNT' });
  if (w != null && m != null && w > m)
    throw Object.assign(new Error('O limite semanal nao pode passar do mensal.'), { code: 'BAD_AMOUNT' });

  /* Aumentar limite tem carencia de 24h; reduzir vale na hora.
     Sem isso o limite nao protege ninguem: bastaria aumenta-lo no impulso. */
  const now = Date.now();
  const cur = {
    d: user.deposit_limit_day_cents, w: user.deposit_limit_week_cents, m: user.deposit_limit_month_cents,
  };
  const raising = (novo, atual) => atual != null && (novo == null || novo > atual);
  if (raising(d, cur.d) || raising(w, cur.w) || raising(m, cur.m)) {
    throw Object.assign(
      new Error('Aumentar um limite leva 24h para valer. Fale com o suporte para confirmar.'),
      { code: 'LIMIT_COOLDOWN' });
  }

  db.prepare(`UPDATE users SET deposit_limit_day_cents=?, deposit_limit_week_cents=?,
              deposit_limit_month_cents=?, updated_at=? WHERE id=?`)
    .run(d, w, m, now, user.id);
  audit(user.id, 'limits.set', { d, w, m });
  return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
}

/** Pausa curta. Nao pode ser encurtada depois de posta. */
export function pause(user, days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0 || n > 180)
    throw Object.assign(new Error('Periodo invalido.'), { code: 'BAD_AMOUNT' });
  const until = Date.now() + n * DAY;
  if (until < user.paused_until)
    throw Object.assign(new Error('Ja existe uma pausa mais longa em vigor.'), { code: 'FORBIDDEN' });
  db.prepare('UPDATE users SET paused_until=?, updated_at=? WHERE id=?').run(until, Date.now(), user.id);
  audit(user.id, 'pause.set', { days: n });
  return until;
}

/** Autoexclusao. Deliberadamente irreversivel ate o prazo terminar. */
export function selfExclude(user, days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n < 30 || n > 1825)
    throw Object.assign(new Error('A autoexclusao vai de 30 dias a 5 anos.'), { code: 'BAD_AMOUNT' });
  const until = Date.now() + n * DAY;
  if (until < user.excluded_until)
    throw Object.assign(new Error('Ja existe uma autoexclusao mais longa em vigor.'), { code: 'FORBIDDEN' });
  db.prepare('UPDATE users SET excluded_until=?, updated_at=? WHERE id=?').run(until, Date.now(), user.id);
  audit(user.id, 'self_exclusion.set', { days: n });
  return until;
}

/**
 * Verificacao de documento.
 * ATENCAO: aqui so registramos que foi enviado. A conferencia de verdade
 * (documento x selfie x base oficial) e feita por um provedor de KYC, e e ele
 * quem deve promover a conta ao nivel 3. Promover sozinho, pelo pedido do
 * cliente, derruba a unica trava que existe antes do saque.
 */
export function submitKyc(user, { docType }) {
  if (!['rg', 'cnh', 'passaporte'].includes(String(docType)))
    throw Object.assign(new Error('Tipo de documento invalido.'), { code: 'BAD_PROFILE' });
  if (user.kyc_level < 2)
    throw Object.assign(new Error('Complete seus dados antes de verificar.'), { code: 'BAD_PROFILE' });
  audit(user.id, 'kyc.submitted', { docType });
  return { status: 'pending', message: 'Documento recebido. A analise leva ate 48h.' };
}

export const publicProfile = (u) => ({
  id: u.id, name: u.name, email: u.email,
  kycLevel: u.kyc_level,
  fullName: u.full_name,
  // CPF sempre mascarado na resposta: nao ha motivo para devolve-lo inteiro.
  cpf: u.cpf ? `***.${u.cpf.slice(3, 6)}.${u.cpf.slice(6, 9)}-**` : null,
  birth: u.birth, phone: u.phone, country: u.country,
  limits: {
    dayCents: u.deposit_limit_day_cents,
    weekCents: u.deposit_limit_week_cents,
    monthCents: u.deposit_limit_month_cents,
  },
  pausedUntil: u.paused_until,
  excludedUntil: u.excluded_until,
});
