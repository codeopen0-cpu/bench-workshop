# UNO R4 WiFi LED matrix: upstream sources

Copied unchanged from GitHub, so `tools/make_matrix_data.py` can turn them into the app's data
(`src/sketch/ledmatrix-gallery.ts`, `src/sketch/ledmatrix-fonts.ts`), and so the bench's
`ArduinoLEDMatrix` (in `src/sketch/worker.ts`) can be checked against how the real one works.

| Files | From | License |
|---|---|---|
| `Arduino_LED_Matrix.h`, `gallery.h`, `TextAnimation.h` | [arduino/ArduinoCore-renesas](https://github.com/arduino/ArduinoCore-renesas), `libraries/Arduino_LED_Matrix/src` | MIT |
| `ArduinoGraphics.h`, `ArduinoGraphics.cpp`, `Font.h`, `Font_4x6.c`, `Font_5x7.c` | [arduino-libraries/ArduinoGraphics](https://github.com/arduino-libraries/ArduinoGraphics), `src` | MPL-2.0 (these files, and `src/sketch/ledmatrix-fonts.ts` made from the fonts, stay under it) |

Copyright of all of them: Arduino SA.
