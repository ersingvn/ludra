// Resizable panels. Sizes live in CSS variables on #app and in localStorage.

const KEY = "ludra.studio.layout.v1";

interface Sizes {
  left: number;
  right: number;
  bottom: number;
}

const DEFAULTS: Sizes = { left: 248, right: 312, bottom: 248 };
const LIMITS: Record<keyof Sizes, [number, number]> = { left: [160, 520], right: [220, 640], bottom: [96, 720] };

export function initLayout(app: HTMLElement): void {
  let sizes = load();
  const apply = () => {
    // Keep the game at least 320 × 180, whatever the window does.
    const w = window.innerWidth;
    const h = window.innerHeight;
    const fit = { ...sizes };
    const spareX = w - 320 - 8;
    if (fit.left + fit.right > spareX) {
      const scale = Math.max(0, spareX) / (fit.left + fit.right);
      fit.left = Math.max(LIMITS.left[0], Math.floor(fit.left * scale));
      fit.right = Math.max(LIMITS.right[0], Math.floor(fit.right * scale));
    }
    fit.bottom = Math.min(fit.bottom, Math.max(LIMITS.bottom[0], h - 40 - 180 - 24));
    app.style.setProperty("--left", `${fit.left}px`);
    app.style.setProperty("--right", `${fit.right}px`);
    app.style.setProperty("--bottom", `${fit.bottom}px`);
  };
  apply();
  window.addEventListener("resize", apply);

  for (const handle of app.querySelectorAll<HTMLElement>("[data-split]")) {
    const which = handle.dataset.split as keyof Sizes;
    handle.addEventListener("pointerdown", (down) => {
      down.preventDefault();
      handle.setPointerCapture(down.pointerId);
      const start = sizes[which];
      const x0 = down.clientX;
      const y0 = down.clientY;
      document.body.classList.add(which === "bottom" ? "resizing-y" : "resizing-x");
      const move = (e: PointerEvent) => {
        const delta = which === "left" ? e.clientX - x0 : which === "right" ? x0 - e.clientX : y0 - e.clientY;
        const [min, max] = LIMITS[which];
        sizes = { ...sizes, [which]: Math.round(Math.min(max, Math.max(min, start + delta))) };
        apply();
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        document.body.classList.remove("resizing-x", "resizing-y");
        save(sizes);
        window.dispatchEvent(new Event("ludra:layout"));
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
    handle.addEventListener("dblclick", () => {
      sizes = { ...sizes, [which]: DEFAULTS[which] };
      apply();
      save(sizes);
      window.dispatchEvent(new Event("ludra:layout"));
    });
  }
}

function load(): Sizes {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Sizes>;
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS) as (keyof Sizes)[]) {
      const v = saved[k];
      if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], v));
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

function save(sizes: Sizes): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(sizes));
  } catch {
    // Storage may be off; the layout still works for this session.
  }
}

/** A small persisted preference (open tab, collapsed sections...). */
export function pref<T>(key: string, fallback: T): { get(): T; set(v: T): void } {
  const full = `ludra.studio.${key}`;
  return {
    get() {
      try {
        const raw = localStorage.getItem(full);
        return raw === null ? fallback : (JSON.parse(raw) as T);
      } catch {
        return fallback;
      }
    },
    set(v) {
      try {
        localStorage.setItem(full, JSON.stringify(v));
      } catch {
        // ignore
      }
    },
  };
}
