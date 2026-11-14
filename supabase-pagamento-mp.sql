-- ============================================================
-- ComandaJá — pagamento automático (Mercado Pago, Assinaturas)
-- SQL MÍNIMO: só as colunas novas da tabela `restaurants`.
-- Como rodar: Dashboard do Supabase → SQL Editor → New query →
-- colar este arquivo inteiro → Run. Pode rodar de novo sem erro
-- (tudo usa "add column if not exists").
--
-- Depois de rodar: configurar no painel da Vercel as variáveis
-- MP_ACCESS_TOKEN (obrigatório — token de acesso do Mercado Pago,
-- começa com APP_USR nas credenciais de teste) e MP_WEBHOOK_SECRET
-- (opcional — segredo da assinatura do webhook). Sem o token, o
-- checkout responde erro claro e o app continua funcionando no
-- período grátis — nada quebra por falta de token.
-- ============================================================

alter table public.restaurants
  add column if not exists subscription_status text
    check (subscription_status in ('trial', 'active', 'past_due', 'canceled'));

alter table public.restaurants
  add column if not exists mp_preapproval_id text;

alter table public.restaurants
  add column if not exists paid_until timestamptz;

alter table public.restaurants
  add column if not exists billing_email text;
