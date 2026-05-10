import * as utils from "@iobroker/adapter-core";
import {
    ALARM_FLAGS,
    CommandId,
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
    type StatusInfo,
} from "./lib/daly/commands";
import { Poller } from "./lib/daly/poller";
import { buildRequest, type ParsedFrame } from "./lib/daly/protocol";
import { DalyTransport } from "./lib/daly/transport";

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace ioBroker {
        interface AdapterConfig {
            serialPort: string;
            baudRate: number;
            hostAddress: number;
            pollIntervalMs: number;
            requestTimeoutMs: number;
        }
    }
}

interface BmsConfig {
    cellCount: number;
    tempSensorCount: number;
}

class DalyUsbAdapter extends utils.Adapter {
    private transport?: DalyTransport;
    private poller?: Poller;
    private bms?: BmsConfig;
    private lastVoltage = 0;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: "daly-usb" });
        this.on("ready", this.onReady.bind(this));
        this.on("unload", this.onUnload.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
    }

    private async onReady(): Promise<void> {
        await this.setState("info.connection", false, true);
        await this.ensureCoreObjects();
        await this.ensureAlarmObjects();

        this.transport = new DalyTransport({
            path: this.config.serialPort,
            baudRate: this.config.baudRate,
            requestTimeoutMs: this.config.requestTimeoutMs,
            log: this.log,
        });

        try {
            await this.transport.open();
            this.log.info(`opened ${this.config.serialPort} @ ${this.config.baudRate} baud`);
        } catch (err) {
            this.log.error(`failed to open serial port: ${(err as Error).message}`);
            return;
        }

        try {
            this.bms = await this.discover();
            this.log.info(
                `discovered BMS: ${this.bms.cellCount} cells, ${this.bms.tempSensorCount} temp sensors`,
            );
            await this.syncDynamicObjects(this.bms);
            await this.setState("info.connection", true, true);
        } catch (err) {
            this.log.error(`discovery failed: ${(err as Error).message}`);
            return;
        }

        this.subscribeStates("control.*");

        this.poller = new Poller(this.config.pollIntervalMs, () => this.poll(), this.log);
        this.poller.start();
    }

    private async discover(): Promise<BmsConfig> {
        const status = await this.runCommand(CommandId.StatusInfo, 1, parseStatusInfo);
        if (status.cellCount === 0 || status.tempSensorCount === 0) {
            throw new Error(
                `BMS reported impossible config (cells=${status.cellCount}, temps=${status.tempSensorCount})`,
            );
        }
        return { cellCount: status.cellCount, tempSensorCount: status.tempSensorCount };
    }

    private async poll(): Promise<void> {
        if (!this.transport || !this.bms) return;
        await this.tickPackMeasurements();
        await this.tickMinMaxCellVoltage();
        await this.tickMinMaxTemperature();
        await this.tickMosfetStatus();
        await this.tickStatusInfo();
        await this.tickCellVoltages(this.bms.cellCount);
        await this.tickTemperatures(this.bms.tempSensorCount);
        await this.tickBalancer(this.bms.cellCount);
        await this.tickAlarms();
    }

    private async tickPackMeasurements(): Promise<void> {
        await this.guarded("0x90", async () => {
            const m = await this.runCommand(CommandId.PackMeasurements, 1, parsePackMeasurements);
            this.lastVoltage = m.voltage;
            await this.setStateChangedAsync("info.voltage", m.voltage, true);
            await this.setStateChangedAsync("info.current", m.current, true);
            await this.setStateChangedAsync("info.soc", m.soc, true);
        });
    }

    private async tickMinMaxCellVoltage(): Promise<void> {
        await this.guarded("0x91", async () => {
            const m = await this.runCommand(
                CommandId.MinMaxCellVoltage,
                1,
                parseMinMaxCellVoltage,
            );
            await this.setStateChangedAsync("info.minCellVoltage", m.minVoltage, true);
            await this.setStateChangedAsync("info.maxCellVoltage", m.maxVoltage, true);
            await this.setStateChangedAsync("info.minCellNumber", m.minCellNumber, true);
            await this.setStateChangedAsync("info.maxCellNumber", m.maxCellNumber, true);
            await this.setStateChangedAsync(
                "info.cellDiff",
                Number((m.maxVoltage - m.minVoltage).toFixed(3)),
                true,
            );
        });
    }

    private async tickMinMaxTemperature(): Promise<void> {
        await this.guarded("0x92", async () => {
            const m = await this.runCommand(
                CommandId.MinMaxTemperature,
                1,
                parseMinMaxTemperature,
            );
            await this.setStateChangedAsync("info.minTemperature", m.minTemperature, true);
            await this.setStateChangedAsync("info.maxTemperature", m.maxTemperature, true);
            await this.setStateChangedAsync("info.minSensorNumber", m.minSensorNumber, true);
            await this.setStateChangedAsync("info.maxSensorNumber", m.maxSensorNumber, true);
        });
    }

    private async tickMosfetStatus(): Promise<void> {
        await this.guarded("0x93", async () => {
            const m = await this.runCommand(CommandId.MosfetStatus, 1, parseMosfetStatus);
            await this.setStateChangedAsync("info.bmsState", m.state, true);
            await this.setStateChangedAsync("info.chargeMosOn", m.chargeMosOn, true);
            await this.setStateChangedAsync("info.dischargeMosOn", m.dischargeMosOn, true);
            await this.setStateChangedAsync("info.bmsLife", m.bmsLife, true);
            await this.setStateChangedAsync(
                "info.residualCapacity",
                Number(m.residualCapacityAh.toFixed(3)),
                true,
            );
            const energyKwh = (m.residualCapacityAh * this.lastVoltage) / 1000;
            await this.setStateChangedAsync(
                "info.energyRemaining",
                Number(energyKwh.toFixed(3)),
                true,
            );
        });
    }

    private async tickStatusInfo(): Promise<void> {
        await this.guarded("0x94", async () => {
            const s: StatusInfo = await this.runCommand(
                CommandId.StatusInfo,
                1,
                parseStatusInfo,
            );
            await this.setStateChangedAsync("info.cycleCount", s.cycleCount, true);
            await this.setStateChangedAsync("info.chargerConnected", s.chargerConnected, true);
            await this.setStateChangedAsync("info.loadConnected", s.loadConnected, true);
        });
    }

    private async tickCellVoltages(cellCount: number): Promise<void> {
        await this.guarded("0x95", async () => {
            const frames = Math.ceil(cellCount / 3);
            const parsed = await this.runCommandMulti(
                CommandId.CellVoltages,
                frames,
                parseCellVoltageFrame,
            );
            const voltages = combineCellVoltageFrames(parsed, cellCount);
            for (let i = 0; i < voltages.length; i++) {
                await this.setStateChangedAsync(
                    `cells.cell_${i + 1}`,
                    Number(voltages[i].toFixed(3)),
                    true,
                );
            }
        });
    }

    private async tickTemperatures(sensorCount: number): Promise<void> {
        await this.guarded("0x96", async () => {
            const frames = Math.ceil(sensorCount / 7);
            const parsed = await this.runCommandMulti(
                CommandId.TemperatureSensors,
                frames,
                parseTemperatureFrame,
            );
            const temps = combineTemperatureFrames(parsed, sensorCount);
            for (let i = 0; i < temps.length; i++) {
                await this.setStateChangedAsync(`temps.sensor_${i + 1}`, temps[i], true);
            }
        });
    }

    private async tickBalancer(cellCount: number): Promise<void> {
        await this.guarded("0x97", async () => {
            if (!this.transport) return;
            const req = buildRequest(this.config.hostAddress, CommandId.BalancerState);
            const [frame] = await this.transport.request(req, 1, CommandId.BalancerState);
            const flags = parseBalancerState(frame.payload, cellCount);
            for (let i = 0; i < flags.length; i++) {
                await this.setStateChangedAsync(`balancer.cell_${i + 1}`, flags[i], true);
            }
        });
    }

    private async tickAlarms(): Promise<void> {
        await this.guarded("0x98", async () => {
            const flags = await this.runCommand(CommandId.AlarmFlags, 1, parseAlarmFlags);
            for (const def of ALARM_FLAGS) {
                await this.setStateChangedAsync(`alarms.${def.key}`, flags[def.key] ?? false, true);
            }
        });
    }

    private async runCommand<T>(
        command: number,
        expectedFrames: number,
        parse: (payload: Buffer) => T,
    ): Promise<T> {
        if (!this.transport) throw new Error("transport not initialised");
        const req = buildRequest(this.config.hostAddress, command);
        const [frame] = await this.transport.request(req, expectedFrames, command);
        return parse(frame.payload);
    }

    private async runCommandMulti<T>(
        command: number,
        expectedFrames: number,
        parse: (payload: Buffer) => T,
    ): Promise<T[]> {
        if (!this.transport) throw new Error("transport not initialised");
        const req = buildRequest(this.config.hostAddress, command);
        const frames: ParsedFrame[] = await this.transport.request(req, expectedFrames, command);
        return frames.map(f => parse(f.payload));
    }

    private async guarded(label: string, fn: () => Promise<void>): Promise<void> {
        try {
            await fn();
        } catch (err) {
            this.log.warn(`${label} failed: ${(err as Error).message}`);
        }
    }

    private async ensureCoreObjects(): Promise<void> {
        await this.makeChannel("cells", "Per-cell voltages");
        await this.makeChannel("temps", "Temperature sensors");
        await this.makeChannel("balancer", "Cell balancer state");
        await this.makeChannel("alarms", "Alarm flags");
        await this.makeChannel("control", "Writable controls");
        await this.makeWritableBool(
            "control.chargeMosfet",
            "Charge MOSFET on/off",
            "switch.power",
        );
        await this.makeWritableBool(
            "control.dischargeMosfet",
            "Discharge MOSFET on/off",
            "switch.power",
        );
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
        await this.makeBool("info.chargerConnected", "Charger connected", "indicator");
        await this.makeBool("info.loadConnected", "Load connected", "indicator");
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

    private async ensureAlarmObjects(): Promise<void> {
        for (const def of ALARM_FLAGS) {
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
        }
    }

    private async syncDynamicObjects(bms: BmsConfig): Promise<void> {
        for (let i = 1; i <= bms.cellCount; i++) {
            await this.makeNumber(`cells.cell_${i}`, `Cell ${i} voltage`, "V", "value.voltage");
            await this.makeBool(`balancer.cell_${i}`, `Cell ${i} balancing`, "indicator");
        }
        for (let i = 1; i <= bms.tempSensorCount; i++) {
            await this.makeNumber(
                `temps.sensor_${i}`,
                `Temperature sensor ${i}`,
                "°C",
                "value.temperature",
            );
        }
        await this.deleteStaleChannelMembers("cells", "cell_", bms.cellCount);
        await this.deleteStaleChannelMembers("balancer", "cell_", bms.cellCount);
        await this.deleteStaleChannelMembers("temps", "sensor_", bms.tempSensorCount);
    }

    private async makeChannel(id: string, name: string): Promise<void> {
        await this.setObjectNotExistsAsync(id, {
            type: "channel",
            common: { name },
            native: {},
        });
    }

    private async makeNumber(
        id: string,
        name: string,
        unit: string,
        role: string,
    ): Promise<void> {
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

    private async makeBool(id: string, name: string, role: string): Promise<void> {
        await this.setObjectNotExistsAsync(id, {
            type: "state",
            common: { type: "boolean", role, name, read: true, write: false },
            native: {},
        });
    }

    private async makeWritableBool(id: string, name: string, role: string): Promise<void> {
        await this.setObjectNotExistsAsync(id, {
            type: "state",
            common: { type: "boolean", role, name, read: true, write: true, def: false },
            native: {},
        });
    }

    private async deleteStaleChannelMembers(
        channel: string,
        prefix: string,
        keep: number,
    ): Promise<void> {
        const view = await this.getAdapterObjectsAsync();
        const fullPrefix = `${this.namespace}.${channel}.${prefix}`;
        for (const id of Object.keys(view)) {
            if (!id.startsWith(fullPrefix)) continue;
            const idx = Number(id.slice(fullPrefix.length));
            if (Number.isFinite(idx) && idx > keep) {
                await this.delObjectAsync(id);
            }
        }
    }

    private async onUnload(callback: () => void): Promise<void> {
        try {
            this.poller?.stop();
            await this.transport?.close();
            await this.setState("info.connection", false, true);
        } catch {
            /* ignore — best-effort cleanup */
        } finally {
            callback();
        }
    }

    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!state || state.ack) return;
        if (typeof state.val !== "boolean") return;
        const local = id.slice(this.namespace.length + 1);
        if (local === "control.chargeMosfet") {
            void this.handleMosfetWrite(CommandId.SetChargeMosfet, state.val, id);
        } else if (local === "control.dischargeMosfet") {
            void this.handleMosfetWrite(CommandId.SetDischargeMosfet, state.val, id);
        }
    }

    private async handleMosfetWrite(command: number, on: boolean, id: string): Promise<void> {
        if (!this.transport) return;
        try {
            const req = buildRequest(this.config.hostAddress, command, buildMosfetPayload(on));
            await this.transport.request(req, 1, command);
            this.log.info(`set ${id} -> ${on}`);
        } catch (err) {
            this.log.warn(`failed to write ${id}=${on}: ${(err as Error).message}`);
            return;
        }
        await this.tickMosfetStatus();
        await this.setState(id, on, true);
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined): DalyUsbAdapter =>
        new DalyUsbAdapter(options);
} else {
    (() => new DalyUsbAdapter())();
}
