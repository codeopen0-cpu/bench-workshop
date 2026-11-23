// Sounds from library parts (a buzzer, a speaker): tones, played with the Web Audio API.
// Safety: libraries can't play files or anything they like, only tones; every tone is clamped to
// 20 Hz .. 12 kHz, the loudest is a quarter of full scale (under the app's own volume), at most 12
// play at once, everything goes quiet when the run pauses or stops or the window is hidden, and
// the toolbar's sound button mutes all of it (remembered).
// A speaker on an I2S amp (elec/audio.ts) plays a board's samples: pcm(). The same rules: under the
// same ceiling and mute, quiet when paused / stopped / hidden, and never more than a second queued.

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
    for (const k of [...this.streams.keys()]) if (k.startsWith(prefix)) this.stopStream(k);
    this.apply();
  }
  get playing() { return this.voices.size + this.streams.size; }
  /** every tone asked for now (heard on the bench even when the speakers are muted): key, Hz, volume */
  sounding(): [string, number, number][] {
    const now = performance.now();
    const pcm = [...this.levels].filter(([, l]) => now - l.at < 150 && l.vol > 0.002).map(([k, l]) => [k, l.hz, l.vol] as [string, number, number]);
    return [...[...this.wanted].map(([k, t]) => [k, t[0], t[1]] as [string, number, number]), ...pcm];
  }

  // ---- samples (a speaker on an I2S amp)
  private streams = new Map<string, { next: number; sources: AudioBufferSourceNode[] }>();
  private levels = new Map<string, { vol: number; hz: number; at: number }>();
  /** how loud a speaker is now (0..1) and its main pitch: for its status and the bench's microphones */
  level(key: string) {
    const l = this.levels.get(key);
    return l && performance.now() - l.at < 150 ? l : { vol: 0, hz: 0, at: 0 };
  }
  /** A speaker's samples (-1..1) at this rate, played straight after what it was given before (after
   *  a gap: from now). Too far ahead of the sound card (the run going faster than real time): dropped. */
  pcm(key: string, samples: Float32Array, rate: number) {
    if (!samples.length) return;
    // (its loudness and pitch: what a microphone on the bench hears, even with the sound muted)
    let sum = 0, cross = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
      if (i && (samples[i - 1] < 0) !== (samples[i] < 0)) cross++;
    }
    const rms = Math.sqrt(sum / samples.length);
    this.levels.set(key, { vol: Math.min(1, rms * 1.41), hz: Math.round((cross / 2) * (rate / samples.length)), at: performance.now() });
    const silent = this.muted || this.paused || (typeof document !== 'undefined' && document.hidden);
    const ctx = this.ctx, master = this.master;
    if (silent || !ctx || !master) { this.stopStream(key); return; }
    let st = this.streams.get(key);
    if (!st) this.streams.set(key, (st = { next: 0, sources: [] }));
    if (st.next < ctx.currentTime + 0.01) st.next = ctx.currentTime + 0.06; // (a gap, or the first: start just ahead)
    if (st.next > ctx.currentTime + 1) return;
    const buf = ctx.createBuffer(1, samples.length, Math.max(3000, Math.min(96000, rate)));
    const clamped = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) clamped[i] = Math.max(-1, Math.min(1, samples[i]));
    buf.copyToChannel(clamped, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(master);
    src.start(st.next);
    st.next += buf.duration;
    st.sources.push(src);
    src.onended = () => { const i = st!.sources.indexOf(src); if (i >= 0) st!.sources.splice(i, 1); };
  }
  private stopStream(key: string) {
    const st = this.streams.get(key);
    if (!st) return;
    for (const s of st.sources) try { s.stop(); } catch { /* already */ }
    this.streams.delete(key);
  }

  private apply() {
    const silent = this.muted || this.paused || (typeof document !== 'undefined' && document.hidden);
    if (silent) for (const k of [...this.streams.keys()]) this.stopStream(k);
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
