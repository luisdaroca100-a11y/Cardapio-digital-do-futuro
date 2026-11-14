/**
 * POST /api/mp/checkout — cria a assinatura (pré-aprovação) no
 * Mercado Pago e devolve o `init_point` pro dono autorizar o cartão.
 *
 * Corpo: { restaurantId, plan, payerEmail }
 *  - plano e e-mail validados; o PREÇO vem do plano (tabela em
 *    src/lib/mp.ts), nunca do cliente.
 *  - sem MP_ACCESS_TOKEN: 503 com erro claro em pt-BR (o pagamento
 *    ainda não está configurado — o app NÃO quebra).
 *  - grava mp_preapproval_id + billing_email + plano no restaurante
 *    (quando o Supabase está configurado; no modo local, sem banco,
 *    a pré-aprovação é criada do mesmo jeito e o init_point volta —
 *    o destrave real só acontece via webhook no Supabase).
 *  - a `back_url` NÃO é prova de pagamento: a liberação vem do
 *    webhook, depois do GET de confirmação à API do MP.
 */
import { NextResponse } from 'next/server';
import { buildPreapprovalPayload } from '@/lib/mp';
import type { PlanId } from '@/lib/types';
import {
  mpApi,
  mpError,
  mpSupabase,
  requestOrigin,
} from '@/lib/mpServer';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return mpError(400, 'Pedido inválido. Tente de novo.');
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const restaurantId =
    typeof b.restaurantId === 'string' ? b.restaurantId.trim() : '';
  const plan = typeof b.plan === 'string' ? b.plan : '';
  const payerEmail =
    typeof b.payerEmail === 'string' ? b.payerEmail.trim() : '';

  if (!restaurantId) {
    return mpError(400, 'Restaurante não identificado.');
  }
  if (plan !== 'monthly' && plan !== 'annual') {
    return mpError(400, 'Plano inválido. Escolha Mensal ou Anual.');
  }
  if (!EMAIL_RE.test(payerEmail)) {
    return mpError(400, 'Informe um e-mail válido para a assinatura.');
  }

  const token = process.env.MP_ACCESS_TOKEN || '';
  if (!token) {
    return mpError(
      503,
      'O pagamento ainda não está configurado — fale com o Luis para ativar a assinatura.',
    );
  }

  const sb = mpSupabase();
  if (sb) {
    const { data: restaurant, error } = await sb
      .from('restaurants')
      .select('id')
      .eq('id', restaurantId)
      .maybeSingle();
    if (error) {
      return mpError(500, 'Não foi possível conferir o restaurante. Tente de novo.');
    }
    if (!restaurant) {
      return mpError(404, 'Restaurante não encontrado.');
    }
  }

  const origin = requestOrigin(req);
  const payload = buildPreapprovalPayload({
    restaurantId,
    plan: plan as PlanId,
    payerEmail,
    notificationUrl: `${origin}/api/mp/webhook?source_news=webhooks`,
    backUrl: `${origin}/?tela=planos`,
  });

  let mpRes: Response;
  try {
    mpRes = await mpApi('/preapproval', token, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch {
    return mpError(
      502,
      'Não foi possível falar com o Mercado Pago. Tente de novo em alguns minutos.',
    );
  }
  const mpData = (await mpRes.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!mpRes.ok || typeof mpData.init_point !== 'string') {
    return mpError(
      502,
      'O Mercado Pago não aceitou a assinatura. Confira o e-mail e tente de novo.',
    );
  }

  // Grava a pré-aprovação no restaurante (o destrave vem do webhook).
  if (sb && typeof mpData.id === 'string') {
    await sb
      .from('restaurants')
      .update({
        plan: plan as PlanId,
        billing_email: payerEmail,
        mp_preapproval_id: mpData.id,
      })
      .eq('id', restaurantId);
  }

  return NextResponse.json({ init_point: mpData.init_point });
}
