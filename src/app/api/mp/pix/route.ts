/**
 * /api/mp/pix — pagamento único por Pix (QR code) no Mercado Pago.
 *
 * POST: cria o pagamento (POST /v1/payments, payment_method_id
 * "pix") e devolve o QR code (imagem base64) + o código copia-e-cola
 * + o id do pagamento. O preço vem do plano (tabela PIX_PRICES em
 * src/lib/mp.ts), nunca do cliente. Pagamento único NÃO renova.
 * GET ?paymentId=: consulta o status (GET /v1/payments/{id}) — é o
 * que a tela usa no polling e no botão "Já paguei, verificar".
 *
 * Corpo POST: { restaurantId, plan, payerEmail, payerCpf }
 *  - plano: 'monthly' | 'annual' | 'test' (teste = 1 dia, R$ 0,50)
 *  - CPF com 11 dígitos (só dígitos): o guia do MP exige e-mail +
 *    documento pra criar o pagamento Pix.
 *  - sem MP_ACCESS_TOKEN: 503 com erro claro em pt-BR (o pagamento
 *    ainda não está configurado — o app NÃO quebra).
 *  - o destrave real só acontece via webhook no Supabase (ou pelo
 *    polling da tela, que recarrega o restaurante quando confirma).
 */
import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import {
  buildPixPaymentPayload,
  isPixPlanId,
  isValidCpf,
  onlyDigitsCpf,
  type PixPlanId,
} from '@/lib/mp';
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
  const payerCpf =
    typeof b.payerCpf === 'string' ? b.payerCpf.trim() : '';

  if (!restaurantId) {
    return mpError(400, 'Restaurante não identificado.');
  }
  if (!isPixPlanId(plan)) {
    return mpError(400, 'Plano inválido. Escolha Mensal, Anual ou Teste.');
  }
  if (!EMAIL_RE.test(payerEmail)) {
    return mpError(400, 'Informe um e-mail válido para o pagamento Pix.');
  }
  if (!isValidCpf(payerCpf)) {
    return mpError(
      400,
      'Informe um CPF válido com 11 dígitos para pagar com Pix.',
    );
  }

  const token = process.env.MP_ACCESS_TOKEN || '';
  if (!token) {
    return mpError(
      503,
      'O pagamento ainda não está configurado — fale com o Luis para ativar o Pix.',
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
  const payload = buildPixPaymentPayload({
    restaurantId,
    plan: plan as PixPlanId,
    payerEmail,
    payerCpf: onlyDigitsCpf(payerCpf),
    notificationUrl: `${origin}/api/mp/webhook?source_news=webhooks`,
  });

  let mpRes: Response;
  try {
    mpRes = await mpApi('/v1/payments', token, {
      method: 'POST',
      headers: { 'X-Idempotency-Key': randomUUID() },
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
  const poi = (mpData.point_of_interaction ?? {}) as Record<string, unknown>;
  const tx = (poi.transaction_data ?? {}) as Record<string, unknown>;
  const qrCode = typeof tx.qr_code === 'string' ? tx.qr_code : '';
  const qrCodeBase64 =
    typeof tx.qr_code_base64 === 'string' ? tx.qr_code_base64 : '';
  if (!mpRes.ok || !qrCode) {
    return mpError(
      502,
      'O Mercado Pago não gerou o QR code do Pix. Confira o e-mail e o CPF e tente de novo.',
    );
  }

  return NextResponse.json({
    qr_code: qrCode,
    qr_code_base64: qrCodeBase64,
    payment_id: typeof mpData.id === 'number' || typeof mpData.id === 'string'
      ? String(mpData.id)
      : null,
    expires_at:
      typeof mpData.date_of_expiration === 'string'
        ? mpData.date_of_expiration
        : null,
  });
}

export async function GET(req: Request) {
  const paymentId = new URL(req.url).searchParams.get('paymentId') ?? '';
  if (!paymentId.trim()) {
    return mpError(400, 'Pagamento não identificado.');
  }
  const token = process.env.MP_ACCESS_TOKEN || '';
  if (!token) {
    return mpError(
      503,
      'O pagamento ainda não está configurado — fale com o Luis para ativar o Pix.',
    );
  }
  let mpRes: Response;
  try {
    mpRes = await mpApi(
      `/v1/payments/${encodeURIComponent(paymentId.trim())}`,
      token,
    );
  } catch {
    return mpError(
      502,
      'Não foi possível falar com o Mercado Pago. Tente de novo em alguns minutos.',
    );
  }
  if (!mpRes.ok) {
    return mpError(
      502,
      'Não foi possível conferir o pagamento. Tente de novo.',
    );
  }
  const mpData = (await mpRes.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return NextResponse.json({
    status: typeof mpData.status === 'string' ? mpData.status : 'unknown',
    status_detail:
      typeof mpData.status_detail === 'string' ? mpData.status_detail : null,
  });
}
