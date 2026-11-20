/* Monta app/www/ — o pacote de arquivos que vai dentro do APK.
 *
 * O app nativo carrega a interface do proprio aparelho (nao baixa a cada
 * abertura), mas TODO dado de dinheiro continua vindo da API pela rede. Nada
 * de saldo ou partida e empacotado aqui.
 *
 * Uso:
 *   LUDOPIX_API=https://api.seudominio.com node build.mjs
 *
 * A URL da API e obrigatoria: um APK apontando para lugar nenhum instala,
 * abre e falha em tudo que importa. Melhor falhar no build.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(AQUI, '..');
const WWW = path.join(AQUI, 'www');

const API = (process.env.LUDOPIX_API || '').trim().replace(/\/+$/, '');
if (!API) {
  console.error(`
[build] Falta LUDOPIX_API.

  Este APK precisa saber onde fica o servidor. Sem isso ele abre e nada
  funciona: login, carteira e desafios falham todos.

  Exemplo:
    LUDOPIX_API=https://api.seudominio.com node build.mjs
`);
  process.exit(1);
}
if (!/^https:\/\//.test(API) && !process.env.PERMITIR_HTTP) {
  console.error(`
[build] LUDOPIX_API precisa ser https.

  Recebido: ${API}

  O Android bloqueia trafego em texto puro por padrao, e aqui trafegam
  credenciais e valores. Para um servidor de teste local, repita com
  PERMITIR_HTTP=1 — nunca para a build que vai para os jogadores.
`);
  process.exit(1);
}

const PAGINAS = ['index.html', 'jogo.html', 'desafio.html', 'perfil.html', 'offline.html'];

fs.rmSync(WWW, { recursive: true, force: true });
fs.mkdirSync(WWW, { recursive: true });

// assets/ inteiro, menos as fontes dos icones (so interessam no build do icone)
fs.cpSync(path.join(RAIZ, 'assets'), path.join(WWW, 'assets'), {
  recursive: true,
  filter: (src) => !src.includes(`${path.sep}icon-src`),
});
fs.copyFileSync(path.join(RAIZ, 'favicon.ico'), path.join(WWW, 'favicon.ico'));

let paginas = 0;
for (const nome of PAGINAS) {
  const origem = path.join(RAIZ, nome);
  if (!fs.existsSync(origem)) { console.warn(`[build] ausente, pulando: ${nome}`); continue; }
  let html = fs.readFileSync(origem, 'utf8');

  /* Sem manifest nem service worker no pacote nativo: o app ja e instalado, e
     um service worker aqui so criaria uma segunda camada de cache para
     confundir atualizacao. */
  html = html.replace(/\s*<link rel="manifest"[^>]*>/g, '');

  /* Aponta a API. Entra ANTES de api.js, que le window.LUDOPIX_API na carga. */
  const cfg = `<script>window.LUDOPIX_API=${JSON.stringify(API)};</script>\n`;
  if (html.includes('assets/api.js')) {
    html = html.replace(/(<script src="[^"]*assets\/api\.js"><\/script>)/, `${cfg}$1`);
  } else {
    html = html.replace('</head>', `${cfg}</head>`);
  }

  fs.writeFileSync(path.join(WWW, nome), html);
  paginas++;
}

const tamanho = (d) => {
  let t = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    t += e.isDirectory() ? tamanho(p) : fs.statSync(p).size;
  }
  return t;
};

console.log(`[build] ${paginas} páginas empacotadas`);
console.log(`[build] API: ${API}`);
console.log(`[build] www/: ${(tamanho(WWW) / 1024).toFixed(0)} KB`);
