/* Cliente da API.
 *
 * Esta e a UNICA porta pela qual o front fala de dinheiro. Nenhuma pagina
 * escreve saldo, decide vencedor ou sorteia dado — tudo isso passa por aqui e
 * e decidido no servidor.
 *
 * Valores trafegam em CENTAVOS INTEIROS (`...Cents`). Converter para reais so
 * na hora de mostrar na tela, com LP.fmt(). Fazer conta em float com dinheiro
 * perde centavo, e foi assim que o codigo antigo calculava o premio.
 *
 * A sessao vive num cookie httpOnly posto pelo servidor: o JS desta pagina nao
 * consegue ler o token, entao um XSS tambem nao consegue roubar a sessao.
 */
const LP = (function () {
  const BASE = window.LUDOPIX_API || '';

  class ApiError extends Error {
    constructor(status, code, message) {
      super(message || code || `HTTP ${status}`);
      this.status = status;
      this.code = code;
    }
  }

  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        // Sem isto o cookie de sessao nao e enviado e tudo responde 401.
        credentials: 'include',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiError(0, 'OFFLINE', 'Nao foi possivel falar com o servidor.');
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* resposta nao-JSON */ }
    if (!res.ok) throw new ApiError(res.status, data?.error, data?.message);
    return data;
  }

  const get  = (p) => call('GET', p);
  const post = (p, b) => call('POST', p, b ?? {});

  /* ---------------------------------------------------------- formato */

  /** Centavos inteiros -> "R$ 12,34". */
  const fmt = (cents) =>
    (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  /**
   * "12,34" ou "12.34" -> 1234 centavos, sem passar por float.
   * `Math.round(parseFloat("8.07") * 100)` ja erra em alguns valores; por isso
   * aqui os centavos sao lidos como texto.
   */
  function parseCents(input) {
    const s = String(input ?? '').trim().replace(/[R$\s]/g, '').replace(',', '.');
    if (!/^\d*\.?\d{0,2}$/.test(s) || s === '' || s === '.') return null;
    const [reais, cents = ''] = s.split('.');
    return Number(reais || '0') * 100 + Number(cents.padEnd(2, '0'));
  }

  /** Escapa texto antes de entrar em innerHTML. */
  const esc = (s) => String(s == null ? '' : s)
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  return {
    ApiError, fmt, parseCents, esc,

    // ---- contas
    register: (email, name, password) => post('/api/auth/register', { email, name, password }),
    login:    (email, password)       => post('/api/auth/login', { email, password }),
    logout:   ()                      => post('/api/auth/logout'),
    me:       ()                      => get('/api/me'),
    changePassword: (current, next)   => post('/api/me/password', { current, next }),

    // ---- perfil, verificacao e jogo responsavel
    getProfile:    ()      => get('/api/me/profile'),
    updateProfile: (data)  => post('/api/me/profile', data),
    setLimits:     (lim)   => post('/api/me/limits', lim),
    pause:         (days)  => post('/api/me/pause', { days }),
    selfExclude:   (days)  => post('/api/me/self-exclude', { days }),
    submitKyc:     (docType) => post('/api/me/kyc', { docType }),

    // ---- carteira
    wallet:   ()                      => get('/api/wallet'),
    deposit:  (amountCents)           => post('/api/wallet/deposit', { amountCents }),
    withdraw: (amountCents, pixKey)   => post('/api/wallet/withdraw', { amountCents, pixKey }),

    // ---- desafios
    createChallenge: (stakeCents)     => post('/api/challenges', { stakeCents }),
    acceptChallenge: (code)           => post(`/api/challenges/${encodeURIComponent(code)}/accept`),
    cancelChallenge: (code)           => post(`/api/challenges/${encodeURIComponent(code)}/cancel`),
    forfeit:         (code)           => post(`/api/challenges/${encodeURIComponent(code)}/forfeit`),
    getChallenge:    (code)           => get(`/api/challenges/${encodeURIComponent(code)}`),
    roll: (code, version)             => post(`/api/challenges/${encodeURIComponent(code)}/roll`, { version }),
    move: (code, tokenIdx, version)   => post(`/api/challenges/${encodeURIComponent(code)}/move`, { tokenIdx, version }),

    /**
     * Acompanha uma partida por polling.
     * Websocket seria melhor, mas polling atravessa qualquer proxy e nao cai
     * em rede movel instavel — e para um jogo de turnos o atraso nao incomoda.
     * Devolve uma funcao que interrompe o acompanhamento.
     */
    watchChallenge(code, onState, { intervalMs = 1500 } = {}) {
      let stop = false, lastVersion = -1, timer = null;
      let delay = intervalMs;
      (async function tick() {
        if (stop) return;
        try {
          const st = await LP.getChallenge(code);
          delay = intervalMs;                       // deu certo: volta ao ritmo normal
          if (st.version !== lastVersion) { lastVersion = st.version; onState(st); }
          if (st.status === 'resolved' || st.status === 'cancelled') return;
        } catch (err) {
          // Recuo exponencial: se o servidor cair, nao o bombardeamos.
          delay = Math.min(delay * 2, 30000);
          if (err.status === 401 || err.status === 404) return;
        }
        timer = setTimeout(tick, delay);
      })();
      return () => { stop = true; clearTimeout(timer); };
    },

    /**
     * Confere que as rolagens de uma partida batem com o hash publicado no inicio.
     * E o que permite ao jogador verificar que o dado nao foi escolhido a dedo.
     * Rode no console depois da partida: LP.verifyFairness(code, serverSeed, rolls)
     */
    async verifyFairness(code, serverSeed, rolls) {
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey('raw', enc.encode(serverSeed),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const out = [];
      for (const { nonce, value } of rolls) {
        const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${code}:${nonce}`)));
        let expected = (sig[sig.length - 1] % 6) + 1;
        for (const b of sig) if (b < 252) { expected = (b % 6) + 1; break; }
        out.push({ nonce, value, expected, ok: expected === value });
      }
      return { allOk: out.every((r) => r.ok), rolls: out };
    },
  };
})();

if (typeof window !== 'undefined') window.LP = LP;
