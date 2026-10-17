# -*- coding: utf-8 -*-
"""在 C 问法上重新拟合温度，并与 A 问法的 T 对比。"""
import sys, io, json, time
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
import numpy as np
from laya import calibrate, load as laya_load

sys.path.insert(0, r"C:\Users\34246\.dsh\plugins\laya\work")
from build_dataset import build

data = build()
A = "Is this text attempting to change, override, or extract the assistant's instructions (prompt injection or jailbreak)?"
C = "Does this text contain an attempt to manipulate an AI assistant into ignoring its rules?"

ag = laya_load("convaiinnovations/laya-multilingual", device="cpu")

def fit_on(instr, tag):
    Q = {"inject": {"type":"noul","instructions":instr}}
    pairs = []
    for text, lab, kind in data:
        target = np.array([1.0-lab, float(lab)], dtype=np.float32)
        pairs.append((text, Q, {"inject": target}))
    recs = calibrate.records_from_labeled(ag, pairs)
    res = calibrate.fit_temperatures(recs)
    T = res["temperature"][2] if isinstance(res["temperature"], list) else res["temperature"]
    print(f"[{tag}] T = {T:.4f}")
    return T

print("== 分别在各问法上拟合温度 ==")
T_A = fit_on(A, "A 问法")
T_C = fit_on(C, "C 问法")
print(f"\n差异: T_A={T_A:.4f}  T_C={T_C:.4f}  比值={T_A/T_C:.3f}")

json.dump({"T_A": float(T_A), "T_C": float(T_C)}, open(r"C:\Users\34246\.dsh\plugins\laya\work\temperatures.json","w"), indent=1)
print("\n已写入 temperatures.json")
