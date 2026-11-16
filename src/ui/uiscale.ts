// How big the buttons and text are. Windows' display scaling already applies (the window is drawn at
// its scale); on top of that, "auto" makes everything a little bigger on big screens (a 1440p or 4K
// monitor at 100 %) and a little smaller on small ones, and never so big that the toolbar doesn't fit
// the window. Or a size you choose. In the desktop app it is the window's own zoom (like Ctrl and +
// in a browser), so everything, the 3D view's mouse picking too, stays exact.
import { inTauri } from '../files';

const KEY = 'bench.uiScale';
/** the toolbar's width at 100 % (CSS pixels): auto never makes the UI bigger than the window fits */
const TOOLBAR_W = 1750;
let applied = 1;
/** the screen and window at 100 %, in CSS pixels (from the desktop app: unaffected by our zoom) */
let screenH = typeof screen !== 'undefined' ? screen.height : 1080;
let windowW = typeof window !== 'undefined' ? window.innerWidth : 1600;

export function uiScaleSetting(): string {
  try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; }
}
/** what auto comes to here: about 100 % on a 1080p screen, 115 % at 1440p, 140 % at 4K (at 100 %
 *  display scaling), held down so the toolbar still fits the window */
export function autoUiScale() {
  const bySize = Math.sqrt(Math.max(600, screenH) / 1080);
  // (bigger only as far as the toolbar still fits; a narrow window scrolls the toolbar instead of
  //  shrinking everything below the screen's size)
  const byWindow = Math.max(1, windowW / TOOLBAR_W);
  const f = Math.min(bySize, byWindow);
  return Math.round(Math.max(0.75, Math.min(1.75, f)) * 20) / 20; // (steps of 5 %)
}
export function setUiScale(v: string) {
  try { if (v === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch { /* not remembered */ }
  return applyUiScale();
}
/** Measure the screen and window (desktop app: from Windows, in its own scaling), then size the UI. */
export async function applyUiScale() {
  if (inTauri()) {
    try {
      const { getCurrentWindow, currentMonitor } = await import('@tauri-apps/api/window');
      const mon = await currentMonitor();
      if (mon) screenH = mon.size.height / mon.scaleFactor;
      const w = getCurrentWindow();
      const [inner, sf] = await Promise.all([w.innerSize(), w.scaleFactor()]);
      windowW = inner.width / sf;
    } catch (e) {
      console.warn(`[ui] couldn't measure the screen: ${(e as Error)?.message ?? e}`);
    }
  } else {
    screenH = screen.height * applied;
    windowW = window.innerWidth * applied;
  }
  const set = uiScaleSetting();
  const f = set === 'auto' ? autoUiScale() : Math.max(0.5, Math.min(3, Number(set) || 1));
  console.info(`[ui] size ${Math.round(f * 100)} % (${set}; screen ${Math.round(screenH)} px high, window ${Math.round(windowW)} px wide at 100 %, display scaling ${Math.round(window.devicePixelRatio / applied * 100)} %)`);
  if (Math.abs(f - applied) < 1e-3) return f;
  if (inTauri()) {
    try {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      await getCurrentWebview().setZoom(f);
      applied = f;
    } catch (e) {
      console.warn(`[ui] couldn't set the size: ${(e as Error)?.message ?? e}`);
    }
  } else {
    // (developing in a browser: its own zoom, Ctrl and +, does this; the page leaves it alone)
    console.info(`[ui] (in a browser: use its zoom for ${Math.round(f * 100)} %)`);
  }
  return f;
}
/** Keep auto right when the window moves to another screen or is resized a lot. */
export function watchUiScale(onChange: () => void) {
  let t = 0;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = window.setTimeout(async () => {
      if (uiScaleSetting() !== 'auto') return;
      const before = applied;
      await applyUiScale();
      if (applied !== before) onChange();
    }, 400);
  });
}
