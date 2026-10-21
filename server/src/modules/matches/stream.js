/**
 * Barramento de eventos das partidas, em memória.
 *
 * AVISO OPERACIONAL: isto vive na memória do processo. Com mais de uma
 * instância, um jogador conectado à instância A não recebe o evento publicado
 * pela instância B — a partida parece travar até o cliente recarregar.
 *
 * Ao escalar horizontalmente, troque por Redis pub/sub (ou LISTEN/NOTIFY do
 * próprio PostgreSQL, que já está aí). A interface é de duas funções
 * justamente para que essa troca seja local.
 *
 * Importante: o estado da partida NUNCA vive aqui. A verdade está no banco;
 * isto é só um aviso de "vá buscar" / "aqui está o novo estado".
 */

const rooms = new Map(); // matchId -> Set<send>

export function subscribe(matchId, send) {
  let room = rooms.get(matchId);
  if (!room) { room = new Set(); rooms.set(matchId, room); }
  room.add(send);

  return () => {
    room.delete(send);
    if (room.size === 0) rooms.delete(matchId);
  };
}

export function publish(matchId, event, data) {
  const room = rooms.get(matchId);
  if (!room) return 0;
  let delivered = 0;
  for (const send of room) {
    try { send(event, data); delivered += 1; }
    catch {
      // Conexão morta: tira da sala para não acumular.
      room.delete(send);
    }
  }
  return delivered;
}

export function roomSize(matchId) {
  return rooms.get(matchId)?.size ?? 0;
}

export function totalConnections() {
  let n = 0;
  for (const room of rooms.values()) n += room.size;
  return n;
}
