// A board's web page, in a small browser panel over the bench (it stays open while things run, so
// you can press its buttons and watch the bench react). The page comes from the board's own address
// on this PC (127.0.0.1:<port>, a different origin from the app) and is sandboxed: it can run its
// scripts and forms, nothing else. "Open in my browser" shows the same page in your real browser.

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style' && typeof v === 'string') e.setAttribute('style', v);
    else (e as any)[k] = v;
  }
  e.append(...kids);
  return e;
};
const inTauri = () => '__TAURI_INTERNALS__' in window;

export class WebView {
  private panel: HTMLElement | null = null;
  private frame: HTMLIFrameElement | null = null;
  private addr: HTMLInputElement | null = null;
  private base = '';
  private ip = '';

  open(board: string, ip: string, url: string) {
    this.base = url;
    this.ip = ip;
    if (!this.panel) this.build();
    this.panel!.querySelector('.wv-title')!.textContent = `${board}: its web page`;
    this.go('/');
  }

  /** the run stopped: the page can't answer any more */
  stopped() {
    if (!this.panel || !this.frame) return;
    this.frame.removeAttribute('src');
    this.frame.srcdoc = '<body style="font:14px system-ui;color:#9aa1b2;background:#16181d;padding:20px">The simulation stopped, so the board is off. Run it again to see its page.</body>';
  }

  close() {
    this.panel?.remove();
    this.panel = this.frame = this.addr = null;
  }

  private go(path: string) {
    if (!this.frame || !this.addr) return;
    const p = path.startsWith('/') ? path : `/${path}`;
    this.addr.value = `http://${this.ip}${p}`;
    this.frame.removeAttribute('srcdoc');
    this.frame.src = new URL(p, this.base).href;
    console.info(`[wifi] page ${this.addr.value} -> ${this.frame.src}`);
  }

  private build() {
    this.addr = el('input', { className: 'wv-addr', title: 'The board\'s address on the bench\'s Wi-Fi. Type a path (/status, /led?on=1) and press Enter.' }) as HTMLInputElement;
    this.addr.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      const m = /^(?:https?:\/\/[^/]+)?(\/.*)?$/.exec(this.addr!.value.trim());
      this.go(m?.[1] ?? '/');
    };
    this.frame = el('iframe', { className: 'wv-frame' }) as HTMLIFrameElement;
    // its own origin (the board's port), scripts and forms allowed; no top navigation, no popups
    this.frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-modals');
    this.frame.setAttribute('referrerpolicy', 'no-referrer');
    this.frame.onload = () => {
      // keep the address bar in step with links the page follows (it's same-origin with the board, not the app)
      try {
        const p = this.frame!.contentWindow!.location;
        if (p.href.startsWith(this.base.replace(/\/$/, ''))) this.addr!.value = `http://${this.ip}${p.pathname}${p.search}`;
      } catch { /* cross-origin: leave it */ }
    };
    const openOut = async () => {
      const url = this.frame?.src || this.base;
      if (inTauri()) (await import('@tauri-apps/plugin-opener')).openUrl(url);
      else window.open(url, '_blank', 'noopener');
    };
    const head = el('div', { className: 'wv-head' },
      el('span', { className: 'wv-title' }),
      el('span', { style: 'flex:1' }),
      el('button', { textContent: 'Open in my browser', title: 'The same page in your real browser (this PC only, while the bench runs)', onclick: openOut }),
      el('button', { textContent: '×', title: 'Close', onclick: () => this.close() }));
    const bar = el('div', { className: 'wv-bar' },
      el('button', { textContent: '↻', title: 'Reload', onclick: () => this.frame && (this.frame.src = this.frame.src) }),
      this.addr);
    this.panel = el('div', { className: 'wv-panel' }, head, bar, this.frame);
    // drag it by its title bar
    head.onpointerdown = (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      const r = this.panel!.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (m: PointerEvent) => {
        this.panel!.style.left = `${Math.max(0, m.clientX - dx)}px`;
        this.panel!.style.top = `${Math.max(0, m.clientY - dy)}px`;
        this.panel!.style.right = 'auto';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
    document.body.append(this.panel);
  }
}
