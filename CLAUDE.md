# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

This repository is in an **early/planning stage**. It currently contains only:

- `README.md` — describes the goal: an ioBroker adapter that talks to a DALY BMS over a USB-UART adapter.
- `reference.py` — a standalone working Python proof of concept that polls the BMS and pushes values into ioBroker via its REST API. It is **not** the adapter itself; it exists only as a behavioural reference for the eventual adapter.
- No adapter scaffolding yet (no `package.json`, no `io-package.json`, no `src/`, no tests, no lint/build config). When implementation begins, the adapter is expected to follow the standard ioBroker adapter layout (typically JavaScript/TypeScript using `@iobroker/adapter-core`).

Because there is no build system yet, there are no project-specific build, lint, or test commands to document. Add them to this file as soon as the adapter is scaffolded.

## Goals the adapter must hit (from README)

- Run as an ioBroker adapter (not a standalone script).
- Read all states exposed by the official DALY BMS API.
- Create read-only states with correct units (V, kWh, A, %, °C, …).
- Create writable states for every writable DALY API call.
- Be light on CPU and RAM.
- Auto-adapt to the BMS configuration (e.g. number of cells), instead of hardcoding it as `reference.py` does.

The "auto-adapts to number of cells" requirement is the main behavioural delta from `reference.py`, which assumes 8 cells across 3 frames. The adapter must instead derive cell count from the BMS and request/parse the appropriate number of frames.

## DALY UART protocol notes (extracted from `reference.py`)

These are the concrete protocol details encoded in the reference script — preserve them when porting:

- **Serial settings**: 9600 baud, 1 s read timeout, frames are 13 bytes.
- **Frame start byte**: `0xA5`. Command byte is at index 2.
- **Request — SOC / pack voltage / pack current** (`0x90`):
  `A5 40 90 08 00 00 00 00 00 00 00 00 BD`
  Response (13 bytes):
  - `voltage = ((res[4] << 8) | res[5]) / 10.0` → V
  - `current = (((res[8] << 8) | res[9]) - 30000) / 10.0` → A (note the 30000 offset; positive = charge / negative = discharge depending on BMS)
  - `soc     = ((res[10] << 8) | res[11]) / 10.0` → %
- **Request — cell voltages** (`0x95`):
  `A5 40 95 08 00 00 00 00 00 00 00 00 C2`
  Response is multi-frame; each frame carries 3 cell values. `res[4]` is the 1-based frame index. Cell voltage = `((hi << 8) | lo) / 1000.0` → V. `reference.py` reads exactly 3 frames for an 8-cell pack (frame 3 only fills 2 cells); the adapter must instead read `ceil(n_cells / 3)` frames.
- The trailing byte of each request is a checksum. If you add new commands, compute it as the 8-bit sum of the preceding 12 bytes.

## Reference script behaviour (for parity testing)

`reference.py` polls every 5 s and pushes values to ioBroker via HTTP to `http://<IOBROKER_IP>:8087/set/0_userdata.0.bms.<state>?value=<v>&ack=true`. State names used (useful as a baseline for the adapter's object tree):

- `voltage`, `current`, `soc`
- `cells.cell_1` … `cells.cell_N`
- `min_cell_voltage`, `max_cell_voltage`, `cell_diff`

The adapter should expose the same semantic states (plus everything else from the DALY API) as proper ioBroker objects with units, instead of via the REST simple API.

## Branching

Development for this task happens on `claude/add-claude-documentation-Up42b`. Push to that branch; do not push to `main` without explicit instruction.
