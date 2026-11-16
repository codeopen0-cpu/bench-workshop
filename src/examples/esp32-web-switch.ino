// ESP32 web switch: the board joins the bench's Wi-Fi and serves a page with On / Off buttons for
// the LED on IO4, and shows the knob on IO34. Press Run, wait for "Connected!" in the serial monitor,
// then select the ESP32 in the run panel and press "Open its web page".
#include <WiFi.h>
#include <WebServer.h>

const char* ssid = "Workshop";       // the bench's Wi-Fi (project settings: click the empty bench)
const char* password = "bench1234";

WebServer server(80);
const int LED = 4;
const int KNOB = 34;
bool ledOn = false;

const char page[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ESP32 web switch</title>
<style>
  body { font-family: sans-serif; text-align: center; margin-top: 30px; background: #f4f6fa; }
  button { font-size: 22px; padding: 12px 30px; margin: 8px; border-radius: 10px; border: 0; color: white; }
  .on { background: #2fa36b; } .off { background: #c0392b; }
  .card { display: inline-block; background: white; padding: 18px 30px; border-radius: 14px; box-shadow: 0 2px 10px #0002; }
</style></head>
<body><div class="card">
  <h1>ESP32 web switch</h1>
  <p>The LED is <b id="state">...</b></p>
  <button class="on" onclick="send('on')">On</button>
  <button class="off" onclick="send('off')">Off</button>
  <p>Knob: <b id="knob">...</b> of 4095</p>
</div>
<script>
  function send(s) {
    fetch('/led?state=' + s).then(r => r.text()).then(t => document.getElementById('state').textContent = t);
  }
  setInterval(() => fetch('/status').then(r => r.json()).then(j => {
    document.getElementById('state').textContent = j.led ? 'on' : 'off';
    document.getElementById('knob').textContent = j.knob;
  }), 500);
</script>
</body></html>
)rawliteral";

void handleRoot() {
  server.send(200, "text/html", page);
}

void handleLed() {
  ledOn = server.arg("state") == "on";
  digitalWrite(LED, ledOn ? HIGH : LOW);
  server.send(200, "text/plain", ledOn ? "on" : "off");
}

void handleStatus() {
  String json = "{\"led\":" + String(ledOn ? "true" : "false") + ",\"knob\":" + String(analogRead(KNOB)) + "}";
  server.send(200, "application/json", json);
}

void setup() {
  Serial.begin(115200);
  pinMode(LED, OUTPUT);
  WiFi.begin(ssid, password);
  Serial.print("Connecting to Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("Connected! The page is at http://");
  Serial.println(WiFi.localIP());
  server.on("/", handleRoot);
  server.on("/led", handleLed);
  server.on("/status", handleStatus);
  server.begin();
}

void loop() {
  server.handleClient();
}
