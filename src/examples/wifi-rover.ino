// Wi-Fi remote-control rover (ESP32): a phone-style web page with Forward / Left / Right / Backward / Stop.
// Press Run, wait for "WiFi connected!" in the serial monitor, then select the ESP32 in the run panel
// and press "Open its web page" (or "Open in my browser").
//
// Wiring (the same on a real car):
//   2x 18650 (7.4 V) +  -> L298N 12V   and  ESP32 5V (VIN)  (motors and board from one pack)
//   2x 18650 (7.4 V) -  -> L298N GND   and  ESP32 GND       (one shared ground: needed!)
//   ESP32 25 -> IN1, 26 -> IN2, 27 (PWM) -> ENA              (motor A: left wheel)
//   ESP32 32 -> IN3, 33 -> IN4, 14 (PWM) -> ENB              (motor B: right wheel)
//   L298N OUT1 -> left motor +,  OUT2 -> left motor -
//   L298N OUT3 -> right motor -, OUT4 -> right motor +       (swapped: the right motor faces the other
//                                                              way, so "forward" must turn it backwards)
// Take the ENA/ENB jumpers off the L298N, or the speed pins do nothing (always full speed).
// Why these pins: GPIO 6-11 belong to the ESP32's flash chip; 25-27, 32, 33 and 14 are free outputs.
// On an ESP32, WiFi.begin() returns at once: call it once, then wait on WiFi.status() (calling begin()
// over and over restarts the connection every time). The L298N reads the ESP32's 3.3 V as HIGH.
#include <WiFi.h>

// Wi-Fi credentials
const char* ssid = "Workshop";
const char* password = "bench1234";

// Motor A (Left front wheel)
const int IN1 = 25;
const int IN2 = 26;
const int ENA = 27; // PWM

// Motor B (Right front wheel)
const int IN3 = 32;
const int IN4 = 33;
const int ENB = 14; // PWM

WiFiServer server(80);

void setup() {
  // Set motor pins as output
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(ENA, OUTPUT);

  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);
  pinMode(ENB, OUTPUT);

  Serial.begin(115200);

  // Connect to WiFi: start once, then wait
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.println("WiFi connected!");
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());
  Serial.print("Connection status: ");
  Serial.println(WiFi.status());  // WL_CONNECTED = 3

  server.begin();
}

void loop() {
  WiFiClient client = server.available();

  if (client) {
    String request = client.readStringUntil('\r');
    client.flush();

    if (request.indexOf("/forward") != -1) {
      moveForward();
    } else if (request.indexOf("/backward") != -1) {
      moveBackward();
    } else if (request.indexOf("/left") != -1) {
      turnLeft();
    } else if (request.indexOf("/right") != -1) {
      turnRight();
    } else if (request.indexOf("/stop") != -1) {
      stopMotors();
    } else {
      stopMotors();
    }

    // HTML interface
    client.println("HTTP/1.1 200 OK");
    client.println("Content-Type: text/html\n");
    client.println("<!DOCTYPE html><html><head><meta name='viewport' content='width=device-width, initial-scale=1'>");
    client.println("<style>");
    client.println("body { text-align: center; font-family: sans-serif; margin: 0; padding: 0;}");
    client.println("h1 { font-size: 28px; }");
    client.println(".btn { font-size: 24px; padding: 20px 40px; margin: 10px; background: #007bff; color: white; border: none; border-radius: 10px; cursor: pointer; }");
    client.println(".btn:active { background: #0056b3; }");
    client.println(".stop-btn { background: red; font-size: 30px; padding: 30px 60px; }");
    client.println("@media screen and (max-width: 600px) { .btn { font-size: 20px; padding: 15px 30px; } h1 { font-size: 24px; } }");
    client.println("</style></head><body>");
    client.println("<h1>Drive Control</h1>");
    client.println("<div>");
    client.println("<a href=\"/forward\"><button class=\"btn\">Forward</button></a><br>");
    client.println("<a href=\"/left\"><button class=\"btn\">Left</button></a>");
    client.println("<a href=\"/right\"><button class=\"btn\">Right</button></a><br>");
    client.println("<a href=\"/backward\"><button class=\"btn\">Backward</button></a><br>");
    client.println("<a href=\"/stop\"><button class=\"btn stop-btn\">Stop</button></a>");
    client.println("</div>");
    client.println("</body></html>");
    client.stop();
  }
}

// === Motor Control Functions ===

void moveForward() {
  digitalWrite(IN1, HIGH);
  digitalWrite(IN2, LOW);
  analogWrite(ENA, 200);

  digitalWrite(IN3, HIGH);
  digitalWrite(IN4, LOW);
  analogWrite(ENB, 200);
}

void moveBackward() {
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);
  analogWrite(ENA, 200);

  digitalWrite(IN3, LOW);
  digitalWrite(IN4, HIGH);
  analogWrite(ENB, 200);
}

void turnLeft() {
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);   // Left motor backward
  analogWrite(ENA, 200);

  digitalWrite(IN3, HIGH);
  digitalWrite(IN4, LOW);    // Right motor forward
  analogWrite(ENB, 200);
}

void turnRight() {
  digitalWrite(IN1, HIGH);
  digitalWrite(IN2, LOW);    // Left motor forward
  analogWrite(ENA, 200);

  digitalWrite(IN3, LOW);
  digitalWrite(IN4, HIGH);   // Right motor backward
  analogWrite(ENB, 200);
}

void stopMotors() {
  analogWrite(ENA, 0);
  analogWrite(ENB, 0);
}
