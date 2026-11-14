# Bench Workshop

A 3D workbench with real physics for building things out of parts and boards: put them together,
wire them, program them, run them, and see whether they work (and look right) before you build them
for real. Not just robots: anything with boards, motors, sensors and displays.

**[Download the latest version](https://github.com/codeopen0-cpu/bench-workshop/releases/latest)**
(Windows: `Bench Workshop_x.y.z_x64-setup.exe`). It updates itself when a new version comes out.

## What it does

- **Build** with blocks, plates, wheels, servos, motors, batteries and boards. Glue parts together,
  drag them around, and run real physics: motors have their real torque, servos stall when the load
  is too heavy, wires have a length and pull what they're attached to.
- **Wire** pins together. Power, shorts, floating inputs and over-voltage are checked as it runs.
- **Program** boards with Arduino-style sketches written in the app, or run a real RP2040 `.uf2` on
  an emulated chip (GPIO, PWM, ADC, I2C, USB serial).
- **Modules** that act like the real chips: servo driver (PCA9685), motion sensor (MPU-6050), IO
  expander (MCP23017), analog inputs (ADS1115), power meter (INA226), memory (24C02).
- **Libraries**: add-on parts (an 8x8 LED matrix, a 16x2 LCD...) downloaded from the
  [library list](https://github.com/codeopen0-cpu/bench-workshop-libraries). Anyone can add one,
  straight from the app (Libraries > Publish). Every library is safety-checked.
- **Your own boards**: import a KiCad board (with its 3D look) or make one in the app.

## Questions, bugs, ideas

Open an [issue](https://github.com/codeopen0-cpu/bench-workshop/issues).
