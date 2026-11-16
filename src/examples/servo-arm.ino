// Servo arm: turn the knob and the arm follows. Press Run, then drag the knob's slider in the run
// panel on the right. Then make the steel weight bigger, or swap in the small SG90, and see when the
// servo can't hold it any more (the bar at the bottom tells you when it stalls).
//
// Wiring (the same on a real bench):
//   board GP15      -> servo signal (orange)
//   battery +       -> servo V+ (red)      (a servo this size needs its own supply: up to ~2.5 A)
//   battery -       -> servo GND (brown) and board GND   (one shared ground: needed!)
//   board 3V3 / GND -> the knob's two ends, knob middle -> board A0
#include <Servo.h>

Servo shoulder;

void setup() {
  Serial.begin(115200);
  shoulder.attach(15);              // the signal pin
}

void loop() {
  int knob = analogRead(A0);        // 0 .. 4095
  int angle = map(knob, 0, 4095, 0, 180);
  shoulder.write(angle);            // 0 .. 180 degrees (90 = straight out)
  Serial.print("angle ");
  Serial.println(angle);
  delay(50);
}
