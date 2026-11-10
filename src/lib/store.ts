import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  ClosedBill,
  Order,
  OrderItem,
  OrderWithItems,
  Product,
  Settings,
  Waiter,
} from './types';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

/** true quando as duas variáveis do Supabase estão configuradas. */
export const isSupabase = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

let supabase: SupabaseClient | null = null;
if (isSupabase) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

/* ------------------------------------------------------------------ */
/* Armazenamento seguro: nunca derruba o app se o navegador bloquear  */
/* o localStorage (foi o que causava a tela preta no celular).         */
/* ------------------------------------------------------------------ */

export function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* armazenamento bloqueado: segue sem persistir */
  }
}

export function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Sessão do garçom logado (só guarda id + nome, nunca a senha). */
export const SESSION_KEY = 'garcom_session_v1';

export function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return 'id-' + Date.now() + '-' + Math.floor(Math.random() * 1e9);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** SHA-256 da senha (WebCrypto quando disponível, hash simples de fallback). */
export async function hashPassword(password: string): Promise<string> {
  try {
    if (typeof window !== 'undefined' && window.crypto?.subtle) {
      const buf = await window.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(password),
      );
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch {
    /* cai no hash simples abaixo */
  }
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < password.length; i++) {
    const ch = password.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16);
}

export const DEFAULT_SETTINGS: Settings = { service_fee_pct: 3, table_count: 12 };

/* ------------------------------------------------------------------ */
/* Modo local (localStorage) — usado quando o Supabase não está        */
/* configurado. Um aparelho só; os dados ficam no navegador.           */
/* ------------------------------------------------------------------ */

interface LocalDb {
  waiters: Waiter[];
  products: Product[];
  settings: Settings;
  orders: Order[];
  items: OrderItem[];
  bills: ClosedBill[];
}

const LOCAL_KEY = 'garcom_db_v1';

function loadLocal(): LocalDb {
  const raw = safeGet(LOCAL_KEY);
  if (raw) {
    try {
      const d = JSON.parse(raw) as Partial<LocalDb>;
      return {
        waiters: d.waiters ?? [],
        products: d.products ?? [],
        settings: d.settings ?? DEFAULT_SETTINGS,
        orders: d.orders ?? [],
        items: d.items ?? [],
        bills: d.bills ?? [],
      };
    } catch {
      /* banco local corrompido: começa do zero */
    }
  }
  return {
    waiters: [],
    products: [],
    settings: { ...DEFAULT_SETTINGS },
    orders: [],
    items: [],
    bills: [],
  };
}

function saveLocal(db: LocalDb): void {
  safeSet(LOCAL_KEY, JSON.stringify(db));
}

/* ------------------------------------------------------------------ */
/* API de dados — mesma assinatura nos dois modos.                      */
/* ------------------------------------------------------------------ */

function sb(): SupabaseClient {
  if (!supabase) throw new Error('Supabase não configurado');
  return supabase;
}

export async function getSettings(): Promise<Settings> {
  if (!isSupabase) return loadLocal().settings;
  const { data, error } = await sb()
    .from('settings')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const { error: insErr } = await sb()
      .from('settings')
      .insert({ id: 1, ...DEFAULT_SETTINGS });
    if (insErr) throw insErr;
    return { ...DEFAULT_SETTINGS };
  }
  return {
    service_fee_pct: data.service_fee_pct,
    table_count: data.table_count,
  };
}

export async function saveSettings(s: Settings): Promise<void> {
  if (!isSupabase) {
    const db = loadLocal();
    db.settings = s;
    saveLocal(db);
    return;
  }
  const { error } = await sb()
    .from('settings')
    .upsert({ id: 1, ...s });
  if (error) throw error;
}

export async function listWaiters(): Promise<Waiter[]> {
  if (!isSupabase) return loadLocal().waiters;
  const { data, error } = await sb()
    .from('waiters')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Waiter[];
}

export async function createWaiter(
  name: string,
  login: string,
  passwordHash: string,
): Promise<Waiter> {
  const waiter: Waiter = {
    id: newId(),
    name,
    login,
    password_hash: passwordHash,
    created_at: nowIso(),
  };
  if (!isSupabase) {
    const db = loadLocal();
    if (db.waiters.some((w) => w.login === login)) {
      throw new Error('Já existe um garçom com esse login.');
    }
    db.waiters.push(waiter);
    saveLocal(db);
    return waiter;
  }
  const { data, error } = await sb()
    .from('waiters')
    .insert({
      id: waiter.id,
      name,
      login,
      password_hash: passwordHash,
    })
    .select()
    .single();
  if (error) throw error;
  return data as Waiter;
}

export async function findWaiterByLogin(login: string): Promise<Waiter | null> {
  if (!isSupabase) {
    return loadLocal().waiters.find((w) => w.login === login) ?? null;
  }
  const { data, error } = await sb()
    .from('waiters')
    .select('*')
    .eq('login', login)
    .maybeSingle();
  if (error) throw error;
  return (data as Waiter | null) ?? null;
}

export async function listProducts(): Promise<Product[]> {
  if (!isSupabase) {
    const p = loadLocal().products;
    return [...p].sort((a, b) =>
      a.category.localeCompare(b.category, 'pt-BR') ||
      a.name.localeCompare(b.name, 'pt-BR'),
    );
  }
  const { data, error } = await sb()
    .from('products')
    .select('*')
    .order('category', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Product[];
}

export async function createProduct(input: {
  name: string;
  price_cents: number;
  category: string;
  prints_in: 'kitchen' | 'bar';
}): Promise<Product> {
  const product: Product = {
    id: newId(),
    name: input.name,
    price_cents: input.price_cents,
    category: input.category,
    prints_in: input.prints_in,
    created_at: nowIso(),
  };
  if (!isSupabase) {
    const db = loadLocal();
    db.products.push(product);
    saveLocal(db);
    return product;
  }
  const { data, error } = await sb()
    .from('products')
    .insert({
      id: product.id,
      name: product.name,
      price_cents: product.price_cents,
      category: product.category,
      prints_in: product.prints_in,
    })
    .select()
    .single();
  if (error) throw error;
  return data as Product;
}

export async function deleteProduct(id: string): Promise<void> {
  if (!isSupabase) {
    const db = loadLocal();
    db.products = db.products.filter((p) => p.id !== id);
    saveLocal(db);
    return;
  }
  const { error } = await sb().from('products').delete().eq('id', id);
  if (error) throw error;
}

export async function listOpenOrders(): Promise<OrderWithItems[]> {
  if (!isSupabase) {
    const db = loadLocal();
    return db.orders
      .filter((o) => o.status === 'open')
      .sort((a, b) => a.table_number - b.table_number)
      .map((order) => ({
        order,
        items: db.items.filter((i) => i.order_id === order.id),
      }));
  }
  const { data: orders, error } = await sb()
    .from('orders')
    .select('*')
    .eq('status', 'open')
    .order('table_number', { ascending: true });
  if (error) throw error;
  const ids = (orders ?? []).map((o) => o.id);
  let items: OrderItem[] = [];
  if (ids.length > 0) {
    const { data: itemsData, error: itemsErr } = await sb()
      .from('order_items')
      .select('*')
      .in('order_id', ids)
      .order('created_at', { ascending: true });
    if (itemsErr) throw itemsErr;
    items = (itemsData ?? []) as OrderItem[];
  }
  return ((orders ?? []) as Order[]).map((order) => ({
    order,
    items: items.filter((i) => i.order_id === order.id),
  }));
}

export async function getOrderWithItems(
  orderId: string,
): Promise<OrderWithItems | null> {
  if (!isSupabase) {
    const db = loadLocal();
    const order = db.orders.find((o) => o.id === orderId);
    if (!order) return null;
    return {
      order,
      items: db.items.filter((i) => i.order_id === orderId),
    };
  }
  const { data: order, error } = await sb()
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .maybeSingle();
  if (error) throw error;
  if (!order) return null;
  const { data: items, error: itemsErr } = await sb()
    .from('order_items')
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: true });
  if (itemsErr) throw itemsErr;
  return { order: order as Order, items: (items ?? []) as OrderItem[] };
}

export async function createOrder(
  tableNumber: number,
  waiter: Waiter,
): Promise<Order> {
  const order: Order = {
    id: newId(),
    table_number: tableNumber,
    waiter_id: waiter.id,
    waiter_name: waiter.name,
    status: 'open',
    created_at: nowIso(),
    closed_at: null,
  };
  if (!isSupabase) {
    const db = loadLocal();
    db.orders.push(order);
    saveLocal(db);
    return order;
  }
  const { data, error } = await sb()
    .from('orders')
    .insert({
      id: order.id,
      table_number: tableNumber,
      waiter_id: waiter.id,
      waiter_name: waiter.name,
      status: 'open',
    })
    .select()
    .single();
  if (error) throw error;
  return data as Order;
}

/** Adiciona 1 unidade do produto ao pedido (soma na linha se já existir uma não enviada). */
export async function addItem(
  orderId: string,
  product: Product,
): Promise<OrderItem> {
  if (!isSupabase) {
    const db = loadLocal();
    const existing = db.items.find(
      (i) => i.order_id === orderId && i.product_id === product.id && !i.sent,
    );
    if (existing) {
      existing.qty += 1;
      saveLocal(db);
      return existing;
    }
    const item: OrderItem = {
      id: newId(),
      order_id: orderId,
      product_id: product.id,
      product_name: product.name,
      price_cents: product.price_cents,
      qty: 1,
      note: '',
      sent: false,
      created_at: nowIso(),
    };
    db.items.push(item);
    saveLocal(db);
    return item;
  }
  const { data: existing } = await sb()
    .from('order_items')
    .select('*')
    .eq('order_id', orderId)
    .eq('product_id', product.id)
    .eq('sent', false)
    .maybeSingle();
  if (existing) {
    const { data, error } = await sb()
      .from('order_items')
      .update({ qty: (existing as OrderItem).qty + 1 })
      .eq('id', (existing as OrderItem).id)
      .select()
      .single();
    if (error) throw error;
    return data as OrderItem;
  }
  const { data, error } = await sb()
    .from('order_items')
    .insert({
      id: newId(),
      order_id: orderId,
      product_id: product.id,
      product_name: product.name,
      price_cents: product.price_cents,
      qty: 1,
      note: '',
      sent: false,
    })
    .select()
    .single();
  if (error) throw error;
  return data as OrderItem;
}

export async function updateItem(
  id: string,
  patch: Partial<Pick<OrderItem, 'qty' | 'note'>>,
): Promise<void> {
  if (!isSupabase) {
    const db = loadLocal();
    const item = db.items.find((i) => i.id === id);
    if (!item) return;
    if (patch.qty !== undefined) item.qty = patch.qty;
    if (patch.note !== undefined) item.note = patch.note;
    saveLocal(db);
    return;
  }
  const { error } = await sb().from('order_items').update(patch).eq('id', id);
  if (error) throw error;
}

export async function removeItem(id: string): Promise<void> {
  if (!isSupabase) {
    const db = loadLocal();
    db.items = db.items.filter((i) => i.id !== id);
    saveLocal(db);
    return;
  }
  const { error } = await sb().from('order_items').delete().eq('id', id);
  if (error) throw error;
}

/** Marca os itens ainda não enviados como enviados (vão p/ cozinha/bar). */
export async function sendOrder(orderId: string): Promise<void> {
  if (!isSupabase) {
    const db = loadLocal();
    db.items.forEach((i) => {
      if (i.order_id === orderId) i.sent = true;
    });
    saveLocal(db);
    return;
  }
  const { error } = await sb()
    .from('order_items')
    .update({ sent: true })
    .eq('order_id', orderId)
    .eq('sent', false);
  if (error) throw error;
}

/**
 * Fecha a mesa: calcula os totais, grava a conta fechada (p/ o financeiro
 * do dono ler depois) e marca o pedido como fechado. Retorna a conta.
 */
export async function closeOrder(
  orderId: string,
  serviceFeePct: number,
): Promise<ClosedBill> {
  const ow = await getOrderWithItems(orderId);
  if (!ow) throw new Error('Pedido não encontrado.');
  const subtotal = ow.items.reduce((s, i) => s + i.price_cents * i.qty, 0);
  const fee = Math.round((subtotal * serviceFeePct) / 100);
  const bill: ClosedBill = {
    id: newId(),
    order_id: orderId,
    table_number: ow.order.table_number,
    waiter_id: ow.order.waiter_id,
    waiter_name: ow.order.waiter_name,
    subtotal_cents: subtotal,
    fee_cents: fee,
    total_cents: subtotal + fee,
    closed_at: nowIso(),
  };
  if (!isSupabase) {
    const db = loadLocal();
    db.bills.push(bill);
    const order = db.orders.find((o) => o.id === orderId);
    if (order) {
      order.status = 'closed';
      order.closed_at = bill.closed_at;
    }
    saveLocal(db);
    return bill;
  }
  const { error: billErr } = await sb().from('closed_bills').insert({
    id: bill.id,
    order_id: bill.order_id,
    table_number: bill.table_number,
    waiter_id: bill.waiter_id,
    waiter_name: bill.waiter_name,
    subtotal_cents: bill.subtotal_cents,
    fee_cents: bill.fee_cents,
    total_cents: bill.total_cents,
    closed_at: bill.closed_at,
  });
  if (billErr) throw billErr;
  const { error: orderErr } = await sb()
    .from('orders')
    .update({ status: 'closed', closed_at: bill.closed_at })
    .eq('id', orderId);
  if (orderErr) throw orderErr;
  return bill;
}

/** Contas fechadas (p/ o futuro sistema financeiro do dono). */
export async function listClosedBills(): Promise<ClosedBill[]> {
  if (!isSupabase) {
    return [...loadLocal().bills].sort((a, b) =>
      b.closed_at.localeCompare(a.closed_at),
    );
  }
  const { data, error } = await sb()
    .from('closed_bills')
    .select('*')
    .order('closed_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ClosedBill[];
}
