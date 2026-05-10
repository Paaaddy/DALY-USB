import { ByteLengthParser, SerialPort } from "serialport";
import { FRAME_LENGTH, ParsedFrame, parseFrame } from "./protocol";

export interface TransportLogger {
    debug(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
}

export interface TransportOptions {
    path: string;
    baudRate: number;
    requestTimeoutMs: number;
    /** Maximum time to wait for the underlying port to open before giving up. */
    openTimeoutMs?: number;
    log: TransportLogger;
}

type Frame = Buffer;

export class TransportClosedError extends Error {
    constructor() {
        super("transport closed");
    }
}

export class DalyTransport {
    private port?: SerialPort;
    private parser?: ByteLengthParser;
    private queue: Promise<unknown> = Promise.resolve();
    private incoming: Frame[] = [];
    private waiter?: { resolve: (f: Frame) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
    private closed = false;

    constructor(private readonly opts: TransportOptions) {}

    async open(): Promise<void> {
        this.port = new SerialPort({
            path: this.opts.path,
            baudRate: this.opts.baudRate,
            autoOpen: false,
        });
        this.parser = this.port.pipe(new ByteLengthParser({ length: FRAME_LENGTH }));
        this.parser.on("data", (data: Buffer) => this.onFrame(data));
        this.port.on("error", (err: Error) => this.opts.log.error(`serial error: ${err.message}`));

        const openMs = this.opts.openTimeoutMs ?? Math.max(this.opts.requestTimeoutMs, 5000);
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`failed to open ${this.opts.path} within ${openMs}ms`));
            }, openMs);
            this.port!.open(err => {
                clearTimeout(timer);
                if (err) reject(err);
                else resolve();
            });
        });
    }

    async close(): Promise<void> {
        this.closed = true;
        if (this.waiter) {
            clearTimeout(this.waiter.timer);
            this.waiter.reject(new TransportClosedError());
            this.waiter = undefined;
        }
        if (!this.port) return;
        if (this.port.isOpen) {
            await new Promise<void>(res => this.port!.close(() => res()));
        }
        this.port = undefined;
        this.parser = undefined;
    }

    /**
     * Send a request, then wait for `expectedFrames` 13-byte responses with the
     * given command byte. All requests are serialised on a single internal queue
     * so concurrent callers never interleave on the bus.
     */
    request(buf: Buffer, expectedFrames: number, expectedCommand: number): Promise<ParsedFrame[]> {
        if (this.closed) return Promise.reject(new TransportClosedError());
        const exec = async (): Promise<ParsedFrame[]> => {
            if (this.closed) throw new TransportClosedError();
            if (!this.port?.isOpen) throw new Error("serial port not open");
            this.incoming = [];

            await new Promise<void>((resolve, reject) =>
                this.port!.write(buf, err => (err ? reject(err) : resolve())),
            );
            await new Promise<void>((resolve, reject) =>
                this.port!.drain(err => (err ? reject(err) : resolve())),
            );

            const frames: ParsedFrame[] = [];
            for (let i = 0; i < expectedFrames; i++) {
                const raw = await this.awaitFrame();
                frames.push(parseFrame(raw, expectedCommand));
            }
            return frames;
        };
        const next = this.queue.then(exec, exec);
        this.queue = next.catch(() => undefined);
        return next;
    }

    private onFrame(data: Frame): void {
        if (this.waiter) {
            const w = this.waiter;
            this.waiter = undefined;
            clearTimeout(w.timer);
            w.resolve(data);
        } else {
            this.incoming.push(data);
        }
    }

    private awaitFrame(): Promise<Frame> {
        const buffered = this.incoming.shift();
        if (buffered) return Promise.resolve(buffered);
        return new Promise<Frame>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiter = undefined;
                reject(new Error(`timeout waiting for response after ${this.opts.requestTimeoutMs}ms`));
            }, this.opts.requestTimeoutMs);
            this.waiter = { resolve, reject, timer };
        });
    }
}
