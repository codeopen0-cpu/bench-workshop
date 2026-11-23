// A little tune through an I2S amp (MAX98357A) and a speaker. Press Run and listen (the toolbar's
// sound button must be on). Wiring: BCLK to 26, LRC to 25, DIN to 22, VIN to 3V3, GND to GND, and
// the speaker on the amp's + and -. The same sketch runs on a real ESP32 (core 3: ESP_I2S.h).
#include <ESP_I2S.h>

I2SClass i2s;

const int RATE = 16000;
const int NOTES[] = {523, 659, 784, 1047, 784, 659, 523, 0};
int16_t buf[160];

// one note: a sine wave that fades out over its length (0 Hz: a rest)
void playNote(int hz, int ms) {
  long frames = RATE / 1000 * ms;
  long total = frames;
  float phase = 0;
  while (frames > 0) {
    int n = frames > 160 ? 160 : frames;
    for (int i = 0; i < n; i++) {
      float fade = (frames - i) / (float)total;
      buf[i] = hz ? (int16_t)(sin(phase) * 12000 * fade) : 0;
      phase += 2 * PI * hz / RATE;
      if (phase > 2 * PI) phase -= 2 * PI;
    }
    i2s.write((uint8_t *)buf, n * 2);
    frames -= n;
  }
}

void setup() {
  Serial.begin(115200);
  i2s.setPins(26, 25, 22);
  if (!i2s.begin(I2S_MODE_STD, RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO)) {
    Serial.println("I2S failed to start");
    while (1);
  }
  Serial.println("playing");
}

void loop() {
  for (int i = 0; i < 8; i++) {
    Serial.print("note ");
    Serial.println(NOTES[i]);
    playNote(NOTES[i], 250);
  }
  delay(500);
}
