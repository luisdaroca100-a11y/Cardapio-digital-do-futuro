import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  ClosedBill,
  Order,
  OrderItem,
  OrderWithItems,
  Owner,
  PlatformAdmin,
  PlanId,
  Product,
  Restaurant,
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

/** Sessão do administrador da plataforma (só guarda id + login). */
export const PLATFORM_ADMIN_SESSION_KEY = 'platform_admin_session_v1';

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
/* Restaurante ativo — todo dado lido ou gravado é filtrado por ele.  */
/* A sessão (garçom ou dono) define o restaurante; sem restaurante    */
/* ativo, as leituras voltam vazias e as escritas são rejeitadas.     */
/* ------------------------------------------------------------------ */

export const ACTIVE_RESTAURANT_KEY = 'restaurant_active_v1';

let activeRestaurantId: string | null = null;

/** id do restaurante da sessão atual (null = ninguém logado). */
export function getActiveRestaurantId(): string | null {
  if (activeRestaurantId) return activeRestaurantId;
  const saved = safeGet(ACTIVE_RESTAURANT_KEY);
  if (saved) {
    activeRestaurantId = saved;
    return saved;
  }
  return null;
}

/** Troca o restaurante ativo (no login e no cadastro); null = sair. */
export function setActiveRestaurant(id: string | null): void {
  activeRestaurantId = id;
  if (id) safeSet(ACTIVE_RESTAURANT_KEY, id);
  else safeRemove(ACTIVE_RESTAURANT_KEY);
}

function requireRestaurantId(): string {
  const id = getActiveRestaurantId();
  if (!id) {
    throw new Error('Nenhum restaurante selecionado. Entre com o seu acesso.');
  }
  return id;
}

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
  restaurants: Restaurant[];
  /** donos — um por restaurante */
  owners: Owner[];
  waiters: Waiter[];
  products: Product[];
  /** configurações POR restaurante (antes era uma única linha) */
  settingsByRestaurant: Record<string, Settings>;
  orders: Order[];
  items: OrderItem[];
  bills: ClosedBill[];
  /** administrador da plataforma — um só, separado dos donos */
  platformAdmins: PlatformAdmin[];
}

const LOCAL_KEY = 'garcom_db_v1';

function emptyLocalDb(): LocalDb {
  return {
    restaurants: [],
    owners: [],
    waiters: [],
    products: [],
    settingsByRestaurant: {},
    orders: [],
    items: [],
    bills: [],
    platformAdmins: [],
  };
}

function loadLocal(): LocalDb {
  const raw = safeGet(LOCAL_KEY);
  if (!raw) return emptyLocalDb();
  try {
    const d = JSON.parse(raw) as Partial<LocalDb> & {
      /** formato antigo: um único dono */
      owner?: Owner | null;
      /** formato antigo: uma única configuração */
      settings?: Settings;
      /** formato antigo: contador do pedido fora das configurações */
      order_seq?: number;
    };
    const db: LocalDb = {
      restaurants: d.restaurants ?? [],
      owners: d.owners ?? [],
      waiters: (d.waiters ?? []).map((w) => ({
        ...w,
        commission_pct: w.commission_pct ?? DEFAULT_COMMISSION_PCT,
      })),
      products: d.products ?? [],
      settingsByRestaurant: d.settingsByRestaurant ?? {},
      orders: d.orders ?? [],
      items: d.items ?? [],
      bills: (d.bills ?? []).map((b) => ({
        ...b,
        commission_cents: b.commission_cents ?? 0,
        commission_pct: b.commission_pct ?? 0,
      })),
      platformAdmins: d.platformAdmins ?? [],
    };
    // Migração de bancos locais antigos (de antes do multi-restaurante):
    // tudo que existia pertencia ao Gosto Caseiro — nada se perde, só
    // ganha o restaurante. Roda uma única vez, na primeira leitura.
    if (db.restaurants.length === 0) {
      const legacyOwner = d.owner ?? null;
      const legacySettings = d.settings;
      const hasLegacyData =
        legacyOwner !== null ||
        db.waiters.length > 0 ||
        db.products.length > 0 ||
        db.orders.length > 0 ||
        db.items.length > 0 ||
        db.bills.length > 0 ||
        (legacySettings !== undefined &&
          (legacySettings.service_fee_pct !== DEFAULT_SETTINGS.service_fee_pct ||
            legacySettings.table_count !== DEFAULT_SETTINGS.table_count ||
            (legacySettings.default_commission_pct ?? DEFAULT_COMMISSION_PCT) !==
              DEFAULT_COMMISSION_PCT ||
            (legacySettings.day_closed_date ?? null) !== null ||
            (d.order_seq ?? 0) > 0));
      if (hasLegacyData) {
        const gc: Restaurant = {
          id: newId(),
          name: 'Gosto Caseiro',
          created_at: nowIso(),
        };
        db.restaurants = [gc];
        if (legacyOwner) {
          db.owners = [{ ...legacyOwner, restaurant_id: gc.id }];
        }
        db.waiters.forEach((w) => {
          w.restaurant_id = gc.id;
        });
        db.products.forEach((p) => {
          p.restaurant_id = gc.id;
        });
        db.orders.forEach((o) => {
          o.restaurant_id = gc.id;
        });
        db.items.forEach((i) => {
          i.restaurant_id = gc.id;
        });
        db.bills.forEach((b) => {
          b.restaurant_id = gc.id;
        });
        db.settingsByRestaurant = {
          [gc.id]: {
            ...DEFAULT_SETTINGS,
            ...(legacySettings ?? {}),
            restaurant_id: gc.id,
            order_seq: d.order_seq ?? legacySettings?.order_seq ?? 0,
          },
        };
        setActiveRestaurant(gc.id);
        saveLocal(db);
      }
    }
    return db;
  } catch {
    /* banco local corrompido: começa do zero */
    return emptyLocalDb();
  }
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

/* ------------------------------------------------------------------ */
/* Restaurantes e cadastro (self-service)                              */
/* ------------------------------------------------------------------ */

export async function listRestaurants(): Promise<Restaurant[]> {
  if (!isSupabase) {
    return [...loadLocal().restaurants].sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    );
  }
  const { data, error } = await sb()
    .from('restaurants')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Restaurant[];
}

export async function getRestaurant(id: string): Promise<Restaurant | null> {
  if (!isSupabase) {
    return loadLocal().restaurants.find((r) => r.id === id) ?? null;
  }
  const { data, error } = await sb()
    .from('restaurants')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as Restaurant | null) ?? null;
}

export async function getActiveRestaurant(): Promise<Restaurant | null> {
  const id = getActiveRestaurantId();
  if (!id) return null;
  return getRestaurant(id);
}

/**
 * Resumo por restaurante para a área do administrador da plataforma:
 * nome do restaurante, nome do dono, data do cadastro e número de
 * garçons. NENHUM dado financeiro — o administrador não vê vendas,
 * valores nem comissões (o financeiro é só do dono de cada restaurante).
 */
export interface RestaurantSummary {
  restaurant: Restaurant;
  ownerName: string;
  waiterCount: number;
}

export async function listRestaurantSummaries(): Promise<RestaurantSummary[]> {
  const restaurants = await listRestaurants();
  if (!isSupabase) {
    const db = loadLocal();
    return restaurants.map((r) => ({
      restaurant: r,
      ownerName:
        db.owners.find((o) => o.restaurant_id === r.id)?.name ?? '—',
      waiterCount: db.waiters.filter((w) => w.restaurant_id === r.id).length,
    }));
  }
  const [{ data: owners }, { data: waiters }] = await Promise.all([
    sb().from('owners').select('restaurant_id, name'),
    sb().from('waiters').select('restaurant_id'),
  ]);
  const ownerByRestaurant = new Map<string, string>();
  for (const o of (owners ?? []) as { restaurant_id: string; name: string }[]) {
    if (o.restaurant_id) ownerByRestaurant.set(o.restaurant_id, o.name);
  }
  const waitersByRestaurant = new Map<string, number>();
  for (const w of (waiters ?? []) as { restaurant_id: string }[]) {
    if (!w.restaurant_id) continue;
    waitersByRestaurant.set(
      w.restaurant_id,
      (waitersByRestaurant.get(w.restaurant_id) ?? 0) + 1,
    );
  }
  return restaurants.map((r) => ({
    restaurant: r,
    ownerName: ownerByRestaurant.get(r.id) ?? '—',
    waiterCount: waitersByRestaurant.get(r.id) ?? 0,
  }));
}

/**
 * true quando o login já é usado por alguém na plataforma toda
 * (dono, garçom ou administrador) — o login é único na plataforma.
 */
export async function isLoginTaken(login: string): Promise<boolean> {
  const [owner, waiter, admin] = await Promise.all([
    findOwnerByLogin(login),
    findWaiterByLogin(login),
    findPlatformAdminByLogin(login),
  ]);
  return Boolean(owner || waiter || admin);
}

/**
 * Duração do período grátis dos dois planos, em dias, contada a
 * partir da data de cadastro do restaurante.
 */
export const TRIAL_DAYS = 3;

/** Rótulo do plano pro painel do administrador. */
export function planLabel(plan?: PlanId | null): string {
  if (plan === 'monthly') return 'Mensal — R$ 69,99/mês';
  if (plan === 'annual') return 'Anual — R$ 499,99/ano';
  return 'Sem plano escolhido';
}

/** Fim do período grátis, contado da data de cadastro do restaurante. */
export function trialEndDate(createdAt: string): Date {
  const start = new Date(createdAt).getTime();
  return new Date(start + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Status do período grátis de um restaurante: em trial (com os dias
 * restantes, arredondados pra cima) ou encerrado (com a data de
 * término). Restaurante sem plano fica no período grátis do mesmo
 * jeito — o prazo conta da data de cadastro dele. `now` injetável
 * pros testes.
 */
export function trialStatus(
  createdAt: string,
  now: Date = new Date(),
): { inTrial: boolean; daysLeft: number; end: Date } {
  const end = trialEndDate(createdAt);
  const diffMs = end.getTime() - now.getTime();
  const daysLeft = Math.max(0, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
  return { inTrial: diffMs > 0, daysLeft, end };
}

/**
 * Cadastro sozinho (self-service): o dono informa o nome do
 * restaurante, o nome dele, o login e a senha; cria o restaurante +
 * o dono e já deixa o restaurante ativo. Por enquanto o acesso é
 * liberado no cadastro, sem pagamento dentro do sistema.
 */
export async function registerRestaurant(input: {
  restaurantName: string;
  ownerName: string;
  login: string;
  passwordHash: string;
  /** plano escolhido no cartão da apresentação; ausente = cadastro
   * genérico (botão do cabeçalho/hero/rodapé) — fica no período
   * grátis, sem plano definido. */
  plan?: PlanId | null;
}): Promise<{ restaurant: Restaurant; owner: Owner }> {
  const login = input.login.trim();
  if (await isLoginTaken(login)) {
    throw new Error(
      'Já existe um acesso com esse login na plataforma. Escolha outro login.',
    );
  }
  const restaurant: Restaurant = {
    id: newId(),
    name: input.restaurantName.trim(),
    plan: input.plan ?? null,
    created_at: nowIso(),
  };
  const owner: Owner = {
    id: newId(),
    restaurant_id: restaurant.id,
    name: input.ownerName.trim(),
    login,
    password_hash: input.passwordHash,
    created_at: nowIso(),
  };
  if (!isSupabase) {
    const db = loadLocal();
    db.restaurants.push(restaurant);
    db.owners.push(owner);
    db.settingsByRestaurant[restaurant.id] = {
      ...DEFAULT_SETTINGS,
      restaurant_id: restaurant.id,
    };
    saveLocal(db);
    setActiveRestaurant(restaurant.id);
    return { restaurant, owner };
  }
  const { error: rErr } = await sb().from('restaurants').insert({
    id: restaurant.id,
    name: restaurant.name,
    plan: restaurant.plan ?? null,
  });
  if (rErr) throw rErr;
  const { data, error } = await sb()
    .from('owners')
    .insert({
      id: owner.id,
      restaurant_id: restaurant.id,
      name: owner.name,
      login: owner.login,
      password_hash: owner.password_hash,
    })
    .select()
    .single();
  if (error) throw error;
  setActiveRestaurant(restaurant.id);
  return { restaurant, owner: data as Owner };
}

/* ------------------------------------------------------------------ */
/* Administrador da plataforma (só o Luis) — separado dos donos.      */
/* ------------------------------------------------------------------ */

export async function getPlatformAdmin(): Promise<PlatformAdmin | null> {
  if (!isSupabase) return loadLocal().platformAdmins[0] ?? null;
  const { data, error } = await sb()
    .from('platform_admins')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as PlatformAdmin | null) ?? null;
}

/**
 * Primeiro acesso do administrador: cria o login dele (um só).
 * Não é dono nem garçom — não entra em nenhum restaurante.
 */
export async function createPlatformAdmin(
  login: string,
  passwordHash: string,
): Promise<PlatformAdmin> {
  const cleanLogin = login.trim();
  if (await isLoginTaken(cleanLogin)) {
    throw new Error(
      'Já existe um acesso com esse login na plataforma. Escolha outro login.',
    );
  }
  const admin: PlatformAdmin = {
    id: newId(),
    login: cleanLogin,
    password_hash: passwordHash,
    created_at: nowIso(),
  };
  if (!isSupabase) {
    const db = loadLocal();
    if (db.platformAdmins.length > 0) {
      throw new Error('Já existe um administrador da plataforma.');
    }
    db.platformAdmins.push(admin);
    saveLocal(db);
    return admin;
  }
  const existing = await getPlatformAdmin();
  if (existing) {
    throw new Error('Já existe um administrador da plataforma.');
  }
  const { data, error } = await sb()
    .from('platform_admins')
    .insert({
      id: admin.id,
      login: admin.login,
      password_hash: admin.password_hash,
    })
    .select()
    .single();
  if (error) throw error;
  return data as PlatformAdmin;
}

export async function findPlatformAdminByLogin(
  login: string,
): Promise<PlatformAdmin | null> {
  if (!isSupabase) {
    return loadLocal().platformAdmins.find((a) => a.login === login) ?? null;
  }
  const { data, error } = await sb()
    .from('platform_admins')
    .select('*')
    .eq('login', login)
    .maybeSingle();
  if (error) throw error;
  return (data as PlatformAdmin | null) ?? null;
}

/* ------------------------------------------------------------------ */
/* Configurações — uma linha POR restaurante.                          */
/* ------------------------------------------------------------------ */

export async function getSettings(): Promise<Settings> {
  if (!isSupabase) {
    const id = getActiveRestaurantId();
    if (!id) return { ...DEFAULT_SETTINGS };
    const db = loadLocal();
    return {
      ...DEFAULT_SETTINGS,
      ...(db.settingsByRestaurant[id] ?? {}),
      restaurant_id: id,
    };
  }
  const rid = requireRestaurantId();
  const { data, error } = await sb()
    .from('settings')
    .select('*')
    .eq('restaurant_id', rid)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const { error: insErr } = await sb()
      .from('settings')
      .insert({ restaurant_id: rid, ...DEFAULT_SETTINGS });
    if (insErr) throw insErr;
    return { ...DEFAULT_SETTINGS, restaurant_id: rid };
  }
  return {
    service_fee_pct: data.service_fee_pct,
    table_count: data.table_count,
    order_seq: data.order_seq ?? 0,
    default_commission_pct:
      data.default_commission_pct ?? DEFAULT_COMMISSION_PCT,
    day_closed_date: data.day_closed_date ?? null,
    restaurant_id: rid,
  };
}

/**
 * Próximo número do pedido ("Pedido Nº 0001", sequencial, persistente)
 * — POR restaurante: cada restaurante tem o seu próprio sequencial.
 * Modo local: contador nas configurações do restaurante. Supabase:
 * incremento atômico via função SQL next_order_number(restaurant_id);
 * se o supabase.sql antigo ainda não tiver a função, cai no
 * leitura-e-gravação da linha de settings do restaurante.
 */
export async function nextOrderNumber(): Promise<number> {
  if (!isSupabase) {
    const db = loadLocal();
    const id = getActiveRestaurantId();
    if (!id) {
      throw new Error('Nenhum restaurante selecionado.');
    }
    const s: Settings = {
      ...DEFAULT_SETTINGS,
      ...(db.settingsByRestaurant[id] ?? {}),
      restaurant_id: id,
    };
    const n = (s.order_seq ?? 0) + 1;
    db.settingsByRestaurant[id] = { ...s, order_seq: n };
    saveLocal(db);
    return n;
  }
  const rid = requireRestaurantId();
  const { data, error } = await sb().rpc('next_order_number', {
    p_restaurant_id: rid,
  });
  if (!error && typeof data === 'number') return data;
  const s = await getSettings();
  const n = (s.order_seq ?? 0) + 1;
  const { error: upErr } = await sb()
    .from('settings')
    .upsert({ restaurant_id: rid, order_seq: n }, { onConflict: 'restaurant_id' });
  if (upErr) throw upErr;
  return n;
}

export async function saveSettings(s: Settings): Promise<void> {
  // Mescla com o que já existe para não perder campos que a tela
  // não editou (ex.: order_seq, default_commission_pct).
  const merged: Settings = { ...(await getSettings()), ...s };
  if (!isSupabase) {
    const id = getActiveRestaurantId();
    if (!id) {
      throw new Error('Nenhum restaurante selecionado.');
    }
    const db = loadLocal();
    db.settingsByRestaurant[id] = { ...merged, restaurant_id: id };
    saveLocal(db);
    return;
  }
  const rid = requireRestaurantId();
  const { error } = await sb()
    .from('settings')
    .upsert({ restaurant_id: rid, ...merged }, { onConflict: 'restaurant_id' });
  if (error) throw error;
}

/* ------------------------------------------------------------------ */
/* Dono — um por restaurante; login próprio de administrador.          */
/* ------------------------------------------------------------------ */

export async function getOwner(): Promise<Owner | null> {
  if (!isSupabase) {
    const id = getActiveRestaurantId();
    if (!id) return null;
    return loadLocal().owners.find((o) => o.restaurant_id === id) ?? null;
  }
  const rid = requireRestaurantId();
  const { data, error } = await sb()
    .from('owners')
    .select('*')
    .eq('restaurant_id', rid)
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
  const cleanLogin = login.trim();
  if (await isLoginTaken(cleanLogin)) {
    throw new Error(
      'Já existe um acesso com esse login na plataforma. Escolha outro login.',
    );
  }
  const rid = requireRestaurantId();
  const owner: Owner = {
    id: newId(),
    restaurant_id: rid,
    name: name.trim(),
    login: cleanLogin,
    password_hash: passwordHash,
    created_at: nowIso(),
  };
  if (!isSupabase) {
    const db = loadLocal();
    if (db.owners.some((o) => o.restaurant_id === rid)) {
      throw new Error('Já existe um dono cadastrado.');
    }
    db.owners.push(owner);
    saveLocal(db);
    return owner;
  }
  const existing = await getOwner();
  if (existing) throw new Error('Já existe um dono cadastrado.');
  const { data, error } = await sb()
    .from('owners')
    .insert({
      id: owner.id,
      restaurant_id: owner.restaurant_id,
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
    return loadLocal().owners.find((o) => o.login === login) ?? null;
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
  if (!isSupabase) {
    const id = getActiveRestaurantId();
    if (!id) return [];
    return loadLocal().waiters.filter((w) => w.restaurant_id === id);
  }
  const rid = requireRestaurantId();
  const { data, error } = await sb()
    .from('waiters')
    .select('*')
    .eq('restaurant_id', rid)
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
  const cleanLogin = login.trim();
  if (await isLoginTaken(cleanLogin)) {
    throw new Error(
      'Já existe um acesso com esse login na plataforma. Escolha outro login.',
    );
  }
  const rid = requireRestaurantId();
  const pct =
    commissionPct ?? (await getSettings()).default_commission_pct ??
    DEFAULT_COMMISSION_PCT;
  const waiter: Waiter = {
    id: newId(),
    restaurant_id: rid,
    name: name.trim(),
    login: cleanLogin,
    password_hash: passwordHash,
    commission_pct: pct,
    created_at: nowIso(),
  };
  if (!isSupabase) {
    const db = loadLocal();
    db.waiters.push(waiter);
    saveLocal(db);
    return waiter;
  }
  const { data, error } = await sb()
    .from('waiters')
    .insert({
      id: waiter.id,
      restaurant_id: waiter.restaurant_id,
      name,
      login: cleanLogin,
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
    const rid = getActiveRestaurantId();
    return (
      loadLocal().waiters.find(
        (w) => w.id === id && (!rid || w.restaurant_id === rid),
      ) ?? null
    );
  }
  const rid = requireRestaurantId();
  const { data, error } = await sb()
    .from('waiters')
    .select('*')
    .eq('id', id)
    .eq('restaurant_id', rid)
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
    const rid = getActiveRestaurantId();
    const w = db.waiters.find(
      (x) => x.id === id && (!rid || x.restaurant_id === rid),
    );
    if (!w) return;
    if (patch.name !== undefined) w.name = patch.name;
    if (patch.commission_pct !== undefined)
      w.commission_pct = patch.commission_pct;
    if (patch.password_hash !== undefined)
      w.password_hash = patch.password_hash;
    saveLocal(db);
    return;
  }
  const rid = requireRestaurantId();
  const { error } = await sb()
    .from('waiters')
    .update(patch)
    .eq('id', id)
    .eq('restaurant_id', rid);
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
    const rid = getActiveRestaurantId();
    db.waiters = db.waiters.filter(
      (w) => !(w.id === id && (!rid || w.restaurant_id === rid)),
    );
    saveLocal(db);
    return;
  }
  const rid = requireRestaurantId();
  const { error } = await sb()
    .from('waiters')
    .delete()
    .eq('id', id)
    .eq('restaurant_id', rid);
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

/** Login do formulário principal: procura o login entre garçons e
 * donos (o login é único na plataforma toda) e confere a senha.
 * Devolve quem é e o papel dele; null = login inexistente ou senha
 * errada. Garçom entra nas mesas; dono entra na área dele. */
export type Principal =
  | { kind: 'waiter'; user: Waiter }
  | { kind: 'owner'; user: Owner };

export async function authenticate(
  login: string,
  password: string,
): Promise<Principal | null> {
  const clean = login.trim();
  const waiter = await findWaiterByLogin(clean);
  if (waiter) {
    const hash = await hashPassword(password);
    return hash === waiter.password_hash
      ? { kind: 'waiter', user: waiter }
      : null;
  }
  const owner = await findOwnerByLogin(clean);
  if (!owner) return null;
  const hash = await hashPassword(password);
  return hash === owner.password_hash ? { kind: 'owner', user: owner } : null;
}

/** Endereço que o QR Code dos garçons codifica: abre o sistema direto
 * na tela de login do garçom (só login e senha), pelo parâmetro
 * ?acesso=garcom — igual ao artefato; ?tela=garcom também é aceito
 * (links antigos continuam funcionando). */
export function waiterLoginUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/?acesso=garcom`;
}

export async function listProducts(): Promise<Product[]> {
  if (!isSupabase) {
    const id = getActiveRestaurantId();
    if (!id) return [];
    const p = loadLocal().products.filter((x) => x.restaurant_id === id);
    return [...p].sort((a, b) =>
      a.category.localeCompare(b.category, 'pt-BR') ||
      a.name.localeCompare(b.name, 'pt-BR'),
    );
  }
  const rid = requireRestaurantId();
  const { data, error } = await sb()
    .from('products')
    .select('*')
    .eq('restaurant_id', rid)
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
  const rid = requireRestaurantId();
  const product: Product = {
    id: newId(),
    restaurant_id: rid,
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
      restaurant_id: rid,
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
    const rid = getActiveRestaurantId();
    db.products = db.products.filter(
      (p) => !(p.id === id && (!rid || p.restaurant_id === rid)),
    );
    saveLocal(db);
    return;
  }
  const rid = requireRestaurantId();
  const { error } = await sb()
    .from('products')
    .delete()
    .eq('id', id)
    .eq('restaurant_id', rid);
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
    const rid = getActiveRestaurantId();
    const p = db.products.find(
      (x) => x.id === id && (!rid || x.restaurant_id === rid),
    );
    if (!p) return;
    Object.assign(p, patch);
    saveLocal(db);
    return;
  }
  const rid = requireRestaurantId();
  const { error } = await sb()
    .from('products')
    .update(patch)
    .eq('id', id)
    .eq('restaurant_id', rid);
  if (error) throw error;
}

export async function listOpenOrders(): Promise<OrderWithItems[]> {
  if (!isSupabase) {
    const db = loadLocal();
    const id = getActiveRestaurantId();
    if (!id) return [];
    return db.orders
      .filter((o) => o.status === 'open' && o.restaurant_id === id)
      .sort((a, b) => a.table_number - b.table_number)
      .map((order) => ({
        order,
        items: db.items.filter((i) => i.order_id === order.id),
      }));
  }
  const rid = requireRestaurantId();
  const { data: orders, error } = await sb()
    .from('orders')
    .select('*')
    .eq('status', 'open')
    .eq('restaurant_id', rid)
    .order('table_number', { ascending: true });
  if (error) throw error;
  const ids = (orders ?? []).map((o) => o.id);
  let items: OrderItem[] = [];
  if (ids.length > 0) {
    const { data: itemsData, error: itemsErr } = await sb()
      .from('order_items')
      .select('*')
      .in('order_id', ids)
      .eq('restaurant_id', rid)
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
    const rid = getActiveRestaurantId();
    const order = db.orders.find(
      (o) => o.id === orderId && (!rid || o.restaurant_id === rid),
    );
    if (!order) return null;
    return {
      order,
      items: db.items.filter((i) => i.order_id === orderId),
    };
  }
  const rid = requireRestaurantId();
  const { data: order, error } = await sb()
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .eq('restaurant_id', rid)
    .maybeSingle();
  if (error) throw error;
  if (!order) return null;
  const { data: items, error: itemsErr } = await sb()
    .from('order_items')
    .select('*')
    .eq('order_id', orderId)
    .eq('restaurant_id', rid)
    .order('created_at', { ascending: true });
  if (itemsErr) throw itemsErr;
  return { order: order as Order, items: (items ?? []) as OrderItem[] };
}

export async function createOrder(
  tableNumber: number,
  waiter: Waiter,
): Promise<Order> {
  const rid = requireRestaurantId();
  const order: Order = {
    id: newId(),
    restaurant_id: rid,
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
      restaurant_id: rid,
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
  const rid = requireRestaurantId();
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
      restaurant_id: rid,
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
    .eq('restaurant_id', rid)
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
      restaurant_id: rid,
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
    const rid = getActiveRestaurantId();
    const item = db.items.find(
      (i) => i.id === id && (!rid || !i.restaurant_id || i.restaurant_id === rid),
    );
    if (!item) return;
    if (patch.qty !== undefined) item.qty = patch.qty;
    if (patch.note !== undefined) item.note = patch.note;
    saveLocal(db);
    return;
  }
  const rid = requireRestaurantId();
  const { error } = await sb()
    .from('order_items')
    .update(patch)
    .eq('id', id)
    .eq('restaurant_id', rid);
  if (error) throw error;
}

export async function removeItem(id: string): Promise<void> {
  if (!isSupabase) {
    const db = loadLocal();
    const rid = getActiveRestaurantId();
    db.items = db.items.filter(
      (i) => !(i.id === id && (!rid || !i.restaurant_id || i.restaurant_id === rid)),
    );
    saveLocal(db);
    return;
  }
  const rid = requireRestaurantId();
  const { error } = await sb()
    .from('order_items')
    .delete()
    .eq('id', id)
    .eq('restaurant_id', rid);
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
    const rid = getActiveRestaurantId();
    const emptyIds = new Set(
      db.orders
        .filter((o) => o.status === 'open')
        .filter((o) => !rid || o.restaurant_id === rid)
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
  const rid = requireRestaurantId();
  const { error } = await sb()
    .from('order_items')
    .update({ sent: true })
    .eq('order_id', orderId)
    .eq('restaurant_id', rid)
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
  const rid = requireRestaurantId();
  const bill: ClosedBill = {
    id: newId(),
    order_id: orderId,
    restaurant_id: rid,
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
    restaurant_id: rid,
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
    .eq('id', orderId)
    .eq('restaurant_id', rid);
  if (orderErr) throw orderErr;
  return bill;
}

/** Contas fechadas (p/ o financeiro do dono). */
export async function listClosedBills(): Promise<ClosedBill[]> {
  if (!isSupabase) {
    const id = getActiveRestaurantId();
    if (!id) return [];
    return [...loadLocal().bills]
      .filter((b) => b.restaurant_id === id)
      .map((b) => ({
        ...b,
        commission_cents: b.commission_cents ?? 0,
        commission_pct: b.commission_pct ?? 0,
      }))
      .sort((a, b) => b.closed_at.localeCompare(a.closed_at));
  }
  const rid = requireRestaurantId();
  const { data, error } = await sb()
    .from('closed_bills')
    .select('*')
    .eq('restaurant_id', rid)
    .order('closed_at', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as ClosedBill[]).map((b) => ({
    ...b,
    commission_cents: b.commission_cents ?? 0,
    commission_pct: b.commission_pct ?? 0,
  }));
}
