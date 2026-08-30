"""PLC communication layer — Snap7 wrapper for S7-1200 (DB4 energy + DB8 billets).

Optimized block access must be OFF on DB4 and DB8 in TIA Portal.
"""
from pac3200_reader import (  # noqa: F401
    PLCReader,
    PLC_IP,
    RACK,
    SLOT,
    BILLETS_DB_NUMBER,
    BILLETS_COUNT_TAGS,
    BILLETS_HMD_BOOLS,
)
