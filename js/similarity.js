// Agrupamento de produtos por similaridade.
// Ex.: "Creme de Leite Nestlé 200g" e "Creme de Leite Itambé" -> grupo "Creme de Leite".

const STOPWORDS = new Set([
  'de', 'da', 'do', 'das', 'dos', 'e', 'com', 'sem', 'em', 'para', 'p', 'c', 'o', 'a', 'os', 'as',
  'tipo', 'sabor', 'lata', 'caixa', 'cx', 'pacote', 'pct', 'pc', 'garrafa', 'gf', 'pet', 'sache', 'sachet',
  'tp', 'tetra', 'pak', 'pack', 'refil', 'refill', 'un', 'und', 'unid', 'unidade', 'unidades', 'embalagem',
  'economica', 'promocional', 'gratis', 'leve', 'pague', 'novo', 'nova', 'original', 'tradicional',
]);

// Variações que não mudam "o que é" o produto: Leite Integral e Leite Desnatado continuam sendo Leite.
const MODIFIERS = new Set([
  'light', 'diet', 'zero', 'integral', 'desnatado', 'desnatada', 'semidesnatado', 'semidesnatada', 'uht',
  'lactose', 'fit', 'organico', 'organica', 'premium', 'extra', 'especial', 'refinado', 'refinada', 'tipo1',
  'gourmet', 'classico', 'classica', 'natural', 'fresco', 'fresca', 'pasteurizado', 'longa', 'vida',
]);

// Remove acentos, deixa minúsculo e troca pontuação por espaço.
export function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const SIZE_RE = /\b\d+([.,]\d+)?\s*(x\s*\d+\s*)?(kg|g|gr|grs|mg|ml|l|lt|lts|litro|litros|cl|un|und|unid|m|cm|mm|rolos?|folhas?|cps|caps|capsulas?|saches?)?\b/g;

// Converte um nome em lista de palavras relevantes, sem marcas, tamanhos e palavras vazias.
export function tokens(text, brands = []) {
  const brandTokens = new Set();
  for (const b of brands) for (const t of normalize(b).split(' ')) if (t.length > 1) brandTokens.add(t);
  return normalize(text)
    .replace(SIZE_RE, ' ')
    .split(' ')
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !MODIFIERS.has(t) && !brandTokens.has(t) && !/^\d+$/.test(t));
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

// Palavras "iguais" tolerando plural e pequenos erros de digitação.
function tokenMatch(a, b) {
  if (a === b) return true;
  const sa = a.replace(/(es|s)$/, '');
  const sb = b.replace(/(es|s)$/, '');
  if (sa === sb) return true;
  const len = Math.max(a.length, b.length);
  if (len < 5) return false;
  return levenshtein(a, b) <= (len >= 8 ? 2 : 1);
}

function coverage(needles, haystack) {
  if (!needles.length) return 0;
  let hit = 0;
  for (const n of needles) if (haystack.some((h) => tokenMatch(n, h))) hit++;
  return hit / needles.length;
}

// Similaridade entre 0 e 1. Prioriza o quanto do nome do grupo aparece no nome do produto,
// já que o produto costuma ter palavras extras (ex.: "UHT", "light").
export function similarity(productTokens, groupTokens) {
  if (!productTokens.length || !groupTokens.length) return 0;
  const groupInProduct = coverage(groupTokens, productTokens);
  const productInGroup = coverage(productTokens, groupTokens);
  // Ordem das palavras importa um pouco: "leite condensado" x "creme de leite".
  const firstBonus = tokenMatch(productTokens[0], groupTokens[0]) ? 0.1 : 0;
  return Math.min(1, 0.5 * groupInProduct + 0.4 * productInGroup + firstBonus);
}

export const MATCH_THRESHOLD = 0.82;

// Sugere o grupo mais parecido. `groups`: [{id, name}], `products`: [{name, brand, groupId}].
export function suggestGroup({ name, brand }, groups, products = []) {
  const brands = [brand, ...products.map((p) => p.brand)].filter(Boolean);
  const pTokens = tokens(name, brands);
  let best = null;
  for (const g of groups) {
    let score = similarity(pTokens, tokens(g.name, brands));
    for (const p of products) {
      if (p.groupId !== g.id) continue;
      score = Math.max(score, similarity(pTokens, tokens(p.name, brands)) - 0.05);
    }
    if (!best || score > best.score) best = { group: g, score };
  }
  if (best && best.score >= MATCH_THRESHOLD) return { group: best.group, score: best.score, newName: null };
  return { group: null, score: best ? best.score : 0, newName: genericName(name, brands) };
}

// Nome genérico para um grupo novo: "CREME DE LEITE NESTLE 200G" -> "Creme de Leite".
export function genericName(name, brands = []) {
  const brandTokens = new Set(brands.flatMap((b) => normalize(b).split(' ')).filter((t) => t.length > 1));
  const sizeFree = String(name || '')
    .replace(/\b\d+([.,]\d+)?\s*(x\s*\d+\s*)?(kg|g|gr|grs|mg|ml|l|lt|lts|litros?|cl|un|und|unid)\b\.?/gi, ' ')
    .split(/\s+/)
    .filter((w) => {
      const n = normalize(w);
      return n && !brandTokens.has(n) && !MODIFIERS.has(n) && !/^\d+$/.test(n);
    });
  const lowerWords = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'com', 'sem', 'em', 'para']);
  const words = sizeFree.map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '')).filter(Boolean);
  while (words.length && lowerWords.has(words[words.length - 1])) words.pop();
  return words
    .map((w, i) => (i > 0 && lowerWords.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

const CATEGORY_KEYWORDS = {
  'Laticínios': ['leite', 'creme', 'queijo', 'iogurte', 'manteiga', 'requeijao', 'margarina', 'nata', 'coalhada'],
  'Mercearia': ['arroz', 'feijao', 'macarrao', 'massa', 'farinha', 'acucar', 'sal', 'oleo', 'azeite', 'cafe', 'molho', 'extrato', 'milho', 'ervilha', 'atum', 'sardinha', 'biscoito', 'bolacha', 'aveia', 'achocolatado', 'tempero', 'vinagre', 'fuba', 'granola', 'gelatina', 'chocolate', 'condensado'],
  'Bebidas': ['refrigerante', 'suco', 'agua', 'cerveja', 'vinho', 'cha', 'energetico', 'isotonico'],
  'Limpeza': ['detergente', 'sabao', 'amaciante', 'desinfetante', 'agua sanitaria', 'alvejante', 'esponja', 'limpador', 'multiuso', 'saco lixo', 'lustra', 'cloro'],
  'Higiene': ['papel higienico', 'sabonete', 'shampoo', 'condicionador', 'creme dental', 'pasta dente', 'desodorante', 'escova', 'absorvente', 'fralda', 'algodao', 'cotonete', 'fio dental'],
  'Carnes e Frios': ['carne', 'frango', 'peixe', 'presunto', 'mortadela', 'salsicha', 'linguica', 'bacon', 'peito peru', 'salame'],
  'Hortifruti': ['banana', 'maca', 'tomate', 'cebola', 'alho', 'batata', 'cenoura', 'alface', 'limao', 'laranja', 'ovo', 'ovos'],
  'Padaria': ['pao', 'bolo', 'torrada'],
  'Congelados': ['congelado', 'sorvete', 'lasanha', 'pizza', 'nuggets', 'hamburguer'],
};

export const CATEGORIES = [...Object.keys(CATEGORY_KEYWORDS), 'Outros'];

// Palpite de seção do mercado a partir do nome do grupo.
export function guessCategory(name) {
  const n = ` ${normalize(name)} `;
  let best = 'Outros';
  let bestLen = 0;
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const w of words) {
      if (n.includes(` ${w} `) && w.length > bestLen) {
        best = cat;
        bestLen = w.length;
      }
    }
  }
  return best;
}
