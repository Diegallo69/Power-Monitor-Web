/* ============================================================
   Smart Energy Contact — app.js
   ============================================================ */

// ------------------------------------------------------------------
// Estado global
// ------------------------------------------------------------------
let client    = null;
let connected = false;
let relayOn   = null; // Estado real desconocido hasta recibir confirmación del hardware
let powerChartRange = 'hour';
let consumptionChartRange = 'day';
let powerChartRangeOffset = 0;
let consumptionChartRangeOffset = 0;

let trianglePa  = 0;
let trianglePap = 0;
let trianglePr  = 0;

let powerChart = null;
const powerChartLabels = new Array(60).fill('');
const powerChartData   = new Array(60).fill(null);
let powerChartFillCount = 0; // cuántos puntos reales han llegado desde que arrancó

let consumptionChart = null;
const consumptionChartLabels = [];
const consumptionChartData = [];

let pendingConsumptionKwh = 0;
let pendingWaveformMode = 'manual'; // 'manual' | 'silent' | 'auto'
let lastConsumptionSaveTime = Date.now();
let lastTelemetrySaveMs = 0;
let telemetryAccumulator = {
  count: 0, sumV: 0, sumI: 0, sumPa: 0, sumPap: 0, sumPr: 0, sumFp: 0, sumThd: 0, faultFlagsOr: 0
};

let latestAlertTimeout = null;
let lastDisplayedFaultFlags = 0;

// Registro local de alertas en memoria (respaldo si Supabase no está disponible)
// Cada entrada: { time: string, label: string, severity: string }
const localAlertLog = [];

let harmonicChart = null;
const harmonicChartLabels = [];
const harmonicChartData = [];
let lastHarmonicThd = null;
let waveformChart = null;

const HARMONICS_REQUEST_TOPIC = 'smartcontact/contacto_01/control/armonicos/request';
const HARMONICS_COUNT = 20;

const WAVEFORM_REQUEST_TOPIC = 'smartcontact/contacto_01/control/waveform/request';

// Formato binario de forma de onda
const WAVEFORM_HEADER_SIZE = 24;
const WAVEFORM_CHANNELS_EXPECTED = 2;
const WAVEFORM_FORMAT_I16_SCALED = 1;

const VOLTAGE_SCALE = 100.0;
const CURRENT_SCALE = 1000.0;

const waveformSequences = new Map();

const SUPABASE_URL = 'https://xedqybcdrkknidhajtcn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhlZHF5YmNkcmtrbmlkaGFqdGNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM4MjAxOTgsImV4cCI6MjA5OTM5NjE5OH0.xIOevKOa0o4mdEl5YKKyzuaA-hwwHVwz6DfBL8os22c';

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function testDatabaseConnection() {
  try {
    const { data, error } = await db
      .from('telemetry')
      .select('id, created_at')
      .limit(1);

    if (error) {
      log(`Error conectando a Supabase: ${error.message}`, 'error');
      return;
    }

    log('Conexión a Supabase correcta.', 'success');
  } catch (e) {
    log(`Error Supabase: ${e.message}`, 'error');
  }
}


// Acumulador de energía (kWh)
let kwhTotal      = 0;       // kWh acumulados en sesión
let kwhStartTime  = null;    // timestamp de inicio de sesión
let lastPowerW    = 0;       // última potencia activa recibida (W)
let kwhTimerInterval = null;
let lastFaultFlags = 0;

let dataWatchdog = null;

let periodStartTime = null;
let periodStartKwh = 0;

// Límites para las barras de progreso
const LIMITS = { v: 250, i: 10 };

// ------------------------------------------------------------------
// Registro dinámico de dispositivos detectados
// Se puebla automáticamente al recibir telemetría de cualquier ESP32.
// El dashboard extrae el device ID del tópico y lo guarda aquí.
// Así publishToAllDevices() sabe a cuántos y cuáles enviar.
// ------------------------------------------------------------------
const knownDevices = new Set(['contacto_01']); // seed: el dispositivo hardcodeado

function registerDeviceFromTopic(topic) {
  // Los tópicos siguen el patrón: smartcontact/<device_id>/...
  const parts = topic.split('/');
  if (parts.length >= 2 && parts[0] === 'smartcontact') {
    const deviceId = parts[1];
    if (deviceId && !knownDevices.has(deviceId)) {
      knownDevices.add(deviceId);
      log(`✔ Nuevo dispositivo detectado: ${deviceId} (total: ${knownDevices.size})`, 'success');
    }
  }
}

// Publica un mensaje en el tópico de control de CADA dispositivo conocido.
// Usa el mismo patrón de Paho que publishMessage (que sí funciona con toggleRelay).
function publishToAllDevices(controlPath, payload) {
  if (!connected || !client) {
    log('Error: No conectado. No se puede enviar comando.', 'error');
    return;
  }
  const payloadStr = payload.toString();
  knownDevices.forEach(deviceId => {
    const topic = `smartcontact/${deviceId}/${controlPath}`;
    const msg = new Paho.MQTT.Message(payloadStr);
    msg.destinationName = topic;
    try {
      client.send(msg);
      log(`▸ [${topic}] → ${payloadStr}`, 'success');
    } catch (e) {
      log(`Error enviando a ${topic}: ${e.message}`, 'error');
    }
  });
}

const FAULTS = {
  FAULT_OVERCURRENT: {
    bit: 0,
    label: 'Sobrecorriente',
    severity: 'error'
  },
  FAULT_OVERVOLTAGE: {
    bit: 1,
    label: 'Sobrevoltaje',
    severity: 'error'
  },
  FAULT_UNDERVOLTAGE: {
    bit: 2,
    label: 'Bajo voltaje',
    severity: 'warn'
  },
  FAULT_OVERPOWER: {
    bit: 3,
    label: 'Sobrecarga de potencia',
    severity: 'error'
  },
  FAULT_FREQUENCY_OUT_OF_RANGE: {
    bit: 4,
    label: 'Frecuencia fuera de rango',
    severity: 'warn'
  },
  FAULT_HIGH_THD: {
    bit: 5,
    label: 'THD elevado',
    severity: 'warn'
  },
  FAULT_POWER_FACTOR_TOO_LOW: {
    bit: 6,
    label: 'Factor de potencia bajo',
    severity: 'warn'
  },
  FAULT_NO_VOLTAGE: {
    bit: 7,
    label: 'Sin voltaje detectado',
    severity: 'error'
  },
  FAULT_NO_LOAD: {
    bit: 8,
    label: 'Sin corriente cuando se esperaba carga',
    severity: 'warn'
  },
  FAULT_CURRENT_WHEN_RELAY_OPEN: {
    bit: 9,
    label: 'Corriente detectada con relé abierto',
    severity: 'error'
  },
  FAULT_ADC_SATURATION: {
    bit: 10,
    label: 'Saturación del ADC',
    severity: 'error'
  },
  FAULT_ADC_DISCONNECTED: {
    bit: 11,
    label: 'ADC desconectado',
    severity: 'error'
  },
  FAULT_ZERO_CROSS_MISSING: {
    bit: 12,
    label: 'Cruce por cero ausente',
    severity: 'error'
  },
  FAULT_ZERO_CROSS_STUCK: {
    bit: 13,
    label: 'Cruce por cero bloqueado',
    severity: 'error'
  },
  FAULT_RELAY_WELDED: {
    bit: 14,
    label: 'Relé soldado',
    severity: 'error'
  },
  FAULT_RELAY_FAILED_TO_CLOSE: {
    bit: 15,
    label: 'Relé no cerró',
    severity: 'error'
  },
  FAULT_RELAY_FAILED_TO_OPEN: {
    bit: 16,
    label: 'Relé no abrió',
    severity: 'error'
  },
  FAULT_HIGH_POWER: {
    bit: 17,
    label: 'Potencia elevada',
    severity: 'warn'
  }
};

const CFE_TARIFFS = {
  '1': {
    name: 'CFE Tarifa 1',
    seasonStartMonth: 5, seasonEndMonth: 10,
    verano: { blocks: [
      { label: 'Básico', limitKwh: 75, price: 1.125 },
      { label: 'Intermedio', limitKwh: 65, price: 1.369 },
      { label: 'Excedente', limitKwh: Infinity, price: 4.004 }
    ]},
    invierno: { blocks: [
      { label: 'Básico', limitKwh: 75, price: 1.148 },
      { label: 'Intermedio', limitKwh: 65, price: 1.393 },
      { label: 'Excedente', limitKwh: Infinity, price: 4.08 }
    ]},
    dacLimitKwhPerMonth: 250
  },
  '1A': {
    name: 'CFE Tarifa 1A',
    seasonStartMonth: 5, seasonEndMonth: 10,
    verano: { blocks: [
      { label: 'Básico', limitKwh: 100, price: 1.007 },
      { label: 'Intermedio', limitKwh: 50, price: 1.167 },
      { label: 'Excedente', limitKwh: Infinity, price: 4.004 }
    ]},
    invierno: { blocks: [
      { label: 'Básico', limitKwh: 75, price: 1.148 },
      { label: 'Intermedio', limitKwh: 75, price: 1.393 },
      { label: 'Excedente', limitKwh: Infinity, price: 4.08 }
    ]},
    dacLimitKwhPerMonth: 300
  },
  '1B': {
    name: 'CFE Tarifa 1B',
    seasonStartMonth: 5, seasonEndMonth: 10,
    verano: { blocks: [
      { label: 'Básico', limitKwh: 125, price: 1.007 },
      { label: 'Intermedio', limitKwh: 100, price: 1.167 },
      { label: 'Excedente', limitKwh: Infinity, price: 4.004 }
    ]},
    invierno: { blocks: [
      { label: 'Básico', limitKwh: 75, price: 1.148 },
      { label: 'Intermedio', limitKwh: 100, price: 1.393 },
      { label: 'Excedente', limitKwh: Infinity, price: 4.08 }
    ]},
    dacLimitKwhPerMonth: 400
  },
  '1C': {
    name: 'CFE Tarifa 1C',
    seasonStartMonth: 5, seasonEndMonth: 10,
    verano: { blocks: [
      { label: 'Básico', limitKwh: 150, price: 1.007 },
      { label: 'Intermedio bajo', limitKwh: 150, price: 1.167 },
      { label: 'Intermedio alto', limitKwh: 150, price: 1.500 },
      { label: 'Excedente', limitKwh: Infinity, price: 4.004 }
    ]},
    invierno: { blocks: [
      { label: 'Básico', limitKwh: 75, price: 1.148 },
      { label: 'Intermedio', limitKwh: 100, price: 1.393 },
      { label: 'Excedente', limitKwh: Infinity, price: 4.08 }
    ]},
    dacLimitKwhPerMonth: 850
  },
  '1D': {
    name: 'CFE Tarifa 1D',
    seasonStartMonth: 5, seasonEndMonth: 10,
    verano: { blocks: [
      { label: 'Básico', limitKwh: 175, price: 1.007 },
      { label: 'Intermedio bajo', limitKwh: 225, price: 1.167 },
      { label: 'Intermedio alto', limitKwh: 200, price: 1.500 },
      { label: 'Excedente', limitKwh: Infinity, price: 4.004 }
    ]},
    invierno: { blocks: [
      { label: 'Básico', limitKwh: 75, price: 1.148 },
      { label: 'Intermedio', limitKwh: 125, price: 1.393 },
      { label: 'Excedente', limitKwh: Infinity, price: 4.08 }
    ]},
    dacLimitKwhPerMonth: 1000
  },
  '1E': {
    name: 'CFE Tarifa 1E - 2026',
    seasonStartMonth: 4, seasonEndMonth: 10,
    verano: { blocks: [
      { label: 'Básico', limitKwh: 300, price: 0.842 },
      { label: 'Intermedio bajo', limitKwh: 450, price: 1.042 },
      { label: 'Intermedio alto', limitKwh: 150, price: 1.352 },
      { label: 'Excedente', limitKwh: Infinity, price: 4.004 }
    ]},
    invierno: { blocks: [
      { label: 'Básico', limitKwh: 75, price: 1.148 },
      { label: 'Intermedio', limitKwh: 125, price: 1.393 },
      { label: 'Excedente', limitKwh: Infinity, price: 4.08 }
    ]},
    dacLimitKwhPerMonth: 2000
  },
  '1F': {
    name: 'CFE Tarifa 1F - 2026',
    seasonStartMonth: 4, seasonEndMonth: 10,
    verano: { blocks: [
      { label: 'Básico', limitKwh: 300, price: 0.842 },
      { label: 'Intermedio bajo', limitKwh: 900, price: 1.042 },
      { label: 'Intermedio alto', limitKwh: 1300, price: 2.534 },
      { label: 'Excedente', limitKwh: Infinity, price: 4.004 }
    ]},
    invierno: { blocks: [
      { label: 'Básico', limitKwh: 75, price: 1.148 },
      { label: 'Intermedio', limitKwh: 125, price: 1.393 },
      { label: 'Excedente', limitKwh: Infinity, price: 4.08 }
    ]},
    dacLimitKwhPerMonth: 2500
  }
};

// ------------------------------------------------------------------
// Tarifas CFE y componente de select personalizado (dropdown reutilizable)
// ------------------------------------------------------------------
let selectedTariffCode = localStorage.getItem('selectedTariffCode') || '1';

function getCurrentSeason(tariff) {
  const month = new Date().getMonth() + 1; // 1-12
  return (month >= tariff.seasonStartMonth && month <= tariff.seasonEndMonth) ? 'verano' : 'invierno';
}

window.onTariffChange = function (code) {
  if (!CFE_TARIFFS[code]) return;
  selectedTariffCode = code;
  localStorage.setItem('selectedTariffCode', code);
  updateEnergyCost();
  log(`Tarifa cambiada a ${CFE_TARIFFS[code].name}`, 'warn');
};

function createCustomSelect(rootId, onSelect) {
  const root = document.getElementById(rootId);
  if (!root) return null;

  const trigger = root.querySelector('.custom-select-trigger');
  const label   = root.querySelector('.custom-select-label');
  const items   = Array.from(root.querySelectorAll('.custom-select-options li'));

  function close() { root.classList.remove('open'); }
  function open() {
    document.querySelectorAll('.custom-select.open').forEach(el => {
      if (el !== root) el.classList.remove('open');
    });
    root.classList.add('open');
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    root.classList.contains('open') ? close() : open();
  });

  items.forEach(item => {
    item.addEventListener('click', () => {
      items.forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
      label.textContent = item.textContent;
      close();
      onSelect(item.dataset.value);
    });
  });

  document.addEventListener('click', (e) => {
    if (!root.contains(e.target)) close();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  return {
    setValue(value) {
      const match = items.find(i => i.dataset.value === value);
      if (!match) return;
      items.forEach(i => i.classList.remove('selected'));
      match.classList.add('selected');
      label.textContent = match.textContent;
    }
  };
}

let tariffSelectCtrl = null;
let periodSelectCtrl = null;

// ------------------------------------------------------------------
// Detección y clasificación de fallas del dispositivo
// ------------------------------------------------------------------
function getActiveFaults(faultFlags) {
  const flags = Number(faultFlags);

  if (!Number.isFinite(flags) || flags === 0) {
    return [];
  }

  const activeFaults = [];

  Object.entries(FAULTS).forEach(([code, info]) => {
    const mask = 1 << info.bit;

    if ((flags & mask) !== 0) {
      activeFaults.push({
        code,
        label: info.label,
        severity: info.severity
      });
    }
  });

  return activeFaults;
}

// ------------------------------------------------------------------
// Guardado de telemetría en Supabase (con promediado por ventana)
// ------------------------------------------------------------------
async function saveTelemetryToDatabase(d) {
  try {
    const { error } = await db
      .from('telemetry')
      .insert({
        voltage: d.v ?? null,
        current: d.i ?? null,
        active_power: d.p_activa ?? null,
        apparent_power: d.p_aparente ?? null,
        reactive_power: d.p_reactiva ?? null,
        power_factor: d.fp ?? null,
        thd: d.thd ?? null,
        fault_flags: d.fault_flags ?? null
      });

    if (error) {
      log(`Error guardando telemetría DB: ${error.message}`, 'error');
      return;
    }

    log('Telemetría guardada en Supabase.', 'success');
  } catch (e) {
    log(`Error DB telemetría: ${e.message}`, 'error');
  }
}

function accumulateTelemetry(d) {
  telemetryAccumulator.count++;
  if (d.v          !== undefined) telemetryAccumulator.sumV   += Number(d.v);
  if (d.i          !== undefined) telemetryAccumulator.sumI   += Number(d.i);
  if (d.p_activa   !== undefined) telemetryAccumulator.sumPa  += Number(d.p_activa);
  if (d.p_aparente !== undefined) telemetryAccumulator.sumPap += Number(d.p_aparente);
  if (d.p_reactiva !== undefined) telemetryAccumulator.sumPr  += Number(d.p_reactiva);
  if (d.fp         !== undefined) telemetryAccumulator.sumFp  += Number(d.fp);
  if (d.thd        !== undefined) telemetryAccumulator.sumThd += Number(d.thd);
  if (d.fault_flags !== undefined) telemetryAccumulator.faultFlagsOr |= Number(d.fault_flags);
}

function flushTelemetryAverage() {
  const n = telemetryAccumulator.count;
  if (n === 0) return;

  saveTelemetryToDatabase({
    v:          telemetryAccumulator.sumV   / n,
    i:          telemetryAccumulator.sumI   / n,
    p_activa:   telemetryAccumulator.sumPa  / n,
    p_aparente: telemetryAccumulator.sumPap / n,
    p_reactiva: telemetryAccumulator.sumPr  / n,
    fp:         telemetryAccumulator.sumFp  / n,
    thd:        telemetryAccumulator.sumThd / n,
    fault_flags: telemetryAccumulator.faultFlagsOr, // si hubo alguna falla en la ventana, queda registrada
  });

  telemetryAccumulator = { count: 0, sumV: 0, sumI: 0, sumPa: 0, sumPap: 0, sumPr: 0, sumFp: 0, sumThd: 0, faultFlagsOr: 0 };
}

// ------------------------------------------------------------------
// Barra de "última alerta" (junto al botón Conectar)
// ------------------------------------------------------------------
function showLatestAlert(faultFlags) {
  const alertBox = $('latestAlert');
  const alertText = $('latestAlertText');

  if (!alertBox || !alertText) return;

  const activeFaults = getActiveFaults(faultFlags);

  if (activeFaults.length === 0) {
    scheduleHideLatestAlert();
    return;
  }

  // Mientras la ESP32 siga mandando alerta, se cancela el ocultamiento
  if (latestAlertTimeout) {
    clearTimeout(latestAlertTimeout);
    latestAlertTimeout = null;
  }

  // Priorizar errores sobre warnings
  const selectedFault =
    activeFaults.find(fault => fault.severity === 'error') || activeFaults[0];

  const extraCount = activeFaults.length - 1;
  const extraText = extraCount > 0 ? ` +${extraCount}` : '';

  alertText.textContent = `${selectedFault.label}${extraText}`;

  alertBox.classList.remove('hidden', 'warn', 'error');
  alertBox.classList.add(selectedFault.severity === 'error' ? 'error' : 'warn');

  lastDisplayedFaultFlags = Number(faultFlags);
}

function scheduleHideLatestAlert() {
  const alertBox = $('latestAlert');
  const alertText = $('latestAlertText');

  if (!alertBox || !alertText) return;

  if (latestAlertTimeout) {
    clearTimeout(latestAlertTimeout);
  }

  latestAlertTimeout = setTimeout(() => {
    alertBox.classList.add('hidden');
    alertText.textContent = '—';
    lastDisplayedFaultFlags = 0;
  }, 5000);
}

// ------------------------------------------------------------------
// Modal de alertas
// ------------------------------------------------------------------
let alertModalQueue = [];
let alertModalVisible = false;

function showAlertModal(faults) {
  // faults: array de { label, severity }
  if (!faults || faults.length === 0) return;

  // Encolar todas las fallas nuevas
  faults.forEach(f => alertModalQueue.push(f));

  if (!alertModalVisible) {
    _renderNextAlertModal();
  }
}

function _renderNextAlertModal() {
  if (alertModalQueue.length === 0) {
    alertModalVisible = false;
    return;
  }

  alertModalVisible = true;
  const fault = alertModalQueue.shift();

  // Crear overlay
  const overlay = document.createElement('div');
  overlay.id = 'alertModalOverlay';
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(0,0,0,0.65); backdrop-filter: blur(3px);
    display: flex; align-items: center; justify-content: center;
    animation: fadeInOverlay .15s ease;
  `;

  const isError = fault.severity === 'error';
  const accentColor = isError ? 'var(--accent-alert)' : 'var(--accent-warn)';
  const iconChar = isError ? '🚨' : '⚠️';

  const box = document.createElement('div');
  box.style.cssText = `
    background: var(--bg3);
    border: 2px solid ${accentColor};
    border-radius: 10px;
    padding: 28px 32px 24px;
    min-width: 320px; max-width: 480px;
    box-shadow: 0 0 32px color-mix(in srgb, ${accentColor} 33%, transparent);
    font-family: 'Exo 2', sans-serif;
    color: var(--text);
    text-align: center;
    animation: slideInModal .2s ease;
  `;

  const remaining = alertModalQueue.length;
  const moreText = remaining > 0 ? `<div style="margin-top:8px;font-size:12px;color:var(--text-dim)">+${remaining} alerta${remaining > 1 ? 's' : ''} pendiente${remaining > 1 ? 's' : ''}</div>` : '';

  box.innerHTML = `
    <div style="font-size:38px;margin-bottom:12px">${iconChar}</div>
    <div style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:${accentColor};margin-bottom:8px">
      ${isError ? 'ALERTA CRÍTICA' : 'ADVERTENCIA'}
    </div>
    <div style="font-size:18px;font-weight:600;margin-bottom:20px">${fault.label}</div>
    <div style="font-size:11px;color:var(--text-dim);margin-bottom:20px">${new Date().toLocaleString('es-MX')}</div>
    ${moreText}
    <button id="alertModalCloseBtn" style="
      margin-top:18px;
      background:color-mix(in srgb, ${accentColor} 13%, transparent); border:1px solid ${accentColor};
      color:${accentColor}; border-radius:6px; padding:8px 28px;
      font-size:13px; letter-spacing:1px; cursor:pointer;
      font-family:inherit; text-transform:uppercase;
    ">Aceptar</button>
  `;

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const closeModal = () => {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    // Si hay más en cola, mostrar la siguiente con pequeño delay
    if (alertModalQueue.length > 0) {
      setTimeout(_renderNextAlertModal, 300);
    } else {
      alertModalVisible = false;
    }
  };

  document.getElementById('alertModalCloseBtn').addEventListener('click', closeModal);
  // Todos los modales (error y warn) esperan click del usuario — sin auto-cierre
}

// Inyectar keyframes para la animación del modal (una sola vez)
(function injectModalStyles() {
  if (document.getElementById('alertModalStyles')) return;
  const style = document.createElement('style');
  style.id = 'alertModalStyles';
  style.textContent = `
    @keyframes fadeInOverlay { from { opacity:0 } to { opacity:1 } }
    @keyframes slideInModal  { from { transform:translateY(-20px); opacity:0 } to { transform:translateY(0); opacity:1 } }
  `;
  document.head.appendChild(style);
})();

// ------------------------------------------------------------------
// Referencias DOM
// ------------------------------------------------------------------
const $ = id => document.getElementById(id);

const els = {
  v:   $('val-v'),
  i:   $('val-i'),
  pa:  $('val-pa'),
  pap: $('val-pap'),
  pr:  $('val-pr'),
  fp:  $('val-fp'),
  thd: $('val-thd'),
  kwh: $('val-kwh'),
};

// ------------------------------------------------------------------
// Conectar / Desconectar
// ------------------------------------------------------------------
window.toggleConnection = function () {
  connected ? disconnect() : connect();
};

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function getStartTimeForRange(range) {
  const todayStart = startOfToday();

  if (range === 'hour') {
    return Date.now() - (60 * 60 * 1000);
  }

  if (range === 'day') {
    return todayStart;
  }

  if (range === 'week') {
    // Hoy + 6 días anteriores = 7 días exactos
    return todayStart - (6 * 24 * 60 * 60 * 1000);
  }

  if (range === 'bimester') {
    // 9 semanas exactas, no 10 buckets parciales
    return todayStart - (8 * 7 * 24 * 60 * 60 * 1000);
  }

  return Date.now() - (60 * 60 * 1000);
}

function updateHourNavClock() {
  if (powerChartRange !== 'hour') return;
  const labelEl = $('powerChartNavLabel');
  if (labelEl) labelEl.textContent = new Date().toLocaleTimeString('es-MX');
}

setInterval(updateHourNavClock, 1000);

function startOfWeekMonday(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 = domingo, 1 = lunes, ... 6 = sábado
  const diff = (day === 0 ? -6 : 1) - day; // días para retroceder hasta el lunes
  d.setDate(d.getDate() + diff);
  return d.getTime();
}

function getRangeBounds(range, offset = 0) {
  const todayStart = startOfToday();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const nowMs = Date.now();

  if (range === 'day') {
    if (offset === 0) return { start: todayStart, end: nowMs };
    const start = todayStart + offset * DAY_MS;
    return { start, end: start + DAY_MS };
  }

  if (range === 'week') {
    const currentWeekStart = startOfWeekMonday(nowMs);
    if (offset === 0) return { start: currentWeekStart, end: nowMs };
    const blockMs = 7 * DAY_MS;
    const start = currentWeekStart + offset * blockMs;
    return { start, end: start + blockMs };
  }

  // bimestre — bloques de 63 días anclados a hoy (sin cambios)
  const blockDays = 63;
  const blockMs = blockDays * DAY_MS;
  const currentBlockStart = todayStart - (blockDays - 1) * DAY_MS;
  if (offset === 0) return { start: currentBlockStart, end: nowMs };
  const start = currentBlockStart + offset * blockMs;
  return { start, end: start + blockMs };
}

function formatRangeLabel(range, start, end) {
  if (range === 'day') {
    return new Date(start).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  const startStr = new Date(start).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
  const endStr = new Date(end - 1).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
  return `${startStr} — ${endStr}`;
}

function handleDataTimeout() {
  log('⚠ Alerta: Se dejó de recibir telemetría. Reiniciando valores a 0.', 'warn');

  // 1. Mandar un objeto con puros ceros para actualizar las tarjetas y la gráfica
  updateDashboard({ 
    v: 0, i: 0, p_activa: 0, p_aparente: 0, p_reactiva: 0, fp: 0, thd: 0 
  });

  // Nota: Al mandar p_activa: 0, lastPowerW se vuelve 0, 
  // lo que hace que el contador de kWh se congele automáticamente.

  // 2. Apagar el relé visualmente por seguridad
  if (relayOn) {
    relayOn = false;
    saveConsumptionPeriod(); // Guardar el historial de consumo hasta este corte

    const btn  = $('onoffBtn');
    const text = $('onoffText');
    const hint = $('onoffHint');
    
    if (btn && text && hint) {
      btn.className  = 'onoff-btn onoff-off';
      text.textContent = 'OFF';
      hint.textContent = 'Sin conexión de datos';
    }
  }
}

function connect() {
  const host  = '53064f1f1cf946df990d74434c676994.s1.eu.hivemq.cloud';
  const port  = 8884;
  const topic = 'sec/datos';

  const clientId = 'sec_dashboard_' + Math.random().toString(16).slice(2, 8);
  log(`Conectando a ws://${host}:${port} …`, 'info');

  client = new Paho.MQTT.Client(host, port, clientId);
  client.onConnectionLost = onConnectionLost;
  // Paho 1.0.1 falla con mensajes binarios si se accede a payloadString.
  // Parcheamos onMessageArrived para interceptar el tópico waveform
  // y leer el ArrayBuffer interno ANTES de que Paho intente decodificar UTF-8.
  client.onMessageArrived = function(message) {
    try {
      if (message.destinationName.match(/^smartcontact\/.+\/telemetria\/waveform$/)) {
        _handleWaveformMessage(message);
        return;
      }
    } catch (e) {
      log(`Error interceptando waveform: ${e.message}`, 'error');
      return;
    }
    onMessageArrived(message);
  };

  client.connect({
    onSuccess:  () => onConnected(topic),
    onFailure:  (err) => onConnectFailed(err),
    useSSL:     true,
    userName:   'esp32_power_monitor',
    password:   'Power-Monitor69',
    timeout:    8,
    keepAliveInterval: 30,
  });
}

function disconnect() {
  if (dataWatchdog) { clearTimeout(dataWatchdog); dataWatchdog = null; }
  if (client && connected) client.disconnect();
  connected = false;
  setStatus(false);

  const btn = $('connectBtn');
  if (btn) {
    btn.textContent = 'Conectar';
    btn.classList.remove('disconnect');
  }

  setSystemOffline();
  log('Desconectado manualmente.', 'warn');
}

// ------------------------------------------------------------------
// Callbacks MQTT
// ------------------------------------------------------------------
function onConnected(topic) {
  connected = true;
  setStatus(true);
  log(`Conectado. Suscrito a "${topic}"`, 'success');

  // 1. Suscripción a la telemetría (la que el usuario pone en la interfaz)
  client.subscribe(topic, {
    onSuccess:  () => log(`✔ Suscripción a "${topic}" confirmada.`, 'success'),
    onFailure:  (err) => log(`Error suscripción: ${err.errorMessage}`, 'error'),    
  });

  client.subscribe('smartcontact/+/telemetria/estado', {
    onSuccess: () => log('✔ Suscripción a telemetría/estado (todos los dispositivos) confirmada.', 'success'),
    onFailure: err => log(`Error suscripción telemetría/estado: ${err.errorMessage}`, 'error'),
  });  

  // Suscripción a las alertas de todos los dispositivos
  client.subscribe('smartcontact/+/alertas');

  // Suscripción al estado físico del relé de todos los dispositivos
  client.subscribe('smartcontact/+/estado/rele');
  client.subscribe('smartcontact/+/telemetria/armonicos', {
    onSuccess: () => log(`✔ Suscripción a armónicos (todos los dispositivos) confirmada.`, 'success'),
    onFailure: err => log(`Error suscripción armónicos: ${err.errorMessage}`, 'error'),
  });

  client.subscribe('smartcontact/+/telemetria/waveform', {
    onSuccess: () => log(`✔ Suscripción a waveform (todos los dispositivos) confirmada.`, 'success'),
    onFailure: err => log(`Error suscripción waveform: ${err.errorMessage}`, 'error'),
  });

  const btn = $('connectBtn');
  btn.textContent = 'Desconectar';
  btn.classList.add('disconnect');

  setSystemOnline();
  updateEnergyCost();

  // Iniciar acumulador kWh
  if (!kwhStartTime) startKwhTimer();

  // Diagnóstico de carga automático (silencioso, sin graficar) — se le da
  // un respiro a las suscripciones MQTT antes de pedirlo.
  setTimeout(() => {
    requestDiagnosisWaveform();
  }, 1000);
}

function onConnectionLost(res) {
  connected = false;
  setStatus(false);
  if (res.errorCode !== 0) log(`Conexión perdida: ${res.errorMessage}`, 'error');
  const btn = $('connectBtn');
  btn.textContent = 'Conectar';
  btn.classList.remove('disconnect');
  
  setSystemOffline();
}

function onConnectFailed(err) {
  log(`No se pudo conectar: ${err.errorMessage}`, 'error');
}

function onMessageArrived(message) {
  const topic = message.destinationName;
  const raw = message.payloadString;
  const telemetriaTopic = 'sec/datos';

  // Registrar automáticamente cualquier dispositivo que publique bajo smartcontact/
  if (topic.startsWith('smartcontact/')) {
    registerDeviceFromTopic(topic);
  }

  // ============================================================
  // FLUJO A: Telemetría normal (Datos para tus gráficas)
  // ============================================================
  if (topic === telemetriaTopic || topic.match(/^smartcontact\/.+\/telemetria\/estado$/)) {
    log(`← ${raw}`, 'data');
    try {
      const d = JSON.parse(raw);
      updateDashboard(d);

      accumulateTelemetry(d);

      const nowMs = Date.now();
      if (nowMs - lastTelemetrySaveMs >= 300000) { // 5 minutos, como los medidores inteligentes de CFE
        lastTelemetrySaveMs = nowMs;
        flushTelemetryAverage();
      }
      $('lastUpdate').textContent = new Date().toLocaleTimeString('es-MX');

      // --- Watchdog Dinámico ---
      if (dataWatchdog) clearTimeout(dataWatchdog);
      
      // 1. Leer el tiempo de muestreo actual de la interfaz (en segundos)
      const tiempoMuestreoSegundos = parseInt($('sampleRate').value) || 1;
      
      // 2. Convertir a milisegundos y sumar el margen de tolerancia (2.5s)
      const toleranciaMs = 2500; 
      const timeoutDinamicoMs = (tiempoMuestreoSegundos * 1000) + toleranciaMs;
      
      // 3. Iniciar el temporizador
      dataWatchdog = setTimeout(handleDataTimeout, timeoutDinamicoMs);
      // ---------------------------------------------------

    } catch (e) {
      log(`JSON inválido: ${e.message}`, 'error');
    }
  }
  
  // ============================================================
  // FLUJO B: Alertas del ESP32 (Errores físicos detectados)
  // ============================================================
  else if (topic.match(/^smartcontact\/.+\/alertas$/)) {
    try {
      const payload = JSON.parse(raw);

      // El ESP32 manda: {timestamp, flags, active, severity, cleared}
      // timestamp: segundos Unix — lo convertimos a ms para Date()
      // active: bitmask de fallas activas en este momento
      // cleared: true si las fallas fueron resueltas

      const activeMask  = Number(payload.active  ?? payload.flags ?? 0);
      const timestampMs = Number(payload.timestamp ?? 0) * 1000;
      const cleared     = payload.cleared === true;

      // Construir fecha legible desde el timestamp del hardware
      // Si el timestamp es 0, inválido, o antes del año 2020, usar la fecha actual del navegador
      const MIN_VALID_TS_MS = new Date('2020-01-01').getTime();
      const fechaHardware = (timestampMs > MIN_VALID_TS_MS)
        ? new Date(timestampMs).toLocaleString('es-MX')
        : new Date().toLocaleString('es-MX');

      if (cleared || activeMask === 0) {
        log(`✔ Alertas resueltas (${fechaHardware})`, 'success');
        scheduleHideLatestAlert();
        return;
      }

      // Descomponer el bitmask en fallas individuales usando FAULTS
      const fallasActivas = Object.entries(FAULTS).filter(([, info]) => {
        return (activeMask & (1 << info.bit)) !== 0;
      });

      fallasActivas.forEach(([code, info]) => {
        // Mostrar en el log con nombre legible, no código
        log(`🚨 ALERTA [${fechaHardware}]: ${info.label}`, info.severity === 'error' ? 'error' : 'warn');

        // Corte de seguridad visual para fallas críticas
        if (info.severity === 'error' && (
          code === 'FAULT_OVERCURRENT' ||
          code === 'FAULT_OVERPOWER'   ||
          code === 'FAULT_RELAY_WELDED'
        )) {
          relayOn = false;
          const btn  = $('onoffBtn');
          const text = $('onoffText');
          const hint = $('onoffHint');
          if (btn && text && hint) {
            btn.className    = 'onoff-btn onoff-off';
            text.textContent = 'OFF';
            hint.textContent = 'Corte por seguridad';
          }
        }

        // Guardar en Supabase con timestamp real del hardware
        saveAlert({
          code,
          label:     info.label,
          severity:  info.severity,
          value:     activeMask,
          timestamp: fechaHardware
        });
      });

      // Mostrar la alerta más prioritaria junto al botón de conectar
      showLatestAlert(activeMask);

      // Abrir modal de notificación para cada falla activa
      // fallasActivas es [[code, info], ...] — mapear a { label, severity }
      showAlertModal(fallasActivas.map(([, info]) => ({ label: info.label, severity: info.severity })));

    } catch (e) {
      log(`Error procesando alerta: ${e.message}`, 'error');
    }
  } 
  
  // ============================================================
  // FLUJO C: Sincronización del botón físico del ESP32
  // ============================================================
  else if (topic.match(/^smartcontact\/.+\/estado\/rele$/)) {
    const estadoFisico = raw.trim().toUpperCase();
    
    const btn  = $('onoffBtn');
    const text = $('onoffText');
    const hint = $('onoffHint');

    if (estadoFisico === 'ON') {
      // Solo si estaba apagado iniciamos el cálculo de consumo
      if (!relayOn) {
        relayOn = true;
        periodStartTime = new Date().toLocaleString('es-MX');
        periodStartKwh = kwhTotal;
        setTimeout(() => {
          requestAutoWaveform();
        }, 1000);
        setTimeout(() => {
          requestHarmonics();
        }, 1500);
      }
      log('Sincronización: Relé encendido físicamente.', 'success');
      
      if (btn && text && hint) {
        btn.className  = 'onoff-btn onoff-on';
        text.textContent = 'ON';
        hint.textContent = 'Contacto energizado';
      }
    } else if (estadoFisico === 'OFF') {
      // Solo si estaba prendido cerramos el cálculo de consumo
      if (relayOn) {
        relayOn = false;
        saveConsumptionPeriod();
        showDiagnosisPlaceholder('Sin carga conectada — sin datos que analizar');
        clearWaveformAndHarmonicsCharts();
      }
      log('Sincronización: Relé apagado físicamente.', 'warn');
      
      if (btn && text && hint) {
        btn.className  = 'onoff-btn onoff-off';
        text.textContent = 'OFF';
        hint.textContent = 'Contacto apagado';
      }
    }
  }

  // ============================================================
  // FLUJO D: Armónicos THD en vivo
  // ============================================================
  else if (topic.match(/^smartcontact\/.+\/telemetria\/armonicos$/)) {
    log(`← Armónicos THD: ${raw}`, 'data');

    try {
      const payload = JSON.parse(raw);
      processHarmonicsPayload(payload);
    } catch (e) {
      log(`Error procesando armónicos: ${e.message}`, 'error');
    }
  }

  // FLUJO E: Forma de onda — manejado por _handleWaveformMessage antes de llegar aquí
  // (el dispatch ocurre en client.onMessageArrived para evitar que Paho procese
  //  el payload binario como UTF-8 y cierre la conexión)
  else if (topic.match(/^smartcontact\/.+\/telemetria\/waveform$/)) {
    // No debería llegar aquí; _handleWaveformMessage lo intercepta antes.
    log('Waveform llegó a onMessageArrived (inesperado).', 'warn');
  }
}

// ------------------------------------------------------------------
// Manejo seguro de mensajes binarios de forma de onda
// Paho 1.0.1 no soporta payloadBytes. Al acceder a payloadString en un
// mensaje binario puede lanzar una excepción interna que cierra la conexión.
// Esta función lee el buffer interno de Paho (_buffer o similar) directamente.
// ------------------------------------------------------------------
function _handleWaveformMessage(message) {
  let arrayBuffer = null;

  try {
    // Paho 1.0.1 almacena el payload como Uint8Array en message._buffer
    // o en message.payloadBytes dependiendo de la versión exacta.
    if (message._buffer instanceof Uint8Array) {
      arrayBuffer = message._buffer.buffer.slice(
        message._buffer.byteOffset,
        message._buffer.byteOffset + message._buffer.byteLength
      );
    } else if (message.payloadBytes instanceof Uint8Array) {
      arrayBuffer = message.payloadBytes.buffer.slice(
        message.payloadBytes.byteOffset,
        message.payloadBytes.byteOffset + message.payloadBytes.byteLength
      );
    } else {
      // Último recurso: leer byte a byte evitando el getter payloadString
      // Buscamos el Uint8Array interno recorriendo las propiedades del objeto
      let rawBuf = null;
      for (const key of Object.keys(message)) {
        const val = message[key];
        if (val instanceof Uint8Array && val.length > 0) {
          rawBuf = val;
          break;
        }
      }
      if (rawBuf) {
        arrayBuffer = rawBuf.buffer.slice(rawBuf.byteOffset, rawBuf.byteOffset + rawBuf.byteLength);
      } else {
        // Fallback final: charCodeAt (sólo funciona si Paho no lanzó excepción antes)
        const str = message.payloadString;
        const buf = new Uint8Array(str.length);
        for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i) & 0xFF;
        arrayBuffer = buf.buffer;
      }
    }
  } catch (e) {
    log(`Error leyendo buffer waveform: ${e.message}`, 'error');
    return;
  }

  if (!arrayBuffer || arrayBuffer.byteLength === 0) {
    log('Forma de onda inválida: payload vacío.', 'error');
    return;
  }

  try {
    const chunk = parseWaveformChunk(arrayBuffer);
    handleWaveformChunk(chunk);
  } catch (e) {
    log(`Error procesando chunk de forma de onda: ${e.message}`, 'error');
  }
}

window.requestWaveform = function () {
  if (!client || !connected) {
    log('No conectado. No se puede solicitar la gráfica de forma de onda.', 'error');
    return;
  }

  pendingWaveformMode = 'manual';

  const message = new Paho.MQTT.Message('1');
  message.destinationName = WAVEFORM_REQUEST_TOPIC;
  client.send(message);

  log(`→ Solicitud de gráfica enviada a "${WAVEFORM_REQUEST_TOPIC}"`, 'success');

  const statusEl = $('waveformStatus');
  if (statusEl) {
    statusEl.textContent = 'Solicitud enviada...';
  }
};

window.requestDiagnosisWaveform = function () {
  if (!client || !connected) return;

  pendingWaveformMode = 'silent';

  const message = new Paho.MQTT.Message('1');
  message.destinationName = WAVEFORM_REQUEST_TOPIC;
  client.send(message);

  log('→ Solicitud de forma de onda enviada para diagnóstico', 'info');
};

window.requestAutoWaveform = function () {
  if (!client || !connected) return;

  pendingWaveformMode = 'auto';

  const message = new Paho.MQTT.Message('1');
  message.destinationName = WAVEFORM_REQUEST_TOPIC;
  client.send(message);

  log('→ Solicitud de forma de onda enviada para gráfica y diagnóstico', 'info');
};

window.requestHarmonics = function () {
  if (!client || !connected) {
    log('No conectado. No se puede solicitar la gráfica de armónicos.', 'error');
    return;
  }

  const message = new Paho.MQTT.Message('1');
  message.destinationName = HARMONICS_REQUEST_TOPIC;
  client.send(message);

  log(`→ Solicitud de gráfica enviada a "${HARMONICS_REQUEST_TOPIC}"`, 'success');

  const statusEl = $('harmonicLastUpdate');
  if (statusEl) {
    statusEl.textContent = 'Solicitud enviada...';
  }
};

function initWaveformChart() {
  const canvas = $('waveformChart');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');

  waveformChart = new Chart(ctx, {
    type: 'line',
    plugins: [centeredXTitlePlugin],
    data: {
      datasets: [
        {
          label: 'Voltaje (V)',
          data: [],
          borderColor: rootStyles.getPropertyValue('--accent-v').trim(),
          backgroundColor: hexToRgba(rootStyles.getPropertyValue('--accent-v').trim(), 0.25),
          borderWidth: 2,
          tension: 0,
          pointRadius: 0,
          yAxisID: 'y'
        },
        {
          label: 'Corriente (A)',
          data: [],
          borderColor: rootStyles.getPropertyValue('--accent-i').trim(),
          backgroundColor: hexToRgba(rootStyles.getPropertyValue('--accent-i').trim(), 0.25),
          borderWidth: 2,
          tension: 0,
          pointRadius: 0,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: {
        mode: 'nearest',
        intersect: false
      },
      plugins: {
        centeredXTitle: { text: 'Tiempo (ms)' },
        legend: {
          labels: {
            color: '#e0e0e0',
            font: {
              family: 'Share Tech Mono'
            }
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              if (context.dataset.label.includes('Voltaje')) {
                return `${context.dataset.label}: ${context.parsed.y.toFixed(2)} V`;
              }

              return `${context.dataset.label}: ${context.parsed.y.toFixed(3)} A`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          title: {
            display: true,
            text: '',
            color: '#e0e0e0',
            font: {
              family: 'Share Tech Mono',
              size: 12
            }
          },
          ticks: {
            color: '#888888',
            maxTicksLimit: 10
          },
          grid: {
            color: '#2a2a2a'
          }
        },
        y: {
          type: 'linear',
          position: 'left',
          title: {
            display: true,
            text: 'Voltaje (V)',
            color: '#e0e0e0',
            font: {
              family: 'Share Tech Mono',
              size: 12
            }
          },
          ticks: {
            color: '#888888',
            callback: value => value + ' V'
          },
          grid: {
            color: '#2a2a2a'
          }
        },
        y1: {
          type: 'linear',
          position: 'right',
          title: {
            display: true,
            text: 'Corriente (A)',
            color: '#e0e0e0',
            font: {
              family: 'Share Tech Mono',
              size: 12
            }
          },
          ticks: {
            color: '#888888',
            callback: value => value.toFixed(2) + ' A'
          },
          grid: {
            drawOnChartArea: false
          }
        }
      }
    }
  });
}

function parseWaveformChunk(arrayBuffer) {
  if (arrayBuffer.byteLength < WAVEFORM_HEADER_SIZE) {
    throw new Error(`Chunk demasiado corto: ${arrayBuffer.byteLength} bytes`);
  }

  const view = new DataView(arrayBuffer);

  // Leer header con los tipos correctos según el struct del ESP32:
  // uint32 sequence_id  @ offset 0
  // uint64 timestamp_ms @ offset 4
  // uint16 chunk_index  @ offset 12
  // uint16 chunk_count  @ offset 14
  // uint16 sample_rate  @ offset 16
  // uint16 total_samples@ offset 18
  // uint16 samples_in_chunk @ offset 20
  // uint8  channels     @ offset 22
  // uint8  format       @ offset 23
  const sequenceId     = view.getUint32(0, true);
  const chunkIndex     = view.getUint16(12, true);
  const chunkCount     = view.getUint16(14, true);
  const sampleRateHz   = view.getUint16(16, true);
  const totalSamples   = view.getUint16(18, true);
  const samplesInChunk = view.getUint16(20, true);
  const channels       = view.getUint8(22);
  const format         = view.getUint8(23);

  if (channels !== WAVEFORM_CHANNELS_EXPECTED) {
    throw new Error(`Canales no soportados: ${channels}`);
  }

  if (format !== WAVEFORM_FORMAT_I16_SCALED) {
    throw new Error(`Formato de waveform no soportado: ${format}`);
  }

  const expectedBytes = WAVEFORM_HEADER_SIZE + samplesInChunk * channels * 2;
  if (arrayBuffer.byteLength < expectedBytes) {
    throw new Error(`Chunk incompleto: recibidos ${arrayBuffer.byteLength} bytes, esperados ${expectedBytes}`);
  }

  const voltage = new Array(samplesInChunk);
  const current = new Array(samplesInChunk);

  let offset = WAVEFORM_HEADER_SIZE;
  for (let i = 0; i < samplesInChunk; i++) {
    voltage[i] = view.getInt16(offset, true) / VOLTAGE_SCALE;
    offset += 2;
    current[i] = view.getInt16(offset, true) / CURRENT_SCALE;
    offset += 2;
  }

  return {
    sequenceId,
    chunkIndex,
    chunkCount,
    sampleRateHz,
    totalSamples,
    samplesInChunk,
    voltage,
    current
  };
}

function handleWaveformChunk(chunk) {
  let sequence = waveformSequences.get(chunk.sequenceId);

  if (!sequence) {
    sequence = {
      sequenceId:   chunk.sequenceId,
      chunkCount:   chunk.chunkCount,
      receivedCount: 0,
      sampleRateHz: chunk.sampleRateHz,
      totalSamples: chunk.totalSamples,
      chunks:       new Array(chunk.chunkCount)
    };
    waveformSequences.set(chunk.sequenceId, sequence);

    if (waveformSequences.size > 8) {
      const oldestKey = waveformSequences.keys().next().value;
      waveformSequences.delete(oldestKey);
    }
  }

  if (!sequence.chunks[chunk.chunkIndex]) {
    sequence.chunks[chunk.chunkIndex] = chunk;
    sequence.receivedCount++;
  }

  log(`Chunk waveform recibido seq=${chunk.sequenceId} ${chunk.chunkIndex + 1}/${chunk.chunkCount}`, 'data');

  if (sequence.receivedCount === sequence.chunkCount) {
    renderWaveformSequence(sequence, pendingWaveformMode);
    waveformSequences.delete(chunk.sequenceId);
    pendingWaveformMode = 'manual';
  }
}

function findRisingZeroCrossings(points) {
  const crossings = [];
  for (let i = 0; i < points.length - 1; i++) {
    const y0 = points[i].y, y1 = points[i + 1].y;
    if (y0 <= 0 && y1 > 0) {
      const t0 = points[i].x, t1 = points[i + 1].x;
      const frac = -y0 / (y1 - y0);
      crossings.push(t0 + frac * (t1 - t0));
    }
  }
  return crossings;
}

function averagePeriodMs(crossings) {
  if (crossings.length < 2) return null;
  let total = 0;
  for (let i = 1; i < crossings.length; i++) total += crossings[i] - crossings[i - 1];
  return total / (crossings.length - 1);
}

function matchCrossingDeltas(vCrossings, iCrossings) {
  const deltas = [];
  for (const vt of vCrossings) {
    let nearest = null;
    for (const it of iCrossings) {
      const diff = it - vt;
      if (nearest === null || Math.abs(diff) < Math.abs(nearest)) nearest = diff;
    }
    if (nearest !== null) deltas.push(nearest);
  }
  return deltas;
}

function analyzeLoadType(voltagePoints, currentPoints) {
  const typeEl  = $('diagnosis-type');
  const hintEl  = $('diagnosis-hint');
  const dtEl    = $('diagnosis-dt');
  const angleEl = $('diagnosis-angle');
  const tsEl    = $('diagnosis-timestamp');
  if (!typeEl) return;

  const vCrossings = findRisingZeroCrossings(voltagePoints);
  const iCrossings = findRisingZeroCrossings(currentPoints);

  if (vCrossings.length < 2 || iCrossings.length < 1) {
    typeEl.textContent = 'Datos insuficientes';
    typeEl.style.color = 'var(--text-dim)';
    hintEl.textContent = 'La captura fue muy corta o la corriente es demasiado baja para detectar el cruce por cero. Intenta de nuevo.';
    dtEl.textContent = '--- ms';
    angleEl.textContent = '---°';
    return;
  }

  const periodMs = averagePeriodMs(vCrossings);
  const deltas = matchCrossingDeltas(vCrossings, iCrossings);
  deltas.sort((a, b) => a - b);

  const mid = Math.floor(deltas.length / 2);
  const dtMedian = deltas.length % 2 !== 0
    ? deltas[mid]
    : (deltas[mid - 1] + deltas[mid]) / 2;

  const phaseDeg = (dtMedian / periodMs) * 360;
  const THRESHOLD_DEG = 5; // tolerancia de ruido para considerar "resistiva"

  let tipo, color, detalle;
  if (Math.abs(phaseDeg) < THRESHOLD_DEG) {
    tipo = 'Carga Resistiva';
    color = 'var(--text)';
    detalle = 'La corriente está prácticamente en fase con el voltaje.';
  } else if (phaseDeg > 0) {
    tipo = 'Carga Inductiva';
    color = 'var(--text)';
    detalle = 'La corriente va atrasada respecto al voltaje.';
  } else {
    tipo = 'Carga Capacitiva';
    color = 'var(--text)';
    detalle = 'La corriente va adelantada respecto al voltaje.';
  }

  typeEl.textContent = tipo;
  typeEl.style.color = color;
  hintEl.textContent = detalle;
  dtEl.textContent = Math.abs(dtMedian).toFixed(3) + ' ms';
  angleEl.textContent = phaseDeg.toFixed(1) + '°';
  tsEl.textContent = new Date().toLocaleTimeString('es-MX');
}

function renderWaveformSequence(sequence, mode = 'manual') {
  const voltagePoints = [];
  const currentPoints = [];

  let sampleIndex = 0;
  const dtMs = 1000.0 / sequence.sampleRateHz;

  for (let chunkIndex = 0; chunkIndex < sequence.chunkCount; chunkIndex++) {
    const chunk = sequence.chunks[chunkIndex];

    if (!chunk) {
      log(`No se puede renderizar seq=${sequence.sequenceId}; falta chunk ${chunkIndex}`, 'error');
      return;
    }

    for (let i = 0; i < chunk.samplesInChunk; i++) {
      const tMs = sampleIndex * dtMs;
      voltagePoints.push({ x: tMs, y: chunk.voltage[i] });
      currentPoints.push({ x: tMs, y: chunk.current[i] });
      sampleIndex++;
    }
  }

  if (mode !== 'silent') {
    waveformChart.data.datasets[0].data = voltagePoints;
    waveformChart.data.datasets[1].data = currentPoints;

    if (currentPoints.length > 0) {
      const rawMax = Math.max(...currentPoints.map(p => Math.abs(p.y)));
      const axisMax = Math.max(0.1, rawMax * 1.15);
      waveformChart.options.scales.y1.min = -axisMax;
      waveformChart.options.scales.y1.max =  axisMax;
    }

    waveformChart.update('none');

    const statusEl = $('waveformStatus');
    if (statusEl) {
      statusEl.textContent =
        `Captura completa · 60.00 Hz · Última actualización: ${new Date().toLocaleTimeString('es-MX')}`;
    }

    log(`Waveform renderizado: ${sampleIndex} muestras · seq=${sequence.sequenceId}`, 'success');
  }

  if (mode !== 'manual') {
    log(`Diagnóstico de carga ejecutado · seq=${sequence.sequenceId}`, 'info');
    analyzeLoadType(voltagePoints, currentPoints);
  }
}

// ------------------------------------------------------------------
// Persistencia en Supabase — alertas y periodos de consumo
// ------------------------------------------------------------------
async function saveAlert(alertData) {
  const record = {
    code:       alertData.code      || 'FAULT_UNKNOWN',
    label:      alertData.label     || 'Falla desconocida',
    severity:   alertData.severity  || 'warn',
    value:      alertData.value     ?? null,
    alert_time: alertData.timestamp ?? new Date().toLocaleString('es-MX')
  };

  // Siempre registrar en memoria primero — garantiza que aparezca en el historial
  // aunque Supabase falle o la columna no exista
  localAlertLog.unshift({ time: record.alert_time, label: record.label, severity: record.severity });
  if (localAlertLog.length > 200) localAlertLog.pop();   // máx. 200 entradas

  // Actualizar historial visible inmediatamente (sin esperar a la DB)
  renderPowerAlerts();

  try {
    const { error } = await db
      .from('alerts')
      .insert(record);

    if (error) {
      // Si la columna alert_time no existe en la tabla, reintentar sin ella
      if (error.message && error.message.includes('alert_time')) {
        const { error: error2 } = await db
          .from('alerts')
          .insert({ code: record.code, label: record.label, severity: record.severity, value: record.value });
        if (error2) {
          log(`Error guardando alerta DB: ${error2.message}`, 'error');
          return;
        }
      } else {
        log(`Error guardando alerta DB: ${error.message}`, 'error');
        return;
      }
    }

    log(`⚠ Alerta guardada: ${record.label}`, record.severity === 'error' ? 'error' : 'warn');
  } catch (e) {
    log(`Error DB alerta: ${e.message}`, 'error');
  }
}

function processFaultFlags(faultFlags) {
  const flags = Number(faultFlags);
  if (!Number.isFinite(flags)) return;

  // Mostrar alerta activa junto al botón de conectar
  showLatestAlert(flags);

  // Guardar en historial solo fallas nuevas
  const newFaults = flags & ~lastFaultFlags;

  if (newFaults === 0) {
    lastFaultFlags = flags;
    return;
  }

  Object.entries(FAULTS).forEach(([code, info]) => {
    const mask = 1 << info.bit;

    if ((newFaults & mask) !== 0) {
      saveAlert({
        code,
        label: info.label,
        severity: info.severity,
        value: flags
      });
    }
  });

  // Mostrar modal para las fallas nuevas
  const newFaultsList = Object.entries(FAULTS)
    .filter(([, info]) => (newFaults & (1 << info.bit)) !== 0)
    .map(([, info]) => ({ label: info.label, severity: info.severity }));
  showAlertModal(newFaultsList);

  lastFaultFlags = flags;
}

async function renderPowerAlerts() {
  const body = $('powerAlertsBody');
  if (!body) return;

  // --- Paso 1: mostrar log local inmediatamente ---
  // Esto garantiza visibilidad aunque la DB no esté disponible
  function renderFromLocal() {
    body.innerHTML = '';
    if (localAlertLog.length === 0) {
      const emptyLine = document.createElement('div');
      emptyLine.className = 'log-line log-info';
      emptyLine.textContent = 'No hay alertas registradas.';
      body.appendChild(emptyLine);
      return;
    }
    localAlertLog.forEach(alert => {
      const line = document.createElement('div');
      line.className = alert.severity === 'error' ? 'log-line log-error' : 'log-line log-warn';
      line.textContent = `[${alert.time}] ${alert.label}`;
      body.appendChild(line);
    });
  }

  renderFromLocal();

  // --- Paso 2: intentar cargar historial persistente desde Supabase ---
  try {
    const { data, error } = await db
      .from('alerts')
      .select('created_at, alert_time, label, severity')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error || !data || data.length === 0) return;

    // Combinar: DB como base histórica + entradas locales que no están en DB todavía
    // Construir set de claves únicas de la DB para deduplicar
    const dbKeys = new Set(data.map(a => {
      const t = a.alert_time || new Date(a.created_at).toLocaleString('es-MX');
      return `${t}|${a.label}`;
    }));

    // Entradas locales que aún no están en DB (recién generadas en esta sesión)
    const onlyLocal = localAlertLog.filter(a => !dbKeys.has(`${a.time}|${a.label}`));

    // Unir: primero las locales recientes, luego el histórico de DB
    const combined = [
      ...onlyLocal.map(a => ({ time: a.time, label: a.label, severity: a.severity })),
      ...data.map(a => ({
        time: a.alert_time || new Date(a.created_at).toLocaleString('es-MX'),
        label: a.label,
        severity: a.severity
      }))
    ];

    if (combined.length === 0) return;

    body.innerHTML = '';
    combined.forEach(alert => {
      const line = document.createElement('div');
      line.className = alert.severity === 'error' ? 'log-line log-error' : 'log-line log-warn';
      line.textContent = `[${alert.time}] ${alert.label}`;
      body.appendChild(line);
    });

  } catch (e) {
    // Si falla la DB, el log local ya está visible — no sobreescribir
    log(`Error leyendo historial de alertas DB: ${e.message}`, 'error');
  }
}

window.clearPowerAlerts = async function () {
  // Limpiar también el log local en memoria
  localAlertLog.length = 0;

  const { error } = await db
    .from('alerts')
    .delete()
    .neq('id', 0);

  if (error) {
    log(`Error limpiando alertas DB: ${error.message}`, 'error');
    return;
  }

  renderPowerAlerts();
  log('Historial de alertas limpiado en Supabase.', 'warn');
};

async function saveConsumptionPeriod() {
  if (!periodStartTime) return;

  const periodEndTime = new Date().toLocaleString('es-MX');
  const consumedKwh = Math.max(0, kwhTotal - periodStartKwh);

  try {
    const { error } = await db
      .from('consumption_periods')
      .insert({
        start_time: periodStartTime,
        end_time: periodEndTime,
        energy_kwh: Number(consumedKwh.toFixed(4))
      });

    if (error) {
      log(`Error guardando periodo DB: ${error.message}`, 'error');
      return;
    }

    log(`Periodo guardado en Supabase: ${consumedKwh.toFixed(4)} kWh`, 'success');

    renderConsumptionPeriods();

    periodStartTime = null;
    periodStartKwh = kwhTotal;
  } catch (e) {
    log(`Error DB periodo: ${e.message}`, 'error');
  }
}

async function renderConsumptionPeriods() {
  const body = $('consumptionPeriodsBody');
  if (!body) return;

  body.innerHTML = '';

  const { data, error } = await db
    .from('consumption_periods')
    .select('start_time, end_time, energy_kwh')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    const line = document.createElement('div');
    line.className = 'log-line log-error';
    line.textContent = `Error leyendo periodos.: ${error.message}`;
    body.appendChild(line);
    return;
  }

  if (!data || data.length === 0) {
    const emptyLine = document.createElement('div');
    emptyLine.className = 'log-line log-info';
    emptyLine.textContent = 'No hay periodos registrados.';
    body.appendChild(emptyLine);
    return;
  }

  data.forEach(period => {
    const line = document.createElement('div');
    line.className = 'log-line log-energy';
    line.textContent = `[${period.start_time}] → [${period.end_time}] | ${Number(period.energy_kwh).toFixed(4)} kWh`;
    body.appendChild(line);
  });
}

window.clearConsumptionPeriods = async function () {
  const { error } = await db
    .from('consumption_periods')
    .delete()
    .neq('id', 0);

  if (error) {
    log(`Error limpiando periodos DB: ${error.message}`, 'error');
    return;
  }

  renderConsumptionPeriods();
  log('Historial de periodos limpiado en Supabase.', 'warn');
};

async function saveConsumptionPoint(deltaKwh) {
  pendingConsumptionKwh += deltaKwh;

  const now = Date.now();
  const elapsedMs = now - lastConsumptionSaveTime;

  // Guardar cada 60 segundos
  if (elapsedMs < 300000) return;

  const costResult = calculateTieredEnergyCost(kwhTotal);

  try {
    const { error } = await db
      .from('consumption_points')
      .insert({
        energy_kwh: Number(pendingConsumptionKwh.toFixed(6)),
        session_kwh: Number(kwhTotal.toFixed(6)),
        estimated_cost_mxn: Number(costResult.totalCost.toFixed(2))
      });

    if (error) {
      log(`Error guardando consumo DB: ${error.message}`, 'error');
      return;
    }

    pendingConsumptionKwh = 0;
    lastConsumptionSaveTime = now;

    renderConsumptionChartByRange(consumptionChartRange);
    updateEnergyCost();
  } catch (e) {
    log(`Error DB consumo: ${e.message}`, 'error');
  }
}

// ------------------------------------------------------------------
// Gráfica de Armónicos THD
// ------------------------------------------------------------------

const thdBadgePlugin = {
  id: 'thdBadge',
  afterDraw(chart) {
    if (lastHarmonicThd === null) return;

    const { ctx, chartArea } = chart;
    const text = `THD: ${lastHarmonicThd.toFixed(2)}%`;
    const accent = rootStyles.getPropertyValue('--accent-pwr').trim();

    ctx.save();
    ctx.font = '12px "Share Tech Mono"';
    const paddingX = 10;
    const boxHeight = 22;
    const boxWidth = ctx.measureText(text).width + paddingX * 2;
    const x = chartArea.right - boxWidth - 90;
    const y = chartArea.top + 37.5;

    ctx.fillStyle = hexToRgba(accent, 0.12);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(x, y, boxWidth, boxHeight, 4);
    } else {
      ctx.rect(x, y, boxWidth, boxHeight);
    }
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = accent;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + paddingX, y + boxHeight / 2);
    ctx.restore();
  }
};

function initHarmonicChart() {
  const canvas = $('harmonicChart');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');

  harmonicChartLabels.length = 0;
  harmonicChartData.length = 0;

  for (let i = 1; i <= HARMONICS_COUNT; i++) {
    harmonicChartLabels.push(`H${i}`);
    harmonicChartData.push(0);
  }

  harmonicChart = new Chart(ctx, {
    type: 'bar',
    plugins: [centeredXTitlePlugin, thdBadgePlugin],
    data: {
      labels: harmonicChartLabels,
      datasets: [
        {
          label: 'Magnitud armónica (%)',
          data: harmonicChartData,
          borderColor: rootStyles.getPropertyValue('--accent-pwr').trim(),
          backgroundColor: hexToRgba(rootStyles.getPropertyValue('--accent-pwr').trim(), 0.5),
          borderWidth: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        centeredXTitle: { text: 'Armónico' },
        legend: {
          labels: {
            color: '#e0e0e0',
            font: {
              family: 'Share Tech Mono'
            }
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              return `${context.parsed.y.toFixed(2)} %`;
            },
            labelColor: function(context) {
              const flat = blendHexOverBg(rootStyles.getPropertyValue('--accent-pwr').trim(), 0.5);
              return {
                borderColor: flat,
                backgroundColor: flat
              };
            }
          }
        }
      },
      scales: {
        x: {
          title: {
            display: true,
            text: '',
            color: '#e0e0e0',
            font: {
              family: 'Share Tech Mono',
              size: 12
            }
          },
          ticks: {
            color: '#888888',
            maxRotation: 0,
            autoSkip: false
          },
          grid: {
            color: '#2a2a2a'
          }
        },
        y: {
          beginAtZero: true,
          title: {
            display: true,
            text: 'Magnitud (%)',
            color: '#e0e0e0',
            font: {
              family: 'Share Tech Mono',
              size: 12
            }
          },
          ticks: {
            color: '#888888',
            callback: function(value) {
              return value + ' %';
            }
          },
          grid: {
            color: '#2a2a2a'
          }
        }
      }
    }
  });
}

function processHarmonicsPayload(payload) {
  const harmonics = payload.current_harmonics || payload.harmonics || payload.armonicos || [];

  if (!Array.isArray(harmonics)) {
    log('Formato de armónicos inválido: no contiene arreglo de armónicos.', 'error');
    return;
  }

  const normalized = harmonics.slice(0, HARMONICS_COUNT).map((item, index) => {
    if (typeof item === 'number') {
      return {
        n: index + 1,
        rms: null,
        percent: Number(item)
      };
    }

    return {
      n: Number(item.n ?? item.order ?? item.harmonic ?? index + 1),
      rms: item.rms === undefined || item.rms === null ? null : Number(item.rms),
      percent: Number(item.percent ?? item.percentage ?? item.percent_of_fundamental ?? 0)
    };
  });

  if (normalized.some(item => !Number.isFinite(item.percent))) {
    log('Armónicos inválidos: el porcentaje debe ser numérico.', 'error');
    return;
  }

  const thd = Number(payload.thd ?? payload.current_thd_percent ?? 0);
  const fundamental = Number(payload.fundamental_hz ?? payload.fundamentalHz ?? 60);

  lastHarmonicThd = Number.isFinite(thd) && thd > 0 ? thd : null;

  updateHarmonicChart(normalized.map(item => item.percent));

  const lastUpdateEl = $('harmonicLastUpdate');
  if (lastUpdateEl) {
    const freqText = Number.isFinite(fundamental) && fundamental > 0 ? fundamental.toFixed(2) : '60.00';
    lastUpdateEl.textContent =
      `Captura completa · ${freqText} Hz · Última actualización: ${new Date().toLocaleTimeString('es-MX')}`;
  }

  log(`Armónicos actualizados: ${normalized.length} valores`, 'success');
}

function updateHarmonicChart(harmonics) {
  if (!harmonicChart) return;

  harmonicChartData.length = 0;

  harmonics.forEach(value => {
    harmonicChartData.push(Number(value));
  });

  harmonicChart.update();
}

// ------------------------------------------------------------------
// Costo de energía por tarifa CFE (cálculo escalonado por bloques)
// ------------------------------------------------------------------
function calculateTieredEnergyCost(kwh) {
  const tariff = CFE_TARIFFS[selectedTariffCode] || CFE_TARIFFS['1C'];
  const season = getCurrentSeason(tariff);
  const blocks = tariff[season].blocks;

  let remainingKwh = Math.max(0, Number(kwh) || 0);
  let totalCost = 0;
  const details = [];

  blocks.forEach(block => {
    if (remainingKwh <= 0) return;

    const blockKwh = Math.min(remainingKwh, block.limitKwh);
    const blockCost = blockKwh * block.price;

    details.push({
      label: block.label,
      kwh: blockKwh,
      price: block.price,
      cost: blockCost
    });

    totalCost += blockCost;
    remainingKwh -= blockKwh;
  });

  return {
    totalCost,
    details,
    season,
    isDacRisk: kwh >= tariff.dacLimitKwhPerMonth
  };
}

let energyPeriodRange = 'bimester';

window.setEnergyPeriodRange = function (range) {
  energyPeriodRange = range;
  updateEnergyCost();
};

// Calcula el costo de un RANGO de kWh dentro de la progresión de bloques
// (ej. del kWh 180 al 210 del bimestre), en vez de siempre desde 0.
function calculateTieredEnergyCostRange(startKwh, endKwh, tariff, season) {
  const blocks = tariff[season].blocks;
  let cursor = 0;
  let totalCost = 0;
  const details = [];

  blocks.forEach(block => {
    const blockStart = cursor;
    const blockEnd = cursor + block.limitKwh;

    const overlapStart = Math.max(startKwh, blockStart);
    const overlapEnd = Math.min(endKwh, blockEnd);
    const overlapKwh = Math.max(0, overlapEnd - overlapStart);

    if (overlapKwh > 0) {
      const blockCost = overlapKwh * block.price;
      details.push({ label: block.label, kwh: overlapKwh, price: block.price, cost: blockCost });
      totalCost += blockCost;
    }

    cursor = blockEnd;
  });

  return { totalCost, details };
}

async function updateEnergyCost() {
  const bimesterStartIso = getIsoStartForRange('bimester');
  const periodStartMs = getStartTimeForRange(energyPeriodRange);
  const pageSize = 1000;
  let allRows = [];
  let offset = 0;

  try {
    // Siempre traemos el bimestre COMPLETO paginado, sin importar qué periodo esté
    // seleccionado, porque necesitamos saber en qué bloque de tarifa vas acumulado.
    while (true) {
      const { data, error } = await db
        .from('consumption_points')
        .select('created_at, energy_kwh')
        .gte('created_at', bimesterStartIso)
        .order('created_at', { ascending: true })
        .range(offset, offset + pageSize - 1);

      if (error) {
        log(`Error leyendo consumo bimestral DB: ${error.message}`, 'error');
        return;
      }

      if (!data || data.length === 0) break;
      allRows = allRows.concat(data);
      if (data.length < pageSize) break;
      offset += pageSize;
    }

    const bimesterKwh = allRows.reduce((total, item) => total + Number(item.energy_kwh || 0), 0);

    // kWh del periodo seleccionado (subconjunto del bimestre)
    const periodKwh = energyPeriodRange === 'bimester'
      ? bimesterKwh
      : allRows
          .filter(item => new Date(item.created_at).getTime() >= periodStartMs)
          .reduce((total, item) => total + Number(item.energy_kwh || 0), 0);

    const tariff = CFE_TARIFFS[selectedTariffCode] || CFE_TARIFFS['1C'];
    const season = getCurrentSeason(tariff);

    // Costo marginal real: el rango [antes del periodo, bimestre total]
    const baseKwh = Math.max(0, bimesterKwh - periodKwh);
    const result = calculateTieredEnergyCostRange(baseKwh, bimesterKwh, tariff, season);
    result.season = season;
    result.isDacRisk = bimesterKwh >= tariff.dacLimitKwhPerMonth; // el riesgo DAC siempre es del bimestre completo

    const costEl = $('val-cost');
    const costTariffEl = $('cost-tariff');
    const costBlockEl = $('cost-block');
    const costBreakdownEl = $('cost-breakdown');
    const dacWarningEl = $('dac-warning');
    const valKwhEl = $('val-kwh');

    if (valKwhEl) valKwhEl.textContent = periodKwh.toFixed(4);
    if (costEl) costEl.textContent = '$' + result.totalCost.toFixed(4);
    if (tariffSelectCtrl) tariffSelectCtrl.setValue(selectedTariffCode);

    if (costBlockEl) {
      const lastBlock = result.details[result.details.length - 1];
      costBlockEl.textContent = lastBlock ? lastBlock.label : 'Sin consumo';
    }

    if (costBreakdownEl) {
      if (result.details.length === 0) {
        costBreakdownEl.textContent = 'Sin consumo registrado en este periodo.';
      } else {
        const seasonLabel = result.season === 'verano' ? '☀ Temporada de verano' : '❄ Temporada de invierno';
        const lines = result.details
          .map(item => `${item.label}: ${item.kwh.toFixed(4)} kWh × $${item.price.toFixed(4)} = $${item.cost.toFixed(4)}`);
        costBreakdownEl.innerHTML = `<strong>${seasonLabel}</strong><br>` + lines.join('<br>');
      }
    }

    if (dacWarningEl) {
      if (result.isDacRisk) {
        dacWarningEl.textContent = '⚠ Riesgo DAC: consumo bimestral elevado';
        dacWarningEl.classList.remove('hidden');
      } else {
        dacWarningEl.textContent = '';
        dacWarningEl.classList.add('hidden');
      }
    }
  } catch (e) {
    log(`Error DB consumo bimestral: ${e.message}`, 'error');
  }
}

const centeredXTitlePlugin = {
  id: 'centeredXTitle',
  afterDraw(chart) {
    const text = chart.options.plugins?.centeredXTitle?.text;
    if (!text) return;
    const { ctx } = chart;
    ctx.save();
    ctx.fillStyle = '#e0e0e0';
    ctx.font = '12px "Share Tech Mono"';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(text, chart.width / 2, chart.height - 4);
    ctx.restore();
  }
};

// ------------------------------------------------------------------
// Gráfica de Potencia Activa
// ------------------------------------------------------------------
function initPowerChart() {
  const canvas = $('powerChart');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');

  powerChart = new Chart(ctx, {
    type: 'line',
    plugins: [centeredXTitlePlugin],
    data: {
      labels: powerChartLabels,
      datasets: [
        {
          label: 'Potencia activa (W)',
          data: powerChartData,
          borderColor: rootStyles.getPropertyValue('--accent-pwr').trim(),
          backgroundColor: hexToRgba(rootStyles.getPropertyValue('--accent-pwr').trim(), 0.25),
          borderWidth: 2,
          tension: 0.35,
          pointRadius: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        centeredXTitle: { text: 'Periodo' },
        legend: {
          labels: {
            color: '#e0e0e0',
            font: {
              family: 'Share Tech Mono'
            }
          }
        },
        tooltip: {
          mode: 'index',
          intersect: false
        }
      },
      scales: {
        x: {
          title: {
            display: true,
            text: '',
            color: '#e0e0e0',
            font: {
              family: 'Share Tech Mono',
              size: 12
            }
          },
          ticks: {
            color: '#888888',
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 24
          },
          grid: {
            color: '#2a2a2a'
          }
        },
        y: {
          beginAtZero: true,
          afterFit: function(scaleInstance) {
            scaleInstance.width = 80;
          },
          title: {
            display: true,
            text: 'Potencia activa (W)',
            color: '#e0e0e0',
            font: {
              family: 'Share Tech Mono',
              size: 12
            }
          },
          ticks: {
            color: '#888888',
            callback: function(value) {
              return value + ' W';
            }
          },
          grid: {
            color: '#2a2a2a'
          }
        }
      }
    }
  });
}

function updatePowerChart(powerValue) {
  const now = new Date();

  lastPowerW = Number(powerValue);
  const kwhPowerEl = $('kwh-power');
  if (kwhPowerEl) kwhPowerEl.textContent = lastPowerW.toFixed(1) + ' W';

  if (!powerChart) return;

  const label = now.toLocaleTimeString('es-MX');
  const value = Number(lastPowerW.toFixed(2));

  if (powerChartFillCount < 60) {
    // Fase de llenado: coloca el punto en la siguiente posición vacía (izquierda → derecha)
    powerChartLabels[powerChartFillCount] = label;
    powerChartData[powerChartFillCount] = value;
    powerChartFillCount++;
  } else {
    // Ya está llena: se recorre — sale la más vieja por la izquierda, entra la nueva por la derecha
    powerChartLabels.shift();
    powerChartLabels.push(label);
    powerChartData.shift();
    powerChartData.push(value);
  }

  // Solo actualizar la gráfica visualmente si estamos en la pestaña "hora"
  if (powerChartRange === 'hour') {
    powerChart.data.labels = powerChartLabels;
    powerChart.data.datasets[0].data = powerChartData;
    powerChart.update('none');
  }
}

// ------------------------------------------------------------------
// Triángulo de potencia (SVG)
// ------------------------------------------------------------------
function toReadableAngle(deg) {
  // Normaliza a (-90, 90] para que el texto rotado nunca quede "de cabeza"
  let a = ((deg % 180) + 180) % 180;
  if (a > 90) a -= 180;
  return a;
}

function updatePowerTriangle(p, q, s) {
  const svg = $('powerTriangleSvg');
  if (!svg) return;

  const pAbs = Math.abs(p);
  const qAbs = Math.abs(q);
  const sAbs = s ? Math.abs(s) : Math.sqrt(pAbs * pAbs + qAbs * qAbs);

  const originX = 20;
  const originY = 220;
  const maxWidth  = 170;
  const maxHeight = 160;
  const MIN_VISIBLE = 0.05; // por debajo de esto, se considera "cero" y se oculta la etiqueta

  const maxVal = Math.max(pAbs, qAbs, 1);
  const scale  = Math.min(maxWidth / maxVal, maxHeight / maxVal);

  const px = originX + pAbs * scale;
  const py = originY;
  const qx = originX;
  const qy = originY - qAbs * scale;

  $('triangle-shape').setAttribute('points', `${originX},${originY} ${px},${py} ${qx},${qy}`);

  $('triangle-p-line').setAttribute('x1', originX);
  $('triangle-p-line').setAttribute('y1', originY);
  $('triangle-p-line').setAttribute('x2', px);
  $('triangle-p-line').setAttribute('y2', py);

  $('triangle-q-line').setAttribute('x1', originX);
  $('triangle-q-line').setAttribute('y1', originY);
  $('triangle-q-line').setAttribute('x2', qx);
  $('triangle-q-line').setAttribute('y2', qy);

  $('triangle-s-line').setAttribute('x1', px);
  $('triangle-s-line').setAttribute('y1', py);
  $('triangle-s-line').setAttribute('x2', qx);
  $('triangle-s-line').setAttribute('y2', qy);

  // --- Etiqueta P: paralela a su línea (horizontal) ---
  const pLabel = $('triangle-p-label');
  if (pAbs < MIN_VISIBLE) {
    pLabel.style.opacity = 0;
  } else {
    pLabel.style.opacity = 1;
    const pMidX = originX + (px - originX) / 2;
    const pMidY = originY + 20;
    pLabel.setAttribute('x', pMidX);
    pLabel.setAttribute('y', pMidY);
    pLabel.removeAttribute('transform');
    pLabel.textContent = `P = ${pAbs.toFixed(1)} W`;
  }

  // --- Etiqueta Q: paralela a su línea (vertical) ---
  const qLabel = $('triangle-q-label');
  if (qAbs < MIN_VISIBLE) {
    qLabel.style.opacity = 0;
  } else {
    qLabel.style.opacity = 1;
    const qMidY   = originY - (originY - qy) / 2;
    const qPivotX = originX - 14;
    qLabel.setAttribute('x', qPivotX);
    qLabel.setAttribute('y', qMidY);
    qLabel.setAttribute('transform', `rotate(-90 ${qPivotX} ${qMidY})`);
    qLabel.textContent = `Q = ${qAbs.toFixed(1)} VAR`;
  }

  // --- Etiqueta S: paralela a la hipotenusa (ángulo dinámico) ---
  const sLabel = $('triangle-s-label');
  if (sAbs < MIN_VISIBLE) {
    sLabel.style.opacity = 0;
  } else {
    sLabel.style.opacity = 1;
    const dx = qx - px, dy = qy - py;
    const len = Math.hypot(dx, dy) || 1;
    const midX = (px + qx) / 2;
    const midY = (py + qy) / 2;
    const nx = -dy / len, ny = dx / len;
    const offset = 20;
    const candA = { x: midX + nx * offset, y: midY + ny * offset };
    const candB = { x: midX - nx * offset, y: midY - ny * offset };
    const distA = Math.hypot(candA.x - originX, candA.y - originY);
    const distB = Math.hypot(candB.x - originX, candB.y - originY);
    const sPos  = distA > distB ? candA : candB; // el punto que queda fuera del triángulo

    const lineAngleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
    const sAngle = toReadableAngle(lineAngleDeg); // paralelo a la línea, no +90

    sLabel.setAttribute('x', sPos.x);
    sLabel.setAttribute('y', sPos.y);
    sLabel.setAttribute('transform', `rotate(${sAngle} ${sPos.x} ${sPos.y})`);
    sLabel.textContent = `S = ${sAbs.toFixed(1)} VA`;
  }

  // --- Ángulo φ ---
  const phiLabel = $('triangle-angle-label');
  if (sAbs < MIN_VISIBLE) {
    phiLabel.style.opacity = 0;
  } else {
    phiLabel.style.opacity = 1;
    const phi = Math.acos(Math.min(1, pAbs / sAbs)) * 180 / Math.PI;
    phiLabel.setAttribute('x', px + 8);
    phiLabel.setAttribute('y', originY - 8);
    phiLabel.textContent = `φ = ${phi.toFixed(1)}°`;
  }
}

// ------------------------------------------------------------------
// Eficiencia energética
// ------------------------------------------------------------------
function updateEfficiency(p, s) {
  const el = $('val-efficiency');
  if (!el) return;

  const pAbs = Math.abs(p);
  const sAbs = Math.abs(s);
  const eff  = sAbs > 0 ? Math.min(100, (pAbs / sAbs) * 100) : 0;

  el.textContent = eff.toFixed(2);
  updateEfficiencyArc(eff);
}

function updateEfficiencyArc(eff) {
  const arcLen = 125.5;
  const filled = Math.min(1, Math.max(0, eff / 100)) * arcLen;
  const arcEl  = $('efficiency-arc-fill');
  if (!arcEl) return;

  let level, label;
  if      (eff === 0) { level = 'off';    label = '—'; }
  else if (eff >= 95) { level = 'good';   label = 'EXCELENTE'; }
  else if (eff >= 75) { level = 'warn';   label = 'BUENA'; }
  else if (eff >= 50) { level = 'alert';  label = 'REGULAR'; }
  else                { level = 'danger'; label = 'BAJA'; }

  const color = STATUS_COLORS[level];
  arcEl.setAttribute('stroke-dasharray', `${filled} ${arcLen}`);
  arcEl.setAttribute('stroke', color);

  const ratingEl = $('efficiency-rating');
  if (ratingEl) {
    ratingEl.textContent = label;
    ratingEl.style.color = color;
  }

  setCardStatusColor('card-efficiency', level);
}

// ------------------------------------------------------------------
// Utilidades de agregación de históricos (Supabase → buckets de gráfica)
// ------------------------------------------------------------------
function getIsoStartForRange(range) {
  const startTime = getStartTimeForRange(range);
  return new Date(startTime).toISOString();
}

async function fetchPowerHistoryFromDatabase(range, rangeOffset = 0) {
  const { start, end } = getRangeBounds(range, rangeOffset);
  const startIso = new Date(start).toISOString();
  const endIso = new Date(end).toISOString();
  const pageSize = 1000;
  let allRows = [];
  let dbOffset = 0;

  while (true) {
    const { data, error } = await db
      .from('telemetry')
      .select('created_at, active_power')
      .gte('created_at', startIso)
      .lte('created_at', endIso)
      .not('active_power', 'is', null)
      .order('created_at', { ascending: true })
      .range(dbOffset, dbOffset + pageSize - 1);

    if (error) {
      log(`Error leyendo potencia DB: ${error.message}`, 'error');
      break;
    }

    if (!data || data.length === 0) break;

    allRows = allRows.concat(data);

    if (data.length < pageSize) break;
    dbOffset += pageSize;
  }

  return allRows;
}

function aggregateIntoBuckets(rawData, buckets, unitMs, valueKey, mode) {
  const sums = new Array(buckets.length).fill(0);
  const counts = new Array(buckets.length).fill(0);

  rawData.forEach(item => {
    const t = new Date(item.created_at).getTime();
    const idx = Math.floor((t - buckets[0].key) / unitMs);
    if (idx < 0 || idx >= buckets.length) return;
    sums[idx] += Number(item[valueKey]);
    counts[idx] += 1;
  });

  return buckets.map((b, i) => ({
    label: b.label,
    value: mode === 'avg' ? (counts[i] > 0 ? sums[i] / counts[i] : 0) : sums[i]
  }));
}

async function renderPowerChartByRange(range = 'hour', rangeOffset = null) {
  if (!powerChart) return;

  powerChartRange = range;
  if (rangeOffset !== null) powerChartRangeOffset = rangeOffset;

  const navEl = $('powerChartNav');

  if (range === 'hour') {
    if (navEl) navEl.classList.add('time-only');
    updateHourNavClock();

    powerChart.data.labels = powerChartLabels;
    powerChart.data.datasets[0].data = powerChartData;
    powerChart.update('none');
    updatePowerChartButtons(range);
    return;
  }

  if (navEl) navEl.classList.remove('time-only');

  const { start, end } = getRangeBounds(range, powerChartRangeOffset);
  const rawData = await fetchPowerHistoryFromDatabase(range, powerChartRangeOffset);

  const DAY_MS = 24 * 60 * 60 * 1000;
  let unitMs, labelFn;

  if (range === 'day') {
    unitMs = 60 * 60 * 1000;
    labelFn = d => `${String(d.getHours()).padStart(2, '0')}:00`;
  } else if (range === 'week') {
    unitMs = DAY_MS;
    labelFn = d => d.toLocaleDateString('es-MX', { weekday: 'short', day: '2-digit', month: '2-digit' });
  } else {
    unitMs = 7 * DAY_MS;
    labelFn = (d, i) => `Sem ${i + 1}`;
  }

  const buckets = [];
  for (let t = start, i = 0; t < end; t += unitMs, i++) {
    buckets.push({ key: t, label: labelFn(new Date(t), i) });
  }

  const chartData = aggregateIntoBuckets(rawData, buckets, unitMs, 'active_power', 'avg');

  powerChart.data.labels = chartData.map(item => item.label);
  powerChart.data.datasets[0].data = chartData.map(item => Number(item.value.toFixed(2)));

  powerChart.update('none');
  updatePowerChartButtons(range);

  const labelEl = $('powerChartNavLabel');
  if (labelEl) labelEl.textContent = formatRangeLabel(range, start, end);
  const nextBtn = $('powerChartNavNext');
  if (nextBtn) nextBtn.disabled = powerChartRangeOffset >= 0;
}

window.navigatePowerChart = function (direction) {
  if (powerChartRange === 'hour') return;
  const newOffset = powerChartRangeOffset + direction;
  if (newOffset > 0) return;
  renderPowerChartByRange(powerChartRange, newOffset);
};

function updatePowerChartButtons(activeRange) {
  // Acotar al primer panel de gráfica (potencia activa) para no afectar
  // los botones de consumo que comparten la clase chart-range-btn
  const powerPanel = document.querySelector('#powerChart')?.closest('.chart-panel');
  const buttons = powerPanel
    ? powerPanel.querySelectorAll('.chart-range-btn')
    : document.querySelectorAll('.chart-range-btn[data-range]');   // fallback seguro

  buttons.forEach(btn => {
    if (btn.dataset.range === activeRange) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

window.setPowerChartRange = function (range) {
  renderPowerChartByRange(range, 0);
};

// ------------------------------------------------------------------
// Gráfica de Consumo de Energía
// ------------------------------------------------------------------
function initConsumptionChart() {
  const canvas = $('consumptionChart');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');

  consumptionChart = new Chart(ctx, {
    type: 'bar',
    plugins: [centeredXTitlePlugin],
    data: {
      labels: consumptionChartLabels,
      datasets: [
        {
          label: 'Consumo de energía (kWh)',
          data: consumptionChartData,
          borderColor: rootStyles.getPropertyValue('--accent-pwr').trim(),
          backgroundColor: hexToRgba(rootStyles.getPropertyValue('--accent-pwr').trim(), 0.5),
          borderWidth: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        centeredXTitle: { text: 'Periodo' },
        legend: {
          labels: {
            color: '#e0e0e0',
            font: {
              family: 'Share Tech Mono'
            }
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              return `${context.parsed.y.toFixed(4)} kWh`;
            },
            labelColor: function(context) {
              const flat = blendHexOverBg(rootStyles.getPropertyValue('--accent-pwr').trim(), 0.5);
              return {
                borderColor: flat,
                backgroundColor: flat
              };
            }
          }
        }
      },
      scales: {
        x: {
          title: {
            display: true,
            text: '',
            color: '#e0e0e0',
            font: {
              family: 'Share Tech Mono',
              size: 12
            }
          },
          ticks: {
            color: '#888888',
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 24
          },
          grid: {
            color: '#2a2a2a'
          }
        },
        y: {
          beginAtZero: true,
          afterFit: function(scaleInstance) {
            scaleInstance.width = 95; // ancho fijo, así el área de la gráfica nunca se mueve
          },
          title: {
            display: true,
            text: 'Consumo de energía (kWh)',
            color: '#e0e0e0',
            font: {
              family: 'Share Tech Mono',
              size: 12
            }
          },
          ticks: {
            color: '#888888',
            callback: function(value) {
              return value + ' kWh';
            }
          },
          grid: {
            color: '#2a2a2a'
          }
        }
      }
    }
  });
}

async function fetchConsumptionHistoryFromDatabase(range, rangeOffset = 0) {
  const { start, end } = getRangeBounds(range, rangeOffset);
  const startIso = new Date(start).toISOString();
  const endIso = new Date(end).toISOString();
  const pageSize = 1000;
  let allRows = [];
  let dbOffset = 0;

  while (true) {
    const { data, error } = await db
      .from('consumption_points')
      .select('created_at, energy_kwh, session_kwh, estimated_cost_mxn')
      .gte('created_at', startIso)
      .lte('created_at', endIso)
      .order('created_at', { ascending: true })
      .range(dbOffset, dbOffset + pageSize - 1);

    if (error) {
      log(`Error leyendo consumo DB: ${error.message}`, 'error');
      break;
    }

    if (!data || data.length === 0) break;

    allRows = allRows.concat(data);

    if (data.length < pageSize) break;
    dbOffset += pageSize;
  }

  return allRows;
}

async function renderConsumptionChartByRange(range = 'day', rangeOffset = null) {
  if (!consumptionChart) return;

  consumptionChartRange = range;
  if (rangeOffset !== null) consumptionChartRangeOffset = rangeOffset;

  const { start, end } = getRangeBounds(range, consumptionChartRangeOffset);
  const rawData = await fetchConsumptionHistoryFromDatabase(range, consumptionChartRangeOffset);

  const DAY_MS = 24 * 60 * 60 * 1000;
  let unitMs, labelFn;

  if (range === 'day') {
    unitMs = 60 * 60 * 1000;
    labelFn = d => `${String(d.getHours()).padStart(2, '0')}:00`;
  } else if (range === 'week') {
    unitMs = DAY_MS;
    labelFn = d => d.toLocaleDateString('es-MX', { weekday: 'short', day: '2-digit', month: '2-digit' });
  } else {
    unitMs = 7 * DAY_MS;
    labelFn = (d, i) => `Sem ${i + 1}`;
  }

  const buckets = [];
  for (let t = start, i = 0; t < end; t += unitMs, i++) {
    buckets.push({ key: t, label: labelFn(new Date(t), i) });
  }

  const chartData = aggregateIntoBuckets(rawData, buckets, unitMs, 'energy_kwh', 'sum');

  consumptionChartLabels.length = 0;
  consumptionChartData.length = 0;

  chartData.forEach(item => {
    consumptionChartLabels.push(item.label);
    consumptionChartData.push(Number(item.value.toFixed(4)));
  });

  consumptionChart.update();
  updateConsumptionChartButtons(range);

  const labelEl = $('consumptionChartNavLabel');
  if (labelEl) labelEl.textContent = formatRangeLabel(range, start, end);
  const nextBtn = $('consumptionChartNavNext');
  if (nextBtn) nextBtn.disabled = consumptionChartRangeOffset >= 0;
}

window.navigateConsumptionChart = function (direction) {
  const newOffset = consumptionChartRangeOffset + direction;
  if (newOffset > 0) return;
  renderConsumptionChartByRange(consumptionChartRange, newOffset);
};

function updateConsumptionChartButtons(activeRange) {
  const buttons = document.querySelectorAll('.consumption-range-btn');

  buttons.forEach(btn => {
    if (btn.dataset.range === activeRange) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

window.setConsumptionChartRange = function (range) {
  renderConsumptionChartByRange(range, 0);
};


// ------------------------------------------------------------------
// Actualización general del dashboard (tarjetas en vivo)
// ------------------------------------------------------------------
function updateDashboard(d) {
  if (d.v !== undefined) {
    setVal('v', d.v, 2, 'V');
    setBar('bar-v', d.v, LIMITS.v);
  }
  if (d.i !== undefined) {
    setVal('i', d.i, 2, 'A');
    setBar('bar-i', d.i, LIMITS.i);
  }
  if (d.p_activa !== undefined) {
    setVal('pa', d.p_activa, 1, 'W');
    lastPowerW = parseFloat(d.p_activa);
    trianglePa = lastPowerW;
    const _kwhPow1 = $('kwh-power'); if (_kwhPow1) _kwhPow1.textContent = lastPowerW.toFixed(1) + ' W';

    updatePowerChart(lastPowerW);
  }
  if (d.p_aparente !== undefined) { setVal('pap', d.p_aparente, 1, 'VA'); trianglePap = parseFloat(d.p_aparente); }
  if (d.p_reactiva !== undefined) { setVal('pr',  d.p_reactiva, 1, 'VAR'); trianglePr = parseFloat(d.p_reactiva); }

  updatePowerTriangle(trianglePa, trianglePr, trianglePap);
  updateEfficiency(trianglePa, trianglePap);

  if (d.fp         !== undefined) { setVal('fp', d.fp, 2, ''); updateFpArc(d.fp); }
  if (d.thd        !== undefined) { setVal('thd', d.thd, 2, '%'); updateThdBars(d.thd); updateThdStatus(d.thd); }
  if (d.fault_flags !== undefined) {
    processFaultFlags(d.fault_flags);
  }
  
}

// ------------------------------------------------------------------
// Helpers de actualización de tarjetas
// ------------------------------------------------------------------
function setVal(key, value, decimals, unit) {
  const el = els[key];
  if (!el) return;
  el.textContent = parseFloat(value).toFixed(decimals);

  const unitEl = el.parentElement.querySelector('.card-unit');
  if (unitEl && unit) unitEl.textContent = unit;
}

function setBar(barId, value, max) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  $(barId).style.width = pct + '%';
}

const LIVE_CARD_IDS = ['card-v', 'card-i', 'card-kwh', 'card-cost', 'card-power', 'card-diagnosis', 'card-fp', 'card-thd', 'card-efficiency'];

function setSystemOffline() {
  LIVE_CARD_IDS.forEach(id => setCardStatusColor(id, 'off'));

  const barV = $('bar-v');
  const barI = $('bar-i');
  if (barV) barV.style.width = '0%';
  if (barI) barI.style.width = '0%';

  resetArc('fp-arc-fill', 'fp-rating');
  resetArc('thd-arc-fill', 'thd-rating');
  resetArc('efficiency-arc-fill', 'efficiency-rating');

  trianglePa = 0;
  trianglePap = 0;
  trianglePr = 0;
  updatePowerTriangle(0, 0, 0);

  const offBtn  = $('noLoadOff');
  const keepBtn = $('noLoadKeep');
  if (offBtn)  offBtn.classList.remove('active');
  if (keepBtn) keepBtn.classList.remove('active');

  const onoffBtnEl = $('onoffBtn');
  if (onoffBtnEl) {
    onoffBtnEl.className = 'onoff-btn onoff-unknown';
    const iconEl = $('onoffIcon');
    const textEl = $('onoffText');
    const hintEl = $('onoffHint');
    if (iconEl) iconEl.textContent = '●';
    if (textEl) textEl.textContent = '—';
    if (hintEl) hintEl.textContent = 'Esperando conexión…';
  }
}

function setSystemOnline() {
  LIVE_CARD_IDS.forEach(id => {
    const card = document.getElementById(id);
    if (card) card.style.removeProperty('--status-color');
  });

  const savedNoLoadAction = localStorage.getItem('noLoadAction');
  const offBtn  = $('noLoadOff');
  const keepBtn = $('noLoadKeep');
  if (savedNoLoadAction && offBtn && keepBtn) {
    offBtn.classList.toggle('active', savedNoLoadAction === 'OFF');
    keepBtn.classList.toggle('active', savedNoLoadAction === 'KEEP');
  }
}

const rootStyles = getComputedStyle(document.documentElement);

// ------------------------------------------------------------------
// Utilidades de color (variables CSS → Canvas / Chart.js)
// ------------------------------------------------------------------
function hexToRgba(hex, alpha) {
  const h = hex.trim().replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function blendHexOverBg(hex, alpha, bgHex = '#050505') {
  const c  = hex.trim().replace('#', '');
  const bg = bgHex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16), g = parseInt(c.substring(2, 4), 16), b = parseInt(c.substring(4, 6), 16);
  const br = parseInt(bg.substring(0, 2), 16), bgn = parseInt(bg.substring(2, 4), 16), bb = parseInt(bg.substring(4, 6), 16);
  const rr = Math.round(alpha * r + (1 - alpha) * br);
  const rg = Math.round(alpha * g + (1 - alpha) * bgn);
  const rb = Math.round(alpha * b + (1 - alpha) * bb);
  return `rgb(${rr}, ${rg}, ${rb})`;
}

const STATUS_COLORS = {
  off:    rootStyles.getPropertyValue('--status-off').trim(),
  good:   rootStyles.getPropertyValue('--status-good').trim(),
  warn:   rootStyles.getPropertyValue('--status-warn').trim(),
  alert:  rootStyles.getPropertyValue('--status-alert').trim(),
  danger: rootStyles.getPropertyValue('--status-danger').trim(),
};

function setCardStatusColor(cardId, level) {
  const card = document.getElementById(cardId);
  if (!card) return;
  card.style.setProperty('--status-color', STATUS_COLORS[level] || STATUS_COLORS.off);
}

function updateFpArc(fp) {
  const arcLen = 125.5;
  const filled = Math.min(1, Math.max(0, fp)) * arcLen;
  const arcEl  = $('fp-arc-fill');
  arcEl.setAttribute('stroke-dasharray', `${filled} ${arcLen}`);

  let level, label;
  if      (fp === 0)   { level = 'off';    label = '—'; }
  else if (fp >= 0.95) { level = 'good';   label = 'EXCELENTE'; }
  else if (fp >= 0.75) { level = 'warn';   label = 'BUENO'; }
  else if (fp >= 0.50) { level = 'alert';  label = 'REGULAR'; }
  else                 { level = 'danger'; label = 'BAJO'; }

  const color = STATUS_COLORS[level];
  arcEl.setAttribute('stroke', color);
  $('fp-rating').textContent = label;
  $('fp-rating').style.color = color;
  setCardStatusColor('card-fp', level);
}

function resetArc(arcId, ratingId) {
  const arcEl = $(arcId);
  if (arcEl) {
    arcEl.setAttribute('stroke-dasharray', '0 125.5');
    arcEl.setAttribute('stroke', STATUS_COLORS.off);
  }
  const ratingEl = $(ratingId);
  if (ratingEl) {
    ratingEl.textContent = '—';
    ratingEl.style.color = STATUS_COLORS.off;
  }
}

function updateThdStatus(thd) {
  let level, label;
  if      (thd === 0) { level = 'off';    label = '—'; }
  else if (thd < 25)  { level = 'good';   label = 'BAJO'; }
  else if (thd < 50)  { level = 'warn';   label = 'MODERADO'; }
  else if (thd < 75)  { level = 'alert';  label = 'ALTO'; }
  else                 { level = 'danger'; label = 'CRÍTICO'; }

  const color  = STATUS_COLORS[level];
  const arcLen = 125.5;
  // Capado en 100%: valores mayores llenan el arco completo, no se salen.
  const filled = Math.min(1, Math.max(0, thd / 100)) * arcLen;
  const arcEl  = $('thd-arc-fill');
  if (arcEl) {
    arcEl.setAttribute('stroke-dasharray', `${filled} ${arcLen}`);
    arcEl.setAttribute('stroke', color);
  }
  const ratingEl = $('thd-rating');
  if (ratingEl) {
    ratingEl.textContent = label;
    ratingEl.style.color = color;
  }

  setCardStatusColor('card-thd', level);
}

function updateThdBars(thd) {
  const bars = document.querySelectorAll('.hbar');
  const harmonics = [100, thd * 6, thd * 4, thd * 2.5, thd * 1.5, thd, thd * 0.5];
  bars.forEach((bar, i) => {
    bar.style.height = Math.min(100, harmonics[i] || 2) + '%';
  });
}

// ------------------------------------------------------------------
// Acumulador kWh
// El timer corre al mismo ritmo que el muestreo del ESP32 para evitar
// oscilaciones cuando el intervalo es mayor a 1 segundo.
// ------------------------------------------------------------------
let kwhSampleMs = 1000;   // Intervalo de muestreo actual en ms (se actualiza con sendSampleRate)

function startKwhTimer() {
  if (kwhTimerInterval) {
    clearInterval(kwhTimerInterval);
  }

  kwhStartTime = Date.now();
  periodStartTime = new Date().toLocaleString('es-MX');
  periodStartKwh = kwhTotal;

  _scheduleKwhTick();
}

function _scheduleKwhTick() {
  if (kwhTimerInterval) clearInterval(kwhTimerInterval);

  kwhTimerInterval = setInterval(() => {
    // Acumular energía proporcional al intervalo real (no siempre 1 s)
    const deltaKwh = (lastPowerW * kwhSampleMs) / 3_600_000_000;

    kwhTotal += deltaKwh;

    saveConsumptionPoint(deltaKwh);

    $('kwh-session').textContent = kwhTotal.toFixed(4) + ' kWh';
    const _kwhPow2 = $('kwh-power'); if (_kwhPow2) _kwhPow2.textContent = lastPowerW.toFixed(1) + ' W';

    // Actualizar costo de sesión en pesos
    const sessionCost = calculateTieredEnergyCost(kwhTotal);
    const costSessionEl = $('cost-session');
    if (costSessionEl) costSessionEl.textContent = '$' + sessionCost.totalCost.toFixed(4) + ' MXN';

    

    const elapsed = Math.floor((Date.now() - kwhStartTime) / 1000);
    const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');

    $('kwh-time').textContent = `${h}:${m}:${s}`;
  }, kwhSampleMs);
}

// Llamar esto cuando el usuario cambia el tiempo de muestreo
// (después de sendSampleRate) para sincronizar el timer y el watchdog
function applySampleRate(segundos) {
  const s = Math.max(1, parseInt(segundos) || 1);
  kwhSampleMs = s * 1000;

  // Reiniciar el timer con el nuevo intervalo si ya está corriendo
  if (kwhTimerInterval) {
    _scheduleKwhTick();
    log(`Frecuencia de actualización ajustada a ${s} s`, 'info');
  }

  // El watchdog dinámico se actualiza automáticamente en el siguiente mensaje
  // recibido desde el ESP32 (usa sampleRate.value en tiempo real)
}

window.resetKwh = function () {
  // Antes de resetear, guardar el periodo actual
  if (periodStartTime && kwhTotal > periodStartKwh) {
    saveConsumptionPeriod();
  }

  // Reiniciar contador de energía
  kwhTotal = 0;
  kwhStartTime = Date.now();

  $('kwh-session').textContent = '0.0000 kWh';
  const _kwhPow3 = $('kwh-power'); if (_kwhPow3) _kwhPow3.textContent = lastPowerW.toFixed(1) + ' W';
  $('kwh-time').textContent = '00:00:00';
  updateEnergyCost();

  // Iniciar nuevo periodo después del reset
  periodStartTime = new Date().toLocaleString('es-MX');
  periodStartKwh = kwhTotal;

  log('Contador kWh reseteado y periodo guardado.', 'warn');
};

window.resetDiagnosis = function () {
  showDiagnosisPlaceholder('Solicitando nueva captura...');
  log('Diagnóstico de carga reseteado.', 'warn');
  requestDiagnosisWaveform();
};

function showDiagnosisPlaceholder(hintMessage) {
  const typeEl  = $('diagnosis-type');
  const hintEl  = $('diagnosis-hint');
  const dtEl    = $('diagnosis-dt');
  const angleEl = $('diagnosis-angle');
  const tsEl    = $('diagnosis-timestamp');
  if (!typeEl) return;

  typeEl.textContent = 'Sin datos';
  typeEl.style.color = '';
  hintEl.textContent = hintMessage;
  dtEl.textContent = '--- ms';
  angleEl.textContent = '---°';
  tsEl.textContent = '--:--:--';
}

function clearWaveformAndHarmonicsCharts() {
  if (waveformChart) {
    waveformChart.data.datasets[0].data = [];
    waveformChart.data.datasets[1].data = [];
    waveformChart.update('none');
  }
  const waveformStatusEl = $('waveformStatus');
  if (waveformStatusEl) waveformStatusEl.textContent = 'Última actualización: --:--:--';

  lastHarmonicThd = null;
  if (harmonicChart) {
    harmonicChartData.fill(0);
    harmonicChart.update();
  }
  const harmonicLastUpdateEl = $('harmonicLastUpdate');
  if (harmonicLastUpdateEl) harmonicLastUpdateEl.textContent = 'Última actualización: --:--:--';
}

// ------------------------------------------------------------------
// Comandos del dispositivo
// ------------------------------------------------------------------

// Límite superior de potencia — sincronizar slider ↔ input (con validación cruzada)
window.syncPowerLimit = function (val) {
  let v = parseInt(val);
  const minVal = parseInt($('powerLimitMin').value) || 0;
  if (v < minVal) v = minVal; // el superior no puede bajar del inferior
  $('powerLimit').value       = v;
  $('powerLimitSlider').value = v;
};
window.updatePowerLimitDisplay = function () {
  let v = parseInt($('powerLimit').value);
  if (isNaN(v)) v = 0;
  v = Math.min(1200, Math.max(0, v));

  const minVal = parseInt($('powerLimitMin').value) || 0;
  if (v < minVal) v = minVal;

  $('powerLimit').value       = v;
  $('powerLimitSlider').value = Math.min(1200, v);
};

// Límite inferior de potencia — sincronizar slider ↔ input (con validación cruzada)
window.syncPowerLimitMin = function (val) {
  let v = parseInt(val);
  const maxVal = parseInt($('powerLimit').value) || 1200;
  if (v > maxVal) v = maxVal; // el inferior no puede pasar del superior
  $('powerLimitMin').value       = v;
  $('powerLimitMinSlider').value = v;
};
window.updatePowerLimitMinDisplay = function () {
  let v = parseInt($('powerLimitMin').value);
  if (isNaN(v)) v = 0;
  v = Math.min(1200, Math.max(0, v));

  const maxVal = parseInt($('powerLimit').value) || 1200;
  if (v > maxVal) v = maxVal;

  $('powerLimitMin').value       = v;
  $('powerLimitMinSlider').value = Math.min(1200, v);
};

// Tiempo de muestreo — sincronizar slider ↔ input
window.syncSampleRate = function (val) {
  $('sampleRate').value = val;
};
window.updateSampleDisplay = function () {
  let v = parseInt($('sampleRate').value);
  if (isNaN(v)) v = 1;
  v = Math.min(60, Math.max(1, v));
  $('sampleRate').value   = v;
  $('sampleSlider').value = Math.min(60, v);
};


// ------------------------------------------------------------------
// Estado de conexión
// ------------------------------------------------------------------
function setStatus(isConnected) {
  const dot  = $('statusDot');
  const text = $('statusText');
  if (isConnected) {
    dot.classList.add('connected');
    text.textContent = 'Conectado';
  } else {
    dot.classList.remove('connected');
    text.textContent = 'Desconectado';
  }
}

// ------------------------------------------------------------------
// Log de consola
// ------------------------------------------------------------------
function log(msg, type = 'info') {
  const body = $('logBody');
  const ts   = new Date().toLocaleTimeString('es-MX');
  const line = document.createElement('div');
  line.className = `log-line log-${type}`;
  line.textContent = `[${ts}] ${msg}`;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
  while (body.children.length > 100) body.removeChild(body.firstChild);
}

window.clearLog = function () {
  $('logBody').innerHTML = '';
  log('Log limpiado.', 'info');
};

// ------------------------------------------------------------------
// Simulador (consola del navegador: startSim() / stopSim())
// ------------------------------------------------------------------
let simInterval = null;

window.startSim = function (intervalMs = 1000) {
  stopSim();
  if (!kwhStartTime) startKwhTimer();
  log('▸ Simulador iniciado (sin broker).', 'warn');
  simInterval = setInterval(() => {
    const v   = +(120 + Math.random() * 10 - 5).toFixed(1);
    const i   = +(2  + Math.random() * 0.5).toFixed(2);
    const pa  = +(v * i * 0.9).toFixed(1);
    const pap = +(v * i).toFixed(1);
    const pr  = +(pa * 0.15).toFixed(1);
    const fp  = +(pa / pap).toFixed(2);
    const thd = +(4  + Math.random() * 1.5).toFixed(1);

    const payload = { v, i, p_activa: pa, p_aparente: pap, p_reactiva: pr, fp, thd };
    log(`[SIM] ${JSON.stringify(payload)}`, 'data');
    updateDashboard(payload);
    $('lastUpdate').textContent = new Date().toLocaleTimeString('es-MX');
  }, intervalMs);
};

window.stopSim = function () {
  if (simInterval) {
    clearInterval(simInterval);
    simInterval = null;
    log('■ Simulador detenido.', 'warn');
  }
};
// ============================================================
// FUNCIONES PARA ENVIAR COMANDOS (PUBLICAR EN MQTT)
// ============================================================

// Función genérica para enviar mensajes fácilmente
function publishMessage(topic, payload) {
  if (connected && client) {
    // Paho MQTT requiere crear un objeto Message
    const message = new Paho.MQTT.Message(payload.toString());
    message.destinationName = topic;
    client.send(message);
  } else {
    log('Error: No se puede enviar comando, el broker está desconectado.', 'error');
  }
}

window.toggleRelay = function () {
  // Evaluamos cómo creemos que está el relé para pedir lo contrario
  const payload = relayOn ? 'OFF' : 'ON';
  const topic = 'smartcontact/contacto_01/control/rele';

  // Mandamos la orden al hardware
  publishMessage(topic, payload);
  log(`▸ Comando enviado: Relé -> ${payload} (Esperando confirmación física...)`, 'info');

  // ⛔ NO cambiamos la variable relayOn ni los colores del botón aquí.
};

// 2. Comando de Límite de Potencia
window.sendPowerLimit = function () {
  const rawValue = $('powerLimitSlider').value;
  const limitValue = String(rawValue).padStart(4, '0');
  log(`Dispositivos conocidos: [${[...knownDevices].join(', ')}]`, 'info');
  publishToAllDevices('control/limite_potencia', limitValue);
};

// 2b. Comando de Límite Inferior de Potencia
window.sendPowerLimitMin = function () {
  const rawValue = $('powerLimitMinSlider').value;
  const limitValue = String(rawValue).padStart(4, '0');
  log(`Dispositivos conocidos: [${[...knownDevices].join(', ')}]`, 'info');
  publishToAllDevices('control/limite_potencia_min', limitValue);
};

// 3. Comando de Tiempo de Muestreo
window.sendSampleRate = function () {
  const sampleValue = $('sampleRate').value;
  log(`Dispositivos conocidos: [${[...knownDevices].join(', ')}]`, 'info');
  publishToAllDevices('control/tiempo_muestreo', sampleValue);
  applySampleRate(sampleValue);
};

// 4. Comando de comportamiento sin carga (FAULT_NO_LOAD)
// Control path: control/no_load_action
// Payload: "OFF"  → desconectar salida automáticamente cuando no hay corriente
//          "KEEP" → mantener salida encendida aunque no haya corriente
window.sendNoLoadAction = function (value) {
  const label = value === 'OFF' ? 'Desconectar salida sin carga' : 'Mantener salida sin carga';
  publishToAllDevices('control/no_load_action', value);
  log(`  (${label})`, 'info');

  localStorage.setItem('noLoadAction', value);

  const offBtn  = $('noLoadOff');
  const keepBtn = $('noLoadKeep');
  if (offBtn && keepBtn) {
    offBtn.classList.toggle('active', value === 'OFF');
    keepBtn.classList.toggle('active', value === 'KEEP');
  }
};

window.addEventListener('DOMContentLoaded', () => {

  setSystemOffline();

  periodSelectCtrl = createCustomSelect('energy-period-custom', (value) => {
    setEnergyPeriodRange(value);
  });
  if (periodSelectCtrl) periodSelectCtrl.setValue(energyPeriodRange);

  tariffSelectCtrl = createCustomSelect('cost-tariff-custom', (value) => {
    onTariffChange(value);
  });
  if (tariffSelectCtrl) tariffSelectCtrl.setValue(selectedTariffCode);

  initPowerChart();
  initConsumptionChart();
  initHarmonicChart();
  initWaveformChart();

  setCardStatusColor('card-fp', 'off');
  setCardStatusColor('card-thd', 'off');

  testDatabaseConnection();

  renderPowerChartByRange('hour');
  renderConsumptionChartByRange('day');

  renderPowerAlerts();
  renderConsumptionPeriods();

  if (relayOn && !periodStartTime) {
    periodStartTime = new Date().toLocaleString('es-MX');
    periodStartKwh = kwhTotal;
  }
});