# -*- coding: utf-8 -*-
"""验证：温度校准对 AUC 和 F1 上限的影响。"""
import json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
import numpy as np

rows = json.load(open("preds_raw.json", encoding="utf-8"))
y = np.array([x["label"] for x in rows])
p = np.array([x["p"] for x in rows])

T = 2.7235312461853027
def logit(x): x=np.clip(x,1e-6,1-1e-6); return np.log(x/(1-x))
def sigmoid(z): return 1/(1+np.exp(-z))
p_cal = sigmoid(logit(p)/T)

def auc(pp, yy):
    pos=pp[yy==1]; neg=pp[yy==0]
    return float(np.mean([(1.0 if a>b else 0.5 if a==b else 0.0) for a in pos for b in neg]))

def sweep(pp, yy, name):
    best=None; rows_out=[]
    for th in np.arange(0.02,0.99,0.01):
        pred=(pp>=th).astype(int)
        tp=int(((pred==1)&(yy==1)).sum()); fp=int(((pred==1)&(yy==0)).sum())
        fn=int(((pred==0)&(yy==1)).sum()); tn=int(((pred==0)&(yy==0)).sum())
        prec=tp/(tp+fp) if tp+fp else 0; rec=tp/(tp+fn) if tp+fn else 0
        f1=2*prec*rec/(prec+rec) if prec+rec else 0
        if best is None or f1>best[0]: best=(f1,th,prec,rec,tp,fp,fn,tn)
    print(f"\n[{name}] AUC={auc(pp,yy):.4f}  最佳 F1={best[0]:.3f} @ th={best[1]:.2f}  P={best[2]:.3f} R={best[3]:.3f}")
    print(f"    TP={best[4]} FP={best[5]} FN={best[6]} TN={best[7]}")
    return best

b_raw = sweep(p, y, "原始")
b_cal = sweep(p_cal, y, "校准后 (T=2.72)")

print("\n" + "="*55)
print(f"AUC 变化: {auc(p,y):.4f} -> {auc(p_cal,y):.4f}  (差 {auc(p_cal,y)-auc(p,y):+.6f})")
print(f"最佳 F1 变化: {b_raw[0]:.3f} -> {b_cal[0]:.3f}  (差 {b_cal[0]-b_raw[0]:+.3f})")
print("="*55)

# 校准后 ECE
def ece(conf, correct, bins=10):
    idx = np.digitize(conf, np.linspace(0,1,bins+1)[:-1]) - 1
    idx = np.clip(idx, 0, bins-1)
    e = 0.0
    for b in range(bins):
        m = idx==b
        if m.sum()==0: continue
        e += m.sum()/len(conf) * abs(correct[m].mean() - conf[m].mean())
    return e

pred_raw = (p>=0.5).astype(int)
corr_raw = (pred_raw==y).astype(float)
conf_raw = np.maximum(p, 1-p)
pred_cal = (p_cal>=0.5).astype(int)
corr_cal = (pred_cal==y).astype(float)
conf_cal = np.maximum(p_cal, 1-p_cal)

print(f"\nECE 原始  = {ece(conf_raw, corr_raw):.4f}")
print(f"ECE 校准后 = {ece(conf_cal, corr_cal):.4f}")
print(f"平均置信度 原始={conf_raw.mean():.3f} -> 校准={conf_cal.mean():.3f}")
print(f"实际准确率 = {corr_raw.mean():.3f}")
