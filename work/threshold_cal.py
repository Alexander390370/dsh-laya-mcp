# -*- coding: utf-8 -*-
"""用 C 措辞 + 校准后的概率，重新找最优阈值。"""
import json, sys, io, math
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
import numpy as np

vr = json.load(open("variant_results.json", encoding="utf-8"))
d  = json.load(open("dataset.json", encoding="utf-8"))
y  = np.array([x["label"] for x in d])

p_raw = np.array(vr["C_聚焦攻击意图"]["p"])
T = 2.7235312461853027
def logit(x): x=np.clip(x,1e-6,1-1e-6); return np.log(x/(1-x))
def sigmoid(z): return 1/(1+np.exp(-z))
p_cal = sigmoid(logit(p_raw)/T)

def stats(pp, th):
    pred=(pp>=th).astype(int)
    tp=int(((pred==1)&(y==1)).sum()); fp=int(((pred==1)&(y==0)).sum())
    fn=int(((pred==0)&(y==1)).sum()); tn=int(((pred==0)&(y==0)).sum())
    prec=tp/(tp+fp) if tp+fp else 0; rec=tp/(tp+fn) if tp+fn else 0
    f1=2*prec*rec/(prec+rec) if prec+rec else 0
    return prec,rec,f1,tp,fp,fn,tn

print("== 校准后概率分布 ==")
print(f"benign: min={p_cal[y==0].min():.4f} max={p_cal[y==0].max():.4f} mean={p_cal[y==0].mean():.4f}")
print(f"inject: min={p_cal[y==1].min():.4f} max={p_cal[y==1].max():.4f} mean={p_cal[y==1].mean():.4f}")

print("\n== 校准后阈值扫描 ==")
print("阈值   TP  FP  FN  TN   P      R     F1")
rows=[]
for th in np.arange(0.01,0.95,0.01):
    prec,rec,f1,tp,fp,fn,tn = stats(p_cal, th)
    rows.append((th,prec,rec,f1,tp,fp,fn,tn))
    if f1>0.75 or (prec>=0.95 and rec>=0.55):
        print(f"{th:.2f}  {tp:3d} {fp:3d} {fn:3d} {tn:3d}  {prec:.3f}  {rec:.3f}  {f1:.3f}")

best_f1 = max(rows, key=lambda r:r[3])
print(f"\n最佳F1: th={best_f1[0]:.2f} F1={best_f1[3]:.3f} P={best_f1[1]:.3f} R={best_f1[2]:.3f} (FP={best_f1[5]},FN={best_f1[6]})")

# 高精度档：要求 precision >= 0.95
hp = [r for r in rows if r[1]>=0.95]
if hp:
    b = max(hp, key=lambda r:r[2])
    print(f"高精度: th={b[0]:.2f} P={b[1]:.3f} R={b[2]:.3f} F1={b[3]:.3f} (FP={b[5]},FN={b[6]})")

# 平衡档：F1 最大且误报率<=10%
fp_ok = [r for r in rows if r[5] <= 0.10*36]
if fp_ok:
    b = max(fp_ok, key=lambda r:r[3])
    print(f"误报≤10%: th={b[0]:.2f} P={b[1]:.3f} R={b[2]:.3f} F1={b[3]:.3f} (FP={b[5]},FN={b[6]})")
