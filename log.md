#include <DHT.h>

#define DHTPIN 4     // Pin connected to DHT22 data line
#define DHTTYPE DHT22   

DHT dht(DHTPIN, DHTTYPE);

void setup() {
  Serial.begin(115200); // Baud rate must match the JavaScript configuration
  dht.begin();
}

void loop() {
  float h = dht.readHumidity();
  float t = dht.readTemperature(); // Celsius

  // Check if readings are valid
  if (!isnan(h) && !isnan(t)) {
    // Calculate VPD using your project formula
    float svp = 0.6108 * exp((17.27 * t) / (t + 237.3));
    float vpd = svp * (1.0 - (h / 100.0));

    // Print clean JSON object to the USB Serial port
    Serial.print("{\"temperature\":");
    Serial.print(t, 1);
    Serial.print(",\"humidity\":");
    Serial.print(h, 1);
    Serial.print(",\"vpd\":");
    Serial.print(vpd, 2);
    Serial.println(",\"sensor_confidence\":\"HIGH\"}");
  }
  
  delay(2000); // Send data every 2 seconds
}

html
<!-- Connection Trigger -->
<div class="card" style="margin-bottom: 15px;">
    <button id="connect-usb-btn" style="padding: 10px 20px; font-weight: bold; cursor: pointer;">Connect Microfarm USB</button>
    <span id="connection-status" style="margin-left: 10px; color: red;">Status: Disconnected</span>
</div>

<!-- Global Enclosure Metrics Display -->
<div class="card">
    <h3>Enclosure Environment (DHT22)</h3>
    <p>Temperature: <span id="current-temp">--</span> °C</p>
    <p>Relative Humidity: <span id="current-rh">--</span> %</p>
    <p>VPD: <span id="current-vpd">--</span> kPa</p>
    <p id="temp-confidence">Sensor confidence: --</p>
</div>

js
const connectBtn = document.getElementById("connect-usb-btn");
const statusSpan = document.getElementById("connection-status");

connectBtn.addEventListener("click", async () => {
    // Ensure browser supports Web Serial API (Chrome, Edge, Opera)
    if (!("serial" in navigator)) {
        alert("Web Serial API not supported in this browser. Please use Google Chrome or Microsoft Edge.");
        return;
    }

    try {
        // Request port access and open connection
        const port = await navigator.serial.requestPort();
        await port.open({ baudRate: 115200 });

        statusSpan.innerText = "Status: Connected";
        statusSpan.style.color = "green";
        connectBtn.innerText = "Connected";
        connectBtn.disabled = true;

        const textDecoder = new TextDecoderStream();
        port.readable.pipeTo(textDecoder.writable);
        const reader = textDecoder.readable.getReader();

        let buffer = "";
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            
            buffer += value;
            let lines = buffer.split("\n");
            buffer = lines.pop(); // Retain partial chunks for the next read cycle

            for (let line of lines) {
                try {
                    // Parse the JSON string transmitted over USB
                    const data = JSON.parse(line.trim());
                    
                    // Update your dashboard DOM elements dynamically
                    document.getElementById("current-temp").innerText = data.temperature;
                    document.getElementById("current-rh").innerText = data.humidity;
                    document.getElementById("current-vpd").innerText = data.vpd;
                    document.getElementById("temp-confidence").innerText = `Sensor confidence: ${data.sensor_confidence}`;
                    
                } catch (err) {
                    // Skip non-JSON or debug logging lines cleanly
                }
            }
        }
    } catch (error) {
        console.error("Error reading serial port:", error);
        statusSpan.innerText = "Status: Connection Failed";
        statusSpan.style.color = "orange";
    }
});

