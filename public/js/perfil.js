/**
 * Conta do jogador: entrar, perfil, verificação, carteira, depósito, saque,
 * segurança e limites de jogo responsável.
 *
 * Reescrita completa. O protótipo guardava TUDO no localStorage: senha (em
 * SHA-256 com salt de Math.random), saldo, histórico e limites. Ou seja, o
 * jogador era dono do próprio saldo e podia apagar o próprio limite — que é
 * justamente o contrário do que um limite serve.
 *
 * Agora o localStorage não guarda nada que valha dinheiro. A verdade vem do
 * servidor a cada carregamento.
 */

import { api, ApiError, formatBRL, esc, parseAmount, newIdempotencyKey } from './api.js';

const $ = (id) => document.getElementById(id);
const show = (id) => {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('show'));
  $(id).classList.add('show');
  window.scrollTo(0, 0);
};

let session = null;      // { user, balanceCents }
let profile = null;
let limits = null;
let activeTab = 'perfil';
let MM = null;

const mm = (kind, text) => MM?.react(kind, text);

function msg(el, text, ok = false) {
  el.className = ok ? 'okmsg' : 'err';
  el.textContent = text;
}

/* ================================================================== */
/* Entrar / criar conta                                               */
/* ================================================================== */

let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  $('tabLogin').classList.toggle('on', mode === 'login');
  $('tabSignup').classList.toggle('on', mode === 'signup');
  $('fieldName').style.display = mode === 'signup' ? 'block' : 'none';
  $('fieldTerms').style.display = mode === 'signup' ? 'block' : 'none';
  $('fieldBirth').style.display = mode === 'signup' ? 'block' : 'none';
  $('authBtn').textContent = mode === 'login' ? 'Entrar' : 'Criar conta';
  $('authErr').textContent = '';
  $('inPass').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
}

async function doAuth() {
  const err = $('authErr');
  err.textContent = '';
  const email = $('inEmail').value.trim().toLowerCase();
  const password = $('inPass').value;
  $('authBtn').disabled = true;

  try {
    if (authMode === 'login') {
      session = await api.login(email, password);
    } else {
      if (!$('inTerms').checked) throw new ApiError('É preciso confirmar que você tem 18 anos ou mais.');
      session = await api.signup({
        email,
        password,
        displayName: $('inName').value.trim(),
        birthDate: $('inBirth').value,
        acceptedTerms: true,
      });
    }
    $('inPass').value = '';
    await enterAccount();
  } catch (e) {
    // O servidor responde a mesma coisa para e-mail inexistente e senha
    // errada; repassamos como veio, sem tentar adivinhar qual foi.
    err.textContent = e.issues?.length ? e.issues[0].message : e.message;
  } finally {
    $('authBtn').disabled = false;
  }
}

async function enterAccount() {
  [profile, limits] = await Promise.all([api.getProfile(), api.getLimits()]);
  session.balanceCents = (await api.balance()).balanceCents;
  renderAccount();
  show('view-account');
  mm('hello', `Bem-vindo, ${session.user.displayName}! 👋`);
}

/* ================================================================== */
/* Painel da conta                                                     */
/* ================================================================== */

const LEVEL_TEXT = {
  registered: 'Nível 1 · Conta criada',
  personal_data: 'Nível 2 · Dados completos',
  verified: 'Nível 3 · Verificada',
};

const TABS = [
  ['perfil', '👤 Perfil'],
  ['carteira', '💰 Carteira'],
  ['historico', '📜 Histórico'],
  ['seguranca', '🔒 Segurança'],
  ['limites', '🛟 Jogo responsável'],
];

function renderAccount() {
  const lockInfo = currentLock();

  $('hdr').innerHTML = `
    <div class="hdrline">
      <b>${esc(session.user.displayName)}</b>
      <span class="badge">${esc(LEVEL_TEXT[profile.kycLevel] ?? '')}</span>
    </div>
    <div class="muted">${esc(profile.email)}</div>
    <div class="bal">${esc(formatBRL(session.balanceCents))}</div>
    ${lockInfo ? `<div class="warn">${esc(lockInfo)}</div>` : ''}
    <div class="row" style="gap:10px; margin-top:10px;">
      <button class="bigbtn mini" id="goDeposit">Depositar</button>
      <button class="bigbtn mini ghost" id="goWithdraw">Sacar</button>
    </div>
  `;
  $('goDeposit').addEventListener('click', openDeposit);
  $('goWithdraw').addEventListener('click', openWithdraw);

  $('tabbar').innerHTML = TABS
    .map(([id, label]) => `<button class="tb ${activeTab === id ? 'on' : ''}" data-tab="${id}">${label}</button>`)
    .join('');
  $('tabbar').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => { activeTab = b.dataset.tab; renderAccount(); }));

  ({
    perfil: tabPerfil,
    carteira: tabCarteira,
    historico: tabHistorico,
    seguranca: tabSeguranca,
    limites: tabLimites,
  })[activeTab]();
}

function currentLock() {
  const now = Date.now();
  if (limits.selfExcludedUntil && new Date(limits.selfExcludedUntil) > now) {
    return `Autoexclusão ativa até ${new Date(limits.selfExcludedUntil).toLocaleString('pt-BR')}. Você pode sacar, mas não apostar.`;
  }
  if (limits.pausedUntil && new Date(limits.pausedUntil) > now) {
    return `Pausa ativa até ${new Date(limits.pausedUntil).toLocaleString('pt-BR')}.`;
  }
  return null;
}

/* ---------------- perfil e verificação ---------------- */

function tabPerfil() {
  const p = profile;
  const item = (state, label, value) =>
    `<div class="chk ${state}"><span>${state === 'ok' ? '✔' : state === 'pend' ? '⏳' : '○'}</span>
       <div><b>${esc(label)}</b><small>${value}</small></div></div>`;

  $('tabBody').innerHTML = `
    <h2 class="sec">Verificação da conta</h2>
    ${item('ok', 'E-mail cadastrado', esc(p.email))}
    ${item(p.fullName && p.cpfMasked ? 'ok' : 'no', 'Dados pessoais',
      p.fullName ? `${esc(p.fullName)} · ${esc(p.cpfMasked ?? '')}` : 'Libera apostas maiores')}
    ${item(p.docStatus === 'approved' ? 'ok' : p.docStatus === 'pending' ? 'pend' : 'no',
      'Documento com foto',
      p.docStatus === 'approved' ? 'Verificado — libera <b>saques</b>'
        : p.docStatus === 'pending' ? 'Em análise'
        : p.docStatus === 'rejected' ? `Recusado: ${esc(p.docRejectReason ?? '')}`
        : 'Libera <b>saques</b>')}

    <h2 class="sec" style="margin-top:18px;">Seus dados</h2>
    <label for="f_nick">Apelido</label>
    <input id="f_nick" value="${esc(p.displayName ?? '')}" maxlength="30">
    <label for="f_name">Nome completo</label>
    <input id="f_name" value="${esc(p.fullName ?? '')}" maxlength="120" placeholder="Como no documento">
    <label for="f_cpf">CPF</label>
    <input id="f_cpf" inputmode="numeric" maxlength="14"
           value="${esc(p.cpfMasked ?? '')}" ${p.kycLevel === 'verified' ? 'disabled' : ''}>
    <label for="f_phone">Telefone</label>
    <input id="f_phone" inputmode="numeric" maxlength="20" value="${esc(p.phone ?? '')}">
    <div class="row" style="gap:10px;">
      <div style="flex:2;"><label for="f_city">Cidade</label><input id="f_city" value="${esc(p.city ?? '')}"></div>
      <div style="flex:1;"><label for="f_uf">UF</label><input id="f_uf" maxlength="2" value="${esc(p.uf ?? '')}"></div>
    </div>
    <div class="status" id="profMsg"></div>
    <button class="bigbtn" id="saveProf">Salvar dados</button>
    <p class="muted" style="margin-top:10px;">
      Seu CPF é guardado apenas de forma cifrada, para conferir que não há conta duplicada.
      O número completo não fica armazenado.
    </p>
  `;

  $('saveProf').addEventListener('click', async () => {
    const el = $('profMsg');
    const body = {
      displayName: $('f_nick').value.trim(),
      fullName: $('f_name').value.trim() || undefined,
      phone: $('f_phone').value.trim() || undefined,
      city: $('f_city').value.trim() || undefined,
      uf: $('f_uf').value.trim().toUpperCase() || undefined,
    };
    // Só manda o CPF se o jogador digitou um novo (o campo mostra a máscara).
    const cpf = $('f_cpf').value.replace(/\D/g, '');
    if (cpf.length === 11) body.cpf = cpf;

    try {
      const r = await api.updateProfile(body);
      profile = await api.getProfile();
      msg(el, r.kycLevel === 'verified' ? 'Dados salvos. Conta verificada ✔' : 'Dados salvos ✔', true);
      mm('cheer', 'Dados atualizados! 📋');
      setTimeout(renderAccount, 800);
    } catch (e) {
      msg(el, e.issues?.length ? e.issues[0].message : e.message);
    }
  });
}

/* ---------------- carteira ---------------- */

function tabCarteira() {
  $('tabBody').innerHTML = `
    <h2 class="sec">Carteira</h2>
    <p class="muted">Saldo disponível</p>
    <div class="bal">${esc(formatBRL(session.balanceCents))}</div>
    <div class="row" style="gap:10px; margin-top:12px;">
      <button class="bigbtn mini" id="wDeposit">Depositar via Pix</button>
      <button class="bigbtn mini ghost" id="wWithdraw">Sacar</button>
    </div>
    <p class="muted" style="margin-top:16px;">
      Para sacar é preciso ter a conta verificada e usar uma chave Pix do próprio titular.
    </p>
  `;
  $('wDeposit').addEventListener('click', openDeposit);
  $('wWithdraw').addEventListener('click', openWithdraw);
}

/* ---------------- histórico ---------------- */

async function tabHistorico() {
  $('tabBody').innerHTML = '<h2 class="sec">Histórico</h2><div class="spinner"></div>';
  try {
    const { entries } = await api.statement();
    $('tabBody').innerHTML = `
      <h2 class="sec">Histórico</h2>
      ${entries.length === 0 ? '<p class="muted">Nenhuma movimentação ainda.</p>' : ''}
      ${entries.map((e) => `
        <div class="hist">
          <span class="hic">${esc(e.icon)}</span>
          <div class="hbody">
            <b>${esc(e.label)}</b>
            <small>${esc(new Date(e.createdAt).toLocaleString('pt-BR'))}</small>
          </div>
          <span class="hamt ${e.direction}">
            ${e.direction === 'in' ? '+' : '−'}${esc(formatBRL(Math.abs(e.amountCents)))}
          </span>
        </div>`).join('')}
      <p class="muted" style="margin-top:12px;">
        Cada linha é um lançamento no livro-razão e não pode ser alterada nem apagada.
      </p>
    `;
  } catch (e) {
    $('tabBody').innerHTML = `<p class="err">${esc(e.message)}</p>`;
  }
}

/* ---------------- segurança ---------------- */

function tabSeguranca() {
  $('tabBody').innerHTML = `
    <h2 class="sec">Segurança</h2>
    <label for="pw0">Senha atual</label><input id="pw0" type="password" autocomplete="current-password">
    <label for="pw1">Nova senha</label><input id="pw1" type="password" autocomplete="new-password" placeholder="mínimo 10 caracteres">
    <label for="pw2">Repita a nova senha</label><input id="pw2" type="password" autocomplete="new-password">
    <div class="status" id="pwMsg"></div>
    <button class="bigbtn" id="pwGo">Alterar senha</button>

    <h2 class="sec" style="margin-top:20px;">Sessões</h2>
    <p class="muted">Se achar que alguém entrou na sua conta, encerre todas as sessões.</p>
    <button class="bigbtn ghost" id="logoutAll">Sair de todos os aparelhos</button>
    <button class="bigbtn ghost" id="logoutOne">Sair desta conta</button>
  `;

  $('pwGo').addEventListener('click', async () => {
    const el = $('pwMsg');
    if ($('pw1').value !== $('pw2').value) return msg(el, 'As senhas não conferem.');
    try {
      const r = await api.changePassword($('pw0').value, $('pw1').value);
      msg(el, r.message, true);
      ['pw0', 'pw1', 'pw2'].forEach((id) => { $(id).value = ''; });
      mm('cheer', 'Senha atualizada 🔒');
    } catch (e) {
      msg(el, e.issues?.length ? e.issues[0].message : e.message);
    }
  });

  $('logoutAll').addEventListener('click', async () => {
    await api.logoutAll().catch(() => {});
    location.reload();
  });
  $('logoutOne').addEventListener('click', async () => {
    await api.logout().catch(() => {});
    location.reload();
  });
}

/* ---------------- jogo responsável ---------------- */

function tabLimites() {
  const l = limits;
  const val = (cents) => (cents ? (cents / 100).toFixed(2).replace('.', ',') : '');

  $('tabBody').innerHTML = `
    <h2 class="sec">Limites</h2>
    <p class="muted">
      Apertar um limite vale na hora. Afrouxar ou remover só passa a valer
      depois de <b>24 horas</b> — é proposital, para que a decisão não seja tomada no impulso.
    </p>
    ${l.pendingEffectiveAt ? `<div class="warn">
      Há alterações aguardando carência, válidas a partir de
      ${esc(new Date(l.pendingEffectiveAt).toLocaleString('pt-BR'))}.
    </div>` : ''}
    <label for="lim_day">Limite de depósito por dia (R$)</label>
    <input id="lim_day" inputmode="decimal" value="${esc(val(l.depositLimitDay))}" placeholder="sem limite">
    <label for="lim_week">Por semana (R$)</label>
    <input id="lim_week" inputmode="decimal" value="${esc(val(l.depositLimitWeek))}" placeholder="sem limite">
    <label for="lim_month">Por mês (R$)</label>
    <input id="lim_month" inputmode="decimal" value="${esc(val(l.depositLimitMonth))}" placeholder="sem limite">
    <label for="lim_stake">Limite de apostas por dia (R$)</label>
    <input id="lim_stake" inputmode="decimal" value="${esc(val(l.stakeLimitDay))}" placeholder="sem limite">
    <div class="status" id="limMsg"></div>
    <button class="bigbtn" id="saveLim">Salvar limites</button>

    <h2 class="sec" style="margin-top:20px;">Pausa</h2>
    <p class="muted">Uma pausa curta impede novas apostas pelo período escolhido.</p>
    <div class="chips" id="pauseChips">
      <button data-h="24">24 horas</button>
      <button data-h="168">7 dias</button>
      <button data-h="720">30 dias</button>
    </div>

    <h2 class="sec" style="margin-top:20px;">Autoexclusão</h2>
    <p class="muted">
      A autoexclusão <b>não pode ser desfeita</b> antes do prazo, nem pelo suporte.
      Durante o período você continua podendo sacar o seu saldo.
    </p>
    <div class="chips" id="exclChips">
      <button data-d="30">30 dias</button>
      <button data-d="180">6 meses</button>
      <button data-d="365">1 ano</button>
    </div>
    <div class="status" id="rgMsg"></div>
  `;

  $('saveLim').addEventListener('click', async () => {
    const el = $('limMsg');
    const read = (id) => {
      const raw = $(id).value.trim();
      if (!raw) return 0; // 0 = remover o limite
      const cents = parseAmount(raw);
      if (cents === null) throw new Error('Informe valores como 100 ou 100,50.');
      return cents;
    };
    try {
      const r = await api.updateLimits({
        depositLimitDay: read('lim_day'),
        depositLimitWeek: read('lim_week'),
        depositLimitMonth: read('lim_month'),
        stakeLimitDay: read('lim_stake'),
      });
      limits = await api.getLimits();
      msg(el, r.message, true);
      setTimeout(renderAccount, 1200);
    } catch (e) {
      msg(el, e.message);
    }
  });

  $('pauseChips').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm(`Pausar apostas por ${b.textContent}?`)) return;
      try {
        await api.setPause(Number(b.dataset.h));
        limits = await api.getLimits();
        msg($('rgMsg'), 'Pausa registrada.', true);
        setTimeout(renderAccount, 900);
      } catch (e) { msg($('rgMsg'), e.message); }
    }));

  $('exclChips').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', async () => {
      const label = b.textContent;
      // Duas confirmações: é irreversível.
      if (!confirm(`Autoexcluir por ${label}?\n\nIsto NÃO pode ser desfeito antes do prazo.`)) return;
      if (!confirm('Tem certeza? Nem o suporte consegue reverter antes do prazo.')) return;
      try {
        const r = await api.selfExclude(Number(b.dataset.d));
        limits = await api.getLimits();
        msg($('rgMsg'), r.message, true);
        setTimeout(renderAccount, 1500);
      } catch (e) { msg($('rgMsg'), e.message); }
    }));
}

/* ================================================================== */
/* Depósito                                                            */
/* ================================================================== */

let depositPoll = null;

function openDeposit() {
  $('depStatus').textContent = '';
  $('depResult').innerHTML = '';
  $('depAmount').value = '50,00';
  show('view-deposit');
  mm('hello', 'Quanto quer depositar? 💰');
}

async function createDeposit() {
  const el = $('depStatus');
  const cents = parseAmount($('depAmount').value);
  if (cents === null || cents <= 0) return msg(el, 'Informe um valor como 50 ou 50,00.');

  $('btnCreateDep').disabled = true;
  el.className = 'status';
  el.innerHTML = '<div class="spinner"></div>Gerando cobrança Pix…';

  try {
    const dep = await api.createDeposit($('depAmount').value, newIdempotencyKey());
    el.textContent = '';
    $('depResult').innerHTML = `
      <p class="muted">Pague ${esc(formatBRL(dep.amountCents))} com o código abaixo:</p>
      ${dep.pixQrCodeBase64
        ? `<img class="qrimg" alt="QR Code Pix" src="data:image/png;base64,${esc(dep.pixQrCodeBase64)}">`
        : ''}
      <div class="code" id="pixCode">${esc(dep.pixCopyPaste)}</div>
      <button class="bigbtn" id="copyPix">Copiar código Pix</button>
      <p class="muted" id="depWait">
        Aguardando o pagamento… o saldo entra sozinho assim que o banco confirmar.
      </p>
    `;
    $('copyPix').addEventListener('click', async (e) => {
      try {
        await navigator.clipboard.writeText(dep.pixCopyPaste);
        e.target.textContent = 'Código copiado ✔';
      } catch { e.target.textContent = 'Copie o código acima'; }
    });
    pollDeposit(dep.id);
  } catch (e) {
    // Limite de jogo responsável tem mensagem própria, vale destacar.
    msg(el, e.issues?.length ? e.issues[0].message : e.message);
    $('btnCreateDep').disabled = false;
  }
}

/**
 * Pergunta ao servidor se o Pix caiu.
 *
 * Note que NÃO existe botão "já paguei" que credite saldo — era assim no
 * protótipo, e qualquer um clicava. Quem credita é o webhook do banco.
 */
function pollDeposit(id) {
  clearInterval(depositPoll);
  let tries = 0;
  depositPoll = setInterval(async () => {
    tries += 1;
    if (tries > 150) return clearInterval(depositPoll); // ~5 minutos
    try {
      const dep = await api.getDeposit(id);
      if (dep.status === 'paid') {
        clearInterval(depositPoll);
        session.balanceCents = (await api.balance()).balanceCents;
        mm('dance', 'Depósito confirmado! 💰');
        $('depWait').innerHTML = '<b>Pagamento confirmado ✔</b>';
        setTimeout(() => { activeTab = 'carteira'; renderAccount(); show('view-account'); }, 1200);
      } else if (['expired', 'failed'].includes(dep.status)) {
        clearInterval(depositPoll);
        $('depWait').textContent = 'A cobrança expirou. Gere outra.';
      }
    } catch { /* tenta de novo no próximo ciclo */ }
  }, 2000);
}

/* ================================================================== */
/* Saque                                                               */
/* ================================================================== */

function openWithdraw() {
  const blocked =
    profile.kycLevel !== 'verified'
      ? 'Para sacar é preciso ter a conta <b>verificada</b>: dados completos e documento aprovado.'
      : null;

  $('wdBlock').innerHTML = blocked ? `<div class="warn">${blocked}</div>` : '';
  $('wdForm').innerHTML = blocked ? '' : `
    <p class="muted">Disponível: <b>${esc(formatBRL(session.balanceCents))}</b></p>
    <label for="wdAmount">Valor do saque</label>
    <input id="wdAmount" inputmode="decimal" placeholder="R$ 0,00">
    <label for="wdType">Tipo de chave Pix</label>
    <select id="wdType">
      <option value="cpf">CPF</option>
      <option value="email">E-mail</option>
      <option value="phone">Telefone</option>
      <option value="random">Aleatória</option>
    </select>
    <label for="wdKey">Chave Pix</label>
    <input id="wdKey" placeholder="A chave precisa ser do titular da conta">
    <label for="wdPw">Confirme sua senha</label>
    <input id="wdPw" type="password" autocomplete="current-password">
    <button class="bigbtn" id="wdGo">Solicitar saque</button>
    <p class="muted" style="margin-top:10px;">
      O valor sai da carteira assim que você pedir e fica retido até a análise.
      Saques passam por conferência manual antes do envio.
    </p>
  `;
  $('wdStatus').textContent = '';
  show('view-withdraw');

  $('wdGo')?.addEventListener('click', async () => {
    const el = $('wdStatus');
    $('wdGo').disabled = true;
    try {
      const r = await api.requestWithdrawal({
        amount: $('wdAmount').value,
        pixKeyType: $('wdType').value,
        pixKey: $('wdKey').value.trim(),
        password: $('wdPw').value,
      }, newIdempotencyKey());
      session.balanceCents = (await api.balance()).balanceCents;
      msg(el, `Saque de ${formatBRL(r.amountCents)} solicitado. Você será avisado quando for analisado.`, true);
      mm('cheer', 'Saque solicitado! 💸');
      setTimeout(() => { activeTab = 'carteira'; renderAccount(); show('view-account'); }, 2000);
    } catch (e) {
      msg(el, e.issues?.length ? e.issues[0].message : e.message);
      $('wdGo').disabled = false;
    }
  });
}

/* ================================================================== */
/* Início                                                              */
/* ================================================================== */

export async function initProfile(mascot) {
  MM = mascot;

  $('tabLogin').addEventListener('click', () => setAuthMode('login'));
  $('tabSignup').addEventListener('click', () => setAuthMode('signup'));
  $('authBtn').addEventListener('click', doAuth);
  ['inEmail', 'inPass'].forEach((id) =>
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuth(); }));

  $('backFromDeposit').addEventListener('click', () => { clearInterval(depositPoll); show('view-account'); });
  $('backFromWithdraw').addEventListener('click', () => show('view-account'));
  $('btnCreateDep').addEventListener('click', createDeposit);
  $('depChips').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      $('depChips').querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      $('depAmount').value = `${b.dataset.v},00`;
    }));

  // Já tem sessão? O cookie é httpOnly, então quem responde é o servidor.
  try {
    const current = await api.me();
    if (current.user) {
      session = current;
      await enterAccount();
      return;
    }
  } catch { /* sem sessão: segue para a tela de entrada */ }

  setAuthMode('login');
  mm('hello', 'Olá! Entre ou crie sua conta 👋');

  // Abre direto numa aba, se a URL pedir (ex.: vindo do desafio).
  const tab = new URLSearchParams(location.search).get('tab');
  if (tab && TABS.some(([id]) => id === tab)) activeTab = tab;
}
