import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  ClosedBill,
  Order,
  OrderItem,
  OrderWithItems,
  Owner,
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

/** Sessão do dono logado (só guarda id + nome, nunca a senha). */
export const OWNER_SESSION_KEY = 'dono_session_v1';

/** % de comissão padrão dos garçons (exemplo do dono: vendeu R$ 200,
 * 8% = R$ 16 dele, R$ 184 do restaurante). */
export const DEFAULT_COMMISSION_PCT = 8;

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

export const DEFAULT_SETTINGS: Settings = {
  service_fee_pct: 3,
  table_count: 12,
  order_seq: 0,
  default_commission_pct: DEFAULT_COMMISSION_PCT,
  day_closed_date: null,
};

/* ------------------------------------------------------------------ */
/* Finalizar dia — o dia encerrado reabre sozinho às 9h do dia seguinte */
/* ------------------------------------------------------------------ */

/** Hora em que o dia encerrado reabre sozinho (9h da manhã seguinte). */
export const DAY_REOPEN_HOUR = 9;

/** Data local de hoje no formato AAAA-MM-DD. */
export function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * true quando o dia está encerrado agora: o dono finalizou o dia e
 * ainda não chegou 9h da manhã do dia seguinte. Antes das 9h o dia
 * continua fechado; depois das 9h abre sozinho, sem ninguém fazer nada.
 * O fechamento vale só pro dia em que foi feito.
 */
export function isDayClosed(settings: Settings, now: Date = new Date()): boolean {
  const closed = settings.day_closed_date;
  if (!closed) return false;
  const parts = closed.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return false;
  }
  const [y, m, d] = parts;
  const reopen = new Date(y, m - 1, d + 1, DAY_REOPEN_HOUR, 0, 0, 0);
  return now.getTime() < reopen.getTime();
}

/**
 * O dono finaliza o dia: grava a data de hoje. Vale pra todos os
 * aparelhos (fica no banco, não só no celular do dono).
 */
export async function finalizeDay(): Promise<Settings> {
  const settings = await getSettings();
  const next: Settings = {
    ...settings,
    day_closed_date: localDateString(new Date()),
  };
  await saveSettings(next);
  return next;
}

/** O dono reabre o dia (caso tenha finalizado sem querer). */
export async function reopenDay(): Promise<Settings> {
  const settings = await getSettings();
  const next: Settings = { ...settings, day_closed_date: null };
  await saveSettings(next);
  return next;
}

/* ------------------------------------------------------------------ */
/* Modo local (localStorage) — usado quando o Supabase não está        */
/* configurado. Um aparelho só; os dados ficam no navegador.           */
/* ------------------------------------------------------------------ */

interface LocalDb {
  waiters: Waiter[];
  /** dono do restaurante (um só; null até o primeiro acesso do dono) */
  owner: Owner | null;
  products: Product[];
  settings: Settings;
  orders: Order[];
  items: OrderItem[];
  bills: ClosedBill[];
  /** contador do número do pedido (sequencial) */
  order_seq: number;
}

const LOCAL_KEY = 'garcom_db_v1';

function loadLocal(): LocalDb {
  const raw = safeGet(LOCAL_KEY);
  if (raw) {
    try {
      const d = JSON.parse(raw) as Partial<LocalDb>;
      return {
        waiters: (d.waiters ?? []).map((w) => ({
          ...w,
          commission_pct: w.commission_pct ?? DEFAULT_COMMISSION_PCT,
        })),
        owner: d.owner ?? null,
        products: d.products ?? [],
        settings: {
          ...DEFAULT_SETTINGS,
          ...(d.settings ?? {}),
          default_commission_pct:
            d.settings?.default_commission_pct ?? DEFAULT_COMMISSION_PCT,
          day_closed_date: d.settings?.day_closed_date ?? null,
        },
        orders: d.orders ?? [],
        items: d.items ?? [],
        bills: (d.bills ?? []).map((b) => ({
          ...b,
          commission_cents: b.commission_cents ?? 0,
          commission_pct: b.commission_pct ?? 0,
        })),
        order_seq: d.order_seq ?? d.settings?.order_seq ?? 0,
      };
    } catch {
      /* banco local corrompido: começa do zero */
    }
  }
  return {
    waiters: [],
    owner: null,
    products: [],
    settings: { ...DEFAULT_SETTINGS },
    orders: [],
    items: [],
    bills: [],
    order_seq: 0,
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
  if (!isSupabase) {
    const db = loadLocal();
    return { ...db.settings, order_seq: db.order_seq ?? 0 };
  }
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
    order_seq: data.order_seq ?? 0,
    default_commission_pct:
      data.default_commission_pct ?? DEFAULT_COMMISSION_PCT,
    day_closed_date: data.day_closed_date ?? null,
  };
}

/**
 * Próximo número do pedido ("Pedido Nº 0001", sequencial, persistente).
 * Modo local: contador no banco local. Supabase: incremento atômico via
 * função SQL next_order_number(); se o supabase.sql antigo ainda não
 * tiver a função, cai no leitura-e-gravação da linha de settings.
 */
export async function nextOrderNumber(): Promise<number> {
  if (!isSupabase) {
    const db = loadLocal();
    const n = (db.order_seq ?? 0) + 1;
    db.order_seq = n;
    saveLocal(db);
    return n;
  }
  const { data, error } = await sb().rpc('next_order_number');
  if (!error && typeof data === 'number') return data;
  const s = await getSettings();
  const n = (s.order_seq ?? 0) + 1;
  const { error: upErr } = await sb()
    .from('settings')
    .upsert({ id: 1, order_seq: n });
  if (upErr) throw upErr;
  return n;
}

export async function saveSettings(s: Settings): Promise<void> {
  // Mescla com o que já existe para não perder campos que a tela
  // não editou (ex.: order_seq, default_commission_pct).
  const merged: Settings = { ...(await getSettings()), ...s };
  if (!isSupabase) {
    const db = loadLocal();
    db.settings = merged;
    saveLocal(db);
    return;
  }
  const { error } = await sb()
    .from('settings')
    .upsert({ id: 1, ...merged });
  if (error) throw error;
}

/* ------------------------------------------------------------------ */
/* Dono (um só) — login próprio de administrador do financeiro.       */
/* ------------------------------------------------------------------ */

export async function getOwner(): Promise<Owner | null> {
  if (!isSupabase) return loadLocal().owner;
  const { data, error } = await sb()
    .from('owners')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as Owner | null) ?? null;
}

export async function createOwner(
  name: string,
  login: string,
  passwordHash: string,
): Promise<Owner> {
  const owner: Owner = {
    id: newId(),
    name,
    login,
    password_hash: passwordHash,
    created_at: nowIso(),
  };
  if (!isSupabase) {
    const db = loadLocal();
    if (db.owner) throw new Error('Já existe um dono cadastrado.');
    db.owner = owner;
    saveLocal(db);
    return owner;
  }
  const existing = await getOwner();
  if (existing) throw new Error('Já existe um dono cadastrado.');
  const { data, error } = await sb()
    .from('owners')
    .insert({
      id: owner.id,
      name: owner.name,
      login: owner.login,
      password_hash: owner.password_hash,
    })
    .select()
    .single();
  if (error) throw error;
  return data as Owner;
}

export async function findOwnerByLogin(login: string): Promise<Owner | null> {
  if (!isSupabase) {
    const owner = loadLocal().owner;
    return owner && owner.login === login ? owner : null;
  }
  const { data, error } = await sb()
    .from('owners')
    .select('*')
    .eq('login', login)
    .maybeSingle();
  if (error) throw error;
  return (data as Owner | null) ?? null;
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
  commissionPct?: number,
): Promise<Waiter> {
  const pct =
    commissionPct ?? (await getSettings()).default_commission_pct ??
    DEFAULT_COMMISSION_PCT;
  const waiter: Waiter = {
    id: newId(),
    name,
    login,
    password_hash: passwordHash,
    commission_pct: pct,
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
      commission_pct: pct,
    })
    .select()
    .single();
  if (error) throw error;
  return data as Waiter;
}

export async function getWaiterById(id: string): Promise<Waiter | null> {
  if (!isSupabase) {
    return loadLocal().waiters.find((w) => w.id === id) ?? null;
  }
  const { data, error } = await sb()
    .from('waiters')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as Waiter | null) ?? null;
}

/** O dono edita nome, % de comissão e (opcional) a senha do garçom. */
export async function updateWaiter(
  id: string,
  patch: Partial<Pick<Waiter, 'name' | 'commission_pct' | 'password_hash'>>,
): Promise<void> {
  if (!isSupabase) {
    const db = loadLocal();
    const w = db.waiters.find((x) => x.id === id);
    if (!w) return;
    if (patch.name !== undefined) w.name = patch.name;
    if (patch.commission_pct !== undefined)
      w.commission_pct = patch.commission_pct;
    if (patch.password_hash !== undefined)
      w.password_hash = patch.password_hash;
    saveLocal(db);
    return;
  }
  const { error } = await sb().from('waiters').update(patch).eq('id', id);
  if (error) throw error;
}

/**
 * O dono remove um garçom. Não deixa remover quem já tem pedido ou
 * conta fechada (o financeiro precisa do histórico dele).
 */
export async function deleteWaiter(id: string): Promise<void> {
  const open = await listOpenOrders();
  if (open.some((ow) => ow.order.waiter_id === id)) {
    throw new Error(
      'Esse garçom tem mesa aberta. Feche as mesas dele antes de remover.',
    );
  }
  const bills = await listClosedBills();
  if (bills.some((b) => b.waiter_id === id)) {
    throw new Error(
      'Esse garçom já tem vendas registradas. Não dá pra remover (o financeiro precisa do histórico).',
    );
  }
  if (!isSupabase) {
    const db = loadLocal();
    db.waiters = db.waiters.filter((w) => w.id !== id);
    saveLocal(db);
    return;
  }
  const { error } = await sb().from('waiters').delete().eq('id', id);
  if (error) throw error;
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
  drink_type?: string;
  description?: string;
}): Promise<Product> {
  const product: Product = {
    id: newId(),
    name: input.name,
    price_cents: input.price_cents,
    category: input.category,
    prints_in: input.prints_in,
    drink_type: (input.drink_type as Product['drink_type']) ?? undefined,
    description: input.description ?? undefined,
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
      drink_type: product.drink_type ?? null,
      description: product.description ?? null,
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

/** O dono edita um produto do cardápio (nome, preço, categoria, onde
 * imprime, tipo de bebida e o que vem no prato). */
export async function updateProduct(
  id: string,
  patch: Partial<
    Pick<
      Product,
      'name' | 'price_cents' | 'category' | 'prints_in' | 'drink_type' | 'description'
    >
  >,
): Promise<void> {
  if (!isSupabase) {
    const db = loadLocal();
    const p = db.products.find((x) => x.id === id);
    if (!p) return;
    Object.assign(p, patch);
    saveLocal(db);
    return;
  }
  const { error } = await sb().from('products').update(patch).eq('id', id);
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

/** Adiciona 1 unidade do produto ao pedido (soma na linha se já existir uma não enviada com o mesmo modo de servir). */
export async function addItem(
  orderId: string,
  product: Product,
  opts?: { serve?: string },
): Promise<OrderItem> {
  const serve = opts?.serve ?? null;
  if (!isSupabase) {
    const db = loadLocal();
    const existing = db.items.find(
      (i) =>
        i.order_id === orderId &&
        i.product_id === product.id &&
        !i.sent &&
        (i.serve ?? null) === serve,
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
      serve: serve ?? undefined,
      sent: false,
      created_at: nowIso(),
    };
    db.items.push(item);
    saveLocal(db);
    return item;
  }
  const { data: lines } = await sb()
    .from('order_items')
    .select('*')
    .eq('order_id', orderId)
    .eq('product_id', product.id)
    .eq('sent', false);
  const existing = (lines ?? []).find(
    (i) => ((i as OrderItem).serve ?? null) === serve,
  ) as OrderItem | undefined;
  if (existing) {
    const { data, error } = await sb()
      .from('order_items')
      .update({ qty: existing.qty + 1 })
      .eq('id', existing.id)
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
      serve,
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

/**
 * Remove pedidos abertos sem nenhum item (restos da regra antiga, que
 * travava a mesa só de abrir). Uma mesa sem pedido volta a ficar livre.
 * Retorna quantos pedidos foram removidos.
 */
export async function cleanupEmptyOrders(): Promise<number> {
  if (!isSupabase) {
    const db = loadLocal();
    const emptyIds = new Set(
      db.orders
        .filter((o) => o.status === 'open')
        .filter((o) => !db.items.some((i) => i.order_id === o.id))
        .map((o) => o.id),
    );
    if (emptyIds.size === 0) return 0;
    db.orders = db.orders.filter((o) => !emptyIds.has(o.id));
    saveLocal(db);
    return emptyIds.size;
  }
  const open = await listOpenOrders();
  const empty = open.filter((ow) => ow.items.length === 0);
  if (empty.length === 0) return 0;
  const { error } = await sb()
    .from('orders')
    .delete()
    .in(
      'id',
      empty.map((ow) => ow.order.id),
    );
  if (error) throw error;
  return empty.length;
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
 * Fecha a mesa: calcula os totais, a comissão do garçom (com a % dele
 * NAQUELE MOMENTO — fica gravada na conta; se a % mudar depois, as
 * contas antigas não mudam), grava a conta fechada (p/ o financeiro
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
  const total = subtotal + fee;
  // Comissão sobre o TOTAL da conta, com a % do garçom agora.
  const waiter = await getWaiterById(ow.order.waiter_id);
  const commissionPct =
    waiter?.commission_pct ??
    (await getSettings()).default_commission_pct ??
    DEFAULT_COMMISSION_PCT;
  const commission = Math.round((total * commissionPct) / 100);
  const bill: ClosedBill = {
    id: newId(),
    order_id: orderId,
    table_number: ow.order.table_number,
    waiter_id: ow.order.waiter_id,
    waiter_name: ow.order.waiter_name,
    subtotal_cents: subtotal,
    fee_cents: fee,
    total_cents: total,
    commission_cents: commission,
    commission_pct: commissionPct,
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
    commission_cents: bill.commission_cents,
    commission_pct: bill.commission_pct,
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

/** Contas fechadas (p/ o financeiro do dono). */
export async function listClosedBills(): Promise<ClosedBill[]> {
  if (!isSupabase) {
    return [...loadLocal().bills]
      .map((b) => ({
        ...b,
        commission_cents: b.commission_cents ?? 0,
        commission_pct: b.commission_pct ?? 0,
      }))
      .sort((a, b) => b.closed_at.localeCompare(a.closed_at));
  }
  const { data, error } = await sb()
    .from('closed_bills')
    .select('*')
    .order('closed_at', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as ClosedBill[]).map((b) => ({
    ...b,
    commission_cents: b.commission_cents ?? 0,
    commission_pct: b.commission_pct ?? 0,
  }));
}
