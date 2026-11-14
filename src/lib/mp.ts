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
 *
 * Pix (pagamento único, QR code — 14/11/2026):
 *  - Pagamento único NÃO renova: é outra API da assinatura/preapproval
 *    (POST /v1/payments, payment_method_id "pix"). Cada ciclo pago no
 *    Pix precisa de um QR novo — NUNCA prometer Pix automático.
 *  - PENDÊNCIA DE VALIDAÇÃO: o valor mínimo do Pix NÃO está documentado
 *    na referência da API; o blog oficial diz não haver mínimo pra
 *    receber Pix (a partir de R$ 0,01), então R$ 0,50 deve passar —
 *    mas NÃO está validado com token real. Confirmar com credencial
 *    de teste antes de anunciar como validado.
 *  - Pré-requisito do vendedor (fora do código): chave Pix cadastrada
 *    na conta do Mercado Pago que recebe.
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

/** Soma dias a uma data (usado pelo plano de teste Pix: +1 dia). */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/* ------------------------------------------------------------------ */
/* Pix — pagamento único por QR code (POST /v1/payments)               */
/* ------------------------------------------------------------------ */

/**
 * Flag ÚNICO do plano de teste — pra tirar o teste depois, basta
 * trocar este valor pra false (um lugar só, nada mais muda).
 */
export const SHOW_TEST_PLAN = true;

/** Plano de teste Pix — centralizado aqui (um lugar só). */
export const TEST_PLAN = {
  plan: 'test',
  name: 'Teste',
  priceCents: 50,
  priceLabel: 'R$ 0,50',
  days: 1,
  per: '1 dia',
} as const;

/** Planos pagáveis por Pix. NÃO polui `PlanId` ('monthly' | 'annual',
 * usado na pré-aprovação): o plano de teste é SÓ Pix, nunca vira
 * assinatura — nunca vai pro `plan` guardado no restaurante. */
export type PixPlanId = 'monthly' | 'annual' | 'test';

/** Preços Pix em centavos — O PREÇO VEM DO PLANO, nunca do cliente. */
export const PIX_PRICES: Record<PixPlanId, number> = {
  monthly: 6999,
  annual: 49999,
  test: 50,
};

export function isPixPlanId(v: unknown): v is PixPlanId {
  return v === 'monthly' || v === 'annual' || v === 'test';
}

/** Preço Pix em reais com 2 casas (o que a API espera). */
export function pixPriceReais(plan: PixPlanId): number {
  return PIX_PRICES[plan] / 100;
}

/** Descrição do pagamento Pix que aparece pro cliente no MP. */
export function pixDescription(plan: PixPlanId): string {
  if (plan === 'test') return 'ComandaJá — Teste 1 dia';
  return plan === 'annual'
    ? 'ComandaJá — Pix Anual'
    : 'ComandaJá — Pix Mensal';
}

/** Período liberado por um pagamento Pix aprovado. */
export function pixPeriod(plan: PixPlanId): { days?: number; months?: number } {
  if (plan === 'test') return { days: 1 };
  return plan === 'annual' ? { months: 12 } : { months: 1 };
}

/** CPF só com dígitos (o MP exige 11 dígitos, sem ponto/traço). */
export function onlyDigitsCpf(cpf: string): string {
  return cpf.replace(/\D/g, '');
}

export function isValidCpf(cpf: string): boolean {
  return /^\d{11}$/.test(onlyDigitsCpf(cpf));
}

export interface PixPaymentPayloadInput {
  restaurantId: string;
  plan: PixPlanId;
  payerEmail: string;
  payerCpf: string;
  notificationUrl: string;
}

/**
 * Corpo do POST https://api.mercadopago.com/v1/payments.
 * Sem `date_of_expiration`: vale o padrão do MP (24h). O e-mail +
 * CPF são exigidos pelo guia do MP — enviados sempre. O preço vem
 * do plano (tabela PIX_PRICES), nunca do cliente.
 */
export function buildPixPaymentPayload(input: PixPaymentPayloadInput): {
  transaction_amount: number;
  payment_method_id: 'pix';
  payer: {
    email: string;
    identification: { type: 'CPF'; number: string };
  };
  description: string;
  external_reference: string;
  notification_url: string;
} {
  return {
    transaction_amount: pixPriceReais(input.plan),
    payment_method_id: 'pix',
    payer: {
      email: input.payerEmail.trim(),
      identification: {
        type: 'CPF',
        number: onlyDigitsCpf(input.payerCpf),
      },
    },
    description: pixDescription(input.plan),
    external_reference: `${input.restaurantId}:pix:${input.plan}`,
    notification_url: input.notificationUrl,
  };
}

/** `external_reference` do Pix: `restaurantId:pix:plan`. */
export function parsePixExternalReference(
  ref: string | null | undefined,
): { restaurantId: string; plan: PixPlanId } | null {
  if (typeof ref !== 'string') return null;
  const parts = ref.split(':');
  if (parts.length !== 3 || parts[1] !== 'pix') return null;
  if (!parts[0] || !isPixPlanId(parts[2])) return null;
  return { restaurantId: parts[0], plan: parts[2] };
}

/** Plano Pix pelo valor em reais (o MP devolve o valor pago). */
export function pixPlanFromAmount(amountReais: number): PixPlanId | null {
  const cents = Math.round(amountReais * 100);
  if (cents === PIX_PRICES.test) return 'test';
  if (cents === PIX_PRICES.monthly) return 'monthly';
  if (cents === PIX_PRICES.annual) return 'annual';
  return null;
}

/** Pagamento Pix devolvido pelo GET /v1/payments/{id}. */
export interface ConfirmedPixPayment {
  id: string | number;
  status: string;
  status_detail?: string | null;
  external_reference?: string | null;
  transaction_amount?: number | null;
  payer?: { email?: string | null } | null;
}

export type PixPaymentDecision =
  | {
      action: 'activate';
      /** novo paid_until */
      paidUntil: string;
      plan: PixPlanId;
      restaurantId: string;
    }
  | { action: 'keep'; reason: 'payment_not_approved' }
  | { action: 'none'; reason: 'ignored' };

/**
 * Decide o que fazer no banco a partir do pagamento Pix confirmado
 * por GET — NUNCA a partir do payload do webhook (que só traz o ID).
 *
 *  - `approved` + external_reference `id:pix:plano` + valor batendo
 *    com o plano → libera. paidUntil = max(agora, paid_until atual)
 *    + período (teste +1 dia, mensal +1 mês, anual +12 meses):
 *    pagar ANTES do vencimento não perde dias — o prazo estende a
 *    partir do que já estava pago.
 *  - `rejected` / `cancelled` / `expired` → mantém (não libera nem
 *    bloqueia na hora).
 *  - qualquer outro estado, referência ou valor → não mexe.
 */
export function decidePixPaymentUpdate(input: {
  payment: ConfirmedPixPayment | null;
  now?: Date;
  currentPaidUntil?: string | null;
}): PixPaymentDecision {
  const payment = input.payment;
  if (!payment) return { action: 'none', reason: 'ignored' };
  const status = payment.status;
  if (
    status === 'rejected' ||
    status === 'cancelled' ||
    status === 'expired' ||
    payment.status_detail === 'expired'
  ) {
    return { action: 'keep', reason: 'payment_not_approved' };
  }
  if (status !== 'approved') {
    return { action: 'none', reason: 'ignored' };
  }
  const parsed = parsePixExternalReference(payment.external_reference);
  if (!parsed) return { action: 'none', reason: 'ignored' };
  if (
    typeof payment.transaction_amount !== 'number' ||
    pixPlanFromAmount(payment.transaction_amount) !== parsed.plan
  ) {
    return { action: 'none', reason: 'ignored' };
  }
  const now = input.now ?? new Date();
  let base = now.getTime();
  if (input.currentPaidUntil) {
    const cur = new Date(input.currentPaidUntil).getTime();
    if (Number.isFinite(cur) && cur > base) base = cur;
  }
  const baseDate = new Date(base);
  const period = pixPeriod(parsed.plan);
  const paidUntil =
    period.days !== undefined
      ? addDays(baseDate, period.days)
      : addMonths(baseDate, period.months ?? 1);
  return {
    action: 'activate',
    paidUntil: paidUntil.toISOString(),
    plan: parsed.plan,
    restaurantId: parsed.restaurantId,
  };
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
  status_detail?: string | null;
  preapproval_id?: string | null;
  /** Pix único: `restaurantId:pix:plano` (ausente na assinatura). */
  external_reference?: string | null;
  transaction_amount?: number | null;
  payer?: { email?: string | null } | null;
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
