# Dispensa — controle de compras e estoque da casa

App web (PWA) para controlar o estoque da dispensa e montar a lista de compras do mercado.
Funciona no celular, pode ser instalado na tela inicial e funciona offline. Os dados ficam salvos no próprio aparelho (IndexedDB).

## Funcionalidades

1. **Cadastro de produtos com foto e código de barras**
   - Foto tirada pela câmera ou escolhida da galeria (reduzida automaticamente para não ocupar espaço).
   - Código de barras lido pela câmera, digitado ou por leitor USB/Bluetooth.
   - Opcional: preenche nome, marca, tamanho e foto pela base pública [Open Food Facts](https://world.openfoodfacts.org).
2. **Agrupamento por similaridade**
   - Produtos equivalentes de marcas diferentes ficam no mesmo **grupo**: *Creme de Leite Nestlé* e *Creme de Leite Itambé* → grupo **Creme de Leite**.
   - Ao cadastrar, o app ignora marca, tamanho (200g, 1L…), embalagem e variações (light, UHT, integral…) e sugere o grupo mais parecido, ou cria um novo com nome genérico. Dá para trocar o grupo e juntar grupos depois.
   - O estoque é contado pelo grupo (soma de todas as marcas).
3. **Saída do estoque bipando**
   - Na tela *Bipar → Retirar*, cada leitura tira 1 unidade. Tem botão de desfazer.
   - Em *Bipar → Guardar* (quando chega do mercado), escolha a quantidade antes de bipar (ex.: 12) e bipe o produto uma vez só; depois a quantidade volta para 1. Código desconhecido abre o cadastro já com a quantidade escolhida.
4. **Lista de compras automática**
   - Cada grupo tem estoque **mínimo** e **máximo**. Quando o total fica igual ou abaixo do mínimo, o grupo entra na lista com a quantidade para chegar ao máximo.
   - Seção "pode completar" para itens entre o mínimo e o máximo.
   - Organizada por seção do mercado, com marcas preferidas, itens para marcar e compartilhamento (WhatsApp etc.).
5. **Relatório de consumo mensal**
   - Quanto de cada produto foi usado por mês (3, 6 ou 12 meses), com comparativo mês a mês (▲/▼ %), detalhamento por marca, média mensal e quantas semanas o estoque atual dura.
   - Também mostra as compras (entradas) por mês, sugere mínimo/máximo com base no consumo e exporta CSV.

Extras: histórico de movimentações, backup/restauração em JSON, tema claro/escuro.

## Como rodar

Não precisa de build. Sirva a pasta com qualquer servidor estático:

```bash
npm start            # ou: python3 -m http.server 8080
```

Abra `http://localhost:8080`. **A câmera só funciona em HTTPS ou localhost**, então para usar no celular publique em um host com HTTPS (ex.: GitHub Pages: *Settings → Pages → Deploy from branch*).

Leitura de código de barras: usa o `BarcodeDetector` nativo (Chrome/Android) e, onde não existe (iPhone, desktop), a biblioteca [ZXing](https://github.com/zxing-js/library) incluída em `vendor/` (Apache-2.0).

## Testes

```bash
npm test
```

Testam a similaridade entre produtos, a lista de compras e o relatório mensal.

## Estrutura

```
index.html            página única
css/style.css         estilos (claro/escuro, mobile first)
js/app.js             telas e navegação
js/db.js              armazenamento local (IndexedDB), movimentações, backup
js/similarity.js      agrupamento por similaridade e seção do mercado
js/logic.js           lista de compras e relatório de consumo
js/scanner.js         leitura do código de barras pela câmera
sw.js                 cache offline
vendor/zxing.min.js   leitor de código de barras para navegadores sem BarcodeDetector
```
