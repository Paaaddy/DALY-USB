"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DalyTransport = exports.TransportClosedError = void 0;
const serialport_1 = require("serialport");
const protocol_1 = require("./protocol");
class TransportClosedError extends Error {
    constructor() {
        super("transport closed");
    }
}
exports.TransportClosedError = TransportClosedError;
const MAX_QUEUE_DEPTH = 20;
class DalyTransport {
    opts;
    port;
    parser;
    queue = Promise.resolve();
    queueDepth = 0;
    incoming = [];
    waiter;
    closed = false;
    constructor(opts) {
        this.opts = opts;
    }
    async open() {
        this.port = new serialport_1.SerialPort({
            path: this.opts.path,
            baudRate: this.opts.baudRate,
            autoOpen: false,
        });
        this.parser = this.port.pipe(new serialport_1.ByteLengthParser({ length: protocol_1.FRAME_LENGTH }));
        this.parser.on("data", (data) => this.onFrame(data));
        this.parser.on("error", (err) => {
            this.opts.log.error(`parser error: ${err.message}`);
            if (this.waiter) {
                const w = this.waiter;
                this.waiter = undefined;
                clearTimeout(w.timer);
                w.reject(err);
            }
        });
        this.port.on("error", (err) => {
            this.opts.log.error(`serial error: ${err.message}`);
            if (this.waiter) {
                const w = this.waiter;
                this.waiter = undefined;
                clearTimeout(w.timer);
                w.reject(err);
            }
        });
        const openMs = this.opts.openTimeoutMs ?? Math.max(this.opts.requestTimeoutMs, 5000);
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`failed to open ${this.opts.path} within ${openMs}ms`));
            }, openMs);
            this.port.open(err => {
                clearTimeout(timer);
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
    }
    async close() {
        this.closed = true;
        if (this.waiter) {
            clearTimeout(this.waiter.timer);
            this.waiter.reject(new TransportClosedError());
            this.waiter = undefined;
        }
        if (!this.port)
            return;
        if (this.port.isOpen) {
            await new Promise(res => this.port.close(() => res()));
        }
        this.port = undefined;
        this.parser = undefined;
    }
    /**
     * Send a request, then wait for `expectedFrames` 13-byte responses with the
     * given command byte. All requests are serialised on a single internal queue
     * so concurrent callers never interleave on the bus.
     */
    request(buf, expectedFrames, expectedCommand) {
        if (this.closed)
            return Promise.reject(new TransportClosedError());
        if (this.queueDepth >= MAX_QUEUE_DEPTH) {
            return Promise.reject(new Error(`request queue full (depth=${this.queueDepth}): BMS may be unresponsive`));
        }
        this.queueDepth++;
        const exec = async () => {
            if (this.closed)
                throw new TransportClosedError();
            if (!this.port?.isOpen)
                throw new Error("serial port not open");
            this.incoming = [];
            await new Promise((resolve, reject) => this.port.write(buf, err => (err ? reject(err) : resolve())));
            await new Promise((resolve, reject) => this.port.drain(err => (err ? reject(err) : resolve())));
            const frames = [];
            for (let i = 0; i < expectedFrames; i++) {
                const raw = await this.awaitFrame();
                frames.push((0, protocol_1.parseFrame)(raw, expectedCommand));
            }
            return frames;
        };
        const wrapped = async () => {
            try {
                return await exec();
            }
            finally {
                this.queueDepth--;
            }
        };
        const next = this.queue.then(wrapped, wrapped);
        this.queue = next.catch(() => undefined);
        return next;
    }
    onFrame(data) {
        if (this.waiter) {
            const w = this.waiter;
            this.waiter = undefined;
            clearTimeout(w.timer);
            w.resolve(data);
        }
        else if (this.incoming.length < MAX_QUEUE_DEPTH) {
            this.incoming.push(data);
        }
        else {
            this.opts.log.warn(`incoming frame buffer full (${MAX_QUEUE_DEPTH}), dropping unsolicited frame`);
        }
    }
    awaitFrame() {
        const buffered = this.incoming.shift();
        if (buffered)
            return Promise.resolve(buffered);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiter = undefined;
                reject(new Error(`timeout waiting for response after ${this.opts.requestTimeoutMs}ms`));
            }, this.opts.requestTimeoutMs);
            this.waiter = { resolve, reject, timer };
        });
    }
}
exports.DalyTransport = DalyTransport;
//# sourceMappingURL=transport.js.map