"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const utils = __importStar(require("@iobroker/adapter-core"));
const commands_1 = require("./lib/daly/commands");
const poller_1 = require("./lib/daly/poller");
const protocol_1 = require("./lib/daly/protocol");
const transport_1 = require("./lib/daly/transport");
const CONNECTION_DOWN_AFTER_FAILED_TICKS = 3;
const HEARTBEAT_STUCK_LIMIT = 5;
const MOSFET_WRITE_DEBOUNCE_MS = 2000;
class DalyUsbAdapter extends utils.Adapter {
    transport;
    poller;
    bms;
    lastVoltage = NaN;
    readRequestCache = new Map();
    failureSignatures = new Map();
    consecutiveTickFailures = 0;
    connectionDown = true;
    lastBmsLife;
    bmsLifeStuckCount = 0;
    lastMosfetWriteAt = 0;
    constructor(options = {}) {
        super({ ...options, name: "daly-usb" });
        this.on("ready", this.onReady.bind(this));
        this.on("unload", this.onUnload.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
    }
    async onReady() {
        await this.setState("info.connection", false, true);
        await this.ensureCoreObjects();
        await this.ensureAlarmObjects();
        if (!this.config.serialPort) {
            this.log.error("serialPort is not configured. Set it in the adapter settings (e.g. /dev/serial/by-id/...).");
            return;
        }
        const serialPort = this.config.serialPort.trim();
        if (!/^(\/dev\/tty|\/dev\/serial\/)/.test(serialPort) || serialPort.includes("..")) {
            this.log.error(`invalid serialPort "${serialPort}": must be under /dev/tty* or /dev/serial/by-id/`);
            return;
        }
        const baudRate = Number(this.config.baudRate);
        const pollIntervalMs = Number(this.config.pollIntervalMs);
        const requestTimeoutMs = Number(this.config.requestTimeoutMs);
        if (!baudRate || baudRate < 300 || baudRate > 115200) {
            this.log.error(`invalid baudRate ${baudRate}: must be between 300 and 115200`);
            return;
        }
        if (!pollIntervalMs || pollIntervalMs < 500) {
            this.log.error(`invalid pollIntervalMs ${pollIntervalMs}: must be >= 500`);
            return;
        }
        if (!requestTimeoutMs || requestTimeoutMs < 100) {
            this.log.error(`invalid requestTimeoutMs ${requestTimeoutMs}: must be >= 100`);
            return;
        }
        if (this.config.allowMosfetWrites) {
            this.log.error("*** MOSFET WRITES ENABLED *** The adapter can now disconnect the battery " +
                "from the load or charger. Automations that write control.chargeMosfet / " +
                "control.dischargeMosfet will send real commands to hardware. " +
                "If this was unintended, disable allowMosfetWrites and restart.");
        }
        this.transport = new transport_1.DalyTransport({
            path: serialPort,
            baudRate,
            requestTimeoutMs,
            log: this.log,
        });
        try {
            await this.transport.open();
            this.log.info(`opened ${this.config.serialPort} @ ${this.config.baudRate} baud`);
        }
        catch (err) {
            this.log.error(`failed to open serial port: ${err.message}`);
            return;
        }
        try {
            this.bms = await this.discover();
            this.log.info(`discovered BMS: ${this.bms.cellCount} cells, ${this.bms.tempSensorCount} temp sensors`);
            await this.syncDynamicObjects(this.bms);
        }
        catch (err) {
            this.log.error(`discovery failed: ${err.message}`);
            return;
        }
        if (this.config.allowMosfetWrites) {
            this.subscribeStates("control.*");
        }
        else {
            this.log.info("MOSFET writes disabled by config; control.* states are read-only until allowMosfetWrites is enabled");
        }
        this.poller = new poller_1.Poller(pollIntervalMs, () => this.poll(), this.log);
        this.poller.start();
    }
    async discover() {
        const RETRIES = 3;
        const RETRY_DELAY_MS = 1000;
        let lastErr;
        for (let attempt = 1; attempt <= RETRIES; attempt++) {
            try {
                const status = await this.runCommand(commands_1.CommandId.StatusInfo, 1, commands_1.parseStatusInfo);
                if (status.cellCount === 0 || status.tempSensorCount === 0) {
                    throw new Error(`BMS reported impossible config (cells=${status.cellCount}, temps=${status.tempSensorCount})`);
                }
                if (status.cellCount > commands_1.MAX_CELLS) {
                    throw new Error(`BMS reported ${status.cellCount} cells, exceeds protocol max of ${commands_1.MAX_CELLS} — refusing to trust`);
                }
                if (status.tempSensorCount > commands_1.MAX_TEMP_SENSORS) {
                    throw new Error(`BMS reported ${status.tempSensorCount} temp sensors, exceeds protocol max of ${commands_1.MAX_TEMP_SENSORS} — refusing to trust`);
                }
                return { cellCount: status.cellCount, tempSensorCount: status.tempSensorCount };
            }
            catch (err) {
                lastErr = err;
                if (attempt < RETRIES) {
                    this.log.warn(`discovery attempt ${attempt} failed (${lastErr.message}), retrying in ${RETRY_DELAY_MS}ms…`);
                    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                }
            }
        }
        throw lastErr;
    }
    async poll() {
        if (!this.transport || !this.bms)
            return;
        let anyFailure = false;
        const wrap = async (label, fn) => {
            const ok = await this.guarded(label, fn);
            if (!ok)
                anyFailure = true;
        };
        await wrap("0x90", () => this.tickPackMeasurements());
        await wrap("0x91", () => this.tickMinMaxCellVoltage());
        await wrap("0x92", () => this.tickMinMaxTemperature());
        await wrap("0x93", () => this.tickMosfetStatus());
        await wrap("0x94", () => this.tickStatusInfo());
        await wrap("0x95", () => this.tickCellVoltages(this.bms.cellCount));
        await wrap("0x96", () => this.tickTemperatures(this.bms.tempSensorCount));
        await wrap("0x97", () => this.tickBalancer(this.bms.cellCount));
        await wrap("0x98", () => this.tickAlarms());
        if (anyFailure) {
            this.consecutiveTickFailures++;
            if (this.consecutiveTickFailures >= CONNECTION_DOWN_AFTER_FAILED_TICKS &&
                !this.connectionDown) {
                this.connectionDown = true;
                await this.setState("info.connection", false, true);
                await this.setState("info.chargeMosOn", null, true);
                await this.setState("info.dischargeMosOn", null, true);
                this.log.warn(`${this.consecutiveTickFailures} consecutive ticks with failures — flagging info.connection=false`);
            }
        }
        else {
            this.consecutiveTickFailures = 0;
            if (this.connectionDown) {
                this.connectionDown = false;
                await this.setState("info.connection", true, true);
                this.log.info("info.connection restored");
            }
            await this.setStateChangedAsync("info.lastSuccessfulTick", new Date().toISOString(), true);
        }
    }
    async tickPackMeasurements() {
        const m = await this.runCommand(commands_1.CommandId.PackMeasurements, 1, commands_1.parsePackMeasurements);
        if (!commands_1.Bounds.packVoltage(m.voltage)) {
            throw new Error(`pack voltage out of range: ${m.voltage} V`);
        }
        const maxVoltage = this.bms.cellCount * 4.5;
        if (m.voltage > maxVoltage) {
            throw new Error(`pack voltage ${m.voltage} V exceeds cell-count ceiling ${maxVoltage} V` +
                ` (${this.bms.cellCount} cells × 4.5 V/cell)`);
        }
        if (!commands_1.Bounds.packCurrent(m.current)) {
            throw new Error(`pack current out of range: ${m.current} A`);
        }
        if (!commands_1.Bounds.soc(m.soc)) {
            throw new Error(`SOC out of range: ${m.soc} %`);
        }
        this.lastVoltage = m.voltage;
        await this.setStateChangedAsync("info.voltage", m.voltage, true);
        await this.setStateChangedAsync("info.current", m.current, true);
        await this.setStateChangedAsync("info.soc", m.soc, true);
    }
    async tickMinMaxCellVoltage() {
        const m = await this.runCommand(commands_1.CommandId.MinMaxCellVoltage, 1, commands_1.parseMinMaxCellVoltage);
        if (!commands_1.Bounds.cellVoltage(m.minVoltage) || !commands_1.Bounds.cellVoltage(m.maxVoltage)) {
            throw new Error(`min/max cell V out of range: min=${m.minVoltage} max=${m.maxVoltage}`);
        }
        await this.setStateChangedAsync("info.minCellVoltage", m.minVoltage, true);
        await this.setStateChangedAsync("info.maxCellVoltage", m.maxVoltage, true);
        await this.setStateChangedAsync("info.minCellNumber", m.minCellNumber, true);
        await this.setStateChangedAsync("info.maxCellNumber", m.maxCellNumber, true);
        await this.setStateChangedAsync("info.cellDiff", Number((m.maxVoltage - m.minVoltage).toFixed(3)), true);
    }
    async tickMinMaxTemperature() {
        const m = await this.runCommand(commands_1.CommandId.MinMaxTemperature, 1, commands_1.parseMinMaxTemperature);
        if (!commands_1.Bounds.temperature(m.minTemperature) || !commands_1.Bounds.temperature(m.maxTemperature)) {
            throw new Error(`min/max temp out of range: min=${m.minTemperature} max=${m.maxTemperature}`);
        }
        await this.setStateChangedAsync("info.minTemperature", m.minTemperature, true);
        await this.setStateChangedAsync("info.maxTemperature", m.maxTemperature, true);
        await this.setStateChangedAsync("info.minSensorNumber", m.minSensorNumber, true);
        await this.setStateChangedAsync("info.maxSensorNumber", m.maxSensorNumber, true);
    }
    async tickMosfetStatus() {
        const m = await this.runCommand(commands_1.CommandId.MosfetStatus, 1, commands_1.parseMosfetStatus);
        if (this.lastBmsLife !== undefined) {
            if (m.bmsLife === this.lastBmsLife) {
                this.bmsLifeStuckCount++;
            }
            else {
                this.bmsLifeStuckCount = 0;
            }
        }
        this.lastBmsLife = m.bmsLife;
        if (this.bmsLifeStuckCount >= HEARTBEAT_STUCK_LIMIT) {
            throw new Error(`BMS heartbeat (bmsLife) unchanged for ${this.bmsLifeStuckCount} reads — BMS may be locked up`);
        }
        await this.setStateChangedAsync("info.bmsState", m.state, true);
        await this.setStateChangedAsync("info.chargeMosOn", m.chargeMosOn, true);
        await this.setStateChangedAsync("info.dischargeMosOn", m.dischargeMosOn, true);
        await this.setStateChangedAsync("info.bmsLife", m.bmsLife, true);
        await this.setStateChangedAsync("info.residualCapacity", Number(m.residualCapacityAh.toFixed(3)), true);
        if (!isNaN(this.lastVoltage)) {
            const energyKwh = (m.residualCapacityAh * this.lastVoltage) / 1000;
            await this.setStateChangedAsync("info.energyRemaining", Number(energyKwh.toFixed(3)), true);
        }
    }
    async tickStatusInfo() {
        const s = await this.runCommand(commands_1.CommandId.StatusInfo, 1, commands_1.parseStatusInfo);
        await this.setStateChangedAsync("info.cycleCount", s.cycleCount, true);
        await this.setStateChangedAsync("info.chargerConnected", s.chargerConnected, true);
        await this.setStateChangedAsync("info.loadConnected", s.loadConnected, true);
    }
    async tickCellVoltages(cellCount) {
        const frames = Math.ceil(cellCount / 3);
        const parsed = await this.runCommandMulti(commands_1.CommandId.CellVoltages, frames, commands_1.parseCellVoltageFrame);
        const voltages = (0, commands_1.combineCellVoltageFrames)(parsed, cellCount);
        for (let i = 0; i < voltages.length; i++) {
            if (!commands_1.Bounds.cellVoltage(voltages[i])) {
                throw new Error(`cell ${i + 1} voltage out of range: ${voltages[i]} V`);
            }
        }
        for (let i = 0; i < voltages.length; i++) {
            await this.setStateChangedAsync(`cells.cell_${i + 1}`, Number(voltages[i].toFixed(3)), true);
        }
    }
    async tickTemperatures(sensorCount) {
        const frames = Math.ceil(sensorCount / 7);
        const parsed = await this.runCommandMulti(commands_1.CommandId.TemperatureSensors, frames, commands_1.parseTemperatureFrame);
        const temps = (0, commands_1.combineTemperatureFrames)(parsed, sensorCount);
        for (let i = 0; i < temps.length; i++) {
            if (!commands_1.Bounds.temperature(temps[i])) {
                throw new Error(`sensor ${i + 1} temp out of range: ${temps[i]} °C`);
            }
        }
        for (let i = 0; i < temps.length; i++) {
            await this.setStateChangedAsync(`temps.sensor_${i + 1}`, temps[i], true);
        }
    }
    async tickBalancer(cellCount) {
        if (!this.transport)
            throw new Error("transport not initialised");
        const req = this.readRequest(commands_1.CommandId.BalancerState);
        const [frame] = await this.transport.request(req, 1, commands_1.CommandId.BalancerState);
        const flags = (0, commands_1.parseBalancerState)(frame.payload, cellCount);
        for (let i = 0; i < flags.length; i++) {
            await this.setStateChangedAsync(`balancer.cell_${i + 1}`, flags[i], true);
        }
    }
    async tickAlarms() {
        const flags = await this.runCommand(commands_1.CommandId.AlarmFlags, 1, commands_1.parseAlarmFlags);
        for (const def of commands_1.ALARM_FLAGS) {
            await this.setStateChangedAsync(`alarms.${def.key}`, flags[def.key] ?? false, true);
        }
        await this.setStateChangedAsync("info.lastAlarmUpdate", new Date().toISOString(), true);
    }
    async runCommand(command, expectedFrames, parse) {
        if (!this.transport)
            throw new Error("transport not initialised");
        const req = this.readRequest(command);
        const [frame] = await this.transport.request(req, expectedFrames, command);
        return parse(frame.payload);
    }
    async runCommandMulti(command, expectedFrames, parse) {
        if (!this.transport)
            throw new Error("transport not initialised");
        const req = this.readRequest(command);
        const frames = await this.transport.request(req, expectedFrames, command);
        return frames.map(f => parse(f.payload));
    }
    readRequest(command) {
        let buf = this.readRequestCache.get(command);
        if (!buf) {
            buf = (0, protocol_1.buildRequest)(this.config.hostAddress, command);
            this.readRequestCache.set(command, buf);
        }
        return buf;
    }
    /**
     * Run `fn`. Returns true on success, false on any thrown error. On error,
     * log only the first occurrence of a particular message at warn level;
     * identical repeats drop to debug to avoid filling the log when a BMS is
     * unplugged. Recovery is logged once at info.
     */
    async guarded(label, fn) {
        try {
            await fn();
            if (this.failureSignatures.has(label)) {
                this.failureSignatures.delete(label);
                this.log.info(`${label} recovered`);
            }
            return true;
        }
        catch (err) {
            const msg = err.message;
            if (this.failureSignatures.get(label) === msg) {
                this.log.debug(`${label} failed (repeat): ${msg}`);
            }
            else {
                this.failureSignatures.set(label, msg);
                this.log.warn(`${label} failed: ${msg}`);
            }
            return false;
        }
    }
    async ensureCoreObjects() {
        await this.makeChannel("cells", "Per-cell voltages");
        await this.makeChannel("temps", "Temperature sensors");
        await this.makeChannel("balancer", "Cell balancer state");
        await this.makeChannel("alarms", "Alarm flags");
        await this.makeChannel("control", "Writable controls");
        await this.makeWritableBool("control.chargeMosfet", "Charge MOSFET on/off", "switch.power");
        await this.makeWritableBool("control.dischargeMosfet", "Discharge MOSFET on/off", "switch.power");
        await this.makeNumber("info.voltage", "Pack voltage", "V", "value.voltage");
        await this.makeNumber("info.current", "Pack current", "A", "value.current");
        await this.makeNumber("info.soc", "State of charge", "%", "value.battery");
        await this.makeNumber("info.minCellVoltage", "Minimum cell voltage", "V", "value.voltage");
        await this.makeNumber("info.maxCellVoltage", "Maximum cell voltage", "V", "value.voltage");
        await this.makeNumber("info.cellDiff", "Cell voltage spread", "V", "value.voltage");
        await this.makeNumber("info.minCellNumber", "Cell number with min voltage", "", "value");
        await this.makeNumber("info.maxCellNumber", "Cell number with max voltage", "", "value");
        await this.makeNumber("info.minTemperature", "Minimum temperature", "°C", "value.temperature");
        await this.makeNumber("info.maxTemperature", "Maximum temperature", "°C", "value.temperature");
        await this.makeNumber("info.minSensorNumber", "Sensor with min temperature", "", "value");
        await this.makeNumber("info.maxSensorNumber", "Sensor with max temperature", "", "value");
        await this.makeNumber("info.cycleCount", "Charge/discharge cycle count", "", "value");
        await this.makeNumber("info.bmsLife", "BMS lifecycle counter", "", "value");
        await this.makeNumber("info.residualCapacity", "Residual capacity", "Ah", "value");
        await this.makeNumber("info.energyRemaining", "Remaining energy", "kWh", "value.power.consumption");
        await this.makeBool("info.chargeMosOn", "Charge MOSFET on", "indicator");
        await this.makeBool("info.dischargeMosOn", "Discharge MOSFET on", "indicator");
        await this.makeBool("info.mosfetWriteFailed", "Last MOSFET write rejected by BMS", "indicator.alarm");
        await this.makeBool("info.chargerConnected", "Charger connected", "indicator");
        await this.makeBool("info.loadConnected", "Load connected", "indicator");
        await this.makeText("info.lastAlarmUpdate", "Timestamp of last successful alarm read");
        await this.makeText("info.lastSuccessfulTick", "Timestamp of last fully-successful poll");
        await this.setObjectNotExistsAsync("info.bmsState", {
            type: "state",
            common: {
                type: "string",
                role: "text",
                name: "BMS pack state",
                read: true,
                write: false,
                states: {
                    stationary: "stationary",
                    charging: "charging",
                    discharging: "discharging",
                    unknown: "unknown",
                },
            },
            native: {},
        });
    }
    async ensureAlarmObjects() {
        for (const def of commands_1.ALARM_FLAGS) {
            await this.setObjectNotExistsAsync(`alarms.${def.key}`, {
                type: "state",
                common: {
                    type: "boolean",
                    role: "indicator.alarm",
                    name: def.name,
                    read: true,
                    write: false,
                },
                native: {},
            });
            await this.setStateChangedAsync(`alarms.${def.key}`, false, true);
        }
    }
    async syncDynamicObjects(bms) {
        for (let i = 1; i <= bms.cellCount; i++) {
            await this.makeNumber(`cells.cell_${i}`, `Cell ${i} voltage`, "V", "value.voltage");
            await this.makeBool(`balancer.cell_${i}`, `Cell ${i} balancing`, "indicator");
        }
        for (let i = 1; i <= bms.tempSensorCount; i++) {
            await this.makeNumber(`temps.sensor_${i}`, `Temperature sensor ${i}`, "°C", "value.temperature");
        }
        const view = await this.getAdapterObjectsAsync();
        await this.pruneChannel(view, "cells", "cell_", bms.cellCount);
        await this.pruneChannel(view, "balancer", "cell_", bms.cellCount);
        await this.pruneChannel(view, "temps", "sensor_", bms.tempSensorCount);
    }
    async makeChannel(id, name) {
        await this.setObjectNotExistsAsync(id, {
            type: "channel",
            common: { name },
            native: {},
        });
    }
    async makeNumber(id, name, unit, role) {
        await this.setObjectNotExistsAsync(id, {
            type: "state",
            common: {
                type: "number",
                role,
                name,
                unit: unit || undefined,
                read: true,
                write: false,
            },
            native: {},
        });
    }
    async makeBool(id, name, role) {
        await this.setObjectNotExistsAsync(id, {
            type: "state",
            common: { type: "boolean", role, name, read: true, write: false },
            native: {},
        });
    }
    async makeWritableBool(id, name, role) {
        await this.setObjectNotExistsAsync(id, {
            type: "state",
            common: { type: "boolean", role, name, read: true, write: true, def: false },
            native: {},
        });
    }
    async makeText(id, name) {
        await this.setObjectNotExistsAsync(id, {
            type: "state",
            common: { type: "string", role: "date", name, read: true, write: false },
            native: {},
        });
    }
    async pruneChannel(view, channel, prefix, keep) {
        const fullPrefix = `${this.namespace}.${channel}.${prefix}`;
        for (const id of Object.keys(view)) {
            if (!id.startsWith(fullPrefix))
                continue;
            const idx = Number(id.slice(fullPrefix.length));
            if (Number.isFinite(idx) && idx > keep) {
                await this.delObjectAsync(id);
            }
        }
    }
    async onUnload(callback) {
        try {
            await this.unsubscribeStatesAsync("control.*");
        }
        catch {
            /* ignore — best-effort cleanup */
        }
        try {
            await this.poller?.stop();
        }
        catch {
            /* ignore */
        }
        try {
            await this.transport?.close();
        }
        catch {
            /* ignore */
        }
        try {
            await this.setState("info.connection", false, true);
        }
        catch {
            /* ignore */
        }
        callback();
    }
    onStateChange(id, state) {
        if (!state || state.ack)
            return;
        if (typeof state.val !== "boolean")
            return;
        if (!this.config.allowMosfetWrites) {
            this.log.warn(`ignored write to ${id}: allowMosfetWrites is disabled in adapter settings`);
            return;
        }
        const local = id.slice(this.namespace.length + 1);
        if (local === "control.chargeMosfet") {
            void this.handleMosfetWrite(commands_1.CommandId.SetChargeMosfet, state.val, id, "info.chargeMosOn");
        }
        else if (local === "control.dischargeMosfet") {
            void this.handleMosfetWrite(commands_1.CommandId.SetDischargeMosfet, state.val, id, "info.dischargeMosOn");
        }
    }
    /**
     * Send a MOSFET write, then read back the actual MOS state via 0x93. Ack
     * the writable control state with the value the BMS actually settled on
     * (not the value the user requested) so automations can't be fooled by a
     * silently-rejected write. If the readback disagrees with the request,
     * leave the control state pending (ack=false), warn, and set
     * info.mosfetWriteFailed=true so automations can detect the rejection.
     *
     * Gated: refuses when connection is down or within the debounce window.
     */
    async handleMosfetWrite(command, on, controlId, readbackId) {
        if (!this.transport)
            return;
        if (this.connectionDown) {
            this.log.warn(`ignored write to ${controlId}: connection is down — refusing to send hardware command`);
            return;
        }
        const now = Date.now();
        if (now - this.lastMosfetWriteAt < MOSFET_WRITE_DEBOUNCE_MS) {
            this.log.warn(`ignored write to ${controlId}: debounce active (${MOSFET_WRITE_DEBOUNCE_MS}ms between writes)`);
            return;
        }
        this.lastMosfetWriteAt = now;
        try {
            const req = (0, protocol_1.buildRequest)(this.config.hostAddress, command, (0, commands_1.buildMosfetPayload)(on));
            await this.transport.request(req, 1, command);
            this.log.info(`sent ${controlId} -> ${on}`);
        }
        catch (err) {
            this.log.warn(`failed to write ${controlId}=${on}: ${err.message}`);
            return;
        }
        try {
            await this.tickMosfetStatus();
        }
        catch (err) {
            this.log.warn(`readback after ${controlId} write failed: ${err.message}`);
            await this.setStateChangedAsync("info.mosfetWriteFailed", true, true);
            return;
        }
        const readback = await this.getStateAsync(readbackId);
        const actual = readback?.val;
        if (typeof actual !== "boolean") {
            this.log.warn(`readback for ${controlId} produced no boolean value`);
            await this.setStateChangedAsync("info.mosfetWriteFailed", true, true);
            return;
        }
        if (actual !== on) {
            this.log.warn(`${controlId} write disagrees with readback (requested=${on}, actual=${actual}); BMS rejected the command`);
            await this.setStateChangedAsync("info.mosfetWriteFailed", true, true);
            return;
        }
        await this.setState(controlId, actual, true);
        await this.setStateChangedAsync("info.mosfetWriteFailed", false, true);
    }
}
if (require.main !== module) {
    module.exports = (options) => new DalyUsbAdapter(options);
}
else {
    (() => new DalyUsbAdapter())();
}
//# sourceMappingURL=main.js.map