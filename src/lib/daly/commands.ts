import { readU16BE } from "./protocol";

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
} as const;
export type CommandId = (typeof CommandId)[keyof typeof CommandId];

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
