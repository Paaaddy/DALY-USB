export const FRAME_LENGTH = 13;
export const START_BYTE = 0xa5;
export const DATA_LENGTH_BYTE = 0x08;

export class FrameValidationError extends Error {}

export interface ParsedFrame {
    hostAddress: number;
    command: number;
    payload: Buffer;
}

export function checksum(bytes: Uint8Array | readonly number[]): number {
    let sum = 0;
    for (const b of bytes) sum = (sum + b) & 0xff;
    return sum;
}

export function buildRequest(
    hostAddress: number,
    command: number,
    payload: Uint8Array | readonly number[] = new Uint8Array(8),
): Buffer {
    const buf = Buffer.alloc(FRAME_LENGTH);
    buf[0] = START_BYTE;
    buf[1] = hostAddress & 0xff;
    buf[2] = command & 0xff;
    buf[3] = DATA_LENGTH_BYTE;
    for (let i = 0; i < 8; i++) buf[4 + i] = payload[i] ?? 0;
    buf[12] = checksum(buf.subarray(0, 12));
    return buf;
}

export function parseFrame(frame: Buffer, expectedCommand?: number): ParsedFrame {
    if (frame.length !== FRAME_LENGTH) {
        throw new FrameValidationError(`expected ${FRAME_LENGTH} bytes, got ${frame.length}`);
    }
    if (frame[0] !== START_BYTE) {
        throw new FrameValidationError(`bad start byte 0x${frame[0].toString(16)}`);
    }
    if (frame[3] !== DATA_LENGTH_BYTE) {
        throw new FrameValidationError(`bad length byte 0x${frame[3].toString(16)}`);
    }
    const cs = checksum(frame.subarray(0, 12));
    if (cs !== frame[12]) {
        throw new FrameValidationError(
            `checksum mismatch (got 0x${frame[12].toString(16)}, expected 0x${cs.toString(16)})`,
        );
    }
    if (expectedCommand !== undefined && frame[2] !== expectedCommand) {
        throw new FrameValidationError(
            `command mismatch (got 0x${frame[2].toString(16)}, expected 0x${expectedCommand.toString(16)})`,
        );
    }
    return {
        hostAddress: frame[1],
        command: frame[2],
        payload: frame.subarray(4, 12),
    };
}

export function readU16BE(buf: Buffer, offset: number): number {
    return buf.readUInt16BE(offset);
}
