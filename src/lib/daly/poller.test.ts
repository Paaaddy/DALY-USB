import { expect } from "chai";
import { Poller } from "./poller";

const noopLog = {
    debug: (_: string) => undefined,
    info: (_: string) => undefined,
    warn: (_: string) => undefined,
    error: (_: string) => undefined,
};

describe("Poller", () => {
    it("does not start a second tick while first is in flight", async () => {
        let concurrent = 0;
        let maxConcurrent = 0;
        let tickCount = 0;
        const tick = (): Promise<void> =>
            new Promise(resolve => {
                concurrent++;
                maxConcurrent = Math.max(maxConcurrent, concurrent);
                tickCount++;
                setTimeout(() => {
                    concurrent--;
                    resolve();
                }, 50);
            });

        const poller = new Poller(10, tick, noopLog);
        poller.start();
        await new Promise(r => setTimeout(r, 120));
        await poller.stop();

        expect(maxConcurrent).to.equal(1);
        expect(tickCount).to.be.greaterThan(1);
    });

    it("stop() resolves only after in-flight tick completes", async () => {
        let tickFinished = false;
        const tick = (): Promise<void> =>
            new Promise(resolve =>
                setTimeout(() => {
                    tickFinished = true;
                    resolve();
                }, 80),
            );

        const poller = new Poller(1000, tick, noopLog);
        poller.start();
        await new Promise(r => setTimeout(r, 20));
        await poller.stop();

        expect(tickFinished).to.equal(true);
    });

    it("start() is idempotent", async () => {
        let tickCount = 0;
        const tick = (): Promise<void> => {
            tickCount++;
            return Promise.resolve();
        };

        const poller = new Poller(20, tick, noopLog);
        poller.start();
        poller.start();
        poller.start();
        await new Promise(r => setTimeout(r, 80));
        await poller.stop();

        // Three start() calls must not triple the fire rate.
        // With interval=20ms over 80ms we expect roughly 4 ticks (not 12).
        expect(tickCount).to.be.lessThan(8);
    });

    it("a tick that throws does not stop the poller", async () => {
        let tickCount = 0;
        const tick = (): Promise<void> => {
            tickCount++;
            return Promise.reject(new Error("boom"));
        };

        const poller = new Poller(20, tick, noopLog);
        poller.start();
        await new Promise(r => setTimeout(r, 80));
        await poller.stop();

        expect(tickCount).to.be.greaterThan(1);
    });
});
