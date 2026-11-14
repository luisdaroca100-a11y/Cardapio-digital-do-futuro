/**
 * POST /api/mp/webhook — recebe as notificações do Mercado Pago
 * (assinatura criada/atualizada, parcela autorizada, pagamento).
 * Pagamento único Pix (sem preapproval_id) também cai aqui: é
 * tratado por decidePixPaymentUpdate (external_reference
 * `id:pix:plano` + valor + status approved) e NÃO muda o `plan`
 * guardado quando é o teste de R$ 0,50.
 *
 * Regras de segurança (não flexibilizar):
 *  - O payload do webhook só traz o ID — NUNCA liberar/bloquear
 *    por ele. A assinatura HMAC do header `x-signature` é validada
 *    quando MP_WEBHOOK_SECRET existe, e SEMPRE se confirma com GET
 *    à API do MP (GET /preapproval/{id} e/ou GET /v1/payments/{id})
 *    antes de atualizar o banco.
 *  - Responde 200 rápido (o MP reenvia a cada 15 min sem 200).
 *  - Idempotente: notificação duplicada não estende o prazo duas
 *    vezes, e webhook de pré-aprovação antiga (de plano trocado)
 *    não mexe na assinatura atual.
 *  - Sem MP_ACCESS_TOKEN ou sem Supabase configurado, não há como
 *    confirmar nem gravar: responde 200 sem mexer em nada.
 */
import { NextResponse } from 'next/server';
import {
  decidePixPaymentUpdate,
  decideSubscriptionUpdate,
  type ConfirmedPayment,
  type ConfirmedPreapproval,
} from '@/lib/mp';
import {
  mpApi,
  mpSupabase,
  verifyMpSignature,
} from '@/lib/mpServer';

export async function POST(req: Request) {
  let envelope: unknown;
  try {
    envelope = await req.json();
  } catch {
    return NextResponse.json({ received: true });
  }
  const env = (envelope ?? {}) as Record<string, unknown>;
  const data = (env.data ?? {}) as Record<string, unknown>;
  const dataId = data.id;
  const type = typeof env.type === 'string' ? env.type : '';
  if (dataId === undefined || dataId === null || String(dataId) === '') {
    return NextResponse.json({ received: true });
  }
  const resourceId = String(dataId);

  // Assinatura HMAC (só quando há segredo configurado). Assinatura
  // inválida = ignora o evento, sem mexer no banco.
  if (verifyMpSignature(req, resourceId, process.env.MP_WEBHOOK_SECRET) === false) {
    console.warn('[mp/webhook] assinatura x-signature inválida — evento ignorado.');
    return NextResponse.json({ received: true });
  }

  const token = process.env.MP_ACCESS_TOKEN || '';
  const sb = mpSupabase();
  if (!token || !sb) {
    return NextResponse.json({ received: true });
  }

  // Confirmação por GET à API do MP (o payload só traz o ID).
  let preapproval: ConfirmedPreapproval | null = null;
  let payment: ConfirmedPayment | null = null;
  try {
    if (type === 'subscription_preapproval') {
      const res = await mpApi(`/preapproval/${resourceId}`, token);
      if (!res.ok) return NextResponse.json({ received: true });
      preapproval = (await res.json()) as ConfirmedPreapproval;
    } else if (
      type === 'subscription_authorized_payment' ||
      type === 'payment'
    ) {
      const payRes = await mpApi(`/v1/payments/${resourceId}`, token);
      if (!payRes.ok) return NextResponse.json({ received: true });
      payment = (await payRes.json()) as ConfirmedPayment;
      const preId =
        typeof payment.preapproval_id === 'string'
          ? payment.preapproval_id
          : null;
      // Pagamento único Pix NÃO tem preapproval_id: é o fluxo Pix
      // (decidePixPaymentUpdate), não o da assinatura — trata aqui
      // e responde; o fluxo de assinatura continua abaixo.
      if (!preId) {
        if (type !== 'payment') return NextResponse.json({ received: true });
        const pixDecision = decidePixPaymentUpdate({ payment });
        if (pixDecision.action !== 'activate') {
          return NextResponse.json({ received: true });
        }
        const { data: pixRestaurant } = await sb
          .from('restaurants')
          .select('id, paid_until, plan')
          .eq('id', pixDecision.restaurantId)
          .maybeSingle();
        if (!pixRestaurant) return NextResponse.json({ received: true });
        // Idempotente: duplicata não estende o prazo duas vezes.
        // (decidePixPaymentUpdate sem paid_until atual usa "agora"
        // como base — recalcula com o paid_until guardado.)
        const withCurrent = decidePixPaymentUpdate({
          payment,
          currentPaidUntil:
            typeof (pixRestaurant as Record<string, unknown>).paid_until ===
            'string'
              ? ((pixRestaurant as Record<string, unknown>).paid_until as string)
              : null,
        });
        if (withCurrent.action !== 'activate') {
          return NextResponse.json({ received: true });
        }
        const currentPaidUntil =
          typeof (pixRestaurant as Record<string, unknown>).paid_until ===
          'string'
            ? new Date(
                (pixRestaurant as Record<string, unknown>).paid_until as string,
              ).getTime()
            : NaN;
        if (
          Number.isFinite(currentPaidUntil) &&
          currentPaidUntil >= new Date(withCurrent.paidUntil).getTime()
        ) {
          return NextResponse.json({ received: true });
        }
        // Plano de teste NÃO muda o `plan` guardado (nunca vira
        // assinatura); mensal/anual no Pix guardam o plano pago.
        const pixUpdate: Record<string, unknown> = {
          subscription_status: 'active',
          paid_until: withCurrent.paidUntil,
        };
        if (withCurrent.plan !== 'test') {
          pixUpdate.plan = withCurrent.plan;
        }
        const payerEmail =
          typeof payment.payer?.email === 'string'
            ? payment.payer.email
            : null;
        if (payerEmail) pixUpdate.billing_email = payerEmail;
        await sb
          .from('restaurants')
          .update(pixUpdate)
          .eq('id', pixDecision.restaurantId);
        return NextResponse.json({ received: true });
      }
      const preRes = await mpApi(`/preapproval/${preId}`, token);
      if (!preRes.ok) return NextResponse.json({ received: true });
      preapproval = (await preRes.json()) as ConfirmedPreapproval;
    } else {
      return NextResponse.json({ received: true });
    }
  } catch {
    return NextResponse.json({ received: true });
  }

  const decision = decideSubscriptionUpdate({
    webhookType: type,
    preapproval,
    payment,
  });
  if (decision.action === 'keep' || decision.action === 'none') {
    return NextResponse.json({ received: true });
  }

  const restaurantId =
    typeof preapproval?.external_reference === 'string'
      ? preapproval.external_reference
      : null;
  if (!restaurantId || !preapproval) {
    return NextResponse.json({ received: true });
  }

  const { data: restaurant } = await sb
    .from('restaurants')
    .select('id, mp_preapproval_id, paid_until, subscription_status')
    .eq('id', restaurantId)
    .maybeSingle();
  if (!restaurant) return NextResponse.json({ received: true });

  // Webhook de pré-aprovação antiga (plano trocado) não mexe na
  // assinatura atual: só vale o id guardado no restaurante (ou
  // nenhum, quando o checkout ainda não gravou).
  const storedPreapprovalId =
    typeof (restaurant as Record<string, unknown>).mp_preapproval_id ===
    'string'
      ? ((restaurant as Record<string, unknown>).mp_preapproval_id as string)
      : null;
  if (storedPreapprovalId && storedPreapprovalId !== preapproval.id) {
    return NextResponse.json({ received: true });
  }

  if (decision.action === 'activate') {
    const currentPaidUntil =
      typeof (restaurant as Record<string, unknown>).paid_until === 'string'
        ? new Date(
            (restaurant as Record<string, unknown>).paid_until as string,
          ).getTime()
        : NaN;
    // Idempotente: duplicata não estende o prazo duas vezes.
    if (
      Number.isFinite(currentPaidUntil) &&
      currentPaidUntil >= new Date(decision.paidUntil).getTime()
    ) {
      return NextResponse.json({ received: true });
    }
    await sb
      .from('restaurants')
      .update({
        subscription_status: 'active',
        paid_until: decision.paidUntil,
        mp_preapproval_id: preapproval.id,
        plan: decision.plan,
      })
      .eq('id', restaurantId);
  } else if (decision.action === 'block') {
    if (
      (restaurant as Record<string, unknown>).subscription_status ===
      'canceled'
    ) {
      return NextResponse.json({ received: true });
    }
    await sb
      .from('restaurants')
      .update({ subscription_status: 'canceled' })
      .eq('id', restaurantId);
  }

  return NextResponse.json({ received: true });
}
