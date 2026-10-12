# Dispensa — controle de compras e estoque da casa

App web (PWA) para controlar o estoque da dispensa e montar a lista de compras do mercado.
Funciona no celular e pode ser instalado na tela inicial. Os dados ficam **na nuvem (Firebase)**, sincronizados
em tempo real entre os celulares da família, e o app continua funcionando sem internet (as mudanças sobem quando a conexão volta).

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

6. **Nuvem, família e log de ações**
   - Cada pessoa entra com a própria conta (e-mail/senha ou Google) no próprio celular.
   - Os dados ficam numa **casa** compartilhada. Quem cria a casa recebe um **código de convite** (ex.: `K7Q2MX`), e os outros entram digitando esse código.
   - Mudanças feitas por uma pessoa aparecem sozinhas para as outras.
   - Cada retirada, entrada, desfazer, cadastro/edição/exclusão de produto ou grupo e restauração de backup fica registrada com o nome de quem fez.
   - O *Histórico* filtra por pessoa e por tipo e mostra o resumo do mês: quanto cada um retirou e guardou.
   - Só quem faz parte da casa vê e altera os dados dela (regras em `firestore.rules`).
   - Quem já usava a versão anterior (dados só no aparelho) vê em ⚙️ o botão **Enviar para a casa** para levar tudo para a nuvem.

Extras: backup/restauração em JSON, tema claro/escuro.

## Configurar a nuvem (Firebase) — uma vez só

O plano gratuito (Spark) do Firebase é suficiente para uma família.

1. Acesse <https://console.firebase.google.com> e clique em **Criar projeto** (pode desativar o Google Analytics).
2. **Authentication → Vamos começar → Método de login**: ative **E-mail/senha**. Opcional: ative **Google**.
3. **Firestore Database → Criar banco de dados**: escolha um local (ex.: `southamerica-east1`, São Paulo) e o modo de produção.
   Depois, na aba **Regras**, apague o conteúdo, cole o arquivo [`firestore.rules`](firestore.rules) e clique em **Publicar**.
4. **Configurações do projeto (⚙️) → Seus apps → Web (`</>`)**: registre o app e copie o objeto `firebaseConfig`.
5. Cole o `firebaseConfig` em [`js/firebase-config.js`](js/firebase-config.js) (troque o `null`) e faça commit.
   Se preferir, deixe `null`: o app pede a configuração na primeira abertura, mas aí é preciso colar em cada celular.
6. Publique o app num endereço **HTTPS** (a câmera e o login exigem HTTPS):
   - **GitHub Pages**: *Settings → Pages → Deploy from branch*. Depois, no Firebase, em
     **Authentication → Configurações → Domínios autorizados**, adicione `SEU-USUARIO.github.io`.
   - ou **Firebase Hosting**: `npx firebase-tools login` e `npx firebase-tools deploy --project SEU-PROJETO`
     (publica o app e as regras; o domínio já vem autorizado).
7. Abra o app no celular, crie sua conta, crie a casa e envie o código de convite para a família (⚙️ → Casa e pessoas → Enviar convite).

Os valores do `firebaseConfig` não são secretos; o que protege os dados são as regras do Firestore.

## Como rodar localmente

Não precisa de build. Sirva a pasta com qualquer servidor estático:

```bash
npm start            # http://localhost:5173
```

Para desenvolver sem mexer no projeto real, use os emuladores do Firebase (precisa de Java):

```bash
npm run emulators    # Auth + Firestore com as regras, e o app em http://127.0.0.1:5000
```

Na tela de configuração do app, cole `{ apiKey: "demo", projectId: "demo-dispensa", authDomain: "localhost", appId: "demo" }`.
Projetos com nome `demo-*` se conectam automaticamente aos emuladores.

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
js/db.js              dados na nuvem (Firebase Auth + Firestore), casa, convites, movimentações, backup
js/firebase-config.js configuração do projeto Firebase
js/local-db.js        banco local da versão anterior (usado só para migrar os dados para a nuvem)
firestore.rules       regras de segurança do Firestore
firebase.json         Firebase Hosting e emuladores
js/similarity.js      agrupamento por similaridade e seção do mercado
js/logic.js           lista de compras e relatório de consumo
js/scanner.js         leitura do código de barras pela câmera
sw.js                 cache offline
vendor/zxing.min.js   leitor de código de barras para navegadores sem BarcodeDetector
```
