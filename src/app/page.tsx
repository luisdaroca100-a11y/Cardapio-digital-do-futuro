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
  PlanId,
  PrinterBridge,
  PrinterConfig,
  PrinterConnection,
  PrinterSector,
  PrintJob,
  PrintJobItem,
  PrintJobVia,
  Product,
  Restaurant,
  Settings,
  Waiter,
} from '@/lib/types';
import {
  buildEscPosSlip,
  buildEscPosTestSlip,
  decodeEscPosText,
  sectorLabel,
} from '@/lib/escpos';
import { LANDING_HERO_POSTER, LANDING_HERO_VIDEO, LANDING_PRINTS } from '@/lib/landing-media';

type View =
  | 'home'
  | 'login'
  | 'register'
  | 'register-success'
  | 'tables'
  | 'order'
  | 'serve'
  | 'summary'
  | 'settings'
  | 'review'
  | 'menu'
  | 'owner'
  | 'owner-waiters'
  | 'owner-menu'
  | 'owner-settings'
  | 'print-center'
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

/** Data curta dd/mm/aaaa — usada no prazo do período grátis do admin. */
function formatDate(d: string | Date): string {
  try {
    return new Date(d).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
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

interface PrintedVia {
  id: string;
  orderId: string;
  station: 'Cozinha' | 'Bar' | 'Balcão — conta';
  count: number;
  time: string;
  ticket: TicketData;
}

/** Produtos pausados pelo dono: guardados no aparelho, por
 * restaurante — pausar não muda o banco nem o cardápio, só esconde
 * o produto da tela de pedir do garçom. */
const PAUSED_KEY_PREFIX = 'paused_products_v1_';

function loadPausedIds(restaurantId: string | null): Set<string> {
  if (!restaurantId) return new Set();
  try {
    const raw = safeGet(PAUSED_KEY_PREFIX + restaurantId);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
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

/* ------------------------------------------------------------------ */
/* TUTORIAL DO GARÇOM (Parte 4) — tour guiado nas telas de verdade   */
/*                                                                    */
/* O tour anda pelas telas reais do garçom (mesas → pedido → como     */
/* servir → resumo → revisar → fechar mesa) com um balão curto por    */
/* passo. O pedido mostrado é SÓ EM MEMÓRIA (id vazio, como o        */
/* rascunho de mesa aberta sem item): nenhuma função do tour chama   */
/* store.createOrder / addItem / sendOrder / closeOrder — nada é      */
/* gravado, nenhuma mesa trava de verdade, nada vai pra cozinha,     */
/* bar ou balcão. Ao terminar ou pular, o garçom cai na grade de      */
/* Mesas limpa. O "visto" é guardado no aparelho, por login do        */
/* garçom — em outro celular o tour aparece de novo.                  */
/* ------------------------------------------------------------------ */

/** Chave do "visto" no aparelho, por login do garçom. */
const TOUR_SEEN_PREFIX = 'tutorial_garcom_visto_v1_';

/** Quantidade de passos do tour. */
const TOUR_STEP_COUNT = 7;

type TourStep = {
  id: string;
  title: string;
  text: string;
  /** tela real que o passo mostra */
  view: View;
  /** seletores do elemento destacado (tenta em ordem) */
  selectors: string[];
  /** 'top' quando o destacado fica na barra de baixo (REVISAR /
   * Fechar mesa): o balão vai pra cima pra não cobrir o botão */
  balloon: 'top' | 'bottom';
};

/** Textos do tour — curtos, diretos, no tom do sistema. O passo
 * "como servir" muda conforme o tipo da bebida de demonstração. */
function getTourSteps(drinkType: DrinkType): TourStep[] {
  const serveText =
    drinkType === 'cerveja'
      ? 'Bebida sempre pergunta como vai ser servida. Cerveja pergunta se precisa de copos e quantos — se não precisar, entra como "sem copos". A escolha vai na via do bar.'
      : drinkType === 'torre'
        ? 'Bebida sempre pergunta como vai ser servida. Torre de chopp pergunta quantas canecas vão precisar. A escolha vai na via do bar.'
        : 'Bebida sempre pergunta como vai ser servida: são 4 quadradinhos — copo com limão e gelo, só limão, só gelo ou só copo. A escolha vai na via do bar.';
  return [
    {
      id: 'mesas',
      title: 'Suas mesas',
      text: 'Aqui você vê todas as mesas. Em cima, os pedidos em andamento: verde é mesa sua; laranja com cadeado é de outro garçom — essa você não abre. Embaixo, as mesas livres, em cinza, com ABRIR.',
      view: 'tables',
      selectors: ['[data-tour="mesas-livres"]', '[data-tour="mesas-livres-titulo"]'],
      balloon: 'bottom',
    },
    {
      id: 'abrir-mesa',
      title: 'Abrir uma mesa',
      text: 'Toque em ABRIR numa mesa livre pra começar o pedido. Só quem abre a mesa mexe nela depois — e a mesa só fica ocupada quando você adicionar o primeiro item.',
      view: 'tables',
      selectors: ['[data-tour="mesa-livre"]', '[data-tour="mesas-livres-titulo"]'],
      balloon: 'bottom',
    },
    {
      id: 'buscar-produto',
      title: 'Buscar o produto',
      text: 'Na tela do pedido, use a busca pra achar o produto pelo nome, ou toque numa categoria laranja. O cliente escolhe no cardápio de papel e você anota aqui.',
      view: 'order',
      selectors: ['[data-tour="busca-produto"]'],
      balloon: 'bottom',
    },
    {
      id: 'como-servir',
      title: 'Como servir a bebida',
      text: serveText,
      view: 'serve',
      selectors: ['[data-tour="opcoes-servir"]'],
      balloon: 'bottom',
    },
    {
      id: 'resumo',
      title: 'Resumo do pedido',
      text: 'Aqui você confere tudo antes de enviar: toque em + ou − pra mudar a quantidade, em Retirar pra tirar um item, e em "Adicionar produtos" pra pedir mais.',
      view: 'summary',
      selectors: ['[data-tour="resumo-item"]', '[data-tour="adicionar-produtos"]'],
      balloon: 'bottom',
    },
    {
      id: 'revisar',
      title: 'Revisar antes de enviar',
      text: 'Antes de mandar pra cozinha ou pro bar, toque em REVISAR pra conferir o resumo. Nada vai pra cozinha sem você revisar.',
      view: 'order',
      selectors: ['[data-tour="btn-revisar"]'],
      balloon: 'top',
    },
    {
      id: 'fechar-mesa',
      title: 'Fechar a mesa',
      text: 'Com tudo enviado, toque em Fechar mesa: a conta completa sai na impressora do balcão e depois você vê a revisão do que tinha na mesa. A mesa fica livre de novo.',
      view: 'summary',
      selectors: ['[data-tour="btn-fechar-mesa"]'],
      balloon: 'top',
    },
  ];
}

/** Categoria especial: mostra todos os produtos. */
const ALL_PRODUCTS = '__todos__';

/** true quando o endereço pede só o login do garçom (QR Code dos
 * garçons): ?acesso=garcom (igual ao artefato) ou ?tela=garcom
 * (links antigos continuam funcionando). Abre só a tela de login
 * do garçom — sem apresentação e sem os links de dono, cadastro e
 * administrador. */
function isWaiterOnlyParam(): boolean {
  if (typeof window === 'undefined') return false;
  const q = new URLSearchParams(window.location.search);
  return q.get('acesso') === 'garcom' || q.get('tela') === 'garcom';
}

/** true quando o endereço é a entrada escondida do administrador:
/adm. Não há link visível pra cá em lugar nenhum do site — só quem
conhece o endereço chega. Abre o login do administrador (primeiro
acesso cria o login dele); com sessão válida, abre o painel direto. */
function isAdminPath(): boolean {
  if (typeof window === 'undefined') return false;
  const p = window.location.pathname.replace(/\/+$/, '');
  return p === '/adm';
}

/** true quando o endereço pede a central de impressão:
 * ?central=impressao — o aparelho do balcão (computador ou celular
 * velho) abre direto nela quando o dono já está logado; sem sessão
 * de dono, cai no login do dono. */
function isPrintCenterParam(): boolean {
  if (typeof window === 'undefined') return false;
  const q = new URLSearchParams(window.location.search);
  return q.get('central') === 'impressao';
}

/** Rótulo do setor da impressora na tela. */
function printerSectorLabel(sector: PrinterSector): string {
  return sector === 'kitchen'
    ? 'Cozinha'
    : sector === 'bar'
      ? 'Bar'
      : 'Balcão — conta';
}

/** Rótulo da ligação da impressora na tela. */
function printerConnectionLabel(c: PrinterConnection): string {
  return c === 'usb' ? 'USB' : c === 'bluetooth' ? 'Bluetooth' : 'Wi-Fi ou rede';
}

/** Rótulo da ponte (quem leva a via até a impressora). */
function printerBridgeLabel(b: PrinterBridge): string {
  return b === 'computer' ? 'Computador do balcão' : 'Celular na central';
}

/** Rótulo de por onde a via saiu (no registro de impressas). */
function printViaLabel(via: PrintJobVia | null | undefined): string {
  return via === 'computer'
    ? 'Computador'
    : via === 'phone'
      ? 'Celular (Bluetooth)'
      : via === 'simulation'
        ? 'Simulação'
        : '—';
}

function GarcomApp() {
  const [waiterOnly, setWaiterOnly] = useState(() => isWaiterOnlyParam());
  const [view, setView] = useState<View>(() =>
    isWaiterOnlyParam() || isAdminPath() ? 'login' : 'home',
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
  /** quantidade (copos p/ cerveja, canecas p/ torre) — padrão 2 */
  const [serveQty, setServeQty] = useState(2);
  const [orderCategory, setOrderCategory] = useState<string | null>(null);
  const [orderSearch, setOrderSearch] = useState('');
  /** busca por número na tela de mesas ("Digite o nº da mesa/comanda...") */
  const [tableSearch, setTableSearch] = useState('');
  /** mesa abrindo agora (o quadrado mostra "Abrindo…" enquanto abre) */
  const [openingTable, setOpeningTable] = useState<number | null>(null);
  /** menu hambúrguer da tela de mesas (Revisão / Sair) */
  const [menuOpen, setMenuOpen] = useState(false);
  /** tutorial do garçom (Parte 4): passo atual (0..6) ou null
   * (tour desligado). Só vale pro garçom — nunca pro dono, /adm ou
   * apresentação. */
  const [tour, setTour] = useState<number | null>(null);
  /** elemento destacado pelo tour (p/ remover o anel ao trocar de
   * passo ou ao terminar) */
  const tourTargetRef = useRef<HTMLElement | null>(null);
  /** contas fechadas p/ a tela de Revisão */
  const [closedBills, setClosedBills] = useState<ClosedBill[]>([]);
  /** itens + hora de abertura de cada conta fechada (p/ a Revisão
   * mostrar "N itens" no cartão e o detalhe ao expandir) */
  const [billDetails, setBillDetails] = useState<
    Record<string, { items: OrderItem[]; openedAt: string }>
  >({});
  /** nº sequencial da conta ("Pedido Nº") — só existe p/ a conta que
   * acabou de fechar neste aparelho; conta antiga mostra "—" */
  const [billNumbers, setBillNumbers] = useState<Record<string, number>>({});
  /** conta expandida na Revisão (e a recém-fechada, em destaque) */
  const [expandedBillId, setExpandedBillId] = useState<string | null>(null);
  const [highlightedBillId, setHighlightedBillId] = useState<string | null>(
    null,
  );
  /** vias impressas da mesa aberta (p/ reabrir o cupom no resumo) */
  const [printedVias, setPrintedVias] = useState<PrintedVia[]>([]);
  /** cupom aberto no modal "Via impressa" (a partir da lista de vias) */
  const [viewTicket, setViewTicket] = useState<TicketData | null>(null);
  /** produtos pausados pelo dono (não aparecem na tela de pedir) —
   * guardados neste aparelho, sem mudar o banco */
  const [pausedIds, setPausedIds] = useState<Set<string>>(new Set());
  const [tickets, setTickets] = useState<TicketData | null>(null);
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
  /** plano escolhido no cadastro (tela de sucesso) — null = cadastro
   * genérico, sem plano escolhido (período grátis) */
  const [registeredPlan, setRegisteredPlan] = useState<PlanId | null>(null);
  /** plano escolhido no cartão da apresentação, levado pro
   * formulário de cadastro — null = botão genérico (cabeçalho, hero
   * ou fim da página), sem plano escolhido */
  const [registerPlan, setRegisterPlan] = useState<PlanId | null>(null);
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
        // QR Code dos garçons (?acesso=garcom ou ?tela=garcom): pula a
        // apresentação e abre só a tela de login do garçom — sessão de
        // dono ou de administrador não é restaurada nesse endereço.
        const onlyWaiter = isWaiterOnlyParam();
        setWaiterOnly(onlyWaiter);
        if (!onlyWaiter) {
          // A consulta do administrador só roda fora do QR: no endereço
          // do QR, o login do garçom não depende de nada do banco.
          const adminExists = (await store.getPlatformAdmin()) !== null;
          setHasAdmin(adminExists);
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
          // Entrada escondida /adm: sem sessão de admin, abre o login
          // do administrador (primeiro acesso cria o login dele).
          // Não restaura sessão de dono nem de garçom nesse endereço.
          if (isAdminPath()) {
            setAdminAuth(adminExists ? 'login' : 'setup');
            setView('login');
            return;
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
                // O dono cai direto no painel dele (Financeiro), mesmo
                // com 0 garçons — garçons e cardápio são cadastrados
                // nas abas certas, lá dentro. No endereço da central
                // de impressão (?central=impressao), cai direto nela:
                // é o aparelho do balcão, que fica sempre aberto.
                setView(isPrintCenterParam() ? 'print-center' : 'owner');
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
              const restored: Session = {
                id: waiter.id,
                name: waiter.name,
                login: waiter.login,
                restaurant_id: rid,
              };
              setSession(restored);
              await refresh();
              // Mesas abertas sem nenhum item (restos da regra antiga)
              // voltam a ficar livres.
              await store.cleanupEmptyOrders();
              await refresh();
              setView('tables');
              // Sessão restaurada: primeira vez deste garçom neste
              // aparelho abre o tutorial.
              startTourIfFirstTime(waiter.login, restored);
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
        // No endereço do QR, nunca mostrar a tela de erro: qualquer
        // falha no boot cai direto no login do garçom, sem mensagem.
        if (!isWaiterOnlyParam()) {
          setError(
            e instanceof Error ? e.message : 'Não foi possível carregar o sistema.',
          );
        }
        setView('login');
      } finally {
        setBooting(false);
      }
    })();
  }, [refresh, refreshOwner]);

  /** Login único do formulário principal: o login é único na
   * plataforma toda — se for de garçom, abre as mesas; se for de
   * dono, abre a área do dono. Na tela do QR (?acesso=garcom ou
   * ?tela=garcom), só o garçom entra (o login de dono não vale ali). */
  async function handleLogin(login: string, password: string) {
    setError('');
    setBusy(true);
    try {
      const result = await store.authenticate(login.trim(), password);
      if (!result) throw new Error('Não foi possível entrar. Tente de novo.');
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
        // Primeira vez deste garçom neste aparelho: abre o tutorial
        // (tour guiado nas telas de verdade).
        startTourIfFirstTime(waiter.login, s);
        return;
      }
      if (waiterOnly) throw new Error('Não foi possível entrar. Tente de novo.');
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

  /* ------------------------------ TUTORIAL DO GARÇOM (Parte 4) ------------------------------ */

  /** "Visto" do tour: guardado no aparelho, por login do garçom. */
  function hasSeenTour(login: string): boolean {
    return safeGet(TOUR_SEEN_PREFIX + login) === '1';
  }
  function markTourSeen(login: string) {
    safeSet(TOUR_SEEN_PREFIX + login, '1');
  }

  /** Bebida de demonstração p/ o passo "como servir": de preferência
   * um refrigerante de verdade do cardápio; senão, cerveja ou torre
   * de verdade; se não houver bebida com opções no cardápio, uma
   * Coca fictícia SÓ em memória (nunca é gravada). */
  function demoServeProduct(): Product {
    const bar = availableProducts.filter((p) => p.prints_in === 'bar');
    const withOptions = bar.find(
      (p) =>
        p.drink_type === 'refrigerante' ||
        p.drink_type === 'cerveja' ||
        p.drink_type === 'torre',
    );
    if (withOptions) return withOptions;
    return {
      id: 'tour-demo-bebida',
      name: 'Coca 600ml',
      price_cents: 899,
      category: 'Bebidas',
      prints_in: 'bar',
      drink_type: 'refrigerante',
      created_at: '',
    };
  }

  /** Rótulo de "como servir" que o item de demonstração carrega. */
  function demoServeLabel(drinkType: DrinkType): string {
    if (drinkType === 'cerveja') return '2 copos';
    if (drinkType === 'torre') return '2 canecas';
    return SERVE_OPTIONS[0];
  }

  /** Pedido de demonstração, SÓ EM MEMÓRIA: 1 prato + 1 bebida, com
   * id vazio — igual ao rascunho de mesa aberta sem item, que nunca
   * é persistido. `sent` = true deixa tudo como "já enviado" (passo
   * "Fechar mesa"); false deixa como "a enviar" (resumo/revisar). */
  function buildDemoOrder(sess: Session | null, sent: boolean): OrderWithItems {
    const dish =
      availableProducts.find((p) => p.prints_in === 'kitchen') ??
      ({
        id: 'tour-demo-prato',
        name: 'Casarao 1',
        price_cents: 15999,
        category: 'Almoço',
        prints_in: 'kitchen',
        drink_type: null,
        created_at: '',
      } as Product);
    const drink = demoServeProduct();
    const drinkType = drink.drink_type ?? 'refrigerante';
    const busy = new Set(
      openOrders.filter((o) => o.items.length > 0).map((o) => o.order.table_number),
    );
    const demoTable =
      Array.from({ length: settings.table_count }, (_, i) => i + 1).find(
        (n) => !busy.has(n),
      ) ?? 1;
    const now = new Date().toISOString();
    return {
      order: {
        id: '',
        table_number: demoTable,
        waiter_id: sess?.id ?? '',
        waiter_name: sess?.name ?? '',
        status: 'open',
        created_at: now,
        closed_at: null,
      },
      items: [
        {
          id: 'tour-item-1',
          order_id: '',
          product_id: dish.id,
          product_name: dish.name,
          price_cents: dish.price_cents,
          qty: 1,
          note: '',
          serve: null,
          sent,
          created_at: now,
        },
        {
          id: 'tour-item-2',
          order_id: '',
          product_id: drink.id,
          product_name: drink.name,
          price_cents: drink.price_cents,
          qty: 1,
          note: '',
          serve: demoServeLabel(drinkType),
          sent,
          created_at: now,
        },
      ],
    };
  }

  /** Vai pro passo `i` do tour: navega pra tela real do passo com o
   * pedido de demonstração (quando o passo precisa dele). Não grava
   * nada — só muda a tela e o estado em memória. */
  function applyTourStep(i: number, sess?: Session | null) {
    const s = sess ?? session;
    setTour(i);
    setMenuOpen(false);
    setError('');
    setConfirmClose(false);
    if (i <= 1) {
      // Grade de Mesas: sem pedido aberto e sem filtro de busca.
      setCurrentOrder(null);
      setServeProduct(null);
      setTableSearch('');
      setView('tables');
      return;
    }
    if (i === 2 || i === 5) {
      // Tela de pedir (buscar produto / botão REVISAR): pedido de
      // demonstração com itens "a enviar" (REVISAR fica habilitado).
      setCurrentOrder(buildDemoOrder(s, false));
      setServeProduct(null);
      setOrderCategory(null);
      setOrderSearch('');
      setView('order');
      return;
    }
    if (i === 3) {
      // Tela de como servir, com a bebida de demonstração.
      setCurrentOrder(buildDemoOrder(s, false));
      setServeProduct(demoServeProduct());
      setBeerCups(null);
      setServeQty(2);
      setView('serve');
      return;
    }
    // i === 4 (resumo) ou 6 (fechar mesa): resumo do pedido. No passo
    // 6 tudo já está como "enviado", pra o botão Fechar mesa ficar
    // habilitado — igual a uma mesa real pronta pra fechar.
    setCurrentOrder(buildDemoOrder(s, i === 6));
    setServeProduct(null);
    setView('summary');
  }

  /** Começa o tour do zero (primeiro login ou "Ver tutorial de
   * novo"). Descarta qualquer rascunho em memória (id vazio = sem
   * itens, nada gravado) — um pedido já salvo continua no banco e
   * reabre pela mesa. */
  function startTour(sess?: Session | null) {
    applyTourStep(0, sess);
  }

  /** Abre o tour sozinho só na primeira vez daquele garçom neste
   * aparelho. */
  function startTourIfFirstTime(login: string, sess?: Session | null) {
    if (!hasSeenTour(login)) startTour(sess);
  }

  /** Termina (ou pula) o tour: grava o "visto", descarta o pedido de
   * demonstração e cai na grade de Mesas limpa, sem mesa aberta nem
   * pedido criado. */
  function endTour() {
    if (session) markTourSeen(session.login);
    setTour(null);
    setCurrentOrder(null);
    setServeProduct(null);
    setOrderCategory(null);
    setOrderSearch('');
    setMenuOpen(false);
    setConfirmClose(false);
    setError('');
    setView('tables');
    void refresh();
  }

  /** Anel laranja no elemento destacado do passo + rola a tela até
   * ele. Roda depois de cada troca de passo/tela. */
  useEffect(() => {
    const prev = tourTargetRef.current;
    if (tour === null) {
      if (prev) {
        prev.classList.remove('tour-highlight');
        tourTargetRef.current = null;
      }
      return;
    }
    const steps = getTourSteps(serveProduct?.drink_type ?? 'refrigerante');
    const step = steps[tour];
    if (!step) return;
    let el: HTMLElement | null = null;
    for (const sel of step.selectors) {
      el = document.querySelector<HTMLElement>(sel);
      if (el) break;
    }
    if (prev && prev !== el) prev.classList.remove('tour-highlight');
    if (el) {
      el.classList.add('tour-highlight');
      el.scrollIntoView({ block: 'center' });
      tourTargetRef.current = el;
    }
    return () => {
      if (tourTargetRef.current) {
        tourTargetRef.current.classList.remove('tour-highlight');
        tourTargetRef.current = null;
      }
    };
  }, [tour, view, currentOrder, serveProduct]);

  /* ------------------------------ DONO: ACESSO ------------------------------ */

  /** Entra na área do dono (área financeira) — usado pelo login
   * principal (quando o login é de dono) e pelo "Sou o dono". */
  async function enterOwnerArea(owner: Owner) {
    if (!owner.restaurant_id) {
      throw new Error(
        'Restaurante não identificado — rode a migração do supabase.sql.',
      );
    }
    // O pré-preenchimento do login vale só para a primeira entrada
    // logo após o cadastro; depois do login ele é limpo.
    setRegisteredLogin('');
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
    // O dono cai direto no painel dele (Financeiro), mesmo com 0
    // garçons — garçons e cardápio são cadastrados nas abas certas.
    // No endereço da central (?central=impressao), cai direto nela.
    setView(isPrintCenterParam() ? 'print-center' : 'owner');
  }

  async function handleOwnerLogin(login: string, password: string) {
    setError('');
    setBusy(true);
    try {
      const owner = await store.findOwnerByLogin(login.trim());
      if (!owner) throw new Error('Não foi possível entrar. Tente de novo.');
      const hash = await store.hashPassword(password);
      if (hash !== owner.password_hash) {
        throw new Error('Não foi possível entrar. Tente de novo.');
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

  /** Cadastro sozinho: cria o restaurante + o dono. NÃO entra direto —
   * mostra a tela "Cadastro realizado com sucesso" e, embaixo, o link
   * para a tela de login do dono (com o login já preenchido). O dono
   * só entra na área dele depois de digitar a senha. O plano escolhido
   * no cartão da apresentação é gravado no restaurante. */
  async function handleRestaurantRegister(
    restaurantName: string,
    name: string,
    login: string,
    password: string,
    plan: PlanId | null,
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
        plan: plan ?? null,
      });
      setRegisteredLogin(owner.login);
      setRegisteredRestaurantName(restaurant.name);
      setRegisteredPlan(restaurant.plan ?? null);
      setView('register-success');
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
    safeRemove(PLATFORM_ADMIN_SESSION_KEY);
    // No endereço escondido /adm, sair volta pro login do
    // administrador (não pra apresentação).
    if (isAdminPath()) {
      setAdminAuth(hasAdmin ? 'login' : 'setup');
      setView('login');
      return;
    }
    setAdminAuth(null);
    setView(waiterOnly ? 'login' : 'home');
  }

  /** Abre a Revisão: lista das mesas fechadas (menu hambúrguer).
   * Carrega também os itens de cada conta (p/ o cartão mostrar
   * "N itens" e o detalhe ao expandir). Mostra as 20 últimas. */
  async function openReview() {
    setMenuOpen(false);
    setError('');
    setBusy(true);
    try {
      const bills = await store.listClosedBills();
      const shown = bills.slice(0, 20);
      setClosedBills(shown);
      const details: Record<string, { items: OrderItem[]; openedAt: string }> = {};
      await Promise.all(
        shown.map(async (b) => {
          const ow = await store.getOrderWithItems(b.order_id);
          if (ow) {
            details[b.id] = {
              items: ow.items,
              openedAt: ow.order.created_at,
            };
          }
        }),
      );
      setBillDetails(details);
      setView('review');
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Não foi possível abrir a revisão.',
      );
    } finally {
      setBusy(false);
    }
  }

  /** Pausa/reativa um produto do cardápio (só o dono): pausado, ele
   * some da tela de pedir do garçom e aparece como "pausado" na
   * lista do dono. Guardado neste aparelho, sem mudar o banco. */
  function togglePauseProduct(id: string) {
    setPausedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      const rid = restaurant?.id ?? getActiveRestaurantIdSafe();
      if (rid) safeSet(PAUSED_KEY_PREFIX + rid, JSON.stringify([...next]));
      return next;
    });
  }

  function getActiveRestaurantIdSafe(): string | null {
    try {
      return store.getActiveRestaurantId();
    } catch {
      return null;
    }
  }

  // Produtos pausados: carrega os do restaurante da sessão.
  useEffect(() => {
    setPausedIds(loadPausedIds(restaurant?.id ?? null));
  }, [restaurant?.id]);

  // A grade de mesas atualiza a cada 5 s (outro garçom pode ter
  // aberto ou fechado uma mesa nesse meio-tempo).
  useEffect(() => {
    if (view !== 'tables' || !session) return;
    const t = setInterval(() => {
      void refresh();
    }, 5000);
    return () => clearInterval(t);
  }, [view, session, refresh]);

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
    setOpeningTable(tableNumber);
    try {
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
          `A mesa ${tableNumber} está com ${existing.order.waiter_name} — só ele pode mexer nela.`,
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
    } finally {
      setOpeningTable(null);
    }
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
      setServeQty(2);
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

  /** Cerveja — "Precisa de copos?": Não precisa → entra como
   * "Sem copos"; Precisa → pede a quantidade. */
  async function chooseBeerCups(needsCups: boolean) {
    const product = serveProduct;
    if (!product) return;
    if (!needsCups) {
      setServeProduct(null);
      setBeerCups(null);
      await addProduct(product, 'Sem copos');
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
              `A mesa ${currentOrder.order.table_number} está com ${taken.order.waiter_name} — só ele pode mexer nela.`,
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

  /**
   * Enfileira as vias da impressão automática (cozinha, bar e/ou
   * balcão) a partir do mesmo TicketData que aparece na tela. A via é
   * fotografada aqui (itens, descrição do prato, como servir, totais
   * da conta) — a central de impressão não precisa buscar o pedido de
   * novo. Se enfileirar falhar, o garçom não trava: a via continua na
   * tela dele e a central só não recebe essa via (o erro fica no
   * console; o pedido em si já foi enviado/fechado).
   */
  async function enqueuePrintJobsForTicket(ticket: TicketData) {
    try {
      const snap = (items: OrderItem[]): PrintJobItem[] =>
        items.map((i) => ({
          product_name: i.product_name,
          qty: i.qty,
          price_cents: i.price_cents,
          serve: i.serve ?? null,
          note: i.note ?? null,
          description:
            products.find((p) => p.id === i.product_id)?.description ??
            null,
        }));
      const jobs: Array<
        Omit<PrintJob, 'id' | 'status' | 'created_at' | 'printed_at'>
      > = [];
      if (ticket.kind === 'send') {
        if (ticket.kitchen.length > 0) {
          jobs.push({
            sector: 'kitchen',
            kind: 'send',
            order_number: ticket.orderNumber ?? 0,
            table_number: ticket.tableNumber,
            waiter_name: ticket.waiterName ?? '',
            items: snap(ticket.kitchen),
            bill: null,
          });
        }
        if (ticket.bar.length > 0) {
          jobs.push({
            sector: 'bar',
            kind: 'send',
            order_number: ticket.orderNumber ?? 0,
            table_number: ticket.tableNumber,
            waiter_name: ticket.waiterName ?? '',
            items: snap(ticket.bar),
            bill: null,
          });
        }
      } else if (ticket.bill) {
        jobs.push({
          sector: 'counter',
          kind: 'close',
          order_number: ticket.orderNumber ?? 0,
          table_number: ticket.tableNumber,
          waiter_name: ticket.waiterName ?? ticket.bill.waiter_name,
          items: snap([...ticket.kitchen, ...ticket.bar]),
          bill: {
            subtotal_cents: ticket.bill.subtotal_cents,
            fee_cents: ticket.bill.fee_cents,
            total_cents: ticket.bill.total_cents,
          },
        });
      }
      if (jobs.length > 0) await store.enqueuePrintJobs(jobs);
    } catch (e) {
      console.error('Não foi possível enfileirar a via pra impressão.', e);
    }
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
      const ticket: TicketData = {
        kind: 'send',
        tableNumber: currentOrder.order.table_number,
        kitchen,
        bar,
        bill: null,
        orderNumber,
        sentAt,
        waiterName: currentOrder.order.waiter_name,
      };
      setTickets(ticket);
      // Enfileira as vias pra impressão automática (cozinha/bar) — a
      // central do balcão imprime sozinha; sem travar o garçom.
      void enqueuePrintJobsForTicket(ticket);
      // Guarda as vias impressas desta mesa p/ reabrir o cupom no resumo.
      setPrintedVias((prev) => [
        ...prev.filter((v) => v.orderId !== currentOrder.order.id || v.station === 'Balcão — conta'),
        ...(kitchen.length > 0
          ? [
              {
                id: `via-${orderNumber}-cozinha`,
                orderId: currentOrder.order.id,
                station: 'Cozinha' as const,
                count: kitchen.reduce((s, i) => s + i.qty, 0),
                time: sentAt,
                ticket,
              },
            ]
          : []),
        ...(bar.length > 0
          ? [
              {
                id: `via-${orderNumber}-bar`,
                orderId: currentOrder.order.id,
                station: 'Bar' as const,
                count: bar.reduce((s, i) => s + i.qty, 0),
                time: sentAt,
                ticket,
              },
            ]
          : []),
      ]);
      await refreshCurrentOrder(currentOrder.order.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível enviar o pedido.');
    } finally {
      setBusy(false);
    }
  }

  /** "Fechar mesa": com item pendente, o botão mostra o aviso e não
   * fecha — primeiro envia. Sem pendência, abre a confirmação
   * "Fechar a mesa N?" com os valores da conta. */
  function requestClose() {
    if (!currentOrder) return;
    if (currentOrder.items.filter((i) => !i.sent).length > 0) return;
    setConfirmClose(true);
  }

  async function closeTable() {
    if (!currentOrder) return;
    setConfirmClose(false);
    setBusy(true);
    try {
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
      const ticket: TicketData = {
        kind: 'close',
        tableNumber: currentOrder.order.table_number,
        kitchen,
        bar,
        bill,
        orderNumber: billNumber,
        sentAt: bill.closed_at,
        waiterName: bill.waiter_name,
      };
      setTickets(ticket);
      // Enfileira a conta do balcão pra impressão automática.
      void enqueuePrintJobsForTicket(ticket);
      setPrintedVias((prev) => [
        ...prev,
        {
          id: `via-${billNumber}-balcao`,
          orderId: currentOrder.order.id,
          station: 'Balcão — conta',
          count: allItems.reduce((s, i) => s + i.qty, 0),
          time: bill.closed_at,
          ticket,
        },
      ]);
      setBillNumbers((prev) => ({ ...prev, [bill.id]: billNumber }));
      setBillDetails((prev) => ({
        ...prev,
        [bill.id]: {
          items: allItems,
          openedAt: ow?.order.created_at ?? currentOrder.order.created_at,
        },
      }));
      // A conta aparece primeiro; ao ver a revisão, a recém-fechada
      // abre destacada com borda roxa.
      const freshBills = await store.listClosedBills();
      setClosedBills(freshBills.slice(0, 20));
      setExpandedBillId(bill.id);
      setHighlightedBillId(bill.id);
      setCurrentOrder(null);
      setView('review');
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
  /** produtos que o garçom vê na tela de pedir (pausado some) */
  const availableProducts = products.filter((p) => !pausedIds.has(p.id));
  const categories = Array.from(
    new Set(availableProducts.map((p) => p.category)),
  ).sort((a, b) => a.localeCompare(b, 'pt-BR'));

  /* ------------------------------ TUTORIAL DO GARÇOM: BALÃO ------------------------------ */
  /** Balão do tour: bloqueia os toques no app (o tour navega
   * sozinho), mostra o selo "Tutorial · demonstração", o passo
   * atual com progresso e os botões Voltar / Próximo (Concluir no
   * último) / Pular tutorial. Nas telas em que o destacado fica na
   * barra de baixo (REVISAR, Fechar mesa), o balão vai pra cima pra
   * não cobrir o botão. */
  const tourSteps =
    tour === null
      ? []
      : getTourSteps(serveProduct?.drink_type ?? 'refrigerante');
  const tourStep = tour === null ? null : tourSteps[tour] ?? null;
  const tourOverlay =
    tour === null || !tourStep ? null : (
      <>
        <div className="tour-blocker" aria-hidden />
        <div
          className={`tour-balloon${tourStep.balloon === 'top' ? ' tour-balloon-top' : ''}`}
          role="dialog"
          aria-label={`Tutorial do garçom, passo ${tour + 1} de ${TOUR_STEP_COUNT}`}
        >
          <div className="tour-demo-tag">Tutorial · demonstração</div>
          <div className="tour-progress">
            {tour + 1} de {TOUR_STEP_COUNT}
          </div>
          <h3>{tourStep.title}</h3>
          <p>{tourStep.text}</p>
          <div className="tour-actions">
            <button
              className="btn btn-ghost"
              disabled={tour === 0}
              onClick={() => applyTourStep(tour - 1)}
            >
              ← Voltar
            </button>
            <button
              className="btn btn-green"
              onClick={() => {
                if (tour === TOUR_STEP_COUNT - 1) endTour();
                else applyTourStep(tour + 1);
              }}
            >
              {tour === TOUR_STEP_COUNT - 1 ? 'Concluir' : 'Próximo →'}
            </button>
          </div>
          <button className="tour-skip" onClick={endTour}>
            Pular tutorial
          </button>
        </div>
      </>
    );

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
        onRegister={(plan) => {
          // O botão do cartão do plano leva o plano escolhido pro
          // cadastro; os outros botões vão sem plano (período grátis).
          setRegisterPlan(plan ?? null);
          setView('register');
        }}
      />
    );
  }

  /* ------------------------------ SETUP ------------------------------ */

  /* ------------------------------ CADASTRO DO RESTAURANTE ------------------------------ */

  if (view === 'register') {
    return (
      <div className="app">
        <div className="content auth-wide">
          {error && <div className="error">{error}</div>}
          <RegisterRestaurantView
            busy={busy}
            plan={registerPlan}
            onRegister={handleRestaurantRegister}
            onCancel={() => setView('login')}
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

  /* ------------------------------ CADASTRO REALIZADO ------------------------------ */

  if (view === 'register-success') {
    return (
      <div className="app">
        <div className="content auth-wide">
          <div className="card success-card">
            <div className="success-check" aria-hidden>
              ✓
            </div>
            <h2>Cadastro realizado com sucesso!</h2>
            <p className="hint">
              O restaurante <strong>{registeredRestaurantName}</strong> foi
              criado com o login <strong>{registeredLogin}</strong>.
              {registeredPlan
                ? ` Plano: ${store.planLabel(registeredPlan)} — você usa 3 dias grátis.`
                : ' Você usa 3 dias grátis — depois, escolha o plano Mensal ou Anual.'}
            </p>
            <button
              className="btn btn-purple"
              onClick={() => {
                setOwnerAuth(true);
                setView('login');
              }}
            >
              Entrar no meu financeiro →
            </button>
            <p className="hint" style={{ marginTop: 12, marginBottom: 0 }}>
              O login já vai preenchido - é só digitar a sua senha.
            </p>
          </div>
        </div>
      </div>
    );
  }

  /* ------------------------------ LOGIN ------------------------------ */

  if (view === 'login') {
    return (
      <div className="app">
        {ownerAuth ? (
          <div className="content auth">
            {error && <div className="error">{error}</div>}
            <OwnerAuthView
              busy={busy}
              initialLogin={registeredLogin}
              onLogin={handleOwnerLogin}
              onCancel={() => setOwnerAuth(false)}
            />
          </div>
        ) : adminAuth ? (
          <>
            <div className="hero">
              <h1>Sistema do Garçom</h1>
              <p>Entre com o seu acesso para abrir as mesas.</p>
            </div>
            <div className="content auth">
              {error && <div className="error">{error}</div>}
              <AdminAuthView
                mode={adminAuth}
                busy={busy}
                onLogin={handleAdminLogin}
                onCreate={handleAdminCreate}
                onCancel={() => setAdminAuth(null)}
                hideCancel={isAdminPath()}
              />
            </div>
          </>
        ) : (
          <>
            <div className="hero">
              <div className="eyebrow">Restaurante</div>
              <h1>
                {waiterOnly ? 'Acesso do garçom' : 'Entrar no sistema'}
              </h1>
              <p>
                {waiterOnly
                  ? 'Entre com seu usuário e senha pra ver as mesas do seu restaurante.'
                  : 'Entre com seu usuário e senha: o garçom cai direto nas mesas, e o dono, no painel do restaurante dele.'}
              </p>
            </div>
            <div className="content auth">
              {error && <div className="error">{error}</div>}
              <LoginForm busy={busy} onLogin={handleLogin} />
              <p className="hint" style={{ textAlign: 'center' }}>
                O acesso do garçom é criado pelo dono do restaurante, na
                área financeira dele.
              </p>
              {/* Na tela do QR (?acesso=garcom ou ?tela=garcom) só
                  aparece o login do garçom — sem "Sou o dono" e sem
                  cadastro. A área do administrador não tem entrada
                  visível: só quem conhece o endereço /adm chega lá. */}
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
                </>
              )}
              <div className="mode-badge">
                {isSupabase
                  ? 'Banco de dados: Supabase (nuvem)'
                  : 'Banco de dados: local (neste aparelho)'}
              </div>
            </div>
          </>
        )}
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
        ownerName={ownerSession.name}
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
        ownerName={ownerSession.name}
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
        ownerName={ownerSession.name}
        pausedIds={pausedIds}
        onTogglePause={togglePauseProduct}
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
        ownerName={ownerSession.name}
        printers={settings.printers ?? []}
        onSaved={refreshOwner}
        onSavedPrinters={refreshOwner}
        onOpenPrintCenter={() => setView('print-center')}
        onNavigate={setView}
        onLogout={handleOwnerLogout}
      />
    );
  }

  if (view === 'print-center' && ownerSession) {
    return (
      <PrintCenterView
        restaurantName={restaurant?.name ?? ''}
        ownerName={ownerSession.name}
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
    const firstName = session.name.split(' ')[0];
    return (
      <div className="app">
        <header className="header header-blue">
          <div>
            <h1>Mesas</h1>
            <div className="sub">
              Olá, {firstName} · {restaurant?.name ?? ''}
            </div>
          </div>
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
                <button
                  className="menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    startTour();
                  }}
                >
                  Ver tutorial de novo
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
              Dia encerrado — o dono finalizou o dia. Não dá pra abrir mesa
              nova nem fazer pedido novo; o dia reabre às 9h. Mesas já
              abertas ainda podem ser fechadas.
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
          <div
            className="tables-section-title"
            data-tour="mesas-livres-titulo"
          >
            Mesas/Comandas livres ({free.length})
          </div>
          <div className="mesas-grid" data-tour="mesas-livres">
            {free.map((n, idx) => (
              <button
                key={n}
                className="mesa-tile free"
                data-tour={idx === 0 ? 'mesa-livre' : undefined}
                disabled={busy || dayClosed}
                onClick={() => openTable(n)}
              >
                <span className="mesa-open">
                  {openingTable === n ? 'Abrindo…' : 'ABRIR'}
                </span>
                <span className="mesa-num">{pad2(n)}</span>
              </button>
            ))}
          </div>
          {shownTables.length === 0 && (
            <div className="empty">Nenhuma mesa com esse número.</div>
          )}
        </div>
        {tourOverlay}
      </div>
    );
  }

  /* ------------------------------ PEDIR ------------------------------ */

  if (view === 'order' && currentOrder) {
    const tableNumber = currentOrder.order.table_number;
    const query = orderSearch.trim().toLowerCase();
    const shownProducts = query
      ? availableProducts.filter(
          (p) =>
            p.name.toLowerCase().includes(query) ||
            p.category.toLowerCase().includes(query),
        )
      : orderCategory === ALL_PRODUCTS
        ? availableProducts
        : orderCategory
          ? availableProducts.filter((p) => p.category === orderCategory)
          : [];
    const pendingCount = pendingItems.reduce((s, i) => s + i.qty, 0);

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
                <button
                  className="menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    startTour();
                  }}
                >
                  Ver tutorial de novo
                </button>
                <button className="menu-item" onClick={handleLogout}>
                  Sair
                </button>
              </div>
            </>
          )}
        </header>
        <div className="content">
          <div className="order-search" data-tour="busca-produto">
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
              <div className="section-title">
                Resultados para &quot;{orderSearch}&quot;
              </div>
              {shownProducts.length === 0 ? (
                <div className="empty">
                  Nenhum produto encontrado. Confira o nome.
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
                  O cardápio ainda está vazio. O cadastro dos produtos é
                  feito pelo dono, na área financeira do restaurante.
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
            data-tour="btn-revisar"
            disabled={pendingCount === 0}
            onClick={() => {
              setMenuOpen(false);
              setView('summary');
            }}
          >
            ✓ REVISAR
          </button>
        </div>
        {tourOverlay}
      </div>
    );
  }

  /* ------------------------------ COMO SERVIR ------------------------------ */

  if (view === 'serve' && serveProduct && currentOrder) {
    const drinkType = serveProduct.drink_type ?? 'refrigerante';
    const qtyUnit = drinkType === 'torre' ? 'caneca' : 'copo';
    return (
      <div className="app">
        <header className="header">
          <div>
            <h1>{serveProduct.name}</h1>
            <div className="sub">
              Mesa {currentOrder.order.table_number}
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
              <div className="cat-grid" data-tour="opcoes-servir">
                <button
                  className="serve-tile"
                  onClick={() => void chooseBeerCups(true)}
                >
                  Precisa de copos
                </button>
                <button
                  className="serve-tile"
                  onClick={() => void chooseBeerCups(false)}
                >
                  Não precisa
                </button>
              </div>
            </>
          ) : drinkType === 'cerveja' || drinkType === 'torre' ? (
            <>
              <p className="serve-q">
                {drinkType === 'torre'
                  ? 'Quantas canecas vai precisar?'
                  : 'Quantos copos?'}
              </p>
              <div className="serve-qty" data-tour="opcoes-servir">
                <button
                  aria-label="Diminuir"
                  onClick={() => setServeQty((q) => Math.max(1, q - 1))}
                >
                  −
                </button>
                <span>{serveQty}</span>
                <button
                  aria-label="Aumentar"
                  onClick={() => setServeQty((q) => Math.min(30, q + 1))}
                >
                  +
                </button>
              </div>
              <button
                className="btn btn-green"
                style={{ width: '100%', marginTop: 16 }}
                onClick={() => void confirmServeQty()}
              >
                Adicionar — {serveQty}{' '}
                {serveQty === 1 ? qtyUnit : `${qtyUnit}s`}
              </button>
            </>
          ) : (
            <>
              <p className="serve-q">Como a bebida vai ser servida?</p>
              <div className="cat-grid" data-tour="opcoes-servir">
                {SERVE_OPTIONS.map((opt) => (
                  <button
                    key={opt}
                    className="serve-tile"
                    onClick={() => void chooseServe(opt)}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        {tourOverlay}
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

          <div className="summary-section pending">
            A enviar ({pendingItems.length})
          </div>
          {pendingItems.length === 0 && (
            <div className="empty">
              Nenhum item novo. Toque em “Adicionar produtos” para pedir.
            </div>
          )}
          {pendingItems.map((item, idx) => (
            <ItemRow
              key={item.id}
              dataTour={idx === 0 ? 'resumo-item' : undefined}
              item={item}
              station={
                products.find((p) => p.id === item.product_id)
                  ?.prints_in === 'bar'
                  ? 'bar'
                  : 'kitchen'
              }
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
              {sentItems.map((item) => {
                const station =
                  products.find((p) => p.id === item.product_id)
                    ?.prints_in === 'bar'
                    ? 'bar'
                    : 'kitchen';
                return (
                  <div key={item.id} className="item-row sent">
                    <div className="top">
                      <span className="iname">
                        {item.qty}× {item.product_name}
                      </span>
                      <span className="iline">
                        {brl(item.price_cents * item.qty)}
                      </span>
                    </div>
                    {item.serve && (
                      <div className="serve-line">{item.serve}</div>
                    )}
                    <div className="item-meta">
                      <span>{brl(item.price_cents)} cada</span>
                      <span
                        className={`station-badge ${
                          station === 'bar' ? 'bar' : 'kitchen'
                        }`}
                      >
                        {station === 'bar' ? 'Bar' : 'Cozinha'}
                      </span>
                    </div>
                    {item.note && (
                      <div className="note-line">obs: {item.note}</div>
                    )}
                  </div>
                );
              })}
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
              <span>Total da mesa</span>
              <span>{brl(totals.total)}</span>
            </div>
          </div>

          <div style={{ height: 14 }} />
          <button
            className="btn btn-green"
            disabled={busy || pendingItems.length === 0}
            onClick={sendOrder}
          >
            {busy
              ? 'Enviando…'
              : `🖨️ Enviar pedido (${pendingItems.length})`}
          </button>
          <p className="hint" style={{ textAlign: 'center', marginTop: 10 }}>
            Depois de enviar, a mesa continua sua: se o cliente pedir mais,
            é só abrir a mesma mesa e adicionar.
          </p>

          {printedVias.filter((v) => v.orderId === currentOrder.order.id)
            .length > 0 && (
            <>
              <div className="summary-section">Vias impressas desta mesa</div>
              {printedVias
                .filter((v) => v.orderId === currentOrder.order.id)
                .map((v) => (
                  <button
                    key={v.id}
                    className="review-row"
                    onClick={() => setViewTicket(v.ticket)}
                  >
                    <span className="review-table">{v.station}</span>
                    <span className="review-meta">
                      {v.count} {v.count === 1 ? 'item' : 'itens'} ·{' '}
                      {formatTime(v.time)}
                    </span>
                    <span className="review-total">Ver</span>
                  </button>
                ))}
            </>
          )}
        </div>
        <div className="bottom-bar">
          <button
            className="btn btn-outline-purple"
            data-tour="adicionar-produtos"
            onClick={() => {
              setOrderCategory(null);
              setOrderSearch('');
              setView('order');
            }}
          >
            Adicionar produtos
          </button>
          <button
            className="btn btn-green"
            data-tour="btn-fechar-mesa"
            disabled={
              busy ||
              currentOrder.items.length === 0 ||
              pendingItems.length > 0
            }
            onClick={requestClose}
          >
            {pendingItems.length > 0
              ? 'Envie os itens pendentes pra cozinha/bar antes de fechar a mesa.'
              : '✓ Fechar mesa'}
          </button>
        </div>
        {confirmClose && (
          <div className="modal-backdrop">
            <div className="modal">
              <h3 style={{ marginTop: 0 }}>
                Fechar a mesa {tableNumber}?
              </h3>
              <p className="hint">
                A conta completa sai na impressora do balcão e a mesa fica
                livre.
              </p>
              <div className="totals">
                <div className="trow">
                  <span>Subtotal</span>
                  <span>{brl(totals.subtotal)}</span>
                </div>
                <div className="trow">
                  <span>Taxa de serviço ({settings.service_fee_pct}%)</span>
                  <span>{brl(totals.fee)}</span>
                </div>
                <div className="trow total">
                  <span>Total</span>
                  <span style={{ color: 'var(--purple)' }}>
                    {brl(totals.total)}
                  </span>
                </div>
              </div>
              <div style={{ height: 14 }} />
              <button
                className="btn btn-ghost"
                onClick={() => setConfirmClose(false)}
              >
                Voltar
              </button>
              <div style={{ height: 10 }} />
              <button
                className="btn btn-purple"
                disabled={busy}
                onClick={() => void closeTable()}
              >
                Fechar e imprimir
              </button>
            </div>
          </div>
        )}
        {tickets && (
          <TicketsModal
            data={tickets}
            products={products}
            restaurantName={restaurant?.name ?? 'Restaurante'}
            title={
              tickets.kind === 'close'
                ? 'Conta fechada — via do balcão'
                : 'Pedido enviado — vias impressas'
            }
            closeLabel={
              tickets.kind === 'close'
                ? 'Ver revisão da mesa'
                : 'OK, voltar à mesa'
            }
            onClose={() => {
              setTickets(null);
            }}
          />
        )}
        {viewTicket && (
          <TicketsModal
            data={viewTicket}
            products={products}
            restaurantName={restaurant?.name ?? 'Restaurante'}
            title="Via impressa"
            closeLabel="Fechar"
            onClose={() => setViewTicket(null)}
          />
        )}
        {tourOverlay}
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
          </div>
          <button className="icon-btn" onClick={() => setView('tables')}>
            Mesas
          </button>
        </header>
        <div className="content">
          {error && <div className="error">{error}</div>}
          <p className="hint">
            O que tinha em cada mesa que você fechou. Confira os itens, as
            quantidades e os valores pra ver se não esqueceu nada ou se
            adicionou algo sem querer.
          </p>
          {closedBills.length === 0 ? (
            <div className="empty">
              Você ainda não fechou nenhuma mesa. Quando fechar uma conta,
              ela aparece aqui pra você conferir.
            </div>
          ) : (
            closedBills.map((bill) => {
              const detail = billDetails[bill.id];
              const itemCount = detail
                ? detail.items.reduce((s, i) => s + i.qty, 0)
                : 0;
              const expanded = expandedBillId === bill.id;
              const highlighted = highlightedBillId === bill.id;
              return (
                <div
                  key={bill.id}
                  className={`review-card${expanded ? ' open' : ''}${
                    highlighted ? ' highlighted' : ''
                  }`}
                >
                  <button
                    className="review-row"
                    disabled={busy}
                    onClick={() =>
                      setExpandedBillId(expanded ? null : bill.id)
                    }
                  >
                    <span className="review-table">
                      Mesa {String(bill.table_number).padStart(2, '0')}
                    </span>
                    <span className="review-meta">
                      Fechada em {formatDateTime(bill.closed_at)} ·{' '}
                      {itemCount} {itemCount === 1 ? 'item' : 'itens'}
                    </span>
                    <span className="review-total">
                      {brl(bill.total_cents)}
                    </span>
                  </button>
                  {expanded && detail && (
                    <div className="review-detail">
                      {detail.items.map((item) => {
                        const station =
                          products.find((p) => p.id === item.product_id)
                            ?.prints_in === 'bar'
                            ? 'bar'
                            : 'kitchen';
                        return (
                          <div key={item.id} className="item-row">
                            <div className="top">
                              <span className="iname">
                                {item.qty}× {item.product_name}
                              </span>
                              <span className="iline">
                                {brl(item.price_cents * item.qty)}
                              </span>
                            </div>
                            {item.serve && (
                              <div className="serve-line">{item.serve}</div>
                            )}
                            <div className="item-meta">
                              <span>
                                {brl(item.price_cents)} cada
                                {item.note ? ` · obs: ${item.note}` : ''}
                              </span>
                              <span
                                className={`station-badge ${
                                  station === 'bar' ? 'bar' : 'kitchen'
                                }`}
                              >
                                {station === 'bar' ? 'Bar' : 'Cozinha'}
                              </span>
                            </div>
                          </div>
                        );
                      })}
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
                          <span>Total da mesa</span>
                          <span>{brl(bill.total_cents)}</span>
                        </div>
                      </div>
                      <p className="hint">
                        Aberta às {formatTime(detail.openedAt)} · fechada às{' '}
                        {formatTime(bill.closed_at)}
                      </p>
                      <button
                        className="btn btn-purple"
                        onClick={() => {
                          const { kitchen, bar } = splitTickets(detail.items);
                          setViewTicket({
                            kind: 'close',
                            tableNumber: bill.table_number,
                            kitchen,
                            bar,
                            bill,
                            orderNumber: billNumbers[bill.id],
                            sentAt: bill.closed_at,
                            waiterName: bill.waiter_name,
                          });
                        }}
                      >
                        Ver via do balcão
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
        {tickets && (
          <TicketsModal
            data={tickets}
            products={products}
            restaurantName={restaurant?.name ?? 'Restaurante'}
            title="Conta fechada — via do balcão"
            closeLabel="Ver revisão da mesa"
            onClose={() => setTickets(null)}
          />
        )}
        {viewTicket && (
          <TicketsModal
            data={viewTicket}
            products={products}
            restaurantName={restaurant?.name ?? 'Restaurante'}
            title="Via do balcão — conta fechada"
            closeLabel="Fechar"
            onClose={() => setViewTicket(null)}
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
        <label htmlFor="login">Usuário</label>
        <input
          id="login"
          autoComplete="username"
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          placeholder="Seu usuário"
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
        {busy ? 'Entrando…' : 'Entrar'}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Cadastro de produto (usado na área do dono)                          */
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
      setError('Preço inválido. Use o formato 32,90.');
      return;
    }
    setBusy(true);
    try {
      const input = {
        name: name.trim(),
        price_cents: cents,
        category: category.trim() || 'Geral',
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
          <label htmlFor="prod-cat">Categoria (botão na tela de pedido)</label>
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
          <label htmlFor="prod-desc">O que vem no prato</label>
          <input
            id="prod-desc"
            value={description}
            disabled={disabled}
            maxLength={300}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Ex.: arroz, feijão, 300g de filé de tilápia"
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
      {onCancelEdit && (
        <>
          <div style={{ height: 10 }} />
          <button className="btn btn-ghost" onClick={onCancelEdit}>
            Cancelar
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
  pausedIds,
  onTogglePause,
}: {
  products: Product[];
  onDeleted: () => Promise<void>;
  readOnly?: boolean;
  /** editar (só na área do dono) — quando ausente, não mostra o botão */
  onEdit?: (p: Product) => void;
  /** produtos pausados (não aparecem na tela de pedir) */
  pausedIds?: Set<string>;
  /** pausar/reativar (só na área do dono) */
  onTogglePause?: (id: string) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
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
            {items.map((p) => {
              const paused = pausedIds?.has(p.id) ?? false;
              return (
                <div key={p.id}>
                  <div
                    className="prod-list-item"
                    style={paused ? { opacity: 0.6 } : undefined}
                  >
                    <span>
                      {p.name}{' '}
                      <span className="where">
                        {p.category} ·{' '}
                        {p.prints_in === 'kitchen' ? 'Cozinha' : 'Bar'}
                        {paused ? ' · pausado' : ''}
                      </span>
                    </span>
                    <span className="prod-list-price">{brl(p.price_cents)}</span>
                    {!readOnly && (
                      <span className="prod-list-actions">
                        {onEdit && (
                          <button onClick={() => onEdit(p)}>Editar</button>
                        )}
                        {onTogglePause && (
                          <button onClick={() => onTogglePause(p.id)}>
                            {paused ? 'Reativar' : 'Pausar'}
                          </button>
                        )}
                        <button
                          className="danger"
                          onClick={() => setConfirmDelete(p.id)}
                        >
                          Remover
                        </button>
                      </span>
                    )}
                  </div>
                  {confirmDelete === p.id && (
                    <div className="confirm-box">
                      <p>
                        Remover {p.name} do cardápio? Ele some da tela de
                        pedido do garçom. Contas já fechadas não mudam.
                      </p>
                      <div className="confirm-actions">
                        <button
                          className="btn btn-ghost btn-auto"
                          onClick={() => setConfirmDelete(null)}
                        >
                          Cancelar
                        </button>
                        <button
                          className="btn btn-danger btn-auto"
                          onClick={async () => {
                            setConfirmDelete(null);
                            await store.deleteProduct(p.id);
                            await onDeleted();
                          }}
                        >
                          Remover mesmo
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
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
  station,
  onQty,
  onRemove,
  onNote,
  dataTour,
}: {
  item: OrderItem;
  station: 'kitchen' | 'bar';
  onQty: (delta: number) => void;
  onRemove: () => void;
  onNote: (note: string) => void;
  /** marcador do tutorial do garçom (só o primeiro item do resumo) */
  dataTour?: string;
}) {
  const [editingNote, setEditingNote] = useState(false);
  const [draft, setDraft] = useState(item.note);
  return (
    <div className="item-row" data-tour={dataTour}>
      <div className="top">
        <span className="iname">{item.product_name}</span>
        <span className="iline">{brl(item.price_cents * item.qty)}</span>
      </div>
      {item.serve && <div className="serve-line">{item.serve}</div>}
      <div className="item-meta">
        <span>{brl(item.price_cents)} cada</span>
        <span
          className={`station-badge ${station === 'bar' ? 'bar' : 'kitchen'}`}
        >
          {station === 'bar' ? 'Bar' : 'Cozinha'}
        </span>
      </div>
      {editingNote ? (
        <div className="note-edit">
          <input
            className="note-input"
            value={draft}
            placeholder="observações"
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
          <button
            className="btn btn-green note-save"
            onClick={() => {
              onNote(draft.trim());
              setEditingNote(false);
            }}
          >
            Salvar
          </button>
        </div>
      ) : (
        <button
          className="note-link"
          onClick={() => {
            setDraft(item.note);
            setEditingNote(true);
          }}
        >
          {item.note ? `obs: ${item.note} (editar)` : 'observações'}
        </button>
      )}
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
/* Vias de papel (cozinha / bar / balcão)                              */
/* ------------------------------------------------------------------ */

function TicketsModal({
  data,
  products,
  restaurantName,
  title,
  closeLabel,
  onClose,
}: {
  data: TicketData;
  products: Product[];
  /** nome do restaurante no cabeçalho das vias */
  restaurantName: string;
  title?: string;
  closeLabel?: string;
  onClose: () => void;
}) {
  const orderNo = data.orderNumber
    ? String(data.orderNumber).padStart(4, '0')
    : '—';
  /** observações juntas numa só caixa cinza (vias da cozinha e do bar) */
  const notesOf = (items: OrderItem[]) =>
    items
      .filter((i) => i.note)
      .map((i) => `${i.qty}× ${i.product_name}: ${i.note}`);
  const kitchenNotes = notesOf(data.kitchen);
  const barNotes = notesOf(data.bar);
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3 style={{ marginTop: 0 }}>
          {title ??
            (data.kind === 'send'
              ? 'Pedido enviado — vias impressas'
              : 'Conta fechada — via do balcão')}
        </h3>

        {data.kind === 'send' && data.kitchen.length > 0 && (
          <div className="ticket">
            <div className="t-head">
              <span className="t-logo" aria-hidden>
                👨‍🍳
              </span>
              <span className="t-name">{restaurantName}</span>
              <span className="t-num">
                Pedido Nº
                <strong>{orderNo}</strong>
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
                </div>
              );
            })}
            {kitchenNotes.length > 0 && (
              <div className="t-obs">
                <strong>Observações:</strong>
                {kitchenNotes.map((n) => (
                  <div key={n}>{n}</div>
                ))}
              </div>
            )}
            <hr />
            <div className="t-foot">
              Pedido em preparo!
              <span>Qualquer dúvida, chame o garçom.</span>
            </div>
          </div>
        )}

        {data.kind === 'send' && data.bar.length > 0 && (
          <div className="ticket">
            <div className="t-head">
              <span className="t-logo" aria-hidden>
                🥤
              </span>
              <span className="t-name">{restaurantName}</span>
              <span className="t-num">
                Pedido Nº
                <strong>{orderNo}</strong>
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
              </div>
            ))}
            {barNotes.length > 0 && (
              <div className="t-obs">
                <strong>Observações:</strong>
                {barNotes.map((n) => (
                  <div key={n}>{n}</div>
                ))}
              </div>
            )}
            <hr />
            <div className="t-foot">
              Pedido em preparo!
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
                <strong>{orderNo}</strong>
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
                {i.note && <div className="t-detail">obs: {i.note}</div>}
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
              <span>TOTAL</span>
              <span>{brl(data.bill.total_cents)}</span>
            </div>
            <hr />
            <div className="t-foot">Obrigado pela preferência!</div>
          </div>
        )}

        <button className="btn btn-purple" onClick={onClose}>
          {closeLabel ??
            (data.kind === 'close'
              ? 'Ver revisão da mesa'
              : 'OK, voltar à mesa')}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Via da fila de impressão — um só cupom (um setor) a partir do       */
/* PrintJob. Mesmo conteúdo e mesmas classes da via na tela            */
/* (TicketsModal): cabeçalho, número, mesa/hora/garçom, faixa do       */
/* setor, itens, observações e rodapé; a conta traz valores e TOTAL.   */
/* Usado na prévia da central, no teste da impressora e na área de     */
/* impressão do computador (#print-area).                              */
/* ------------------------------------------------------------------ */

function PrintJobSlip({
  job,
  restaurantName,
}: {
  job: PrintJob;
  restaurantName: string;
}) {
  const orderNo = String(job.order_number).padStart(4, '0');
  const logo =
    job.sector === 'kitchen' ? '👨‍🍳' : job.sector === 'bar' ? '🥤' : '🧾';
  const notes = job.items
    .filter((i) => i.note)
    .map((i) => `${i.qty}× ${i.product_name}: ${i.note}`);
  return (
    <div className="ticket">
      <div className="t-head">
        <span className="t-logo" aria-hidden>
          {logo}
        </span>
        <span className="t-name">{restaurantName}</span>
        <span className="t-num">
          Pedido Nº
          <strong>{orderNo}</strong>
        </span>
      </div>
      <div className="t-meta">
        Mesa: {job.table_number} | Hora: {formatTime(job.created_at)} |
        Garçom: {job.waiter_name}
      </div>
      <div className="t-band">
        {logo}&nbsp; {sectorLabel(job.sector)}
      </div>
      <div className="t-cols">
        <span className="t-qty">Qtd.</span>
        <span className="t-item">Produto</span>
        {job.kind === 'close' && <span className="t-price">Valor</span>}
      </div>
      <hr />
      {job.items.map((i, idx) => (
        <div key={`${job.id}-${idx}`}>
          <div className="t-row">
            <span className="t-qty">{i.qty}×</span>
            <span className="t-item">{i.product_name}</span>
            {job.kind === 'close' && (
              <span className="t-price">{brl(i.price_cents * i.qty)}</span>
            )}
          </div>
          {job.sector === 'kitchen' && i.description && (
            <div className="t-detail">{i.description}</div>
          )}
          {i.serve && <div className="t-detail">{i.serve}</div>}
          {i.note && <div className="t-detail">obs: {i.note}</div>}
        </div>
      ))}
      {job.kind === 'send' && notes.length > 0 && (
        <div className="t-obs">
          <strong>Observações:</strong>
          {notes.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
      )}
      <hr />
      {job.kind === 'close' && job.bill ? (
        <>
          <div className="t-line">
            <span>Subtotal</span>
            <span>{brl(job.bill.subtotal_cents)}</span>
          </div>
          <div className="t-line">
            <span>Taxa de serviço</span>
            <span>{brl(job.bill.fee_cents)}</span>
          </div>
          <div className="t-line t-total">
            <span>TOTAL</span>
            <span>{brl(job.bill.total_cents)}</span>
          </div>
          <hr />
          <div className="t-foot">Obrigado pela preferência!</div>
        </>
      ) : (
        <div className="t-foot">
          Pedido em preparo!
          <span>Qualquer dúvida, chame o garçom.</span>
        </div>
      )}
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
    if (!Number.isInteger(count) || count < 1 || count > 60) {
      setError('Número de mesas inválido (de 1 a 60).');
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
 * em "Cadastrar meu restaurante", na tela de login. Primeiro acesso
 * do restaurante original (sem dono ainda): cria o acesso com
 * "Seu nome" e o botão "Criar acesso e entrar". Vindo da tela de
 * sucesso, o usuário já vem preenchido e NÃO cai no primeiro acesso. */
function OwnerAuthView({
  busy,
  onLogin,
  onCancel,
  initialLogin = '',
}: {
  busy: boolean;
  onLogin: (login: string, password: string) => void;
  onCancel: () => void;
  /** login já preenchido (vem da tela de "Cadastro realizado com sucesso") */
  initialLogin?: string;
}) {
  const [name, setName] = useState('');
  const [login, setLogin] = useState(initialLogin);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  /** null = conferindo se já existe dono; true = primeiro acesso */
  const [firstAccess, setFirstAccess] = useState<boolean | null>(
    initialLogin ? false : null,
  );

  useEffect(() => {
    if (initialLogin) return;
    let alive = true;
    (async () => {
      try {
        // Primeiro acesso só vale com restaurante ativo e sem dono:
        // sem restaurante, o caminho é "Cadastrar meu restaurante".
        if (!store.getActiveRestaurantId()) {
          if (alive) setFirstAccess(false);
          return;
        }
        const owner = await store.getOwner();
        if (alive) setFirstAccess(owner === null);
      } catch {
        // Sem restaurante ativo não dá pra conferir: mostra o login.
        if (alive) setFirstAccess(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [initialLogin]);

  function submit() {
    if (firstAccess && !name.trim()) {
      setError('Preencha o seu nome.');
      return;
    }
    if (!login.trim() || !password) {
      setError('Preencha o usuário e a senha.');
      return;
    }
    if (firstAccess && password.length < 4) {
      setError('A senha precisa ter no mínimo 4 caracteres.');
      return;
    }
    onLogin(login, password);
  }

  async function createAccess() {
    setError('');
    if (!name.trim() || !login.trim()) {
      setError('Preencha o seu nome e o usuário.');
      return;
    }
    if (password.length < 4) {
      setError('A senha precisa ter no mínimo 4 caracteres.');
      return;
    }
    try {
      const hash = await store.hashPassword(password);
      await store.createOwner(name.trim(), login.trim(), hash);
      onLogin(login.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível criar o acesso.');
    }
  }

  return (
    <div className="card">
      <div className="eyebrow">Restaurante</div>
      <h2>Acesso do dono</h2>
      <p className="hint">
        {firstAccess
          ? 'Primeiro acesso do restaurante: crie o seu acesso de dono pra abrir a área financeira.'
          : 'Entre com seu usuário e senha pra abrir a área financeira do seu restaurante.'}
      </p>
      {error && <div className="error">{error}</div>}
      {firstAccess && (
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
        <label htmlFor="owner-login">Usuário</label>
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
      {firstAccess ? (
        <button
          className="btn btn-purple"
          disabled={busy}
          onClick={() => void createAccess()}
        >
          Criar acesso e entrar
        </button>
      ) : (
        <button className="btn btn-purple" disabled={busy} onClick={submit}>
          {busy ? 'Entrando…' : 'Entrar no financeiro'}
        </button>
      )}
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
  plan,
  onRegister,
  onCancel,
}: {
  busy: boolean;
  /** plano escolhido no cartão da apresentação (null = cadastro
   * genérico, sem plano — fica no período grátis) */
  plan?: PlanId | null;
  onRegister: (
    restaurantName: string,
    name: string,
    login: string,
    password: string,
    plan: PlanId | null,
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
    onRegister(restaurantName, name, login, password, plan ?? null);
  }

  return (
    <div className="card">
      <div className="eyebrow">NOVO RESTAURANTE</div>
      <h2>Cadastrar meu restaurante</h2>
      <p className="hint">
        {plan
          ? `Plano escolhido: ${store.planLabel(plan)}. Você usa 3 dias grátis.`
          : 'Você usa 3 dias grátis. Depois, escolha o plano Mensal (R$ 69,99/mês) ou Anual (R$ 499,99/ano).'}
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
        <label htmlFor="reg-name">Seu nome (dono)</label>
        <input
          id="reg-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex.: Luis"
        />
      </div>
      <div className="field">
        <label htmlFor="reg-login">Usuário (seu login de dono)</label>
        <input
          id="reg-login"
          autoComplete="username"
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          placeholder="Seu usuário"
        />
        <p className="hint" style={{ marginTop: 6, marginBottom: 0 }}>
          O login do dono é único na plataforma toda — se já existir um
          acesso com esse usuário, escolha outro.
        </p>
      </div>
      <div className="field">
        <label htmlFor="reg-password">Senha (mínimo 4 caracteres)</label>
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
  hideCancel,
}: {
  mode: 'login' | 'setup';
  busy: boolean;
  onLogin: (login: string, password: string) => void;
  onCreate: (login: string, password: string) => void;
  onCancel: () => void;
  /** no endereço escondido /adm não há pra onde voltar — o login do
   * admin é a única tela dali */
  hideCancel?: boolean;
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
      {!hideCancel && (
        <>
          <div style={{ height: 10 }} />
          <button className="btn btn-ghost" onClick={onCancel}>
            Voltar ao login do garçom
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Lista de restaurantes cadastrados — SÓ cadastro: nome do restaurante,
 * nome do dono, data do cadastro, número de garçons, plano escolhido e
 * status do período grátis (3 dias a partir do cadastro). NENHUM dado
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
            {summaries.map((s) => {
              const trial = store.trialStatus(s.restaurant.created_at);
              return (
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
                  <div className="note-line">
                    Plano: {store.planLabel(s.restaurant.plan)} · Período
                    grátis:{' '}
                    {trial.inTrial
                      ? `${
                          trial.daysLeft === 1
                            ? 'resta 1 dia'
                            : `restam ${trial.daysLeft} dias`
                        } (termina em ${formatDate(trial.end)})`
                      : `encerrado em ${formatDate(trial.end)}`}
                  </div>
                </div>
              );
            })}
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

type OwnerTab = 'dashboard' | 'waiters' | 'menu' | 'settings';

/** Cabeçalho da área do dono: "Financeiro" + restaurante e "Olá,
 * <primeiro nome>", botão Sair; abaixo, o "Menu do dono" em grade
 * de 4 colunas: Início, Garçons, Cardápio, Ajustes. Aba ativa roxa
 * com texto branco; inativa branca com texto escuro. */
function OwnerHeader({
  tab,
  restaurantName,
  ownerName,
  onNavigate,
  onLogout,
}: {
  tab: OwnerTab;
  restaurantName?: string;
  ownerName?: string;
  onNavigate: (v: View) => void;
  onLogout: () => void;
}) {
  const firstName = (ownerName ?? '').split(' ')[0];
  return (
    <>
      <header className="owner-header">
        <div>
          <h1>Financeiro</h1>
          <div className="owner-sub">
            {restaurantName ? `${restaurantName} · ` : ''}
            {firstName ? `Olá, ${firstName}` : ''}
          </div>
        </div>
        <button className="owner-logout" onClick={onLogout}>
          Sair
        </button>
      </header>
      <div className="owner-nav-label">Menu do dono</div>
      <nav className="owner-tabs">
        <button
          className={tab === 'dashboard' ? 'on' : ''}
          onClick={() => onNavigate('owner')}
        >
          Início
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
      </nav>
    </>
  );
}

/* ------------------- APRESENTAÇÃO (PRIMEIRA TELA) ------------------- */

/** Primeira tela do sistema: explica como funciona, mostra os planos
 * e o cadastro. Só tem o botão "Cadastrar meu restaurante" — quem já
 * tem conta entra pelo link pequeno e discreto no rodapé ("Já tem uma
 * conta? Entrar"). O QR Code dos garçons (?acesso=garcom) não passa
 * por aqui: vai direto pro login do garçom. */
function HomeView({
  onLogin,
  onRegister,
}: {
  onLogin: () => void;
  /** plano escolhido no cartão da apresentação; sem argumento = botão
   * genérico (cabeçalho, hero ou fim da página) — cadastro sem plano */
  onRegister: (plan?: PlanId) => void;
}) {
  // A landing é escura, igual à da versão de teste: fundo #17110c,
  // título grande em duas cores e CTA laranja-avermelhado #f26a3d.
  // A landing sempre abre rolada pro topo — o Chrome restaurava a
  // rolagem e a página abria no meio, com o topo cortado.
  useEffect(() => {
    if ('scrollRestoration' in history) {
      history.scrollRestoration = 'manual';
    }
    window.scrollTo(0, 0);
  }, []);
  // Carrossel "Veja o sistema funcionando": prints reais das telas,
  // avançando sozinhos. Pausa no toque/hover e respeita
  // prefers-reduced-motion (sem avanço automático nem zoom; o vídeo
  // do hero vira um quadro estático (poster) nesse caso).
  const [reducedMotion, setReducedMotion] = useState(false);
  const [slide, setSlide] = useState(0);
  const [carouselPaused, setCarouselPaused] = useState(false);
  const touchX = useRef<number | null>(null);
  const resumeTimer = useRef<number | null>(null);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  useEffect(() => {
    return () => {
      if (resumeTimer.current !== null) {
        window.clearTimeout(resumeTimer.current);
      }
    };
  }, []);
  function pauseTemporarily(ms: number) {
    setCarouselPaused(true);
    if (resumeTimer.current !== null) {
      window.clearTimeout(resumeTimer.current);
    }
    resumeTimer.current = window.setTimeout(
      () => setCarouselPaused(false),
      ms,
    );
  }
  useEffect(() => {
    if (reducedMotion || carouselPaused) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        setSlide((s) => (s + 1) % LANDING_PRINTS.length);
      }
    }, 4000);
    return () => window.clearInterval(id);
  }, [reducedMotion, carouselPaused]);
  // O botão flutuante de WhatsApp fica fixo no canto inferior direito
  // e cobria conteúdo ao rolar (antes o preço do plano Anual, depois
  // o nome do garçom no cupom térmico). Enquanto a grade de planos
  // ou as vias estiverem na faixa do botão (~76px do fim da tela),
  // o botão se esconde — nada fica coberto ao rolar.
  const plansRef = useRef<HTMLDivElement | null>(null);
  const ticketsRef = useRef<HTMLDivElement | null>(null);
  const [hideWa, setHideWa] = useState(false);
  // Calculadora de comissão — exemplo do Luis: R$ 200,00 a 8% =
  // R$ 16,00 do garçom, R$ 184,00 pro restaurante.
  const [calcVenda, setCalcVenda] = useState('200');
  const [calcPct, setCalcPct] = useState('8');
  const calcVendaCents = Math.max(
    0,
    Math.round((parseFloat(calcVenda.replace(',', '.')) || 0) * 100),
  );
  const calcPctNum = Math.max(
    0,
    Math.min(100, parseFloat(calcPct.replace(',', '.')) || 0),
  );
  const calcComissaoCents = Math.round(
    (calcVendaCents * calcPctNum) / 100,
  );
  const calcRestauranteCents = calcVendaCents - calcComissaoCents;
  // Dúvidas frequentes em sanfona: fechada por padrão.
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const faqs = [
    {
      q: 'Preciso instalar algum aplicativo?',
      a: 'Não. O sistema abre no navegador do celular, sem instalar nada — é só abrir o endereço e entrar.',
    },
    {
      q: 'Quem cadastra o cardápio e os garçons?',
      a: 'Só o dono, na área dele. O garçom só recebe o login e a senha pra entrar nas mesas.',
    },
    {
      q: 'Preciso de impressoras especiais?',
      a: 'As vias saem nas impressoras térmicas da cozinha, do bar e do balcão — cada via sai só onde ela pertence.',
    },
    {
      q: 'Outro restaurante consegue ver minhas vendas?',
      a: 'Não. Cada restaurante vê só os dados dele — garçons, cardápio, mesas e financeiro separados.',
    },
    {
      q: 'Quanto custa?',
      a: '3 dias grátis. Depois, R$ 69,99 por mês ou R$ 499,99 por ano — os dois com suporte 24 horas.',
    },
    {
      q: 'E se o cliente pedir mais depois de fechar a conta?',
      a: 'O garçom reabre a mesma mesa e continua o pedido normal.',
    },
  ];
  useEffect(() => {
    const inBand = (el: HTMLDivElement | null) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.bottom > window.innerHeight - 76 && r.top < window.innerHeight;
    };
    const update = () => {
      setHideWa(inBand(plansRef.current) || inBand(ticketsRef.current));
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
    <div className="app landing">
      <div className="landing-header">
        <strong>Sistema de Restaurante</strong>
        <nav className="landing-nav" aria-label="Menu">
          <a href="#como-funciona">Como funciona</a>
          <a href="#pro-garcom">Pro garçom</a>
          <a href="#pro-dono">Pro dono</a>
          <a href="#planos">Planos</a>
          <a href="#duvidas">Dúvidas</a>
        </nav>
        <button
          className="btn btn-orange landing-header-cta"
          onClick={() => onRegister()}
        >
          Cadastrar meu restaurante
        </button>
      </div>
      <div className="content home landing-content">
        <div className="landing-hero">
          {reducedMotion ? (
            <img
              className="landing-hero-video"
              src={LANDING_HERO_POSTER}
              alt=""
              aria-hidden
            />
          ) : (
            <video
              className="landing-hero-video"
              src={LANDING_HERO_VIDEO}
              autoPlay
              muted
              loop
              playsInline
              preload="auto"
              aria-hidden
            />
          )}
          <div className="landing-hero-veil" aria-hidden />
          <h1>
            O pedido sai da mesa direto pra cozinha.{' '}
            <span className="landing-accent">
              E a venda, direto pro seu financeiro.
            </span>
          </h1>
          <p>
            Sistema completo para restaurantes: o garçom anota o pedido no
            celular, cada setor recebe só a sua via — prato na cozinha,
            bebida no bar, conta no balcão — e você, dono, acompanha vendas
            e comissões sem digitar nada duas vezes.
          </p>
          <div className="landing-hero-btns">
            <button
              className="btn btn-orange"
              onClick={() => onRegister()}
            >
              Cadastrar meu restaurante
            </button>
            <button
              className="btn landing-outline"
              onClick={() =>
                document
                  .getElementById('como-funciona')
                  ?.scrollIntoView({ behavior: 'smooth' })
              }
            >
              Ver como funciona
            </button>
          </div>
          <div className="landing-checks">
            <span>✓ Sem instalar nada</span>
            <span>✓ 3 dias grátis</span>
            <span>✓ Suporte 24 horas</span>
            <span>✓ Dados separados</span>
          </div>
        </div>

        <div className="section-title">Veja o sistema funcionando</div>
        <p className="hint">
          Telas de verdade do sistema, passando sozinhas:
        </p>
        <div
          className="showcase"
          role="region"
          aria-label="Demonstração do sistema"
          onMouseEnter={() => setCarouselPaused(true)}
          onMouseLeave={() => setCarouselPaused(false)}
          onTouchStart={(e) => {
            touchX.current = e.touches[0].clientX;
            setCarouselPaused(true);
          }}
          onTouchEnd={(e) => {
            if (touchX.current === null) return;
            const dx = e.changedTouches[0].clientX - touchX.current;
            if (Math.abs(dx) > 40) {
              setSlide((s) =>
                dx < 0
                  ? (s + 1) % LANDING_PRINTS.length
                  : (s - 1 + LANDING_PRINTS.length) % LANDING_PRINTS.length,
              );
            }
            touchX.current = null;
            pauseTemporarily(8000);
          }}
        >
          <div className="landing-phone showcase-phone">
            <div className="landing-phone-screen showcase-screen">
              {LANDING_PRINTS.map((p, i) => (
                <img
                  key={p.caption}
                  className={
                    'showcase-slide' +
                    (i === slide ? ' showcase-active' : '')
                  }
                  src={p.src}
                  alt=""
                />
              ))}
            </div>
          </div>
          <p className="showcase-caption">{LANDING_PRINTS[slide].caption}</p>
          <div className="showcase-dots">
            {LANDING_PRINTS.map((p, i) => (
              <button
                key={p.caption}
                type="button"
                aria-label={`Ver: ${p.caption}`}
                aria-current={i === slide}
                className={
                  'showcase-dot' +
                  (i === slide ? ' showcase-dot-active' : '')
                }
                onClick={() => {
                  setSlide(i);
                  pauseTemporarily(10000);
                }}
              />
            ))}
          </div>
        </div>

        <div className="section-title" id="como-funciona">
          Como funciona
        </div>
        <div className="steps">
          <div className="step">
            <strong>1 · Cadastre o restaurante</strong>
            <span>
              Crie o restaurante e o seu acesso de dono em poucos minutos,
              sem instalar nada.
            </span>
          </div>
          <div className="step">
            <strong>2 · Monte a equipe e o cardápio</strong>
            <span>
              Cadastre os garçons e os produtos, com preço e onde cada um
              imprime: cozinha ou bar.
            </span>
          </div>
          <div className="step">
            <strong>3 · O garçom atende pelo celular</strong>
            <span>
              Ele abre a mesa, anota o pedido e envia pra cozinha e pro
              bar na hora.
            </span>
          </div>
          <div className="step">
            <strong>4 · A venda cai no financeiro</strong>
            <span>
              Ao fechar a mesa, a conta vai pro financeiro com a comissão
              do garçom já calculada.
            </span>
          </div>
        </div>

        <div className="section-title" id="pro-garcom">
          No celular do garçom
        </div>
        <div className="steps">
          <div className="step">
            <strong>Grade de mesas</strong>
            <span>
              Mesas numeradas com o estado ao vivo: livres, suas e de
              outros garçons.
            </span>
          </div>
          <div className="step">
            <strong>Mesa de quem abriu</strong>
            <span>
              Só quem abriu a mesa mexe nela — os outros veem de quem ela
              é.
            </span>
          </div>
          <div className="step">
            <strong>Busca</strong>
            <span>
              Acha o produto na hora, por nome ou categoria.
            </span>
          </div>
          <div className="step">
            <strong>Bebida do jeito do cliente</strong>
            <span>
              Refrigerante com limão e gelo, cerveja com copos, torre com
              canecas.
            </span>
          </div>
        </div>
        <p className="hint">
          O pedido sai impresso na hora, cada um no seu lugar. Na cozinha
          e no bar, a via sai sem valores — só o pedido e a mesa.
        </p>
        <div className="home-tickets" ref={ticketsRef}>
          <div className="ticket">
            <div className="t-head">
              <span className="t-logo" aria-hidden>
                👨‍🍳
              </span>
              <span className="t-name">Gosto Caseiro</span>
              <span className="t-num">
                Pedido Nº<strong>0042</strong>
              </span>
            </div>
            <div className="t-meta">
              Mesa: 07 | Hora: 20:14 | Garçom: Carlos
            </div>
            <div className="t-band">👨‍🍳&nbsp; COZINHA</div>
            <div className="t-cols">
              <span className="t-qty">Qtd.</span>
              <span>Produto</span>
            </div>
            <hr />
            <div className="t-row">
              <span className="t-qty">1×</span>
              <span>Filé de Frango</span>
            </div>
            <div className="t-detail">
              arroz branco, salada verde, batata frita
            </div>
            <div className="t-row">
              <span className="t-qty">1×</span>
              <span>Prato da casa</span>
            </div>
            <div className="t-detail">
              arroz, feijão, 300g de filé de tilápia
            </div>
            <hr />
            <div className="t-foot">
              Pedido em preparo!
              <span>Qualquer dúvida, chame o garçom.</span>
            </div>
          </div>

          <div className="ticket">
            <div className="t-head">
              <span className="t-logo" aria-hidden>
                🥤
              </span>
              <span className="t-name">Gosto Caseiro</span>
              <span className="t-num">
                Pedido Nº<strong>0042</strong>
              </span>
            </div>
            <div className="t-meta">
              Mesa: 07 | Hora: 20:14 | Garçom: Carlos
            </div>
            <div className="t-band">🥤&nbsp; BAR</div>
            <div className="t-cols">
              <span className="t-qty">Qtd.</span>
              <span>Produto</span>
            </div>
            <hr />
            <div className="t-row">
              <span className="t-qty">2×</span>
              <span>Coca 600ml</span>
            </div>
            <div className="t-detail">copo com limão e gelo</div>
            <hr />
            <div className="t-foot">
              Pedido em preparo!
              <span>Qualquer dúvida, chame o garçom.</span>
            </div>
          </div>

          <div className="ticket">
            <div className="t-head">
              <span className="t-logo" aria-hidden>
                🧾
              </span>
              <span className="t-name">Gosto Caseiro</span>
              <span className="t-num">
                Pedido Nº<strong>0042</strong>
              </span>
            </div>
            <div className="t-meta">
              Mesa: 07 | Hora: 20:14 | Garçom: Carlos
            </div>
            <div className="t-band">🧾&nbsp; CONTA</div>
            <div className="t-cols">
              <span className="t-qty">Qtd.</span>
              <span className="t-item">Produto</span>
              <span className="t-price">Valor</span>
            </div>
            <hr />
            <div className="t-row">
              <span className="t-qty">1×</span>
              <span className="t-item">Filé de Frango</span>
              <span className="t-price">R$ 89,00</span>
            </div>
            <div className="t-row">
              <span className="t-qty">1×</span>
              <span className="t-item">Prato da casa</span>
              <span className="t-price">R$ 81,00</span>
            </div>
            <div className="t-row">
              <span className="t-qty">2×</span>
              <span className="t-item">Coca 600ml</span>
              <span className="t-price">R$ 18,00</span>
            </div>
            <hr />
            <div className="t-line">
              <span>Subtotal</span>
              <span>R$ 188,00</span>
            </div>
            <div className="t-line">
              <span>Taxa de serviço</span>
              <span>R$ 5,64</span>
            </div>
            <div className="t-line t-total">
              <span>TOTAL</span>
              <span>R$ 193,64</span>
            </div>
            <hr />
            <div className="t-foot">Obrigado pela preferência!</div>
          </div>
        </div>

        <div className="section-title" id="pro-dono">
          No painel do dono
        </div>
        <div className="steps">
          <div className="step">
            <strong>Vendas por garçom</strong>
            <span>
              Cada conta fechada cai sozinha no financeiro, com o garçom e
              a % dele.
            </span>
          </div>
          <div className="step">
            <strong>Comissão automática</strong>
            <span>
              Exemplo: vendeu R$ 200,00 a 8% — R$ 16,00 é do garçom e
              R$ 184,00 fica pro restaurante.
            </span>
          </div>
          <div className="step">
            <strong>Finalizar o dia</strong>
            <span>
              Fecha o dia com o resumo pra pagar os garçons. No dia
              seguinte, abre sozinho às 9h.
            </span>
          </div>
          <div className="step">
            <strong>Preço e cardápio do dono</strong>
            <span>
              Só o dono muda preços, cardápio, taxa de serviço e comissão.
            </span>
          </div>
        </div>

        <div className="card calc-card">
          <h3>Calculadora de comissão</h3>
          <p className="hint">
            Digite o valor da venda e a % do garçom:
          </p>
          <div className="calc-row">
            <div className="field">
              <label htmlFor="calc-venda">Valor da venda (R$)</label>
              <input
                id="calc-venda"
                inputMode="decimal"
                value={calcVenda}
                onChange={(e) => setCalcVenda(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="calc-pct">% do garçom</label>
              <input
                id="calc-pct"
                inputMode="decimal"
                value={calcPct}
                onChange={(e) => setCalcPct(e.target.value)}
              />
            </div>
          </div>
          <div className="calc-result">
            <div className="calc-line">
              <span>Do garçom:</span>
              <strong>{brl(calcComissaoCents)}</strong>
            </div>
            <div className="calc-line">
              <span>Fica pro restaurante:</span>
              <strong>{brl(calcRestauranteCents)}</strong>
            </div>
          </div>
        </div>

        <div className="section-title" id="duvidas">
          Dúvidas frequentes
        </div>
        <div className="faq-list">
          {faqs.map((f, i) => (
            <div key={f.q} className="faq-item">
              <button
                className="faq-q"
                onClick={() => setOpenFaq(openFaq === i ? null : i)}
                aria-expanded={openFaq === i}
              >
                <span>{f.q}</span>
                <span aria-hidden>{openFaq === i ? '−' : '+'}</span>
              </button>
              {openFaq === i && <p className="faq-a">{f.a}</p>}
            </div>
          ))}
        </div>

        <div className="section-title" id="planos">
          Planos
        </div>
        <p className="hint">
          Cadastre seu restaurante e use <strong>3 dias grátis</strong>.
          Depois, escolha o plano:
        </p>
        <div className="plan-badge">3 dias grátis</div>
        <div className="plan-grid" ref={plansRef}>
          <div className="plan-card">
            <strong>Mensal</strong>
            <span className="plan-price">R$ 69,99 por mês</span>
            <span>Sistema completo</span>
            <span>Suporte 24 horas</span>
            <button
              className="btn btn-orange"
              onClick={() => onRegister('monthly')}
            >
              Cadastrar meu restaurante
            </button>
          </div>
          <div className="plan-card featured">
            <strong>Anual</strong>
            <span className="plan-price">R$ 499,99 por ano</span>
            <span>Sistema completo</span>
            <span>Suporte 24 horas</span>
            <button
              className="btn btn-orange"
              onClick={() => onRegister('annual')}
            >
              Cadastrar meu restaurante
            </button>
          </div>
        </div>

        <div className="landing-final">
          <h2>Cadastre seu restaurante</h2>
          <p>
            Pronto pra começar? Cadastre seu restaurante e use 3 dias
            grátis.
          </p>
          <button
            className="btn btn-orange home-cta"
            onClick={() => onRegister()}
          >
            Cadastrar meu restaurante
          </button>
        </div>

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
  ownerName,
  onNavigate,
  onLogout,
  onRefresh,
}: {
  bills: ClosedBill[];
  waiters: Waiter[];
  settings: Settings;
  restaurantName: string;
  ownerName: string;
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
    <div className="app app-owner">
      <OwnerHeader
        tab="dashboard"
        restaurantName={restaurantName}
        ownerName={ownerName}
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
            <span className="stat-sub">
              {shown.length} {shown.length === 1 ? 'conta' : 'contas'}
            </span>
          </div>
          <div className="stat-card">
            <span>Comissão dos garçons</span>
            <strong>{brl(commission)}</strong>
          </div>
          <div className="stat-card highlight">
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
                  Comissão ({pct}%): {brl(wComm)} · Restaurante:{' '}
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
          <div className="empty">
            Nenhuma conta fechada neste período. Quando um garçom fechar
            uma mesa, a venda aparece aqui sozinha.
          </div>
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
        <div style={{ textAlign: 'right' }}>
          <button
            className="btn btn-ghost btn-auto"
            onClick={() => void onRefresh()}
          >
            Atualizar
          </button>
        </div>
        <div style={{ height: 10 }} />
        {dayMsg && (
          <div className={dayMsg.error ? 'error' : 'ok-note'}>{dayMsg.text}</div>
        )}
        {dayClosed ? (
          <>
            <div className="card">
              <h3>Dia encerrado</h3>
              <p className="hint">
                Os garçons não conseguem abrir mesa nova nem fazer pedido
                novo. Mesas abertas ainda podem ser fechadas. Reabre
                sozinho amanhã às 9h.
              </p>
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
            className="btn btn-dark"
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
                <span>Total a pagar aos garçons</span>
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
              className="btn btn-ghost"
              onClick={() => setConfirmFinalize(false)}
            >
              Voltar
            </button>
            <div style={{ height: 10 }} />
            <button
              className="btn btn-purple"
              disabled={busyDay}
              onClick={() => void finalize()}
            >
              Finalizar dia
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
  ownerName,
  onChanged,
  onNavigate,
  onLogout,
}: {
  waiters: Waiter[];
  bills: ClosedBill[];
  defaultPct: number;
  restaurantName: string;
  ownerName: string;
  onChanged: () => Promise<void>;
  onNavigate: (v: View) => void;
  onLogout: () => void;
}) {
  const [name, setName] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [pct, setPct] = useState(String(defaultPct));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Waiter | null>(null);
  /** QR Code dos garçons (gerado no próprio app, SVG 208px) */
  const [qrSvg, setQrSvg] = useState('');
  const [qrError, setQrError] = useState('');
  const qrUrl =
    typeof window !== 'undefined'
      ? store.waiterLoginUrl(window.location.origin)
      : '';

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const svg = await QRCode.toString(qrUrl, {
          type: 'svg',
          width: 208,
          // Margem 4 = zona de silêncio do padrão QR: com margem 1 a
          // câmera tinha dificuldade pra ler o código.
          margin: 4,
        });
        if (alive) setQrSvg(svg);
      } catch {
        if (alive)
          setQrError(
            'Não foi possível gerar o QR Code. Peça pros garçons abrirem este endereço no celular.',
          );
      }
    })();
    return () => {
      alive = false;
    };
  }, [qrUrl]);

  function startEdit(w: Waiter) {
    setEditingId(w.id);
    setName(w.name);
    setLogin(w.login);
    setPassword('');
    setPct(String(w.commission_pct ?? defaultPct));
    setShowForm(true);
  }

  function cancelEdit() {
    setEditingId(null);
    setShowForm(false);
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
    <div className="app app-owner">
      <OwnerHeader
        tab="waiters"
        restaurantName={restaurantName}
        ownerName={ownerName}
        onNavigate={onNavigate}
        onLogout={onLogout}
      />
      <div className="content">
        {error && <div className="error">{error}</div>}

        <div className="card">
          <h2>QR Code dos garçons</h2>
          <p className="hint">
            Mostre este código pros seus garçons: eles escaneiam com a
            câmera do celular e já caem na tela de login deles.
          </p>
          {qrError && <div className="error">{qrError}</div>}
          {qrSvg ? (
            <div
              className="qr-svg"
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
          ) : (
            !qrError && <div className="loading">Gerando o QR Code…</div>
          )}
          <p className="hint qr-url">{qrUrl}</p>
        </div>

        <div className="title-row">
          <h2 className="section-title" style={{ margin: 0 }}>
            Garçons ({waiters.length})
          </h2>
          <button
            className="btn btn-purple btn-auto"
            onClick={() => {
              cancelEdit();
              setShowForm(true);
            }}
          >
            Novo garçom
          </button>
        </div>
        <p className="hint">
          Quem cadastra o garçom é você: depois é só passar o usuário e a
          senha pra ele entrar no sistema das mesas.
        </p>

        {showForm && (
          <div className="card">
            <h2>
              {editingId
                ? `Editar ${waiters.find((w) => w.id === editingId)?.name ?? ''}`
                : 'Novo garçom'}
            </h2>
            <div className="field">
              <label htmlFor="waiter-name">Nome do garçom</label>
              <input
                id="waiter-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex.: Carlos"
              />
            </div>
            <div className="row2">
              <div className="field">
                <label htmlFor="waiter-login">Usuário (pra entrar)</label>
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
                <label htmlFor="waiter-pct">Comissão dele (%)</label>
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
                {editingId ? 'Nova senha' : 'Senha (mínimo 4 caracteres)'}
              </label>
              <input
                id="waiter-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  editingId
                    ? 'Em branco mantém a atual'
                    : 'Mínimo 4 caracteres'
                }
              />
            </div>
            <p className="hint">
              Exemplo: vendeu R$ 200 com comissão de 8% → R$ 16 são dele
              e R$ 184 ficam pro restaurante.
            </p>
            <button
              className="btn btn-purple"
              disabled={busy}
              onClick={save}
            >
              {editingId ? 'Salvar alterações' : 'Cadastrar garçom'}
            </button>
            <div style={{ height: 10 }} />
            <button className="btn btn-ghost" onClick={cancelEdit}>
              Cancelar
            </button>
          </div>
        )}

        {waiters.length === 0 ? (
          <div className="empty">Nenhum garçom cadastrado.</div>
        ) : (
          waiters.map((w) => (
            <div key={w.id} className="item-row">
              <div className="top">
                <span className="iname">{w.name}</span>
              </div>
              <div className="note-line">
                usuário: {w.login} · comissão {w.commission_pct ?? 8}%
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
              {confirmDelete?.id === w.id && (
                <div className="confirm-box">
                  <p>
                    Remover o acesso de {w.name}? Ele não entra mais no
                    sistema. As contas que ele já fechou continuam no
                    financeiro.
                  </p>
                  <div className="confirm-actions">
                    <button
                      className="btn btn-ghost btn-auto"
                      onClick={() => setConfirmDelete(null)}
                    >
                      Cancelar
                    </button>
                    <button
                      className="btn btn-danger btn-auto"
                      disabled={busy}
                      onClick={async () => {
                        const waiter = confirmDelete;
                        setConfirmDelete(null);
                        setError('');
                        setBusy(true);
                        try {
                          await store.deleteWaiter(waiter.id);
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
                    >
                      Remover mesmo
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------- DONO: CARDÁPIO ------------------- */

function OwnerMenuView({
  products,
  restaurantName,
  ownerName,
  pausedIds,
  onTogglePause,
  onChanged,
  onNavigate,
  onLogout,
}: {
  products: Product[];
  restaurantName: string;
  ownerName: string;
  pausedIds: Set<string>;
  onTogglePause: (id: string) => void;
  onChanged: () => Promise<void>;
  onNavigate: (v: View) => void;
  onLogout: () => void;
}) {
  const [editing, setEditing] = useState<Product | null>(null);
  const [showForm, setShowForm] = useState(false);
  return (
    <div className="app app-owner">
      <OwnerHeader
        tab="menu"
        restaurantName={restaurantName}
        ownerName={ownerName}
        onNavigate={onNavigate}
        onLogout={onLogout}
      />
      <div className="content">
        <div className="title-row">
          <h2 className="section-title" style={{ margin: 0 }}>
            Cardápio ({products.length})
          </h2>
          <button
            className="btn btn-purple btn-auto"
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
          >
            Novo produto
          </button>
        </div>
        <p className="hint">
          Quem mexe no cardápio é você: o garçom só usa os produtos na hora
          de anotar o pedido.
        </p>
        {showForm && (
          <div className="card">
            <h2>
              {editing ? `Editar ${editing.name}` : 'Novo produto'}
            </h2>
            <ProductForm
              products={products}
              editing={editing}
              onAdded={async () => {
                setEditing(null);
                setShowForm(false);
                await onChanged();
              }}
              onCancelEdit={() => {
                setEditing(null);
                setShowForm(false);
              }}
            />
          </div>
        )}
        {products.length === 0 ? (
          <div className="empty">
            O cardápio está vazio. Toque em Novo produto pra cadastrar o
            primeiro.
          </div>
        ) : (
          <ProductListGrouped
            products={products}
            pausedIds={pausedIds}
            onTogglePause={onTogglePause}
            onDeleted={onChanged}
            onEdit={(p) => {
              setEditing(p);
              setShowForm(true);
            }}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------- DONO: AJUSTES ------------------- */

/* ------------------------------------------------------------------ */
/* Central de impressão — o aparelho do balcão (computador ou celular  */
/* velho) que fica aberto ouvindo os pedidos e imprimindo sozinho.     */
/*                                                                      */
/* Dois caminhos, o dono escolhe por setor em Ajustes → Impressoras:    */
/*  - Computador do balcão: imprime pelo navegador (window.print com   */
/*    a via em #print-area, CSS 80mm). Pra não pedir confirmação a     */
/*    cada cupom, o Chrome tem que abrir com --kiosk-printing.         */
/*  - Celular na central: manda os bytes ESC/POS direto pra            */
/*    impressora Bluetooth (Web Bluetooth, serviço UART). Sem          */
/*    Bluetooth, volta pra impressão do sistema.                       */
/*                                                                      */
/* Sem impressora ligada, o modo simulação registra a via como         */
/* impressa (simulada) — pra testar o fluxo sem hardware. Via que      */
/* não saiu fica 'pending' na fila até imprimir: nada se perde sem     */
/* aviso (falha também fica na fila, com "Tentar de novo").            */
/* ------------------------------------------------------------------ */

/** Serviço UART (Nordic) — o que as térmicas Bluetooth baratas
 * (XPrinter, Elgin, Bematech e similares) expõem pro Web Bluetooth. */
const BT_NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const BT_NUS_TX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

type BtState = 'unsupported' | 'disconnected' | 'connecting' | 'connected' | 'error';

const PRINT_SECTORS: PrinterSector[] = ['kitchen', 'bar', 'counter'];

function PrintCenterView({
  restaurantName,
  ownerName,
  onNavigate,
  onLogout,
}: {
  restaurantName: string;
  ownerName: string;
  onNavigate: (v: View) => void;
  onLogout: () => void;
}) {
  const [printers, setPrinters] = useState<PrinterConfig[]>([]);
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [autoPrint, setAutoPrint] = useState(
    () => safeGet('central_autoprint_v1') !== '0',
  );
  const [simulation, setSimulation] = useState(
    () => safeGet('central_simulacao_v1') === '1',
  );
  const [btState, setBtState] = useState<BtState>('disconnected');
  const [btError, setBtError] = useState('');
  const [printingJobId, setPrintingJobId] = useState<string | null>(null);
  const [printAreaJob, setPrintAreaJob] = useState<PrintJob | null>(null);
  const [previewJob, setPreviewJob] = useState<PrintJob | null>(null);
  const btCharRef = useRef<unknown>(null);
  /** trava: só um cupom por vez no diálogo de impressão/Bluetooth */
  const printingRef = useRef(false);

  async function refreshJobs() {
    try {
      const list = await store.listPrintJobs();
      setJobs(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível ler a fila.');
    }
  }

  useEffect(() => {
    let alive = true;
    let unsub: (() => void) | null = null;
    (async () => {
      setLoading(true);
      try {
        const [cfg, list] = await Promise.all([
          store.getPrinterConfig(),
          store.listPrintJobs(),
        ]);
        if (!alive) return;
        setPrinters(cfg);
        setJobs(list);
      } catch (e) {
        if (alive) {
          setError(
            e instanceof Error ? e.message : 'Não foi possível carregar a central.',
          );
        }
      } finally {
        if (alive) setLoading(false);
      }
      if (isSupabase) {
        try {
          unsub = store.subscribePrintJobs(() => {
            void refreshJobs();
          });
        } catch {
          /* sem tempo real, o polling abaixo cobre */
        }
      }
    })();
    // Polling de reserva (5s): cobre o modo local e qualquer falha do
    // tempo real — a fila nunca fica desatualizada.
    const timer = setInterval(() => {
      void refreshJobs();
    }, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
      if (unsub) unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Quando o diálogo de impressão fecha, a via sai da fila como
   * impressa (computador). */
  useEffect(() => {
    const onAfterPrint = () => {
      if (!printingJobId) return;
      const id = printingJobId;
      setPrintingJobId(null);
      setPrintAreaJob(null);
      printingRef.current = false;
      void store
        .markPrintJobPrinted(id, 'computer')
        .then(() => refreshJobs())
        .catch(() => {
          setError('A via saiu no papel, mas não foi marcada como impressa.');
        });
    };
    window.addEventListener('afterprint', onAfterPrint);
    return () => window.removeEventListener('afterprint', onAfterPrint);
  }, [printingJobId]);

  /** Renderizou a via na área de impressão: abre o diálogo. */
  useEffect(() => {
    if (!printAreaJob) return;
    const t = setTimeout(() => {
      window.print();
    }, 350);
    // Segurança: se o diálogo nunca fechar (navegador sem suporte),
    // destrava a fila depois de 2 minutos.
    const guard = setTimeout(() => {
      if (printingRef.current && printingJobId === printAreaJob.id) {
        printingRef.current = false;
        setPrintingJobId(null);
        setPrintAreaJob(null);
      }
    }, 120000);
    return () => {
      clearTimeout(t);
      clearTimeout(guard);
    };
  }, [printAreaJob, printingJobId]);

  /** Processa a fila sozinha: pega a primeira via pendente e imprime
   * pelo caminho do setor dela (computador, celular ou simulação). */
  useEffect(() => {
    if (loading) return;
    if (printingRef.current) return;
    const pending = jobs.filter((j) => j.status === 'pending');
    if (pending.length === 0) return;
    const job = pending[0];
    const cfg = printers.find((p) => p.sector === job.sector);
    // Sem impressora cadastrada ou desligada: a via fica pendente na
    // fila, visível, até o dono ligar a impressora (nada some).
    if (!cfg || !cfg.enabled) return;
    if (simulation) {
      void (async () => {
        await store.markPrintJobPrinted(job.id, 'simulation');
        await refreshJobs();
      })();
      return;
    }
    if (cfg.bridge === 'computer') {
      if (!autoPrint) return;
      printingRef.current = true;
      setPrintingJobId(job.id);
      setPrintAreaJob(job);
      return;
    }
    // Ponte do celular: só manda sozinho com o Bluetooth conectado.
    if (btState === 'connected' && btCharRef.current) {
      printingRef.current = true;
      void sendViaBluetooth(job);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, printers, simulation, autoPrint, btState, loading]);

  async function sendViaBluetooth(job: PrintJob) {
    try {
      const bytes = buildEscPosSlip(job, restaurantName);
      const char = btCharRef.current as {
        writeValueWithoutResponse?: (d: Uint8Array) => Promise<void>;
        writeValue?: (d: Uint8Array) => Promise<void>;
      } | null;
      if (!char) throw new Error('Bluetooth desconectado.');
      // Escreve em pedaços (a maioria das térmicas aceita ~180 bytes
      // por escrita sem resposta).
      const chunk = 180;
      for (let i = 0; i < bytes.length; i += chunk) {
        const slice = bytes.slice(i, i + chunk);
        if (typeof char.writeValueWithoutResponse === 'function') {
          await char.writeValueWithoutResponse(slice);
        } else if (typeof char.writeValue === 'function') {
          await char.writeValue(slice);
        } else {
          throw new Error('Impressora sem escrita Bluetooth.');
        }
      }
      await store.markPrintJobPrinted(job.id, 'phone');
      setNotice(
        `Via ${String(job.order_number).padStart(4, '0')} impressa no ${printerSectorLabel(job.sector)} (Bluetooth).`,
      );
    } catch (e) {
      await store.markPrintJobFailed(job.id).catch(() => {});
      setNotice(
        'Falha no Bluetooth — a via ficou na fila. Verifique a impressora e toque em "Tentar de novo".',
      );
    } finally {
      printingRef.current = false;
      await refreshJobs();
    }
  }

  async function connectBluetooth() {
    const nav = navigator as unknown as { bluetooth?: {
      requestDevice: (opts: unknown) => Promise<{
        name?: string;
        gatt: { connect: () => Promise<{
          getPrimaryService: (uuid: string) => Promise<{
            getCharacteristic: (uuid: string) => Promise<unknown>;
          }>;
        }> };
        addEventListener: (ev: string, cb: () => void) => void;
      }>;
    } };
    if (!nav.bluetooth) {
      setBtState('unsupported');
      setBtError(
        'Este aparelho/navegador não tem Bluetooth web. Use o computador do balcão ou imprima pelo sistema.',
      );
      return;
    }
    setBtState('connecting');
    setBtError('');
    try {
      const device = await nav.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [BT_NUS_SERVICE],
      });
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(BT_NUS_SERVICE);
      const char = await service.getCharacteristic(BT_NUS_TX);
      btCharRef.current = char;
      device.addEventListener('gattserverdisconnected', () => {
        btCharRef.current = null;
        setBtState('disconnected');
      });
      setBtState('connected');
      setNotice(
        `Impressora Bluetooth conectada (${device.name ?? 'sem nome'}). As vias do celular saem sozinhas agora.`,
      );
    } catch (e) {
      btCharRef.current = null;
      setBtState('error');
      setBtError(
        e instanceof Error ? e.message : 'Não foi possível conectar.',
      );
    }
  }

  async function testBluetooth() {
    if (btState !== 'connected' || !btCharRef.current) {
      setNotice('Conecte a impressora Bluetooth primeiro.');
      return;
    }
    try {
      const sector =
        printers.find((p) => p.bridge === 'phone' && p.enabled)?.sector ??
        'kitchen';
      const bytes = buildEscPosTestSlip(restaurantName, sector);
      const char = btCharRef.current as {
        writeValueWithoutResponse?: (d: Uint8Array) => Promise<void>;
        writeValue?: (d: Uint8Array) => Promise<void>;
      };
      const chunk = 180;
      for (let i = 0; i < bytes.length; i += chunk) {
        const slice = bytes.slice(i, i + chunk);
        if (typeof char.writeValueWithoutResponse === 'function') {
          await char.writeValueWithoutResponse(slice);
        } else if (typeof char.writeValue === 'function') {
          await char.writeValue(slice);
        }
      }
      setNotice('Cupom de teste enviado por Bluetooth.');
    } catch {
      setNotice('Falha ao enviar o teste por Bluetooth.');
    }
  }

  /** Imprime uma via agora (botão da fila). */
  async function manualPrint(job: PrintJob) {
    if (printingRef.current) return;
    const cfg = printers.find((p) => p.sector === job.sector);
    if (simulation) {
      await store.markPrintJobPrinted(job.id, 'simulation');
      setNotice(
        `Via ${String(job.order_number).padStart(4, '0')} registrada como impressa (simulação).`,
      );
      await refreshJobs();
      return;
    }
    if (!cfg || !cfg.enabled) {
      setNotice(
        'Sem impressora cadastrada neste setor — a via fica na fila. Cadastre em Ajustes → Impressoras.',
      );
      return;
    }
    if (cfg.bridge === 'phone') {
      if (btState === 'connected' && btCharRef.current) {
        printingRef.current = true;
        await sendViaBluetooth(job);
        return;
      }
      setNotice(
        'Bluetooth desligado — imprimindo pelo sistema. Conecte a impressora Bluetooth pra mandar direto.',
      );
    }
    printingRef.current = true;
    setPrintingJobId(job.id);
    setPrintAreaJob(job);
  }

  async function reprint(job: PrintJob) {
    await store.retryPrintJob(job.id);
    setNotice(
      `Via ${String(job.order_number).padStart(4, '0')} voltou pra fila pra imprimir de novo.`,
    );
    await refreshJobs();
  }

  async function retryFailed(job: PrintJob) {
    await store.retryPrintJob(job.id);
    setNotice(
      `Via ${String(job.order_number).padStart(4, '0')} voltou pra fila.`,
    );
    await refreshJobs();
  }

  const pendingJobs = jobs.filter((j) => j.status === 'pending');
  const failedJobs = jobs.filter((j) => j.status === 'failed');
  const printedJobs = jobs
    .filter((j) => j.status === 'printed')
    .slice(-10)
    .reverse();
  const hasPhoneBridge = printers.some(
    (p) => p.bridge === 'phone' && p.enabled,
  );
  const totalItems = (j: PrintJob) =>
    j.items.reduce((s, i) => s + i.qty, 0);

  return (
    <div className="app app-owner">
      <div className="print-center-head">
        <div>
          <h1 style={{ margin: 0 }}>Central de impressão</h1>
          <p className="hint" style={{ margin: '4px 0 0' }}>
            {restaurantName} · {ownerName} · fica aberta no balcão
          </p>
        </div>
        <div className="print-center-head-btns">
          <button
            className="btn btn-white"
            onClick={() => onNavigate('owner-settings')}
          >
            Impressoras
          </button>
          <button className="btn btn-white" onClick={onLogout}>
            Sair
          </button>
        </div>
      </div>
      <div className="content">
        {error && <div className="error">{error}</div>}
        {notice && <div className="ok-note">{notice}</div>}
        {simulation && (
          <div className="print-sim-banner">
            Modo simulação ligado — nenhuma via sai na impressora de
            verdade. As vias são registradas como "impressa (simulada)"
            pra testar o fluxo sem hardware.
          </div>
        )}
        {loading ? (
          <div className="card">Carregando a central…</div>
        ) : (
          <>
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Impressoras por setor</h2>
              {PRINT_SECTORS.map((sector) => {
                const cfg = printers.find((p) => p.sector === sector);
                const pending = pendingJobs.filter(
                  (j) => j.sector === sector,
                ).length;
                return (
                  <div key={sector} className="printer-status">
                    <div>
                      <strong>{printerSectorLabel(sector)}</strong>
                      <div className="hint">
                        {cfg
                          ? `${cfg.name || 'Sem nome'} · ${printerConnectionLabel(cfg.connection)} · ${printerBridgeLabel(cfg.bridge)}${cfg.enabled ? '' : ' · desligada'}`
                          : 'Sem impressora cadastrada'}
                      </div>
                      {cfg?.bridge === 'phone' && (
                        <div className="hint">
                          Bluetooth:{' '}
                          {btState === 'connected'
                            ? 'conectado'
                            : btState === 'connecting'
                              ? 'conectando…'
                              : btState === 'unsupported'
                                ? 'não disponível neste aparelho'
                                : 'desligado'}
                        </div>
                      )}
                    </div>
                    <span
                      className={
                        'print-badge ' +
                        (pending > 0 ? 'print-badge-pending' : 'print-badge-ok')
                      }
                    >
                      {pending > 0
                        ? `${pending} na fila`
                        : 'fila vazia'}
                    </span>
                  </div>
                );
              })}
              <div className="field" style={{ marginTop: 12 }}>
                <label>
                  <input
                    type="checkbox"
                    checked={autoPrint}
                    onChange={(e) => {
                      setAutoPrint(e.target.checked);
                      safeSet(
                        'central_autoprint_v1',
                        e.target.checked ? '1' : '0',
                      );
                    }}
                  />{' '}
                  Imprimir automaticamente quando a via chegar
                </label>
              </div>
              <div className="field">
                <label>
                  <input
                    type="checkbox"
                    checked={simulation}
                    onChange={(e) => {
                      setSimulation(e.target.checked);
                      safeSet(
                        'central_simulacao_v1',
                        e.target.checked ? '1' : '0',
                      );
                    }}
                  />{' '}
                  Modo simulação (sem impressora ligada)
                </label>
              </div>
              {hasPhoneBridge && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    className="btn btn-purple"
                    disabled={
                      btState === 'connecting' || btState === 'connected'
                    }
                    onClick={() => void connectBluetooth()}
                  >
                    {btState === 'connected'
                      ? 'Bluetooth conectado'
                      : btState === 'connecting'
                        ? 'Conectando…'
                        : 'Conectar impressora Bluetooth'}
                  </button>
                  {btState === 'connected' && (
                    <button
                      className="btn btn-white"
                      onClick={() => void testBluetooth()}
                    >
                      Testar Bluetooth
                    </button>
                  )}
                </div>
              )}
              {btError && <div className="error">{btError}</div>}
              <p className="hint">
                No computador do balcão, pra imprimir sem pedir
                confirmação a cada cupom, abra o Chrome com a opção
                --kiosk-printing. Sem ela, o diálogo de impressão abre
                uma vez por cupom — a via só sai da fila depois que
                você confirma.
              </p>
            </div>

            <div className="card">
              <h2 style={{ marginTop: 0 }}>
                Fila de impressão ({pendingJobs.length + failedJobs.length})
              </h2>
              {pendingJobs.length === 0 && failedJobs.length === 0 ? (
                <p className="hint">Nenhuma via esperando. Quando o garçom enviar um pedido ou fechar uma mesa, a via aparece aqui e imprime sozinha.</p>
              ) : (
                <>
                  {failedJobs.map((job) => (
                    <div key={job.id} className="print-job print-job-failed">
                      <div>
                        <strong>
                          {printerSectorLabel(job.sector)} · Pedido Nº{' '}
                          {String(job.order_number).padStart(4, '0')}
                        </strong>
                        <div className="hint">
                          Mesa {job.table_number} ·{' '}
                          {formatTime(job.created_at)} · Garçom{' '}
                          {job.waiter_name} · {totalItems(job)} item(ns)
                        </div>
                        <div className="error" style={{ marginTop: 4 }}>
                          Falha na impressão — a via não se perdeu, está
                          na fila.
                        </div>
                      </div>
                      <div className="print-job-btns">
                        <button
                          className="btn btn-orange"
                          onClick={() => void retryFailed(job)}
                        >
                          Tentar de novo
                        </button>
                        <button
                          className="btn btn-white"
                          onClick={() => setPreviewJob(job)}
                        >
                          Ver via
                        </button>
                      </div>
                    </div>
                  ))}
                  {pendingJobs.map((job) => {
                    const cfg = printers.find((p) => p.sector === job.sector);
                    const noPrinter = !cfg || !cfg.enabled;
                    return (
                      <div key={job.id} className="print-job">
                        <div>
                          <strong>
                            {printerSectorLabel(job.sector)} · Pedido Nº{' '}
                            {String(job.order_number).padStart(4, '0')}
                          </strong>
                          <div className="hint">
                            Mesa {job.table_number} ·{' '}
                            {formatTime(job.created_at)} · Garçom{' '}
                            {job.waiter_name} · {totalItems(job)} item(ns)
                            {cfg ? ` · ${printerBridgeLabel(cfg.bridge)}` : ''}
                          </div>
                          {noPrinter && (
                            <div className="hint" style={{ color: '#b45309' }}>
                              Sem impressora neste setor — a via espera
                              aqui até o dono ligar uma em Ajustes →
                              Impressoras.
                            </div>
                          )}
                          {cfg?.bridge === 'phone' &&
                            btState !== 'connected' && (
                              <div
                                className="hint"
                                style={{ color: '#b45309' }}
                              >
                                Aguardando o Bluetooth — conecte a
                                impressora acima.
                              </div>
                            )}
                        </div>
                        <div className="print-job-btns">
                          <button
                            className="btn btn-orange"
                            disabled={printingRef.current}
                            onClick={() => void manualPrint(job)}
                          >
                            Imprimir agora
                          </button>
                          <button
                            className="btn btn-white"
                            onClick={() => setPreviewJob(job)}
                          >
                            Ver via
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>

            {printedJobs.length > 0 && (
              <div className="card">
                <h2 style={{ marginTop: 0 }}>Últimas impressas</h2>
                {printedJobs.map((job) => (
                  <div key={job.id} className="print-job print-job-done">
                    <div>
                      <strong>
                        {printerSectorLabel(job.sector)} · Pedido Nº{' '}
                        {String(job.order_number).padStart(4, '0')}
                      </strong>
                      <div className="hint">
                        Mesa {job.table_number} ·{' '}
                        {job.printed_at
                          ? formatTime(job.printed_at)
                          : formatTime(job.created_at)}{' '}
                        · {printViaLabel(job.printed_via)}
                      </div>
                    </div>
                    <div className="print-job-btns">
                      <button
                        className="btn btn-white"
                        onClick={() => void reprint(job)}
                      >
                        Reimprimir
                      </button>
                      <button
                        className="btn btn-white"
                        onClick={() => setPreviewJob(job)}
                      >
                        Ver via
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {previewJob && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3 style={{ marginTop: 0 }}>
              Via — {printerSectorLabel(previewJob.sector)} · Pedido Nº{' '}
              {String(previewJob.order_number).padStart(4, '0')}
            </h3>
            <PrintJobSlip
              job={previewJob}
              restaurantName={restaurantName}
            />
            <p className="hint">
              Conteúdo em ESC/POS (Bluetooth):{' '}
              <code>
                {decodeEscPosText(
                  buildEscPosSlip(previewJob, restaurantName),
                )
                  .split('\n')
                  .slice(0, 3)
                  .join(' / ')}
                …
              </code>
            </p>
            <button
              className="btn btn-purple"
              onClick={() => setPreviewJob(null)}
            >
              Fechar
            </button>
          </div>
        </div>
      )}

      {/* Área de impressão do computador: fora da tela, só aparece no
          papel (CSS @media print). */}
      <div id="print-area" aria-hidden="true">
        {printAreaJob && (
          <PrintJobSlip
            job={printAreaJob}
            restaurantName={restaurantName}
          />
        )}
      </div>
    </div>
  );
}

function OwnerSettingsView({
  settings,
  restaurantName,
  ownerName,
  printers,
  onSaved,
  onSavedPrinters,
  onOpenPrintCenter,
  onNavigate,
  onLogout,
}: {
  settings: Settings;
  restaurantName: string;
  ownerName: string;
  /** impressoras cadastradas (uma por setor) */
  printers: PrinterConfig[];
  onSaved: () => Promise<void>;
  onSavedPrinters: () => Promise<void>;
  onOpenPrintCenter: () => void;
  onNavigate: (v: View) => void;
  onLogout: () => void;
}) {
  const [fee, setFee] = useState(String(settings.service_fee_pct));
  /** rascunho das impressoras (3 setores) — salvo à parte dos ajustes */
  const [draft, setDraft] = useState<PrinterConfig[]>(() =>
    PRINT_SECTORS.map((sector) => {
      const found = (printers ?? []).find((p) => p.sector === sector);
      return (
        found ?? {
          sector,
          name: '',
          connection: 'usb',
          bridge: 'computer',
          enabled: false,
        }
      );
    }),
  );
  const [printersSaved, setPrintersSaved] = useState(false);
  const [printersBusy, setPrintersBusy] = useState(false);
  const [printersError, setPrintersError] = useState('');
  /** cupom de teste em prévia (modal) */
  const [testJob, setTestJob] = useState<PrintJob | null>(null);

  function setDraftSector(
    sector: PrinterSector,
    patch: Partial<PrinterConfig>,
  ) {
    setDraft((prev) =>
      prev.map((p) => (p.sector === sector ? { ...p, ...patch } : p)),
    );
  }

  async function savePrinters() {
    setPrintersError('');
    setPrintersSaved(false);
    setPrintersBusy(true);
    try {
      // Só grava os setores com nome (setor sem nome = sem impressora).
      const list = draft
        .filter((p) => p.name.trim().length > 0)
        .map((p) => ({ ...p, name: p.name.trim() }));
      await store.savePrinterConfig(list);
      await onSavedPrinters();
      setPrintersSaved(true);
    } catch (e) {
      setPrintersError(
        e instanceof Error ? e.message : 'Não foi possível salvar.',
      );
    } finally {
      setPrintersBusy(false);
    }
  }

  /** Monta o cupom de teste de um setor (prévia + impressão). */
  function openTest(sector: PrinterSector) {
    const job: PrintJob = {
      id: 'teste-' + sector,
      sector,
      kind: sector === 'counter' ? 'close' : 'send',
      order_number: 0,
      table_number: 0,
      waiter_name: 'Teste',
      items:
        sector === 'counter'
          ? [
              { product_name: 'Prato teste', qty: 1, price_cents: 2500 },
              { product_name: 'Bebida teste', qty: 1, price_cents: 899 },
            ]
          : [
              {
                product_name: 'Item teste',
                qty: 1,
                price_cents: 1000,
                description:
                  sector === 'kitchen'
                    ? 'o que vem no prato (teste)'
                    : undefined,
                serve:
                  sector === 'bar' ? 'copo com limao e gelo' : undefined,
              },
            ],
      bill:
        sector === 'counter'
          ? { subtotal_cents: 3399, fee_cents: 102, total_cents: 3501 }
          : null,
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    setTestJob(job);
  }
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
    if (!Number.isInteger(count) || count < 1 || count > 60) {
      setError('Número de mesas inválido (de 1 a 60).');
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
    <div className="app app-owner">
      <OwnerHeader
        tab="settings"
        restaurantName={restaurantName}
        ownerName={ownerName}
        onNavigate={onNavigate}
        onLogout={onLogout}
      />
      <div className="content">
        {error && <div className="error">{error}</div>}
        {saved && <div className="ok-note">Ajustes salvos.</div>}
        <div className="card">
          <h2>Ajustes</h2>
          <div className="field">
            <label htmlFor="owner-fee">Taxa de serviço (%)</label>
            <input
              id="owner-fee"
              inputMode="decimal"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
            />
            <p className="hint" style={{ marginTop: 6, marginBottom: 0 }}>
              Somada em cima do consumo em toda conta (padrão 3%).
            </p>
          </div>
          <div className="field">
            <label htmlFor="owner-commission">
              Comissão padrão dos garçons (%)
            </label>
            <input
              id="owner-commission"
              inputMode="decimal"
              value={commission}
              onChange={(e) => setCommission(e.target.value)}
            />
            <p className="hint" style={{ marginTop: 6, marginBottom: 0 }}>
              Vale pros garçons cadastrados daqui pra frente. Quem já
              existe mantém a % dele — pra mudar, edite o garçom na aba
              Garçons.
            </p>
          </div>
          <div className="field">
            <label htmlFor="owner-tables">Número de mesas</label>
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

        {/* Impressoras térmicas — o dono liga sozinho, sem técnico:
            cadastra a impressora de cada setor (nome, ligação e ponte),
            testa e abre a central de impressão. */}
        <div className="card">
          <h2>Impressoras</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Cada setor tem a sua impressora térmica (80mm, ESC/POS — a
            que você já tem no restaurante). Escolha por onde a via
            chega até ela: pelo computador do balcão ou pelo celular
            parado no balcão (Bluetooth). Depois é só apertar
            "Testar" — sai um cupom de teste.
          </p>
          {printersError && <div className="error">{printersError}</div>}
          {printersSaved && (
            <div className="ok-note">Impressoras salvas.</div>
          )}
          {draft.map((cfg) => (
            <div key={cfg.sector} className="printer-card">
              <strong>{printerSectorLabel(cfg.sector)}</strong>
              <div className="field">
                <label htmlFor={`printer-name-${cfg.sector}`}>
                  Nome da impressora
                </label>
                <input
                  id={`printer-name-${cfg.sector}`}
                  placeholder="Ex.: Bematech da cozinha"
                  value={cfg.name}
                  onChange={(e) =>
                    setDraftSector(cfg.sector, { name: e.target.value })
                  }
                />
              </div>
              <div className="field">
                <label htmlFor={`printer-conn-${cfg.sector}`}>
                  Como ela liga
                </label>
                <select
                  id={`printer-conn-${cfg.sector}`}
                  value={cfg.connection}
                  onChange={(e) =>
                    setDraftSector(cfg.sector, {
                      connection: e.target.value as PrinterConnection,
                    })
                  }
                >
                  <option value="usb">USB</option>
                  <option value="bluetooth">Bluetooth</option>
                  <option value="wifi">Wi-Fi ou rede</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor={`printer-bridge-${cfg.sector}`}>
                  Quem leva a via até ela
                </label>
                <select
                  id={`printer-bridge-${cfg.sector}`}
                  value={cfg.bridge}
                  onChange={(e) =>
                    setDraftSector(cfg.sector, {
                      bridge: e.target.value as PrinterBridge,
                    })
                  }
                >
                  <option value="computer">Computador do balcão</option>
                  <option value="phone">Celular na central</option>
                </select>
                <p className="hint" style={{ marginTop: 6, marginBottom: 0 }}>
                  {cfg.bridge === 'computer'
                    ? 'O computador do balcão fica com a central aberta e imprime pelo navegador.'
                    : 'Um celular velho parado no balcão, com a central aberta, manda a via por Bluetooth.'}
                </p>
              </div>
              <div className="field">
                <label>
                  <input
                    type="checkbox"
                    checked={cfg.enabled}
                    onChange={(e) =>
                      setDraftSector(cfg.sector, {
                        enabled: e.target.checked,
                      })
                    }
                  />{' '}
                  Impressão automática ligada
                </label>
              </div>
              <button
                className="btn btn-white"
                onClick={() => openTest(cfg.sector)}
              >
                Testar
              </button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn btn-purple"
              disabled={printersBusy}
              onClick={() => void savePrinters()}
            >
              Salvar impressoras
            </button>
            <button className="btn btn-orange" onClick={onOpenPrintCenter}>
              Abrir central de impressão
            </button>
          </div>
          <p className="hint">
            Sem impressora cadastrada, a via fica na fila da central como
            pendente — nada se perde. Pra testar sem hardware, ligue o
            modo simulação na central.
          </p>
        </div>
      </div>

      {testJob && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3 style={{ marginTop: 0 }}>
              Teste — {printerSectorLabel(testJob.sector)}
            </h3>
            {!(draft.find((p) => p.sector === testJob.sector)?.name ?? '')
              .trim() && (
              <div className="print-sim-banner">
                Simulação — nenhuma impressora cadastrada neste setor.
                Cadastre o nome acima e salve, ou teste na central de
                impressão.
              </div>
            )}
            <PrintJobSlip
              job={testJob}
              restaurantName={restaurantName}
            />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                className="btn btn-orange"
                onClick={() => window.print()}
              >
                Imprimir teste
              </button>
              <button
                className="btn btn-white"
                onClick={() => setTestJob(null)}
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Área de impressão do teste: fora da tela, só sai no papel. */}
      <div id="print-area" aria-hidden="true">
        {testJob && (
          <PrintJobSlip job={testJob} restaurantName={restaurantName} />
        )}
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
