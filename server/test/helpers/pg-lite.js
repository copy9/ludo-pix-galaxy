/**
 * Cliente mínimo do protocolo do PostgreSQL — APENAS PARA TESTES.
 *
 * ================================================================
 *  ESTE ARQUIVO NÃO É USADO EM PRODUÇÃO E NÃO DEVE SER.
 *  Em produção o servidor usa o driver `pg`, que é maduro e auditado.
 *  Escrever o próprio driver de banco debaixo de um sistema de pagamento
 *  seria a decisão errada.
 * ================================================================
 *
 * Ele existe porque o ambiente onde este código foi escrito não tinha acesso
 * ao registry do npm, e rodar os testes de dinheiro contra um PostgreSQL de
 * verdade vale mais do que rodá-los contra um banco falso em memória.
 *
 * Implementa o necessário e nada além: autenticação `trust`, consulta
 * estendida com parâmetros (sem concatenação de SQL) e conversão dos tipos
 * que este projeto usa. Expõe a mesma interface do `pg` que o código chama:
 * `query(text, params)`, `connect()`, `release()`, `end()`.
 */

import net from 'node:net';

/* ---------------- OIDs dos tipos que usamos ---------------- */
const OID = {
  BOOL: 16, INT8: 20, INT2: 21, INT4: 23, TEXT: 25, JSON: 114, JSONB: 3802,
  FLOAT4: 700, FLOAT8: 701, VARCHAR: 1043, DATE: 1082, TIMESTAMP: 1114,
  TIMESTAMPTZ: 1184, UUID: 2950, NUMERIC: 1700,
};

function decodeValue(raw, oid) {
  if (raw === null) return null;
  const text = raw.toString('utf8');
  switch (oid) {
    case OID.BOOL: return text === 't';
    case OID.INT2:
    case OID.INT4: return Number(text);
    case OID.INT8: {
      const n = Number(text);
      if (!Number.isSafeInteger(n)) throw new Error(`BIGINT fora da faixa segura: ${text}`);
      return n;
    }
    case OID.FLOAT4:
    case OID.FLOAT8: return Number(text);
    case OID.JSON:
    case OID.JSONB: return JSON.parse(text);
    case OID.DATE:
    case OID.TIMESTAMP:
    case OID.TIMESTAMPTZ: return new Date(text);
    default: return text;
  }
}

/** Serializa um parâmetro JS para o formato texto do Postgres. */
function encodeParam(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Buffer.from(value.toISOString(), 'utf8');
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) {
    // Literal de array: {"a","b"}. Aspas e barras precisam de escape.
    const items = value.map((item) => {
      if (item === null) return 'NULL';
      const s = String(item).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `"${s}"`;
    });
    return Buffer.from(`{${items.join(',')}}`, 'utf8');
  }
  if (typeof value === 'object') return Buffer.from(JSON.stringify(value), 'utf8');
  if (typeof value === 'boolean') return Buffer.from(value ? 't' : 'f', 'utf8');
  return Buffer.from(String(value), 'utf8');
}

/* ---------------- montagem de mensagens ---------------- */

function cstring(s) {
  return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
}

function message(type, payload) {
  const len = Buffer.alloc(4);
  len.writeInt32BE(payload.length + 4);
  return type
    ? Buffer.concat([Buffer.from(type, 'ascii'), len, payload])
    : Buffer.concat([len, payload]);
}

export class PgLiteClient {
  constructor({ host = '127.0.0.1', port = 5432, user, database }) {
    this.opts = { host, port, user, database };
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = [];       // fila de resolvers aguardando ReadyForQuery
    this.current = null;
    this.ready = false;
  }

  async connect() {
    if (this.socket) return this;
    await new Promise((resolve, reject) => {
      this.socket = net.connect(this.opts.port, this.opts.host);
      this.socket.on('error', (err) => {
        if (!this.ready) reject(err);
        else this.#failAll(err);
      });
      this.socket.on('data', (chunk) => this.#onData(chunk));
      this.socket.on('close', () => this.#failAll(new Error('conexão fechada')));
      this.socket.once('connect', () => {
        const params = Buffer.concat([
          cstring('user'), cstring(this.opts.user),
          cstring('database'), cstring(this.opts.database),
          cstring('client_encoding'), cstring('UTF8'),
          Buffer.from([0]),
        ]);
        const version = Buffer.alloc(4);
        version.writeInt32BE(196608); // protocolo 3.0
        this.socket.write(message(null, Buffer.concat([version, params])));
        this.readyResolve = resolve;
        this.readyReject = reject;
      });
    });
    return this;
  }

  #failAll(err) {
    this.ready = false;
    const waiting = [...this.pending];
    this.pending = [];
    if (this.current) { waiting.unshift(this.current); this.current = null; }
    for (const w of waiting) w.reject?.(err);
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 5) {
      const type = String.fromCharCode(this.buffer[0]);
      const len = this.buffer.readInt32BE(1);
      if (this.buffer.length < len + 1) break;
      const body = this.buffer.subarray(5, len + 1);
      this.buffer = this.buffer.subarray(len + 1);
      this.#handle(type, body);
    }
  }

  #handle(type, body) {
    switch (type) {
      case 'R': { // Authentication
        const code = body.readInt32BE(0);
        if (code !== 0) {
          this.readyReject?.(new Error(
            `pg-lite só suporta autenticação trust (código ${code}). ` +
            `Ajuste pg_hba.conf para trust em 127.0.0.1 neste banco de teste.`,
          ));
        }
        break;
      }
      case 'Z': // ReadyForQuery
        if (!this.ready) { this.ready = true; this.readyResolve?.(this); }
        if (this.current) {
          const { resolve, reject, error, rows, fields } = this.current;
          this.current = null;
          if (error) reject(error); else resolve({ rows, fields, rowCount: rows.length });
          this.#next();
        }
        break;
      case 'T': { // RowDescription
        const count = body.readInt16BE(0);
        let off = 2;
        const fields = [];
        for (let i = 0; i < count; i += 1) {
          const end = body.indexOf(0, off);
          const name = body.subarray(off, end).toString('utf8');
          off = end + 1;
          const dataTypeOid = body.readInt32BE(off + 6);
          off += 18;
          fields.push({ name, dataTypeOid });
        }
        if (this.current) this.current.fields = fields;
        break;
      }
      case 'D': { // DataRow
        if (!this.current) break;
        const count = body.readInt16BE(0);
        let off = 2;
        const row = {};
        for (let i = 0; i < count; i += 1) {
          const size = body.readInt32BE(off);
          off += 4;
          let value = null;
          if (size >= 0) { value = body.subarray(off, off + size); off += size; }
          const field = this.current.fields[i];
          row[field?.name ?? i] = decodeValue(value, field?.dataTypeOid);
        }
        this.current.rows.push(row);
        break;
      }
      case 'E': { // ErrorResponse
        const parts = {};
        let off = 0;
        while (off < body.length && body[off] !== 0) {
          const key = String.fromCharCode(body[off]);
          const end = body.indexOf(0, off + 1);
          parts[key] = body.subarray(off + 1, end).toString('utf8');
          off = end + 1;
        }
        const err = new Error(parts.M ?? 'erro do postgres');
        err.code = parts.C;
        err.constraint = parts.n;
        err.detail = parts.D;
        if (this.current) this.current.error = err;
        else if (!this.ready) this.readyReject?.(err);
        break;
      }
      default:
        break; // ParameterStatus, BackendKeyData, CommandComplete, etc.
    }
  }

  #next() {
    if (this.current || this.pending.length === 0) return;
    const job = this.pending.shift();
    this.current = job;
    this.socket.write(job.payload);
  }

  /**
   * Executa uma consulta com parâmetros ($1, $2...). Nunca concatena SQL.
   *
   * Sem parâmetros, usa o protocolo de consulta SIMPLES, que aceita vários
   * comandos separados por ponto e vírgula — é o que as migrações precisam.
   * Com parâmetros, usa o protocolo ESTENDIDO, que só aceita um comando por
   * vez mas é o que mantém os valores fora do texto do SQL. O driver `pg`
   * real faz exatamente a mesma distinção.
   */
  query(text, params = []) {
    if (!params || params.length === 0) return this.#simpleQuery(text);
    return new Promise((resolve, reject) => {
      const encoded = params.map(encodeParam);

      const parse = message('P', Buffer.concat([
        cstring(''), cstring(text),
        (() => { const b = Buffer.alloc(2); b.writeInt16BE(0); return b; })(),
      ]));

      const paramBufs = [];
      const n = Buffer.alloc(2); n.writeInt16BE(0); paramBufs.push(n);      // formatos
      const cnt = Buffer.alloc(2); cnt.writeInt16BE(encoded.length); paramBufs.push(cnt);
      for (const p of encoded) {
        if (p === null) { const l = Buffer.alloc(4); l.writeInt32BE(-1); paramBufs.push(l); }
        else { const l = Buffer.alloc(4); l.writeInt32BE(p.length); paramBufs.push(l, p); }
      }
      const resFmt = Buffer.alloc(2); resFmt.writeInt16BE(0); paramBufs.push(resFmt);

      const bind = message('B', Buffer.concat([cstring(''), cstring(''), ...paramBufs]));
      const describe = message('D', Buffer.concat([Buffer.from('P', 'ascii'), cstring('')]));
      const execute = message('E', Buffer.concat([
        cstring(''), (() => { const b = Buffer.alloc(4); b.writeInt32BE(0); return b; })(),
      ]));
      const sync = message('S', Buffer.alloc(0));

      this.pending.push({
        payload: Buffer.concat([parse, bind, describe, execute, sync]),
        resolve, reject, rows: [], fields: [], error: null,
      });
      this.#next();
    });
  }

  /** Protocolo simples: um único 'Q', aceita múltiplos comandos. */
  #simpleQuery(text) {
    return new Promise((resolve, reject) => {
      this.pending.push({
        payload: message('Q', cstring(text)),
        resolve, reject, rows: [], fields: [], error: null,
      });
      this.#next();
    });
  }

  release() { /* pool de uma conexão só: nada a devolver */ }

  async end() {
    if (!this.socket) return;
    this.socket.end();
    this.socket = null;
    this.ready = false;
  }
}

/**
 * Pool compatível com o uso que o código faz do `pg`.
 * Uma conexão por pool mantém a semântica de transação dos testes simples.
 */
export class PgLitePool {
  constructor(opts) { this.opts = opts; this.clients = []; }

  async connect() {
    const c = new PgLiteClient(this.opts);
    await c.connect();
    this.clients.push(c);
    const release = () => { c.end().catch(() => {}); };
    return Object.assign(c, { release });
  }

  async query(text, params) {
    if (!this.shared) { this.shared = new PgLiteClient(this.opts); await this.shared.connect(); }
    return this.shared.query(text, params);
  }

  async end() {
    await Promise.all(this.clients.map((c) => c.end().catch(() => {})));
    await this.shared?.end().catch(() => {});
  }
}
