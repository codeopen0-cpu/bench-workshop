# Bench Workshop

A 3D workbench with real physics for building things out of parts and boards: put them together,
wire them, program them, run them, and see whether they work (and look right) before you build them
for real. Not just robots: anything with boards, motors, sensors and displays.

**[Download the latest version](https://github.com/codeopen0-cpu/bench-workshop/releases/latest)**
(Windows: `Bench Workshop_x.y.z_x64-setup.exe`). It updates itself when a new version comes out.

It's open source (MIT licence, see [LICENSE](LICENSE)): read it, change it, build your own.

## What it does

- **Build** with blocks, plates, rods, wheels, servos (from an SG90 to winch and smart servos),
  motors, steppers, batteries and boards. Click a part, then click where it goes: placing it on
  another part glues it there, and moving a part moves everything glued to it. A **grid** (toolbar,
  or G) snaps parts as you place and move them, and a part you put things on gets its own grid that
  fits it, odd sizes too. Search the parts list with Ctrl+F.
- **Your own designs:** import a 3D model (.stl) as a part (its weight from its volume and material,
  and a solid shape that keeps holes and hollows open), import a KiCad board (pins, copper and its
  3D look), or make a board in the app.
- **Run** real physics (Rapier): motors have their real torque, servos stall when the load is too
  heavy, wires have a length, pull what they're attached to and snap if stretched too far. Pick
  things up while it runs (WASD carries them, right-drag turns the camera), shove them with a ball
  (Shift), and change gravity.
- **Wire** pins together. Power, shorts, floating inputs and over-voltage are checked as it runs, and
  **Check** reads the wiring without running it.
- **Program** boards with Arduino-style sketches written in the app (real ESP32 and Arduino sketches
  run as they are: `#if`, structs, lambdas, `String`, `Preferences`, `ledc`...), run a real
  RP2040 `.uf2` on an emulated chip (GPIO, PWM, ADC, I2C, USB serial), or write **MicroPython**:
  the real MicroPython (1.29, bundled) runs on that chip, with its `>>>` prompt in the serial monitor.
- **Wi-Fi boards** (ESP32, UNO R4 WiFi layout) join the bench's own network and serve real web pages
  on this PC (127.0.0.1 only; nothing reaches the internet).
- **Power** that behaves like the real thing: AA, 9 V, coin cells, 18650s, LiPo packs, power banks
  and a bench supply, with their voltage curves, sag under load and brown-outs.
- **Modules** that act like the real chips: servo driver (PCA9685), motion sensor (MPU-6050), IO
  expander (MCP23017), analog inputs (ADS1115), power meter (INA226), memory (24C02).
- **Libraries**: add-on parts (displays, sensors, radios, cameras...) downloaded from the
  [library list](https://github.com/codeopen0-cpu/bench-workshop-libraries). Anyone can add one,
  straight from the app (Libraries > Publish). Their code runs sealed off, and every library is
  safety-checked.
- **Mechanics and flying:** gears that mesh by tooth count, pulleys and belts, tank tracks,
  mecanum and omni wheels, brushless motors with propellers and ESCs. The colour camera library has
  a quadcopter that follows a ball: its own flight controller sketch (ESP32-S3, MPU-6050, sonar).
- **Boards:** Arduino Nano and Mega, ESP8266 (NodeMCU, D1 mini), ESP32, ESP32-S3 and C3, Pico and
  Pico W. ESP32s talk over ESP-NOW; a PS2 controller library is played with a game pad.
- **Sensors that see:** distance (HC-SR04), a thermal camera (AMG8833, with the Adafruit_AMG88xx
  library) that sees warm things, and a 360-degree lidar (RPLidar A1, with its RPLidar library).
- **Real boards:** upload a sketch to a real board on USB from the program editor (with the
  arduino-cli that comes with the Arduino IDE).
- **Courses** to test a robot on: ramps and hills, stairs, speed bumps, walls, an arena, rough
  ground, an obstacle field and line tracks.
- **Measure** with a ruler (M) and a multimeter (V). **Parts list**: what to buy, with rough prices,
  and a wiring sheet to print.
- **Control API**: your own programs (Python, test scripts) drive the bench at
  `http://127.0.0.1:7420/` (toolbar: API; this PC only): run, step, read where parts are, press
  their buttons, read serial, load benches and programs. `GET /` there lists it all.

  ```python
  import requests
  api = "http://127.0.0.1:7420"
  requests.post(f"{api}/step", json={"seconds": 2})
  print(requests.get(f"{api}/parts/chassis").json()["pos"])
  ```
- **Learn**: step-by-step lessons, each ending with what's different on a real bench.

## Questions, bugs, ideas

Open an [issue](https://github.com/codeopen0-cpu/bench-workshop/issues).

## Building it yourself

You need [Node.js](https://nodejs.org) 20 or newer, and for the desktop app
[Rust](https://rustup.rs) and the Microsoft C++ build tools (see Tauri's
[prerequisites](https://v2.tauri.app/start/prerequisites/)).

```
npm install
npm run dev        # just the page, in a browser at http://localhost:1420
npm run app        # the desktop app, live-reloading (Tauri + Vite)
npm run check      # type-check
```

### Your own installer

`npm run release` builds the installer (`src-tauri/target/release/bundle/nsis`). Installers are
signed so the app only accepts updates from whoever holds the signing key, which is kept private
and is not in this repository. For your own builds, make your own key:

```
npx tauri signer generate -w <a private place>/my-bench.key
```

then put its public key in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`), point
`plugins.updater.endpoints` at your own releases, and build with the environment variables
`TAURI_SIGNING_PRIVATE_KEY=<path to your key>` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty if it
has none). Or set `bundle.createUpdaterArtifacts` to `false` to build without updates.

`node tools/release.mjs "what's new"` publishes a built version as a GitHub release (it uses the
`gh` CLI's login). Bump `version` in `package.json`, `src-tauri/tauri.conf.json` and
`src-tauri/Cargo.toml` before each one.

The library list lives in `registry/` (published as its own repository); see `registry/README.md`
and `registry/GUIDE.md` for making a library.

## How it's built

| Piece | What |
|---|---|
| `src/parts/catalog.ts` | the parts bin: shape, weight, colliders, joints, motors of every part |
| `src/project.ts` | the project file: parts, what each is glued to, where |
| `src/sim.ts` | physics: glued parts are merged into single rigid bodies, actuators are joint motors, wires are ropes |
| `src/elec/` | circuits (nets, drives, I2C), what each part does, programmable boards |
| `src/sketch/` | sketches: the Arduino-style runtime in its own thread, the C++ to JavaScript translator |
| `src/kit/` | the emulated RP2040 (rp2040js + I2C target mode + pin-level I2C), chip models, KiCad board loading |
| `src/lib/` | libraries: the format, the sealed worker their code runs in, installing, KiCad and STL import, publishing |
| `src/ui/` | windows: libraries, part maker, Check, lessons, pin graph, UI size |
| `src/app.ts` | the app: build and run modes, placing, the grid, grabbing, the inspector, files, undo |
| `registry/` | the library list: libraries as folders, the safety checker, the pack/check tools |
| `firmware/rp2040-demo/` | the RP2040 board's demo program (PlatformIO, arduino-pico) |
| `src-tauri/` | the desktop shell (Tauri 2): window, file dialogs, the boards' little web servers, updates |

Units throughout are centimetres, grams, seconds and radians.

## Licence

MIT: see [LICENSE](LICENSE). It uses three.js (MIT), Rapier (Apache-2.0), rp2040js (MIT), Monaco
(MIT) and Tauri (MIT / Apache-2.0); the RP2040 demo firmware is built with arduino-pico (LGPL-2.1),
whose source it is built from is in `firmware/rp2040-demo`. The bundled MicroPython firmware
(`public/firmware/micropython-rpi-pico-v1.29.0.uf2`, unchanged from micropython.org) is MIT
licensed: see `public/firmware/MICROPYTHON-LICENSE.txt`.
