import * as utils from "@iobroker/adapter-core";
import { CommandId, parsePackMeasurements } from "./lib/daly/commands";
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

class DalyUsbAdapter extends utils.Adapter {
    private transport?: DalyTransport;
    private poller?: Poller;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: "daly-usb" });
        this.on("ready", this.onReady.bind(this));
        this.on("unload", this.onUnload.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
    }

    private async onReady(): Promise<void> {
        await this.setState("info.connection", false, true);
        await this.ensureReadOnlyNumber("info.voltage", "Pack voltage", "V", "value.voltage");
        await this.ensureReadOnlyNumber("info.current", "Pack current", "A", "value.current");
        await this.ensureReadOnlyNumber("info.soc", "State of charge", "%", "value.battery");

        this.transport = new DalyTransport({
            path: this.config.serialPort,
            baudRate: this.config.baudRate,
            requestTimeoutMs: this.config.requestTimeoutMs,
            log: this.log,
        });

        try {
            await this.transport.open();
            await this.setState("info.connection", true, true);
            this.log.info(`opened ${this.config.serialPort} @ ${this.config.baudRate} baud`);
        } catch (err) {
            this.log.error(`failed to open serial port: ${(err as Error).message}`);
            return;
        }

        this.poller = new Poller(this.config.pollIntervalMs, () => this.poll(), this.log);
        this.poller.start();
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

    private async ensureReadOnlyNumber(
        id: string,
        name: string,
        unit: string,
        role: string,
    ): Promise<void> {
        await this.setObjectNotExistsAsync(id, {
            type: "state",
            common: { type: "number", role, name, unit, read: true, write: false },
            native: {},
        });
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
