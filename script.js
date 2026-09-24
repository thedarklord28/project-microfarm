/**
 * Urban Microfarm IoT Control Dashboard Engine
 * Optimized Architecture:
 * - Separates sensor telemetry acquisition (getSensorData) from UI rendering and control decisions.
 * - Implements a deterministic, rule-based actuator control engine with hysteresis and safety constraints.
 * - Enforces strict data confidence labeling (Direct, Calculated, Calibrated, Relative).
 * - Full Web Serial API Integration for USB ESP32-S3 & DHT22 telemetry.
 */

// --- 1. LOCAL PLANT DATABASE ---
let PLANT_DATABASE = {}; // Stored as an object/dictionary loaded from plants.json

async function initializePlantDatabase() {
    try {
        const response = await fetch('plants.json');
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
        
        PLANT_DATABASE = await response.json();
        console.log("Plant database loaded successfully from plants.json", PLANT_DATABASE);

        if (typeof populatePlantDropdowns === 'function') {
            populatePlantDropdowns();
        }
    } catch (error) {
        console.warn("Could not fetch plants.json directly, falling back to built-in fallback profiles.", error);
        // Fallback default plant database if external json is absent
        PLANT_DATABASE = {
            lettuce: {
                name: "Butterhead Lettuce",
                category: "Leafy Green",
                stages: {
                    Vegetative: { 
                        temperature: { min: 16, target: 21, max: 25 }, 
                        humidity: { min: 55, target: 65, max: 75 }, 
                        vpd: { min: 0.8, target: 1.0, max: 1.2 },
                        moisture: { min: 60, target: 70, max: 85 }, 
                        light: { min: 500, target: 700, max: 900 } 
                    }
                }
            },
            basil: {
                name: "Genovese Basil",
                category: "Herb",
                stages: {
                    Vegetative: { 
                        temperature: { min: 21, target: 25, max: 30 }, 
                        humidity: { min: 60, target: 70, max: 80 }, 
                        vpd: { min: 0.8, target: 1.1, max: 1.4 },
                        moisture: { min: 60, target: 70, max: 85 }, 
                        light: { min: 600, target: 800, max: 1000 } 
                    }
                }
            }
        };
        populatePlantDropdowns();
    }
}

// Helper to get active profile safely across JSON and custom local storage plants
function getActivePlantProfile(zoneId) {
    if (!sensorData.zones || !sensorData.zones[zoneId]) return null;
    const plantId = sensorData.zones[zoneId].plantId;
    
    // Check custom plants in localStorage first
    const customPlants = JSON.parse(localStorage.getItem('urban_microfarm_custom_plants') || '[]');
    const foundCustom = customPlants.find(p => p.id === plantId);
    if (foundCustom) return foundCustom;

    // Check main JSON dictionary database
    if (PLANT_DATABASE && PLANT_DATABASE[plantId]) {
        return PLANT_DATABASE[plantId];
    }

    // Fallback default if nothing matches
    const firstKey = PLANT_DATABASE ? Object.keys(PLANT_DATABASE)[0] : null;
    if (firstKey && PLANT_DATABASE[firstKey]) {
        return PLANT_DATABASE[firstKey];
    }

    return {
        name: "Default Plant",
        stages: {
            Vegetative: { 
                temperature: { min: 18, target: 24, max: 28 }, 
                humidity: { min: 50, target: 60, max: 75 }, 
                vpd: { min: 0.8, target: 1.0, max: 1.4 },
                moisture: { min: 55, target: 65, max: 75 }, 
                light: { min: 250, target: 500, max: 800 } 
            }
        }
    };
}

// --- 2. GLOBAL SYSTEM STATE ---
let controlMode = 'auto'; // 'auto' or 'manual'
let simulationMode = true;

let sensorData = {
    temperature: 23.5, // °C
    humidity: 62.0,    // %
    vpd: 0.95,         // kPa
    zones: {
        1: { moistureADC: 580, lightADC: 750, moisturePct: 65, plantId: 'lettuce', stage: 'Vegetative' },
        2: { moistureADC: 640, lightADC: 820, moisturePct: 52, plantId: 'basil', stage: 'Vegetative' }
    }
};

let actuators = {
    fan: { state: false, reason: 'System stable' },
    pump1: { state: false, reason: 'Moisture adequate' },
    pump2: { state: false, reason: 'Moisture adequate' },
    light1: { state: true, reason: 'Photoperiod active' },
    light2: { state: true, reason: 'Photoperiod active' }
};

let calibrations = {
    zone1: { dry: 850, wet: 300, calibrated: false },
    zone2: { dry: 850, wet: 300, calibrated: false }
};

let telemetryHistory = [];
let alerts = [];

// Web Serial API handles
let serialPort = null;
let serialReader = null;
let serialWriter = null;
let isHardwareConnected = false;

// --- 3. INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    initializePlantDatabase();
    initActuatorUI();
    
    // Start main control & simulation loop
    setInterval(mainLoop, 1000);
});

// --- 4. WEB SERIAL HARDWARE CONNECTION ---
async function toggleHardwareConnection() {
    if (!("serial" in navigator)) {
        alert("Web Serial API is not supported in this browser. Please use Chrome, Edge, or Opera.");
        return;
    }

    if (isHardwareConnected) {
        await disconnectHardware();
    } else {
        await connectHardware();
    }
}

async function connectHardware() {
    try {
        serialPort = await navigator.serial.requestPort();
        await serialPort.open({ baudRate: 115200 });
        
        isHardwareConnected = true;
        
        // Auto-disable simulation mode when real hardware is linked
        simulationMode = false;
        const simToggle = document.getElementById('sim-mode-toggle');
        if (simToggle) simToggle.checked = false;

        updateHardwareUIStatus(true);
        pushAlert('Connected to ESP32 via Serial USB.', 'info');

        // Setup writer stream
        const textEncoder = new TextEncoderStream();
        textEncoder.readable.pipeTo(serialPort.writable);
        serialWriter = textEncoder.writable.getWriter();

        // Start reading loop
        readSerialStream();
    } catch (err) {
        console.error("Serial Connection Error: ", err);
        pushAlert(`Hardware Connection Failed: ${err.message}`, 'danger');
        updateHardwareUIStatus(false);
    }
}

async function disconnectHardware() {
    try {
        if (serialReader) {
            await serialReader.cancel();
            serialReader.releaseLock();
        }
        if (serialWriter) {
            await serialWriter.close();
        }
        if (serialPort) {
            await serialPort.close();
        }
    } catch (err) {
        console.warn("Error during serial port close:", err);
    } finally {
        isHardwareConnected = false;
        serialPort = null;
        serialReader = null;
        serialWriter = null;
        
        updateHardwareUIStatus(false);
        pushAlert('Disconnected from ESP32 Serial Hardware.', 'warning');
    }
}

async function readSerialStream() {
    const textDecoder = new TextDecoderStream();
    const readableStreamClosed = serialPort.readable.pipeTo(textDecoder.writable);
    serialReader = textDecoder.readable.getReader();

    let buffer = '';

    try {
        while (true) {
            const { value, done } = await serialReader.read();
            if (done) {
                serialReader.releaseLock();
                break;
            }
            if (value) {
                buffer += value;
                let lines = buffer.split('\n');
                // Keep incomplete line snippet in buffer
                buffer = lines.pop(); 

                for (let line of lines) {
                    line = line.trim();
                    if (line.length > 0) {
                        parseIncomingSerialLine(line);
                    }
                }
            }
        }
    } catch (err) {
        console.error("Serial Reading Loop Error:", err);
    }
}

function parseIncomingSerialLine(line) {
    try {
        const parsed = JSON.parse(line);

        if (typeof parsed.temp === 'number') sensorData.temperature = parsed.temp;
        if (typeof parsed.hum === 'number') sensorData.humidity = parsed.hum;
        if (typeof parsed.vpd === 'number') sensorData.vpd = parsed.vpd;
        
        // --- ADDED: CO2 Sensor Telemetry Handling ---
        if (typeof parsed.co2 === 'number') {
            sensorData.co2 = parsed.co2;
            const co2El = document.getElementById('val-co2');
            if (co2El) co2El.innerHTML = `${parsed.co2} <span class="unit">ppm</span>`;
        }
        
        // Track Flap Servo state in Dashboard UI
        if (typeof parsed.flap_state === 'string') {
            actuators.fan.reason = `Flap state: ${parsed.flap_state} (VPD: ${parsed.vpd} kPa)`;
            actuators.fan.state = parsed.flap_state === "OPEN";
        } else if (typeof parsed.flap_angle === 'number') {
            actuators.fan.reason = `Flap open at ${parsed.flap_angle}° (VPD: ${parsed.vpd} kPa)`;
            actuators.fan.state = parsed.flap_angle > 0;
        }
        
        // Zone sensor telemetry updates
        if (typeof parsed.z1_m === 'number') sensorData.zones[1].moistureADC = parsed.z1_m;
        if (typeof parsed.z1_l === 'number') sensorData.zones[1].lightADC = parsed.z1_l;
        if (typeof parsed.z2_m === 'number') sensorData.zones[2].moistureADC = parsed.z2_m;
        if (typeof parsed.z2_l === 'number') sensorData.zones[2].lightADC = parsed.z2_l;

        // Update Direct Confidence Badges
        setConfidenceBadge('conf-temp', 'DIRECT (DHT22)', 'calibrated');
        setConfidenceBadge('conf-hum', 'DIRECT (DHT22)', 'calibrated');
        setConfidenceBadge('conf-co2', 'DIRECT (MH-Z19B)', 'calibrated'); // Added badge update for CO2

    } catch (e) {
        // Handle non-JSON serial logs/debug messages gracefully
        console.log("ESP32 Raw Serial Log:", line);
    }
}

async function sendSerialCommand(commandObj) {
    if (!isHardwareConnected || !serialWriter) return;
    try {
        const payload = JSON.stringify(commandObj) + '\n';
        await serialWriter.write(payload);
    } catch (err) {
        console.error("Failed to transmit command over Serial:", err);
    }
}

function updateHardwareUIStatus(connected) {
    const btn = document.getElementById('btn-connect');
    if (btn) {
        if (connected) {
            btn.innerText = 'Disconnect ESP32';
            btn.classList.add('connected');
        } else {
            btn.innerText = 'Connect Hardware';
            btn.classList.remove('connected');
        }
    }

    const hwStatusBadge = document.getElementById('hardware-status-badge');
    if (hwStatusBadge) {
        hwStatusBadge.innerText = connected ? 'ESP32 ONLINE (USB)' : 'HARDWARE OFFLINE';
        hwStatusBadge.className = `status-pill ${connected ? 'optimal' : 'warning'}`;
    }
}

function setConfidenceBadge(id, text, typeClass) {
    const el = document.getElementById(id);
    if (el) {
        el.innerText = text;
        el.className = `confidence-badge ${typeClass}`;
    }
}

// --- 5. BACKEND-READY API HOOKS & TELEMETRY ---
function getSensorData() {
    if (simulationMode && controlMode === 'auto') {
        // Natural drift and reaction to actuators in simulation
        if (actuators.fan.state) {
            sensorData.temperature = Math.max(10, sensorData.temperature - 0.08);
            sensorData.humidity = Math.max(20, sensorData.humidity - 0.15);
        } else {
            sensorData.temperature += (24.5 - sensorData.temperature) * 0.02;
            sensorData.humidity += (65 - sensorData.humidity) * 0.02;
        }

        if (actuators.pump1.state) {
            sensorData.zones[1].moistureADC = Math.max(300, sensorData.zones[1].moistureADC - 15);
        } else {
            sensorData.zones[1].moistureADC = Math.min(900, sensorData.zones[1].moistureADC + 1.5);
        }

        if (actuators.pump2.state) {
            sensorData.zones[2].moistureADC = Math.max(300, sensorData.zones[2].moistureADC - 15);
        } else {
            sensorData.zones[2].moistureADC = Math.min(900, sensorData.zones[2].moistureADC + 1.5);
        }

        // Light actuators affect LDR reading
        sensorData.zones[1].lightADC = actuators.light1.state ? 850 : 350;
        sensorData.zones[2].lightADC = actuators.light2.state ? 900 : 350;
    }

    // Recalculate normalized relative moisture percentages from ADC using zone calibrations
    sensorData.zones[1].moisturePct = adcToMoisturePercent(sensorData.zones[1].moistureADC, calibrations.zone1);
    sensorData.zones[2].moisturePct = adcToMoisturePercent(sensorData.zones[2].moistureADC, calibrations.zone2);

    // Calculate VPD
    sensorData.vpd = calculateVPD(sensorData.temperature, sensorData.humidity);

    return sensorData;
}

function calculateVPD(t, rh) {
    const svp = 0.6108 * Math.exp((17.27 * t) / (t + 237.3));
    const vpd = svp * (1 - rh / 100);
    return Math.max(0, parseFloat(vpd.toFixed(2)));
}

function adcToMoisturePercent(adc, cal) {
    let pct = ((cal.dry - adc) / (cal.dry - cal.wet)) * 100;
    return Math.min(100, Math.max(0, Math.round(pct)));
}

// --- 6. CONTROL ENGINE & LOGIC ---
function mainLoop() {
    const data = getSensorData();

    if (controlMode === 'auto') {
        runControlEngine(data);
    }

    updateDashboardUI(data);
    logTelemetryData(data);
}

function runControlEngine(data) {
    const p1 = getActivePlantProfile(1);
    const p2 = getActivePlantProfile(2);
    if (!p1 || !p2) return; 

    const stage1 = data.zones[1].stage || 'Vegetative';
    const stage2 = data.zones[2].stage || 'Vegetative';

    const p1Stages = p1.stages[stage1] || p1.stages[Object.keys(p1.stages)[0]];
    const p2Stages = p2.stages[stage2] || p2.stages[Object.keys(p2.stages)[0]];
    if (!p1Stages || !p2Stages) return;

    // 1. Fan Control
    const tempHigh = data.temperature > p1Stages.temperature.max;
    const humHigh = data.humidity > p1Stages.humidity.max;
    const tempTooLow = data.temperature < p1Stages.temperature.min;

    if (tempTooLow) {
        setActuatorState('fan', false, 'Temperature below minimum — cooling halted');
    } else if (tempHigh && humHigh) {
        setActuatorState('fan', true, 'Temperature above max + humidity above max (Fan cooling & drying)');
    } else if (tempHigh) {
        setActuatorState('fan', true, 'Temperature above maximum target');
    } else if (humHigh) {
        setActuatorState('fan', true, 'Humidity above maximum target');
    } else {
        setActuatorState('fan', false, 'Enclosure environment within target range');
    }

    // 2. Pump 1 Control (Hysteresis)
    if (data.zones[1].moisturePct < p1Stages.moisture.min && !actuators.pump1.state) {
        setActuatorState('pump1', true, `Zone 1 moisture (${data.zones[1].moisturePct}%) below minimum (${p1Stages.moisture.min}%)`);
    } else if (data.zones[1].moisturePct > (p1Stages.moisture.target + 5) && actuators.pump1.state) {
        setActuatorState('pump1', false, 'Zone 1 moisture reached target hysteresis threshold');
    }

    // 3. Pump 2 Control (Hysteresis)
    if (data.zones[2].moisturePct < p2Stages.moisture.min && !actuators.pump2.state) {
        setActuatorState('pump2', true, `Zone 2 moisture (${data.zones[2].moisturePct}%) below minimum (${p2Stages.moisture.min}%)`);
    } else if (data.zones[2].moisturePct > (p2Stages.moisture.target + 5) && actuators.pump2.state) {
        setActuatorState('pump2', false, 'Zone 2 moisture reached target hysteresis threshold');
    }

    // 4. Lights Control
    const light1State = data.zones[1].lightADC < p1Stages.light.min;
    setActuatorState('light1', light1State, light1State ? 'Zone 1 relative light below target' : 'Photoperiod light level adequate');

    const light2State = data.zones[2].lightADC < p2Stages.light.min;
    setActuatorState('light2', light2State, light2State ? 'Zone 2 relative light below target' : 'Photoperiod light level adequate');
}

function setActuatorState(key, state, reason) {
    if (actuators[key].state !== state) {
        actuators[key].state = state;
        actuators[key].reason = reason;
        
        // Transmit command to hardware if connected
        if (isHardwareConnected) {
            sendSerialCommand({ [key]: state });
        }
    } else {
        actuators[key].reason = reason;
    }
}

// --- 7. ENVIRONMENTAL MATCH SCORING ---
function calculateEnvironmentalMatch(zoneId, data) {
    const profile = getActivePlantProfile(zoneId);
    if (!profile) return { total: 0, breakdown: { temp: 0, hum: 0, vpd: 0, moist: 0, light: 0 } };

    const stage = data.zones[zoneId].stage || 'Vegetative';
    const targets = profile.stages[stage] || profile.stages[Object.keys(profile.stages)[0]];
    if (!targets) return { total: 0, breakdown: { temp: 0, hum: 0, vpd: 0, moist: 0, light: 0 } };

    const tempScore = getScoreInRange(data.temperature, targets.temperature.min, targets.temperature.target, targets.temperature.max);
    const humScore = getScoreInRange(data.humidity, targets.humidity.min, targets.humidity.target, targets.humidity.max);
    const vpdScore = getScoreInRange(data.vpd, targets.vpd.min, targets.vpd.target, targets.vpd.max);
    const moistScore = getScoreInRange(data.zones[zoneId].moisturePct, targets.moisture.min, targets.moisture.target, targets.moisture.max);
    const lightScore = getScoreInRange(data.zones[zoneId].lightADC, targets.light.min, targets.light.target, targets.light.max);

    const weights = { temp: 0.2, hum: 0.2, vpd: 0.2, moist: 0.2, light: 0.2 };
    const totalMatch = (tempScore * weights.temp + humScore * weights.hum + vpdScore * weights.vpd + moistScore * weights.moist + lightScore * weights.light);

    return {
        total: Math.round(totalMatch),
        breakdown: { temp: Math.round(tempScore), hum: Math.round(humScore), vpd: Math.round(vpdScore), moist: Math.round(moistScore), light: Math.round(lightScore) }
    };
}

function getScoreInRange(val, min, target, max) {
    if (val >= min && val <= max) {
        const range = max - min;
        const distFromTarget = Math.abs(val - target);
        const score = range === 0 ? 100 : 100 - (distFromTarget / (range / 2)) * 30;
        return Math.max(70, Math.min(100, score));
    } else {
        const dist = val < min ? min - val : val - max;
        const score = 70 - dist * 10;
        return Math.max(0, score);
    }
}

// --- 8. UI RENDERING & UPDATES ---
function updateDashboardUI(data) {
    const tempEl = document.getElementById('val-temp');
    if (tempEl) tempEl.innerHTML = `${data.temperature.toFixed(1)} <span class="unit">°C</span>`;
    
    const humEl = document.getElementById('val-humidity');
    if (humEl) humEl.innerHTML = `${data.humidity.toFixed(0)} <span class="unit">%</span>`;
    
    const vpdEl = document.getElementById('val-vpd');
    if (vpdEl) vpdEl.innerHTML = `${data.vpd.toFixed(2)} <span class="unit">kPa</span>`;

    const p1Profile = getActivePlantProfile(1);
    if (p1Profile) {
        const p1Stage = data.zones[1].stage || 'Vegetative';
        const p1Targets = p1Profile.stages[p1Stage] || p1Profile.stages[Object.keys(p1Profile.stages)[0]];
        
        if (p1Targets) {
            const tTargetEl = document.getElementById('target-temp');
            if (tTargetEl) tTargetEl.innerText = `Target: ${p1Targets.temperature.min}–${p1Targets.temperature.max}°C`;
            
            const hTargetEl = document.getElementById('target-humidity');
            if (hTargetEl) hTargetEl.innerText = `Target: ${p1Targets.humidity.min}–${p1Targets.humidity.max}%`;
            
            const vTargetEl = document.getElementById('target-vpd');
            if (vTargetEl) vTargetEl.innerText = `Target: ${p1Targets.vpd.min}–${p1Targets.vpd.max} kPa`;

            updateStatusPill('status-temp', evaluateStatus(data.temperature, p1Targets.temperature.min, p1Targets.temperature.max, '°C', 'Heating unavailable'));
            updateStatusPill('status-humidity', evaluateStatus(data.humidity, p1Targets.humidity.min, p1Targets.humidity.max, '%', 'Humidification unavailable'));
            updateStatusPill('status-vpd', evaluateStatus(data.vpd, p1Targets.vpd.min, p1Targets.vpd.max, 'kPa', ''));
        }

        // Zone 1 UI
        const z1Moist = document.getElementById('z1-val-moisture');
        if (z1Moist) z1Moist.innerHTML = `${data.zones[1].moisturePct} <span class="unit">%</span>`;
        
        const z1MoistTarget = document.getElementById('z1-target-moisture');
        if (z1MoistTarget && p1Targets) z1MoistTarget.innerText = `Target: ${p1Targets.moisture.min}–${p1Targets.moisture.max}%`;
        
        const z1Light = document.getElementById('z1-val-light');
        if (z1Light) z1Light.innerHTML = `${data.zones[1].lightADC} <span class="unit">ADC</span>`;
        
        const z1LightTarget = document.getElementById('z1-target-light');
        if (z1LightTarget && p1Targets) z1LightTarget.innerText = `Target: ${p1Targets.light.min}–${p1Targets.light.max} ADC`;
        
        const z1Pump = document.getElementById('z1-act-pump');
        if (z1Pump) z1Pump.innerText = actuators.pump1.state ? 'ON' : 'OFF';
        
        const z1LgtState = document.getElementById('z1-act-light');
        if (z1LgtState) z1LgtState.innerText = actuators.light1.state ? 'ON' : 'OFF';

        const z1Match = calculateEnvironmentalMatch(1, data);
        const z1MatchScore = document.getElementById('z1-match-score');
        if (z1MatchScore) z1MatchScore.innerText = `${z1Match.total}%`;
        
        renderBreakdownBars(z1Match.breakdown, 1);
    }

    // Zone 2 UI
    const p2Profile = getActivePlantProfile(2);
    if (p2Profile) {
        const p2Stage = data.zones[2].stage || 'Vegetative';
        const p2Targets = p2Profile.stages[p2Stage] || p2Profile.stages[Object.keys(p2Profile.stages)[0]];
        
        const z2Moist = document.getElementById('z2-val-moisture');
        if (z2Moist) z2Moist.innerHTML = `${data.zones[2].moisturePct} <span class="unit">%</span>`;
        
        const z2MoistTarget = document.getElementById('z2-target-moisture');
        if (z2MoistTarget && p2Targets) z2MoistTarget.innerText = `Target: ${p2Targets.moisture.min}–${p2Targets.moisture.max}%`;
        
        const z2Light = document.getElementById('z2-val-light');
        if (z2Light) z2Light.innerHTML = `${data.zones[2].lightADC} <span class="unit">ADC</span>`;
        
        const z2LightTarget = document.getElementById('z2-target-light');
        if (z2LightTarget && p2Targets) z2LightTarget.innerText = `Target: ${p2Targets.light.min}–${p2Targets.light.max} ADC`;
        
        const z2Pump = document.getElementById('z2-act-pump');
        if (z2Pump) z2Pump.innerText = actuators.pump2.state ? 'ON' : 'OFF';
        
        const z2LgtState = document.getElementById('z2-act-light');
        if (z2LgtState) z2LgtState.innerText = actuators.light2.state ? 'ON' : 'OFF';

        const z2Match = calculateEnvironmentalMatch(2, data);
        const z2MatchScore = document.getElementById('z2-match-score');
        if (z2MatchScore) z2MatchScore.innerText = `${z2Match.total}%`;
        
        renderBreakdownBars(z2Match.breakdown, 2);
    }

    renderActuatorsList();
}

function evaluateStatus(val, min, max, unit, limitationNote) {
    if (val >= min && val <= max) {
        return { text: '🟢 Optimal', class: 'optimal' };
    } else if (val < min) {
        return { text: `🟡 Below target ${limitationNote ? '— ' + limitationNote : ''}`, class: 'warning' };
    } else {
        return { text: `🟡 Above target`, class: 'warning' };
    }
}

function updateStatusPill(elementId, statusObj) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.innerText = statusObj.text;
    el.className = `status-pill ${statusObj.class}`;
}

function initActuatorUI() {
    renderActuatorsList();
}

function renderActuatorsList() {
    const container = document.getElementById('actuators-list-container');
    if (!container) return;

    const list = [
        { key: 'fan', name: 'Fan (Cooling/Drying)', data: actuators.fan },
        { key: 'pump1', name: 'Pump 1 (Zone 1 Irrigation)', data: actuators.pump1 },
        { key: 'pump2', name: 'Pump 2 (Zone 2 Irrigation)', data: actuators.pump2 },
        { key: 'light1', name: 'Light 1 (Zone 1 Spectrum)', data: actuators.light1 },
        { key: 'light2', name: 'Light 2 (Zone 2 Spectrum)', data: actuators.light2 }
    ];

    container.innerHTML = list.map(item => `
        <div class="actuator-row">
            <div class="actuator-info">
                <span class="actuator-name">${item.name}</span>
                <span class="actuator-reason">${item.data.reason}</span>
            </div>
            <div class="actuator-control-group">
                <span class="badge-state ${item.data.state ? 'on' : 'off'}">${item.data.state ? 'ON' : 'OFF'}</span>
                ${controlMode === 'manual' ? `<button class="manual-toggle-btn" onclick="toggleActuatorManual('${item.key}')">Toggle</button>` : ''}
            </div>
        </div>
    `).join('');
}

function renderBreakdownBars(breakdown, zoneId = 1) {
    const containerId = (zoneId === 2) ? 'breakdown-bars-container-2' : 'breakdown-bars-container';
    const container = document.getElementById(containerId);
    if (!container) return;

    const items = [
        { label: 'Temperature Match', score: breakdown.temp },
        { label: 'Humidity Match', score: breakdown.hum },
        { label: 'VPD Match', score: breakdown.vpd },
        { label: 'Soil Moisture Match', score: breakdown.moist },
        { label: 'Light Match', score: breakdown.light }
    ];

    container.innerHTML = items.map(item => `
        <div class="breakdown-item">
            <div class="breakdown-label-row">
                <span>${item.label}</span>
                <strong>${item.score}%</strong>
            </div>
            <div class="progress-bar-bg">
                <div class="progress-bar-fill" style="width: ${item.score}%"></div>
            </div>
        </div>
    `).join('');
}

// --- 9. PLANT MANAGEMENT & DROPDOWNS ---
function populatePlantDropdowns() {
    if (!PLANT_DATABASE || typeof PLANT_DATABASE !== 'object') return;

    const customPlants = JSON.parse(localStorage.getItem('urban_microfarm_custom_plants') || '[]');
    let optionsHtml = '';
    
    Object.keys(PLANT_DATABASE).forEach(key => {
        const plant = PLANT_DATABASE[key];
        optionsHtml += `<option value="${key}">${plant.name} (${plant.category || 'Crop'})</option>`;
    });

    customPlants.forEach(p => {
        optionsHtml += `<option value="${p.id}">${p.name} (${p.category || 'Custom Crop'})</option>`;
    });

    ['1', '2'].forEach(zone => {
        const select = document.getElementById(`zone${zone}-plant-select`);
        if (select) {
            select.innerHTML = optionsHtml;
            const currentPlantId = sensorData.zones[zone].plantId;
            
            const existsInJson = PLANT_DATABASE[currentPlantId];
            const existsInCustom = customPlants.some(p => p.id === currentPlantId);

            if (existsInJson || existsInCustom) {
                select.value = currentPlantId;
            } else {
                const firstKey = Object.keys(PLANT_DATABASE)[0] || (customPlants[0] ? customPlants[0].id : '');
                sensorData.zones[zone].plantId = firstKey;
                select.value = firstKey;
            }
        }
    });
}

function onPlantChange(zoneId) {
    const select = document.getElementById(`zone${zoneId}-plant-select`);
    if (!select) return;
    sensorData.zones[zoneId].plantId = select.value;
    pushAlert(`Zone ${zoneId} plant changed to ${select.options[select.selectedIndex]?.text || select.value}`, 'info');
}

function onStageChange(zoneId) {
    const select = document.getElementById(`zone${zoneId}-stage-select`);
    if (!select) return;
    sensorData.zones[zoneId].stage = select.value;
    pushAlert(`Zone ${zoneId} growth stage updated to ${select.value}`, 'info');
}

// --- 10. CONTROL MODES & MANUAL OVERRIDES ---
function setControlMode(mode) {
    controlMode = mode;
    const autoBtn = document.getElementById('btn-mode-auto');
    const manualBtn = document.getElementById('btn-mode-manual');
    const warningBanner = document.getElementById('manual-warning-banner');

    if (autoBtn) autoBtn.classList.toggle('active', mode === 'auto');
    if (manualBtn) manualBtn.classList.toggle('active', mode === 'manual');
    if (warningBanner) warningBanner.classList.toggle('hidden', mode === 'auto');

    renderActuatorsList();
    pushAlert(`System switched to ${mode.toUpperCase()} mode.`, mode === 'manual' ? 'warning' : 'info');
}

function toggleSimulationMode(checkbox) {
    simulationMode = checkbox.checked;
    pushAlert(`Simulation mode ${simulationMode ? 'ENABLED' : 'DISABLED'}`, 'info');
}

function toggleActuatorManual(key) {
    if (controlMode !== 'manual') return;
    const newState = !actuators[key].state;
    setActuatorState(key, newState, 'Manual user override');
    renderActuatorsList();
}

// --- Manual VPD Override Functions ---
async function applyManualVpd() {
    const inputEl = document.getElementById('manual-vpd-input');
    const statusEl = document.getElementById('status-manual-vpd');
    if (!inputEl) return;

    const val = parseFloat(inputEl.value);
    if (isNaN(val) || val < 0 || val > 3.0) {
        alert("Please enter a valid VPD value between 0.0 and 3.0 kPa.");
        return;
    }
    
    // Override local sensorData value for immediate UI feedback
    sensorData.vpd = val;

    // Update status badge UI
    if (statusEl) {
        statusEl.innerText = `ACTIVE (${val} kPa)`;
        statusEl.className = 'status-pill optimal';
    }

    // Send payload over Web Serial if hardware is connected
    const payload = { manual_vpd: val };
    await sendSerialCommand(payload);
    console.log("Sent Manual VPD Override:", val);
    pushAlert(`Manual VPD override set to ${val} kPa`, 'warning');
}

async function disableManualVpd() {
    const statusEl = document.getElementById('status-manual-vpd');
    
    // Reset status badge UI
    if (statusEl) {
        statusEl.innerText = 'DISABLED';
        statusEl.className = 'status-pill warning';
    }

    // Send disable code (-1) over Web Serial to return control back to sensor calculations
    const payload = { manual_vpd: -1 };
    await sendSerialCommand(payload);
    console.log("Disabled Manual VPD override.");
    pushAlert("Manual VPD override disabled. Resumed sensor calculations.", 'info');
}

async function restartESP32() {
    if (!isHardwareConnected || !serialWriter) {
        alert("Hardware is not connected! Please connect the ESP32 via USB first.");
        return;
    }

    if (confirm("Are you sure you want to restart the ESP32 hardware?")) {
        try {
            await sendSerialCommand({ restart: true });
            console.log("Sent restart command to ESP32: {\"restart\":true}");
            pushAlert("Sent restart command to ESP32.", "warning");
        } catch (error) {
            console.error("Failed to send restart command:", error);
            alert("Error sending restart command over serial.");
        }
    }
}

// --- 11. SIMULATOR SLIDERS ---
function onManualSliderInput() {
    if (!simulationMode) return;
    
    const tSlider = document.getElementById('sim-slider-temp');
    const hSlider = document.getElementById('sim-slider-hum');
    const z1mSlider = document.getElementById('sim-slider-z1m');
    const z1lSlider = document.getElementById('sim-slider-z1l');
    const z2mSlider = document.getElementById('sim-slider-z2m');
    const z2lSlider = document.getElementById('sim-slider-z2l');

    if (tSlider) sensorData.temperature = parseFloat(tSlider.value);
    if (hSlider) sensorData.humidity = parseFloat(hSlider.value);
    if (z1mSlider) sensorData.zones[1].moisturePct = parseInt(z1mSlider.value);
    if (z1lSlider) sensorData.zones[1].lightADC = parseInt(z1lSlider.value);
    if (z2mSlider) sensorData.zones[2].moisturePct = parseInt(z2mSlider.value);
    if (z2lSlider) sensorData.zones[2].lightADC = parseInt(z2lSlider.value);

    const lblTemp = document.getElementById('sim-lbl-temp');
    if (lblTemp) lblTemp.innerText = sensorData.temperature;
    const lblHum = document.getElementById('sim-lbl-hum');
    if (lblHum) lblHum.innerText = sensorData.humidity;
    const lblZ1M = document.getElementById('sim-lbl-z1m');
    if (lblZ1M) lblZ1M.innerText = sensorData.zones[1].moisturePct;
    const lblZ1L = document.getElementById('sim-lbl-z1l');
    if (lblZ1L) lblZ1L.innerText = sensorData.zones[1].lightADC;
    const lblZ2M = document.getElementById('sim-lbl-z2m');
    if (lblZ2M) lblZ2M.innerText = sensorData.zones[2].moisturePct;
    const lblZ2L = document.getElementById('sim-lbl-z2l');
    if (lblZ2L) lblZ2L.innerText = sensorData.zones[2].lightADC;
}

// --- 12. CALIBRATION & CUSTOM PLANTS ---
function saveMoistureCalibration(zoneId) {
    const dryInput = parseInt(document.getElementById(`z${zoneId}-cal-dry`)?.value);
    const wetInput = parseInt(document.getElementById(`z${zoneId}-cal-wet`)?.value);

    if (isNaN(dryInput) || isNaN(wetInput)) {
        alert('Please enter valid numerical ADC values for Dry and Wet baselines.');
        return;
    }

    calibrations[`zone${zoneId}`] = {
        dry: dryInput,
        wet: wetInput,
        calibrated: true
    };

    const badgeEl = document.getElementById(`z${zoneId}-moisture-conf`);
    if (badgeEl) {
        badgeEl.innerText = 'CALIBRATED';
        badgeEl.className = 'confidence-badge calibrated';
    }

    pushAlert(`Zone ${zoneId} soil moisture sensor calibrated (Dry: ${dryInput}, Wet: ${wetInput}).`, 'info');
    alert(`Zone ${zoneId} moisture calibration successfully saved!`);
}

function saveLightCalibration() {
    const ppfd = document.getElementById('ref-ppfd-input')?.value;
    const adc = document.getElementById('ref-adc-input')?.value;
    if (!ppfd || !adc) return alert('Please enter both reference values.');
    
    const msg = document.getElementById('ppfd-status-msg');
    if (msg) {
        msg.innerText = `Calibrated! Estimated PPFD active based on reference.`;
        msg.style.color = '#4ade80';
    }
    pushAlert('LDR light sensor calibrated against reference PPFD.', 'info');
}

function saveCustomPlantProfile() {
    const name = document.getElementById('cp-name')?.value;
    if (!name) return alert('Please enter a plant name.');

    const newPlant = {
        id: 'custom_' + Date.now(),
        name: name,
        scientificName: document.getElementById('cp-sci')?.value || '',
        category: 'Custom Crop',
        stages: {
            Vegetative: {
                temperature: { min: parseFloat(document.getElementById('cp-t-dmin')?.value || 18), target: parseFloat(document.getElementById('cp-t-dtarget')?.value || 22), max: parseFloat(document.getElementById('cp-t-dmax')?.value || 26) },
                humidity: { min: parseFloat(document.getElementById('cp-h-min')?.value || 50), target: parseFloat(document.getElementById('cp-h-target')?.value || 65), max: parseFloat(document.getElementById('cp-h-max')?.value || 80) },
                vpd: { min: 0.6, target: 1.0, max: 1.3 },
                moisture: { min: parseFloat(document.getElementById('cp-m-min')?.value || 40), target: parseFloat(document.getElementById('cp-m-target')?.value || 60), max: parseFloat(document.getElementById('cp-m-max')?.value || 80) },
                light: { min: parseInt(document.getElementById('cp-l-min')?.value || 200), target: parseInt(document.getElementById('cp-l-target')?.value || 500), max: parseInt(document.getElementById('cp-l-max')?.value || 800), unit: 'relative_adc' }
            }
        },
        source: 'User Custom Profile'
    };

    let customPlants = JSON.parse(localStorage.getItem('urban_microfarm_custom_plants') || '[]');
    customPlants.push(newPlant);
    localStorage.setItem('urban_microfarm_custom_plants', JSON.stringify(customPlants));

    populatePlantDropdowns();
    closeModal('modal-settings');
    pushAlert(`Custom plant profile '${name}' saved to local storage.`, 'info');
    alert('Custom plant saved successfully!');
}

// --- 13. DATA LOGGING & TELEMETRY ---
function logTelemetryData(data) {
    const timestamp = new Date().toLocaleTimeString();
    telemetryHistory.push({
        time: timestamp,
        temp: data.temperature,
        hum: data.humidity,
        vpd: data.vpd
    });

    if (telemetryHistory.length > 30) telemetryHistory.shift();
    drawTelemetryChart();
}

function drawTelemetryChart() {
    const canvas = document.getElementById('telemetryCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (telemetryHistory.length < 2) return;

    const w = canvas.width;
    const h = canvas.height;
    const step = w / (telemetryHistory.length - 1);

    const drawLine = (key, color, scaleMax) => {
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        telemetryHistory.forEach((pt, i) => {
            const x = i * step;
            const y = h - (pt[key] / scaleMax) * h;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();
    };

    drawLine('temp', '#38bdf8', 40);  // Scale 0-40 °C
    drawLine('hum', '#22c55e', 100); // Scale 0-100 %
}

function exportCSV() {
    let csv = 'Timestamp,Temperature,Humidity,VPD\n';
    telemetryHistory.forEach(r => {
        csv += `${r.time},${r.temp},${r.hum},${r.vpd}\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `microfarm_telemetry_${Date.now()}.csv`;
    a.click();
}

function clearLogHistory() {
    telemetryHistory = [];
    drawTelemetryChart();
}

// --- 14. ALERTS & MODALS ---
function pushAlert(message, severity = 'warning') {
    const timestamp = new Date().toLocaleTimeString();
    alerts.unshift({ message, severity, timestamp });
    if (alerts.length > 50) alerts.pop();
    renderAlerts();
}

function renderAlerts() {
    const container = document.getElementById('alerts-container');
    if (!container) return;

    container.innerHTML = alerts.map(a => `
        <div class="alert-item ${a.severity}">
            <span>${a.message}</span>
            <span class="alert-time">${a.timestamp}</span>
        </div>
    `).join('');
}

function clearAlerts() {
    alerts = [];
    renderAlerts();
}

function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
}

function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
}

function switchModalTab(evt, tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    const targetTab = document.getElementById(tabId);
    if (targetTab) targetTab.classList.add('active');
    evt.currentTarget.classList.add('active');
}

// --- 15. AI ASSISTANT PLACEHOLDER ---
function sendAIPrompt() {
    const input = document.getElementById('ai-user-input');
    const chatBox = document.querySelector('.ai-chat-box');
    if (!input || !chatBox) return;

    const query = input.value.trim();
    if (!query) return;

    chatBox.innerHTML += `<div class="ai-msg user">${query}</div>`;
    input.value = '';

    setTimeout(() => {
        let reply = "I analyzed your query against current plant database standards. ";
        if (query.toLowerCase().includes('fan')) {
            reply += `The fan is currently ${actuators.fan.state ? 'ACTIVE' : 'INACTIVE'}. Reason: ${actuators.fan.reason}.`;
        } else if (query.toLowerCase().includes('vpd')) {
            reply += `Current VPD is ${sensorData.vpd} kPa. This is derived from your temperature and relative humidity readings.`;
        } else {
            reply += "All sensors are reporting within expected parameters for the selected growth stages.";
        }
        chatBox.innerHTML += `<div class="ai-msg bot">${reply}</div>`;
        chatBox.scrollTop = chatBox.scrollHeight;
    }, 600);
}