// Obstacle-avoiding rover (an ordinary Arduino sketch).
// Drives forward; when something is closer than 20 cm it backs up and turns away.
#define AIN1 2    // right motor (through the DRV8833)
#define AIN2 3
#define BIN1 5    // left motor
#define BIN2 6
#define TRIG 10   // HC-SR04
#define ECHO 11

void motor(int in1, int in2, int speed) {
  if (speed >= 0) { analogWrite(in1, speed); analogWrite(in2, 0); }
  else            { analogWrite(in1, 0);     analogWrite(in2, -speed); }
}

void drive(int left, int right) {   // -255 .. 255
  motor(BIN1, BIN2, left);
  motor(AIN2, AIN1, right);         // the right motor faces the other way
}

float distanceCm() {
  digitalWrite(TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  long us = pulseIn(ECHO, HIGH, 30000);
  if (us == 0) return 999;          // no echo: nothing in range
  return us / 58.0;
}

void setup() {
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
  Serial.begin(115200);
  Serial.println("rover ready");
}

void loop() {
  float d = distanceCm();
  Serial.print("distance: ");
  Serial.println(d);
  if (d < 20) {
    drive(-200, -200);   // back up
    delay(400);
    drive(200, -200);    // spin right
    delay(450);
  } else {
    drive(220, 220);     // forward
  }
  delay(50);
}
