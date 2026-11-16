// RP2040 board demo program (ships with Bench Workshop as public/firmware/rp2040-demo.uf2).
//  - blinks the on-board LED (GP25)
//  - every 2 s scans the I2C bus on GP4 (SDA) / GP5 (SCL) and lists every chip that answers
//  - a motion sensor (MPU-6050, 0x68/0x69) on the bus: prints what it feels
//  - a servo driver (PCA9685, 0x40-0x47) on the bus: swings the servo on its S0 back and forth
// Wire a module's VCC/GND to 3V3/GND and its SDA/SCL to GP4/GP5.
#include <Arduino.h>
#include <Wire.h>

static int mpuAddr = -1, pcaAddr = -1;

static void writeReg(uint8_t addr, uint8_t reg, uint8_t value) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(value);
  Wire.endTransmission();
}

static void pcaStart(uint8_t addr) {
  writeReg(addr, 0x00, 0x10);  // MODE1: sleep (the clock divider can only change while asleep)
  writeReg(addr, 0xFE, 121);   // PRE_SCALE: 25 MHz / (4096 * 50 Hz) - 1 = 121 -> 50 Hz
  writeReg(addr, 0x00, 0x20);  // MODE1: awake, register auto-increment
  delay(1);
}

static void pcaPulse(uint8_t addr, uint8_t channel, uint16_t us) {
  uint16_t off = (uint32_t)us * 4096 / 20000;  // 20 ms period at 50 Hz
  Wire.beginTransmission(addr);
  Wire.write(0x06 + 4 * channel);  // LEDn_ON_L, then ON_H, OFF_L, OFF_H
  Wire.write(0);
  Wire.write(0);
  Wire.write(off & 0xFF);
  Wire.write(off >> 8);
  Wire.endTransmission();
}

static void mpuPrint(uint8_t addr) {
  writeReg(addr, 0x6B, 0x00);  // PWR_MGMT_1: wake up
  Wire.beginTransmission(addr);
  Wire.write(0x3B);  // ACCEL_XOUT_H
  Wire.endTransmission(false);
  if (Wire.requestFrom(addr, (size_t)6) != 6) {
    Serial.println("MPU-6050: no data");
    return;
  }
  int16_t v[3];
  for (int i = 0; i < 3; i++) v[i] = (int16_t)((Wire.read() << 8) | Wire.read());
  // (this build's printf has no floats: thousandths of a g, as whole numbers)
  Serial.printf("MPU-6050 at 0x%02X: accel x %d  y %d  z %d (1000 = 1 g)\r\n", addr, v[0] * 1000 / 16384, v[1] * 1000 / 16384, v[2] * 1000 / 16384);
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);
  Wire.setSDA(4);
  Wire.setSCL(5);
  Wire.begin();
  Serial.println("RP2040 demo: blinking GP25, scanning I2C on GP4/GP5");
}

void loop() {
  static uint32_t lastScan = 0;
  static bool swing = false;
  digitalWrite(LED_BUILTIN, (millis() / 250) % 2);
  if (millis() - lastScan >= 2000) {
    lastScan = millis();
    Serial.print("I2C scan:");
    int found = 0, mpu = -1, pca = -1;
    for (uint8_t a = 1; a < 127; a++) {
      Wire.beginTransmission(a);
      if (Wire.endTransmission() == 0) {
        Serial.printf(" 0x%02X", a);
        found++;
        if (a == 0x68 || a == 0x69) mpu = a;
        if (a >= 0x40 && a <= 0x47 && pca < 0) pca = a;
      }
    }
    Serial.println(found ? "" : " nothing");
    if (mpu >= 0) mpuPrint(mpu);
    if (pca >= 0) {
      if (pca != pcaAddr) pcaStart(pca);
      swing = !swing;
      pcaPulse(pca, 0, swing ? 2000 : 1000);  // 1 ms = one end, 2 ms = the other
      Serial.printf("PCA9685 at 0x%02X: servo S0 -> %s\r\n", pca, swing ? "2.0 ms" : "1.0 ms");
    }
    mpuAddr = mpu;
    pcaAddr = pca;
  }
  delay(5);
}
