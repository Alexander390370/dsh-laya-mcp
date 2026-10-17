# -*- coding: utf-8 -*-
"""温度校准实验：验证单调变换能否改善判别。"""
import json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
import numpy as np
from laya import Router, calibrate, ece_score

rows = json.load(open("preds_raw.json", encoding="utf-8"))
y = np.array([x["label"] for x in rows])
p = np.array([x["p"] for x in rows])
conf = np.array([x["conf"] for x in rows])

print("== 校准前 ==")
print(f"ECE = {ece_score(conf, (p>=0.5).astype(float)):.4f}")
print(f"mean_conf = {conf.mean():.3f}  actual_acc = {(p>=0.5).astype(int).__eq__(y).mean():.3f}")

# 构造 laya 校准所需的 records 格式
records = [{"qtype": 3, "k": 1, "conf": float(c), "correct": int((pp>=0.5)==(yy==1))}
           for c, pp, yy in zip(conf, p, y)]
# 打印一个样本看格式
print("\nrecord sample:", records[0])

# 拟合单温度
pairs = [(float(c), 1.0 if (pp>=0.5)==(yy==1) else 0.0) for c, pp, yy in zip(conf, p, y)]
try:
    T = calibrate.fit_one_temperature(pairs, min_n=10)
    print(f"\n拟合温度 T = {T:.4f}")
except Exception as e:
    print(f"fit_one_temperature 失败: {e}")
    T = None

if T:
    # 应用温度：sigmoid(logit(p)/T)
    def logit(x): 
        x=np.clip(x,1e-6,1-1e-6); return np.log(x/(1-x))
    def sigmoid(z): return 1/(1+np.exp(-z))
    p_cal = sigmoid(logit(p)/T)
    print(f"校准后 mean_conf = {p_cal.mean():.3f}")
    print(f"校准后 ECE(以0.5为界) = {ece_score(p_cal, (p>=0.5).astype(float)):.4f}")
    # AUC 不变性验证
    def auc(pp, yy):
        pos=pp[yy==1]; neg=pp[yy==0]
        return float(np.mean([(1.0 if a>b else 0.5 if a==b else 0.0) for a in pos for b in neg]))
    print(f"\nAUC 原始 = {auc(p,y):.4f}")
    print(f"AUC 校准后 = {auc(p_cal,y):.4f}   <- 必须完全相同（单调变换）")
    
    # 校准后最佳阈值搜索
    print("\n校准后阈值扫描:")
    print("阈值   TP  FP  FN  TN   P      R     F1")
    best=None
    for th in np.arange(0.05,0.96,0.05):
        pred=(p_cal>=th).astype(int)
        tp=int(((pred==1)&(y==1)).sum()); fp=int(((pred==1)&(y==0)).sum())
        fn=int(((pred==0)&(y==1)).sum()); tn=int(((pred==0)&(y==0)).sum())
        prec=tp/(tp+fp) if tp+fp else 0; rec=tp/(tp+fn) if tp+fn else 0
        f1=2*prec*rec/(prec+rec) if prec+rec else 0
        if best is None or f1>best[1]: best=(th,f1,prec,rec)
        if f1>0.7: print(f"{th:.2f}  {tp:3d} {fp:3d} {fn:3d} {tn:3d}  {prec:.3f}  {rec:.3f}  {f1:.3f}")
    print(f"\n校准后最佳: th={best[0]:.2f} F1={best[1]:.3f} P={best[2]:.3f} R={best[3]:.3f}")
    print("原始最佳:  th=0.90 F1=0.756 P=1.000 R=0.607")
    print("\n>>> 若 F1 上限相同，说明温度校准只挪阈值位置，不改善判别能力。")
