/* Service worker.
 *
 * A REGRA QUE MANDA AQUI: nada de dinheiro entra em cache. Nunca.
 *
 * Um service worker guarda respostas para servir depois sem rede. Isso e otimo
 * para a casca do app (HTML, CSS, sprites) e e uma armadilha para saldo, extrato
 * e estado de partida: o jogador abriria o app e veria um saldo de ontem como se
 * fosse o de agora, ou uma partida que ja acabou como se estivesse em andamento.
 * Pior, agiria em cima disso.
 *
 * Por isso tudo sob /api/ passa direto para a rede, sem cache, sem fallback.
 * Se nao ha rede, a tela mostra erro — que e a verdade — em vez de um numero
 * velho que parece verdade.
 */

/* Troque a versao a cada deploy: e o que faz o navegador baixar a casca nova.
   O build do app sobrescreve esta linha automaticamente (ver app/build.mjs). */
const VERSAO = 'lpg-v1';
const CACHE_CASCA = `casca-${VERSAO}`;

/* A casca do app: o que e preciso para a interface abrir.
   Paginas que dependem de dinheiro (desafio, perfil) NAO entram aqui: elas sao
   buscadas da rede, porque abrir uma versao velha delas confunde mais do que
   ajuda. */
const CASCA = [
  '/',
  '/index.html',
  '/jogo.html',
  '/offline.html',
  '/manifest.webmanifest',
  '/assets/api.js',
  '/assets/mascot.js',
  '/assets/music.js',
  '/assets/sprites.js',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE_CASCA);
    // addAll falha inteiro se UM arquivo falhar; aqui cada um e tratado a parte
    // para um sprite ausente nao impedir a instalacao do service worker.
    await Promise.allSettled(CASCA.map((u) => c.add(new Request(u, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(nomes.filter((n) => n !== CACHE_CASCA).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

const ehApi = (url) => url.pathname.startsWith('/api/');

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Só mexemos no que é nosso e no que é GET. POST de aposta/saque jamais.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  /* API: rede e so rede. Sem cache de leitura, sem cache de escrita, sem
     fallback offline. Saldo e partida tem de vir do servidor ou nao vir. */
  if (ehApi(url)) return;

  // Navegação: tenta a rede primeiro para sempre pegar a versão publicada;
  // só cai no cache (ou na página offline) quando não há rede.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const resp = await fetch(req);
        // Guarda só páginas da casca; desafio/perfil ficam de fora de propósito.
        if (resp.ok && CASCA.includes(url.pathname)) {
          const c = await caches.open(CACHE_CASCA);
          c.put(req, resp.clone());
        }
        return resp;
      } catch {
        return (await caches.match(req))
            || (await caches.match('/offline.html'))
            || new Response('Sem conexão', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  // Estáticos (sprites, scripts, ícones): cache primeiro, que é o que deixa o
  // app abrir rápido e funcionar sem rede no modo livre.
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) {
      // Revalida em segundo plano: a próxima abertura já pega a versão nova.
      e.waitUntil((async () => {
        try {
          const fresca = await fetch(req);
          if (fresca.ok) (await caches.open(CACHE_CASCA)).put(req, fresca);
        } catch { /* sem rede: o cache serviu, está tudo bem */ }
      })());
      return hit;
    }
    try {
      const resp = await fetch(req);
      if (resp.ok && resp.type === 'basic') (await caches.open(CACHE_CASCA)).put(req, resp.clone());
      return resp;
    } catch {
      return new Response('', { status: 504 });
    }
  })());
});

/* A página manda SKIP_WAITING quando o usuário aceita atualizar. */
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
