export interface PollerLogger {
    debug(msg: string): void;
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
}

export class Poller {
    private timer?: NodeJS.Timeout;
    private running = false;

    constructor(
        private readonly intervalMs: number,
        private readonly tick: () => Promise<void>,
        private readonly log: PollerLogger,
    ) {}

    start(): void {
        if (this.timer) return;
        const run = async (): Promise<void> => {
            if (this.running) return;
            this.running = true;
            try {
                await this.tick();
            } catch (err) {
                this.log.warn(`poll tick failed: ${(err as Error).message}`);
            } finally {
                this.running = false;
            }
        };
        void run();
        this.timer = setInterval(run, this.intervalMs);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
}
