import { expect } from "chai";
import {
    ALARM_FLAGS,
    Bounds,
    buildMosfetPayload,
    combineCellVoltageFrames,
    combineTemperatureFrames,
    parseAlarmFlags,
    parseBalancerState,
    parseCellVoltageFrame,
    parseMinMaxCellVoltage,
    parseMinMaxTemperature,
    parseMosfetStatus,
    parsePackMeasurements,
    parseStatusInfo,
    parseTemperatureFrame,
} from "./commands";

const buf = (...bytes: number[]): Buffer => Buffer.from(bytes);

describe("parsePackMeasurements", () => {
    it("decodes voltage / current / soc from a real-shape payload", () => {
        // voltage=53.0V -> 530 -> 0x0212
        // current=10.0A -> raw=30100 -> 0x7594
        // soc=85.5% -> 855 -> 0x0357
        const r = parsePackMeasurements(buf(0x02, 0x12, 0, 0, 0x75, 0x94, 0x03, 0x57));
        expect(r.voltage).to.be.closeTo(53.0, 1e-9);
        expect(r.current).to.be.closeTo(10.0, 1e-9);
        expect(r.soc).to.be.closeTo(85.5, 1e-9);
    });

    it("encodes negative current via the 30000 offset", () => {
        // current=-5.0A -> raw=29950 -> 0x74FE
        const r = parsePackMeasurements(buf(0x02, 0x12, 0, 0, 0x74, 0xfe, 0x03, 0x57));
        expect(r.current).to.be.closeTo(-5.0, 1e-9);
    });
});

describe("parseMinMaxCellVoltage", () => {
    it("decodes max/min mV and 1-based cell numbers", () => {
        // max 3752 mV cell 5, min 3740 mV cell 2
        const r = parseMinMaxCellVoltage(buf(0x0e, 0xa8, 5, 0x0e, 0x9c, 2, 0, 0));
        expect(r.maxVoltage).to.be.closeTo(3.752, 1e-9);
        expect(r.maxCellNumber).to.equal(5);
        expect(r.minVoltage).to.be.closeTo(3.74, 1e-9);
        expect(r.minCellNumber).to.equal(2);
    });
});

describe("parseMinMaxTemperature", () => {
    it("applies the -40 offset", () => {
        const r = parseMinMaxTemperature(buf(60, 1, 50, 2, 0, 0, 0, 0));
        expect(r.maxTemperature).to.equal(20);
        expect(r.minTemperature).to.equal(10);
    });
});

describe("parseStatusInfo", () => {
    it("returns cell + temp counts and cycle count", () => {
        // cellCount=16, tempCount=4, charger=true, load=false, cycle=42
        const r = parseStatusInfo(buf(16, 4, 1, 0, 0, 0x00, 0x2a, 0));
        expect(r.cellCount).to.equal(16);
        expect(r.tempSensorCount).to.equal(4);
        expect(r.chargerConnected).to.equal(true);
        expect(r.loadConnected).to.equal(false);
        expect(r.cycleCount).to.equal(42);
    });
});

describe("parseMosfetStatus", () => {
    it("decodes state, MOS flags, and residual capacity in Ah", () => {
        // state=charging(1), chgMos=1, dchMos=0, life=200, residual = 50_000 mAh = 50 Ah
        const r = parseMosfetStatus(buf(1, 1, 0, 200, 0x00, 0x00, 0xc3, 0x50));
        expect(r.state).to.equal("charging");
        expect(r.chargeMosOn).to.equal(true);
        expect(r.dischargeMosOn).to.equal(false);
        expect(r.bmsLife).to.equal(200);
        expect(r.residualCapacityAh).to.be.closeTo(50.0, 1e-9);
    });

    it("falls back to 'unknown' for unexpected state bytes", () => {
        const r = parseMosfetStatus(buf(9, 0, 0, 0, 0, 0, 0, 0));
        expect(r.state).to.equal("unknown");
    });
});

describe("cell voltage frames", () => {
    it("parses one frame's three voltages", () => {
        const f = parseCellVoltageFrame(buf(2, 0x0c, 0xe4, 0x0c, 0xe5, 0x0c, 0xe6, 0));
        expect(f.frameIndex).to.equal(2);
        expect(f.voltages.map(v => Math.round(v * 1000))).to.deep.equal([3300, 3301, 3302]);
    });

    it("reassembles 8 cells from 3 frames in any order", () => {
        const fr1 = parseCellVoltageFrame(buf(1, 0x0c, 0xe4, 0x0c, 0xe5, 0x0c, 0xe6, 0));
        const fr2 = parseCellVoltageFrame(buf(2, 0x0c, 0xe7, 0x0c, 0xe8, 0x0c, 0xe9, 0));
        const fr3 = parseCellVoltageFrame(buf(3, 0x0c, 0xea, 0x0c, 0xeb, 0x00, 0x00, 0));
        const out = combineCellVoltageFrames([fr3, fr1, fr2], 8);
        expect(out.map(v => Math.round(v * 1000))).to.deep.equal([
            3300, 3301, 3302, 3303, 3304, 3305, 3306, 3307,
        ]);
    });

    it("rejects an out-of-range frame index", () => {
        const fr = parseCellVoltageFrame(buf(99, 1, 1, 1, 1, 1, 1, 0));
        // cellCount=3 -> expected=1 frame, so a frameIndex of 99 is out of range
        expect(() => combineCellVoltageFrames([fr], 3)).to.throw(/out of range/);
    });

    it("rejects a duplicated frame index", () => {
        const a = parseCellVoltageFrame(buf(1, 0x0c, 0xe4, 0x0c, 0xe5, 0x0c, 0xe6, 0));
        const b = parseCellVoltageFrame(buf(1, 0x0c, 0xe7, 0x0c, 0xe8, 0x0c, 0xe9, 0));
        const c = parseCellVoltageFrame(buf(3, 0x0c, 0xea, 0x0c, 0xeb, 0x00, 0x00, 0));
        expect(() => combineCellVoltageFrames([a, b, c], 8)).to.throw(/duplicate frame index/);
    });

    it("rejects a missing frame (only 2 of 3 received)", () => {
        const a = parseCellVoltageFrame(buf(1, 0x0c, 0xe4, 0x0c, 0xe5, 0x0c, 0xe6, 0));
        const c = parseCellVoltageFrame(buf(3, 0x0c, 0xea, 0x0c, 0xeb, 0x00, 0x00, 0));
        expect(() => combineCellVoltageFrames([a, c], 8)).to.throw(/expected 3 frame/);
    });
});

describe("temperature frames", () => {
    it("packs 7 sensors per frame with the -40 offset", () => {
        const f = parseTemperatureFrame(buf(1, 60, 50, 40, 30, 20, 10, 0));
        expect(f.temperatures).to.deep.equal([20, 10, 0, -10, -20, -30, -40]);
    });

    it("reassembles 4 sensors from one frame", () => {
        const fr = parseTemperatureFrame(buf(1, 60, 61, 62, 63, 0, 0, 0));
        const out = combineTemperatureFrames([fr], 4);
        expect(out).to.deep.equal([20, 21, 22, 23]);
    });

    it("rejects a duplicated temperature frame index", () => {
        const a = parseTemperatureFrame(buf(1, 60, 60, 60, 60, 60, 60, 60));
        const b = parseTemperatureFrame(buf(1, 60, 60, 60, 60, 60, 60, 60));
        expect(() => combineTemperatureFrames([a, b], 8)).to.throw(/duplicate frame index/);
    });

    it("rejects an out-of-range temperature frame index", () => {
        const fr = parseTemperatureFrame(buf(99, 60, 60, 60, 60, 60, 60, 60));
        expect(() => combineTemperatureFrames([fr], 4)).to.throw(/out of range/);
    });
});

describe("parseBalancerState", () => {
    it("maps bits to per-cell booleans", () => {
        // 0b10101010 = cells 2,4,6,8 balancing in low byte; bit 0 = cell 1
        const out = parseBalancerState(buf(0xaa, 0x00, 0, 0, 0, 0, 0, 0), 8);
        expect(out).to.deep.equal([false, true, false, true, false, true, false, true]);
    });

    it("spans byte boundaries for >8 cells", () => {
        // cell 9 = bit 0 of byte 1
        const out = parseBalancerState(buf(0x00, 0x01, 0, 0, 0, 0, 0, 0), 10);
        expect(out[8]).to.equal(true);
        expect(out[9]).to.equal(false);
    });
});

describe("parseAlarmFlags", () => {
    it("extracts the documented bits and ignores unrelated ones", () => {
        // byte 0 bit 0 = cellVHighL1
        const r = parseAlarmFlags(buf(0x01, 0, 0, 0, 0, 0, 0, 0));
        expect(r.cellVHighL1).to.equal(true);
        expect(r.cellVHighL2).to.equal(false);
        expect(Object.keys(r).length).to.equal(ALARM_FLAGS.length);
    });
});

describe("buildMosfetPayload", () => {
    it("emits a zero-padded 8-byte payload", () => {
        expect(Array.from(buildMosfetPayload(true))).to.deep.equal([1, 0, 0, 0, 0, 0, 0, 0]);
        expect(Array.from(buildMosfetPayload(false))).to.deep.equal([0, 0, 0, 0, 0, 0, 0, 0]);
    });
});

describe("Bounds", () => {
    it("packVoltage rejects 0 V and 600 V, accepts 50 V and 200 V (HV pack)", () => {
        expect(Bounds.packVoltage(0)).to.equal(false);
        expect(Bounds.packVoltage(600)).to.equal(false);
        expect(Bounds.packVoltage(50)).to.equal(true);
        expect(Bounds.packVoltage(200)).to.equal(true);
    });

    it("soc rejects -1 % and 200 %, accepts 0..110", () => {
        expect(Bounds.soc(-1)).to.equal(false);
        expect(Bounds.soc(200)).to.equal(false);
        expect(Bounds.soc(0)).to.equal(true);
        expect(Bounds.soc(110)).to.equal(true);
    });

    it("packCurrent accepts the +/-500 A range and rejects beyond", () => {
        expect(Bounds.packCurrent(-501)).to.equal(false);
        expect(Bounds.packCurrent(501)).to.equal(false);
        expect(Bounds.packCurrent(-300)).to.equal(true);
        expect(Bounds.packCurrent(300)).to.equal(true);
    });

    it("cellVoltage rejects a phantom 0 V from a missing frame", () => {
        expect(Bounds.cellVoltage(0)).to.equal(false);
        expect(Bounds.cellVoltage(3.3)).to.equal(true);
        expect(Bounds.cellVoltage(5)).to.equal(false);
    });

    it("temperature rejects values below the -40 floor and above 100 °C", () => {
        expect(Bounds.temperature(-41)).to.equal(false);
        expect(Bounds.temperature(101)).to.equal(false);
        expect(Bounds.temperature(25)).to.equal(true);
    });
});
