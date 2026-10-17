# -*- coding: utf-8 -*-
"""用 C 措辞 + 校准后的概率，重新找最优阈值。

⚠️ 温度必须与问法配对：本脚本用的是 C 问法（"描述攻击行为"）的原始概率，
   所以必须用 **C 问法拟合出来的 T_C**，不能用 A 问法的 T_A。
   两者实测只差 0.5%（2.7363 vs 2.7235），但混用会让溯源链断裂——
   阈值就是在错误的温度空间里扫出来的。

T_C 由 fit_T_both.py 产出到 temperatures.json，这里优先读取；
读不到才退回硬编码值（与 server.py 的 TEMPERATURE 保持一致）。
"""
import json
import sys
import io
import math
import os

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
import numpy as np

# 与 server.py 的 TEMPERATURE 保持一致
FALLBACK_T_C = 2.7363243103027344

vr = json.load(open("variant_results.json", encoding="utf-8"))
d = json.load(open("dataset.json", encoding="utf-8"))
y = np.array([x["label"] for x in d])

p_raw = np.array(vr["C_聚焦攻击意图"]["p"])

# 优先读 fit_T_both.py 的产物
T = FALLBACK_T_C
if os.path.exists("temperatures.json"):
    temps = json.load(open("temperatures.json", encoding="utf-8"))
    T = float(temps["T_C"])
    print(f"[温度] 读 temperatures.json: T_C = {T:.6f}")
else:
    print(f"[温度] 未找到 temperatures.json，用硬编码 T_C = {T:.6f}")


def logit(x):
    x = np.clip(x, 1e-6, 1 - 1e-6)
    return np.log(x / (1 - x))


def sigmoid(z):
    return 1 / (1 + np.exp(-z))


p_cal = sigmoid(logit(p_raw) / T)


def stats(pp, th):
    pred = (pp >= th).astype(int)
    tp = int(((pred == 1) & (y == 1)).sum()); fp = int(((pred == 1) & (y == 0)).sum())
    fn = int(((pred == 0) & (y == 1)).sum()); tn = int(((pred == 0) & (y == 0)).sum())
    prec = tp / (tp + fp) if tp + fp else 0
    rec = tp / (tp + fn) if tp + fn else 0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0
    return prec, rec, f1, tp, fp, fn, tn


print("== 校准后概率分布 ==")
print(f"benign: min={p_cal[y==0].min():.4f} max={p_cal[y==0].max():.4f} mean={p_cal[y==0].mean():.4f}")
print(f"inject: min={p_cal[y==1].min():.4f} max={p_cal[y==1].max():.4f} mean={p_cal[y==1].mean():.4f}")

print("\n== 校准后阈值扫描 ==")
print("阈值   TP  FP  FN  TN   P      R     F1")
rows = []
for th in np.arange(0.01, 0.95, 0.01):
    prec, rec, f1, tp, fp, fn, tn = stats(p_cal, th)
    rows.append((th, prec, rec, f1, tp, fp, fn, tn))
    if f1 > 0.75 or (prec >= 0.95 and rec >= 0.55):
        print(f"{th:.2f}  {tp:3d} {fp:3d} {fn:3d} {tn:3d}  {prec:.3f}  {rec:.3f}  {f1:.3f}")

best_f1 = max(rows, key=lambda r: r[3])
print(f"\n最佳F1: th={best_f1[0]:.2f} F1={best_f1[3]:.3f} P={best_f1[1]:.3f} R={best_f1[2]:.3f} (FP={best_f1[5]},FN={best_f1[6]})")

# 高精度档：要求 precision >= 0.95
hp = [r for r in rows if r[1] >= 0.95]
if hp:
    b = max(hp, key=lambda r: r[2])
    print(f"高精度: th={b[0]:.2f} P={b[1]:.3f} R={b[2]:.3f} F1={b[3]:.3f} (FP={b[5]},FN={b[6]})")

# 平衡档：F1 最大且误报率<=10%
fp_ok = [r for r in rows if r[5] <= 0.10 * 36]
if fp_ok:
    b = max(fp_ok, key=lambda r: r[3])
    print(f"误报≤10%: th={b[0]:.2f} P={b[1]:.3f} R={b[2]:.3f} F1={b[3]:.3f} (FP={b[5]},FN={b[6]})")

print("\n== 与 server.py 常量核对 ==")
print(f"server.py TEMPERATURE = {FALLBACK_T_C:.6f}")
print(f"本脚本使用 T          = {T:.6f}")
print(f"一致: {abs(T - FALLBACK_T_C) < 1e-9}")
