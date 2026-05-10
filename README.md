# iobroker.daly-usb

ioBroker adapter that polls a DALY BMS over a USB-UART adapter and exposes its full state set as ioBroker objects.

## Features

- Reads all telemetry the DALY UART protocol exposes (commands `0x90`–`0x98`):
  pack voltage / current / SOC, min / max cell voltages and temperatures with
  cell numbers, MOSFET state, charger and load presence, cycle count, residual
  capacity (Ah) plus computed remaining energy (kWh), per-cell voltages,
  per-sensor temperatures, per-cell balancer state, and the full alarm flag set.
- Auto-adapts to the BMS configuration. On startup the adapter reads the cell
  count and temperature-sensor count from `0x94` and creates exactly that many
  `cells.cell_<n>`, `balancer.cell_<n>`, and `temps.sensor_<n>` objects, deleting
  stragglers from a previous run with a different configuration.
- Optional writable controls. When explicitly enabled in the adapter settings,
  `control.chargeMosfet` and `control.dischargeMosfet` issue `0xDA` / `0xD9`
  to the BMS. The adapter reads back the actual MOS state after each write
  and only acks the writable state if the BMS confirmed the change.
- Light on CPU and RAM. Read request frames are built once and cached, the
  serial port stays open across ticks, and read-only state writes use
  `setStateChangedAsync` so unchanged values don't hit the state DB.
- Connectivity is observable. `info.connection`, `info.lastSuccessfulTick`,
  and `info.lastAlarmUpdate` give automations a clear signal when the BMS is
  unreachable or the alarm data is stale.

## Configuration

Open the adapter settings in the ioBroker admin and configure:

| Setting | Default | Notes |
|---|---|---|
| `serialPort` | *(required)* | Path to the USB-UART device. **Use a stable `/dev/serial/by-id/...` path** to avoid surprises when other USB serial devices are present. |
| `baudRate` | `9600` | DALY UART speed. |
| `hostAddress` | `64` (`0x40`) | Upper-computer host byte. Some firmwares only respond at `128` (`0x80`). |
| `pollIntervalMs` | `5000` | Interval between full poll cycles. |
| `requestTimeoutMs` | `1000` | Per-request timeout on the bus. |
| `allowMosfetWrites` | `false` | **Dangerous.** See the safety section below. |

## Safety

This adapter can disconnect the battery from a load or charger if writable
controls are enabled. Read this before flipping the toggle.

- `allowMosfetWrites` is `false` by default. While it is off, the adapter does
  not subscribe to `control.*` and any incoming write is logged and ignored.
- When you turn `allowMosfetWrites` on, a write to `control.chargeMosfet` /
  `control.dischargeMosfet` switches the corresponding BMS MOSFET. **Switching
  the discharge MOSFET off disconnects the load.** **Switching the charge
  MOSFET off disconnects the charger.** Make sure your installation can handle
  this and that nothing critical depends on uninterrupted current.
- After every write the adapter rereads the BMS-reported MOS state. If the
  readback disagrees with the requested value the writable state stays at
  `ack: false` so automations can detect a silently-rejected write rather than
  acting on stale "confirmed" data.
- Plausibility bounds reject impossible parser outputs: SOC outside `0–110 %`,
  pack voltage outside `5–100 V`, cell voltage outside `0.5–4.5 V`,
  temperature outside `-40 to 100 °C`. An out-of-range value is logged and
  **not** published, so a wire glitch can't reach an automation as fact.
- Auto-discovery refuses to start the adapter if the BMS reports an
  implausible cell count (`> 48`) or temperature-sensor count (`> 16`).
- After three consecutive poll ticks with any command failure, `info.connection`
  flips to `false`. It returns to `true` on the next clean tick. The same
  flag also flips false if the BMS internal heartbeat byte (`bmsLife`) stops
  advancing for five successful reads.

## State tree

| State | Type | Unit | Notes |
|---|---|---|---|
| `info.connection` | boolean | – | true while the BMS is responsive |
| `info.lastSuccessfulTick` | string | ISO date | last fully-successful poll |
| `info.lastAlarmUpdate` | string | ISO date | last successful `0x98` read |
| `info.voltage` | number | V | pack voltage |
| `info.current` | number | A | pack current (sign convention is BMS-dependent) |
| `info.soc` | number | % | state of charge |
| `info.minCellVoltage`, `info.maxCellVoltage`, `info.cellDiff` | number | V | |
| `info.minCellNumber`, `info.maxCellNumber` | number | – | 1-based cell index |
| `info.minTemperature`, `info.maxTemperature` | number | °C | |
| `info.minSensorNumber`, `info.maxSensorNumber` | number | – | 1-based sensor index |
| `info.bmsState` | string | – | `stationary` / `charging` / `discharging` |
| `info.chargeMosOn`, `info.dischargeMosOn` | boolean | – | actual BMS MOS state |
| `info.chargerConnected`, `info.loadConnected` | boolean | – | from `0x94` |
| `info.cycleCount` | number | – | charge/discharge cycles |
| `info.residualCapacity` | number | Ah | from `0x93` |
| `info.energyRemaining` | number | kWh | computed: `residualCapacity × voltage / 1000` |
| `info.bmsLife` | number | – | BMS heartbeat byte |
| `cells.cell_<n>` | number | V | per-cell voltages |
| `temps.sensor_<n>` | number | °C | per-sensor temperatures |
| `balancer.cell_<n>` | boolean | – | true while the BMS is balancing that cell |
| `alarms.<key>` | boolean | – | one boolean per documented alarm bit (see `ALARM_FLAGS` in `src/lib/daly/commands.ts`) |
| `control.chargeMosfet`, `control.dischargeMosfet` | boolean (writable) | – | only honoured when `allowMosfetWrites` is true |

## Development

```bash
npm install            # install deps
npm run build          # tsc -> build/
npm run lint           # eslint . && tsc --noEmit
npm run test:ts        # mocha + ts-node, runs src/**/*.test.ts
npm run test:package   # @iobroker/testing package validation
npm run test:integration  # spins up js-controller against build/main.js (slow)
npm test               # test:ts + test:package
```

The DALY UART protocol details are documented in `CLAUDE.md`. The original
Python proof of concept lives in `reference.py` for reference; it implements
only `0x90` and `0x95` and is not used by the adapter.

## License

MIT — see `LICENSE`.
