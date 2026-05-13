"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FrameValidationError = exports.DATA_LENGTH_BYTE = exports.START_BYTE = exports.FRAME_LENGTH = void 0;
exports.checksum = checksum;
exports.buildRequest = buildRequest;
exports.parseFrame = parseFrame;
exports.readU16BE = readU16BE;
exports.FRAME_LENGTH = 13;
exports.START_BYTE = 0xa5;
exports.DATA_LENGTH_BYTE = 0x08;
class FrameValidationError extends Error {
}
exports.FrameValidationError = FrameValidationError;
function checksum(bytes) {
    let sum = 0;
    for (const b of bytes)
        sum = (sum + b) & 0xff;
    return sum;
}
function buildRequest(hostAddress, command, payload = new Uint8Array(8)) {
    const buf = Buffer.alloc(exports.FRAME_LENGTH);
    buf[0] = exports.START_BYTE;
    buf[1] = hostAddress & 0xff;
    buf[2] = command & 0xff;
    buf[3] = exports.DATA_LENGTH_BYTE;
    for (let i = 0; i < 8; i++)
        buf[4 + i] = payload[i] ?? 0;
    buf[12] = checksum(buf.subarray(0, 12));
    return buf;
}
function parseFrame(frame, expectedCommand) {
    if (frame.length !== exports.FRAME_LENGTH) {
        throw new FrameValidationError(`expected ${exports.FRAME_LENGTH} bytes, got ${frame.length}`);
    }
    if (frame[0] !== exports.START_BYTE) {
        throw new FrameValidationError(`bad start byte 0x${frame[0].toString(16)}`);
    }
    if (frame[3] !== exports.DATA_LENGTH_BYTE) {
        throw new FrameValidationError(`bad length byte 0x${frame[3].toString(16)}`);
    }
    const cs = checksum(frame.subarray(0, 12));
    if (cs !== frame[12]) {
        throw new FrameValidationError(`checksum mismatch (got 0x${frame[12].toString(16)}, expected 0x${cs.toString(16)})`);
    }
    if (expectedCommand !== undefined && frame[2] !== expectedCommand) {
        throw new FrameValidationError(`command mismatch (got 0x${frame[2].toString(16)}, expected 0x${expectedCommand.toString(16)})`);
    }
    return {
        hostAddress: frame[1],
        command: frame[2],
        payload: frame.subarray(4, 12),
    };
}
function readU16BE(buf, offset) {
    return buf.readUInt16BE(offset);
}
//# sourceMappingURL=protocol.js.map