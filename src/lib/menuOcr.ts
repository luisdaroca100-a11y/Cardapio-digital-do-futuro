/**
 * Cardápio por foto (OCR) — parser do texto lido da foto do cardápio.
 *
 * Regras (decididas com o Luis):
 *  - Linha com preço no fim ("Casarão 1 ......... 32,90" ou
 *    "Coca 600ml R$ 8,90") vira um item (nome, preço em centavos).
 *  - Linha sem preço que parece título de seção ("ALMOÇO", "Bebidas",
 *    "PORÇÕES") vira a categoria dos itens abaixo dela.
 *  - Linha que não é item nem seção (descrição, rodapé, sujeira do
 *    OCR) é ignorada e contada em `skipped`.
 *  - "O que vem no prato" fica vazio (o dono completa depois);
 *    tipo de bebida padrão é "outro"; produto criado ativo.
 *  - Nome que já existe no cardápio é marcado (`exists: true`) — o
 *    dono decide se inclui ou não; nada duplica em silêncio.
 *
 * Puro (sem DOM, sem rede): dá pra testar em Node no smoke test e
 * reutilizar no navegador com o texto que o Tesseract.js devolve.
 */

export type OcrPrintsIn = 'kitchen' | 'bar';

export interface OcrSuggestion {
  name: string;
  priceCents: number;
  category: string;
  printsIn: OcrPrintsIn;
  /** tipo de bebida padrão — o dono edita se for refrigerante/cerveja/torre */
  drinkType: 'outro';
  /** já existe um produto com esse nome no cardápio */
  exists: boolean;
}

export interface ParsedMenu {
  items: OcrSuggestion[];
  sections: string[];
  /** linhas ignoradas (nem item, nem seção) */
  skipped: number;
}

/** Normaliza um nome pra comparar duplicados (minúsculo, sem acento). */
export function normalizeMenuName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Palavras que, sozinhas, são título de seção de cardápio. */
const KNOWN_SECTIONS = new Set([
  'almoco',
  'almocos',
  'porcoes',
  'bebidas',
  'cervejas',
  'chopp',
  'chopps',
  'sobremesas',
  'cafe',
  'cafes',
  'entradas',
  'pratos',
  'massas',
  'pizzas',
  'lanches',
  'saladas',
  'drinks',
  'sucos',
  'refrigerantes',
  'doces',
  'petiscos',
  'grelhados',
  'peixes',
  'carnes',
  'combos',
  'promocoes',
  'vinhos',
  'destilados',
  'caldos',
  'sopas',
  'sanduiches',
  'tapiocas',
  'acai',
  'milkshakes',
  'vitaminas',
  'aguas',
]);

/** Categorias que imprimem no bar (o resto vai pra cozinha). */
const BAR_CATEGORIES = new Set([
  'bebidas',
  'cervejas',
  'chopp',
  'chopps',
  'cafe',
  'cafes',
  'drinks',
  'sucos',
  'refrigerantes',
  'vinhos',
  'destilados',
  'aguas',
  'milkshakes',
  'vitaminas',
  'acai',
]);

export function guessPrintsIn(category: string): OcrPrintsIn {
  return BAR_CATEGORIES.has(normalizeMenuName(category)) ? 'bar' : 'kitchen';
}

/**
 * Preço no fim da linha: "32,90" | "32,9" | "32.90" | "R$ 32,90" |
 * "1.234,56". Devolve { name, priceCents } ou null.
 * O OCR às vezes lê 0 como O e 1 como l — tolera isso SÓ no preço.
 * E às vezes lê a vírgula como barra ("12/00") — tolera também.
 */
const PRICE_END_RE =
  /(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*,\d{1,2}|\d+,\d{1,2}|\d+\.\d{2}|\d+\/\d{2})\s*$/;

/**
 * Normaliza um token do nome que o OCR costuma ler errado.
 * Casos medidos no teste real (foto de cardápio com pontilhado):
 *  - "600ml" sai como "600mil", "600miI", "600m!", "600M", "6O0MI"
 *    -> "600ml"; "3L" sai como "3E" -> "3L"; "6un" sai como "6uh"
 *    ou "GUN" -> "6un". Só mexe em token que começa com dígito
 *    (ou é exatamente "GUN"), pra não tocar em palavra normal.
 */
export function normalizeOcrToken(token: string): string {
  let t = token.replace(/^[.,;:!|"'·\-–—]+|[.,;:!|"'·\-–—]+$/g, '');
  if (!t) return t;
  if (/^\d/.test(t)) {
    t = t.replace(/(\d)[oO](\d)/g, '$10$2');
    if (/^\d+m[i1l!|]+$/i.test(t)) return t.replace(/^(\d+)m[i1l!|]+$/i, '$1ml');
    if (/^\d+m$/i.test(t)) return t.replace(/^(\d+)m$/i, '$1ml');
    if (/^\d+uh$/i.test(t)) return t.replace(/^(\d+)uh$/i, '$1un');
    if (/^\d+e$/i.test(t)) return t.replace(/^(\d+)e$/i, '$1L');
    return t;
  }
  if (/^gun$/i.test(t)) return '6un';
  return t;
}

/** Aplica normalizeOcrToken em cada palavra do nome. */
export function normalizeOcrName(name: string): string {
  return name
    .split(/\s+/)
    .map(normalizeOcrToken)
    .filter(Boolean)
    .join(' ');
}

export function extractTrailingPrice(line: string): {
  name: string;
  priceCents: number;
} | null {
  // O OCR às vezes lê 0 como O e 1 como l no preço ("31,9O") — tolera
  // isso SÓ colado a dígito, antes de procurar o preço.
  const cleaned = line
    .replace(/(?<=\d)[Oo]/g, '0')
    .replace(/(?<=\d)[lI]/g, '1');
  const m = cleaned.match(PRICE_END_RE);
  if (!m) return null;
  const raw = m[1];
  let cents: number;
  if (raw.includes(',') || raw.includes('/')) {
    // Vírgula (ou barra lida no lugar dela) é o decimal; ponto é
    // milhar ("1.234,56" -> 123456; "12/00" -> 1200).
    const v = Number(
      raw.replace(/\./g, '').replace(',', '.').replace('/', '.'),
    );
    if (!Number.isFinite(v) || v <= 0) return null;
    cents = Math.round(v * 100);
  } else {
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) return null;
    cents = Math.round(v * 100);
  }
  const name = cleaned
    .slice(0, m.index)
    .replace(/^[-•·\s]+/, '')
    .replace(/[\s.\-–—:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) return null;
  return { name, priceCents: cents };
}

/** Linha sem preço que é título de seção (ex.: "ALMOÇO", "Bebidas"). */
export function isSectionTitle(line: string): boolean {
  const t = line.trim().replace(/[:–—]+$/, '').trim();
  if (!t || t.length > 30 || /\d/.test(t)) return false;
  const letters = t.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (letters.length < 2) return false;
  const allUpper = t === t.toUpperCase() && /[A-ZÀ-Þ]/.test(t);
  if (allUpper) return true;
  return KNOWN_SECTIONS.has(normalizeMenuName(t));
}

/** "ALMOÇO" -> "Almoço" (pra não criar categoria duplicada em maiúsculo). */
export function titleCaseSection(t: string): string {
  const lower = t.trim().toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Lê o texto do OCR e devolve os itens sugeridos.
 * `existing` leva nomes e categorias que já existem no cardápio, pra
 * marcar duplicados e reaproveitar a grafia da categoria.
 */
export function parseMenuText(
  text: string,
  existing: { names: string[]; categories: string[] } = {
    names: [],
    categories: [],
  },
): ParsedMenu {
  const existingNames = new Set(existing.names.map(normalizeMenuName));
  const categoryByNorm = new Map(
    existing.categories.map((c) => [normalizeMenuName(c), c] as const),
  );
  const items: OcrSuggestion[] = [];
  const sections: string[] = [];
  let skipped = 0;
  let category = '';
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const priced = extractTrailingPrice(line);
    if (priced) {
      const cat = category || '';
      if (cat && !sections.includes(cat)) sections.push(cat);
      const name = normalizeOcrName(priced.name);
      items.push({
        name,
        priceCents: priced.priceCents,
        category: cat,
        printsIn: guessPrintsIn(cat),
        drinkType: 'outro',
        exists: existingNames.has(normalizeMenuName(name)),
      });
      continue;
    }
    if (isSectionTitle(line)) {
      const titled = titleCaseSection(line);
      const norm = normalizeMenuName(titled);
      category = categoryByNorm.get(norm) ?? titled;
      continue;
    }
    skipped += 1;
  }
  return { items, sections, skipped };
}

/**
 * Limpa os pontinhos do pontilhado ("nome ......... preço") antes do
 * OCR — medido no teste real: sem limpar, o Tesseract lê os pontos
 * como letras ("eee", "ro", "cc") e acerta só 6 de 36 itens; limpando,
 * acerta 36 de 36 (com a normalização de "ml").
 *
 * Como funciona (dois passos): binariza (tinta = luminância < 160),
 * rotula os componentes conexos (8 vizinhos) e apaga o componente
 * pequeno (largura e altura <= 8px) que NÃO tem por perto (a) nenhuma
 * outra tinta a até 3px pros lados / 8px pra cima-baixo, NEM (b) tinta
 * de componente GRANDE (> 8px) a até 6px / 8px. O pontinho do
 * pontilhado só vê outro pontinho (pequeno e a ~6px) e some; a vírgula
 * do preço vê o dígito (grande), o ponto do "i" vê a haste (grande),
 * e letrinha de foto de longe vê a letra vizinha (a ~3px). A tinta
 * apagada é pintada de branco NA IMAGEM ORIGINAL (só a análise é
 * binária), então o texto real não perde cinza nem antisserrilhamento.
 *
 * Recebe um ImageData (ou { width, height, data }) e edita `data` no
 * lugar. Devolve quantos pontinhos foram apagados. Puro (sem DOM):
 * dá pra testar em Node com um ImageData sintético.
 */
export function cleanMenuPhoto(imageData: {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}): { removed: number } {
  const w = imageData.width;
  const h = imageData.height;
  const data = imageData.data;
  const n = w * h;
  if (n === 0 || data.length < n * 4) return { removed: 0 };
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const lum = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    ink[i] = lum < 160 ? 1 : 0;
  }
  // Passo 1: rotula todos os componentes e guarda bbox + pixels.
  const labels = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  interface Comp {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    pixels: number[];
  }
  const comps: Comp[] = [];
  for (let start = 0; start < n; start++) {
    if (!ink[start] || labels[start] !== -1) continue;
    const id = comps.length + 1;
    const comp: Comp = {
      minX: start % w,
      maxX: start % w,
      minY: Math.floor(start / w),
      maxY: Math.floor(start / w),
      pixels: [],
    };
    comps.push(comp);
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;
    while (sp > 0) {
      const p = stack[--sp];
      comp.pixels.push(p);
      const x = p % w;
      const y = Math.floor(p / w);
      if (x < comp.minX) comp.minX = x;
      if (x > comp.maxX) comp.maxX = x;
      if (y < comp.minY) comp.minY = y;
      if (y > comp.maxY) comp.maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const np = ny * w + nx;
          if (ink[np] && labels[np] === -1) {
            labels[np] = id;
            stack[sp++] = np;
          }
        }
      }
    }
  }
  // Passo 2: apaga o componente pequeno sem vizinho que o proteja.
  const MAXS = 8;
  const VY = 8;
  const compMax = comps.map((c) =>
    Math.max(c.maxX - c.minX + 1, c.maxY - c.minY + 1),
  );
  let removed = 0;
  for (let i = 0; i < comps.length; i++) {
    if (compMax[i] > MAXS) continue;
    const c = comps[i];
    const id = i + 1;
    let keep = false;
    // (a) Qualquer tinta a até 3px pros lados / 8px pra cima-baixo.
    const ax0 = Math.max(0, c.minX - 3);
    const ax1 = Math.min(w - 1, c.maxX + 3);
    const ay0 = Math.max(0, c.minY - VY);
    const ay1 = Math.min(h - 1, c.maxY + VY);
    outerA: for (let yy = ay0; yy <= ay1; yy++) {
      for (let xx = ax0; xx <= ax1; xx++) {
        const p = yy * w + xx;
        if (ink[p] && labels[p] !== id) {
          keep = true;
          break outerA;
        }
      }
    }
    // (b) Tinta de componente GRANDE a até 6px pros lados / 8px.
    if (!keep) {
      const bx0 = Math.max(0, c.minX - 6);
      const bx1 = Math.min(w - 1, c.maxX + 6);
      const by0 = Math.max(0, c.minY - VY);
      const by1 = Math.min(h - 1, c.maxY + VY);
      outerB: for (let yy = by0; yy <= by1; yy++) {
        for (let xx = bx0; xx <= bx1; xx++) {
          const p = yy * w + xx;
          const lab = labels[p];
          if (ink[p] && lab !== id && lab > 0 && compMax[lab - 1] > MAXS) {
            keep = true;
            break outerB;
          }
        }
      }
    }
    if (!keep) {
      for (const p of c.pixels) {
        const o = p * 4;
        data[o] = 255;
        data[o + 1] = 255;
        data[o + 2] = 255;
      }
      removed += 1;
    }
  }
  return { removed };
}
