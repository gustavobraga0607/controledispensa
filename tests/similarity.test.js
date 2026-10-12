import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokens, suggestGroup, genericName, guessCategory } from '../js/similarity.js';

const groups = [
  { id: 'g1', name: 'Creme de Leite' },
  { id: 'g2', name: 'Leite Condensado' },
  { id: 'g3', name: 'Leite' },
  { id: 'g4', name: 'Papel Higiênico' },
];

test('remove marca, tamanho e palavras vazias', () => {
  assert.deepEqual(tokens('CREME DE LEITE NESTLÉ 200g', ['Nestlé']), ['creme', 'leite']);
  assert.deepEqual(tokens('Creme de Leite Itambé TP 1,01kg', ['Itambé']), ['creme', 'leite']);
});

test('Creme de Leite Nestlé e Itambé caem no mesmo grupo', () => {
  assert.equal(suggestGroup({ name: 'Creme de Leite Nestlé 200g', brand: 'Nestlé' }, groups).group?.id, 'g1');
  assert.equal(suggestGroup({ name: 'Creme de Leite Itambé', brand: 'Itambé' }, groups).group?.id, 'g1');
  assert.equal(suggestGroup({ name: 'Creme de Leite UHT Light Piracanjuba', brand: '' }, groups).group?.id, 'g1');
});

test('não confunde produtos parecidos mas diferentes', () => {
  assert.equal(suggestGroup({ name: 'Leite Condensado Moça 395g', brand: 'Nestlé' }, groups).group?.id, 'g2');
  assert.equal(suggestGroup({ name: 'Leite Integral Italac 1L', brand: 'Italac' }, groups).group?.id, 'g3');
  assert.equal(suggestGroup({ name: 'Papel Higienico Neve 12 rolos', brand: 'Neve' }, groups).group?.id, 'g4');
  assert.equal(suggestGroup({ name: 'Arroz Tio João 5kg', brand: 'Tio João' }, groups).group, null);
});

test('usa produtos já cadastrados no grupo para comparar', () => {
  const gs = [{ id: 'x', name: 'Molho' }];
  const products = [{ name: 'Molho de Tomate Pomarola', brand: 'Pomarola', groupId: 'x' }];
  assert.equal(suggestGroup({ name: 'Molho de Tomate Heinz 340g', brand: 'Heinz' }, gs, products).group?.id, 'x');
});

test('sugere nome genérico para grupo novo', () => {
  const s = suggestGroup({ name: 'Arroz Branco Tio João 5kg', brand: 'Tio João' }, groups);
  assert.equal(s.newName, 'Arroz Branco');
  assert.equal(genericName('CREME DE LEITE NESTLÉ 200G', ['Nestlé']), 'Creme de Leite');
  assert.equal(genericName('Leite sem lactose Piracanjuba 1L', ['Piracanjuba']), 'Leite');
});

test('palpite de seção do mercado', () => {
  assert.equal(guessCategory('Creme de Leite'), 'Laticínios');
  assert.equal(guessCategory('Papel Higiênico'), 'Higiene');
  assert.equal(guessCategory('Detergente'), 'Limpeza');
  assert.equal(guessCategory('Leite Condensado'), 'Mercearia');
});
