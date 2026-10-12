// GET /api/sync?since=<ms> → documentos da casa alterados desde `since` (inclui excluídos).
import { handler, getPool, houseFromRequest } from './_lib.js';

// Reenvia um pouco antes do cursor para não perder gravações que terminaram fora de ordem.
const OVERLAP_MS = 10_000;

export default handler(async ({ req, query }) => {
  const house = await houseFromRequest(req);
  const since = Math.max(0, Number(query.since) || 0);
  const now = Date.now();
  const { rows } = await getPool().query(
    `select col, id, data, deleted, updated_at from docs
      where house_id = $1 and updated_at > $2
      order by updated_at`,
    [house.id, since ? since - OVERLAP_MS : -1],
  );
  return {
    house,
    now,
    docs: rows.map((r) => ({ col: r.col, id: r.id, data: r.deleted ? null : r.data, deleted: r.deleted, updatedAt: Number(r.updated_at) })),
  };
});
