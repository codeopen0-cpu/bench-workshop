// The UNO R4 WiFi's own 12 x 8 LED matrix: a picture from its gallery, one drawn here, an
// animation, and scrolling text (ArduinoGraphics). The same sketch runs on a real UNO R4 WiFi.
#include "ArduinoGraphics.h"
#include "Arduino_LED_Matrix.h"

ArduinoLEDMatrix matrix;

// a picture of your own: 8 rows of 12 (1 = lit)
uint8_t smile[8][12] = {
  {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0},
  {0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0},
  {0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0},
  {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0},
  {0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0},
  {0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0},
  {0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0},
  {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}
};

void setup() {
  Serial.begin(115200);
  matrix.begin();
}

void loop() {
  Serial.println("heart");
  matrix.loadFrame(LEDMATRIX_HEART_BIG);
  delay(1000);

  Serial.println("smile");
  matrix.renderBitmap(smile, 8, 12);
  delay(1000);

  Serial.println("animation");
  matrix.loadSequence(LEDMATRIX_ANIMATION_HEARTBEAT);
  matrix.play(false);
  while (!matrix.sequenceDone()) delay(10);

  Serial.println("text");
  matrix.beginDraw();
  matrix.stroke(0xFFFFFFFF);
  matrix.textScrollSpeed(60);
  matrix.textFont(Font_5x7);
  matrix.beginText(12, 1, 0xFFFFFF);
  matrix.print("Hello!");
  matrix.endText(SCROLL_LEFT);
  matrix.endDraw();
}
