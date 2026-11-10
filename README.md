# Sistema do Garçom

Sistema do garçom para restaurantes: mesas numeradas, pedidos com cardápio,
vias de cozinha, bar e balcão, e taxa de serviço. O cliente olha o cardápio de
papel e o garçom anota no celular.

> **Parte do garçom apenas.** O sistema do dono (financeiro, gerenciamento de
> cardápio e garçons, QR codes) fica para uma próxima etapa e vai ler as
> contas fechadas que este sistema já grava.

## Como funciona

1. **Primeiro acesso** (só aparece uma vez, quando o sistema está vazio):
   cria o acesso do garçom (nome, login e senha) e cadastra o cardápio
   (nome, preço, categoria e se imprime na Cozinha ou no Bar). Depois, o
   sistema abre direto no login.
2. **Login do garçom** — entra e já cai na grade de mesas.
3. **Mesas** — só o "Olá, nome" e a grade numerada com o estado ao vivo:
   livre, aberta por você (com o total correndo) ou aberta por outro garçom
   (cadeado no canto e o nome dele pequeno no ícone; só ele abre, sem senha
   de novo). No cabeçalho ficam os botões **Cardápio** (ver o cardápio),
   **Ajustes** e **Sair**.
4. **Pedir** — busca em cima, categorias em botões laranja, produtos em
   cartões roxos com o preço na etiqueta verde. Tocou no produto, ele entra
   no pedido e abre o resumo.
5. **Resumo do pedido** — muda quantidade, escreve observação, retira item;
   mostra subtotal, taxa de serviço e total. Embaixo: **Adicionar produtos**,
   **Fechar mesa** e **Enviar pedido**.
6. **Enviar pedido** — a via da **cozinha** sai só com os pratos e a mesa
   (sem valores) e a do **bar** só com as bebidas. Os dois ficam juntos no
   resumo da mesa. Depois de enviar, a mesa continua sendo do mesmo garçom:
   ele toca nela de novo e pede mais na mesma mesa.
7. **Fechar mesa** — a via do **balcão** sai com tudo e os valores finais, e
   a mesa libera. Logo depois do fechamento aparece a **revisão da conta**
   (itens, quantidades e valores) para o garçom conferir se não esqueceu
   nada ou adicionou algo sem querer. A conta fechada fica guardada para o
   financeiro do dono.

As impressoras térmicas de verdade entram quando o sistema rodar no
restaurante — por enquanto cada impressão aparece na tela como a via de
papel, para conferir o que sairia em cada impressora.

## Rodar localmente

```bash
npm install
npm run dev
```

Abra http://localhost:3000.

Sem configurar nada, o sistema roda em **modo local**: os dados ficam no
navegador (localStorage), num aparelho só. Bom para testar.

## Banco de dados com Supabase (nuvem)

1. Crie um projeto no [Supabase](https://supabase.com) (plano gratuito).
2. No painel do projeto, vá em **SQL Editor → New query**, cole o conteúdo
   do arquivo `supabase.sql` e clique em **Run**. Isso cria as tabelas
   (`waiters`, `products`, `settings`, `orders`, `order_items`,
   `closed_bills`).
3. Em **Project Settings → API**, copie a **Project URL** e a chave
   **anon public**.
4. Crie um arquivo `.env.local` na raiz do projeto:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://SEU-PROJETO.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=SUA-CHAVE-ANON
```

5. Reinicie o `npm run dev`. Com as duas variáveis configuradas, o sistema
   passa a usar o Supabase — os dados ficam na nuvem e valem para todos os
   aparelhos.

> Sem as variáveis, o sistema volta sozinho para o modo local. Nada quebra.

## Publicar na Vercel

1. Suba este repositório para o GitHub.
2. Na [Vercel](https://vercel.com), clique em **Add New → Project** e
   importe o repositório.
3. Em **Environment Variables**, adicione as duas variáveis do Supabase
   (`NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY`) se for
   usar o banco na nuvem. Sem elas, o site publicado roda em modo local.
4. Clique em **Deploy**. O endereço da Vercel é o do sistema.

## Estrutura

```
src/app/page.tsx       — todas as telas (setup, login, mesas, pedir, resumo, ajustes)
src/app/layout.tsx     — layout base
src/app/globals.css    — tema branco + roxo + laranja
src/lib/store.ts       — dados: Supabase quando configurado, localStorage quando não
src/lib/types.ts       — tipos (garçom, produto, pedido, item, conta fechada)
supabase.sql           — schema completo do banco
```

## Observações

- A senha do garçom é guardada como hash SHA-256, nunca em texto claro.
- O cadastro do cardápio e dos garçons, no sistema final, é do dono, no
  sistema dele. Aqui ele está no primeiro acesso e em Ajustes só para o
  sistema funcionar e poder ser testado.
- Não há dados de demonstração: o sistema começa vazio e o cardápio é
  cadastrado no primeiro acesso.
