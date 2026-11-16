// Sounds from library parts (a buzzer, a speaker): tones, played with the Web Audio API.
// Safety: libraries can't play files or anything they like, only tones; every tone is clamped to
// 20 Hz .. 12 kHz, the loudest is a quarter of full scale (under the app's own volume), at most 12
// play at once, everything goes quiet when the run pauses or stops or the window is hidden, and
// the toolbar's sound button mutes all of it (remembered).

const MAX_VOICES = 12;
const CEILING = 0.25; // the loudest a library tone can be (of full scale)
const MUTE_KEY = 'bench.sound.muted';

interface Voice { osc: OscillatorNode; gain: GainNode; hz: number; vol: number; wave: string }

class BenchAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private voices = new Map<string, Voice>();
  private wanted = new Map<string, [number, number, string]>(); // what's asked (kept while muted/paused)
  private paused = false;
  muted = false;
  onChange: (() => void) | null = null;

  constructor() {
    try { this.muted = localStorage.getItem(MUTE_KEY) === '1'; } catch { /* default: on */ }
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', () => this.apply());
  }

  /** Call from a click (Run): browsers only let pages start sound after the user did something. */
  unlock() {
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = CEILING;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch (e) {
      console.warn('[sound] no audio here:', e);
    }
  }

  setMuted(m: boolean) {
    this.muted = m;
    try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch { /* not remembered */ }
    console.info(`[sound] library sounds ${m ? 'muted' : 'on'}`);
    this.apply();
    this.onChange?.();
  }
  setPaused(p: boolean) {
    if (this.paused === p) return;
    this.paused = p;
    this.apply();
  }

  /** A part's tone: key = "uid/n"; null = quiet. */
  set(key: string, tone: [number, number, string] | null) {
    if (!tone) this.wanted.delete(key);
    else {
      const hz = Math.max(20, Math.min(12000, Number(tone[0]) || 0));
      const vol = Math.max(0, Math.min(1, Number(tone[1]) || 0));
      const wave = ['square', 'sine', 'triangle', 'sawtooth'].includes(tone[2]) ? tone[2] : 'square';
      if (!this.wanted.has(key) && this.wanted.size >= MAX_VOICES) return; // (too many at once: this one stays quiet)
      this.wanted.set(key, [hz, vol, wave]);
    }
    this.apply();
  }
  /** Everything from these parts goes quiet (a run stopped). */
  clear(prefix = '') {
    for (const k of [...this.wanted.keys()]) if (k.startsWith(prefix)) this.wanted.delete(k);
    this.apply();
  }
  get playing() { return this.voices.size; }
  /** every tone asked for now (heard on the bench even when the speakers are muted): key, Hz, volume */
  sounding(): [string, number, number][] {
    return [...this.wanted].map(([k, t]) => [k, t[0], t[1]]);
  }

  private apply() {
    const silent = this.muted || this.paused || (typeof document !== 'undefined' && document.hidden);
    const ctx = this.ctx, master = this.master;
    // stop voices that shouldn't play
    for (const [k, v] of this.voices)
      if (silent || !this.wanted.has(k)) {
        if (ctx) {
          v.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.01);
          v.osc.stop(ctx.currentTime + 0.06);
        }
        this.voices.delete(k);
      }
    if (silent || !ctx || !master) return;
    for (const [k, [hz, vol, wave]] of this.wanted) {
      let v = this.voices.get(k);
      if (v && v.wave !== wave) {
        v.osc.stop();
        this.voices.delete(k);
        v = undefined;
      }
      // a square wave sounds much louder than a sine at the same level: even them out a little
      const level = vol * (wave === 'square' || wave === 'sawtooth' ? 0.5 : 1);
      if (!v) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = wave as OscillatorType;
        osc.frequency.value = hz;
        gain.gain.value = 0;
        gain.gain.setTargetAtTime(level, ctx.currentTime, 0.005);
        osc.connect(gain).connect(master);
        osc.start();
        this.voices.set(k, { osc, gain, hz, vol, wave });
        continue;
      }
      if (v.hz !== hz) { v.osc.frequency.setTargetAtTime(hz, ctx.currentTime, 0.002); v.hz = hz; }
      if (v.vol !== vol) { v.gain.gain.setTargetAtTime(level, ctx.currentTime, 0.005); v.vol = vol; }
    }
  }
}

export const benchAudio = new BenchAudio();
