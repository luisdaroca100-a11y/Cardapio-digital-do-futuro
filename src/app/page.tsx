'use client';

import { Component, useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import * as store from '@/lib/store';
import {
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
  | 'menu';

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
  /** número sequencial do envio ("Pedido Nº 0001") — só kind 'send' */
  orderNumber?: number;
  /** hora do envio — só kind 'send' */
  sentAt?: string;
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
  const [tickets, setTickets] = useState<TicketData | null>(null);
  const [closedReview, setClosedReview] = useState<{
    bill: ClosedBill;
    items: OrderItem[];
    tableNumber: number;
  } | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
        const [waiters] = await Promise.all([store.listWaiters(), refresh()]);
        // Mesas abertas sem nenhum item (restos da regra antiga) voltam
        // a ficar livres.
        await store.cleanupEmptyOrders();
        await refresh();
        if (waiters.length === 0) {
          setView('setup');
          return;
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
  }, [refresh]);

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
    safeRemove(SESSION_KEY);
    setView('login');
  }

  function openTable(tableNumber: number) {
    if (!session) return;
    setError('');
    const existing = openOrders.find(
      (o) => o.order.table_number === tableNumber,
    );
    if (existing) {
      if (existing.order.waiter_id !== session.id) {
        setError(
          `A Mesa ${tableNumber} foi aberta por ${existing.order.waiter_name}. Só ele pode abrir.`,
        );
        return;
      }
      setCurrentOrder(existing);
      setOrderCategory(null);
      setOrderSearch('');
      setView(existing.items.length === 0 ? 'order' : 'summary');
      return;
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
      const bill = await store.closeOrder(
        currentOrder.order.id,
        settings.service_fee_pct,
      );
      const ow = await store.getOrderWithItems(currentOrder.order.id);
      const allItems = ow?.items ?? currentOrder.items;
      setClosedReview({
        bill,
        items: allItems,
        tableNumber: currentOrder.order.table_number,
      });
      setCurrentOrder(null);
      setTickets(null);
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
          <LoginForm busy={busy} onLogin={handleLogin} />
          <div className="mode-badge">
            {isSupabase
              ? 'Banco de dados: Supabase (nuvem)'
              : 'Banco de dados: local (neste aparelho)'}
          </div>
        </div>
      </div>
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
    const tables = Array.from(
      { length: settings.table_count },
      (_, i) => i + 1,
    );
    return (
      <div className="app">
        <header className="header">
          <div>
            <h1>Mesas</h1>
            <div className="sub">Olá, {session.name}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="icon-btn" onClick={handleLogout}>
              Sair
            </button>
          </div>
        </header>
        <div className="content">
          {error && <div className="error">{error}</div>}
          <div className="tables-grid">
            {tables.map((n) => {
              const ow = openOrders.find((o) => o.order.table_number === n);
              if (!ow) {
                return (
                  <button
                    key={n}
                    className="table-tile free"
                    disabled={busy}
                    onClick={() => openTable(n)}
                  >
                    <span className="num">Mesa {n}</span>
                    <span className="state">Livre</span>
                  </button>
                );
              }
              const mine = ow.order.waiter_id === session.id;
              const total = ow.items.reduce(
                (s, i) => s + i.price_cents * i.qty,
                0,
              );
              return (
                <button
                  key={n}
                  className={`table-tile ${mine ? 'mine' : 'other'}`}
                  disabled={busy}
                  onClick={() => openTable(n)}
                >
                  {!mine && <span className="lock">🔒</span>}
                  <span className="num">Mesa {n}</span>
                  <span className="owner">
                    {ow.order.waiter_name}
                    {mine ? ' (você)' : ''}
                  </span>
                  {mine && (
                    <>
                      <span className="total">{brl(total)}</span>
                      <span className="state">
                        {ow.items.reduce((s, i) => s + i.qty, 0)} itens ·{' '}
                        {formatTime(ow.order.created_at)}
                      </span>
                    </>
                  )}
                  {!mine && <span className="state">só ele pode abrir</span>}
                </button>
              );
            })}
          </div>
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
        <header className="header">
          <div>
            <h1>Novo Pedido - Mesa {tableNumber}</h1>
            <div className="sub">{session.name}</div>
          </div>
          <button className="icon-btn" onClick={backToTablesFromOrder}>
            ✕ Mesas
          </button>
        </header>
        <div className="content">
          <input
            className="search"
            type="search"
            placeholder="Buscar em todas categorias..."
            value={orderSearch}
            onChange={(e) => setOrderSearch(e.target.value)}
          />
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
              <div className="section-title">{orderCategory}</div>
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
                </div>
              )}
            </>
          )}
        </div>
        <div className="bottom-bar">
          <button
            className="btn btn-ghost"
            onClick={() => {
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
            VOLTAR
          </button>
          <button
            className="btn btn-green"
            disabled={pendingCount === 0}
            onClick={() => setView('summary')}
          >
            REVISAR ({pendingCount}) · {brl(pendingTotal)}
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
}: {
  products: Product[];
  onAdded: () => Promise<void>;
  disabled?: boolean;
}) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState('');
  const [printsIn, setPrintsIn] = useState<'kitchen' | 'bar'>('kitchen');
  const [drinkType, setDrinkType] = useState<DrinkType>('refrigerante');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
      await store.createProduct({
        name: name.trim(),
        price_cents: cents,
        category: category.trim(),
        prints_in: printsIn,
        drink_type: printsIn === 'bar' ? drinkType : undefined,
        description:
          printsIn === 'kitchen' && description.trim()
            ? description.trim()
            : undefined,
      });
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
        Adicionar ao cardápio
      </button>
    </div>
  );
}

function ProductListGrouped({
  products,
  onDeleted,
  readOnly,
}: {
  products: Product[];
  onDeleted: () => Promise<void>;
  readOnly?: boolean;
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
                  <button
                    onClick={async () => {
                      await store.deleteProduct(p.id);
                      await onDeleted();
                    }}
                  >
                    Remover
                  </button>
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

        {data.kitchen.length > 0 && (
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
              {data.sentAt ? formatTime(data.sentAt) : ''}
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

        {data.bar.length > 0 && (
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
              {data.sentAt ? formatTime(data.sentAt) : ''}
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
            <h3>BALCÃO — CONTA FINAL</h3>
            <div className="t-sub">
              MESA {data.tableNumber} · {data.bill.waiter_name}
            </div>
            {[...data.kitchen, ...data.bar].map((i) => (
              <div key={i.id}>
                <div className="t-line">
                  <span>
                    {i.qty}× {i.product_name}
                  </span>
                  <span>{brl(i.price_cents * i.qty)}</span>
                </div>
                {i.note && <div className="t-note">Obs.: {i.note}</div>}
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
            Adicione ou remova produtos. (No futuro, o cardápio será gerenciado
            pelo dono, no sistema dele.)
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

export default function Page() {
  return (
    <ErrorBoundary>
      <GarcomApp />
    </ErrorBoundary>
  );
}
