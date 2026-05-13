"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Poller = void 0;
class Poller {
    intervalMs;
    tick;
    log;
    timer;
    currentTick;
    constructor(intervalMs, tick, log) {
        this.intervalMs = intervalMs;
        this.tick = tick;
        this.log = log;
    }
    start() {
        if (this.timer)
            return;
        const run = async () => {
            if (this.currentTick)
                return;
            this.currentTick = (async () => {
                try {
                    await this.tick();
                }
                catch (err) {
                    this.log.warn(`poll tick failed: ${err.message}`);
                }
            })();
            try {
                await this.currentTick;
            }
            finally {
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
    async stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        if (this.currentTick) {
            await this.currentTick.catch(() => undefined);
        }
    }
}
exports.Poller = Poller;
//# sourceMappingURL=poller.js.map