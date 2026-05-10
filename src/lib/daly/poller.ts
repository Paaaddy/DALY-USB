export interface PollerLogger {
    debug(msg: string): void;
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
}

export class Poller {
    private timer?: NodeJS.Timeout;
    private currentTick?: Promise<void>;

    constructor(
        private readonly intervalMs: number,
        private readonly tick: () => Promise<void>,
        private readonly log: PollerLogger,
    ) {}

    start(): void {
        if (this.timer) return;
        const run = async (): Promise<void> => {
            if (this.currentTick) return;
            this.currentTick = (async () => {
                try {
                    await this.tick();
                } catch (err) {
                    this.log.warn(`poll tick failed: ${(err as Error).message}`);
                }
            })();
            try {
                await this.currentTick;
            } finally {
                this.currentTick = undefined;
            }
        };
        void run();
        this.timer = setInterval(() => void run(), this.intervalMs);
        this.timer.unref?.();
    }

    /**
     * Stops the interval and waits for any in-flight tick to finish so the
     * caller can safely tear down resources the tick depends on (e.g. close
     * the serial port) without racing.
     */
    async stop(): Promise<void> {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        if (this.currentTick) {
            await this.currentTick.catch(() => undefined);
        }
    }
}
