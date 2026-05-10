import * as utils from "@iobroker/adapter-core";

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
    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: "daly-usb" });
        this.on("ready", this.onReady.bind(this));
        this.on("unload", this.onUnload.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
    }

    private async onReady(): Promise<void> {
        await this.setState("info.connection", false, true);
        this.log.info(
            `daly-usb starting (port=${this.config.serialPort}, poll=${this.config.pollIntervalMs}ms)`,
        );
    }

    private onUnload(callback: () => void): void {
        try {
            callback();
        } catch {
            callback();
        }
    }

    private onStateChange(_id: string, _state: ioBroker.State | null | undefined): void {
        /* M1 stub — wired up in M5 */
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined): DalyUsbAdapter =>
        new DalyUsbAdapter(options);
} else {
    (() => new DalyUsbAdapter())();
}
