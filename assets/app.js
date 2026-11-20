/* Casca do app: registro do service worker, convite de instalação e aviso de
 * atualização. Carregado por todas as páginas.
 *
 * Não encosta em dinheiro. Saldo, partida e pagamento continuam vindo da API
 * (assets/api.js) e só de lá.
 */
(function () {
  'use strict';

  const rodandoInstalado =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true ||            // iOS
    document.referrer.startsWith('android-app://');

  const ehNativo = !!(window.Capacitor && window.Capacitor.isNativePlatform &&
                      window.Capacitor.isNativePlatform());

  window.LPApp = { instalado: rodandoInstalado, nativo: ehNativo };
  document.documentElement.classList.toggle('app-instalado', rodandoInstalado || ehNativo);

  /* ---------------------------------------------------------- estilo */

  function injetarEstilo() {
    if (document.getElementById('lpapp-css')) return;
    const st = document.createElement('style');
    st.id = 'lpapp-css';
    st.textContent = `
      .lpapp-bar{
        position:fixed; left:50%; transform:translateX(-50%) translateY(140%);
        bottom:max(14px,env(safe-area-inset-bottom)); z-index:9999;
        width:min(520px,calc(100vw - 24px)); display:flex; align-items:center; gap:12px;
        padding:13px 14px; border-radius:16px; color:#eaf0ff;
        font:500 14px/1.45 'Exo 2','Segoe UI',system-ui,sans-serif;
        background:rgba(20,12,56,.92); border:1px solid rgba(140,160,255,.34);
        box-shadow:0 16px 44px rgba(0,0,0,.5); backdrop-filter:blur(12px);
        transition:transform .34s cubic-bezier(.22,1,.36,1);
      }
      .lpapp-bar.on{transform:translateX(-50%) translateY(0);}
      .lpapp-bar .ic{font-size:24px;line-height:1;flex:0 0 auto;}
      .lpapp-bar .tx{flex:1 1 auto;min-width:0;}
      .lpapp-bar .tx b{display:block;font-weight:700;}
      .lpapp-bar .tx small{display:block;opacity:.72;font-size:12.5px;}
      .lpapp-bar button{
        flex:0 0 auto; padding:9px 15px; border:0; border-radius:11px; cursor:pointer;
        font:700 14px/1 'Exo 2',system-ui,sans-serif; color:#fff;
        background:linear-gradient(135deg,#7b5cff,#ff3dcb);
      }
      .lpapp-bar .x{
        background:none; color:#eaf0ff; opacity:.5; font-size:21px; padding:4px 8px; line-height:1;
      }
      @media (prefers-reduced-motion:reduce){ .lpapp-bar{transition:none;} }
    `;
    document.head.appendChild(st);
  }

  function barra({ icone, titulo, detalhe, acao, aoAceitar, aoFechar }) {
    injetarEstilo();
    const el = document.createElement('div');
    el.className = 'lpapp-bar';
    el.setAttribute('role', 'status');
    el.innerHTML =
      `<span class="ic"></span><div class="tx"><b></b><small></small></div>` +
      `<button class="ok"></button><button class="x" aria-label="Fechar">×</button>`;
    el.querySelector('.ic').textContent = icone;
    el.querySelector('b').textContent = titulo;
    el.querySelector('small').textContent = detalhe;
    el.querySelector('.ok').textContent = acao;
    document.body.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));

    const fechar = () => { el.classList.remove('on'); setTimeout(() => el.remove(), 360); };
    el.querySelector('.ok').addEventListener('click', () => { fechar(); aoAceitar && aoAceitar(); });
    el.querySelector('.x').addEventListener('click', () => { fechar(); aoFechar && aoFechar(); });
    return fechar;
  }

  /* -------------------------------------------- service worker */

  // Em app nativo o conteudo ja vem empacotado; service worker so atrapalharia.
  if ('serviceWorker' in navigator && !ehNativo && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').then((reg) => {
        reg.addEventListener('updatefound', () => {
          const novo = reg.installing;
          if (!novo) return;
          novo.addEventListener('statechange', () => {
            // Ha versao nova esperando E ja existe uma controlando a pagina:
            // sem a segunda condicao, isto dispararia na primeira visita.
            if (novo.state === 'installed' && navigator.serviceWorker.controller) {
              barra({
                icone: '✨',
                titulo: 'Nova versão disponível',
                detalhe: 'Atualize para pegar as últimas correções.',
                acao: 'Atualizar',
                aoAceitar: () => { novo.postMessage('SKIP_WAITING'); },
              });
            }
          });
        });
      }).catch(() => { /* sem service worker o site funciona igual, so nao offline */ });

      let recarregando = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (recarregando) return;          // sem isto entra em laco de reload
        recarregando = true;
        location.reload();
      });
    });
  }

  /* ----------------------------------------------- instalacao */

  const CHAVE_ADIADO = 'lpg_instalar_adiado';
  const adiadoRecente = () => {
    try {
      const t = Number(localStorage.getItem(CHAVE_ADIADO) || 0);
      return Date.now() - t < 7 * 864e5;   // respeita o "agora nao" por uma semana
    } catch { return false; }
  };

  let promptGuardado = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();                 // impede o balao padrao do Chrome
    promptGuardado = e;
    if (rodandoInstalado || adiadoRecente()) return;

    // Espera um pouco: oferecer instalacao no primeiro segundo e intrusivo.
    setTimeout(() => {
      if (!promptGuardado) return;
      barra({
        icone: '🎲',
        titulo: 'Instalar o Ludo Pix Galaxy',
        detalhe: 'Abre direto da tela inicial, sem navegador.',
        acao: 'Instalar',
        aoAceitar: async () => {
          const p = promptGuardado; promptGuardado = null;
          try { p.prompt(); await p.userChoice; } catch { /* usuario fechou */ }
        },
        aoFechar: () => { try { localStorage.setItem(CHAVE_ADIADO, String(Date.now())); } catch {} },
      });
    }, 12000);
  });

  window.addEventListener('appinstalled', () => {
    promptGuardado = null;
    try { localStorage.removeItem(CHAVE_ADIADO); } catch {}
  });

  /* iOS nao tem beforeinstallprompt: la a instalacao e manual, pelo menu
     Compartilhar. Sem esta dica o usuario de iPhone simplesmente nao descobre. */
  const ehIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const ehSafari = ehIOS && !/crios|fxios|edgios/i.test(navigator.userAgent);
  if (ehIOS && ehSafari && !rodandoInstalado && !adiadoRecente()) {
    window.addEventListener('load', () => setTimeout(() => {
      barra({
        icone: '📲',
        titulo: 'Instalar no iPhone',
        detalhe: 'Toque em Compartilhar e depois em "Adicionar à Tela de Início".',
        acao: 'Entendi',
        aoAceitar: () => { try { localStorage.setItem(CHAVE_ADIADO, String(Date.now())); } catch {} },
        aoFechar: () => { try { localStorage.setItem(CHAVE_ADIADO, String(Date.now())); } catch {} },
      });
    }, 15000));
  }

  /** Permite chamar a instalação de um botão da própria página. */
  window.LPApp.instalar = async function () {
    if (!promptGuardado) return false;
    const p = promptGuardado; promptGuardado = null;
    try { p.prompt(); const r = await p.userChoice; return r.outcome === 'accepted'; }
    catch { return false; }
  };
  window.LPApp.podeInstalar = () => !!promptGuardado;
})();
