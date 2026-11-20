# Colocar no ar

O servidor entrega a API **e** o site (que é o mesmo PWA que o jogador instala).
Um serviço só, um domínio só.

> ⚠️ **A regra que não pode ser quebrada: disco persistente.**
> O banco guarda saldo, contas e histórico. Em hospedagem com disco efêmero —
> o padrão em quase todo plano gratuito — **cada deploy apaga tudo**, e com isso
> some o dinheiro de todos os jogadores. Não existe "arrumar depois": o dado já
> foi. Toda configuração aqui monta um volume de verdade.

---

## Por que Fly.io

Escolhi o Fly por dois motivos concretos:

1. **Região `gru` (São Paulo).** A partida consulta o servidor a cada 1,5s.
   Servidor nos EUA soma ~120ms em cada ida e volta, o que o jogador sente como
   travamento. Railway e Render não têm região no Brasil.
2. **Volume persistente barato**, que é o requisito inegociável acima.

O `Dockerfile` é portátil: Railway, Render, VPS ou qualquer lugar que rode
container servem igual. Só garanta o disco.

---

## Passo a passo (Fly.io)

```bash
# 1. Instale e entre
curl -L https://fly.io/install.sh | sh
fly auth signup        # ou: fly auth login

# 2. Crie o app (o nome é global — escolha outro se "ludo-pix-galaxy" existir)
fly apps create ludo-pix-galaxy

# 3. Crie o volume do banco, na mesma região do app
fly volumes create lpg_dados --region gru --size 3

# 4. Segredos (nunca no repositório)
fly secrets set \
  PSP_API_KEY="sua-chave-do-gateway" \
  PSP_WEBHOOK_SECRET="segredo-do-webhook" \
  ADMIN_TOKEN="$(openssl rand -hex 32)"

# 5. Suba
fly deploy

# 6. Confira
fly status
curl https://ludo-pix-galaxy.fly.dev/api/health
```

Em produção o servidor **se recusa a subir** sem `PSP_API_KEY` e
`PSP_WEBHOOK_SECRET` — é proposital: sem elas, pagamento ficaria em modo
simulado sem ninguém perceber.

### Domínio próprio

```bash
fly certs create seudominio.com      # mostra os registros DNS para criar
fly certs show seudominio.com        # acompanha a emissão do certificado
```

Depois, informe a origem ao servidor para o anti-CSRF aceitá-la:

```bash
fly secrets set ALLOWED_ORIGINS="https://seudominio.com"
```

---

## Backup — faça antes de precisar

Backup que nunca foi restaurado não é backup; é esperança. Teste a restauração
pelo menos uma vez.

```bash
# Baixar uma cópia do banco
fly ssh console -C "cat /dados/ludopix.db" > backup-$(date +%F).db

# Conferir que a cópia presta (tem de responder "ok")
sqlite3 backup-$(date +%F).db "PRAGMA integrity_check;"

# Conferir que o livro-razão fecha
curl -H "x-admin-token: SEU_ADMIN_TOKEN" https://seudominio.com/api/_audit
```

O banco usa WAL, então o `.db` sozinho pode estar momentos atrás do estado
real. Para cópia exata com o serviço no ar:

```bash
fly ssh console -C "sqlite3 /dados/ludopix.db \".backup '/dados/bkp.db'\""
fly ssh console -C "cat /dados/bkp.db" > backup-consistente.db
```

Agende isso diariamente. É o que separa um incidente de uma catástrofe.

---

## Outros provedores

**Railway** — `Dockerfile` é detectado sozinho. Crie um *Volume* montado em
`/dados` e defina as variáveis. Sem região no Brasil.

**Render** — *New Web Service* → Docker. Adicione um *Disk* em `/dados`
(exige plano pago; o gratuito **apaga o banco** a cada deploy). Defina
`DATA_DIR=/dados`.

**VPS** — qualquer um com Docker:

```bash
docker build -t ludopix .
docker volume create lpg_dados
docker run -d --name ludopix --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v lpg_dados:/dados \
  -e NODE_ENV=production -e TRUST_PROXY=1 \
  -e PSP_API_KEY=... -e PSP_WEBHOOK_SECRET=... -e ADMIN_TOKEN=... \
  ludopix
```

Ponha nginx ou Caddy na frente para o HTTPS. **Sem TLS o resto é teatro**: o
cookie de sessão e os valores trafegariam em texto puro.

---

## Variáveis

| Variável | Para quê |
|---|---|
| `DATA_DIR` | onde fica o banco — **tem que ser o volume** |
| `NODE_ENV=production` | exige as chaves do gateway, liga HSTS |
| `PSP_API_KEY` | chave do gateway de pagamento |
| `PSP_WEBHOOK_SECRET` | confere a assinatura do webhook |
| `ADMIN_TOKEN` | protege `GET /api/_audit` |
| `ALLOWED_ORIGINS` | domínios extras aceitos em POST (anti-CSRF e CORS) |
| `TRUST_PROXY=1` | atrás de proxy/CDN, para o limite de taxa ver o IP real |
| `MATCH_IDLE_MS` | inatividade até encerrar partida abandonada (padrão 15 min) |

---

## Depois de subir

- [ ] `GET /api/health` responde
- [ ] O site abre e oferece **instalar o app**
- [ ] Webhook do gateway apontado para `https://seudominio/api/webhooks/psp`
- [ ] Um depósito de teste cai certo
- [ ] `GET /api/_audit` retorna `ok: true`
- [ ] Backup agendado **e uma restauração testada**
- [ ] Lista do `SECURITY.md` revisada antes do primeiro real de verdade
