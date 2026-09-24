#include <Arduino.h>
#include <DHT.h>
#include <ESP32Servo.h>
#include <ArduinoJson.h>
#include <HardwareSerial.h>

// --- PIN DEFINITIONS ---
#define DHTPIN 4
#define DHTTYPE DHT22
#define SERVO_PIN 18 // SG90 360 Continuous Servo PWM Signal connected to GPIO 18

// Actuator Pins (Relays)
#define FAN_PIN 5
#define PUMP1_PIN 6
#define PUMP2_PIN 7
#define LIGHT1_PIN 15
#define LIGHT2_PIN 21 // Moved from 16 to 21 to free up GPIO 16 for CO2 sensor UART2!

// CO2 Sensor (MH-Z19B) UART2 Pins
#define CO2_RX_PIN 16 // Connect to MH-Z19B TX wire (Pin 6)
#define CO2_TX_PIN 17 // Connect to MH-Z19B RX wire (Pin 5)

// Analog Sensor Pins
#define ZONE1_MOISTURE_PIN 1
#define ZONE1_LIGHT_PIN 2
#define ZONE2_MOISTURE_PIN 3
#define ZONE2_LIGHT_PIN 8

// --- OBJECT INITIALIZATION ---
DHT dht(DHTPIN, DHTTYPE);
Servo flapServo;
HardwareSerial co2Serial(2); // Hardware Serial 2 for MH-Z19B CO2 sensor

// --- 360 SERVO MICROSECOND CONFIGURATION ---
const int SERVO_STOP = 1500;  // Calibrated true center stop pulse (microseconds)
const int SERVO_OPEN = 1900;  // Open pulse width
const int SERVO_CLOSE = 1100; // Close pulse width
const int MOVE_DURATION = 500; // Milliseconds to run servo for full open/close cycle

// Target VPD Bounds (in kPa)
const float VPD_UPPER_LIMIT = 1.2; 
const float VPD_LOWER_LIMIT = 0.8; 

// --- MANUAL VPD OVERRIDE CONFIGURATION ---
bool useManualVpd = true;         
float manualVpdValue = 1.5;       

// Global Timing & State Variables
unsigned long previousMillis = 0;
const long readInterval = 2000;     // Telemetry loop runs every 2 seconds
String flapState = "CLOSED";       

// --- POWER BANK KEEP-AWAKE CONFIGURATION ---
unsigned long lastWakePulseTime = 0;
const unsigned long WAKE_PULSE_INTERVAL = 8000; 

void keepPowerBankAwake() {
  flapServo.writeMicroseconds(1600); 
  delay(80); 
  flapServo.writeMicroseconds(1400); 
  delay(80); 
  flapServo.writeMicroseconds(SERVO_STOP); 
}

void moveFlap(int microsecondPulse, int durationMs) {
  flapServo.writeMicroseconds(microsecondPulse);
  delay(durationMs);
  flapServo.writeMicroseconds(SERVO_STOP); 
  lastWakePulseTime = millis();
}

float calculateVPD(float tempC, float rh) {
  float svp = 0.61078 * exp((17.27 * tempC) / (tempC + 237.3));
  float vpd = svp * (1.0 - (rh / 100.0));
  return vpd;
}

/**
 * Reads CO2 concentration in PPM from the MH-Z19B sensor via UART2
 */
int readCO2PPM() {
  byte cmd[9] = {0xFF, 0x01, 0x86, 0x00, 0x00, 0x00, 0x00, 0x00, 0x79};
  co2Serial.write(cmd, 9);
  
  byte response[9];
  memset(response, 0, 9);
  
  unsigned long startTime = millis();
  while (co2Serial.available() < 9) {
    if (millis() - startTime > 800) {
      return -1; // Timeout error
    }
  }
  
  co2Serial.readBytes(response, 9);
  
  byte checksum = 0;
  for (int i = 1; i < 8; i++) {
    checksum += response[i];
  }
  checksum = 0xFF - checksum + 1;
  
  if (response[0] == 0xFF && response[1] == 0x86 && response[8] == checksum) {
    int co2Ppm = (response[2] << 8) + response[3];
    return co2Ppm;
  }
  return -2; // Checksum mismatch error
}

void processIncomingSerialCommands() {
  if (Serial.available() > 0) {
    String input = Serial.readStringUntil('\n');
    input.trim();
    
    StaticJsonDocument<200> doc;
    DeserializationError error = deserializeJson(doc, input);

    if (!error) {
      if (doc.containsKey("fan"))    digitalWrite(FAN_PIN, doc["fan"] ? HIGH : LOW);
      if (doc.containsKey("pump1"))  digitalWrite(PUMP1_PIN, doc["pump1"] ? HIGH : LOW);
      if (doc.containsKey("pump2"))  digitalWrite(PUMP2_PIN, doc["pump2"] ? HIGH : LOW);
      if (doc.containsKey("light1")) digitalWrite(LIGHT1_PIN, doc["light1"] ? HIGH : LOW);
      if (doc.containsKey("light2")) digitalWrite(LIGHT2_PIN, doc["light2"] ? HIGH : LOW);
      
      if (doc.containsKey("manual_vpd")) {
        float val = doc["manual_vpd"];
        if (val < 0) {
          useManualVpd = false;
          Serial.println(">>> Manual VPD override disabled.");
        } else {
          useManualVpd = true;
          manualVpdValue = val;
          Serial.print(">>> Manual VPD set to: ");
          Serial.println(manualVpdValue);

          if (manualVpdValue > VPD_UPPER_LIMIT && flapState != "OPEN") {
            moveFlap(SERVO_OPEN, MOVE_DURATION);
            flapState = "OPEN";
            digitalWrite(FAN_PIN, HIGH);
          } 
          else if (manualVpdValue <= VPD_LOWER_LIMIT && flapState != "CLOSED") {
            moveFlap(SERVO_CLOSE, MOVE_DURATION);
            flapState = "CLOSED";
            digitalWrite(FAN_PIN, LOW);
          }
        }
      }

      if (doc.containsKey("restart") && doc["restart"] == true) {
        ESP.restart();
      }
    }
  }
}

void readAndSendTelemetry() {
  float hum = dht.readHumidity();
  float temp = dht.readTemperature();

  float vpd;
  if (useManualVpd) {
    vpd = manualVpdValue;
    if (isnan(temp)) temp = 25.0;
    if (isnan(hum)) hum = 50.0;
  } else {
    if (isnan(hum) || isnan(temp)) return; 
    vpd = calculateVPD(temp, hum);
  }

  // Servo & Fan Control Logic
  if (vpd > VPD_UPPER_LIMIT && flapState != "OPEN") {
    moveFlap(SERVO_OPEN, MOVE_DURATION);
    flapState = "OPEN";
    digitalWrite(FAN_PIN, HIGH);
  } 
  else if (vpd <= VPD_LOWER_LIMIT && flapState != "CLOSED") {
    moveFlap(SERVO_CLOSE, MOVE_DURATION);
    flapState = "CLOSED";
    digitalWrite(FAN_PIN, LOW);
  }

  // Read ADC Sensors
  int z1_m = analogRead(ZONE1_MOISTURE_PIN);
  int z1_l = analogRead(ZONE1_LIGHT_PIN);
  int z2_m = analogRead(ZONE2_MOISTURE_PIN);
  int z2_l = analogRead(ZONE2_LIGHT_PIN);

  // Read CO2 Sensor PPM
  int co2Ppm = readCO2PPM();

  // --- BUILD & TRANSMIT JSON PAYLOAD ---
  StaticJsonDocument<256> doc;
  doc["temp"] = round(temp * 10.0) / 10.0;
  doc["hum"] = round(hum * 10.0) / 10.0;
  doc["vpd"] = round(vpd * 100.0) / 10.0;
  doc["co2"] = (co2Ppm > 0) ? co2Ppm : 0; // Include CO2 PPM value
  doc["flap_state"] = flapState;
  doc["manual_vpd_active"] = useManualVpd;
  doc["z1_m"] = z1_m;
  doc["z1_l"] = z1_l;
  doc["z2_m"] = z2_m;
  doc["z2_l"] = z2_l;

  serializeJson(doc, Serial);
  Serial.println(); 
}

void setup() {
  Serial.begin(115200);

  // Initialize CO2 Sensor Serial (UART2)
  co2Serial.begin(9600, SERIAL_8N1, CO2_RX_PIN, CO2_TX_PIN);

  // --- ESP32 HARDWARE TIMER ALLOCATION FOR SERVO ---
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);

  flapServo.setPeriodHertz(50);
  flapServo.attach(SERVO_PIN, 1000, 2000);
  
  // Homing Sequence
  Serial.println("Homing flap to CLOSED position...");
  flapServo.writeMicroseconds(SERVO_CLOSE);
  delay(MOVE_DURATION);
  flapServo.writeMicroseconds(SERVO_STOP);
  flapState = "CLOSED";
  
  lastWakePulseTime = millis();

  // Pin Modes
  pinMode(FAN_PIN, OUTPUT);
  pinMode(PUMP1_PIN, OUTPUT);
  pinMode(PUMP2_PIN, OUTPUT);
  pinMode(LIGHT1_PIN, OUTPUT);
  pinMode(LIGHT2_PIN, OUTPUT);

  dht.begin();
}

void loop() {
  processIncomingSerialCommands();

  unsigned long currentMillis = millis();
  if (currentMillis - lastWakePulseTime >= WAKE_PULSE_INTERVAL) {
    keepPowerBankAwake();
    lastWakePulseTime = currentMillis;
  }

  if (currentMillis - previousMillis >= readInterval) {
    previousMillis = currentMillis;
    readAndSendTelemetry();
  }
}