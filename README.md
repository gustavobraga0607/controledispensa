# Dispensa — controle de compras e estoque da casa

App web (PWA) para controlar o estoque da dispensa e montar a lista de compras do mercado.
Funciona no celular e pode ser instalado na tela inicial. Os dados ficam num banco **Postgres no Neon**,
sincronizados entre os celulares da família, **sem login nem senha**: quem cria a casa envia um link de convite,
e cada celular só escolhe "quem está usando". O app continua funcionando sem internet (as alterações ficam
numa fila e são enviadas quando a conexão volta).

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

6. **Família, sincronização e log de ações (sem login)**
   - Quem abre o app pela primeira vez cria a **casa** e recebe um **link de convite** (⚙️ → Casa e pessoas → Enviar convite).
   - Cada pessoa abre o link no próprio celular e escolhe quem é (nome e ícone). Sem e-mail e sem senha.
   - O nome de quem está usando aparece no topo; tocando nele dá para trocar (celular compartilhado).
   - Os celulares sincronizam sozinhos (a cada 15 segundos, ao abrir o app e quando a internet volta).
   - Cada retirada, entrada, desfazer, cadastro/edição/exclusão de produto ou grupo e restauração de backup fica registrada com o nome de quem fez.
   - O *Histórico* filtra por pessoa e por tipo e mostra o resumo do mês: quanto cada um retirou e guardou.
   - Quem tem o link acessa a casa. Se o link vazar, gere um novo em *Configurações da casa* (o antigo para de funcionar).
   - Quem usava a versão anterior (dados só no aparelho) vê em ⚙️ o botão **Enviar para a casa**.

Extras: backup/restauração em JSON, tema claro/escuro.

## Publicar (Vercel + Neon) — uma vez só

O banco fica no **Neon** e a pequena API que conversa com ele roda na **Vercel**. Os dois têm plano gratuito.
O navegador nunca recebe a senha do banco: ela fica só na Vercel.

1. Crie uma conta em <https://vercel.com> (pode entrar com o GitHub) e clique em **Add New → Project**.
2. Importe este repositório (`controledispensa`) e clique em **Deploy**. Não precisa configurar build.
3. No projeto da Vercel, abra **Storage → Create Database → Neon (Serverless Postgres)** e conecte ao projeto.
   Isso cria o banco e a variável `DATABASE_URL` automaticamente.
   (Se já tiver um banco no Neon, em vez disso vá em **Settings → Environment Variables** e crie
   `DATABASE_URL` com a *connection string* do Neon.)
4. Em **Deployments**, clique em **Redeploy** para a API enxergar a variável.
5. Abra o endereço do app (ex.: `https://controledispensa.vercel.app`) no celular, crie a casa e envie o link de convite para a família.

As tabelas são criadas sozinhas na primeira vez. Só é possível criar **uma casa** por instalação (para ninguém
usar o seu banco); se quiser várias, defina a variável `ALLOW_NEW_HOUSES=1` na Vercel.

### Tabelas no banco

| tabela        | conteúdo |
|---------------|----------|
| `houses`      | a casa e o *hash* da chave do link de convite |
| `docs`        | produtos, grupos, movimentações (log), pessoas e preferências; uma linha por item, com os dados em `jsonb` (coluna `col` diz o tipo) |
| `applied_ops` | controle para uma alteração reenviada não ser aplicada duas vezes |

Exemplo de consulta no SQL Editor do Neon (consumo por produto no mês):

```sql
select data->>'productName' as produto, sum((data->>'qty')::int) as usado
  from docs
 where col = 'movements' and not deleted and data->>'type' = 'out'
   and to_timestamp((data->>'at')::bigint / 1000) >= date_trunc('month', now())
 group by 1 order by 2 desc;
```

## Rodar localmente

```bash
npm install
DATABASE_URL="postgres://usuario:senha@host/banco" npm start    # http://localhost:5173
```

Funciona com a connection string do Neon ou com um Postgres local.
A câmera do celular só funciona em HTTPS (ou em `localhost`).

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
js/db.js              dados: cópia local, fila offline e sincronização com a API
js/local-db.js        banco local da versão anterior (usado só para migrar os dados)
api/house.js          API: criar casa, link de convite, renomear
api/sync.js           API: baixar o que mudou
api/ops.js            API: gravar alterações (com proteção contra envio duplicado)
api/_lib.js           conexão com o Postgres (Neon), tabelas e chave da casa
server.js             servidor local (em produção a Vercel faz esse papel)
js/similarity.js      agrupamento por similaridade e seção do mercado
js/logic.js           lista de compras e relatório de consumo
js/scanner.js         leitura do código de barras pela câmera
sw.js                 cache offline do app
vendor/zxing.min.js   leitor de código de barras para navegadores sem BarcodeDetector
```
