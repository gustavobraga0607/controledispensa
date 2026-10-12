// Regras de negócio puras (sem DOM nem IndexedDB) para facilitar os testes.

export function groupStock(groupId, products) {
  return products.filter((p) => p.groupId === groupId).reduce((sum, p) => sum + (Number(p.qty) || 0), 0);
}

// Situação do grupo em relação ao estoque mínimo/máximo.
export function stockStatus(stock, group) {
  const min = Number(group.min) || 0;
  const max = Number(group.max) || 0;
  if (!max && !min) return 'sem-meta';
  if (stock <= min) return 'comprar';
  if (max && stock < max) return 'ok';
  return 'cheio';
}

// Sugestão de compras: obrigatórios (estoque <= mínimo, comprar até o máximo)
// e opcionais (acima do mínimo, mas abaixo do máximo).
export function shoppingList(groups, products) {
  const required = [];
  const optional = [];
  for (const g of groups) {
    const min = Number(g.min) || 0;
    const max = Math.max(Number(g.max) || 0, min);
    if (!max) continue;
    const stock = groupStock(g.id, products);
    const items = products.filter((p) => p.groupId === g.id);
    const preferred = [...items].sort((a, b) => (b.lastInAt || 0) - (a.lastInAt || 0))[0] || null;
    const entry = { group: g, stock, min, max, preferred, products: items };
    if (stock <= min) required.push({ ...entry, buy: Math.max(1, max - stock) });
    else if (stock < max) optional.push({ ...entry, buy: max - stock });
  }
  const byCat = (a, b) =>
    (a.group.category || 'Outros').localeCompare(b.group.category || 'Outros') || a.group.name.localeCompare(b.group.name);
  return { required: required.sort(byCat), optional: optional.sort(byCat) };
}

export function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function lastMonths(count, now = Date.now()) {
  const d = new Date(now);
  const keys = [];
  for (let i = count - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    keys.push(monthKey(m.getTime()));
  }
  return keys;
}

const MONTH_NAMES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export function monthLabel(key) {
  const [y, m] = key.split('-');
  return `${MONTH_NAMES[Number(m) - 1]}/${y.slice(2)}`;
}

// Variação percentual entre dois meses (null quando não há base de comparação).
export function variation(current, previous) {
  if (!previous) return current ? null : 0;
  return Math.round(((current - previous) / previous) * 100);
}

// Relatório de consumo (saídas) por grupo e por produto, mês a mês.
export function consumptionReport(movements, products, groups, { months = 6, now = Date.now(), type = 'out' } = {}) {
  const keys = lastMonths(months, now);
  const index = new Map(keys.map((k, i) => [k, i]));
  const productById = new Map(products.map((p) => [p.id, p]));
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const rows = new Map();
  const totals = keys.map(() => 0);

  for (const mv of movements) {
    if (mv.type !== type) continue;
    const i = index.get(monthKey(mv.at));
    if (i === undefined) continue;
    const product = productById.get(mv.productId);
    const groupId = product ? product.groupId : mv.groupId;
    const group = groupById.get(groupId) || { id: groupId || '?', name: mv.groupName || 'Sem grupo' };
    if (!rows.has(group.id)) rows.set(group.id, { group, perMonth: keys.map(() => 0), products: new Map() });
    const row = rows.get(group.id);
    const qty = Number(mv.qty) || 0;
    row.perMonth[i] += qty;
    totals[i] += qty;
    const pid = mv.productId;
    if (!row.products.has(pid)) {
      row.products.set(pid, { name: product ? product.name : mv.productName || 'Produto removido', brand: product?.brand || '', perMonth: keys.map(() => 0) });
    }
    row.products.get(pid).perMonth[i] += qty;
  }

  const last = keys.length - 1;
  const result = [...rows.values()].map((r) => {
    const total = r.perMonth.reduce((a, b) => a + b, 0);
    // Média dos meses fechados (sem o mês corrente, que ainda está em andamento).
    const closed = r.perMonth.slice(0, last);
    const avg = closed.length ? closed.reduce((a, b) => a + b, 0) / closed.length : total;
    return {
      group: r.group,
      perMonth: r.perMonth,
      total,
      avg: Math.round(avg * 10) / 10,
      current: r.perMonth[last],
      previous: r.perMonth[last - 1] || 0,
      variation: variation(r.perMonth[last - 1] || 0, r.perMonth[last - 2] || 0),
      products: [...r.products.values()].sort((a, b) => sum(b.perMonth) - sum(a.perMonth)),
    };
  });
  result.sort((a, b) => b.total - a.total || a.group.name.localeCompare(b.group.name));
  return { months: keys, rows: result, totals };
}

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}
