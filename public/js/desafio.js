/**
 * Tela de desafio.
 *
 * Reescrita completa da lógica do protótipo. O que mudou, e por quê:
 *
 *  • O saldo não é mais lido nem escrito pelo navegador. Era
 *    `db.doc(...).set({balance: bal + delta})`, ou seja, qualquer pessoa com
 *    o console aberto creditava o que quisesse.
 *  • Sumiu o botão "+R$50 de saldo teste". Saldo agora só entra por depósito
 *    confirmado.
 *  • Sumiu a votação de vencedor. Era o `reportWinner`, que além de confiar
 *    no jogador tinha o bug de apagar o voto do adversário — um desafio real
 *    entre duas pessoas nunca se resolvia e o dinheiro ficava preso.
 *  • Sumiu o `sim_bot`, com o qual dava para apostar, declarar a própria
 *    vitória e sacar 1,6x do valor.
 *  • Todo texto vindo de outro jogador passa por `esc()` antes de ir ao
 *    innerHTML. O nome do adversário era injetado cru.
 */

import { api, watchMatch, ApiError, formatBRL, esc, parseAmount, newIdempotencyKey } from './api.js';

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
const code = params.get('c');

let me = null;
let challenge = null;
let stream = null;
let lastMood = '';

const MM = createMascot({
  el: document.getElementById('mstage'),
  sprites: SPRM, charH: 124, ground: 14, stroll: true, tap: true,
});

function mood(key, fn) {
  if (lastMood === key) return;
  lastMood = key;
  fn();
}

const html = (s) => { app.innerHTML = s; };

const show = (message, kind = 'muted') =>
  html(`<p class="${kind}">${esc(message)}</p>`);

/** Mostra o erro certo para cada caso, em vez de "erro ao carregar". */
function renderError(err) {
  if (!(err instanceof ApiError)) {
    show('Algo deu errado. Recarregue a página.');
    return;
  }
  if (err.isAuth) {
    html(`
      <p class="muted">Entre na sua conta para desafiar alguém.</p>
      <a href="perfil.html" style="text-decoration:none;"><button class="bigbtn">Entrar</button></a>
    `);
    return;
  }
  if (err.isSelfExcluded) {
    const until = err.detail?.until ? new Date(err.detail.until).toLocaleString('pt-BR') : null;
    html(`
      <p class="muted">${esc(err.message)}</p>
      ${until ? `<p class="muted">Até ${esc(until)}.</p>` : ''}
      <a href="perfil.html" style="text-decoration:none;"><button class="bigbtn ghost">Ver minha conta</button></a>
    `);
    return;
  }
  if (err.isInsufficientFunds) {
    html(`
      <p class="muted">${esc(err.message)}</p>
      <a href="perfil.html?tab=carteira" style="text-decoration:none;">
        <button class="bigbtn">Adicionar saldo</button>
      </a>
    `);
    return;
  }
  show(err.message);
}

/* ------------------------------------------------------------------ */
/* Criação de desafio                                                  */
/* ------------------------------------------------------------------ */

let freeMode = false;

function showCreateForm(balanceCents) {
  mood('create', () => MM.react('hello', 'Crie seu desafio! ⚔️'));
  html(`
    <div class="tabs2">
      <button id="tabBet" class="on">💰 Com aposta</button>
      <button id="tabFree">🤝 Grátis</button>
    </div>
    <div id="betFields">
      <label for="amt">Valor da aposta</label>
      <input id="amt" type="text" inputmode="decimal" value="1,00" autocomplete="off">
      <div class="muted" style="margin-top:6px;">
        Seu saldo: <b id="balTxt">${esc(formatBRL(balanceCents))}</b>
      </div>
    </div>
    <div id="freeNote" style="display:none;" class="muted">Partida amistosa, sem dinheiro envolvido.</div>
    <div id="createErr" class="muted" style="color:#ffb3ab; margin-top:8px;"></div>
    <button class="bigbtn" id="createBtn">Criar desafio</button>
    <a href="perfil.html?tab=carteira" style="text-decoration:none;">
      <button class="bigbtn ghost">Adicionar saldo</button>
    </a>
  `);

  const setTab = (free) => {
    freeMode = free;
    document.getElementById('tabBet').classList.toggle('on', !free);
    document.getElementById('tabFree').classList.toggle('on', free);
    document.getElementById('betFields').style.display = free ? 'none' : 'block';
    document.getElementById('freeNote').style.display = free ? 'block' : 'none';
  };
  document.getElementById('tabBet').addEventListener('click', () => setTab(false));
  document.getElementById('tabFree').addEventListener('click', () => setTab(true));
  document.getElementById('createBtn').addEventListener('click', createChallenge);
}

async function createChallenge(ev) {
  const btn = ev.currentTarget;
  const errBox = document.getElementById('createErr');
  errBox.textContent = '';

  let amount = null;
  if (!freeMode) {
    amount = parseAmount(document.getElementById('amt').value);
    if (amount === null || amount <= 0) {
      errBox.textContent = 'Informe um valor como 10 ou 10,50.';
      return;
    }
  }

  btn.disabled = true;
  try {
    const created = await api.createChallenge(
      { free: freeMode, amount: amount === null ? undefined : (amount / 100).toFixed(2), country: detectedCountry },
      newIdempotencyKey(),
    );
    history.replaceState(null, '', `?c=${encodeURIComponent(created.code)}`);
    await loadChallenge(created.code);
  } catch (err) {
    btn.disabled = false;
    if (err instanceof ApiError && (err.isInsufficientFunds || err.isSelfExcluded)) {
      renderError(err);
    } else {
      errBox.textContent = err.message;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Desafio existente                                                   */
/* ------------------------------------------------------------------ */

async function loadChallenge(c) {
  html('<div class="spinner"></div>');
  try {
    challenge = await api.getChallenge(c);
    render();
  } catch (err) {
    renderError(err);
  }
}

function shareLink(c) {
  return `${location.origin}${location.pathname}?c=${encodeURIComponent(c)}`;
}

function render() {
  const d = challenge;
  const iAmCreator = d.creatorId === me?.id;
  const otherName = iAmCreator ? d.opponentName : d.creatorName;
  const stakeLine = d.stakeCents > 0
    ? `Aposta de <b>${esc(formatBRL(d.stakeCents))}</b>.`
    : 'Desafio <b>grátis</b>, sem aposta.';

  /* --- esperando adversário --- */
  if (d.status === 'open') {
    if (iAmCreator) {
      mood('wait', () => MM.react('look', 'Chame alguém! 📨'));
      const link = shareLink(d.code);
      html(`
        <p class="muted">${stakeLine}</p>
        <p class="muted">Mande este link para quem você quer desafiar:</p>
        <div class="code" id="linkBox">${esc(link)}</div>
        <button class="bigbtn" id="copyBtn">Copiar link</button>
        <p class="muted" style="margin-top:14px;">
          Código: <b>${esc(d.code)}</b> · expira ${esc(new Date(d.expiresAt).toLocaleTimeString('pt-BR'))}
        </p>
        <button class="bigbtn ghost" id="cancelBtn">Cancelar desafio</button>
      `);
      document.getElementById('copyBtn').addEventListener('click', async (e) => {
        try {
          await navigator.clipboard.writeText(link);
          e.target.textContent = 'Link copiado ✔';
          setTimeout(() => { e.target.textContent = 'Copiar link'; }, 1800);
        } catch {
          // Clipboard bloqueado: o link está na tela, dá para copiar à mão.
          e.target.textContent = 'Copie o link acima';
        }
      });
      document.getElementById('cancelBtn').addEventListener('click', async () => {
        try {
          await api.cancelChallenge(d.code);
          if (d.stakeCents > 0) {
            show('Desafio cancelado. Sua aposta voltou para a carteira.', 'muted');
          } else {
            show('Desafio cancelado.', 'muted');
          }
        } catch (err) { renderError(err); }
      });
      // O criador espera; consultamos de tempos em tempos até alguém entrar.
      scheduleRefresh();
    } else {
      mood('join', () => MM.react('hello', 'Aceita o desafio? 🎲'));
      html(`
        <p><b>${esc(d.creatorName ?? 'Alguém')}</b> te desafiou!</p>
        <p class="muted">${stakeLine}</p>
        ${d.stakeCents > 0
          ? `<p class="muted">Ao aceitar, ${esc(formatBRL(d.stakeCents))} saem da sua carteira e ficam retidos até o fim da partida.</p>`
          : ''}
        <div id="joinErr" class="muted" style="color:#ffb3ab;"></div>
        <button class="bigbtn" id="joinBtn">Aceitar desafio</button>
      `);
      document.getElementById('joinBtn').addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        try {
          const joined = await api.joinChallenge(d.code, detectedCountry, newIdempotencyKey());
          location.href = `jogo.html?match=${encodeURIComponent(joined.match.id)}`;
        } catch (err) {
          e.currentTarget.disabled = false;
          if (err instanceof ApiError && (err.isInsufficientFunds || err.isSelfExcluded || err.isAuth)) {
            renderError(err);
          } else {
            document.getElementById('joinErr').textContent = err.message;
          }
        }
      });
    }
    return;
  }

  /* --- partida em andamento --- */
  if (d.status === 'playing' && d.matchId) {
    mood('playing', () => MM.react('cheer', 'Valendo! Boa sorte 🍀'));
    html(`
      <p class="muted">${d.stakeCents > 0
        ? `Ambos apostaram <b>${esc(formatBRL(d.stakeCents))}</b>. Pote: <b>${esc(formatBRL(d.stakeCents * 2))}</b>.`
        : 'Partida amistosa, sem aposta.'}</p>
      <p class="muted">Contra <b>${esc(otherName ?? 'adversário')}</b>.</p>
      <a href="jogo.html?match=${encodeURIComponent(d.matchId)}" style="text-decoration:none;">
        <button class="bigbtn">🎲 Ir para o jogo</button>
      </a>
      <p class="muted" style="margin-top:14px;">
        O vencedor é definido pelo servidor, pelas regras do jogo. Não há nada para confirmar aqui.
      </p>
    `);
    // Acompanha o fim pelo mesmo fluxo em tempo real da partida.
    stream?.close();
    stream = watchMatch(d.matchId, { onEnd: () => loadChallenge(d.code) });
    return;
  }

  /* --- liquidado --- */
  if (d.status === 'settled') {
    const iWon = d.winnerId === me?.id;
    mood(`done${iWon}`, () => (iWon ? MM.react('dance', 'Parabéns! 🏆') : MM.react('sad', 'Na próxima! 💪')));

    const pot = d.stakeCents * 2;
    // A comissão vem do servidor, congelada na criação do desafio.
    const commission = Math.floor((pot * (d.commissionBps ?? 2000)) / 10000);
    const prize = pot - commission;

    html(`
      <p><span class="badge ${iWon ? 'win' : 'lose'}">${iWon ? '🏆 Você venceu!' : 'Você perdeu'}</span></p>
      ${d.stakeCents > 0 ? `
        <p class="muted">
          Pote ${esc(formatBRL(pot))} · vencedor recebe ${esc(formatBRL(prize))} ·
          plataforma fica com ${esc(formatBRL(commission))}.
        </p>
        ${iWon ? '<p class="muted">Valor já creditado na sua carteira.</p>' : ''}
      ` : '<p class="muted">Partida amistosa — sem valores envolvidos.</p>'}
      ${d.matchId ? `
        <button class="bigbtn ghost" id="fairBtn">Conferir se o dado foi justo</button>
        <div id="fairBox" class="muted" style="margin-top:10px;"></div>
      ` : ''}
      <a href="${esc(location.pathname)}" style="text-decoration:none;">
        <button class="bigbtn">Novo desafio</button>
      </a>
    `);

    document.getElementById('fairBtn')?.addEventListener('click', () => showFairness(d.matchId));
    return;
  }

  /* --- demais estados --- */
  const messages = {
    cancelled: 'Este desafio foi cancelado.',
    expired: 'Este desafio expirou sem adversário.' + (d.stakeCents > 0 ? ' Sua aposta foi devolvida.' : ''),
    voided: 'Este desafio foi anulado e as apostas foram devolvidas.',
  };
  html(`
    <p class="muted">${esc(messages[d.status] ?? 'Desafio indisponível.')}</p>
    <a href="${esc(location.pathname)}" style="text-decoration:none;">
      <button class="bigbtn">Novo desafio</button>
    </a>
  `);
}

/**
 * Prova de lisura do dado.
 *
 * O servidor publica o hash do seed ANTES da partida e revela o seed depois.
 * Aqui recalculamos todos os lances no navegador e conferimos. Se o servidor
 * tivesse trocado o seed para favorecer alguém, o hash não bateria.
 */
async function showFairness(matchId) {
  const box = document.getElementById('fairBox');
  box.textContent = 'Conferindo…';
  try {
    const proof = await api.fairness(matchId);

    const enc = new TextEncoder();
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(proof.serverSeed));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const commitOk = hash === proof.serverSeedHash;

    // Recalcula os lances com o mesmo HMAC que o servidor usou.
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(proof.serverSeed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const rolls = [];
    for (let nonce = 0; nonce < proof.rollCount; nonce += 1) {
      const sig = new Uint8Array(await crypto.subtle.sign(
        'HMAC', key, enc.encode(`${proof.clientSeed}:${proof.matchId}:${nonce}`),
      ));
      const byte = [...sig].find((b) => b < 252);
      rolls.push((byte % 6) + 1);
    }
    const logged = proof.events.filter((e) => e.type === 'roll').map((e) => e.payload.die);
    const rollsOk = logged.every((die, i) => die === rolls[i]);

    box.innerHTML = `
      <p>${commitOk ? '✅' : '❌'} O seed revelado corresponde ao hash publicado antes da partida.</p>
      <p>${rollsOk ? '✅' : '❌'} Os ${logged.length} lances do jogo batem com o recálculo.</p>
      <p style="opacity:.7; font-size:11px; word-break:break-all;">
        hash publicado: ${esc(proof.serverSeedHash)}
      </p>
    `;
  } catch (err) {
    box.textContent = err.message;
  }
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      const fresh = await api.getChallenge(challenge.code);
      if (fresh.status !== challenge.status) { challenge = fresh; render(); }
      else scheduleRefresh();
    } catch { scheduleRefresh(); }
  }, 4000);
}

/* ------------------------------------------------------------------ */

async function init() {
  try {
    const session = await api.me();
    me = session.user;
    if (!me) {
      html(`
        <p class="muted">Entre na sua conta para criar ou aceitar um desafio.</p>
        <a href="perfil.html" style="text-decoration:none;"><button class="bigbtn">Entrar</button></a>
      `);
      return;
    }
    if (code) await loadChallenge(code);
    else showCreateForm(session.balanceCents);
  } catch (err) {
    renderError(err);
  }
}

window.addEventListener('beforeunload', () => stream?.close());
init();
