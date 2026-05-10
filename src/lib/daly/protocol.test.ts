import { expect } from "chai";
import {
    buildRequest,
    checksum,
    DATA_LENGTH_BYTE,
    FRAME_LENGTH,
    FrameValidationError,
    parseFrame,
    START_BYTE,
} from "./protocol";

describe("protocol.checksum", () => {
    it("sums bytes modulo 256", () => {
        expect(checksum([0x01, 0x02, 0x03])).to.equal(0x06);
        expect(checksum([0xff, 0x01])).to.equal(0x00);
    });

    it("computes the canonical 0x90 request checksum for host 0x40", () => {
        // A5 40 90 08 00 00 00 00 00 00 00 00 -> sum=0x17D -> low byte 0x7D
        expect(checksum([0xa5, 0x40, 0x90, 0x08, 0, 0, 0, 0, 0, 0, 0, 0])).to.equal(0x7d);
    });

    it("matches reference.py's stored checksum when host = 0x80", () => {
        // reference.py writes A5 40 90 08 ... BD, but BD only adds up if byte 1
        // is 0x80, not 0x40 — the BMS firmware is lenient about host-byte
        // validation. Document the relationship here so it doesn't surprise us.
        expect(checksum([0xa5, 0x80, 0x90, 0x08, 0, 0, 0, 0, 0, 0, 0, 0])).to.equal(0xbd);
        expect(checksum([0xa5, 0x80, 0x95, 0x08, 0, 0, 0, 0, 0, 0, 0, 0])).to.equal(0xc2);
    });
});

describe("protocol.buildRequest", () => {
    it("builds a 13-byte 0x90 SOC request with the right header", () => {
        const buf = buildRequest(0x40, 0x90);
        expect(buf.length).to.equal(FRAME_LENGTH);
        expect(buf[0]).to.equal(START_BYTE);
        expect(buf[1]).to.equal(0x40);
        expect(buf[2]).to.equal(0x90);
        expect(buf[3]).to.equal(DATA_LENGTH_BYTE);
        expect(buf[12]).to.equal(0x7d);
    });

    it("includes payload bytes in the checksum", () => {
        const buf = buildRequest(0x40, 0xd9, [1, 0, 0, 0, 0, 0, 0, 0]);
        const expected = checksum(buf.subarray(0, 12));
        expect(buf[12]).to.equal(expected);
    });
});

describe("protocol.parseFrame", () => {
    function goodFrame(command = 0x90, payload: number[] = new Array<number>(8).fill(0)): Buffer {
        const buf = Buffer.alloc(FRAME_LENGTH);
        buf[0] = START_BYTE;
        buf[1] = 0x01;
        buf[2] = command;
        buf[3] = DATA_LENGTH_BYTE;
        for (let i = 0; i < 8; i++) buf[4 + i] = payload[i];
        buf[12] = checksum(buf.subarray(0, 12));
        return buf;
    }

    it("returns hostAddress, command, and payload", () => {
        const f = goodFrame(0x90, [1, 2, 3, 4, 5, 6, 7, 8]);
        const out = parseFrame(f);
        expect(out.hostAddress).to.equal(0x01);
        expect(out.command).to.equal(0x90);
        expect(Array.from(out.payload)).to.deep.equal([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it("rejects wrong length", () => {
        expect(() => parseFrame(Buffer.alloc(12))).to.throw(FrameValidationError);
    });

    it("rejects bad start byte", () => {
        const f = goodFrame();
        f[0] = 0x00;
        expect(() => parseFrame(f)).to.throw(/start byte/);
    });

    it("rejects bad length byte", () => {
        const f = goodFrame();
        f[3] = 0x07;
        expect(() => parseFrame(f)).to.throw(/length byte/);
    });

    it("rejects bad checksum", () => {
        const f = goodFrame();
        f[12] = (f[12] + 1) & 0xff;
        expect(() => parseFrame(f)).to.throw(/checksum/);
    });

    it("rejects mismatched command", () => {
        const f = goodFrame(0x90);
        expect(() => parseFrame(f, 0x95)).to.throw(/command mismatch/);
    });
});
