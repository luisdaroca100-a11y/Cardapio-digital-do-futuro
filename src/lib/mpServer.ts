/**
 * Auxiliares (server-side) das rotas do Mercado Pago.
 *
 * Nenhuma credencial aqui: MP_ACCESS_TOKEN e MP_WEBHOOK_SECRET vêm
 * das variáveis de ambiente da Vercel (nunca NEXT_PUBLIC_, nunca
 * commitadas). Sem MP_ACCESS_TOKEN, o checkout responde 503 com erro
 * claro — o app nunca quebra por falta de token.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHmac, timingSafeEqual } from 'node:crypto';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

/** Cliente do Supabase (mesmas vars do app; as policies já são
 * abertas — NÃO há service role aqui). null = Supabase não
 * configurado (modo local: o checkout ainda pode criar a
 * pré-aprovação, mas o webhook não tem onde gravar). */
export function mpSupabase(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

/**
 * Origem pública do app, derivada do header `host` da requisição
 * (funciona na Vercel e no dev local). Usada pra montar a
 * notification_url e a back_url do Mercado Pago.
 */
export function requestOrigin(req: Request): string {
  const host = req.headers.get('host') || 'localhost:3000';
  const forwardedProto = req.headers.get('x-forwarded-proto');
  const proto =
    forwardedProto ??
    (host.startsWith('localhost') || host.startsWith('127.0.0.1')
      ? 'http'
      : 'https');
  return `${proto}://${host}`;
}

export const MP_API_BASE = 'https://api.mercadopago.com';

/** Chamada autenticada à API do Mercado Pago. */
export async function mpApi(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${MP_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

/**
 * Valida a assinatura HMAC do webhook (`x-signature: ts=...,v1=...`).
 * Manifesto (documentação do Mercado Pago):
 *   `id:{data.id};request-id:{x-request-id};ts:{ts};`
 * com o `request-id` vazio quando o header não vem — os `;` ficam.
 * Comparação com timingSafeEqual. Sem `MP_WEBHOOK_SECRET`
 * configurado, retorna null (validação desativada — a confirmação
 * por GET à API continua obrigatória antes de mexer no banco).
 */
export function verifyMpSignature(
  req: Request,
  dataId: string,
  secret: string | undefined,
): boolean | null {
  if (!secret) return null;
  const signature = req.headers.get('x-signature');
  const requestId = req.headers.get('x-request-id') ?? '';
  if (!signature) return false;
  const parts = new Map(
    signature.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
    }),
  );
  const ts = parts.get('ts');
  const v1 = parts.get('v1');
  if (!ts || !v1) return false;
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const expected = createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Resposta de erro em pt-BR, no formato que o frontend espera. */
export function mpError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}
