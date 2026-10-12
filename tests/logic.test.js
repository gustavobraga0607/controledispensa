import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shoppingList, stockStatus, consumptionReport, lastMonths, variation } from '../js/logic.js';

const groups = [
  { id: 'creme', name: 'Creme de Leite', category: 'Laticínios', min: 2, max: 6 },
  { id: 'arroz', name: 'Arroz', category: 'Mercearia', min: 1, max: 2 },
  { id: 'cafe', name: 'Café', category: 'Mercearia', min: 1, max: 4 },
  { id: 'sal', name: 'Sal', category: 'Mercearia', min: 0, max: 0 },
];
const products = [
  { id: 'p1', name: 'Creme Nestlé', brand: 'Nestlé', groupId: 'creme', qty: 1, lastInAt: 1 },
  { id: 'p2', name: 'Creme Itambé', brand: 'Itambé', groupId: 'creme', qty: 1, lastInAt: 5 },
  { id: 'p3', name: 'Arroz', groupId: 'arroz', qty: 2 },
  { id: 'p4', name: 'Café', groupId: 'cafe', qty: 2 },
  { id: 'p5', name: 'Sal', groupId: 'sal', qty: 0 },
];

test('estoque soma todas as marcas do grupo e sugere até o máximo', () => {
  const { required, optional } = shoppingList(groups, products);
  assert.deepEqual(required.map((r) => [r.group.id, r.stock, r.buy]), [['creme', 2, 4]]);
  assert.equal(required[0].preferred.id, 'p2', 'marca comprada por último');
  assert.deepEqual(optional.map((r) => [r.group.id, r.buy]), [['cafe', 2]]);
});

test('status do estoque', () => {
  assert.equal(stockStatus(0, { min: 1, max: 3 }), 'comprar');
  assert.equal(stockStatus(2, { min: 1, max: 3 }), 'ok');
  assert.equal(stockStatus(3, { min: 1, max: 3 }), 'cheio');
  assert.equal(stockStatus(3, { min: 0, max: 0 }), 'sem-meta');
});

test('relatório mensal de consumo com comparativo', () => {
  const now = new Date(2026, 9, 12).getTime(); // out/2026
  const at = (m, d = 10) => new Date(2026, m, d).getTime();
  const movements = [
    { type: 'out', productId: 'p1', qty: 1, at: at(7) },
    { type: 'out', productId: 'p1', qty: 1, at: at(8) },
    { type: 'out', productId: 'p2', qty: 2, at: at(8) },
    { type: 'out', productId: 'p2', qty: 1, at: at(9) },
    { type: 'in', productId: 'p2', qty: 5, at: at(9) },
    { type: 'out', productId: 'p3', qty: 1, at: at(8) },
    { type: 'out', productId: 'velho', productName: 'Removido', groupId: 'cafe', qty: 1, at: at(9) },
    { type: 'out', productId: 'p3', qty: 9, at: at(1) }, // fora da janela
  ];
  const rep = consumptionReport(movements, products, groups, { months: 3, now });
  assert.deepEqual(rep.months, ['2026-08', '2026-09', '2026-10']);
  assert.deepEqual(rep.totals, [1, 4, 2]);
  const creme = rep.rows.find((r) => r.group.id === 'creme');
  assert.deepEqual(creme.perMonth, [1, 3, 1]);
  assert.equal(creme.avg, 2); // média dos meses fechados (ago e set)
  assert.equal(creme.variation, 200); // set vs ago
  assert.equal(creme.products.length, 2);
  assert.equal(rep.rows[0].group.id, 'creme', 'ordenado pelo mais consumido');
  assert.ok(rep.rows.find((r) => r.group.id === 'cafe'), 'produto excluído continua no relatório');
});

test('meses e variação', () => {
  assert.deepEqual(lastMonths(3, new Date(2026, 0, 15).getTime()), ['2025-11', '2025-12', '2026-01']);
  assert.equal(variation(5, 0), null);
  assert.equal(variation(0, 0), 0);
  assert.equal(variation(3, 4), -25);
});
