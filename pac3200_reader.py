"""
pac3200_reader.py
------------------
Reads S7-1200 tags over Ethernet (python-snap7):

  DB4  MOV_DB_DB       — PAC3200 energy meter (Input section Reals/LReals)
  DB8  BILLETS_COUNTS  — HMD Bools + DWord production counters

Both DBs need Optimized block access = FALSE for PUT/GET byte offsets.

INSTALL
    pip install python-snap7

    python-snap7 wraps a C library (snap7). On Windows, if you get an
    error like "could not find snap7.dll", download the prebuilt DLL from
    https://snap7.sourceforge.net/ and drop it next to this script (or on
    your PATH). On Linux, `pip install python-snap7` usually pulls a
    working build automatically.

BEFORE THIS WILL CONNECT — CHECK IN TIA PORTAL
    1. CPU Properties -> Protection & Security -> "Permit access with
       PUT/GET communication from remote partner" must be CHECKED, then
       download to the PLC again (this setting only takes effect after
       a download).
    2. DB4 (MOV_DB_DB) must have S7_Optimized_Access = FALSE so it can
       be addressed by byte offset. If it's currently optimized, open
       the DB's Properties -> Attributes and untick "Optimized block
       access", then recompile/download.

VALUES YOU MUST FILL IN BELOW
    PLC_IP - your S7-1200's actual IP address (RACK=0, SLOT=1 is correct
             for a CPU 1214C in almost all setups, so those are already
             filled in for you).
"""

import struct
import snap7

# ---------------- CONFIG: fill this in ----------------
PLC_IP = "192.168.0.1"   # <-- replace with your S7-1200's real IP
RACK = 0
SLOT = 1
DB_NUMBER = 4              # confirmed: MOV_DB_DB is DB4
# ---------------------------------------------------------

# (tag_name_as_in_TIA, byte_offset, type)  type: "R" = Real (4 bytes), "LR" = LReal (8 bytes)
# --- Input section (DB4 Input) — meter read path; not used for live HMI ---
INPUT_TAGS = [
    ("I_KWH_",                   0.0, "LR"),
    ("I_KVAH_1",                 8.0, "LR"),
    ("I_KVARH_1",                16.0, "LR"),
    ("3-Ph Average Curr_1",      24.0, "R"),
    ("3-Ph Average Volt L-L_1",  28.0, "R"),
    ("3-Ph Average Volt L-N_1",  32.0, "R"),
    ("Voltage L1-L2_1",          36.0, "R"),
    ("Voltage L1-N_1",           40.0, "R"),
    ("Voltage L2-L3_1",          44.0, "R"),
    ("Voltage L2-N_1",           48.0, "R"),
    ("Voltage L3-L1_2",          52.0, "R"),
    ("Voltage L3-N_2",           56.0, "R"),
    ("Total Active Power_1",     60.0, "R"),
    ("Total Apparent Power_1",   64.0, "R"),
    ("Total Power Factor_1",     68.0, "R"),
    ("Total Reac Power_1",       72.0, "R"),
    ("Active Power L1_1",        76.0, "R"),
    ("Active Power L2_1",        80.0, "R"),
    ("Active Power L3_1",        84.0, "R"),
    ("Apparent Power L1_1",      88.0, "R"),
    ("Apparent Power L2_1",      92.0, "R"),
    ("Apparent Power L3_1",      96.0, "R"),
    ("Reactive power L1_1",      100.0, "R"),
    ("Reactive power L2_1",      104.0, "R"),
    ("Reactive power L3_1",      108.0, "R"),
    ("Power Factor L1_1",        112.0, "R"),
    ("Power Factor L2_1",        116.0, "R"),
    ("Power Factor L3_1",        120.0, "R"),
    ("THD Current L1_1",         124.0, "R"),
    ("THD Current L2_1",         128.0, "R"),
    ("THD Current L3_1",         132.0, "R"),
    ("THD Voltage L1_1",         136.0, "R"),
    ("THD Voltage L2_1",         140.0, "R"),
    ("THD Voltage L3_1",         144.0, "R"),
    ("Line Frequency_1",         148.0, "R"),
]

# --- Output section (DB4 Output) — live HMI + Raw Tags (offset 152+) ---
OUTPUT_TAGS = [
    ("O_KWH_1",                  152.0, "LR"),
    ("O_KVAH_1",                 160.0, "LR"),
    ("O_KVARH_1",                168.0, "LR"),
    ("3-Ph Average Curr_2",      176.0, "R"),
    ("3-Ph Average Volt L-L_2",  180.0, "R"),
    ("3-Ph Average Volt L-N_2",  184.0, "R"),
    ("Voltage L1-L2_2",          188.0, "R"),
    ("Voltage L1-N_2",           192.0, "R"),
    ("Voltage L2-L3_2",          196.0, "R"),
    ("Voltage L2-N_2",           200.0, "R"),
    ("Voltage L3-L1_3",          204.0, "R"),
    ("Voltage L3-N_3",           208.0, "R"),
    ("Total Active Power_2",     212.0, "R"),
    ("Total Apparent Power_2",   216.0, "R"),
    ("Total Power Factor_2",     220.0, "R"),
    ("Total Reac Power_2",       224.0, "R"),
    ("Active Power L1_2",        228.0, "R"),
    ("Active Power L2_2",        232.0, "R"),
    ("Active Power L3_2",        236.0, "R"),
    ("Apparent Power L1_2",      240.0, "R"),
    ("Apparent Power L2_2",      244.0, "R"),
    ("Apparent Power L3_2",      248.0, "R"),
    ("Reactive power L1_2",      252.0, "R"),
    ("Reactive power L2_2",      256.0, "R"),
    ("Reactive power L3_2",      260.0, "R"),
    ("Power Factor L1_2",        264.0, "R"),
    ("Power Factor L2_2",        268.0, "R"),
    ("Power Factor L3_2",        272.0, "R"),
    ("THD Current L1_2",         276.0, "R"),
    ("THD Current L2_2",         280.0, "R"),
    ("THD Current L3_2",         284.0, "R"),
    ("THD Voltage L1_2",         288.0, "R"),
    ("THD Voltage L2_2",         292.0, "R"),
    ("THD Voltage L3_2",         296.0, "R"),
    ("Line Frequency_2",         300.0, "R"),
]

ALL_TAGS = INPUT_TAGS + OUTPUT_TAGS
# Live path uses Output group only (HMI + Raw Tags)
LIVE_TAGS = OUTPUT_TAGS
LIVE_TAG_NAMES = {t[0] for t in LIVE_TAGS}
DB_READ_SIZE = 304  # Line Frequency_2 (Output) ends at byte 304
# Compat aliases so existing HMI/history keys keep working from Output energy
ENERGY_ALIASES = {
    "O_KWH_1": "I_KWH_",
    "O_KVAH_1": "I_KVAH_2",
    "O_KVARH_1": "I_KVARH_2",
}

# ── BILLETS_COUNTS [DB8] — HMD presence + production counters ──────────────
# Confirmed from TIA Portal: PLC_1 → Program blocks → BILLETS_COUNTS [DB8]
BILLETS_DB_NUMBER = 8
BILLETS_DB_READ_SIZE = 44  # through TMT_RESET @ 43.1

# (name, byte_offset, bit) — Bool
BILLETS_HMD_BOOLS = [
    ("CCM_STAND1_HMD",   0, 0),
    ("CCM_STAND2_HMD",   0, 1),
    ("CCM_RM_ENTRY_HMD", 0, 2),
    ("R3_HMD",           0, 3),
    ("CCS1_HMD",         0, 4),
    ("CCS2_HMD",         0, 5),
    ("DSHEAR_HMD",       0, 6),
    ("BLOCK_ENTRY_HMD",  0, 7),
    ("BLOCK_EXIT_HMD",   1, 0),
    ("TMT_HMD",          1, 1),
]

# (name, byte_offset) — DWord (UDInt), big-endian
BILLETS_COUNT_TAGS = [
    ("CCM_STAND1_COUNTS",   2),
    ("CCM_STAND2_COUNTS",   6),
    ("CCM_RM_ENTRY_COUNTS", 10),
    ("R3_COUNTS",           14),
    ("CCS1_COUNTS",         18),
    ("CCS2_COUNTS",         22),
    ("DSHEAR_COUNTS",       26),
    ("BLOCK_ENTRY_COUNTS",  30),
    ("BLOCK_EXIT_COUNTS",   34),
    ("TMT_COUNTS",          38),
]

# Reset bits (write path reserved for future UI)
BILLETS_RESET_BOOLS = [
    ("CCM_STAND1_RESET",   42, 0),
    ("CCM_STAND2_RESET",   42, 1),
    ("CCM_RM_ENTRY_RESET", 42, 2),
    ("R3_RESET",           42, 3),
    ("CCS1_RESET",         42, 4),
    ("CCS2_RESET",         42, 5),
    ("DSHEAR_RESET",       42, 6),
    ("BLOCK_ENTRY_RESET",  42, 7),
    ("BLOCK_EXIT_RESET",   43, 0),
    ("TMT_RESET",          43, 1),
]


class PLCReader:
    """Wraps a snap7 connection to the S7-1200 and reads DB4 + DB8."""

    def __init__(self, ip=PLC_IP, rack=RACK, slot=SLOT, db_number=DB_NUMBER,
                 billets_db=BILLETS_DB_NUMBER):
        self.ip = ip
        self.rack = rack
        self.slot = slot
        self.db_number = db_number
        self.billets_db = billets_db
        self.client = snap7.client.Client()

    def connect(self):
        if not self.client.get_connected():
            self.client.connect(self.ip, self.rack, self.slot)
        return self.client.get_connected()

    def disconnect(self):
        if self.client.get_connected():
            self.client.disconnect()

    def read_energy(self, group="output"):
        """Reads DB4 (MOV_DB_DB) PAC3200 tags.

        group:
          'output' — DB4 Output (default; live HMI + Raw Tags)
          'input'  — DB4 Input only
          'both'   — Input + Output
        """
        if not self.client.get_connected():
            self.connect()
        try:
            raw = self.client.db_read(self.db_number, 0, DB_READ_SIZE)
        except Exception as exc:
            raise RuntimeError(f"PLC DB4 read failed: {exc}") from exc

        if group == "input":
            tags = INPUT_TAGS
        elif group == "both":
            tags = INPUT_TAGS + OUTPUT_TAGS
        else:
            tags = LIVE_TAGS  # output

        values = {}
        for name, offset, dtype in tags:
            off = int(offset)
            if dtype == "LR":
                values[name] = struct.unpack_from(">d", raw, off)[0]
            else:
                values[name] = struct.unpack_from(">f", raw, off)[0]

        # Aliases for dashboards that still key on I_* energy names
        if group in ("output", "both"):
            for src, alias in ENERGY_ALIASES.items():
                if src in values and alias not in values:
                    values[alias] = values[src]
            values["_db4_group"] = "output" if group == "output" else "both"
        else:
            values["_db4_group"] = "input"
        return values

    def read_billets(self):
        """Reads DB8 (BILLETS_COUNTS) HMD bools + DWord counters."""
        if not self.client.get_connected():
            self.connect()
        try:
            raw = self.client.db_read(self.billets_db, 0, BILLETS_DB_READ_SIZE)
        except Exception as exc:
            raise RuntimeError(f"PLC DB8 read failed: {exc}") from exc

        values = {}
        for name, byte_off, bit in BILLETS_HMD_BOOLS:
            values[name] = bool(raw[byte_off] & (1 << bit))
        for name, byte_off in BILLETS_COUNT_TAGS:
            values[name] = struct.unpack_from(">I", raw, byte_off)[0]
        for name, byte_off, bit in BILLETS_RESET_BOOLS:
            values[name] = bool(raw[byte_off] & (1 << bit))
        return values

    def read(self, group="output"):
        """Reads DB4 Output (default) + DB8 billets into one flat tag dict."""
        values = self.read_energy(group=group)
        try:
            values.update(self.read_billets())
            values["_billets_ok"] = True
        except Exception as exc:
            # Energy still usable if DB8 not yet non-optimized / available
            values["_billets_ok"] = False
            values["_billets_error"] = str(exc)
        return values


if __name__ == "__main__":
    reader = PLCReader()
    print(f"Connecting to {reader.ip} (rack {reader.rack}, slot {reader.slot})...")
    if not reader.connect():
        print("Could not connect. Check IP, rack/slot, and that PUT/GET access is enabled.")
    else:
        print("Connected. Reading DB4 Output + DB8...")
        try:
            data = reader.read(group="output")
            print("--- DB4 Output (sample) ---")
            for k in ("O_KWH_1", "Total Active Power_2", "Line Frequency_2", "3-Ph Average Curr_2"):
                if k in data:
                    print(f"  {k:28s} = {data[k]}")
            print("--- DB8 billets ---")
            for name, _, _ in BILLETS_HMD_BOOLS:
                print(f"  {name:28s} = {data.get(name)}")
            for name, _ in BILLETS_COUNT_TAGS:
                print(f"  {name:28s} = {data.get(name)}")
            print(f"  billets_ok = {data.get('_billets_ok')}")
        except RuntimeError as e:
            print(e)
        finally:
            reader.disconnect()
