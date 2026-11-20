# Imagem do servidor. Serve a API e o site (o mesmo que vira PWA).
#
# Deliberadamente simples: o projeto nao tem dependencia de terceiros, entao
# nao ha etapa de build, nao ha node_modules e nao ha nada para compilar.

FROM node:22-alpine

# Rodar como usuario comum, nao root: se alguem escapar do processo, nao sai
# dono da maquina.
RUN addgroup -S lpg && adduser -S lpg -G lpg

WORKDIR /app

# O codigo do servidor e os arquivos do site.
COPY server/ ./server/
COPY assets/ ./assets/
COPY index.html jogo.html desafio.html perfil.html offline.html ./
COPY manifest.webmanifest sw.js favicon.ico ./

# O banco vive FORA da imagem, num volume montado aqui.
# Sem volume, cada deploy recria o container e leva junto o banco — e com ele
# o saldo de todos os jogadores. Ver DEPLOY.md.
RUN mkdir -p /dados && chown -R lpg:lpg /dados /app
ENV DATA_DIR=/dados
VOLUME ["/dados"]

USER lpg

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Health check: o HEAD e respondido pelo servidor (ver index.js).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
