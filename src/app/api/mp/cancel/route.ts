/**
 * POST /api/mp/cancel — cancela a assinatura (pré-aprovação) no
 * Mercado Pago e marca `canceled` no banco.
 *
 * Corpo: { restaurantId }
 *  - sem MP_ACCESS_TOKEN: 503 com erro claro em pt-BR.
 *  - sem pré-aprovação guardada: só marca `canceled` no banco
 *    (não há o que cancelar no MP).
 *  - trocar de plano (mensal ↔ anual) usa este cancelamento + um
 *    checkout novo: não há endpoint de troca de periodicidade.
 */
import { NextResponse } from 'next/server';
import { mpApi, mpError, mpSupabase } from '@/lib/mpServer';

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
  if (!restaurantId) {
    return mpError(400, 'Restaurante não identificado.');
  }

  const token = process.env.MP_ACCESS_TOKEN || '';
  if (!token) {
    return mpError(
      503,
      'O pagamento ainda não está configurado — fale com o Luis para cancelar a assinatura.',
    );
  }

  const sb = mpSupabase();
  let preapprovalId: string | null = null;
  if (sb) {
    const { data: restaurant, error } = await sb
      .from('restaurants')
      .select('id, mp_preapproval_id')
      .eq('id', restaurantId)
      .maybeSingle();
    if (error) {
      return mpError(500, 'Não foi possível conferir o restaurante. Tente de novo.');
    }
    if (!restaurant) {
      return mpError(404, 'Restaurante não encontrado.');
    }
    preapprovalId =
      typeof (restaurant as Record<string, unknown>).mp_preapproval_id ===
      'string'
        ? ((restaurant as Record<string, unknown>).mp_preapproval_id as string)
        : null;
  }

  if (preapprovalId) {
    let mpRes: Response;
    try {
      mpRes = await mpApi(`/preapproval/${preapprovalId}`, token, {
        method: 'PUT',
        body: JSON.stringify({ status: 'canceled' }),
      });
    } catch {
      return mpError(
        502,
        'Não foi possível falar com o Mercado Pago. Tente de novo em alguns minutos.',
      );
    }
    if (!mpRes.ok) {
      return mpError(
        502,
        'O Mercado Pago não aceitou o cancelamento. Tente de novo.',
      );
    }
  }

  if (sb) {
    await sb
      .from('restaurants')
      .update({ subscription_status: 'canceled' })
      .eq('id', restaurantId);
  }

  return NextResponse.json({ canceled: true });
}
