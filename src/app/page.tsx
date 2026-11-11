'use client';

import { Component, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import QRCode from 'qrcode';
import * as store from '@/lib/store';
import type { RestaurantSummary } from '@/lib/store';
import {
  OWNER_SESSION_KEY,
  PLATFORM_ADMIN_SESSION_KEY,
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
  Restaurant,
  Settings,
  Waiter,
} from '@/lib/types';

type View =
  | 'home'
  | 'setup'
  | 'login'
  | 'register'
  | 'register-success'
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
  | 'owner-settings'
  | 'owner-qr'
  | 'admin';

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
  /** restaurante da sessão (garçom e dono); ausente no admin */
  restaurant_id?: string;
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
  /** true quando o endereço tem ?tela=garcom (QR Code dos garçons):
   * abre só a tela de login do garçom — sem apresentação e sem os
   * links de dono, cadastro e administrador. */
  const [waiterOnly, setWaiterOnly] = useState(
    () =>
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('tela') === 'garcom',
  );
  const [view, setView] = useState<View>(() =>
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('tela') === 'garcom'
      ? 'login'
      : 'home',
  );
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
  /** tela de acesso do dono (null = login do garçom) */
  const [ownerAuth, setOwnerAuth] = useState(false);
  /** login criado no cadastro — pré-preenchido na tela de login do
   * dono quando ele vem da tela de "Cadastro realizado com sucesso" */
  const [registeredLogin, setRegisteredLogin] = useState('');
  /** nome do restaurante recém-cadastrado (tela de sucesso) */
  const [registeredRestaurantName, setRegisteredRestaurantName] =
    useState('');
  const [waiters, setWaiters] = useState<Waiter[]>([]);
  /** contas fechadas p/ o financeiro do dono */
  const [ownerBills, setOwnerBills] = useState<ClosedBill[]>([]);

  /* ------------------------------ RESTAURANTE ------------------------------ */
  /** restaurante da sessão atual (garçom ou dono) — o nome dele vai
   * no cabeçalho das vias e no topo da área do dono */
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);

  /* ------------------------------ ADMINISTRADOR DA PLATAFORMA ------------------------------ */
  /** sessão do administrador da plataforma (só o Luis) — separada de
   * garçom e de dono; sem ela, a área do administrador não abre */
  const [adminSession, setAdminSession] = useState<Session | null>(null);
  /** tela de acesso do admin: login ou criação (null = login do garçom) */
  const [adminAuth, setAdminAuth] = useState<'login' | 'setup' | null>(null);
  const [hasAdmin, setHasAdmin] = useState(false);

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
        // QR Code dos garçons (?tela=garcom): pula a apresentação e
        // abre só a tela de login do garçom — sessão de dono ou de
        // administrador não é restaurada nesse endereço.
        const onlyWaiter =
          new URLSearchParams(window.location.search).get('tela') ===
          'garcom';
        setWaiterOnly(onlyWaiter);
        setHasAdmin((await store.getPlatformAdmin()) !== null);
        if (!onlyWaiter) {
          // Sessão do administrador da plataforma tem prioridade: ele não
          // é garçom nem dono de nenhum restaurante.
          const rawAdmin = safeGet(PLATFORM_ADMIN_SESSION_KEY);
          if (rawAdmin) {
            try {
              const s = JSON.parse(rawAdmin) as Session;
              const admin = await store.findPlatformAdminByLogin(s.login);
              if (admin && admin.id === s.id) {
                setAdminSession({
                  id: admin.id,
                  name: admin.login,
                  login: admin.login,
                });
                setView('admin');
                return;
              }
            } catch {
              /* sessão inválida: vai pro login */
            }
          }
          // Sessão do dono (área financeira) tem prioridade sobre a do garçom.
          const rawOwner = safeGet(OWNER_SESSION_KEY);
          if (rawOwner) {
            try {
              const s = JSON.parse(rawOwner) as Session;
              const owner = await store.findOwnerByLogin(s.login);
              const rid = owner?.restaurant_id ?? s.restaurant_id;
              if (owner && owner.id === s.id && rid) {
                store.setActiveRestaurant(rid);
                setRestaurant(await store.getRestaurant(rid));
                setOwnerSession({
                  id: owner.id,
                  name: owner.name,
                  login: owner.login,
                  restaurant_id: rid,
                });
                await refreshOwner();
                // Restaurante novo, sem garçom ainda: primeiro acesso
                // (criar o primeiro garçom + cardápio).
                const ws = await store.listWaiters();
                setView(ws.length === 0 ? 'setup' : 'owner');
                return;
              }
            } catch {
              /* sessão inválida: vai pro login */
            }
          }
        }
        const raw = safeGet(SESSION_KEY);
        if (raw) {
          try {
            const s = JSON.parse(raw) as Session;
            const waiter = await store.findWaiterByLogin(s.login);
            const rid = waiter?.restaurant_id ?? s.restaurant_id;
            if (waiter && waiter.id === s.id && rid) {
              store.setActiveRestaurant(rid);
              setRestaurant(await store.getRestaurant(rid));
              setSession({
                id: waiter.id,
                name: waiter.name,
                login: waiter.login,
                restaurant_id: rid,
              });
              await refresh();
              // Mesas abertas sem nenhum item (restos da regra antiga)
              // voltam a ficar livres.
              await store.cleanupEmptyOrders();
              await refresh();
              setView('tables');
              return;
            }
          } catch {
            /* sessão inválida: vai pro login */
          }
        }
        // Sem sessão: o QR vai direto pro login do garçom; todo o
        // resto começa na apresentação.
        setView(onlyWaiter ? 'login' : 'home');
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

  /** Login único do formulário principal: o login é único na
   * plataforma toda — se for de garçom, abre as mesas; se for de
   * dono, abre a área do dono. Na tela do QR (?tela=garcom), só o
   * garçom entra (o login de dono não vale ali). */
  async function handleLogin(login: string, password: string) {
    setError('');
    setBusy(true);
    try {
      const result = await store.authenticate(login.trim(), password);
      if (!result) throw new Error('Login ou senha incorretos.');
      if (result.kind === 'waiter') {
        const waiter = result.user;
        if (!waiter.restaurant_id) {
          throw new Error(
            'Restaurante não identificado — peça ao dono para rodar a migração do supabase.sql.',
          );
        }
        store.setActiveRestaurant(waiter.restaurant_id);
        setRestaurant(await store.getRestaurant(waiter.restaurant_id));
        const s: Session = {
          id: waiter.id,
          name: waiter.name,
          login: waiter.login,
          restaurant_id: waiter.restaurant_id,
        };
        setSession(s);
        safeSet(SESSION_KEY, JSON.stringify(s));
        await refresh();
        setView('tables');
        return;
      }
      if (waiterOnly) throw new Error('Login ou senha incorretos.');
      await enterOwnerArea(result.user);
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
    store.setActiveRestaurant(null);
    setRestaurant(null);
    safeRemove(SESSION_KEY);
    // Na tela do QR, sair volta pro login do garçom; no resto, pra apresentação.
    setView(waiterOnly ? 'login' : 'home');
  }

  /* ------------------------------ DONO: ACESSO ------------------------------ */

  /** Entra na área do dono (área financeira) — usado pelo login
   * principal (quando o login é de dono) e pelo "Sou o dono". */
  async function enterOwnerArea(owner: Owner) {
    if (!owner.restaurant_id) {
      throw new Error(
        'Restaurante não identificado — rode a migração do supabase.sql.',
      );
    }
    store.setActiveRestaurant(owner.restaurant_id);
    setRestaurant(await store.getRestaurant(owner.restaurant_id));
    const s: Session = {
      id: owner.id,
      name: owner.name,
      login: owner.login,
      restaurant_id: owner.restaurant_id,
    };
    setOwnerSession(s);
    safeSet(OWNER_SESSION_KEY, JSON.stringify(s));
    setOwnerAuth(false);
    await refreshOwner();
    // Restaurante novo, sem garçom ainda: primeiro acesso.
    const ws = await store.listWaiters();
    setView(ws.length === 0 ? 'setup' : 'owner');
  }

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
      await enterOwnerArea(owner);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível entrar.');
    } finally {
      setBusy(false);
    }
  }

  function handleOwnerLogout() {
    setOwnerSession(null);
    setOwnerAuth(false);
    store.setActiveRestaurant(null);
    setRestaurant(null);
    safeRemove(OWNER_SESSION_KEY);
    setView(waiterOnly ? 'login' : 'home');
  }

  /* ------------------------------ CADASTRO DO RESTAURANTE ------------------------------ */

  /** Cadastro sozinho: cria o restaurante + o dono e já entra na área
   * do dono, no primeiro acesso (criar o primeiro garçom + cardápio). */
  async function handleRestaurantRegister(
    restaurantName: string,
    name: string,
    login: string,
    password: string,
  ) {
    setError('');
    setBusy(true);
    try {
      const hash = await store.hashPassword(password);
      const { restaurant, owner } = await store.registerRestaurant({
        restaurantName: restaurantName.trim(),
        ownerName: name.trim(),
        login: login.trim(),
        passwordHash: hash,
      });
      const s: Session = {
        id: owner.id,
        name: owner.name,
        login: owner.login,
        restaurant_id: restaurant.id,
      };
      setOwnerSession(s);
      setRestaurant(restaurant);
      safeSet(OWNER_SESSION_KEY, JSON.stringify(s));
      setView('setup');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível cadastrar.');
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------ ADMINISTRADOR DA PLATAFORMA ------------------------------ */

  async function handleAdminLogin(login: string, password: string) {
    setError('');
    setBusy(true);
    try {
      const admin = await store.findPlatformAdminByLogin(login.trim());
      if (!admin) throw new Error('Login ou senha incorretos.');
      const hash = await store.hashPassword(password);
      if (hash !== admin.password_hash) {
        throw new Error('Login ou senha incorretos.');
      }
      const s: Session = { id: admin.id, name: admin.login, login: admin.login };
      setAdminSession(s);
      safeSet(PLATFORM_ADMIN_SESSION_KEY, JSON.stringify(s));
      setAdminAuth(null);
      setView('admin');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível entrar.');
    } finally {
      setBusy(false);
    }
  }

  /** Primeiro acesso do administrador: cria o login dele (um só). */
  async function handleAdminCreate(login: string, password: string) {
    setError('');
    setBusy(true);
    try {
      const hash = await store.hashPassword(password);
      const admin = await store.createPlatformAdmin(login.trim(), hash);
      const s: Session = { id: admin.id, name: admin.login, login: admin.login };
      setAdminSession(s);
      setHasAdmin(true);
      safeSet(PLATFORM_ADMIN_SESSION_KEY, JSON.stringify(s));
      setAdminAuth(null);
      setView('admin');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível criar o acesso.');
    } finally {
      setBusy(false);
    }
  }

  function handleAdminLogout() {
    setAdminSession(null);
    setAdminAuth(null);
    safeRemove(PLATFORM_ADMIN_SESSION_KEY);
    setView(waiterOnly ? 'login' : 'home');
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

  /**
   * Confere no banco se o dia está encerrado (vale pra todos os
   * aparelhos — o dono pode ter finalizado o dia em outro celular).
   * O dia reabre sozinho às 9h da manhã seguinte.
   */
  async function dayClosedNow(): Promise<boolean> {
    const fresh = await store.getSettings();
    setSettings(fresh);
    return store.isDayClosed(fresh);
  }

  async function openTable(tableNumber: number) {
    if (!session) return;
    setError('');
    setMenuOpen(false);
    // Dia encerrado: o garçom só reabre uma mesa que já era dele (pra
    // fechar); mesa nova não abre — o dia reabre sozinho às 9h.
    const freshOrders = await store.listOpenOrders();
    setOpenOrders(freshOrders);
    if (await dayClosedNow()) {
      const mine = freshOrders.find(
        (o) =>
          o.order.table_number === tableNumber &&
          o.order.waiter_id === session.id &&
          o.items.length > 0,
      );
      if (!mine) {
        setError('O dia está encerrado. Reabre amanhã às 9h.');
        return;
      }
    }
    const existing = freshOrders.find(
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
    // Dia encerrado: não entra item novo — só fechar as mesas abertas.
    if (await dayClosedNow()) {
      setError(
        'O dia está encerrado. Não dá pra pedir mais — só fechar a mesa. Reabre amanhã às 9h.',
      );
      return;
    }
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
    // Dia encerrado: o pedido não muda — só fechar a mesa.
    if (await dayClosedNow()) {
      setError(
        'O dia está encerrado. Não dá pra mudar o pedido — só fechar a mesa. Reabre amanhã às 9h.',
      );
      return;
    }
    const next = item.qty + delta;
    if (next <= 0) {
      await store.removeItem(item.id);
    } else {
      await store.updateItem(item.id, { qty: next });
    }
    if (currentOrder) await refreshCurrentOrder(currentOrder.order.id);
  }

  /** Retirar um item do resumo (também travado com o dia encerrado). */
  async function removeOrderItem(itemId: string) {
    if (await dayClosedNow()) {
      setError(
        'O dia está encerrado. Não dá pra mudar o pedido — só fechar a mesa. Reabre amanhã às 9h.',
      );
      return;
    }
    await store.removeItem(itemId);
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
    // Dia encerrado: não envia pedido novo pra cozinha/bar.
    if (await dayClosedNow()) {
      setError(
        'O dia está encerrado. Não dá pra enviar pedido novo. Reabre amanhã às 9h.',
      );
      return;
    }
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

  /* ------------------------------ APRESENTAÇÃO (PRIMEIRA TELA) ------------------------------ */

  if (view === 'home') {
    return (
      <HomeView
        onLogin={() => setView('login')}
        onRegister={() => setView('register')}
      />
    );
  }

  /* ------------------------------ SETUP ------------------------------ */

  if (view === 'setup') {
    return (
      <SetupView
        products={products}
        onProductsChanged={refresh}
        onDone={() => {
          // Dono recém-cadastrado volta pra área dele; garçom vai pro login.
          setView(ownerSession ? 'owner' : 'login');
        }}
      />
    );
  }

  /* ------------------------------ CADASTRO DO RESTAURANTE ------------------------------ */

  if (view === 'register') {
    return (
      <div className="app">
        <div className="hero">
          <h1>Cadastrar meu restaurante</h1>
          <p>
            Crie o seu restaurante e o seu acesso de dono. Por enquanto o
            acesso é liberado no cadastro, sem pagamento.
          </p>
        </div>
        <div className="content">
          {error && <div className="error">{error}</div>}
          <RegisterRestaurantView
            busy={busy}
            onRegister={handleRestaurantRegister}
            onCancel={() => setView('home')}
          />
          <div className="mode-badge">
            {isSupabase
              ? 'Banco de dados: Supabase (nuvem)'
              : 'Banco de dados: local (neste aparelho)'}
          </div>
        </div>
      </div>
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
              busy={busy}
              onLogin={handleOwnerLogin}
              onCancel={() => setOwnerAuth(false)}
            />
          ) : adminAuth ? (
            <AdminAuthView
              mode={adminAuth}
              busy={busy}
              onLogin={handleAdminLogin}
              onCreate={handleAdminCreate}
              onCancel={() => setAdminAuth(null)}
            />
          ) : (
            <>
              <LoginForm busy={busy} onLogin={handleLogin} />
              {/* Na tela do QR (?tela=garcom) só aparece o login do
                  garçom — sem "Sou o dono", sem cadastro e sem a área
                  do administrador. */}
              {!waiterOnly && (
                <>
                  <button
                    className="owner-link"
                    onClick={() => setOwnerAuth(true)}
                  >
                    Sou o dono
                  </button>
                  <button
                    className="owner-link"
                    onClick={() => setView('register')}
                  >
                    Cadastrar meu restaurante
                  </button>
                  <button
                    className="owner-link admin-link"
                    onClick={() =>
                      setAdminAuth(hasAdmin ? 'login' : 'setup')
                    }
                  >
                    Área do administrador
                  </button>
                </>
              )}
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

  /* ------------------------------ ÁREA DO ADMINISTRADOR ------------------------------ */

  if (view === 'admin' && adminSession) {
    return (
      <PlatformAdminView
        onLogout={handleAdminLogout}
      />
    );
  }

  /* ------------------------------ ÁREA DO DONO ------------------------------ */

  if (view === 'owner' && ownerSession) {
    return (
      <OwnerDashboardView
        bills={ownerBills}
        waiters={waiters}
        settings={settings}
        restaurantName={restaurant?.name ?? ''}
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
        restaurantName={restaurant?.name ?? ''}
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
        restaurantName={restaurant?.name ?? ''}
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
        restaurantName={restaurant?.name ?? ''}
        onSaved={refreshOwner}
        onNavigate={setView}
        onLogout={handleOwnerLogout}
      />
    );
  }

  /* ------------------------------ DONO: QR CODE DOS GARÇONS ------------------------------ */

  if (view === 'owner-qr' && ownerSession) {
    return (
      <OwnerQrView
        restaurantName={restaurant?.name ?? ''}
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
    // Dia encerrado pelo dono: mesa nova não abre — só fechar as que já
    // estavam abertas. Reabre sozinho amanhã às 9h.
    const dayClosed = store.isDayClosed(settings);
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
          {dayClosed && (
            <div className="error">
              Dia encerrado — não dá pra abrir mesa nova nem fazer pedido
              novo. Mesas abertas ainda podem ser fechadas. Reabre amanhã
              às 9h.
            </div>
          )}
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
                disabled={busy || dayClosed}
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
                await removeOrderItem(item.id);
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
            restaurantName={restaurant?.name ?? 'Restaurante'}
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
            restaurantName={restaurant?.name ?? 'Restaurante'}
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
  restaurantName,
  onClose,
}: {
  data: TicketData;
  products: Product[];
  /** nome do restaurante no cabeçalho das vias */
  restaurantName: string;
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
              <span className="t-name">{restaurantName}</span>
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
              <span className="t-name">{restaurantName}</span>
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
              <span className="t-name">{restaurantName}</span>
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

/** Acesso do dono: login na área financeira. O dono novo se cadastra
 * em "Cadastrar meu restaurante", na tela de login. */
function OwnerAuthView({
  busy,
  onLogin,
  onCancel,
}: {
  busy: boolean;
  onLogin: (login: string, password: string) => void;
  onCancel: () => void;
}) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  function submit() {
    if (!login.trim() || !password) {
      setError('Preencha o usuário e a senha.');
      return;
    }
    onLogin(login, password);
  }

  return (
    <div className="card">
      <h2>Área do dono</h2>
      <p className="hint">Entre com o seu usuário para ver o financeiro.</p>
      {error && <div className="error">{error}</div>}
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
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Sua senha"
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
      </div>
      <button className="btn btn-purple" disabled={busy} onClick={submit}>
        Entrar no financeiro
      </button>
      <div style={{ height: 10 }} />
      <button className="btn btn-ghost" onClick={onCancel}>
        Voltar ao login do garçom
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Cadastro do restaurante (self-service)                              */
/* ------------------------------------------------------------------ */

function RegisterRestaurantView({
  busy,
  onRegister,
  onCancel,
}: {
  busy: boolean;
  onRegister: (
    restaurantName: string,
    name: string,
    login: string,
    password: string,
  ) => void;
  onCancel: () => void;
}) {
  const [restaurantName, setRestaurantName] = useState('');
  const [name, setName] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  function submit() {
    if (!restaurantName.trim() || !name.trim() || !login.trim()) {
      setError('Preencha o nome do restaurante, o seu nome e o usuário.');
      return;
    }
    if (password.length < 4) {
      setError('A senha precisa ter no mínimo 4 caracteres.');
      return;
    }
    onRegister(restaurantName, name, login, password);
  }

  return (
    <div className="card">
      <h2>Seu restaurante</h2>
      <p className="hint">
        O login do dono é único na plataforma toda — se já existir um
        acesso com esse usuário, escolha outro.
      </p>
      {error && <div className="error">{error}</div>}
      <div className="field">
        <label htmlFor="reg-restaurant">Nome do restaurante</label>
        <input
          id="reg-restaurant"
          value={restaurantName}
          onChange={(e) => setRestaurantName(e.target.value)}
          placeholder="Ex.: Gosto Caseiro"
        />
      </div>
      <div className="field">
        <label htmlFor="reg-name">Seu nome</label>
        <input
          id="reg-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex.: Luis"
        />
      </div>
      <div className="field">
        <label htmlFor="reg-login">Usuário (só você sabe)</label>
        <input
          id="reg-login"
          autoComplete="username"
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          placeholder="Seu usuário"
        />
      </div>
      <div className="field">
        <label htmlFor="reg-password">Senha</label>
        <input
          id="reg-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Sua senha"
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
      </div>
      <button className="btn btn-purple" disabled={busy} onClick={submit}>
        Cadastrar meu restaurante
      </button>
      <div style={{ height: 10 }} />
      <button className="btn btn-ghost" onClick={onCancel}>
        Voltar ao login
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Área do administrador da plataforma                                 */
/* ------------------------------------------------------------------ */

/** Acesso do administrador: login ou primeiro acesso (cria o login dele). */
function AdminAuthView({
  mode,
  busy,
  onLogin,
  onCreate,
  onCancel,
}: {
  mode: 'login' | 'setup';
  busy: boolean;
  onLogin: (login: string, password: string) => void;
  onCreate: (login: string, password: string) => void;
  onCancel: () => void;
}) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  function submit() {
    if (!login.trim() || !password) {
      setError('Preencha o usuário e a senha.');
      return;
    }
    if (mode === 'setup' && password.length < 4) {
      setError('A senha precisa ter no mínimo 4 caracteres.');
      return;
    }
    if (mode === 'setup') onCreate(login, password);
    else onLogin(login, password);
  }

  return (
    <div className="card">
      <h2>Área do administrador</h2>
      <p className="hint">
        {mode === 'setup'
          ? 'Primeiro acesso: crie o seu login de administrador da plataforma. Ele é só seu.'
          : 'Entre com o seu login de administrador da plataforma.'}
      </p>
      {error && <div className="error">{error}</div>}
      <div className="field">
        <label htmlFor="admin-login">Usuário (só você sabe)</label>
        <input
          id="admin-login"
          autoComplete="username"
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          placeholder="Seu usuário"
        />
      </div>
      <div className="field">
        <label htmlFor="admin-password">Senha</label>
        <input
          id="admin-password"
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
        {mode === 'setup' ? 'Criar acesso do administrador' : 'Entrar'}
      </button>
      <div style={{ height: 10 }} />
      <button className="btn btn-ghost" onClick={onCancel}>
        Voltar ao login do garçom
      </button>
    </div>
  );
}

/**
 * Lista de restaurantes cadastrados — SÓ cadastro: nome do restaurante,
 * nome do dono, data do cadastro e número de garçons. NENHUM dado
 * financeiro: o administrador não vê vendas, valores nem comissões.
 */
function PlatformAdminView({ onLogout }: { onLogout: () => void }) {
  const [summaries, setSummaries] = useState<RestaurantSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setSummaries(await store.listRestaurantSummaries());
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Não foi possível carregar os restaurantes.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Área do administrador</h1>
          <div className="sub">Restaurantes cadastrados na plataforma</div>
        </div>
        <button className="icon-btn" onClick={onLogout}>
          Sair
        </button>
      </header>
      <div className="content">
        {error && <div className="error">{error}</div>}
        {loading ? (
          <div className="loading">Carregando os restaurantes…</div>
        ) : summaries.length === 0 ? (
          <div className="empty">Nenhum restaurante cadastrado ainda.</div>
        ) : (
          <>
            <div className="section-title">
              Restaurantes ({summaries.length})
            </div>
            {summaries.map((s) => (
              <div key={s.restaurant.id} className="item-row">
                <div className="top">
                  <span className="iname">{s.restaurant.name}</span>
                  <span className="iline">
                    {s.waiterCount === 1
                      ? '1 garçom'
                      : `${s.waiterCount} garçons`}
                  </span>
                </div>
                <div className="note-line">
                  Dono: {s.ownerName} · Cadastrado em{' '}
                  {formatDateTime(s.restaurant.created_at)}
                </div>
              </div>
            ))}
          </>
        )}
        <div style={{ height: 12 }} />
        <button className="btn btn-ghost" onClick={() => void load()}>
          Atualizar
        </button>
      </div>
    </div>
  );
}

type OwnerTab = 'dashboard' | 'waiters' | 'menu' | 'settings' | 'qr';

/** Cabeçalho da área do dono + abas (Dashboard, Garçons, Cardápio, Ajustes). */
function OwnerHeader({
  title,
  sub,
  tab,
  restaurantName,
  onNavigate,
  onLogout,
}: {
  title: string;
  sub?: string;
  tab: OwnerTab;
  restaurantName?: string;
  onNavigate: (v: View) => void;
  onLogout: () => void;
}) {
  return (
    <>
      <header className="header">
        <div>
          <h1>{title}</h1>
          {sub && (
            <div className="sub">
              {sub}
              {restaurantName ? ` · ${restaurantName}` : ''}
            </div>
          )}
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
        <button
          className={tab === 'qr' ? 'on' : ''}
          onClick={() => onNavigate('owner-qr')}
        >
          QR Code
        </button>
      </div>
    </>
  );
}

/* ------------------- APRESENTAÇÃO (PRIMEIRA TELA) ------------------- */

/** Primeira tela do sistema: explica como funciona, mostra os planos
 * e o cadastro. Só tem o botão "Cadastrar meu restaurante" — quem já
 * tem conta entra pelo link pequeno e discreto no rodapé ("Já tem uma
 * conta? Entrar"). O QR Code dos garçons (?tela=garcom) não passa
 * por aqui: vai direto pro login do garçom. */
function HomeView({
  onLogin,
  onRegister,
}: {
  onLogin: () => void;
  onRegister: () => void;
}) {
  // O botão flutuante de WhatsApp fica fixo no canto inferior direito
  // e cobria o preço do plano Anual quando a grade de planos passava
  // por baixo dele. Enquanto a grade estiver na faixa do botão
  // (~76px do fim da tela), o botão se esconde — o preço dos dois
  // planos fica sempre legível ao rolar.
  const plansRef = useRef<HTMLDivElement | null>(null);
  const [hideWa, setHideWa] = useState(false);
  useEffect(() => {
    const update = () => {
      const el = plansRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setHideWa(
        r.bottom > window.innerHeight - 76 && r.top < window.innerHeight,
      );
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  return (
    <div className="app">
      <div className="hero">
        <h1>Sistema do Garçom</h1>
        <p>Pedidos, mesas e financeiro num só lugar.</p>
      </div>
      <div className="content home">
        <button
          className="btn btn-orange home-cta"
          onClick={onRegister}
        >
          Cadastrar meu restaurante
        </button>

        <div className="section-title">Como funciona</div>
        <div className="steps">
          <div className="step">
            <strong>1 · O garçom anota o pedido no celular</strong>
            <span>
              Mesas numeradas, busca do produto, só quem abriu a mesa mexe
              nela.
            </span>
          </div>
          <div className="step">
            <strong>2 · O pedido vai direto pra cozinha e pro bar</strong>
            <span>
              Prato imprime na cozinha sem valor; bebida imprime no bar com
              o jeito de servir.
            </span>
          </div>
          <div className="step">
            <strong>3 · Ao fechar a mesa, a conta vai pro balcão</strong>
            <span>
              A venda cai sozinha no financeiro, com a comissão do garçom
              já calculada.
            </span>
          </div>
          <div className="step">
            <strong>4 · O dono acompanha tudo</strong>
            <span>
              Vendas por garçom, comissão de cada um e botão de finalizar o
              dia (o dia reabre sozinho às 9h).
            </span>
          </div>
        </div>

        <div className="section-title">Planos</div>
        <p className="hint">
          Cadastre seu restaurante e use <strong>3 dias grátis</strong>.
          Depois, escolha o plano:
        </p>
        <div className="plan-grid" ref={plansRef}>
          <div className="plan-card">
            <strong>Mensal</strong>
            <span className="plan-price">R$ 69,99/mês</span>
            <span>Suporte 24 horas</span>
          </div>
          <div className="plan-card featured">
            <strong>Anual</strong>
            <span className="plan-price">R$ 499,99/ano</span>
            <span>Suporte 24 horas</span>
          </div>
        </div>

        <div className="section-title">Dúvidas frequentes</div>
        <div className="card">
          <h3>Quem cadastra o cardápio e os garçons?</h3>
          <p className="hint">
            Só o dono, na área dele. O garçom só recebe o login e a senha
            pra entrar nas mesas.
          </p>
          <h3>Outro restaurante consegue ver minhas vendas?</h3>
          <p className="hint">
            Não. Cada restaurante vê só os dados dele — garçons, cardápio,
            mesas e financeiro separados.
          </p>
          <h3>E se o cliente pedir mais depois de fechar a conta?</h3>
          <p className="hint">
            O garçom reabre a mesma mesa e continua o pedido normal.
          </p>
          <h3>Quanto custa?</h3>
          <p className="hint">
            3 dias grátis. Depois, R$ 69,99 por mês ou R$ 499,99 por ano —
            os dois com suporte 24 horas.
          </p>
        </div>

        <button
          className="btn btn-orange home-cta"
          onClick={onRegister}
        >
          Cadastrar meu restaurante
        </button>

        <div className="home-footer">
          <button className="owner-link" onClick={onLogin}>
            Já tem uma conta? Entrar
          </button>
        </div>
      </div>

      <a
        className={hideWa ? 'wa-float wa-hidden' : 'wa-float'}
        href="https://wa.me/5519971995144?text=Ol%C3%A1!%20Quero%20saber%20mais%20sobre%20o%20sistema%20do%20restaurante."
        target="_blank"
        rel="noreferrer"
        aria-label="Falar no WhatsApp"
        aria-hidden={hideWa}
        tabIndex={hideWa ? -1 : 0}
      >
        💬
      </a>
    </div>
  );
}

/* ------------------- DONO: DASHBOARD FINANCEIRO ------------------- */

function OwnerDashboardView({
  bills,
  waiters,
  settings,
  restaurantName,
  onNavigate,
  onLogout,
  onRefresh,
}: {
  bills: ClosedBill[];
  waiters: Waiter[];
  settings: Settings;
  restaurantName: string;
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

  /* ------------------- FINALIZAR DIA ------------------- */
  const dayClosed = store.isDayClosed(settings);
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [busyDay, setBusyDay] = useState(false);
  const [dayMsg, setDayMsg] = useState<{ text: string; error?: boolean } | null>(null);
  // Resumo de hoje — quanto pagar pra cada garçom (vendeu, % e comissão).
  const todayBills = filterBills(bills, 'today');
  const todaySold = todayBills.reduce((s, b) => s + b.total_cents, 0);
  const todayCommission = todayBills.reduce(
    (s, b) => s + (b.commission_cents ?? 0),
    0,
  );
  const todayRestaurant = todaySold - todayCommission;
  const todayByWaiter = waiters
    .map((w) => {
      const wb = todayBills.filter((b) => b.waiter_id === w.id);
      return {
        waiter: w,
        sold: wb.reduce((s, b) => s + b.total_cents, 0),
        comm: wb.reduce((s, b) => s + (b.commission_cents ?? 0), 0),
        pct: w.commission_pct ?? 8,
      };
    })
    .filter((x) => x.sold > 0);

  async function finalize() {
    setBusyDay(true);
    try {
      await store.finalizeDay();
      setConfirmFinalize(false);
      setDayMsg({
        text: 'Dia finalizado. Os garçons não conseguem abrir mesa nova nem fazer pedido novo — reabre amanhã às 9h.',
      });
      await onRefresh();
    } catch {
      setDayMsg({
        text: 'Não foi possível finalizar o dia. Tente de novo.',
        error: true,
      });
    } finally {
      setBusyDay(false);
    }
  }

  async function reopen() {
    setBusyDay(true);
    try {
      await store.reopenDay();
      setDayMsg({ text: 'Dia reaberto.' });
      await onRefresh();
    } catch {
      setDayMsg({
        text: 'Não foi possível reabrir o dia. Tente de novo.',
        error: true,
      });
    } finally {
      setBusyDay(false);
    }
  }

  return (
    <div className="app">
      <OwnerHeader
        title="Área do dono"
        sub="Financeiro do restaurante"
        tab="dashboard"
        restaurantName={restaurantName}
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
        <div style={{ height: 10 }} />
        {dayMsg && (
          <div className={dayMsg.error ? 'error' : 'ok-note'}>{dayMsg.text}</div>
        )}
        {dayClosed ? (
          <>
            <div className="error">
              Dia encerrado — os garçons não conseguem abrir mesa nova nem
              fazer pedido novo. Mesas abertas ainda podem ser fechadas.
              Reabre sozinho amanhã às 9h.
            </div>
            <button
              className="btn btn-purple"
              disabled={busyDay}
              onClick={() => void reopen()}
            >
              Reabrir dia
            </button>
          </>
        ) : (
          <button
            className="btn btn-purple"
            disabled={busyDay}
            onClick={() => setConfirmFinalize(true)}
          >
            Finalizar dia
          </button>
        )}
      </div>

      {confirmFinalize && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3 style={{ marginTop: 0 }}>Finalizar o dia?</h3>
            <p className="hint">
              Resumo de hoje — quanto pagar pra cada garçom. Depois de
              finalizar, os garçons não conseguem abrir mesa nova nem fazer
              pedido novo. Mesas abertas ainda podem ser fechadas. O dia
              reabre sozinho amanhã às 9h.
            </p>
            <div className="stat-grid">
              <div className="stat-card">
                <span>Total vendido hoje</span>
                <strong>{brl(todaySold)}</strong>
              </div>
              <div className="stat-card">
                <span>A pagar aos garçons</span>
                <strong>{brl(todayCommission)}</strong>
              </div>
              <div className="stat-card">
                <span>Fica pro restaurante</span>
                <strong>{brl(todayRestaurant)}</strong>
              </div>
            </div>
            <div className="section-title">
              Quanto pagar pra cada garçom
            </div>
            {todayByWaiter.length === 0 ? (
              <div className="empty">Nenhuma venda hoje.</div>
            ) : (
              todayByWaiter.map((x) => (
                <div key={x.waiter.id} className="item-row">
                  <div className="top">
                    <span className="iname">{x.waiter.name}</span>
                    <span className="iline">a receber {brl(x.comm)}</span>
                  </div>
                  <div className="note-line">
                    Vendeu {brl(x.sold)} · comissão {x.pct}% · restaurante{' '}
                    {brl(x.sold - x.comm)}
                  </div>
                </div>
              ))
            )}
            <div style={{ height: 12 }} />
            <button
              className="btn btn-green"
              disabled={busyDay}
              onClick={() => void finalize()}
            >
              Finalizar dia
            </button>
            <div style={{ height: 10 }} />
            <button
              className="btn btn-ghost"
              onClick={() => setConfirmFinalize(false)}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------- DONO: GARÇONS ------------------- */

function OwnerWaitersView({
  waiters,
  bills,
  defaultPct,
  restaurantName,
  onChanged,
  onNavigate,
  onLogout,
}: {
  waiters: Waiter[];
  bills: ClosedBill[];
  defaultPct: number;
  restaurantName: string;
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
        restaurantName={restaurantName}
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
  restaurantName,
  onChanged,
  onNavigate,
  onLogout,
}: {
  products: Product[];
  restaurantName: string;
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
        restaurantName={restaurantName}
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
  restaurantName,
  onSaved,
  onNavigate,
  onLogout,
}: {
  settings: Settings;
  restaurantName: string;
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
        restaurantName={restaurantName}
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

/* ------------------- DONO: QR CODE DOS GARÇONS ------------------- */

/** Seção "QR Code dos garçons" na área do dono: o QR é gerado no
 * próprio app (biblioteca `qrcode`, sem serviço externo) e codifica o
 * endereço do sistema com ?tela=garcom. O garçom escaneia com o
 * celular e cai direto na tela de login dele — só login e senha. */
function OwnerQrView({
  restaurantName,
  onNavigate,
  onLogout,
}: {
  restaurantName: string;
  onNavigate: (v: View) => void;
  onLogout: () => void;
}) {
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [qrError, setQrError] = useState('');
  // O endereço é o do sistema onde ele está rodando (em produção, o
  // da Vercel) — o QR sempre aponta pro endereço certo.
  const url =
    typeof window !== 'undefined'
      ? store.waiterLoginUrl(window.location.origin)
      : '';

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const dataUrl = await QRCode.toDataURL(url, {
          width: 280,
          margin: 1,
        });
        if (alive) setQrDataUrl(dataUrl);
      } catch {
        if (alive) setQrError('Não foi possível gerar o QR Code.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [url]);

  return (
    <div className="app">
      <OwnerHeader
        title="QR Code dos garçons"
        sub="Acesso do garçom"
        tab="qr"
        restaurantName={restaurantName}
        onNavigate={onNavigate}
        onLogout={onLogout}
      />
      <div className="content">
        <div className="card">
          <h2>QR Code dos garçons</h2>
          <p className="hint">
            Imprima e deixe no restaurante: o garçom escaneia com o celular
            e cai direto na tela de login dele — só login e senha, sem os
            links de dono, cadastro e administrador. O QR só abre a tela;
            a senha continua protegendo o acesso.
          </p>
          {qrError && <div className="error">{qrError}</div>}
          {qrDataUrl ? (
            <img
              className="qr-img"
              src={qrDataUrl}
              alt="QR Code de acesso do garçom"
            />
          ) : (
            !qrError && <div className="loading">Gerando o QR Code…</div>
          )}
          <p className="hint">Endereço do QR: {url}</p>
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
