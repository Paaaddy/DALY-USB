import { expect } from "chai";
import { DalyTransport, TransportClosedError } from "./transport";
import { buildRequest } from "./protocol";

const noopLog = {
    debug: (_msg: string): void => undefined,
    warn: (_msg: string): void => undefined,
    error: (_msg: string): void => undefined,
};

describe("DalyTransport.close()", () => {
    it("makes subsequent request() calls reject with TransportClosedError", async () => {
        const t = new DalyTransport({
            path: "/dev/null",
            baudRate: 9600,
            requestTimeoutMs: 100,
            log: noopLog,
        });
        await t.close();

        const req = buildRequest(0x40, 0x90);
        try {
            await t.request(req, 1, 0x90);
            expect.fail("expected request() to reject after close()");
        } catch (err) {
            expect(err).to.be.instanceOf(TransportClosedError);
        }
    });

    it("is safe to call before open() and is idempotent", async () => {
        const t = new DalyTransport({
            path: "/dev/null",
            baudRate: 9600,
            requestTimeoutMs: 100,
            log: noopLog,
        });
        await t.close();
        await t.close();
    });
});
