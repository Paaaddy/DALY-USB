import { readU16BE } from "./protocol";

/** Hard upper bounds from the DALY UART spec. Values above these are taken to be garbage. */
export const MAX_CELLS = 48;
export const MAX_TEMP_SENSORS = 16;

export const CommandId = {
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
} as const;
export type CommandId = (typeof CommandId)[keyof typeof CommandId];

/** Build the 8-byte payload for the MOSFET on/off writes (0xD9, 0xDA). */
export function buildMosfetPayload(on: boolean): Uint8Array {
    const p = new Uint8Array(8);
    p[0] = on ? 1 : 0;
    return p;
}

export interface PackMeasurements {
    voltage: number;
    current: number;
    soc: number;
}

/**
 * 0x90 — pack voltage / current / SOC.
 * Ported from reference.py:23-25:
 *   voltage = ((res[4]<<8)|res[5])/10.0
 *   current = (((res[8]<<8)|res[9]) - 30000)/10.0
 *   soc     = ((res[10]<<8)|res[11])/10.0
 * res[4..11] is `payload[0..7]` here.
 */
export function parsePackMeasurements(payload: Buffer): PackMeasurements {
    return {
        voltage: readU16BE(payload, 0) / 10,
        current: (readU16BE(payload, 4) - 30000) / 10,
        soc: readU16BE(payload, 6) / 10,
    };
}

export interface MinMaxCellVoltage {
    maxVoltage: number;
    maxCellNumber: number;
    minVoltage: number;
    minCellNumber: number;
}

/** 0x91 — min/max cell voltage in mV plus 1-based cell numbers. */
export function parseMinMaxCellVoltage(payload: Buffer): MinMaxCellVoltage {
    return {
        maxVoltage: readU16BE(payload, 0) / 1000,
        maxCellNumber: payload[2],
        minVoltage: readU16BE(payload, 3) / 1000,
        minCellNumber: payload[5],
    };
}

export interface MinMaxTemperature {
    maxTemperature: number;
    maxSensorNumber: number;
    minTemperature: number;
    minSensorNumber: number;
}

/** 0x92 — min/max temperature. DALY encodes as `actual + 40` (0 = -40°C). */
export function parseMinMaxTemperature(payload: Buffer): MinMaxTemperature {
    return {
        maxTemperature: payload[0] - 40,
        maxSensorNumber: payload[1],
        minTemperature: payload[2] - 40,
        minSensorNumber: payload[3],
    };
}

export interface StatusInfo {
    cellCount: number;
    tempSensorCount: number;
    chargerConnected: boolean;
    loadConnected: boolean;
    cycleCount: number;
}

/**
 * 0x94 — pack status info. Carries cell/temp-sensor counts used for
 * auto-discovery, plus charger/load presence and cycle count.
 */
export function parseStatusInfo(payload: Buffer): StatusInfo {
    return {
        cellCount: payload[0],
        tempSensorCount: payload[1],
        chargerConnected: payload[2] === 1,
        loadConnected: payload[3] === 1,
        cycleCount: readU16BE(payload, 5),
    };
}

export type BmsState = "stationary" | "charging" | "discharging" | "unknown";

export interface MosfetStatus {
    state: BmsState;
    chargeMosOn: boolean;
    dischargeMosOn: boolean;
    bmsLife: number;
    residualCapacityAh: number;
}

/**
 * 0x93 — MOSFET / charger state and residual capacity.
 *   payload[0] = pack state (0 stationary, 1 charging, 2 discharging)
 *   payload[1] = charge MOS on/off
 *   payload[2] = discharge MOS on/off
 *   payload[3] = BMS lifecycle counter (heartbeat)
 *   payload[4..7] = residual capacity in mAh (UInt32BE)
 */
export function parseMosfetStatus(payload: Buffer): MosfetStatus {
    const stateMap: BmsState[] = ["stationary", "charging", "discharging"];
    return {
        state: stateMap[payload[0]] ?? "unknown",
        chargeMosOn: payload[1] === 1,
        dischargeMosOn: payload[2] === 1,
        bmsLife: payload[3],
        residualCapacityAh: payload.readUInt32BE(4) / 1000,
    };
}

export interface CellVoltageFrame {
    frameIndex: number;
    voltages: [number, number, number];
}

/** 0x95 — single frame of three cell voltages. */
export function parseCellVoltageFrame(payload: Buffer): CellVoltageFrame {
    return {
        frameIndex: payload[0],
        voltages: [
            readU16BE(payload, 1) / 1000,
            readU16BE(payload, 3) / 1000,
            readU16BE(payload, 5) / 1000,
        ],
    };
}

/**
 * Reassemble per-cell voltages from N frames. Throws if the received frame
 * index set isn't exactly {1..ceil(cellCount/3)} so a duplicated or missing
 * frame can't silently leave a cell at 0 V.
 */
export function combineCellVoltageFrames(
    frames: readonly CellVoltageFrame[],
    cellCount: number,
): number[] {
    const expected = Math.ceil(cellCount / 3);
    assertFrameIndexSet(
        frames.map(f => f.frameIndex),
        expected,
        "cell voltage",
    );
    const out = new Array<number>(cellCount).fill(0);
    for (const f of frames) {
        const base = (f.frameIndex - 1) * 3;
        for (let i = 0; i < 3; i++) {
            const idx = base + i;
            if (idx >= 0 && idx < cellCount) out[idx] = f.voltages[i];
        }
    }
    return out;
}

export interface TemperatureFrame {
    frameIndex: number;
    temperatures: number[];
}

/**
 * 0x96 — temperatures: 7 sensors per frame, each 1 byte with the standard
 * DALY -40 offset (0 = -40 °C).
 */
export function parseTemperatureFrame(payload: Buffer): TemperatureFrame {
    if (payload.length < 8) throw new Error(`truncated temperature frame (got ${payload.length} bytes, expected 8)`);
    const temps: number[] = [];
    for (let i = 1; i <= 7; i++) temps.push(payload[i] - 40);
    return { frameIndex: payload[0], temperatures: temps };
}

export function combineTemperatureFrames(
    frames: readonly TemperatureFrame[],
    sensorCount: number,
): number[] {
    const expected = Math.ceil(sensorCount / 7);
    assertFrameIndexSet(
        frames.map(f => f.frameIndex),
        expected,
        "temperature",
    );
    const out = new Array<number>(sensorCount).fill(0);
    for (const f of frames) {
        const base = (f.frameIndex - 1) * 7;
        for (let i = 0; i < 7; i++) {
            const idx = base + i;
            if (idx >= 0 && idx < sensorCount) out[idx] = f.temperatures[i];
        }
    }
    return out;
}

function assertFrameIndexSet(received: readonly number[], expected: number, label: string): void {
    if (received.length !== expected) {
        throw new Error(
            `${label}: expected ${expected} frame(s), got ${received.length}`,
        );
    }
    const seen = new Set<number>();
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
export const Bounds = {
    packVoltage: (v: number): boolean => v >= 5 && v <= 500,
    packCurrent: (a: number): boolean => a >= -500 && a <= 500,
    soc: (s: number): boolean => s >= 0 && s <= 110,
    cellVoltage: (v: number): boolean => v >= 0.5 && v <= 4.5,
    temperature: (t: number): boolean => t >= -40 && t <= 100,
} as const;

/**
 * 0x97 — balancer state. The first 6 payload bytes form a 48-bit bitmap;
 * bit `n` set means cell `n + 1` is currently balancing.
 */
export function parseBalancerState(payload: Buffer, cellCount: number): boolean[] {
    const neededBytes = Math.ceil(cellCount / 8);
    if (payload.length < neededBytes) {
        throw new Error(`truncated balancer state (need ${neededBytes} bytes for ${cellCount} cells, got ${payload.length})`);
    }
    const out = new Array<boolean>(cellCount).fill(false);
    for (let i = 0; i < cellCount; i++) {
        const byte = payload[Math.floor(i / 8)] ?? 0;
        out[i] = (byte & (1 << i % 8)) !== 0;
    }
    return out;
}

/**
 * 0x98 — alarm/fault flag table. Bit positions follow the V1.2 protocol
 * doc; unused bits are simply absent from this list.
 */
export interface AlarmFlagDef {
    byte: number;
    bit: number;
    key: string;
    name: string;
}

export const ALARM_FLAGS: readonly AlarmFlagDef[] = [
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

export function parseAlarmFlags(payload: Buffer): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const f of ALARM_FLAGS) {
        out[f.key] = ((payload[f.byte] ?? 0) & (1 << f.bit)) !== 0;
    }
    return out;
}
