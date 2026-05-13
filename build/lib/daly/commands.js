"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALARM_FLAGS = exports.Bounds = exports.CommandId = exports.MAX_TEMP_SENSORS = exports.MAX_CELLS = void 0;
exports.buildMosfetPayload = buildMosfetPayload;
exports.parsePackMeasurements = parsePackMeasurements;
exports.parseMinMaxCellVoltage = parseMinMaxCellVoltage;
exports.parseMinMaxTemperature = parseMinMaxTemperature;
exports.parseStatusInfo = parseStatusInfo;
exports.parseMosfetStatus = parseMosfetStatus;
exports.parseCellVoltageFrame = parseCellVoltageFrame;
exports.combineCellVoltageFrames = combineCellVoltageFrames;
exports.parseTemperatureFrame = parseTemperatureFrame;
exports.combineTemperatureFrames = combineTemperatureFrames;
exports.parseBalancerState = parseBalancerState;
exports.parseAlarmFlags = parseAlarmFlags;
const protocol_1 = require("./protocol");
/** Hard upper bounds from the DALY UART spec. Values above these are taken to be garbage. */
exports.MAX_CELLS = 48;
exports.MAX_TEMP_SENSORS = 16;
exports.CommandId = {
    PackMeasurements: 0x90,
    MinMaxCellVoltage: 0x91,
    MinMaxTemperature: 0x92,
    MosfetStatus: 0x93,
    StatusInfo: 0x94,
    CellVoltages: 0x95,
    TemperatureSensors: 0x96,
    BalancerState: 0x97,
    AlarmFlags: 0x98,
    SetDischargeMosfet: 0xd9,
    SetChargeMosfet: 0xda,
};
/** Build the 8-byte payload for the MOSFET on/off writes (0xD9, 0xDA). */
function buildMosfetPayload(on) {
    const p = new Uint8Array(8);
    p[0] = on ? 1 : 0;
    return p;
}
/**
 * 0x90 — pack voltage / current / SOC.
 * Ported from reference.py:23-25:
 *   voltage = ((res[4]<<8)|res[5])/10.0
 *   current = (((res[8]<<8)|res[9]) - 30000)/10.0
 *   soc     = ((res[10]<<8)|res[11])/10.0
 * res[4..11] is `payload[0..7]` here.
 */
function parsePackMeasurements(payload) {
    return {
        voltage: (0, protocol_1.readU16BE)(payload, 0) / 10,
        current: ((0, protocol_1.readU16BE)(payload, 4) - 30000) / 10,
        soc: (0, protocol_1.readU16BE)(payload, 6) / 10,
    };
}
/** 0x91 — min/max cell voltage in mV plus 1-based cell numbers. */
function parseMinMaxCellVoltage(payload) {
    return {
        maxVoltage: (0, protocol_1.readU16BE)(payload, 0) / 1000,
        maxCellNumber: payload[2],
        minVoltage: (0, protocol_1.readU16BE)(payload, 3) / 1000,
        minCellNumber: payload[5],
    };
}
/** 0x92 — min/max temperature. DALY encodes as `actual + 40` (0 = -40°C). */
function parseMinMaxTemperature(payload) {
    return {
        maxTemperature: payload[0] - 40,
        maxSensorNumber: payload[1],
        minTemperature: payload[2] - 40,
        minSensorNumber: payload[3],
    };
}
/**
 * 0x94 — pack status info. Carries cell/temp-sensor counts used for
 * auto-discovery, plus charger/load presence and cycle count.
 */
function parseStatusInfo(payload) {
    return {
        cellCount: payload[0],
        tempSensorCount: payload[1],
        chargerConnected: payload[2] === 1,
        loadConnected: payload[3] === 1,
        cycleCount: (0, protocol_1.readU16BE)(payload, 5),
    };
}
/**
 * 0x93 — MOSFET / charger state and residual capacity.
 *   payload[0] = pack state (0 stationary, 1 charging, 2 discharging)
 *   payload[1] = charge MOS on/off
 *   payload[2] = discharge MOS on/off
 *   payload[3] = BMS lifecycle counter (heartbeat)
 *   payload[4..7] = residual capacity in mAh (UInt32BE)
 */
function parseMosfetStatus(payload) {
    const stateMap = ["stationary", "charging", "discharging"];
    return {
        state: stateMap[payload[0]] ?? "unknown",
        chargeMosOn: payload[1] === 1,
        dischargeMosOn: payload[2] === 1,
        bmsLife: payload[3],
        residualCapacityAh: payload.readUInt32BE(4) / 1000,
    };
}
/** 0x95 — single frame of three cell voltages. */
function parseCellVoltageFrame(payload) {
    return {
        frameIndex: payload[0],
        voltages: [
            (0, protocol_1.readU16BE)(payload, 1) / 1000,
            (0, protocol_1.readU16BE)(payload, 3) / 1000,
            (0, protocol_1.readU16BE)(payload, 5) / 1000,
        ],
    };
}
/**
 * Reassemble per-cell voltages from N frames. Throws if the received frame
 * index set isn't exactly {1..ceil(cellCount/3)} so a duplicated or missing
 * frame can't silently leave a cell at 0 V.
 */
function combineCellVoltageFrames(frames, cellCount) {
    const expected = Math.ceil(cellCount / 3);
    assertFrameIndexSet(frames.map(f => f.frameIndex), expected, "cell voltage");
    const out = new Array(cellCount).fill(0);
    for (const f of frames) {
        const base = (f.frameIndex - 1) * 3;
        for (let i = 0; i < 3; i++) {
            const idx = base + i;
            if (idx >= 0 && idx < cellCount)
                out[idx] = f.voltages[i];
        }
    }
    return out;
}
/**
 * 0x96 — temperatures: 7 sensors per frame, each 1 byte with the standard
 * DALY -40 offset (0 = -40 °C).
 */
function parseTemperatureFrame(payload) {
    const temps = [];
    for (let i = 1; i <= 7; i++)
        temps.push(payload[i] - 40);
    return { frameIndex: payload[0], temperatures: temps };
}
function combineTemperatureFrames(frames, sensorCount) {
    const expected = Math.ceil(sensorCount / 7);
    assertFrameIndexSet(frames.map(f => f.frameIndex), expected, "temperature");
    const out = new Array(sensorCount).fill(0);
    for (const f of frames) {
        const base = (f.frameIndex - 1) * 7;
        for (let i = 0; i < 7; i++) {
            const idx = base + i;
            if (idx >= 0 && idx < sensorCount)
                out[idx] = f.temperatures[i];
        }
    }
    return out;
}
function assertFrameIndexSet(received, expected, label) {
    if (received.length !== expected) {
        throw new Error(`${label}: expected ${expected} frame(s), got ${received.length}`);
    }
    const seen = new Set();
    for (const idx of received) {
        if (idx < 1 || idx > expected) {
            throw new Error(`${label}: frame index ${idx} out of range 1..${expected}`);
        }
        if (seen.has(idx)) {
            throw new Error(`${label}: duplicate frame index ${idx}`);
        }
        seen.add(idx);
    }
}
/**
 * Plausibility checks for parsed BMS values. Out-of-range values are
 * almost always wire glitches; refusing to publish them protects
 * downstream automations from operating on phantom data.
 */
exports.Bounds = {
    packVoltage: (v) => v >= 5 && v <= 500,
    packCurrent: (a) => a >= -500 && a <= 500,
    soc: (s) => s >= 0 && s <= 110,
    cellVoltage: (v) => v >= 0.5 && v <= 4.5,
    temperature: (t) => t >= -40 && t <= 100,
};
/**
 * 0x97 — balancer state. The first 6 payload bytes form a 48-bit bitmap;
 * bit `n` set means cell `n + 1` is currently balancing.
 */
function parseBalancerState(payload, cellCount) {
    const out = new Array(cellCount).fill(false);
    for (let i = 0; i < cellCount; i++) {
        const byte = payload[Math.floor(i / 8)] ?? 0;
        out[i] = (byte & (1 << i % 8)) !== 0;
    }
    return out;
}
exports.ALARM_FLAGS = [
    { byte: 0, bit: 0, key: "cellVHighL1", name: "Cell voltage high (level 1)" },
    { byte: 0, bit: 1, key: "cellVHighL2", name: "Cell voltage high (level 2)" },
    { byte: 0, bit: 2, key: "cellVLowL1", name: "Cell voltage low (level 1)" },
    { byte: 0, bit: 3, key: "cellVLowL2", name: "Cell voltage low (level 2)" },
    { byte: 0, bit: 4, key: "packVHighL1", name: "Pack voltage high (level 1)" },
    { byte: 0, bit: 5, key: "packVHighL2", name: "Pack voltage high (level 2)" },
    { byte: 0, bit: 6, key: "packVLowL1", name: "Pack voltage low (level 1)" },
    { byte: 0, bit: 7, key: "packVLowL2", name: "Pack voltage low (level 2)" },
    { byte: 1, bit: 0, key: "chgTempHighL1", name: "Charge temp high (level 1)" },
    { byte: 1, bit: 1, key: "chgTempHighL2", name: "Charge temp high (level 2)" },
    { byte: 1, bit: 2, key: "chgTempLowL1", name: "Charge temp low (level 1)" },
    { byte: 1, bit: 3, key: "chgTempLowL2", name: "Charge temp low (level 2)" },
    { byte: 1, bit: 4, key: "dchTempHighL1", name: "Discharge temp high (level 1)" },
    { byte: 1, bit: 5, key: "dchTempHighL2", name: "Discharge temp high (level 2)" },
    { byte: 1, bit: 6, key: "dchTempLowL1", name: "Discharge temp low (level 1)" },
    { byte: 1, bit: 7, key: "dchTempLowL2", name: "Discharge temp low (level 2)" },
    { byte: 2, bit: 0, key: "chgOcL1", name: "Charge over-current (level 1)" },
    { byte: 2, bit: 1, key: "chgOcL2", name: "Charge over-current (level 2)" },
    { byte: 2, bit: 2, key: "dchOcL1", name: "Discharge over-current (level 1)" },
    { byte: 2, bit: 3, key: "dchOcL2", name: "Discharge over-current (level 2)" },
    { byte: 2, bit: 4, key: "socHighL1", name: "SOC high (level 1)" },
    { byte: 2, bit: 5, key: "socHighL2", name: "SOC high (level 2)" },
    { byte: 2, bit: 6, key: "socLowL1", name: "SOC low (level 1)" },
    { byte: 2, bit: 7, key: "socLowL2", name: "SOC low (level 2)" },
    { byte: 3, bit: 0, key: "diffVoltL1", name: "Cell voltage diff (level 1)" },
    { byte: 3, bit: 1, key: "diffVoltL2", name: "Cell voltage diff (level 2)" },
    { byte: 3, bit: 2, key: "diffTempL1", name: "Cell temp diff (level 1)" },
    { byte: 3, bit: 3, key: "diffTempL2", name: "Cell temp diff (level 2)" },
    { byte: 4, bit: 0, key: "chgMosTempHigh", name: "Charge MOSFET temp high" },
    { byte: 4, bit: 1, key: "dchMosTempHigh", name: "Discharge MOSFET temp high" },
    { byte: 4, bit: 2, key: "chgMosSensorErr", name: "Charge MOSFET temp sensor error" },
    { byte: 4, bit: 3, key: "dchMosSensorErr", name: "Discharge MOSFET temp sensor error" },
    { byte: 4, bit: 4, key: "chgMosStuck", name: "Charge MOSFET stuck" },
    { byte: 4, bit: 5, key: "dchMosStuck", name: "Discharge MOSFET stuck" },
    { byte: 4, bit: 6, key: "chgMosOpen", name: "Charge MOSFET open" },
    { byte: 4, bit: 7, key: "dchMosOpen", name: "Discharge MOSFET open" },
    { byte: 5, bit: 0, key: "afeCollectErr", name: "AFE collect error" },
    { byte: 5, bit: 1, key: "voltSensorErr", name: "Voltage sensor error" },
    { byte: 5, bit: 2, key: "tempSensorErr", name: "Temperature sensor error" },
    { byte: 5, bit: 3, key: "eepromErr", name: "EEPROM error" },
    { byte: 5, bit: 4, key: "rtcErr", name: "RTC error" },
    { byte: 5, bit: 5, key: "preChargeFail", name: "Pre-charge failure" },
    { byte: 5, bit: 6, key: "commFail", name: "Communication failure" },
    { byte: 5, bit: 7, key: "internalCommFail", name: "Internal communication failure" },
    { byte: 6, bit: 0, key: "cellNumErr", name: "Cell count mismatch" },
    { byte: 6, bit: 1, key: "currentSensorErr", name: "Current sensor error" },
    { byte: 6, bit: 2, key: "balanceErr", name: "Cell balancing error" },
    { byte: 6, bit: 3, key: "thermalProtect", name: "Battery thermal protection" },
];
function parseAlarmFlags(payload) {
    const out = {};
    for (const f of exports.ALARM_FLAGS) {
        out[f.key] = ((payload[f.byte] ?? 0) & (1 << f.bit)) !== 0;
    }
    return out;
}
//# sourceMappingURL=commands.js.map