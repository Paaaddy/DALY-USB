# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`iobroker.daly-usb` is an ioBroker adapter (TypeScript, Node 18+) that polls a DALY BMS over a USB-UART adapter and exposes its full state set as ioBroker objects. The original Python proof of concept lives in `reference.py` and stays in tree as a behavioural reference; the adapter itself is in `src/`.

## Commands

```bash
npm install            # install deps
npm run build          # tsc -> build/
npm run lint           # tsc --noEmit on the whole project (incl. tests)
npm run test:ts        # mocha + ts-node, runs src/**/*.test.ts
npm run test:package   # @iobroker/testing package validation
npm run test:integration  # spins up js-controller against build/main.js (slow)
npm test               # test:ts + test:package
```

Run a single unit test file directly:

```bash
npx mocha --config test/mocharc.custom.json "src/lib/daly/protocol.test.ts"
```

`npm run lint` is just a strict typecheck — there is no ESLint config yet. Add one if you need style rules.

## Architecture

The adapter is split into pure protocol code (easy to unit-test) and an I/O shell (harder to test, deliberately thin).

```
src/
├── main.ts                    adapter lifecycle, object tree, poll loop, write handler
└── lib/daly/
    ├── protocol.ts            frame builder, checksum, parseFrame (pure)
    ├── commands.ts            command IDs + per-command parsers (pure)
    ├── transport.ts           SerialPort wrapper, ByteLengthParser(13), serialised request queue
    └── poller.ts              re-entrant-safe interval driver
```

**Key invariants worth preserving:**

- `transport.ts` serialises every request through a single async queue (`this.queue.then(exec, exec)`) so polls and writes from `onStateChange` cannot interleave bytes on the bus. Anything that touches the BMS must go through `DalyTransport.request()`.
- All parsers in `commands.ts` are pure functions over a `Buffer` payload. Add new commands by adding a parser there and a corresponding `tick<X>()` in `main.ts`. Do not parse bytes inline in `main.ts`.
- `main.poll()` issues every read command per tick, each wrapped in `guarded(label, fn)` so a single command failure logs at warn (or debug, on repeats) and the rest of the tick continues. This is what makes the adapter resilient to transient BMS hiccups.
- Auto-discovery (`main.discover()`) runs once after the port opens, reads 0x94, and caches `BmsConfig { cellCount, tempSensorCount }`. `syncDynamicObjects()` then creates exactly N cell + balancer objects and M temp-sensor objects, deleting any stragglers from a previous run with a different cell count.
- `subscribeStates` is limited to `control.*`. Read-only states use `setStateChangedAsync` to keep DB writes minimal.

## DALY UART protocol notes

Useful when extending `commands.ts` or debugging transport issues.

- Frame: 13 bytes. `[0]=0xA5`, `[1]=hostAddress`, `[2]=command`, `[3]=0x08`, `[4..11]=payload`, `[12]=sum&0xFF` of bytes 0..11.
- Host address: the canonical UART value is `0x40`. Some firmwares are lenient and respond regardless. **`reference.py`'s stored frames have `[1]=0x40` but checksums (`0xBD`, `0xC2`) that only add up if `[1]=0x80`.** This is captured as a test case in `protocol.test.ts`. The `hostAddress` adapter setting defaults to 64 (0x40); flip to 128 if your BMS only responds at 0x80.
- Multi-frame responses: 0x95 returns `ceil(cellCount/3)` frames (3 cells/frame), 0x96 returns `ceil(sensorCount/7)` frames (7 sensors/frame). `payload[0]` is the 1-based frame index. The `combine*Frames` helpers reassemble in any order.
- Temperature encoding: `byte - 40` (so 0 = -40°C). Applies to 0x92 and 0x96.
- Pack current encoding: `(raw - 30000) / 10` in A. Negative = discharge convention is BMS-dependent.
- Writable commands implemented: `0xD9` (set discharge MOSFET), `0xDA` (set charge MOSFET). Both take a 1/0 byte at `payload[0]`.
- Alarm flag table (`ALARM_FLAGS` in `commands.ts`) is the source of truth for `alarms.*` state names; add new bits there and they automatically get an object and a poll write.

## Testing patterns

- Pure parsers go in `src/lib/daly/*.test.ts` and run via `ts-node`. Mocha picks them up via the `mocharc.custom.json` glob.
- Don't unit-test `main.ts` directly — use `tests.integration` from `@iobroker/testing` (`test/integration/test.js`) which spins up an actual js-controller. Slow; run on demand, not in pre-commit.
- Package shape (io-package.json keys, valid JSON, license, etc.) is covered by `test/package/test.js` and runs in CI.

## Branching

Active development branch: `claude/add-claude-documentation-Up42b`. Do not push to `main` without explicit instruction.
