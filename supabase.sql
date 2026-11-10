-- ============================================================
-- Sistema do Garçom — schema do Supabase
-- Rode este arquivo inteiro no SQL Editor do Supabase
-- (Dashboard do projeto → SQL Editor → New query → colar → Run).
-- ============================================================

-- Garçons (login + senha com hash SHA-256, criado no app)
create table if not exists public.waiters (
  id uuid primary key,
  name text not null,
  login text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

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
  add column if not exists drink_type text
    check (drink_type in ('refrigerante', 'cerveja', 'torre', 'outro'));
alter table public.products
  add column if not exists description text;

-- Configurações (uma única linha, id = 1)
-- order_seq: contador do número do pedido ("Pedido Nº 0001"), sequencial.
create table if not exists public.settings (
  id integer primary key,
  service_fee_pct numeric not null default 3
    check (service_fee_pct >= 0 and service_fee_pct <= 100),
  table_count integer not null default 12
    check (table_count >= 1 and table_count <= 100),
  order_seq integer not null default 0
);

-- Para bancos criados com a versão anterior do schema (sem a coluna):
alter table public.settings
  add column if not exists order_seq integer not null default 0;

-- Próximo número do pedido — incremento atômico (dois garçons
-- enviando ao mesmo tempo não pegam o mesmo número).
create or replace function public.next_order_number()
returns integer
language sql
as $$
  insert into public.settings (id, order_seq)
  values (1, 1)
  on conflict (id) do update
    set order_seq = public.settings.order_seq + 1
  returning order_seq;
$$;

-- Pedidos (um por mesa aberta)
create table if not exists public.orders (
  id uuid primary key,
  table_number integer not null,
  waiter_id uuid not null references public.waiters (id),
  waiter_name text not null,
  status text not null default 'open'
    check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

-- Itens do pedido
-- sent = false → ainda no resumo; true → já enviado p/ cozinha/bar
-- serve: como servir a bebida (só bar) — ex.: "copo com limão e gelo"
create table if not exists public.order_items (
  id uuid primary key,
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
  add column if not exists serve text;

-- Contas fechadas — é daqui que o futuro sistema financeiro
-- do dono vai ler as vendas por garçom (valor, taxa, garçom).
create table if not exists public.closed_bills (
  id uuid primary key,
  order_id uuid not null references public.orders (id),
  table_number integer not null,
  waiter_id uuid not null references public.waiters (id),
  waiter_name text not null,
  subtotal_cents integer not null,
  fee_cents integer not null,
  total_cents integer not null,
  closed_at timestamptz not null default now()
);

-- Garante a linha de configurações (id = 1)
insert into public.settings (id, service_fee_pct, table_count)
values (1, 3, 12)
on conflict (id) do nothing;

-- ------------------------------------------------------------
-- Acesso: o app usa a chave ANON do Supabase.
-- Estas policies liberam o acesso às tabelas (protótipo do
-- restaurante — o dono é quem vai restringir depois, quando o
-- sistema do dono entrar, com login próprio de administrador).
-- ------------------------------------------------------------

alter table public.waiters enable row level security;
alter table public.products enable row level security;
alter table public.settings enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.closed_bills enable row level security;

create policy "garcom_all_waiters" on public.waiters
  for all using (true) with check (true);
create policy "garcom_all_products" on public.products
  for all using (true) with check (true);
create policy "garcom_all_settings" on public.settings
  for all using (true) with check (true);
create policy "garcom_all_orders" on public.orders
  for all using (true) with check (true);
create policy "garcom_all_order_items" on public.order_items
  for all using (true) with check (true);
create policy "garcom_all_closed_bills" on public.closed_bills
  for all using (true) with check (true);
