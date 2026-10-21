# 🪐 Ludo Pix Galaxy

Protótipo de um jogo de Ludo com tema galáxia, perfil de jogador, carteira (Pix/cartão simulados) e desafios entre amigos.
Tudo em HTML/CSS/JavaScript puro, sem dependências nem etapa de build.

## Páginas

| Arquivo | O que é |
|---|---|
| `index.html` | Página inicial: cena animada com a mascote, música de fundo e menu |
| `jogo.html` | Tabuleiro de Ludo (2 a 4 jogadores, duplas, dado 3D, sons sintetizados, comemoração com bandeira do país do campeão) |
| `desafio.html` | Desafio entre amigos (grátis ou com aposta, divisão 80% / 20%) |
| `perfil.html` | Conta do jogador: dados, verificação (KYC simulada), carteira, segurança, limites de jogo responsável |

## Como rodar

```bash
# opção 1: abrir o index.html no navegador
# opção 2: servidor local
python3 -m http.server 8000   # e acessar http://localhost:8000
```

## GitHub Pages

Em **Settings → Pages**, escolha *Deploy from a branch*, branch `main`, pasta `/ (root)`.

## O que funciona sozinho e o que depende de servidor

- **Funciona só no navegador:** início, jogo (modo livre/local) e perfil (dados salvos em `localStorage`).
- **Depende do ambiente do Claude (`claude.use('db')` / `claude.use('user')`):** o desafio entre amigos e as partidas valendo aposta (`jogo.html?match=...`). Fora do claude.ai essas partes mostram "não foi possível carregar".
- Para funcionar de verdade na web é preciso um **backend próprio** (contas, saldo, partidas sincronizadas, dado decidido no servidor).

## Aviso

Protótipo em desenvolvimento. Depósitos, saques e verificação de documento são **simulados**; nenhum dado de cartão é guardado
e nenhum dinheiro real é movimentado. O modo de teste do dado (`SIX_TEST_MODE` em `jogo.html`) deve ser desligado antes de qualquer uso real.

## Tecnologia

HTML/CSS/JS puro · Web Audio (sons e música gerados em código) · WebGL (animação da mascote com física de mola) · SVG (bandeiras).
