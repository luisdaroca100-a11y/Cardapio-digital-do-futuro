/**
 * Pagamento automático do ComandaJá — Mercado Pago (Assinaturas).
 *
 * Puro (sem DOM, sem rede, sem Next/Supabase): dá pra testar em Node
 * no smoke test e reutilizar nas rotas de API e no navegador.
 *
 * Decisões de produto (definidas com o Luis):
 *  - O trial de 3 dias é do APP (contado do created_at do restaurante)
 *    — NUNCA usar o `free_trial` do Mercado Pago: a primeira cobrança
 *    do MP acontece na autorização, e um trial no MP daria dias grátis
 *    a mais pro cliente.
 *  - Recorrência AUTOMÁTICA no Mercado Pago é só com cartão. Pix nas
 *    assinaturas é cobrança manual a cada ciclo (o cliente paga a cada
 *    mês) e o Pix Automático (BC) não tem suporte documentado na API
 *    de Assinaturas — NUNCA prometer Pix automático em texto de tela.
 *  - Tolerância de 3 dias após o `paid_until` pra retentativa do MP
 *    (parcela recusada entra em `recycling`, até 4 tentativas em 10
 *    dias); só depois disso o acesso bloqueia. Fim do trial sem
 *    assinatura = bloqueio imediato (não há pagamento em retentativa).
 *  - Status desconhecido da pré-aprovação = tratado como não-liberado.
 *  - Não há endpoint de troca de periodicidade (mensal ↔ anual):
 *    trocar de plano = cancelar a pré-aprovação antiga e criar outra.
 *
 * PENDÊNCIA DE VALIDAÇÃO: sem token de teste do Mercado Pago não dá
 * pra chamar o POST /preapproval de verdade — o payload abaixo segue
 * a documentação da API de Assinaturas e precisa ser confirmado com
 * uma credencial de teste (APP_USR) antes de anunciar como validado.
 */

import type { PlanId } from './types.ts';

/** Preços em centavos — O PREÇO VEM DO PLANO, nunca do cliente:
 * buildPreapprovalPayload recebe só o `plan` e resolve o valor aqui.
 * Mensal R$ 69,99/mês; Anual R$ 499,99/ano. */
export const PLAN_PRICES: Record<PlanId, number> = {
  monthly: 6999,
  annual: 49999,
};

/** Periodicidade da cobrança no Mercado Pago: mensal = 1 mês,
 * anual = 12 meses (NÃO existe `frequency_type: "years"` — o anual
 * usa 12 meses). */
export const PLAN_FREQUENCY: Record<
  PlanId,
  { frequency: number; frequency_type: 'months' }
> = {
  monthly: { frequency: 1, frequency_type: 'months' },
  annual: { frequency: 12, frequency_type: 'months' },
};

/** Preço em reais com 2 casas (o que a API do MP espera em
 * auto_recurring.transaction_amount). */
export function planPriceReais(plan: PlanId): number {
  return PLAN_PRICES[plan] / 100;
}

/** Rótulo da assinatura que aparece pro cliente no Mercado Pago. */
export function planReason(plan: PlanId): string {
  return plan === 'annual'
    ? 'ComandaJá — Plano Anual'
    : 'ComandaJá — Plano Mensal';
}

/** Soma meses a uma data (fim de mês trava no último dia do mês). */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  // Mês mais curto (ex.: 31 jan + 1 mês): volta pro último dia.
  if (d.getDate() !== day) d.setDate(0);
  return d;
}

export interface PreapprovalPayloadInput {
  restaurantId: string;
  plan: PlanId;
  payerEmail: string;
  /** URL do webhook (já com ?source_news=webhooks) */
  notificationUrl: string;
  /** URL de retorno após autorizar (NÃO é prova de pagamento) */
  backUrl: string;
  /** Início da recorrência — padrão: agora. */
  startDate?: Date;
}

/**
 * Corpo do POST https://api.mercadopago.com/preapproval.
 * Sem plano associado: tudo vai no /preapproval. O preço vem do
 * `plan` (tabela PLAN_PRICES) — nunca de valor vindo do cliente.
 * Sem `free_trial`: o trial de 3 dias é controlado pelo app.
 */
export function buildPreapprovalPayload(input: PreapprovalPayloadInput): {
  payer_email: string;
  reason: string;
  external_reference: string;
  back_url: string;
  status: 'pending';
  auto_recurring: {
    frequency: number;
    frequency_type: 'months';
    transaction_amount: number;
    currency_id: 'BRL';
    start_date: string;
  };
  notification_url: string;
} {
  const freq = PLAN_FREQUENCY[input.plan];
  return {
    payer_email: input.payerEmail.trim(),
    reason: planReason(input.plan),
    external_reference: input.restaurantId,
    back_url: input.backUrl,
    status: 'pending',
    auto_recurring: {
      frequency: freq.frequency,
      frequency_type: freq.frequency_type,
      transaction_amount: planPriceReais(input.plan),
      currency_id: 'BRL',
      start_date: (input.startDate ?? new Date()).toISOString(),
    },
    notification_url: input.notificationUrl,
  };
}

/** Pré-aprovação devolvida pelo GET /preapproval/{id} (só os campos
 * que a decisão usa — o resto do objeto pode vir junto). */
export interface ConfirmedPreapproval {
  id: string;
  status: string;
  external_reference?: string | null;
  auto_recurring?: {
    frequency?: number;
    frequency_type?: string;
    transaction_amount?: number;
  } | null;
}

/** Pagamento devolvido pelo GET /v1/payments/{id} (só o que importa). */
export interface ConfirmedPayment {
  id: string | number;
  status: string;
  preapproval_id?: string | null;
}

export type SubscriptionDecision =
  | {
      action: 'activate';
      /** novo paid_until (agora + 1 mês / 12 meses) */
      paidUntil: string;
      subscriptionStatus: 'active';
      plan: PlanId;
    }
  | {
      action: 'block';
      subscriptionStatus: 'canceled';
    }
  | {
      action: 'keep';
      /** pagamento recusado/em retentativa: mantém o estado atual —
       * o bloqueio vem da tolerância de 3 dias em accessStatus. */
      reason: 'payment_not_approved';
    }
  | {
      action: 'none';
      /** evento irrelevante ou estado desconhecido: não mexe no banco. */
      reason: 'ignored';
    };

/** Plano pelo valor da parcela (o MP não devolve o nosso plan). */
export function planFromAmount(amountReais: number): PlanId | null {
  if (Math.abs(amountReais - 69.99) < 0.005) return 'monthly';
  if (Math.abs(amountReais - 499.99) < 0.005) return 'annual';
  return null;
}

/** Plano pela frequência da recorrência (1 mês = mensal, 12 = anual). */
export function planFromFrequency(
  frequency: number | undefined,
  frequencyType: string | undefined,
): PlanId | null {
  if (frequencyType !== 'months') return null;
  if (frequency === 1) return 'monthly';
  if (frequency === 12) return 'annual';
  return null;
}

/**
 * Decide o que fazer no banco a partir do que o GET de confirmação
 * devolveu — NUNCA a partir do payload do webhook (que só traz o ID).
 *
 *  - pré-aprovação `authorized` + (sem pagamento no evento, ou
 *    pagamento `approved`) → libera: paid_until = agora + 1/12 meses.
 *  - pré-aprovação `cancelled` → bloqueia (status 'canceled').
 *  - pagamento recusado/cancelado → mantém (a tolerância de 3 dias
 *    decide o bloqueio depois, em accessStatus).
 *  - qualquer outro estado → não mexe (status desconhecido = não
 *    liberado, e nunca liberar por palpite).
 */
export function decideSubscriptionUpdate(input: {
  webhookType: string;
  preapproval: ConfirmedPreapproval | null;
  payment?: ConfirmedPayment | null;
  now?: Date;
}): SubscriptionDecision {
  const now = input.now ?? new Date();
  const pre = input.preapproval;
  const pay = input.payment ?? null;

  if (pre && pre.status === 'cancelled') {
    return { action: 'block', subscriptionStatus: 'canceled' };
  }

  // Pagamento recusado ou cancelado: não libera nem bloqueia na hora —
  // o MP tenta de novo (recycling) e a tolerância cobre esses dias.
  if (pay && (pay.status === 'rejected' || pay.status === 'cancelled')) {
    return { action: 'keep', reason: 'payment_not_approved' };
  }

  if (pre && pre.status === 'authorized') {
    // Evento de pagamento avulso precisa estar aprovado pra liberar.
    if (pay && pay.status !== 'approved') {
      return { action: 'keep', reason: 'payment_not_approved' };
    }
    const amount = pre.auto_recurring?.transaction_amount;
    const plan =
      planFromFrequency(
        pre.auto_recurring?.frequency,
        pre.auto_recurring?.frequency_type,
      ) ??
      (typeof amount === 'number' ? planFromAmount(amount) : null);
    if (!plan) return { action: 'none', reason: 'ignored' };
    const months = plan === 'annual' ? 12 : 1;
    return {
      action: 'activate',
      paidUntil: addMonths(now, months).toISOString(),
      subscriptionStatus: 'active',
      plan,
    };
  }

  return { action: 'none', reason: 'ignored' };
}
