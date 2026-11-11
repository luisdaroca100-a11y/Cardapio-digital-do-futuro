export type PrintsIn = 'kitchen' | 'bar';

/** Plano da plataforma escolhido no cadastro. Os dois planos começam
 * com 3 dias grátis; sem plano escolhido o restaurante fica no
 * período grátis até o dono escolher o plano. */
export type PlanId = 'monthly' | 'annual';

/** Restaurante da plataforma multi-restaurante. Cada restaurante tem
 * seu dono, seus garçons, seu cardápio, seus pedidos e suas vendas —
 * ninguém vê dados de outro restaurante. */
export interface Restaurant {
  id: string;
  name: string;
  /** plano escolhido no cadastro ('monthly' | 'annual'); ausente =
   * restaurante cadastrado antes dos planos, ou cadastro sem plano
   * escolhido — fica no período grátis de 3 dias. */
  plan?: PlanId | null;
  created_at: string;
}

/** Administrador da plataforma (o Luis) — vê TODOS os restaurantes.
 * É SEPARADO dos donos de restaurante: não é dono, não é garçom,
 * não aparece em nenhum restaurante. Um só. */
export interface PlatformAdmin {
  id: string;
  /** login que só ele sabe — único na plataforma toda */
  login: string;
  password_hash: string;
  created_at: string;
}

/** Tipo da bebida (só quando prints_in = 'bar') — define as opções
 * de "Como servir": refrigerante → 4 quadradinhos de copo; cerveja →
 * "Precisa de copos?" (+ quantidade); torre → "Quantas canecas?";
 * outro → sem opções (vai direto pro pedido). */
export type DrinkType = 'refrigerante' | 'cerveja' | 'torre' | 'outro';

export interface Waiter {
  id: string;
  /** restaurante a que o garçom pertence */
  restaurant_id?: string;
  name: string;
  /** login ÚNICO na plataforma toda (não só no restaurante) */
  login: string;
  password_hash: string;
  /** % de comissão do garçom sobre o total da conta (padrão 8) */
  commission_pct?: number;
  created_at: string;
}

/** Dono do restaurante — um por restaurante; login próprio de administrador. */
export interface Owner {
  id: string;
  /** restaurante que o dono administra */
  restaurant_id?: string;
  name: string;
  /** usuário que só o dono sabe — ÚNICO na plataforma toda */
  login: string;
  password_hash: string;
  created_at: string;
}

export interface Product {
  id: string;
  /** restaurante dono do cardápio */
  restaurant_id?: string;
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
  /** restaurante dono destas configurações (uma linha por restaurante) */
  restaurant_id?: string;
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
  /** restaurante do pedido (herdado do pedido) */
  restaurant_id?: string;
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
  /** restaurante da mesa/pedido */
  restaurant_id?: string;
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
  /** restaurante da venda */
  restaurant_id?: string;
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
