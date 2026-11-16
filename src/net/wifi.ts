// The bench's Wi-Fi: one network (its name and password are in the project), that boards with
// Wi-Fi join like a home router: the right password connects them after a moment and gives them an
// address (192.168.1.100, .101...); a wrong one fails, like the real thing. A board can also make its
// own network (WiFi.softAP): it is then 192.168.4.1. Nothing here touches the real network: a board's
// web server is reached through openBoardServer (net/bridge.ts), on this PC only.
import { closeBoardServer, openBoardServer, type WebReq, type WebResp } from './bridge';

export interface WifiSettings { ssid: string; pass: string }
export const DEFAULT_WIFI: WifiSettings = { ssid: 'Workshop', pass: 'bench1234' };
export const WL = { IDLE: 0, NO_SSID: 1, CONNECTED: 3, FAILED: 4, DISCONNECTED: 6 } as const;
export const ipToInt = (ip: string) => ip.split('.').reduce((a, b) => ((a << 8) | (Number(b) & 255)) >>> 0, 0) | 0;

interface Station {
  name: string;
  status: number;
  ip: string;
  due: number; // simulation time the pending change happens
  next: { status: number; ip: string } | null;
  ap: string | null; // its own network's name (softAP)
  server: { port: number; url: string; httpPort: number } | null;
  opening: boolean;
}

export class BenchNetwork {
  private stations = new Map<string, Station>();
  private nextIp = 100;
  constructor(public settings: WifiSettings, private log: (m: string, l?: 'info' | 'warn' | 'bad') => void) {}

  private st(uid: string, name: string) {
    let s = this.stations.get(uid);
    if (!s) this.stations.set(uid, (s = { name, status: WL.DISCONNECTED, ip: '0.0.0.0', due: 0, next: null, ap: null, server: null, opening: false }));
    return s;
  }

  /** WiFi.begin / softAP / disconnect from a board's program. Returns the status it sees right away. */
  join(uid: string, name: string, mode: number, ssid: string, pass: string, now: number): number {
    const s = this.st(uid, name);
    if (mode === 0) {
      s.status = WL.DISCONNECTED;
      s.ip = '0.0.0.0';
      s.next = null;
      s.ap = null;
      return s.status;
    }
    if (mode === 2) {
      s.ap = ssid || 'ESP32';
      s.status = WL.IDLE;
      s.ip = '192.168.4.1';
      this.log(`${name} made its own Wi-Fi network "${s.ap}" (192.168.4.1)`);
      return s.status;
    }
    // asking again for the network it's on (or joining) changes nothing, as on real boards
    if (!s.ap && ssid === this.settings.ssid && pass === this.settings.pass && (s.status === WL.CONNECTED || s.next?.status === WL.CONNECTED)) return s.status;
    s.status = WL.DISCONNECTED;
    s.ip = '0.0.0.0';
    if (ssid !== this.settings.ssid) {
      s.next = { status: WL.NO_SSID, ip: '0.0.0.0' };
      s.due = now + 2.5;
      this.log(`${name} is looking for Wi-Fi "${ssid}", but the bench's network is "${this.settings.ssid}" (change it in the project settings, or in the sketch)`, 'warn');
    } else if (pass !== this.settings.pass) {
      s.next = { status: WL.FAILED, ip: '0.0.0.0' };
      s.due = now + 3;
      this.log(`${name}: wrong Wi-Fi password for "${ssid}" (the bench's is set in the project settings)`, 'warn');
    } else {
      const ip = `192.168.1.${this.nextIp++}`;
      s.next = { status: WL.CONNECTED, ip };
      s.due = now + 1.2 + Math.random() * 0.6; // joining takes a moment, as on a real router
    }
    return s.status;
  }

  /** the board's current status and address (applying a join that has finished) */
  state(uid: string, now: number) {
    const s = this.stations.get(uid);
    if (!s) return { status: WL.IDLE, ip: '0.0.0.0', changed: false };
    let changed = false;
    if (s.next && now >= s.due) {
      s.status = s.next.status;
      s.ip = s.next.ip;
      s.next = null;
      changed = true;
      if (s.status === WL.CONNECTED) this.log(`${s.name} joined Wi-Fi "${this.settings.ssid}" as ${s.ip}`);
    }
    return { status: s.status, ip: s.ip, changed };
  }

  /** server.begin(): its address on this PC, for the app's browser (and yours) */
  async listen(uid: string, name: string, httpPort: number, handle: (r: WebReq) => Promise<WebResp>) {
    const s = this.st(uid, name);
    if (s.server || s.opening) return;
    s.opening = true;
    try {
      const at = await openBoardServer(uid, (req) => {
        if (s.status !== WL.CONNECTED && !s.ap) return Promise.resolve({ status: 503, type: 'text/plain', body: `${name} isn't on Wi-Fi yet (WiFi.begin must connect first).`, headers: {} });
        return handle(req);
      });
      s.server = { ...at, httpPort };
      this.log(`${name}'s web page is up: select it while running and press "Open its web page"`);
    } catch (e) {
      this.log(`${name}'s web server couldn't open: ${(e as Error).message}`, 'warn');
    }
    s.opening = false;
  }

  /** what the run inspector shows, and where its page is */
  info(uid: string) {
    const s = this.stations.get(uid);
    if (!s) return null;
    return { status: s.status, ip: s.ip, ap: s.ap, server: s.server };
  }

  dispose() {
    for (const [uid, s] of this.stations) if (s.server || s.opening) closeBoardServer(uid);
    this.stations.clear();
  }
}
