'use client';

import { Component, useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import * as store from '@/lib/store';
import {
  OWNER_SESSION_KEY,
  SESSION_KEY,
  isSupabase,
  safeGet,
  safeRemove,
  safeSet,
} from '@/lib/store';
import type {
  ClosedBill,
  DrinkType,
  OrderItem,
  OrderWithItems,
  Owner,
  Product,
  Settings,
  Waiter,
} from '@/lib/types';

type View =
  | 'setup'
  | 'login'
  | 'tables'
  | 'order'
  | 'serve'
  | 'summary'
  | 'settings'
  | 'closed'
  | 'review'
  | 'menu'
  | 'owner'
  | 'owner-waiters'
  | 'owner-menu'
  | 'owner-settings';

function brl(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

function parsePriceToCents(raw: string): number | null {
  const cleaned = raw.trim().replace(/[^\d.,]/g, '').replace(',', '.');
  if (!cleaned) return null;
  const v = Number(cleaned);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.round(v * 100);
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

interface Session {
  id: string;
  name: string;
  login: string;
}

interface TicketData {
  kind: 'send' | 'close';
  tableNumber: number;
  kitchen: OrderItem[];
  bar: OrderItem[];
  bill: ClosedBill | null;
  /** número sequencial do documento ("Pedido Nº 0001") — envio e conta */
  orderNumber?: number;
  /** hora do envio (send) ou do fechamento (close) */
  sentAt?: string;
  /** nome do garçom que fez o pedido — vias da cozinha, do bar e do balcão */
  waiterName?: string;
}

/**
 * Rede de segurança: se qualquer erro inesperado acontecer, mostra uma
 * tela de recuperação com botão "Voltar ao início" em vez de tela preta.
 */
class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="app">
          <div className="content">
            <div className="card">
              <h2>Algo deu errado</h2>
              <p className="hint">
                O sistema encontrou um erro inesperado. Seus dados não foram
                apagados.
              </p>
              <button
                className="btn btn-purple"
                onClick={() => window.location.reload()}
              >
                Voltar ao início
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Nome do restaurante no cabeçalho das vias da cozinha e do bar. */
const RESTAURANT_NAME = 'Gosto Caseiro';

/** Opções de como servir a bebida (escolha única, só pro bar). */
const SERVE_OPTIONS = [
  'copo com limão e gelo',
  'copo com só limão',
  'copo com gelo',
  'só copo',
];

/** Categoria especial: mostra todos os produtos. */
const ALL_PRODUCTS = '__todos__';

function GarcomApp() {
  const [view, setView] = useState<View>('login');
  const [booting, setBooting] = useState(true);
  const [settings, setSettings] = useState<Settings>({
    service_fee_pct: 3,
    table_count: 12,
  });
  const [products, setProducts] = useState<Product[]>([]);
  const [openOrders, setOpenOrders] = useState<OrderWithItems[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [currentOrder, setCurrentOrder] = useState<OrderWithItems | null>(null);
  const [serveProduct, setServeProduct] = useState<Product | null>(null);
  /** cerveja: null = ainda não perguntou se precisa de copos; true = sim, pede a quantidade */
  const [beerCups, setBeerCups] = useState<boolean | null>(null);
  /** quantidade (copos p/ cerveja, canecas p/ torre) */
  const [serveQty, setServeQty] = useState(1);
  const [orderCategory, setOrderCategory] = useState<string | null>(null);
  const [orderSearch, setOrderSearch] = useState('');
  /** busca por número na tela de mesas ("Digite o nº da mesa/comanda...") */
  const [tableSearch, setTableSearch] = useState('');
  /** menu hambúrguer da tela de mesas (Revisão / Sair) */
  const [menuOpen, setMenuOpen] = useState(false);
  /** contas fechadas p/ a tela de Revisão */
  const [closedBills, setClosedBills] = useState<ClosedBill[]>([]);
  const [tickets, setTickets] = useState<TicketData | null>(null);
  const [closedReview, setClosedReview] = useState<{
    bill: ClosedBill;
    items: OrderItem[];
    tableNumber: number;
  } | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  /* ------------------------------ DONO ------------------------------ */
  /** sessão do dono (área financeira — separada da sessão do garçom) */
  const [ownerSession, setOwnerSession] = useState<Session | null>(null);
  /** tela de acesso do dono: login ou criação (null = login do garçom) */
  const [ownerAuth, setOwnerAuth] = useState<'login' | 'setup' | null>(null);
  const [hasOwner, setHasOwner] = useState(false);
  const [waiters, setWaiters] = useState<Waiter[]>([]);
  /** contas fechadas p/ o financeiro do dono */
  const [ownerBills, setOwnerBills] = useState<ClosedBill[]>([]);

  const refreshOwner = useCallback(async () => {
    const [w, b, s, p] = await Promise.all([
      store.listWaiters(),
      store.listClosedBills(),
      store.getSettings(),
      store.listProducts(),
    ]);
    setWaiters(w);
    setOwnerBills(b);
    setSettings(s);
    setProducts(p);
  }, []);

  const refresh = useCallback(async () => {
    const [s, p, o] = await Promise.all([
      store.getSettings(),
      store.listProducts(),
      store.listOpenOrders(),
    ]);
    setSettings(s);
    setProducts(p);
    setOpenOrders(o);
  }, []);

  const refreshCurrentOrder = useCallback(async (orderId: string) => {
    const ow = await store.getOrderWithItems(orderId);
    setCurrentOrder(ow);
    const o = await store.listOpenOrders();
    setOpenOrders(o);
    return ow;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [waiters, owner] = await Promise.all([
          store.listWaiters(),
          store.getOwner(),
          refresh(),
        ]);
        setHasOwner(!!owner);
        // Mesas abertas sem nenhum item (restos da regra antiga) voltam
        // a ficar livres.
        await store.cleanupEmptyOrders();
        await refresh();
        if (waiters.length === 0) {
          setView('setup');
          return;
        }
        // Sessão do dono (área financeira) tem prioridade sobre a do garçom.
        const rawOwner = safeGet(OWNER_SESSION_KEY);
        if (rawOwner && owner) {
          try {
            const s = JSON.parse(rawOwner) as Session;
            if (s.id === owner.id) {
              setOwnerSession({
                id: owner.id,
                name: owner.name,
                login: owner.login,
              });
              await refreshOwner();
              setView('owner');
              return;
            }
          } catch {
            /* sessão inválida: vai pro login */
          }
        }
        const raw = safeGet(SESSION_KEY);
        if (raw) {
          try {
            const s = JSON.parse(raw) as Session;
            const found = waiters.find((w) => w.id === s.id);
            if (found) {
              setSession({ id: found.id, name: found.name, login: found.login });
              setView('tables');
              return;
            }
          } catch {
            /* sessão inválida: vai pro login */
          }
        }
        setView('login');
      } catch (e) {
        setError(
          e instanceof Error ? e.message : 'Não foi possível carregar o sistema.',
        );
        setView('login');
      } finally {
        setBooting(false);
      }
    })();
  }, [refresh, refreshOwner]);

  async function handleLogin(login: string, password: string) {
    setError('');
    setBusy(true);
    try {
      const waiter = await store.findWaiterByLogin(login.trim());
      if (!waiter) throw new Error('Login ou senha incorretos.');
      const hash = await store.hashPassword(password);
      if (hash !== waiter.password_hash) {
        throw new Error('Login ou senha incorretos.');
      }
      const s: Session = { id: waiter.id, name: waiter.name, login: waiter.login };
      setSession(s);
      safeSet(SESSION_KEY, JSON.stringify(s));
      await refresh();
      setView('tables');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível entrar.');
    } finally {
      setBusy(false);
    }
  }

  function handleLogout() {
    setSession(null);
    setCurrentOrder(null);
    setServeProduct(null);
    setMenuOpen(false);
    safeRemove(SESSION_KEY);
    setView('login');
  }

  /* ------------------------------ DONO: ACESSO ------------------------------ */

  async function handleOwnerLogin(login: string, password: string) {
    setError('');
    setBusy(true);
    try {
      const owner = await store.findOwnerByLogin(login.trim());
      if (!owner) throw new Error('Login ou senha incorretos.');
      const hash = await store.hashPassword(password);
      if (hash !== owner.password_hash) {
        throw new Error('Login ou senha incorretos.');
      }
      const s: Session = { id: owner.id, name: owner.name, login: owner.login };
      setOwnerSession(s);
      safeSet(OWNER_SESSION_KEY, JSON.stringify(s));
      setOwnerAuth(null);
      await refreshOwner();
      setView('owner');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível entrar.');
    } finally {
      setBusy(false);
    }
  }

  /** Primeiro acesso do dono: cria o usuário dele (só ele sabe). */
  async function handleOwnerCreate(
    name: string,
    login: string,
    password: string,
  ) {
    setError('');
    setBusy(true);
    try {
      const hash = await store.hashPassword(password);
      const owner: Owner = await store.createOwner(
        name.trim(),
        login.trim(),
        hash,
      );
      const s: Session = { id: owner.id, name: owner.name, login: owner.login };
      setOwnerSession(s);
      setHasOwner(true);
      safeSet(OWNER_SESSION_KEY, JSON.stringify(s));
      setOwnerAuth(null);
      await refreshOwner();
      setView('owner');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível criar o acesso.');
    } finally {
      setBusy(false);
    }
  }

  function handleOwnerLogout() {
    setOwnerSession(null);
    setOwnerAuth(null);
    safeRemove(OWNER_SESSION_KEY);
    setView('login');
  }

  /** Abre a Revisão: lista das mesas fechadas (menu hambúrguer). */
  async function openReview() {
    setMenuOpen(false);
    setError('');
    setBusy(true);
    try {
      const bills = await store.listClosedBills();
      setClosedBills(bills);
      setView('review');
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Não foi possível abrir a revisão.',
      );
    } finally {
      setBusy(false);
    }
  }

  /** Abre o detalhe de uma conta fechada (a partir da Revisão). */
  async function openClosedBill(bill: ClosedBill) {
    setError('');
    setBusy(true);
    try {
      const ow = await store.getOrderWithItems(bill.order_id);
      setClosedReview({
        bill,
        items: ow ? ow.items : [],
        tableNumber: bill.table_number,
      });
      setView('closed');
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Não foi possível abrir a conta.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function openTable(tableNumber: number) {
    if (!session) return;
    setError('');
    setMenuOpen(false);
    const existing = openOrders.find(
      (o) => o.order.table_number === tableNumber,
    );
    if (existing) {
      if (
        existing.items.length === 0 &&
        existing.order.waiter_id !== session.id
      ) {
        // Pedido vazio de outro garçom não trava a mesa (regra da trava):
        // descarta o resto e abre como mesa livre.
        await store.cleanupEmptyOrders();
        await refresh();
      } else if (existing.order.waiter_id !== session.id) {
        setError(
          `A Mesa ${tableNumber} foi aberta por ${existing.order.waiter_name}. Só ele pode abrir.`,
        );
        return;
      } else {
        setCurrentOrder(existing);
        setOrderCategory(null);
        setOrderSearch('');
        setView(existing.items.length === 0 ? 'order' : 'summary');
        return;
      }
    }
    // Rascunho só em memória: a mesa só trava quando o primeiro item for
    // adicionado. Sair sem pedir não grava nada — a mesa continua livre.
    // (id vazio = rascunho ainda não persistido; ver addProduct.)
    setCurrentOrder({
      order: {
        id: '',
        table_number: tableNumber,
        waiter_id: session.id,
        waiter_name: session.name,
        status: 'open',
        created_at: new Date().toISOString(),
        closed_at: null,
      },
      items: [],
    });
    setOrderCategory(null);
    setOrderSearch('');
    setView('order');
  }

  /** Volta às mesas descartando o rascunho (mesa aberta sem nenhum item). */
  function backToTablesFromOrder() {
    if (currentOrder && currentOrder.order.id === '') setCurrentOrder(null);
    setMenuOpen(false);
    setView('tables');
  }

  /** Tocar num produto: bebida abre a escolha de como servir (conforme
   * o tipo dela); comida e "outro sem opções" vão direto. */
  function onProductTap(product: Product) {
    if (
      product.prints_in === 'bar' &&
      (product.drink_type ?? 'refrigerante') !== 'outro'
    ) {
      setServeProduct(product);
      setBeerCups(null);
      setServeQty(1);
      setView('serve');
      return;
    }
    void addProduct(product);
  }

  /** Escolheu como servir (refrigerante): o item entra no pedido com a opção e vai pro resumo. */
  async function chooseServe(option: string) {
    const product = serveProduct;
    setServeProduct(null);
    setBeerCups(null);
    if (!product) return;
    await addProduct(product, option);
  }

  /** Cerveja — "Precisa de copos?": Não → entra sem copos; Sim → pede a quantidade. */
  async function chooseBeerCups(needsCups: boolean) {
    const product = serveProduct;
    if (!product) return;
    if (!needsCups) {
      setServeProduct(null);
      setBeerCups(null);
      await addProduct(product, 'sem copos');
      return;
    }
    setBeerCups(true);
  }

  /** Cerveja (com copos) ou torre: confirma a quantidade e adiciona. */
  async function confirmServeQty() {
    const product = serveProduct;
    if (!product) return;
    const drinkType = product.drink_type ?? 'refrigerante';
    const unit = drinkType === 'torre' ? 'caneca' : 'copo';
    const label =
      serveQty === 1 ? `1 ${unit}` : `${serveQty} ${unit}s`;
    setServeProduct(null);
    setBeerCups(null);
    await addProduct(product, label);
  }

  async function addProduct(product: Product, serve?: string) {
    if (!currentOrder || !session) return;
    setBusy(true);
    try {
      let orderId = currentOrder.order.id;
      if (!orderId) {
        // Primeiro item do rascunho: grava o pedido e trava a mesa.
        // Confere antes se outro garçom não travou a mesa nesse meio-tempo.
        const open = await store.listOpenOrders();
        const taken = open.find(
          (o) => o.order.table_number === currentOrder.order.table_number,
        );
        if (taken) {
          if (taken.order.waiter_id !== session.id) {
            setError(
              `A Mesa ${currentOrder.order.table_number} foi aberta por ${taken.order.waiter_name}. Só ele pode abrir.`,
            );
            setCurrentOrder(null);
            setOpenOrders(open);
            setView('tables');
            return;
          }
          orderId = taken.order.id;
        } else {
          const waiter: Waiter = {
            id: session.id,
            name: session.name,
            login: session.login,
            password_hash: '',
            created_at: '',
          };
          const order = await store.createOrder(
            currentOrder.order.table_number,
            waiter,
          );
          orderId = order.id;
        }
      }
      await store.addItem(orderId, product, serve ? { serve } : undefined);
      const ow = await refreshCurrentOrder(orderId);
      if (ow) setView('summary');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível adicionar.');
    } finally {
      setBusy(false);
    }
  }

  async function changeQty(item: OrderItem, delta: number) {
    const next = item.qty + delta;
    if (next <= 0) {
      await store.removeItem(item.id);
    } else {
      await store.updateItem(item.id, { qty: next });
    }
    if (currentOrder) await refreshCurrentOrder(currentOrder.order.id);
  }

  async function saveNote(item: OrderItem, note: string) {
    if (note === item.note) return;
    await store.updateItem(item.id, { note });
    if (currentOrder) await refreshCurrentOrder(currentOrder.order.id);
  }

  function splitTickets(items: OrderItem[]): {
    kitchen: OrderItem[];
    bar: OrderItem[];
  } {
    const byId = new Map(products.map((p) => [p.id, p]));
    const kitchen: OrderItem[] = [];
    const bar: OrderItem[] = [];
    for (const item of items) {
      const product = byId.get(item.product_id);
      if (product?.prints_in === 'bar') bar.push(item);
      else kitchen.push(item);
    }
    return { kitchen, bar };
  }

  async function sendOrder() {
    if (!currentOrder) return;
    const pending = currentOrder.items.filter((i) => !i.sent);
    if (pending.length === 0) return;
    setBusy(true);
    try {
      const orderNumber = await store.nextOrderNumber();
      const sentAt = new Date().toISOString();
      await store.sendOrder(currentOrder.order.id);
      const { kitchen, bar } = splitTickets(pending);
      setTickets({
        kind: 'send',
        tableNumber: currentOrder.order.table_number,
        kitchen,
        bar,
        bill: null,
        orderNumber,
        sentAt,
        waiterName: currentOrder.order.waiter_name,
      });
      await refreshCurrentOrder(currentOrder.order.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível enviar o pedido.');
    } finally {
      setBusy(false);
    }
  }

  async function closeTable(sendPendingFirst: boolean) {
    if (!currentOrder) return;
    const pending = currentOrder.items.filter((i) => !i.sent);
    if (pending.length > 0 && !sendPendingFirst) {
      setConfirmClose(true);
      return;
    }
    setConfirmClose(false);
    setBusy(true);
    try {
      if (pending.length > 0) await store.sendOrder(currentOrder.order.id);
      // A conta é um documento impresso como os outros: ganha o próximo
      // número sequencial (a conta cobre a mesa inteira, que pode ter
      // vários envios — por isso não reaproveita o número de um envio).
      const billNumber = await store.nextOrderNumber();
      const bill = await store.closeOrder(
        currentOrder.order.id,
        settings.service_fee_pct,
      );
      const ow = await store.getOrderWithItems(currentOrder.order.id);
      const allItems = ow?.items ?? currentOrder.items;
      const { kitchen, bar } = splitTickets(allItems);
      setTickets({
        kind: 'close',
        tableNumber: currentOrder.order.table_number,
        kitchen,
        bar,
        bill,
        orderNumber: billNumber,
        sentAt: bill.closed_at,
        waiterName: bill.waiter_name,
      });
      setClosedReview({
        bill,
        items: allItems,
        tableNumber: currentOrder.order.table_number,
      });
      setCurrentOrder(null);
      setView('closed');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível fechar a mesa.');
    } finally {
      setBusy(false);
    }
  }

  const totals = (() => {
    const items = currentOrder?.items ?? [];
    const subtotal = items.reduce((s, i) => s + i.price_cents * i.qty, 0);
    const fee = Math.round((subtotal * settings.service_fee_pct) / 100);
    return { subtotal, fee, total: subtotal + fee };
  })();

  const pendingItems = (currentOrder?.items ?? []).filter((i) => !i.sent);
  const sentItems = (currentOrder?.items ?? []).filter((i) => i.sent);
  const categories = Array.from(
    new Set(products.map((p) => p.category)),
  ).sort((a, b) => a.localeCompare(b, 'pt-BR'));

  if (booting) {
    return (
      <div className="app">
        <div className="loading">Carregando o sistema…</div>
      </div>
    );
  }

  /* ------------------------------ SETUP ------------------------------ */

  if (view === 'setup') {
    return (
      <SetupView
        products={products}
        onProductsChanged={refresh}
        onDone={() => {
          setView('login');
        }}
      />
    );
  }

  /* ------------------------------ LOGIN ------------------------------ */

  if (view === 'login') {
    return (
      <div className="app">
        <div className="hero">
          <h1>Sistema do Garçom</h1>
          <p>Entre com o seu acesso para abrir as mesas.</p>
        </div>
        <div className="content">
          {error && <div className="error">{error}</div>}
          {ownerAuth ? (
            <OwnerAuthView
              mode={ownerAuth}
              busy={busy}
              onLogin={handleOwnerLogin}
              onCreate={handleOwnerCreate}
              onCancel={() => setOwnerAuth(null)}
            />
          ) : (
            <>
              <LoginForm busy={busy} onLogin={handleLogin} />
              <button
                className="owner-link"
                onClick={() =>
                  setOwnerAuth(hasOwner ? 'login' : 'setup')
                }
              >
                Sou o dono
              </button>
            </>
          )}
          <div className="mode-badge">
            {isSupabase
              ? 'Banco de dados: Supabase (nuvem)'
              : 'Banco de dados: local (neste aparelho)'}
          </div>
        </div>
      </div>
    );
  }

  /* ------------------------------ ÁREA DO DONO ------------------------------ */

  if (view === 'owner' && ownerSession) {
    return (
      <OwnerDashboardView
        bills={ownerBills}
        waiters={waiters}
        onNavigate={setView}
        onLogout={handleOwnerLogout}
        onRefresh={refreshOwner}
      />
    );
  }

  if (view === 'owner-waiters' && ownerSession) {
    return (
      <OwnerWaitersView
        waiters={waiters}
        bills={ownerBills}
        defaultPct={settings.default_commission_pct ?? 8}
        onChanged={refreshOwner}
        onNavigate={setView}
        onLogout={handleOwnerLogout}
      />
    );
  }

  if (view === 'owner-menu' && ownerSession) {
    return (
      <OwnerMenuView
        products={products}
        onChanged={refreshOwner}
        onNavigate={setView}
        onLogout={handleOwnerLogout}
      />
    );
  }

  if (view === 'owner-settings' && ownerSession) {
    return (
      <OwnerSettingsView
        settings={settings}
        onSaved={refreshOwner}
        onNavigate={setView}
        onLogout={handleOwnerLogout}
      />
    );
  }

  if (!session) {
    return (
      <div className="app">
        <div className="loading">Carregando o sistema…</div>
      </div>
    );
  }

  /* ------------------------------ MESAS ------------------------------ */

  if (view === 'tables') {
    const allTables = Array.from(
      { length: settings.table_count },
      (_, i) => i + 1,
    );
    const q = tableSearch.trim();
    // Busca por número: filtra a grade enquanto digita.
    const shownTables = q
      ? allTables.filter((n) => String(n).includes(q))
      : allTables;
    // Pedido em andamento = pedido aberto COM item (regra da trava:
    // mesa aberta sem item continua livre).
    const busyOrder = (n: number) => {
      const ow = openOrders.find((o) => o.order.table_number === n);
      return ow && ow.items.length > 0 ? ow : null;
    };
    const inProgress = shownTables.filter((n) => busyOrder(n));
    const free = shownTables.filter((n) => !busyOrder(n));
    const pad2 = (n: number) => String(n).padStart(2, '0');
    return (
      <div className="app">
        <header className="header header-blue">
          <h1>Mesas</h1>
          <button
            className="menu-btn"
            aria-label="Menu"
            onClick={() => setMenuOpen((v) => !v)}
          >
            ☰
          </button>
          {menuOpen && (
            <>
              <button
                className="menu-backdrop"
                aria-label="Fechar menu"
                onClick={() => setMenuOpen(false)}
              />
              <div className="menu-drop">
                <div className="menu-user">Olá, {session.name}</div>
                <button className="menu-item" onClick={openReview}>
                  Revisão
                </button>
                <button className="menu-item" onClick={handleLogout}>
                  Sair
                </button>
              </div>
            </>
          )}
        </header>
        <div className="content">
          {error && <div className="error">{error}</div>}
          <input
            className="table-search"
            type="search"
            inputMode="numeric"
            placeholder="Digite o nº da mesa/comanda..."
            value={tableSearch}
            onChange={(e) => setTableSearch(e.target.value)}
          />
          <div className="tables-section-title">
            Pedidos em andamento ({inProgress.length})
          </div>
          <div className="mesas-grid">
            {inProgress.map((n) => {
              const ow = busyOrder(n)!;
              const mine = ow.order.waiter_id === session.id;
              return (
                <button
                  key={n}
                  className={`mesa-tile ${mine ? 'mine' : 'other'}`}
                  disabled={busy}
                  onClick={() => openTable(n)}
                >
                  {!mine && <span className="mesa-lock">🔒</span>}
                  <span className="mesa-num">{pad2(n)}</span>
                  {!mine && (
                    <span className="mesa-owner">{ow.order.waiter_name}</span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="tables-section-title">
            Mesas/Comandas livres ({free.length})
          </div>
          <div className="mesas-grid">
            {free.map((n) => (
              <button
                key={n}
                className="mesa-tile free"
                disabled={busy}
                onClick={() => openTable(n)}
              >
                <span className="mesa-open">ABRIR</span>
                <span className="mesa-num">{pad2(n)}</span>
              </button>
            ))}
          </div>
          {shownTables.length === 0 && (
            <div className="empty">Nenhuma mesa com esse número.</div>
          )}
        </div>
      </div>
    );
  }

  /* ------------------------------ PEDIR ------------------------------ */

  if (view === 'order' && currentOrder) {
    const tableNumber = currentOrder.order.table_number;
    const query = orderSearch.trim().toLowerCase();
    const shownProducts = query
      ? products.filter(
          (p) =>
            p.name.toLowerCase().includes(query) ||
            p.category.toLowerCase().includes(query),
        )
      : orderCategory === ALL_PRODUCTS
        ? products
        : orderCategory
          ? products.filter((p) => p.category === orderCategory)
          : [];
    const pendingCount = pendingItems.reduce((s, i) => s + i.qty, 0);
    const pendingTotal = pendingItems.reduce(
      (s, i) => s + i.price_cents * i.qty,
      0,
    );

    return (
      <div className="app">
        <header className="header header-blue">
          <h1>Novo Pedido - Mesa {tableNumber}</h1>
          <button
            className="menu-btn"
            aria-label="Menu"
            onClick={() => setMenuOpen((v) => !v)}
          >
            ☰
          </button>
          {menuOpen && (
            <>
              <button
                className="menu-backdrop"
                aria-label="Fechar menu"
                onClick={() => setMenuOpen(false)}
              />
              <div className="menu-drop">
                <div className="menu-user">Olá, {session.name}</div>
                <button
                  className="menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    backToTablesFromOrder();
                  }}
                >
                  Mesas
                </button>
                <button className="menu-item" onClick={openReview}>
                  Revisão
                </button>
                <button className="menu-item" onClick={handleLogout}>
                  Sair
                </button>
              </div>
            </>
          )}
        </header>
        <div className="content">
          <div className="order-search">
            <input
              id="order-search"
              className="order-search-input"
              type="search"
              placeholder="Buscar em todas categorias por código..."
              value={orderSearch}
              onChange={(e) => setOrderSearch(e.target.value)}
            />
            <button
              className="order-search-btn"
              aria-label="Buscar"
              onClick={() =>
                document.getElementById('order-search')?.focus()
              }
            >
              🔍
            </button>
          </div>
          {query ? (
            <>
              <div className="section-title">Resultados da busca</div>
              {shownProducts.length === 0 ? (
                <div className="empty">
                  Nenhum produto encontrado para “{orderSearch}”.
                </div>
              ) : (
                <div className="prod-grid">
                  {shownProducts.map((p) => (
                    <ProductCard
                      key={p.id}
                      product={p}
                      qtyInOrder={
                        pendingItems.find((i) => i.product_id === p.id)?.qty ??
                        0
                      }
                      onAdd={() => onProductTap(p)}
                    />
                  ))}
                </div>
              )}
            </>
          ) : orderCategory ? (
            <>
              <div className="section-title">
                {orderCategory === ALL_PRODUCTS
                  ? 'Todos os produtos'
                  : orderCategory}
              </div>
              {shownProducts.length === 0 ? (
                <div className="empty">
                  Nenhum produto nesta categoria.
                </div>
              ) : (
                <div className="prod-grid">
                  {shownProducts.map((p) => (
                    <ProductCard
                      key={p.id}
                      product={p}
                      qtyInOrder={
                        pendingItems.find((i) => i.product_id === p.id)?.qty ??
                        0
                      }
                      onAdd={() => onProductTap(p)}
                    />
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              {categories.length === 0 ? (
                <div className="empty">
                  Nenhum produto cadastrado. Peça ao dono para cadastrar o
                  cardápio.
                </div>
              ) : (
                <div className="cat-grid">
                  {categories.map((c) => (
                    <button
                      key={c}
                      className="cat-tile"
                      onClick={() => setOrderCategory(c)}
                    >
                      {c}
                    </button>
                  ))}
                  <button
                    className="cat-tile cat-tile-all"
                    onClick={() => setOrderCategory(ALL_PRODUCTS)}
                  >
                    Todos os produtos
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        <div className="bottom-bar">
          <button
            className="btn btn-ghost"
            onClick={() => {
              setMenuOpen(false);
              if (orderCategory || query) {
                setOrderCategory(null);
                setOrderSearch('');
              } else if (currentOrder.items.length > 0) {
                setView('summary');
              } else {
                backToTablesFromOrder();
              }
            }}
          >
            ← VOLTAR
          </button>
          <button
            className="btn btn-green"
            disabled={pendingCount === 0}
            onClick={() => {
              setMenuOpen(false);
              setView('summary');
            }}
          >
            ✓ REVISAR ({pendingCount}) · {brl(pendingTotal)}
          </button>
        </div>
      </div>
    );
  }

  /* ------------------------------ COMO SERVIR ------------------------------ */

  if (view === 'serve' && serveProduct && currentOrder) {
    const drinkType = serveProduct.drink_type ?? 'refrigerante';
    return (
      <div className="app">
        <header className="header">
          <div>
            <h1>Como servir</h1>
            <div className="sub">
              {serveProduct.name} · Mesa {currentOrder.order.table_number}
            </div>
          </div>
          <button
            className="icon-btn"
            onClick={() => {
              setServeProduct(null);
              setBeerCups(null);
              setView('order');
            }}
          >
            ✕ Voltar
          </button>
        </header>
        <div className="content">
          {drinkType === 'cerveja' && beerCups === null ? (
            <>
              <p className="serve-q">Precisa de copos?</p>
              <div className="cat-grid">
                <button
                  className="cat-tile"
                  onClick={() => void chooseBeerCups(true)}
                >
                  Sim
                </button>
                <button
                  className="cat-tile"
                  onClick={() => void chooseBeerCups(false)}
                >
                  Não
                </button>
              </div>
            </>
          ) : drinkType === 'cerveja' || drinkType === 'torre' ? (
            <>
              <p className="serve-q">
                {drinkType === 'torre' ? 'Quantas canecas?' : 'Quantos copos?'}
              </p>
              <div className="serve-qty">
                <button
                  aria-label="Diminuir"
                  onClick={() => setServeQty((q) => Math.max(1, q - 1))}
                >
                  −
                </button>
                <span>{serveQty}</span>
                <button
                  aria-label="Aumentar"
                  onClick={() => setServeQty((q) => Math.min(20, q + 1))}
                >
                  +
                </button>
              </div>
              <button
                className="btn btn-green"
                style={{ width: '100%', marginTop: 16 }}
                onClick={() => void confirmServeQty()}
              >
                Adicionar
              </button>
            </>
          ) : (
            <div className="cat-grid">
              {SERVE_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  className="cat-tile"
                  onClick={() => void chooseServe(opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ------------------------------ RESUMO ------------------------------ */

  if (view === 'summary' && currentOrder) {
    const tableNumber = currentOrder.order.table_number;
    return (
      <div className="app">
        <header className="header">
          <div>
            <h1>Resumo do pedido - Mesa {tableNumber}</h1>
            <div className="sub">
              {session.name} · aberta às {formatTime(currentOrder.order.created_at)}
            </div>
          </div>
          <button className="icon-btn" onClick={() => setView('tables')}>
            ✕ Mesas
          </button>
        </header>
        <div className="content">
          {error && <div className="error">{error}</div>}

          <div className="summary-section">A enviar</div>
          {pendingItems.length === 0 && (
            <div className="empty">
              Nenhum item novo. Toque em “Adicionar produtos” para pedir.
            </div>
          )}
          {pendingItems.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              onQty={(d) => changeQty(item, d)}
              onRemove={async () => {
                await store.removeItem(item.id);
                if (currentOrder)
                  await refreshCurrentOrder(currentOrder.order.id);
              }}
              onNote={(note) => saveNote(item, note)}
            />
          ))}

          {sentItems.length > 0 && (
            <>
              <div className="summary-section">Já enviado</div>
              {sentItems.map((item) => (
                <div key={item.id} className="item-row sent">
                  <div className="top">
                    <span className="iname">
                      {item.qty}× {item.product_name}
                    </span>
                    <span className="iline">
                      {brl(item.price_cents * item.qty)}
                    </span>
                  </div>
                  {item.note && (
                    <div className="note-line">Obs.: {item.note}</div>
                  )}
                </div>
              ))}
            </>
          )}

          <div className="totals">
            <div className="trow">
              <span>Subtotal</span>
              <span>{brl(totals.subtotal)}</span>
            </div>
            <div className="trow">
              <span>Taxa de serviço</span>
              <span>{brl(totals.fee)}</span>
            </div>
            <div className="trow total">
              <span>Total</span>
              <span>{brl(totals.total)}</span>
            </div>
          </div>
        </div>
        <div className="bottom-bar">
          <button
            className="btn btn-ghost"
            onClick={() => {
              setOrderCategory(null);
              setOrderSearch('');
              setView('order');
            }}
          >
            Adicionar produtos
          </button>
          <button
            className="btn btn-purple"
            disabled={busy || currentOrder.items.length === 0}
            onClick={() => closeTable(false)}
          >
            Fechar mesa
          </button>
          <button
            className="btn btn-green"
            disabled={busy || pendingItems.length === 0}
            onClick={sendOrder}
          >
            Enviar pedido
          </button>
        </div>
        {confirmClose && (
          <ConfirmModal
            title="Ainda há itens não enviados"
            text="Tem item no resumo que ainda não foi enviado para a cozinha/bar. Deseja enviar agora e fechar a conta?"
            confirmLabel="Enviar e fechar"
            onConfirm={() => closeTable(true)}
            onCancel={() => setConfirmClose(false)}
          />
        )}
        {tickets && (
          <TicketsModal
            data={tickets}
            products={products}
            onClose={() => {
              setTickets(null);
              setView('tables');
            }}
          />
        )}
      </div>
    );
  }

  /* ------------------- REVISÃO: CONTAS FECHADAS ------------------- */

  if (view === 'review') {
    return (
      <div className="app">
        <header className="header">
          <div>
            <h1>Revisão</h1>
            <div className="sub">Mesas fechadas</div>
          </div>
          <button className="icon-btn" onClick={() => setView('tables')}>
            ✕ Voltar
          </button>
        </header>
        <div className="content">
          {error && <div className="error">{error}</div>}
          {closedBills.length === 0 ? (
            <div className="empty">Nenhuma mesa fechada ainda.</div>
          ) : (
            closedBills.map((bill) => (
              <button
                key={bill.id}
                className="review-row"
                disabled={busy}
                onClick={() => openClosedBill(bill)}
              >
                <span className="review-table">
                  Mesa {String(bill.table_number).padStart(2, '0')}
                </span>
                <span className="review-meta">
                  {bill.waiter_name} · {formatTime(bill.closed_at)}
                </span>
                <span className="review-total">{brl(bill.total_cents)}</span>
              </button>
            ))
          )}
        </div>
      </div>
    );
  }

  /* ------------------- REVISÃO DA CONTA FECHADA ------------------- */

  if (view === 'closed' && closedReview) {
    const { bill, items, tableNumber } = closedReview;
    return (
      <div className="app">
        <header className="header">
          <div>
            <h1>Conta fechada - Mesa {tableNumber}</h1>
            <div className="sub">
              {bill.waiter_name} · fechada às {formatTime(bill.closed_at)}
            </div>
          </div>
        </header>
        <div className="content">
          <p className="hint">
            Confira o que tinha na mesa — itens, quantidades e valores.
          </p>
          {items.map((item) => (
            <div key={item.id} className="item-row">
              <div className="top">
                <span className="iname">
                  {item.qty}× {item.product_name}
                </span>
                <span className="iline">
                  {brl(item.price_cents * item.qty)}
                </span>
              </div>
              <div className="note-line">
                {brl(item.price_cents)} cada
                {item.note ? ` · Obs.: ${item.note}` : ''}
              </div>
            </div>
          ))}
          <div className="totals">
            <div className="trow">
              <span>Subtotal</span>
              <span>{brl(bill.subtotal_cents)}</span>
            </div>
            <div className="trow">
              <span>Taxa de serviço</span>
              <span>{brl(bill.fee_cents)}</span>
            </div>
            <div className="trow total">
              <span>Total</span>
              <span>{brl(bill.total_cents)}</span>
            </div>
          </div>
          <div style={{ height: 16 }} />
          <button
            className="btn btn-green"
            onClick={() => {
              setClosedReview(null);
              setView('tables');
            }}
          >
            Voltar às mesas
          </button>
        </div>
        {tickets && (
          <TicketsModal
            data={tickets}
            products={products}
            onClose={() => setTickets(null)}
          />
        )}
      </div>
    );
  }

  /* ------------------------------ CARDÁPIO ------------------------------ */

  if (view === 'menu') {
    return (
      <div className="app">
        <header className="header">
          <div>
            <h1>Cardápio</h1>
          </div>
          <button className="icon-btn" onClick={() => setView('tables')}>
            ✕ Voltar
          </button>
        </header>
        <div className="content">
          {products.length === 0 ? (
            <div className="empty">
              Nenhum produto cadastrado. Cadastre o cardápio em Ajustes.
            </div>
          ) : (
            <ProductListGrouped
              products={products}
              onDeleted={refresh}
              readOnly
            />
          )}
          <p className="hint" style={{ textAlign: 'center' }}>
            Para adicionar ou remover produtos, vá em Ajustes.
          </p>
        </div>
      </div>
    );
  }

  /* ------------------------------ AJUSTES ------------------------------ */

  if (view === 'settings') {
    return (
      <SettingsView
        settings={settings}
        products={products}
        onSaved={async () => {
          await refresh();
        }}
        onBack={() => setView('tables')}
        onLogout={handleLogout}
      />
    );
  }

  return (
    <div className="app">
      <div className="loading">Carregando o sistema…</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Formulário de login                                                 */
/* ------------------------------------------------------------------ */

function LoginForm({
  busy,
  onLogin,
}: {
  busy: boolean;
  onLogin: (login: string, password: string) => void;
}) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  return (
    <div className="card">
      <div className="field">
        <label htmlFor="login">Login</label>
        <input
          id="login"
          autoComplete="username"
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          placeholder="Seu login"
        />
      </div>
      <div className="field">
        <label htmlFor="password">Senha</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Sua senha"
          onKeyDown={(e) => {
            if (e.key === 'Enter') onLogin(login, password);
          }}
        />
      </div>
      <button
        className="btn btn-purple"
        disabled={busy || !login.trim() || !password}
        onClick={() => onLogin(login, password)}
      >
        Entrar
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Primeiro acesso: cria o acesso do garçom e cadastra o cardápio.    */
/* Só aparece quando o sistema está vazio.                             */
/* ------------------------------------------------------------------ */

function SetupView({
  products,
  onProductsChanged,
  onDone,
}: {
  products: Product[];
  onProductsChanged: () => Promise<void>;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [accessCreated, setAccessCreated] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function createAccess() {
    setError('');
    if (!name.trim() || !login.trim()) {
      setError('Preencha o nome e o login do garçom.');
      return;
    }
    if (password.length < 4) {
      setError('A senha precisa ter no mínimo 4 caracteres.');
      return;
    }
    setBusy(true);
    try {
      const hash = await store.hashPassword(password);
      await store.createWaiter(name.trim(), login.trim(), hash);
      setAccessCreated(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível criar o acesso.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <div className="hero">
        <h1>Sistema do Garçom</h1>
        <p>Primeiro acesso — configure o sistema uma única vez.</p>
      </div>
      <div className="content">
        {error && <div className="error">{error}</div>}

        <div className="card">
          <h2>1 · Criar acesso</h2>
          <p className="hint">
            Crie o acesso do garçom. Depois, o dono cria os acessos dos outros
            garçons no sistema dele e só passa o login e a senha.
          </p>
          {accessCreated ? (
            <div className="ok-note">
              Acesso criado para <strong>{name.trim()}</strong> (login:{' '}
              <strong>{login.trim()}</strong>).
            </div>
          ) : (
            <>
              <div className="field">
                <label htmlFor="setup-name">Nome do garçom</label>
                <input
                  id="setup-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ex.: Carlos"
                />
              </div>
              <div className="field">
                <label htmlFor="setup-login">Login</label>
                <input
                  id="setup-login"
                  autoComplete="username"
                  value={login}
                  onChange={(e) => setLogin(e.target.value)}
                  placeholder="Ex.: carlos"
                />
              </div>
              <div className="field">
                <label htmlFor="setup-password">Senha (mínimo 4 caracteres)</label>
                <input
                  id="setup-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Crie uma senha"
                />
              </div>
              <button
                className="btn btn-purple"
                disabled={busy}
                onClick={createAccess}
              >
                Criar acesso
              </button>
            </>
          )}
        </div>

        <div className="card">
          <h2>2 · Cardápio</h2>
          <p className="hint">
            Cada produto sai numa impressora: pratos na cozinha, bebidas no
            bar.
          </p>
          <ProductForm
            products={products}
            onAdded={onProductsChanged}
            disabled={!accessCreated}
          />
          {products.length > 0 && (
            <ProductListGrouped products={products} onDeleted={onProductsChanged} />
          )}
        </div>

        <button
          className="btn btn-green"
          disabled={!accessCreated || products.length === 0}
          onClick={onDone}
        >
          Ir para o login
        </button>
        {accessCreated && products.length === 0 && (
          <p className="hint" style={{ textAlign: 'center', marginTop: 10 }}>
            Cadastre ao menos 1 produto para continuar.
          </p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Cadastro de produto (usado no primeiro acesso e em Ajustes)         */
/* ------------------------------------------------------------------ */

function ProductForm({
  products,
  onAdded,
  disabled,
  editing,
  onCancelEdit,
}: {
  products: Product[];
  onAdded: () => Promise<void>;
  disabled?: boolean;
  /** produto em edição (só na área do dono) — null = cadastro novo */
  editing?: Product | null;
  onCancelEdit?: () => void;
}) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState('');
  const [printsIn, setPrintsIn] = useState<'kitchen' | 'bar'>('kitchen');
  const [drinkType, setDrinkType] = useState<DrinkType>('refrigerante');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Ao escolher um produto pra editar, preenche o formulário com ele.
  useEffect(() => {
    if (!editing) return;
    setName(editing.name);
    setPrice(String(editing.price_cents / 100).replace('.', ','));
    setCategory(editing.category);
    setPrintsIn(editing.prints_in);
    setDrinkType(editing.drink_type ?? 'refrigerante');
    setDescription(editing.description ?? '');
  }, [editing]);

  const suggestions = Array.from(
    new Set(products.map((p) => p.category)),
  ).sort((a, b) => a.localeCompare(b, 'pt-BR'));

  async function add() {
    setError('');
    const cents = parsePriceToCents(price);
    if (!name.trim()) {
      setError('Informe o nome do produto.');
      return;
    }
    if (cents === null) {
      setError('Informe um preço válido. Ex.: 32,90');
      return;
    }
    if (!category.trim()) {
      setError('Informe a categoria. Ex.: Almoço, Bebidas.');
      return;
    }
    setBusy(true);
    try {
      const input = {
        name: name.trim(),
        price_cents: cents,
        category: category.trim(),
        prints_in: printsIn,
        drink_type: printsIn === 'bar' ? drinkType : undefined,
        description:
          printsIn === 'kitchen' && description.trim()
            ? description.trim()
            : undefined,
      };
      if (editing) {
        await store.updateProduct(editing.id, input);
      } else {
        await store.createProduct(input);
      }
      setName('');
      setPrice('');
      setCategory('');
      setDrinkType('refrigerante');
      setDescription('');
      await onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível adicionar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {error && <div className="error">{error}</div>}
      <div className="field">
        <label htmlFor="prod-name">Nome do produto</label>
        <input
          id="prod-name"
          value={name}
          disabled={disabled}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex.: Prato da casa"
        />
      </div>
      <div className="row2">
        <div className="field">
          <label htmlFor="prod-price">Preço (R$)</label>
          <input
            id="prod-price"
            inputMode="decimal"
            value={price}
            disabled={disabled}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="32,90"
          />
        </div>
        <div className="field">
          <label htmlFor="prod-cat">Categoria</label>
          <input
            id="prod-cat"
            list="cat-suggestions"
            value={category}
            disabled={disabled}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="Ex.: Almoço"
          />
          <datalist id="cat-suggestions">
            {suggestions.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
      </div>
      <div className="field">
        <label>Imprime em</label>
        <div className="seg">
          <button
            type="button"
            disabled={disabled}
            className={printsIn === 'kitchen' ? 'on-kitchen' : ''}
            onClick={() => setPrintsIn('kitchen')}
          >
            🍽️ Cozinha
          </button>
          <button
            type="button"
            disabled={disabled}
            className={printsIn === 'bar' ? 'on-bar' : ''}
            onClick={() => setPrintsIn('bar')}
          >
            🥤 Bar
          </button>
        </div>
      </div>
      {printsIn === 'bar' && (
        <div className="field">
          <label htmlFor="prod-drink">Tipo de bebida</label>
          <select
            id="prod-drink"
            value={drinkType}
            disabled={disabled}
            onChange={(e) => setDrinkType(e.target.value as DrinkType)}
          >
            <option value="refrigerante">Refrigerante</option>
            <option value="cerveja">Cerveja</option>
            <option value="torre">Torre de chopp</option>
            <option value="outro">Outro sem opções</option>
          </select>
        </div>
      )}
      {printsIn === 'kitchen' && (
        <div className="field">
          <label htmlFor="prod-desc">O que vem no prato (opcional)</label>
          <input
            id="prod-desc"
            value={description}
            disabled={disabled}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Ex.: arroz, feijão, batata frita"
          />
        </div>
      )}
      <button
        className="btn btn-orange"
        disabled={busy || disabled}
        onClick={add}
      >
        {editing ? 'Salvar alterações' : 'Adicionar ao cardápio'}
      </button>
      {editing && onCancelEdit && (
        <>
          <div style={{ height: 10 }} />
          <button className="btn btn-ghost" onClick={onCancelEdit}>
            Cancelar edição
          </button>
        </>
      )}
    </div>
  );
}

function ProductListGrouped({
  products,
  onDeleted,
  readOnly,
  onEdit,
}: {
  products: Product[];
  onDeleted: () => Promise<void>;
  readOnly?: boolean;
  /** editar (só na área do dono) — quando ausente, não mostra o botão */
  onEdit?: (p: Product) => void;
}) {
  const groups = new Map<string, Product[]>();
  for (const p of products) {
    const list = groups.get(p.category) ?? [];
    list.push(p);
    groups.set(p.category, list);
  }
  return (
    <div style={{ marginTop: 16 }}>
      {Array.from(groups.entries())
        .sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'))
        .map(([cat, items]) => (
          <div key={cat} className="prod-list-group">
            <h4>{cat}</h4>
            {items.map((p) => (
              <div key={p.id} className="prod-list-item">
                <span>
                  {p.name} · {brl(p.price_cents)}{' '}
                  <span className="where">
                    ({p.prints_in === 'kitchen' ? 'Cozinha' : 'Bar'})
                  </span>
                </span>
                {!readOnly && (
                  <>
                    {onEdit && (
                      <button onClick={() => onEdit(p)}>Editar</button>
                    )}
                    <button
                      onClick={async () => {
                        await store.deleteProduct(p.id);
                        await onDeleted();
                      }}
                    >
                      Remover
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Cartão de produto (tela de pedir)                                   */
/* ------------------------------------------------------------------ */

function ProductCard({
  product,
  qtyInOrder,
  onAdd,
}: {
  product: Product;
  qtyInOrder: number;
  onAdd: () => void;
}) {
  return (
    <button className="prod-card" onClick={onAdd}>
      {qtyInOrder > 0 && <span className="qty-badge">{qtyInOrder}×</span>}
      <span className="pname">{product.name}</span>
      <span className="pcat">{product.category}</span>
      <span className="price">{brl(product.price_cents)}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Linha de item no resumo (quantidade, observação, retirar)           */
/* ------------------------------------------------------------------ */

function ItemRow({
  item,
  onQty,
  onRemove,
  onNote,
}: {
  item: OrderItem;
  onQty: (delta: number) => void;
  onRemove: () => void;
  onNote: (note: string) => void;
}) {
  const [draft, setDraft] = useState(item.note);
  return (
    <div className="item-row">
      <div className="top">
        <span className="iname">{item.product_name}</span>
        <span className="iline">{brl(item.price_cents * item.qty)}</span>
      </div>
      {item.serve && <div className="note-line">{item.serve}</div>}
      <input
        className="note-input"
        value={draft}
        placeholder="observações"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onNote(draft.trim())}
      />
      <div className="stepper">
        <button onClick={() => onQty(-1)} aria-label="Diminuir">
          −
        </button>
        <span className="q">{item.qty}</span>
        <button onClick={() => onQty(1)} aria-label="Aumentar">
          +
        </button>
        <button className="remove" onClick={onRemove}>
          Retirar
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Modal de confirmação                                                */
/* ------------------------------------------------------------------ */

function ConfirmModal({
  title,
  text,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  text: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        <p className="hint">{text}</p>
        <button className="btn btn-green" onClick={onConfirm}>
          {confirmLabel}
        </button>
        <div style={{ height: 10 }} />
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Vias de papel (cozinha / bar / balcão)                              */
/* ------------------------------------------------------------------ */

function TicketsModal({
  data,
  products,
  onClose,
}: {
  data: TicketData;
  products: Product[];
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal">
        {data.kind === 'send' ? (
          <>
            <h3 style={{ marginTop: 0 }}>Pedido enviado</h3>
            <p className="hint">
              As vias abaixo são o que sairia em cada impressora.
            </p>
          </>
        ) : (
          <>
            <h3 style={{ marginTop: 0 }}>Conta fechada — Mesa {data.tableNumber}</h3>
            <p className="hint">Via do balcão com os valores finais.</p>
          </>
        )}

        {data.kind === 'send' && data.kitchen.length > 0 && (
          <div className="ticket">
            <div className="t-head">
              <span className="t-logo" aria-hidden>
                👨‍🍳
              </span>
              <span className="t-name">{RESTAURANT_NAME}</span>
              <span className="t-num">
                Pedido Nº
                <strong>
                  {String(data.orderNumber ?? 0).padStart(4, '0')}
                </strong>
              </span>
            </div>
            <div className="t-meta">
              Mesa: {data.tableNumber} | Hora:{' '}
              {data.sentAt ? formatTime(data.sentAt) : ''} | Garçom:{' '}
              {data.waiterName ?? ''}
            </div>
            <div className="t-band">👨‍🍳&nbsp; COZINHA</div>
            <div className="t-cols">
              <span className="t-qty">Qtd.</span>
              <span>Produto</span>
            </div>
            <hr />
            {data.kitchen.map((i) => {
              const desc = products.find(
                (p) => p.id === i.product_id,
              )?.description;
              return (
                <div key={i.id}>
                  <div className="t-row">
                    <span className="t-qty">{i.qty}×</span>
                    <span>{i.product_name}</span>
                  </div>
                  {desc && <div className="t-detail">{desc}</div>}
                  {i.note && (
                    <div className="t-obs">
                      <strong>Observações:</strong> {i.note}
                    </div>
                  )}
                </div>
              );
            })}
            <hr />
            <div className="t-foot">
              ✓ Pedido em preparo!
              <span>Qualquer dúvida, chame o garçom.</span>
            </div>
          </div>
        )}

        {data.kind === 'send' && data.bar.length > 0 && (
          <div className="ticket">
            <div className="t-head">
              <span className="t-logo" aria-hidden>
                👨‍🍳
              </span>
              <span className="t-name">{RESTAURANT_NAME}</span>
              <span className="t-num">
                Pedido Nº
                <strong>
                  {String(data.orderNumber ?? 0).padStart(4, '0')}
                </strong>
              </span>
            </div>
            <div className="t-meta">
              Mesa: {data.tableNumber} | Hora:{' '}
              {data.sentAt ? formatTime(data.sentAt) : ''} | Garçom:{' '}
              {data.waiterName ?? ''}
            </div>
            <div className="t-band">🥤&nbsp; BAR</div>
            <div className="t-cols">
              <span className="t-qty">Qtd.</span>
              <span>Produto</span>
            </div>
            <hr />
            {data.bar.map((i) => (
              <div key={i.id}>
                <div className="t-row">
                  <span className="t-qty">{i.qty}×</span>
                  <span>{i.product_name}</span>
                </div>
                {i.serve && <div className="t-detail">{i.serve}</div>}
                {i.note && (
                  <div className="t-obs">
                    <strong>Observações:</strong> {i.note}
                  </div>
                )}
              </div>
            ))}
            <hr />
            <div className="t-foot">
              ✓ Pedido em preparo!
              <span>Qualquer dúvida, chame o garçom.</span>
            </div>
          </div>
        )}

        {data.bill && (
          <div className="ticket">
            <div className="t-head">
              <span className="t-logo" aria-hidden>
                🧾
              </span>
              <span className="t-name">{RESTAURANT_NAME}</span>
              <span className="t-num">
                Pedido Nº
                <strong>
                  {String(data.orderNumber ?? 0).padStart(4, '0')}
                </strong>
              </span>
            </div>
            <div className="t-meta">
              Mesa: {data.tableNumber} | Hora:{' '}
              {data.sentAt ? formatTime(data.sentAt) : ''} | Garçom:{' '}
              {data.waiterName ?? data.bill.waiter_name}
            </div>
            <div className="t-band">🧾&nbsp; CONTA</div>
            <div className="t-cols">
              <span className="t-qty">Qtd.</span>
              <span className="t-item">Produto</span>
              <span className="t-price">Valor</span>
            </div>
            <hr />
            {[...data.kitchen, ...data.bar].map((i) => (
              <div key={i.id}>
                <div className="t-row">
                  <span className="t-qty">{i.qty}×</span>
                  <span className="t-item">{i.product_name}</span>
                  <span className="t-price">
                    {brl(i.price_cents * i.qty)}
                  </span>
                </div>
                {i.serve && <div className="t-detail">{i.serve}</div>}
                {i.note && (
                  <div className="t-obs">
                    <strong>Observações:</strong> {i.note}
                  </div>
                )}
              </div>
            ))}
            <hr />
            <div className="t-line">
              <span>Subtotal</span>
              <span>{brl(data.bill.subtotal_cents)}</span>
            </div>
            <div className="t-line">
              <span>Taxa de serviço</span>
              <span>{brl(data.bill.fee_cents)}</span>
            </div>
            <div className="t-line t-total">
              <span>Total</span>
              <span>{brl(data.bill.total_cents)}</span>
            </div>
            <hr />
            <div className="t-foot">Obrigado pela preferência!</div>
          </div>
        )}

        <button className="btn btn-purple" onClick={onClose}>
          OK
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Ajustes: taxa de serviço, nº de mesas, cardápio                     */
/* ------------------------------------------------------------------ */

function SettingsView({
  settings,
  products,
  onSaved,
  onBack,
  onLogout,
}: {
  settings: Settings;
  products: Product[];
  onSaved: () => Promise<void>;
  onBack: () => void;
  onLogout: () => void;
}) {
  const [fee, setFee] = useState(String(settings.service_fee_pct));
  const [tables, setTables] = useState(String(settings.table_count));
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save() {
    setError('');
    setSaved(false);
    const feePct = Number(fee.replace(',', '.'));
    const count = Number(tables);
    if (!Number.isFinite(feePct) || feePct < 0 || feePct > 100) {
      setError('Informe uma taxa de serviço entre 0 e 100.');
      return;
    }
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      setError('Informe o número de mesas (1 a 100).');
      return;
    }
    setBusy(true);
    try {
      await store.saveSettings({ service_fee_pct: feePct, table_count: count });
      await onSaved();
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível salvar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Ajustes</h1>
        </div>
        <button className="icon-btn" onClick={onBack}>
          ✕ Voltar
        </button>
      </header>
      <div className="content">
        {error && <div className="error">{error}</div>}
        {saved && <div className="ok-note">Ajustes salvos.</div>}

        <div className="card">
          <h2>Taxa de serviço e mesas</h2>
          <div className="row2">
            <div className="field">
              <label htmlFor="fee">Taxa de serviço (%)</label>
              <input
                id="fee"
                inputMode="decimal"
                value={fee}
                onChange={(e) => setFee(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="tables">Nº de mesas</label>
              <input
                id="tables"
                inputMode="numeric"
                value={tables}
                onChange={(e) => setTables(e.target.value)}
              />
            </div>
          </div>
          <button className="btn btn-purple" disabled={busy} onClick={save}>
            Salvar ajustes
          </button>
        </div>

        <div className="card">
          <h2>Cardápio</h2>
          <p className="hint">
            O cardápio agora é gerenciado pelo dono, na área dele — entre
            com o login do dono na tela de login.
          </p>
          <ProductForm products={products} onAdded={onSaved} />
          {products.length > 0 && (
            <ProductListGrouped products={products} onDeleted={onSaved} />
          )}
        </div>

        <div className="card">
          <h2>Sessão</h2>
          <button className="btn btn-danger-ghost" onClick={onLogout}>
            Sair do sistema
          </button>
        </div>

        <div className="mode-badge">
          {isSupabase
            ? 'Banco de dados: Supabase (nuvem)'
            : 'Banco de dados: local (neste aparelho)'}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Área do dono                                                        */
/* ------------------------------------------------------------------ */

type Period = 'today' | '7d' | '30d' | 'all';

const PERIOD_LABELS: Record<Period, string> = {
  today: 'Hoje',
  '7d': '7 dias',
  '30d': '30 dias',
  all: 'Tudo',
};

function filterBills(bills: ClosedBill[], period: Period): ClosedBill[] {
  if (period === 'all') return bills;
  const now = new Date();
  if (period === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return bills.filter((b) => new Date(b.closed_at) >= start);
  }
  const days = period === '7d' ? 7 : 30;
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return bills.filter((b) => new Date(b.closed_at) >= start);
}

/** Acesso do dono: login ou primeiro acesso (cria o usuário dele). */
function OwnerAuthView({
  mode,
  busy,
  onLogin,
  onCreate,
  onCancel,
}: {
  mode: 'login' | 'setup';
  busy: boolean;
  onLogin: (login: string, password: string) => void;
  onCreate: (name: string, login: string, password: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  function submit() {
    if (mode === 'setup') {
      if (!name.trim() || !login.trim()) {
        setError('Preencha o nome e o usuário.');
        return;
      }
      if (password.length < 4) {
        setError('A senha precisa ter no mínimo 4 caracteres.');
        return;
      }
      onCreate(name, login, password);
    } else {
      if (!login.trim() || !password) {
        setError('Preencha o usuário e a senha.');
        return;
      }
      onLogin(login, password);
    }
  }

  return (
    <div className="card">
      <h2>{mode === 'setup' ? 'Acesso do dono' : 'Área do dono'}</h2>
      <p className="hint">
        {mode === 'setup'
          ? 'Primeiro acesso: crie o seu usuário. Ele é só seu — não passe pra ninguém.'
          : 'Entre com o seu usuário para ver o financeiro.'}
      </p>
      {error && <div className="error">{error}</div>}
      {mode === 'setup' && (
        <div className="field">
          <label htmlFor="owner-name">Seu nome</label>
          <input
            id="owner-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Luis"
          />
        </div>
      )}
      <div className="field">
        <label htmlFor="owner-login">Usuário (só você sabe)</label>
        <input
          id="owner-login"
          autoComplete="username"
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          placeholder="Seu usuário"
        />
      </div>
      <div className="field">
        <label htmlFor="owner-password">Senha</label>
        <input
          id="owner-password"
          type="password"
          autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Sua senha"
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
      </div>
      <button className="btn btn-purple" disabled={busy} onClick={submit}>
        {mode === 'setup' ? 'Criar acesso do dono' : 'Entrar no financeiro'}
      </button>
      <div style={{ height: 10 }} />
      <button className="btn btn-ghost" onClick={onCancel}>
        Voltar ao login do garçom
      </button>
    </div>
  );
}

type OwnerTab = 'dashboard' | 'waiters' | 'menu' | 'settings';

/** Cabeçalho da área do dono + abas (Dashboard, Garçons, Cardápio, Ajustes). */
function OwnerHeader({
  title,
  sub,
  tab,
  onNavigate,
  onLogout,
}: {
  title: string;
  sub?: string;
  tab: OwnerTab;
  onNavigate: (v: View) => void;
  onLogout: () => void;
}) {
  return (
    <>
      <header className="header">
        <div>
          <h1>{title}</h1>
          {sub && <div className="sub">{sub}</div>}
        </div>
        <button className="icon-btn" onClick={onLogout}>
          Sair
        </button>
      </header>
      <div className="owner-tabs">
        <button
          className={tab === 'dashboard' ? 'on' : ''}
          onClick={() => onNavigate('owner')}
        >
          Dashboard
        </button>
        <button
          className={tab === 'waiters' ? 'on' : ''}
          onClick={() => onNavigate('owner-waiters')}
        >
          Garçons
        </button>
        <button
          className={tab === 'menu' ? 'on' : ''}
          onClick={() => onNavigate('owner-menu')}
        >
          Cardápio
        </button>
        <button
          className={tab === 'settings' ? 'on' : ''}
          onClick={() => onNavigate('owner-settings')}
        >
          Ajustes
        </button>
      </div>
    </>
  );
}

/* ------------------- DONO: DASHBOARD FINANCEIRO ------------------- */

function OwnerDashboardView({
  bills,
  waiters,
  onNavigate,
  onLogout,
  onRefresh,
}: {
  bills: ClosedBill[];
  waiters: Waiter[];
  onNavigate: (v: View) => void;
  onLogout: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [period, setPeriod] = useState<Period>('today');
  const shown = filterBills(bills, period);
  const sold = shown.reduce((s, b) => s + b.total_cents, 0);
  const commission = shown.reduce(
    (s, b) => s + (b.commission_cents ?? 0),
    0,
  );
  const restaurant = sold - commission;

  return (
    <div className="app">
      <OwnerHeader
        title="Área do dono"
        sub="Financeiro do restaurante"
        tab="dashboard"
        onNavigate={onNavigate}
        onLogout={onLogout}
      />
      <div className="content">
        <div className="seg">
          {(['today', '7d', '30d', 'all'] as Period[]).map((p) => (
            <button
              key={p}
              type="button"
              className={period === p ? 'on' : ''}
              onClick={() => setPeriod(p)}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>

        <div className="stat-grid">
          <div className="stat-card">
            <span>Total vendido</span>
            <strong>{brl(sold)}</strong>
          </div>
          <div className="stat-card">
            <span>Comissão dos garçons</span>
            <strong>{brl(commission)}</strong>
          </div>
          <div className="stat-card">
            <span>Fica pro restaurante</span>
            <strong>{brl(restaurant)}</strong>
          </div>
        </div>

        <div className="section-title">Por garçom</div>
        {waiters.length === 0 ? (
          <div className="empty">
            Nenhum garçom cadastrado. Cadastre na aba Garçons.
          </div>
        ) : (
          waiters.map((w) => {
            const wb = shown.filter((b) => b.waiter_id === w.id);
            const wSold = wb.reduce((s, b) => s + b.total_cents, 0);
            const wComm = wb.reduce(
              (s, b) => s + (b.commission_cents ?? 0),
              0,
            );
            const pct = w.commission_pct ?? 8;
            return (
              <div key={w.id} className="item-row">
                <div className="top">
                  <span className="iname">{w.name}</span>
                  <span className="iline">{brl(wSold)}</span>
                </div>
                <div className="note-line">
                  Comissão {pct}% · dele {brl(wComm)} · restaurante{' '}
                  {brl(wSold - wComm)}
                </div>
              </div>
            );
          })
        )}

        <div className="section-title">
          Contas fechadas ({shown.length})
        </div>
        {shown.length === 0 ? (
          <div className="empty">Nenhuma venda nesse período.</div>
        ) : (
          shown.map((b) => (
            <div key={b.id} className="item-row">
              <div className="top">
                <span className="iname">
                  Mesa {String(b.table_number).padStart(2, '0')} ·{' '}
                  {b.waiter_name}
                </span>
                <span className="iline">{brl(b.total_cents)}</span>
              </div>
              <div className="note-line">
                {formatDateTime(b.closed_at)} · Comissão{' '}
                {brl(b.commission_cents ?? 0)}
              </div>
            </div>
          ))
        )}

        <div style={{ height: 12 }} />
        <button className="btn btn-ghost" onClick={() => void onRefresh()}>
          Atualizar
        </button>
      </div>
    </div>
  );
}

/* ------------------- DONO: GARÇONS ------------------- */

function OwnerWaitersView({
  waiters,
  bills,
  defaultPct,
  onChanged,
  onNavigate,
  onLogout,
}: {
  waiters: Waiter[];
  bills: ClosedBill[];
  defaultPct: number;
  onChanged: () => Promise<void>;
  onNavigate: (v: View) => void;
  onLogout: () => void;
}) {
  const [name, setName] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [pct, setPct] = useState(String(defaultPct));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Waiter | null>(null);

  function startEdit(w: Waiter) {
    setEditingId(w.id);
    setName(w.name);
    setLogin(w.login);
    setPassword('');
    setPct(String(w.commission_pct ?? defaultPct));
  }

  function cancelEdit() {
    setEditingId(null);
    setName('');
    setLogin('');
    setPassword('');
    setPct(String(defaultPct));
  }

  async function save() {
    setError('');
    const pctNum = Number(pct.replace(',', '.'));
    if (!name.trim() || !login.trim()) {
      setError('Preencha o nome e o login.');
      return;
    }
    if (!Number.isFinite(pctNum) || pctNum < 0 || pctNum > 100) {
      setError('Informe uma comissão entre 0 e 100%.');
      return;
    }
    if (!editingId && password.length < 4) {
      setError('A senha precisa ter no mínimo 4 caracteres.');
      return;
    }
    if (editingId && password && password.length < 4) {
      setError('A nova senha precisa ter no mínimo 4 caracteres.');
      return;
    }
    setBusy(true);
    try {
      if (editingId) {
        const patch: Partial<
          Pick<Waiter, 'name' | 'commission_pct' | 'password_hash'>
        > = { name: name.trim(), commission_pct: pctNum };
        if (password) patch.password_hash = await store.hashPassword(password);
        await store.updateWaiter(editingId, patch);
      } else {
        const hash = await store.hashPassword(password);
        await store.createWaiter(name.trim(), login.trim(), hash, pctNum);
      }
      cancelEdit();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível salvar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <OwnerHeader
        title="Garçons"
        sub="Só o dono cadastra os garçons — depois passa o login e a senha pra cada um"
        tab="waiters"
        onNavigate={onNavigate}
        onLogout={onLogout}
      />
      <div className="content">
        {error && <div className="error">{error}</div>}

        <div className="card">
          <h2>{editingId ? 'Editar garçom' : 'Novo garçom'}</h2>
          <div className="field">
            <label htmlFor="waiter-name">Nome</label>
            <input
              id="waiter-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: Carlos"
            />
          </div>
          <div className="row2">
            <div className="field">
              <label htmlFor="waiter-login">Login</label>
              <input
                id="waiter-login"
                autoComplete="username"
                value={login}
                disabled={!!editingId}
                onChange={(e) => setLogin(e.target.value)}
                placeholder="Ex.: carlos"
              />
            </div>
            <div className="field">
              <label htmlFor="waiter-pct">Comissão (%)</label>
              <input
                id="waiter-pct"
                inputMode="decimal"
                value={pct}
                onChange={(e) => setPct(e.target.value)}
                placeholder="8"
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="waiter-password">
              {editingId ? 'Nova senha (deixe em branco pra manter)' : 'Senha'}
            </label>
            <input
              id="waiter-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Mínimo 4 caracteres"
            />
          </div>
          <button className="btn btn-purple" disabled={busy} onClick={save}>
            {editingId ? 'Salvar alterações' : 'Cadastrar garçom'}
          </button>
          {editingId && (
            <>
              <div style={{ height: 10 }} />
              <button className="btn btn-ghost" onClick={cancelEdit}>
                Cancelar edição
              </button>
            </>
          )}
        </div>

        <div className="section-title">Garçons cadastrados ({waiters.length})</div>
        {waiters.length === 0 ? (
          <div className="empty">Nenhum garçom cadastrado.</div>
        ) : (
          waiters.map((w) => {
            const wSold = bills
              .filter((b) => b.waiter_id === w.id)
              .reduce((s, b) => s + b.total_cents, 0);
            return (
              <div key={w.id} className="item-row">
                <div className="top">
                  <span className="iname">{w.name}</span>
                  <span className="iline">{brl(wSold)}</span>
                </div>
                <div className="note-line">
                  Login: {w.login} · Comissão: {w.commission_pct ?? 8}% ·
                  vendeu no total {brl(wSold)}
                </div>
                <div className="stepper">
                  <button onClick={() => startEdit(w)}>Editar</button>
                  <button
                    className="remove"
                    onClick={() => setConfirmDelete(w)}
                  >
                    Remover
                  </button>
                </div>
              </div>
            );
          })
        )}
        {confirmDelete && (
          <ConfirmModal
            title={`Remover ${confirmDelete.name}?`}
            text="O acesso dele para de funcionar. Só dá pra remover garçom sem vendas registradas."
            confirmLabel="Remover"
            onConfirm={async () => {
              const w = confirmDelete;
              setConfirmDelete(null);
              setError('');
              setBusy(true);
              try {
                await store.deleteWaiter(w.id);
                await onChanged();
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : 'Não foi possível remover.',
                );
              } finally {
                setBusy(false);
              }
            }}
            onCancel={() => setConfirmDelete(null)}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------- DONO: CARDÁPIO ------------------- */

function OwnerMenuView({
  products,
  onChanged,
  onNavigate,
  onLogout,
}: {
  products: Product[];
  onChanged: () => Promise<void>;
  onNavigate: (v: View) => void;
  onLogout: () => void;
}) {
  const [editing, setEditing] = useState<Product | null>(null);
  return (
    <div className="app">
      <OwnerHeader
        title="Cardápio"
        sub="Só o dono muda o cardápio"
        tab="menu"
        onNavigate={onNavigate}
        onLogout={onLogout}
      />
      <div className="content">
        <div className="card">
          <h2>{editing ? `Editar: ${editing.name}` : 'Novo produto'}</h2>
          <ProductForm
            products={products}
            editing={editing}
            onAdded={async () => {
              setEditing(null);
              await onChanged();
            }}
            onCancelEdit={() => setEditing(null)}
          />
        </div>
        {products.length > 0 && (
          <ProductListGrouped
            products={products}
            onDeleted={onChanged}
            onEdit={setEditing}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------- DONO: AJUSTES ------------------- */

function OwnerSettingsView({
  settings,
  onSaved,
  onNavigate,
  onLogout,
}: {
  settings: Settings;
  onSaved: () => Promise<void>;
  onNavigate: (v: View) => void;
  onLogout: () => void;
}) {
  const [fee, setFee] = useState(String(settings.service_fee_pct));
  const [commission, setCommission] = useState(
    String(settings.default_commission_pct ?? 8),
  );
  const [tables, setTables] = useState(String(settings.table_count));
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save() {
    setError('');
    setSaved(false);
    const feePct = Number(fee.replace(',', '.'));
    const commPct = Number(commission.replace(',', '.'));
    const count = Number(tables);
    if (!Number.isFinite(feePct) || feePct < 0 || feePct > 100) {
      setError('Informe uma taxa de serviço entre 0 e 100.');
      return;
    }
    if (!Number.isFinite(commPct) || commPct < 0 || commPct > 100) {
      setError('Informe uma comissão padrão entre 0 e 100.');
      return;
    }
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      setError('Informe o número de mesas (1 a 100).');
      return;
    }
    setBusy(true);
    try {
      await store.saveSettings({
        service_fee_pct: feePct,
        table_count: count,
        default_commission_pct: commPct,
      });
      await onSaved();
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível salvar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <OwnerHeader
        title="Ajustes"
        sub="Taxa de serviço e comissão"
        tab="settings"
        onNavigate={onNavigate}
        onLogout={onLogout}
      />
      <div className="content">
        {error && <div className="error">{error}</div>}
        {saved && <div className="ok-note">Ajustes salvos.</div>}
        <div className="card">
          <h2>Taxa de serviço e comissão</h2>
          <p className="hint">
            A comissão padrão vale pros garçons novos. Quem já existe mantém
            a % dele — pra mudar, edite o garçom na aba Garçons.
          </p>
          <div className="row2">
            <div className="field">
              <label htmlFor="owner-fee">Taxa de serviço (%)</label>
              <input
                id="owner-fee"
                inputMode="decimal"
                value={fee}
                onChange={(e) => setFee(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="owner-commission">Comissão padrão (%)</label>
              <input
                id="owner-commission"
                inputMode="decimal"
                value={commission}
                onChange={(e) => setCommission(e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="owner-tables">Nº de mesas</label>
            <input
              id="owner-tables"
              inputMode="numeric"
              value={tables}
              onChange={(e) => setTables(e.target.value)}
            />
          </div>
          <button className="btn btn-purple" disabled={busy} onClick={save}>
            Salvar ajustes
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <ErrorBoundary>
      <GarcomApp />
    </ErrorBoundary>
  );
}
