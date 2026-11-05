type Child = Node | string | number | null | undefined | false;
type Props = {
  class?: string;
  text?: string;
  title?: string;
  html?: string;
  attrs?: Record<string, string>;
  data?: Record<string, string>;
} & { [event: `on${string}`]: ((e: any) => void) | undefined };

/** Makes an element: h("div", { class: "row", onclick }, child, ...). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key === "class") el.className = value as string;
    else if (key === "text") el.textContent = value as string;
    else if (key === "html") el.innerHTML = value as string;
    else if (key === "title") el.title = value as string;
    else if (key === "attrs") for (const [a, v] of Object.entries(value as Record<string, string>)) el.setAttribute(a, v);
    else if (key === "data") for (const [a, v] of Object.entries(value as Record<string, string>)) el.dataset[a] = v;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value as EventListener);
  }
  append(el, children);
  return el;
}

function append(el: Element, children: (Child | Child[])[]): void {
  for (const child of children) {
    if (Array.isArray(child)) append(el, child);
    else if (child === null || child === undefined || child === false) continue;
    else el.append(child instanceof Node ? child : String(child));
  }
}

export function clear(el: Element, ...children: (Child | Child[])[]): void {
  el.replaceChildren();
  append(el, children);
}

export function $(selector: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}

export function clock(date: Date = new Date()): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** A typed event hub. */
export class Emitter<T extends Record<string, unknown>> {
  private handlers = new Map<keyof T, Set<(value: never) => void>>();
  on<K extends keyof T>(key: K, fn: (value: T[K]) => void): () => void {
    let set = this.handlers.get(key);
    if (!set) this.handlers.set(key, (set = new Set()));
    set.add(fn as (value: never) => void);
    return () => set.delete(fn as (value: never) => void);
  }
  emit<K extends keyof T>(key: K, value: T[K]): void {
    for (const fn of this.handlers.get(key) ?? []) (fn as (value: T[K]) => void)(value);
  }
}

export function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
