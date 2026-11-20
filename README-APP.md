# O aplicativo

O projeto vira app por dois caminhos, dos mesmos arquivos:

| | PWA | APK Android |
|---|---|---|
| Instalação | do navegador, 2 toques | arquivo `.apk`, download direto |
| iPhone | ✅ | ❌ |
| Android | ✅ | ✅ |
| Atualização | automática | nova instalação |
| Offline | modo livre funciona | modo livre funciona |

> **Por que não está nas lojas:** Google Play exige que o operador tenha
> licença **no país do jogador**, e a Apple exige que a conta de desenvolvedor
> seja a entidade licenciada. Por isso nenhuma casa de apostas grande no Brasil
> está nas lojas — todas distribuem PWA ou APK direto. Publicar ali hoje
> resultaria em reprovação, não em app no ar.

---

## PWA

Não exige nada: já está pronto assim que o servidor estiver no ar
(veja `DEPLOY.md`).

**Android/Chrome** — o app se oferece sozinho depois de ~12s de uso, ou pelo
menu ⋮ → *Instalar aplicativo*.

**iPhone/Safari** — a Apple não permite o convite automático, então aparece uma
dica: Compartilhar → *Adicionar à Tela de Início*.

Quem dispensar o convite não é incomodado de novo por uma semana.

### O que funciona sem internet

Só o **modo livre**. Carteira, desafios e partidas valendo aposta exigem rede,
**de propósito**: esses números vivem no servidor, e mostrar um saldo guardado
no aparelho seria mostrar um saldo errado — que o jogador usaria para decidir
quanto apostar. Sem rede, o app diz que está sem rede.

---

## APK Android

O APK é compilado pelo **GitHub Actions**, que já tem o SDK do Android — não
precisa instalar Android Studio.

### 1. Configure a URL da API

GitHub → **Settings → Secrets and variables → Actions → Variables → New**:

```
Nome:  LUDOPIX_API
Valor: https://seudominio.com
```

Sem isso o build falha de propósito: um APK apontando para lugar nenhum instala,
abre e falha em tudo que importa.

### 2. Crie a chave de assinatura (uma vez)

```bash
keytool -genkeypair -v -keystore ludopix.jks \
  -keyalg RSA -keysize 2048 -validity 10000 -alias ludopix
```

> 🔑 **Guarde esse arquivo e as senhas em lugar seguro.**
> Perdeu o keystore, perdeu a capacidade de atualizar quem já instalou: o
> Android recusa um APK assinado por outra chave, e a única saída passa a ser
> pedir que todo mundo desinstale e instale de novo.

Converta para base64 e guarde como secret:

```bash
base64 -w0 ludopix.jks        # Linux
base64 -i ludopix.jks         # macOS
```

Em **Secrets → New repository secret**, crie os quatro:

| Secret | Valor |
|---|---|
| `ANDROID_KEYSTORE_B64` | a saída do base64 |
| `ANDROID_KEYSTORE_PASS` | senha do keystore |
| `ANDROID_KEY_ALIAS` | `ludopix` |
| `ANDROID_KEY_PASS` | senha da chave |

### 3. Compile

GitHub → aba **Actions** → **APK Android** → **Run workflow**.

Ao terminar, o APK está em **Artifacts**, no fim da página. Ou crie uma tag
(`git tag v1.0.0 && git push --tags`) para compilar sozinho.

Sem os secrets o workflow ainda roda e entrega um APK de **debug**: serve para
testar no seu aparelho, não para distribuir.

### 4. Distribua

Hospede o `.apk` e mande o link. O jogador precisa permitir "instalar de fontes
desconhecidas" — é o fluxo normal fora da Play Store.

---

## Compilar localmente (opcional)

```bash
cd app
npm install
LUDOPIX_API=https://seudominio.com npm run build
npx cap add android
npx @capacitor/assets generate --android --assetPath resources
npx cap sync android
cd android && ./gradlew assembleDebug
```

Precisa de JDK 21 e do Android SDK. O APK sai em
`app/android/app/build/outputs/apk/debug/`.

---

## Como o app se autentica

Detalhe que importa para quem for mexer no código:

- **Web** — cookie `httpOnly`. O JavaScript da página não lê o token, então um
  XSS também não rouba a sessão.
- **App nativo** — `Authorization: Bearer`. No APK a página roda em
  `capacitor://localhost` e a API está em outro domínio, onde o cookie
  simplesmente não é enviado.

É a **mesma** sessão, a mesma tabela e o mesmo prazo — só o transporte muda. O
servidor só devolve o token a quem pede com `X-Auth-Mode: token`, para que a web
continue protegida pelo `httpOnly`.

---

## Pendência conhecida: fontes

As páginas carregam Orbitron e Exo 2 do Google Fonts. Consequências:

- **Offline o app troca para a fonte do sistema.** Continua legível e usável —
  o CSS tem fallback — mas muda a aparência.
- A primeira abertura espera um servidor de terceiros, o que atrasa o
  carregamento e entrega o IP dos seus jogadores ao Google.

Para resolver, hospede as fontes junto com o app (não consegui fazer isso aqui
porque este ambiente não alcança o `fonts.gstatic.com`):

```bash
# 1. Baixe os .woff2 em https://gwfh.mranftl.com (Orbitron 600/800, Exo 2 400/600/700)
# 2. Coloque em assets/fonts/
# 3. Nas 4 páginas, troque o <link> do Google por um @font-face local
# 4. Acrescente os .woff2 à lista CASCA no sw.js, para ficarem disponíveis offline
```

Depois disso dá para remover `fonts.googleapis.com` e `fonts.gstatic.com` do CSP
em `server/src/http.js`, deixando a política mais fechada.

---

## Ícones

Fonte em `assets/icon-src/icon.svg`. Para regerar depois de editar:

```bash
for s in 16 32 48 72 96 128 144 152 180 192 256 384 512; do
  rsvg-convert -w $s -h $s assets/icon-src/icon.svg -o assets/icons/icon-$s.png
done
rsvg-convert -w 1024 -h 1024 assets/icon-src/icon.svg -o app/resources/icon.png
```

A variante `icon-maskable.svg` tem o conteúdo encolhido para a zona segura: o
Android recorta o ícone em círculo, e sem essa margem as bordas somem.
