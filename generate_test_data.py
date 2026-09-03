import csv
import os
import random
from datetime import datetime, timedelta

# Change this to your actual data folder
LOG_DIR = r"D:\Smart EMS and MIS Project\Plant_Data"
today = datetime.now().date().isoformat()
csv_path = os.path.join(LOG_DIR, f"pac3200_log_{today}.csv")

# Ensure file exists with header
header = [
    "timestamp", "O_KWH_1", "O_KVAH_1", "O_KVARH_1",
    "3-Ph Average Curr_2", "3-Ph Average Volt L-L_2", "3-Ph Average Volt L-N_2",
    "Voltage L1-L2_2", "Voltage L1-N_2", "Voltage L2-L3_2", "Voltage L2-N_2",
    "Voltage L3-L1_3", "Voltage L3-N_3", "Total Active Power_2", "Total Apparent Power_2",
    "Total Power Factor_2", "Total Reac Power_2", "Active Power L1_2", "Active Power L2_2",
    "Active Power L3_2", "Apparent Power L1_2", "Apparent Power L2_2", "Apparent Power L3_2",
    "Reactive power L1_2", "Reactive power L2_2", "Reactive power L3_2",
    "Power Factor L1_2", "Power Factor L2_2", "Power Factor L3_2",
    "THD Current L1_2", "THD Current L2_2", "THD Current L3_2",
    "THD Voltage L1_2", "THD Voltage L2_2", "THD Voltage L3_2",
    "Line Frequency_2", "I_KWH_", "I_KVAH_2", "I_KVARH_2",
    "CCM_STAND1_HMD", "CCM_STAND2_HMD", "CCM_RM_ENTRY_HMD", "R3_HMD",
    "CCS1_HMD", "CCS2_HMD", "DSHEAR_HMD", "BLOCK_ENTRY_HMD", "BLOCK_EXIT_HMD", "TMT_HMD",
    "CCM_STAND1_COUNTS", "CCM_STAND2_COUNTS", "CCM_RM_ENTRY_COUNTS", "R3_COUNTS",
    "CCS1_COUNTS", "CCS2_COUNTS", "DSHEAR_COUNTS", "BLOCK_ENTRY_COUNTS",
    "BLOCK_EXIT_COUNTS", "TMT_COUNTS"
]

# Create the file with header if not exists
if not os.path.exists(csv_path):
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerow(header)

# Generate test rows – start from a fixed time (e.g., today 08:00)
start_time = datetime.now().replace(hour=8, minute=0, second=0, microsecond=0)
rows = []
# Generate 1 minute of data (60 rows, one per second)
for i in range(60):
    ts = start_time + timedelta(seconds=i)
    # Simulate load: 500-1500 kW
    kw = random.uniform(500, 1500)
    pf = random.uniform(0.85, 0.98)
    kva = kw / pf
    kvar = (kva**2 - kw**2) ** 0.5
    # Simulate counters slowly increasing
    s1 = 10 + i // 10
    s2 = 8 + i // 10
    r3 = 5 + i // 5
    tmt = 4 + i // 5
    # Build row as a list
    row = [
        ts.isoformat(),
        1000 + i * 0.5, 2000 + i * 0.6, 3000 + i * 0.1,
        random.uniform(50, 100), 400, 230,
        400, 230, 400, 230, 400, 230,
        kw, kva, pf, kvar,
        kw/3, kw/3, kw/3, kva/3, kva/3, kva/3, kvar/3, kvar/3, kvar/3,
        pf, pf, pf,
        random.uniform(4, 8), random.uniform(4, 8), random.uniform(4, 8),
        random.uniform(1, 3), random.uniform(1, 3), random.uniform(1, 3),
        50,
        1000 + i * 0.5, 2000 + i * 0.6, 3000 + i * 0.1,
        0,0,0,0,0,0,0,0,0,0,  # HMD booleans
        s1, s2, r3, r3, r3, r3, r3, r3, r3, tmt  # counters
    ]
    rows.append(row)

# Write rows (append mode)
with open(csv_path, "a", newline="", encoding="utf-8") as f:
    writer = csv.writer(f)
    writer.writerows(rows)

print(f"Added {len(rows)} test rows to {csv_path}")