-- ============================================================
-- Sistema do Garçom — schema do Supabase (plataforma multi-restaurante)
-- Rode este arquivo inteiro no SQL Editor do Supabase
-- (Dashboard do projeto → SQL Editor → New query → colar → Run).
-- Pode rodar de novo sem erro: tudo usa "if not exists" e as
-- policies são apagadas antes de recriadas.
-- ============================================================

-- Plataforma: cada restaurante tem seu dono, seus garçons, seu
-- cardápio, seus pedidos e suas vendas. Ninguém vê dados de outro
-- restaurante: toda tabela de dados tem restaurant_id e o app filtra
-- por ele. O login (dono ou garçom) é ÚNICO na plataforma toda.

-- Restaurantes cadastrados na plataforma (cadastro sozinho, pelo dono).
-- plan: plano escolhido no cadastro — 'monthly' (R$ 69,99/mês) ou
-- 'annual' (R$ 499,99/ano). Os dois começam com 3 dias grátis,
-- contados da data de cadastro (created_at). null = restaurante
-- cadastrado antes dos planos, ou sem plano escolhido — fica no
-- período grátis do mesmo jeito.
create table if not exists public.restaurants (
  id uuid primary key,
  name text not null,
  plan text check (plan in ('monthly', 'annual')),
  created_at timestamptz not null default now()
);

-- Para bancos criados com a versão anterior do schema (sem a coluna):
alter table public.restaurants
  add column if not exists plan text check (plan in ('monthly', 'annual'));

-- Administrador da plataforma (só o Luis) — vê QUAIS restaurantes
-- estão cadastrados (nome, dono, data, nº de garçons). NÃO vê
-- financeiro nenhum: sem vendas, sem valores, sem comissões.
-- É SEPARADO dos donos de restaurante: não é dono nem garçom e não
-- aparece em nenhum restaurante.
create table if not exists public.platform_admins (
  id uuid primary key,
  login text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

-- Dono do restaurante — um por restaurante; login próprio de administrador
-- (usuário que só ele sabe + senha com hash SHA-256, criado no app).
-- login é unique na tabela = único na plataforma toda.
create table if not exists public.owners (
  id uuid primary key,
  restaurant_id uuid references public.restaurants (id),
  name text not null,
  login text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

-- Garçons (login + senha com hash SHA-256, criado no app)
-- commission_pct: % de comissão do garçom sobre o total da conta.
-- login é unique na tabela = único na plataforma toda.
create table if not exists public.waiters (
  id uuid primary key,
  restaurant_id uuid references public.restaurants (id),
  name text not null,
  login text not null unique,
  password_hash text not null,
  commission_pct numeric not null default 8
    check (commission_pct >= 0 and commission_pct <= 100),
  created_at timestamptz not null default now()
);

-- Para bancos criados com a versão anterior do schema (sem as colunas):
alter table public.owners
  add column if not exists restaurant_id uuid references public.restaurants (id);
alter table public.waiters
  add column if not exists restaurant_id uuid references public.restaurants (id);
alter table public.waiters
  add column if not exists commission_pct numeric not null default 8
    check (commission_pct >= 0 and commission_pct <= 100);

-- Produtos do cardápio
-- prints_in: 'kitchen' (prato → impressora da cozinha)
--          ou 'bar'    (bebida → impressora do bar)
-- drink_type: tipo da bebida (só bar) — define as opções de "Como
--   servir": 'refrigerante' (4 jeitos de copo), 'cerveja' (precisa de
--   copos? + quantos), 'torre' (quantas canecas?), 'outro' (sem opções).
-- description: "o que vem no prato" (só comida) — opcional, vai na via
-- da cozinha, embaixo do nome do prato.
create table if not exists public.products (
  id uuid primary key,
  restaurant_id uuid references public.restaurants (id),
  name text not null,
  price_cents integer not null check (price_cents > 0),
  category text not null default 'Geral',
  prints_in text not null default 'kitchen'
    check (prints_in in ('kitchen', 'bar')),
  drink_type text
    check (drink_type in ('refrigerante', 'cerveja', 'torre', 'outro')),
  description text,
  created_at timestamptz not null default now()
);

-- Para bancos criados com a versão anterior do schema (sem as colunas):
alter table public.products
  add column if not exists restaurant_id uuid references public.restaurants (id);
alter table public.products
  add column if not exists drink_type text
    check (drink_type in ('refrigerante', 'cerveja', 'torre', 'outro'));
alter table public.products
  add column if not exists description text;

-- Sequência para o id das linhas de configurações (uma linha por
-- restaurante; o id continua inteiro, mas agora vem de uma sequence
-- em vez de ser sempre 1).
create sequence if not exists public.settings_id_seq;

-- Configurações — UMA LINHA POR RESTAURANTE (restaurant_id unique).
-- order_seq: contador do número do pedido ("Pedido Nº 0001"), sequencial
-- POR restaurante. default_commission_pct: % de comissão padrão dos
-- garçons (vale pros novos garçons; cada um pode ter a sua própria %).
-- day_closed_date: data (AAAA-MM-DD) em que o dono finalizou o dia;
-- null = dia aberto. O dia reabre sozinho às 9h da manhã seguinte.
create table if not exists public.settings (
  id integer primary key default nextval('public.settings_id_seq'),
  restaurant_id uuid references public.restaurants (id),
  service_fee_pct numeric not null default 3
    check (service_fee_pct >= 0 and service_fee_pct <= 100),
  table_count integer not null default 12
    check (table_count >= 1 and table_count <= 100),
  order_seq integer not null default 0,
  default_commission_pct numeric not null default 8
    check (default_commission_pct >= 0 and default_commission_pct <= 100),
  day_closed_date text
);

-- Para bancos criados com a versão anterior do schema (sem as colunas):
alter table public.settings
  add column if not exists restaurant_id uuid references public.restaurants (id);
alter table public.settings
  add column if not exists order_seq integer not null default 0;
alter table public.settings
  add column if not exists default_commission_pct numeric not null default 8
    check (default_commission_pct >= 0 and default_commission_pct <= 100);
alter table public.settings
  add column if not exists day_closed_date text;
alter table public.settings
  alter column id set default nextval('public.settings_id_seq');

-- Uma única linha de configurações por restaurante.
create unique index if not exists settings_restaurant_id_key
  on public.settings (restaurant_id);

-- A sequence não pode voltar atrás do maior id que já existe.
do $$
begin
  perform setval(
    'public.settings_id_seq',
    coalesce((select max(id) from public.settings), 1)
  );
end $$;

-- Próximo número do pedido — incremento atômico POR restaurante (dois
-- garçons enviando ao mesmo tempo não pegam o mesmo número, e cada
-- restaurante tem o seu próprio sequencial).
create or replace function public.next_order_number(p_restaurant_id uuid)
returns integer
language sql
as $$
  insert into public.settings (restaurant_id, order_seq)
  values (p_restaurant_id, 1)
  on conflict (restaurant_id) do update
    set order_seq = public.settings.order_seq + 1
  returning order_seq;
$$;

-- Pedidos (um por mesa aberta)
create table if not exists public.orders (
  id uuid primary key,
  restaurant_id uuid references public.restaurants (id),
  table_number integer not null,
  waiter_id uuid not null references public.waiters (id),
  waiter_name text not null,
  status text not null default 'open'
    check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

-- Para bancos criados com a versão anterior do schema (sem a coluna):
alter table public.orders
  add column if not exists restaurant_id uuid references public.restaurants (id);

-- Itens do pedido
-- sent = false → ainda no resumo; true → já enviado p/ cozinha/bar
-- serve: como servir a bebida (só bar) — ex.: "copo com limão e gelo"
create table if not exists public.order_items (
  id uuid primary key,
  restaurant_id uuid references public.restaurants (id),
  order_id uuid not null references public.orders (id) on delete cascade,
  product_id uuid not null references public.products (id),
  product_name text not null,
  price_cents integer not null check (price_cents > 0),
  qty integer not null default 1 check (qty > 0),
  note text not null default '',
  serve text,
  sent boolean not null default false,
  created_at timestamptz not null default now()
);

-- Para bancos criados com a versão anterior do schema (sem a coluna):
alter table public.order_items
  add column if not exists restaurant_id uuid references public.restaurants (id);
alter table public.order_items
  add column if not exists serve text;

-- Contas fechadas — é daqui que o sistema financeiro do dono lê
-- as vendas por garçom (valor, taxa, comissão do garçom).
-- commission_cents / commission_pct: comissão congelada na hora do
-- fechamento (se a % do garçom mudar depois, a conta antiga não muda).
create table if not exists public.closed_bills (
  id uuid primary key,
  restaurant_id uuid references public.restaurants (id),
  order_id uuid not null references public.orders (id),
  table_number integer not null,
  waiter_id uuid not null references public.waiters (id),
  waiter_name text not null,
  subtotal_cents integer not null,
  fee_cents integer not null,
  total_cents integer not null,
  commission_cents integer not null default 0,
  commission_pct numeric not null default 0,
  closed_at timestamptz not null default now()
);

-- Para bancos criados com a versão anterior do schema (sem as colunas):
alter table public.closed_bills
  add column if not exists restaurant_id uuid references public.restaurants (id);
alter table public.closed_bills
  add column if not exists commission_cents integer not null default 0;
alter table public.closed_bills
  add column if not exists commission_pct numeric not null default 0;

-- ------------------------------------------------------------
-- Migração do restaurante que já existe (Gosto Caseiro):
-- o dono, os garçons, o cardápio, os pedidos e as vendas que já
-- estão no banco viram o primeiro restaurante da plataforma, SEM
-- perder nada. Idempotente: só liga os registros que ainda estão
-- sem restaurant_id; rodar de novo não duplica nem mexe em nada.
-- Em banco novo (sem nenhum dado) não cria nada.
-- ------------------------------------------------------------
do $$
declare
  gc_id uuid;
  has_legacy boolean;
begin
  has_legacy :=
    exists (select 1 from public.owners where restaurant_id is null) or
    exists (select 1 from public.waiters where restaurant_id is null) or
    exists (select 1 from public.products where restaurant_id is null) or
    exists (select 1 from public.orders where restaurant_id is null) or
    exists (select 1 from public.order_items where restaurant_id is null) or
    exists (select 1 from public.closed_bills where restaurant_id is null) or
    exists (select 1 from public.settings where restaurant_id is null);
  if has_legacy then
    select id into gc_id
      from public.restaurants
     where name = 'Gosto Caseiro'
     limit 1;
    if gc_id is null then
      insert into public.restaurants (id, name)
      values (gen_random_uuid(), 'Gosto Caseiro')
      returning id into gc_id;
    end if;
    update public.owners
       set restaurant_id = gc_id where restaurant_id is null;
    update public.waiters
       set restaurant_id = gc_id where restaurant_id is null;
    update public.products
       set restaurant_id = gc_id where restaurant_id is null;
    update public.settings
       set restaurant_id = gc_id where restaurant_id is null;
    update public.orders
       set restaurant_id = gc_id where restaurant_id is null;
    update public.closed_bills
       set restaurant_id = gc_id where restaurant_id is null;
    -- Itens herdam o restaurante do pedido deles.
    update public.order_items oi
       set restaurant_id = o.restaurant_id
      from public.orders o
     where oi.order_id = o.id and oi.restaurant_id is null;
  end if;
end $$;

-- ------------------------------------------------------------
-- Acesso: o app usa a chave ANON do Supabase.
-- Estas policies liberam o acesso às tabelas (protótipo do
-- restaurante — o login do dono separa as áreas no app, mas o
-- banco ainda não restringe por usuário; o isolamento entre
-- restaurantes é feito pelo app, filtrando por restaurant_id).
-- ------------------------------------------------------------

alter table public.restaurants enable row level security;
alter table public.platform_admins enable row level security;
alter table public.owners enable row level security;
alter table public.waiters enable row level security;
alter table public.products enable row level security;
alter table public.settings enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.closed_bills enable row level security;

drop policy if exists "garcom_all_restaurants" on public.restaurants;
create policy "garcom_all_restaurants" on public.restaurants
  for all using (true) with check (true);
drop policy if exists "admin_all_platform_admins" on public.platform_admins;
create policy "admin_all_platform_admins" on public.platform_admins
  for all using (true) with check (true);
drop policy if exists "dono_all_owners" on public.owners;
create policy "dono_all_owners" on public.owners
  for all using (true) with check (true);
drop policy if exists "garcom_all_waiters" on public.waiters;
create policy "garcom_all_waiters" on public.waiters
  for all using (true) with check (true);
drop policy if exists "garcom_all_products" on public.products;
create policy "garcom_all_products" on public.products
  for all using (true) with check (true);
drop policy if exists "garcom_all_settings" on public.settings;
create policy "garcom_all_settings" on public.settings
  for all using (true) with check (true);
drop policy if exists "garcom_all_orders" on public.orders;
create policy "garcom_all_orders" on public.orders
  for all using (true) with check (true);
drop policy if exists "garcom_all_order_items" on public.order_items;
create policy "garcom_all_order_items" on public.order_items
  for all using (true) with check (true);
drop policy if exists "garcom_all_closed_bills" on public.closed_bills;
create policy "garcom_all_closed_bills" on public.closed_bills
  for all using (true) with check (true);
