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
