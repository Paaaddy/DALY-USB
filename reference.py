import serial
import time
import requests

# --- KONFIGURATION ---
SERIAL_PORT = '/dev/ttyUSB0'  # Dein FT232H Adapter
IOBROKER_IP = '192.168.178.XX' # BITTE DEINE IP EINTRAGEN
BASE_URL = f"http://{IOBROKER_IP}:8087/set/0_userdata.0.bms"

# Daly UART Befehle (Hex-Protokoll)
REQ_SOC = b'\xA5\x40\x90\x08\x00\x00\x00\x00\x00\x00\x00\x00\xBD'
REQ_CELLS = b'\xA5\x40\x95\x08\x00\x00\x00\x00\x00\x00\x00\x00\xC2'

def get_bms_data():
    results = {"general": None, "cells": [], "stats": {}}
    try:
        ser = serial.Serial(SERIAL_PORT, 9600, timeout=1)
        
        # 1. Gesamtwerte abfragen (SOC, Spannung, Strom)
        ser.write(REQ_SOC)
        res = ser.read(13)
        if len(res) == 13 and res[0] == 0xA5:
            voltage = ((res[4] << 8) | res[5]) / 10.0
            current = (((res[8] << 8) | res[9]) - 30000) / 10.0
            soc = ((res[10] << 8) | res[11]) / 10.0
            results["general"] = {"v": voltage, "c": current, "s": soc}

        # 2. Zellspannungen abfragen (8 Zellen über 3 Frames)
        ser.write(REQ_CELLS)
        cells = [0.0] * 8
        for _ in range(3): # Wir lesen 3 Antwort-Pakete
            res = ser.read(13)
            if len(res) == 13 and res[0] == 0xA5 and res[2] == 0x95:
                frame_idx = res[4]
                if frame_idx == 1: # Zellen 1-3
                    cells[0] = ((res[5] << 8) | res[6]) / 1000.0
                    cells[1] = ((res[7] << 8) | res[8]) / 1000.0
                    cells[2] = ((res[9] << 8) | res[10]) / 1000.0
                elif frame_idx == 2: # Zellen 4-6
                    cells[3] = ((res[5] << 8) | res[6]) / 1000.0
                    cells[4] = ((res[7] << 8) | res[8]) / 1000.0
                    cells[5] = ((res[9] << 8) | res[10]) / 1000.0
                elif frame_idx == 3: # Zellen 7-8
                    cells[6] = ((res[5] << 8) | res[6]) / 1000.0
                    cells[7] = ((res[7] << 8) | res[8]) / 1000.0
        
        results["cells"] = cells

        # 3. Min / Max / Drift berechnen
        if all(c > 0 for c in cells): # Nur berechnen, wenn alle Zellen gelesen wurden
            results["stats"]["min"] = min(cells)
            results["stats"]["max"] = max(cells)
            results["stats"]["diff"] = max(cells) - min(cells)

        ser.close()
        return results
    except Exception as e:
        print(f"Fehler beim Lesen vom BMS: {e}")
    return None

def send_to_iobroker(data):
    try:
        # Sende Gesamtwerte
        if data["general"]:
            g = data["general"]
            requests.get(f"{BASE_URL}.voltage?value={g['v']}&ack=true")
            requests.get(f"{BASE_URL}.current?value={g['c']}&ack=true")
            requests.get(f"{BASE_URL}.soc?value={g['s']}&ack=true")
        
        # Sende Einzelzellen
        for i, val in enumerate(data["cells"]):
            requests.get(f"{BASE_URL}.cells.cell_{i+1}?value={val}&ack=true")
        
        # Sende Min/Max/Diff
        if data["stats"]:
            s = data["stats"]
            requests.get(f"{BASE_URL}.min_cell_voltage?value={s['min']}&ack=true")
            requests.get(f"{BASE_URL}.max_cell_voltage?value={s['max']}&ack=true")
            requests.get(f"{BASE_URL}.cell_diff?value={round(s['diff'], 3)}&ack=true")
        
        print(f"BMS-Update: Min {data['stats'].get('min')}V | SOC {data['general'].get('s')}%")
    except Exception as e:
        print(f"Sende-Fehler: {e}")

# MAIN LOOP
print("BMS Überwachung gestartet...")
while True:
    bms_data = get_bms_data()
    if bms_data:
        send_to_iobroker(bms_data)
    time.sleep(5) # Alle 5 Sekunden aktualisieren