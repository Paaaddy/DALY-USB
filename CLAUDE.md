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

`npm run lint` runs ESLint (flat config in `eslint.config.mjs`, type-checked rules from `typescript-eslint`) and then `tsc --noEmit`. The project file passed to ESLint's typed parser is `tsconfig.json`, so any `.ts` source must be reachable from there.

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

- `transport.ts` serialises every request through a single async queue (`this.queue.then(exec, exec)`) so polls and writes from `onStateChange` cannot interleave bytes on the bus. Anything that touches the BMS must go through `DalyTransport.request()`. After `close()` the transport flips a `closed` flag and rejects subsequent `request()` calls synchronously with `TransportClosedError` — required so writes that arrive during `onUnload` cannot land on a torn-down port.
- All parsers in `commands.ts` are pure functions over a `Buffer` payload. Add new commands by adding a parser there and a corresponding `tick<X>()` in `main.ts`. Do not parse bytes inline in `main.ts`.
- `main.poll()` issues every read command per tick, each wrapped in `guarded(label, fn)` (returns `false` on failure). After 3 consecutive ticks with any failure `info.connection` flips false; on the next clean tick it flips back to true and `info.lastSuccessfulTick` is updated.
- Plausibility bounds in `Bounds` (commands.ts) reject impossible parser outputs (SOC > 110 %, voltage outside 5–100 V, cell V outside 0.5–4.5 V, etc.) so wire glitches never reach ioBroker as fact. `tick*` functions throw on out-of-range — `guarded()` then suppresses the publish.
- `combineCellVoltageFrames` / `combineTemperatureFrames` strictly require the received `frameIndex` set to be exactly `{1..ceil(n/k)}`. Duplicate or missing frames throw rather than silently leaving cells/sensors at 0 V / -40 °C.
- Auto-discovery (`main.discover()`) reads 0x94 once, clamps to `MAX_CELLS=48` / `MAX_TEMP_SENSORS=16`, and refuses to start if the BMS reports impossible counts. `syncDynamicObjects()` creates exactly N cell + balancer objects and M temp-sensor objects, deleting any stragglers from a previous run with a different cell count.
- MOSFET writes are gated by `native.allowMosfetWrites` (default `false`). When enabled, `handleMosfetWrite()` sends the write, runs `tickMosfetStatus()` to read the BMS-reported MOS state, and only acks the writable `control.*` state if the readback matches the requested value — otherwise the state stays at `ack: false` so automations can detect a rejected write.
- `bmsLife` is the BMS's internal heartbeat byte. `tickMosfetStatus` watches it; if it fails to advance for 5 consecutive successful reads, `info.connection` flips false (BMS is locked up even though the bus is open).
- `subscribeStates` is limited to `control.*` and only happens when `allowMosfetWrites` is true. Read-only states use `setStateChangedAsync` to keep DB writes minimal.
- `onUnload` order matters: `unsubscribeStatesAsync('control.*')` first (no new writes accepted), then `await poller.stop()` (waits for the in-flight tick), then `await transport.close()`, then ack `info.connection=false`. Reordering this re-introduces the unload race.

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

## Git install note

`prepare` (not `prepublishOnly`) runs when ioBroker installs the adapter via `iobroker url github.com/...`. Both scripts must call `npm run build` so TypeScript compiles on both git installs and npm publishes. Do not remove `prepare`.
