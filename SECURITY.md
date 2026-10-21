# Segurança — Ludo Pix Galaxy

Este documento existe porque o projeto movimenta dinheiro. Ele registra **o que
foi corrigido**, **por que cada decisão foi tomada** e, principalmente, **o que
ainda falta antes de aceitar um real de verdade**.

Leia a seção "Antes de ir ao ar" inteira. Ela não é formalidade.

---

## O problema original

Na versão anterior, saldo, resultado da partida e pagamento do prêmio eram
decididos **dentro do navegador do jogador**. Isso não era um bug pontual; era a
arquitetura. Qualquer pessoa com o console aberto podia:

```js
addBalance(100000)        // escrever o próprio saldo
reportWinner(code, meuId) // declarar-se vencedor e receber o prêmio
```

Nenhuma correção de front resolveria isso. A regra geral: **o navegador é do
usuário, não seu.** Tudo que chega dele é um pedido, nunca um fato.

---

## O que mudou

| Área | Antes | Agora |
|---|---|---|
| Saldo | campo no banco do cliente, sobrescrito pelo navegador | livro-razão append-only no servidor, partidas dobradas |
| Valores | `float` (`amount*2*0.8`) | centavos inteiros, sempre |
| Dado | `Math.random()` no navegador, com modo de teste viciado ligado | HMAC no servidor, com semente comprometida e auditável |
| Vencedor | jogador clicava "Eu venci" | servidor apura ao fim da partida |
| Jogada | cliente aplicava e empurrava o estado | servidor valida cada jogada |
| Senha | SHA-256 simples, salt de `Math.random()`, verificada no navegador | scrypt no servidor, salt do CSPRNG, comparação em tempo constante |
| Sessão | e-mail no `localStorage` | cookie `httpOnly` + `SameSite`, token guardado em hash |
| Maioridade | `if` no JavaScript | validado no servidor, com CPF conferido |
| Depósito | botão "+R$50" no cliente | webhook assinado do gateway, idempotente |

---

## Decisões de projeto e o porquê

### Centavos inteiros, nunca float
`0.1 + 0.2 === 0.30000000000000004`. O código antigo calculava prêmio com
`d.amount*2*0.8`; com aposta de R$ 0,10 isso dá `0.16000000000000003`. Em
dinheiro, todo valor é inteiro em centavos, e a conversão para reais acontece só
na hora de exibir (`LP.fmt`).

A divisão do pote arredonda a comissão **para baixo** e o resto vai para a casa
(`splitPot`). Assim a soma fecha exata e não sobra centavo órfão no escrow.

### Livro-razão de partidas dobradas
Não existe campo "saldo" que alguém sobrescreve. Existe um razão append-only
onde toda movimentação tem pernas que **somam zero**:

```
apostar:    user:A −5000   escrow:ABC123 +5000
pagar:      escrow:ABC123 −10000   user:A +8000   house:rake +2000
```

Consequências práticas:
- Dinheiro nunca aparece nem some — ele muda de conta.
- `GET /api/_audit` confere a integridade: se a soma global não for zero, há bug.
- Erro se corrige com lançamento de estorno, nunca apagando histórico. Triggers
  no banco impedem `UPDATE` e `DELETE` no razão.
- Quando um jogador reclamar que sumiu dinheiro, você tem o extrato real.

### Idempotência em tudo que move dinheiro
Gateways reenviam webhook quando não recebem `200` rápido. Usuário clica duas
vezes. A rede repete o POST. Toda transação carrega uma chave de idempotência
(`deposit:<id>`, `payout:<code>`, `stake:<code>:<user>`): repetir a chave
devolve a transação original em vez de criar outra.

### Dado *provably fair*
Tirar o dado do navegador resolve a trapaça do jogador, mas cria o problema
inverso: agora ele precisa confiar em **você**.

A solução é o compromisso criptográfico. O servidor sorteia uma semente secreta
por partida e publica o **hash** dela antes da primeira rolagem. Cada dado é
`HMAC-SHA256(semente, "<código>:<nonce>")`. No fim, a semente é revelada: o
jogador recalcula todas as rolagens e confere contra o hash publicado antes.
Como o hash foi divulgado primeiro, a semente não pôde ser trocada no meio.

Há `LP.verifyFairness()` no cliente e teste automatizado que refaz essa conta.

> Detalhe que parece pedantismo e não é: a conversão do HMAC para 1–6 usa
> **rejeição de amostra**. `byte % 6` enviesa, porque 256 não é múltiplo de 6 —
> os valores 1 a 4 sairiam ~0,4% mais que 5 e 6. Num cassino isso é a margem da
> casa inteira. Há teste estatístico cobrindo a uniformidade.

### Trava otimista nas jogadas
Cada partida tem uma `version`. Rolar ou mover exige a versão atual. Um duplo
clique ou um retry de rede chega com a versão velha e recebe `STALE` em vez de
virar duas rolagens.

A checagem de versão vem **antes** da checagem de vez, de propósito: um pedido
construído sobre estado velho deve ouvir "recarregue", não "não é sua vez".

### Limite de taxa por e-mail, não só por IP
No Brasil, operadoras móveis usam CGNAT: milhares de pessoas saem pelo mesmo IP.
Um limite apertado de login por IP bloqueia usuário legítimo em massa sem travar
o atacante. Por isso o limite de login é **por e-mail** (que é o que realmente
contém força bruta contra uma conta) e o por IP ficou folgado.

### Carência para aumentar limite de depósito
Reduzir vale na hora; aumentar leva 24h. Um limite que a pessoa levanta no
impulso não protege ninguém — é no impulso que ela ia querer levantar.

### KYC não é auto-concedido
`POST /api/me/kyc` apenas registra o envio. Quem promove a conta ao nível 3 é o
provedor de KYC, depois de conferir documento contra selfie. Se o cliente
pudesse se promover, a trava do saque não existiria — e ela é o que impede
depositar com cartão roubado e sacar antes de o estorno chegar.

### Cartão não toca no seu código
O formulário que coletava número e CVV foi **removido**. Coletar PAN na sua
página joga o projeto em **PCI-DSS SAQ D**, o nível mais exigente (auditoria
anual, varredura trimestral, controles de rede), e transforma qualquer XSS em
roubo de cartão em massa.

O caminho correto é montar os *hosted fields* do gateway: o cartão vai do
navegador **direto** para ele e você recebe só um token. Isso te coloca em
**SAQ A**. O lugar está marcado em `perfil.html` com instrução.

---

## Auditoria independente

Um auditor que não escreveu este código subiu o servidor e tentou explorar cada
hipótese na prática. Achados e o que foi feito:

| # | Gravidade | Achado | Situação |
|---|---|---|---|
| 1 | **Alta** | Dinheiro preso para sempre em partida abandonada | **corrigido** |
| 2 | Alta (dev) | Webhook sem segredo aceitava evento forjado | **corrigido** |
| 3 | Média | Limite de depósito burlável com cobranças pendentes | **corrigido** |
| 4 | Baixa | Enumeração de usuário no cadastro | **aberto** (ver abaixo) |
| 5 | Baixa | Anti-CSRF pulado sem header `Origin` | **corrigido** |
| 6 | Baixa | `?limit=-1` virava "sem limite" no SQLite | **corrigido** |

### #1 — o que estava errado (o mais grave)

Depois que os dois jogadores apostavam, o **único** caminho que esvaziava o
escrow era a partida terminar. Não havia W.O., timeout nem reembolso:
`cancelChallenge` recusava porque a partida já começara, e `expireStale` só
olhava desafios ainda aguardando alguém aceitar. Jogador que fechasse o
navegador deixava as duas apostas travadas **permanentemente** — nenhum dos
dois recebia e a casa não ficava com nada.

Pior que o dinheiro parado era o incentivo: quem estava perdendo ganhava motivo
para sumir. *"Se eu não posso ganhar, ninguém saca."*

Agora existe `forfeitIdle()`, rodando a cada minuto:

- **Ninguém jogou ainda** → devolve a aposta aos dois, sem comissão. Cobrar de
  uma partida que não aconteceu seria indefensável.
- **A partida andou e parou** → quem tinha a vez perde por W.O., o prêmio sai
  normalmente com comissão. Abandonar passa a custar a aposta.

Também há `POST /api/challenges/:code/forfeit` para desistir na hora.
O tempo de inatividade é `MATCH_IDLE_MS` (padrão 15 min).

### #4 — enumeração de usuário: por que segue aberto

O cadastro devolve **409** quando o e-mail já tem conta e **200** quando não
tem. Dá para varrer uma lista e descobrir quem é cliente da plataforma — o que,
num site de apostas, é informação sensível por si só.

Não "corrigi" porque toda correção superficial é teatro: se o cadastro cria
sessão na hora, a resposta **precisa** diferir entre e-mail novo e existente.
Fechar isso de verdade exige **confirmação por e-mail** — o cadastro responde
sempre igual ("enviamos um link, confira sua caixa") e a conta só nasce quando
o link é aberto. É uma funcionalidade, não um ajuste, e ela precisa existir de
qualquer forma antes de aceitar dinheiro.

O login, esse, já está defendido: erro genérico e tempo de resposta igualado
com uma verificação falsa, para não denunciar quais e-mails existem.

### O que o auditor tentou e não conseguiu furar

Saque duplo em paralelo, saldo negativo, dinheiro criado, prêmio pago em dobro,
replay de webhook (três camadas de idempotência), rollback de transação
aninhada, `tokenIdx` malicioso (`-1`, `1.5`, `{}`, `1e308`, …), trava otimista
na rolagem, timing attack no login, travessia de caminho, SQL injection e XSS.

---

## Antes de ir ao ar

### Obrigatório

- [ ] **Preencher o adaptador do gateway** em `server/src/payments.js`
      (`createPixCharge`, `createPayout`, `parseEvent`). Hoje o modo sem
      `PSP_API_KEY` é simulado e não move dinheiro.
- [ ] **Conferir o formato da assinatura do webhook** com a documentação do seu
      gateway. A implementação assume HMAC-SHA256 do corpo cru; alguns usam
      outro esquema. **Assinatura conferida errado é o mesmo que não conferir.**
- [ ] **HTTPS obrigatório.** Sem TLS, o cookie de sessão trafega em claro e todo
      o resto é teatro. Ponha um nginx/Caddy na frente.
- [ ] `NODE_ENV=production`, com `PSP_API_KEY`, `PSP_WEBHOOK_SECRET` e
      `ADMIN_TOKEN` definidos. O servidor recusa subir sem os dois primeiros.
- [ ] **Backup do banco** (`server/data/ludopix.db`) com teste de restauração.
      Backup que nunca foi restaurado não é backup.
- [ ] **KYC de verdade** antes do primeiro saque.
- [ ] **Confirmação de e-mail no cadastro** — fecha o achado #4 e é pré-requisito
      para recuperação de senha.
- [ ] Rodar `GET /api/_audit` periodicamente e **alertar** se `ok:false`.

### Fortemente recomendado

- [ ] **Saque com aprovação manual** acima de um valor. É a última rede contra
      uma falha que você ainda não conhece.
- [ ] **Alertas antifraude**: conta nova sacando logo após depositar; muitas
      partidas entre o mesmo par de jogadores (conluio para transferir saldo);
      padrão de perda consistente numa direção.
- [ ] Migrar para **Postgres** quando houver mais de uma instância. O SQLite
      aguenta bem um processo só; com vários, o `WAL` não resolve escrita
      concorrente entre máquinas.
- [ ] Trocar o limite de taxa em memória por **Redis** ao escalar — hoje cada
      instância conta separado, e o limite efetivo vira N vezes maior.
- [ ] **NOTA-CSP**: o CSP ainda traz `'unsafe-inline'` em `script-src`, porque as
      páginas têm `<script>` embutido. Mover esse JS para arquivos e remover o
      `'unsafe-inline'` é a defesa mais eficaz que resta contra XSS.
- [ ] Rotação de logs e retenção definida para `audit_log`.

### Custo do login (medido)

O scrypt está em N=2¹⁵, que custa **~100 ms e 32 MiB por verificação**. Isso é
proposital — é o que torna caro quebrar hashes em GPU se o banco vazar. Mas tem
consequência operacional:

| Cenário | Medido |
|---|---|
| Cadastro | ~168 ms |
| Login | ~103 ms |
| 20 logins simultâneos | ~506 ms no total |

O Node roda scrypt na *threadpool* do libuv (4 threads por padrão), então as
chamadas enfileiram em vez de alocar 32 MiB cada uma ao mesmo tempo — o pico
fica em ~128 MiB, não 640 MiB. O laço de eventos **não** trava: o `/api/health`
respondeu em 2 ms sob carga.

Ainda assim, uma enxurrada de tentativas de login satura a threadpool e deixa
todo o resto lento. O limite por e-mail ajuda, mas se você escalar:

- aumente `UV_THREADPOOL_SIZE` junto com os núcleos disponíveis;
- considere um limite global de verificações simultâneas (semáforo);
- não baixe o N do scrypt para "resolver" lentidão — isso troca segurança real
  por latência percebida. Prefira mais máquinas.

### Sobre conluio

Nenhum código impede dois amigos combinarem quem perde para mover saldo entre
contas. Isso é lavagem em miniatura e só se detecta por análise de padrão. Se a
plataforma crescer, isso vira problema antes do que parece.

---

## Jurisdição

A operação ser sediada em Curaçao é decisão de negócio e não muda nada do que
está acima. Vale registrar apenas que **a lei que importa costuma ser a do país
onde o jogador está**, não a da sede, e que processar Pix e CPF de brasileiros
atrai obrigações brasileiras (LGPD, entre outras) mesmo com a empresa fora.
Isto não é parecer jurídico — converse com um advogado da área antes de aceitar
dinheiro real.

---

## Reportar uma falha

Achou um problema de segurança? Não abra issue pública. Mande um e-mail para o
responsável do projeto com os passos para reproduzir.
