export type PrintsIn = 'kitchen' | 'bar';

/** Tipo da bebida (só quando prints_in = 'bar') — define as opções
 * de "Como servir": refrigerante → 4 quadradinhos de copo; cerveja →
 * "Precisa de copos?" (+ quantidade); torre → "Quantas canecas?";
 * outro → sem opções (vai direto pro pedido). */
export type DrinkType = 'refrigerante' | 'cerveja' | 'torre' | 'outro';

export interface Waiter {
  id: string;
  name: string;
  login: string;
  password_hash: string;
  /** % de comissão do garçom sobre o total da conta (padrão 8) */
  commission_pct?: number;
  created_at: string;
}

/** Dono do restaurante — um só; login próprio de administrador. */
export interface Owner {
  id: string;
  name: string;
  /** usuário que só o dono sabe */
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
  /** Tipo da bebida (só bar) — sem ele, bebida se comporta como refrigerante. */
  drink_type?: DrinkType | null;
  /** O que vem no prato (só comida) — opcional, vai na via da cozinha. */
  description?: string | null;
  created_at: string;
}

export interface Settings {
  /** taxa de serviço em % (padrão 3) */
  service_fee_pct: number;
  /** quantidade de mesas (padrão 12) */
  table_count: number;
  /** próximo número do pedido — sequencial, "Pedido Nº 0001" */
  order_seq?: number;
  /** % de comissão padrão dos garçons (padrão 8) — vale pros novos */
  default_commission_pct?: number;
  /** data (AAAA-MM-DD) em que o dono finalizou o dia; null = dia aberto.
   * O dia reabre sozinho às 9h da manhã do dia seguinte. */
  day_closed_date?: string | null;
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
  /** comissão do garçom em centavos — congelada na hora do fechamento
   * (se a % mudar depois, a conta antiga não muda) */
  commission_cents?: number;
  /** % de comissão usada no fechamento (foto da % naquele momento) */
  commission_pct?: number;
  closed_at: string;
}

export interface OrderWithItems {
  order: Order;
  items: OrderItem[];
}
