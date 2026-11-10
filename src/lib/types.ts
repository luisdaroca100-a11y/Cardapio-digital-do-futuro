export type PrintsIn = 'kitchen' | 'bar';

export interface Waiter {
  id: string;
  name: string;
  login: string;
  password_hash: string;
  created_at: string;
}

export interface Product {
  id: string;
  name: string;
  /** preço em centavos */
  price_cents: number;
  category: string;
  prints_in: PrintsIn;
  /** O que vem no prato (só comida) — opcional, vai na via da cozinha. */
  description?: string | null;
  created_at: string;
}

export interface Settings {
  /** taxa de serviço em % (padrão 3) */
  service_fee_pct: number;
  /** quantidade de mesas (padrão 12) */
  table_count: number;
}

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  product_name: string;
  /** preço unitário em centavos (foto do preço na hora do pedido) */
  price_cents: number;
  qty: number;
  note: string;
  /** Como servir a bebida (só bar) — ex.: "copo com limão e gelo". */
  serve?: string | null;
  /** false = ainda no resumo; true = já enviado p/ cozinha/bar */
  sent: boolean;
  created_at: string;
}

export interface Order {
  id: string;
  table_number: number;
  waiter_id: string;
  waiter_name: string;
  status: 'open' | 'closed';
  created_at: string;
  closed_at: string | null;
}

/** Conta fechada — guardada p/ o sistema financeiro do dono ler depois. */
export interface ClosedBill {
  id: string;
  order_id: string;
  table_number: number;
  waiter_id: string;
  waiter_name: string;
  subtotal_cents: number;
  fee_cents: number;
  total_cents: number;
  closed_at: string;
}

export interface OrderWithItems {
  order: Order;
  items: OrderItem[];
}
