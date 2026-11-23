// A face a phone sets over Bluetooth LE: the UNO R4 WiFi advertises as "Robot face"; on the bench
// the run panel is the phone. Press Run, then "Phone: connect", then write Mood 0 (happy), 1 (sad)
// or 2 (heart), or send a Message to scroll across the LED matrix. "Seconds on" notifies the phone.
// The same sketch works with a real phone app such as nRF Connect or LightBlue.
#include <ArduinoBLE.h>
#include "ArduinoGraphics.h"
#include "Arduino_LED_Matrix.h"

ArduinoLEDMatrix matrix;

BLEService faceService("19B10000-E8F2-537E-4F6C-D104768A1214");
BLEByteCharacteristic mood("19B10001-E8F2-537E-4F6C-D104768A1214", BLERead | BLEWrite);
BLEStringCharacteristic message("19B10002-E8F2-537E-4F6C-D104768A1214", BLERead | BLEWrite, 20);
BLEUnsignedLongCharacteristic secondsOn("19B10003-E8F2-537E-4F6C-D104768A1214", BLERead | BLENotify);
BLEDescriptor moodLabel("2901", "Mood");
BLEDescriptor messageLabel("2901", "Message");
BLEDescriptor secondsLabel("2901", "Seconds on");

unsigned long lastTick = 0;

void showMood(byte m) {
  if (m == 1) matrix.loadFrame(LEDMATRIX_EMOJI_SAD);
  else if (m == 2) matrix.loadFrame(LEDMATRIX_HEART_BIG);
  else matrix.loadFrame(LEDMATRIX_EMOJI_HAPPY);
}

void onConnect(BLEDevice central) {
  Serial.print("phone connected: ");
  Serial.println(central.address());
}

void onDisconnect(BLEDevice central) {
  Serial.println("phone gone: advertising again");
}

void setup() {
  Serial.begin(115200);
  matrix.begin();
  if (!BLE.begin()) {
    Serial.println("Bluetooth failed to start");
    while (1);
  }
  BLE.setLocalName("Robot face");
  BLE.setAdvertisedService(faceService);
  mood.addDescriptor(moodLabel);
  message.addDescriptor(messageLabel);
  secondsOn.addDescriptor(secondsLabel);
  faceService.addCharacteristic(mood);
  faceService.addCharacteristic(message);
  faceService.addCharacteristic(secondsOn);
  BLE.addService(faceService);
  BLE.setEventHandler(BLEConnected, onConnect);
  BLE.setEventHandler(BLEDisconnected, onDisconnect);
  BLE.advertise();
  showMood(0);
  Serial.println("advertising as \"Robot face\"");
}

void loop() {
  BLE.poll();
  if (mood.written()) {
    Serial.print("mood ");
    Serial.println(mood.value());
    showMood(mood.value());
  }
  if (message.written()) {
    String text = message.value();
    Serial.print("message: ");
    Serial.println(text);
    matrix.beginDraw();
    matrix.stroke(0xFFFFFFFF);
    matrix.textScrollSpeed(60);
    matrix.textFont(Font_5x7);
    matrix.beginText(12, 1, 0xFFFFFF);
    matrix.print(text);
    matrix.endText(SCROLL_LEFT);
    matrix.endDraw();
    showMood(mood.value());
  }
  if (millis() - lastTick >= 1000) {
    lastTick = millis();
    secondsOn.writeValue(millis() / 1000);
  }
}
