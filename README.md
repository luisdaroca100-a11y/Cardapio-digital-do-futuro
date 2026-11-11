# Sistema do Garçom

Sistema do garçom para restaurantes: mesas numeradas, pedidos com cardápio,
vias de cozinha, bar e balcão, e taxa de serviço. O cliente olha o cardápio de
papel e o garçom anota no celular.

> **Plataforma multi-restaurante.** Cada restaurante se cadastra sozinho
> (nome do restaurante + nome do dono + login + senha) e tem o seu dono,
> os seus garçons, o seu cardápio, os seus pedidos e as suas vendas —
> ninguém vê dados de outro restaurante. O login (de dono ou de garçom)
> é único na plataforma toda. Por enquanto o acesso é liberado no
> cadastro, sem pagamento dentro do sistema — a cobrança mensal fica
> para depois.

> **Apresentação (primeira tela).** Quem abre o sistema cai primeiro
> na apresentação: como funciona, planos (3 dias grátis, depois R$ 69,99
> por mês ou R$ 499,99 por ano, suporte 24 horas nos dois) e o botão
> "Cadastrar meu restaurante", que abre o cadastro dentro do próprio
> sistema. Sem botão grande de entrar — quem já tem conta entra pelo
> link discreto no rodapé ("Já tem uma conta? Entrar").

> **Login único.** O formulário principal de login aceita o login do
> garçom e o do dono (o login é único na plataforma toda): garçom abre
> as mesas; dono abre a área dele. O link "Sou o dono" continua
> existindo como alternativa.

> **QR Code dos garçons.** Na área do dono, a aba "QR Code" mostra um
> QR gerado no próprio app (biblioteca `qrcode`, sem serviço externo)
> com o endereço do sistema + `?tela=garcom`. O garçom escaneia e cai
> direto na tela de login dele — só login e senha, sem apresentação e
> sem os links de dono, cadastro e administrador. O QR só abre a tela;
> a senha continua protegendo o acesso.

> **Área do administrador (só o Luis).** Na tela de login, o link
> discreto "Área do administrador" abre o acesso do administrador da
> plataforma (login que só ele sabe + senha; criado no primeiro
> acesso). Ele vê SÓ quais restaurantes estão cadastrados — nome do
> restaurante, nome do dono, data do cadastro e número de garçons.
> Nenhum dado financeiro: sem vendas, sem valores, sem comissões.
> Donos de restaurante e garçons nunca veem essa área (o link só
> existe na tela de login e a área só abre com a sessão do admin).

## Como funciona

1. **Apresentação** (primeira tela): explica como o sistema funciona,
   mostra os planos e o botão **Cadastrar meu restaurante**, que abre o
   cadastro dentro do próprio sistema. Quem já tem conta entra pelo
   link discreto no rodapé ("Já tem uma conta? Entrar"). O QR Code dos
   garçons (`?tela=garcom`) não passa por aqui: vai direto pro login
   do garçom.
2. **Cadastrar meu restaurante**: o dono informa o
   nome do restaurante, o nome dele, o login e a senha. Cria o
   restaurante + o acesso do dono e mostra a tela **Cadastro realizado
   com sucesso**, com o botão **Entrar no financeiro** embaixo — ele
   abre a tela de login do dono com o usuário já preenchido. O dono
   entra com a senha (não entra direto sem senha) e cai no primeiro
   acesso.
3. **Primeiro acesso** (só aparece uma vez, quando o restaurante ainda
   não tem garçom): cria o acesso do primeiro garçom (nome, login e
   senha) e cadastra o cardápio (nome, preço, categoria e se imprime na
   Cozinha ou no Bar). Depois, o sistema abre direto no login.
4. **Login** — o mesmo formulário aceita o login do garçom e o do dono:
   garçom entra e já cai na grade de mesas; dono entra na área dele.
   (O link "Sou o dono" continua existindo como alternativa.)
5. **Mesas** — só o "Olá, nome" e a grade numerada com o estado ao vivo:
   livre, aberta por você (com o total correndo) ou aberta por outro garçom
   (cadeado no canto e o nome dele pequeno no ícone; só ele abre, sem senha
   de novo). No cabeçalho ficam os botões **Cardápio** (ver o cardápio),
   **Ajustes** e **Sair**.
6. **Pedir** — busca em cima, categorias em botões laranja, produtos em
   cartões roxos com o preço na etiqueta verde. Tocou no produto, ele entra
   no pedido e abre o resumo.
7. **Resumo do pedido** — muda quantidade, escreve observação, retira item;
   mostra subtotal, taxa de serviço e total. Embaixo: **Adicionar produtos**,
   **Fechar mesa** e **Enviar pedido**.
8. **Enviar pedido** — a via da **cozinha** sai só com os pratos e a mesa
   (sem valores) e a do **bar** só com as bebidas. Os dois ficam juntos no
   resumo da mesa. Depois de enviar, a mesa continua sendo do mesmo garçom:
   ele toca nela de novo e pede mais na mesma mesa.
9. **Fechar mesa** — a via do **balcão** sai com tudo e os valores finais, e
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
   (`restaurants`, `platform_admins`, `owners`, `waiters`, `products`,
   `settings`, `orders`, `order_items`, `closed_bills`).
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

## Migração para multi-restaurante (quem já usava o sistema)

O `supabase.sql` pode ser rodado de novo sem erro no banco que já
existe. Ele faz a migração sozinho, sem perder nada:

- Cria a tabela `restaurants` e o restaurante **Gosto Caseiro** (só se
  ainda não existir) e liga a ele tudo que já estava no banco sem
  restaurante — dono, garçons, cardápio, pedidos, itens, contas
  fechadas e configurações. O Gosto Caseiro vira o primeiro
  restaurante da plataforma.
- O número do pedido ("Pedido Nº") passa a ser sequencial **por
  restaurante** — a função `next_order_number()` agora recebe o
  `restaurant_id` e cada restaurante tem o seu próprio contador.
- Em banco novo (sem nenhum dado) a migração não cria nada: o primeiro
  restaurante aparece quando o primeiro dono se cadastra.

No **modo local** (sem Supabase) a migração é automática na primeira
leitura: se o navegador tiver dados do formato antigo, eles viram o
Gosto Caseiro na hora, sem perder nada.

> Depois de rodar o `supabase.sql` novo, o login continua o mesmo —
> garçom e dono entram com o login e a senha de antes, agora dentro
> do restaurante Gosto Caseiro. O administrador da plataforma é
> criado à parte, no primeiro acesso pelo link "Área do administrador"
> na tela de login.

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
src/app/page.tsx       — todas as telas (cadastro, login, mesas, pedir, resumo, ajustes, área do dono, área do administrador)
src/app/layout.tsx     — layout base
src/app/globals.css    — tema branco + roxo + laranja
src/lib/store.ts       — dados: Supabase quando configurado, localStorage quando não; tudo filtrado por restaurante
src/lib/types.ts       — tipos (restaurante, admin da plataforma, dono, garçom, produto, pedido, item, conta fechada)
supabase.sql           — schema completo do banco + migração do Gosto Caseiro
```

## Observações

- A senha do garçom, do dono e do administrador é guardada como hash SHA-256, nunca em texto claro.
- O login é único na plataforma toda: um login usado por um garçom não pode ser usado por um dono (e vice-versa), nem pelo administrador.
- O cadastro do cardápio e dos garçons, no sistema final, é do dono, no
  sistema dele. Aqui ele está no primeiro acesso e em Ajustes só para o
  sistema funcionar e poder ser testado.
- Não há dados de demonstração: o sistema começa vazio e o cardápio é
  cadastrado no primeiro acesso.
