import * as utils from "@iobroker/adapter-core";
import {
    CommandId,
    parsePackMeasurements,
    parseStatusInfo,
    type StatusInfo,
} from "./lib/daly/commands";
import { Poller } from "./lib/daly/poller";
import { buildRequest } from "./lib/daly/protocol";
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

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: "daly-usb" });
        this.on("ready", this.onReady.bind(this));
        this.on("unload", this.onUnload.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
    }

    private async onReady(): Promise<void> {
        await this.setState("info.connection", false, true);
        await this.ensureCoreObjects();

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

        this.poller = new Poller(this.config.pollIntervalMs, () => this.poll(), this.log);
        this.poller.start();
    }

    private async discover(): Promise<BmsConfig> {
        const status = await this.readStatus();
        if (status.cellCount === 0 || status.tempSensorCount === 0) {
            throw new Error(
                `BMS reported impossible config (cells=${status.cellCount}, temps=${status.tempSensorCount})`,
            );
        }
        return { cellCount: status.cellCount, tempSensorCount: status.tempSensorCount };
    }

    private async readStatus(): Promise<StatusInfo> {
        if (!this.transport) throw new Error("transport not initialised");
        const req = buildRequest(this.config.hostAddress, CommandId.StatusInfo);
        const [frame] = await this.transport.request(req, 1, CommandId.StatusInfo);
        return parseStatusInfo(frame.payload);
    }

    private async poll(): Promise<void> {
        if (!this.transport) return;
        const req = buildRequest(this.config.hostAddress, CommandId.PackMeasurements);
        const [frame] = await this.transport.request(req, 1, CommandId.PackMeasurements);
        const m = parsePackMeasurements(frame.payload);
        await this.setStateChangedAsync("info.voltage", m.voltage, true);
        await this.setStateChangedAsync("info.current", m.current, true);
        await this.setStateChangedAsync("info.soc", m.soc, true);
    }

    private async ensureCoreObjects(): Promise<void> {
        await this.setObjectNotExistsAsync("info.voltage", {
            type: "state",
            common: {
                type: "number",
                role: "value.voltage",
                name: "Pack voltage",
                unit: "V",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("info.current", {
            type: "state",
            common: {
                type: "number",
                role: "value.current",
                name: "Pack current",
                unit: "A",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("info.soc", {
            type: "state",
            common: {
                type: "number",
                role: "value.battery",
                name: "State of charge",
                unit: "%",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("cells", {
            type: "channel",
            common: { name: "Per-cell voltages" },
            native: {},
        });
        await this.setObjectNotExistsAsync("temps", {
            type: "channel",
            common: { name: "Temperature sensors" },
            native: {},
        });
    }

    /**
     * Make sure exactly `cellCount` cell states and `tempSensorCount` sensor
     * states exist, deleting any leftovers from a previous BMS configuration
     * with a different cell count.
     */
    private async syncDynamicObjects(bms: BmsConfig): Promise<void> {
        for (let i = 1; i <= bms.cellCount; i++) {
            await this.setObjectNotExistsAsync(`cells.cell_${i}`, {
                type: "state",
                common: {
                    type: "number",
                    role: "value.voltage",
                    name: `Cell ${i} voltage`,
                    unit: "V",
                    read: true,
                    write: false,
                },
                native: {},
            });
        }
        for (let i = 1; i <= bms.tempSensorCount; i++) {
            await this.setObjectNotExistsAsync(`temps.sensor_${i}`, {
                type: "state",
                common: {
                    type: "number",
                    role: "value.temperature",
                    name: `Temperature sensor ${i}`,
                    unit: "°C",
                    read: true,
                    write: false,
                },
                native: {},
            });
        }
        await this.deleteStaleChannelMembers("cells", "cell_", bms.cellCount);
        await this.deleteStaleChannelMembers("temps", "sensor_", bms.tempSensorCount);
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

    private onStateChange(_id: string, _state: ioBroker.State | null | undefined): void {
        /* wired up in M5 */
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined): DalyUsbAdapter =>
        new DalyUsbAdapter(options);
} else {
    (() => new DalyUsbAdapter())();
}
