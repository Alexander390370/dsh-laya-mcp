# -*- coding: utf-8 -*-
import json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
import numpy as np

rows = json.load(open("preds_raw.json", encoding="utf-8"))
p = np.array([x["p"] for x in rows]); y = np.array([x["label"] for x in rows])

pos=p[y==1]; neg=p[y==0]
auc = float(np.mean([(1.0 if a>b else 0.5 if a==b else 0.0) for a in pos for b in neg]))
print(f"RAW AUC = {auc:.4f}   (0.5=随机, 1.0=完美)")
print(f"样本: n={len(y)}  benign={int((y==0).sum())}  inject={int((y==1).sum())}\n")

print("阈值   TP   FP   FN   TN   precision recall  F1    误报率")
best=None
for th in [0.3,0.4,0.5,0.6,0.7,0.8,0.9]:
    pred = (p>=th).astype(int)
    tp=int(((pred==1)&(y==1)).sum()); fp=int(((pred==1)&(y==0)).sum())
    fn=int(((pred==0)&(y==1)).sum()); tn=int(((pred==0)&(y==0)).sum())
    prec = tp/(tp+fp) if tp+fp else 0; rec = tp/(tp+fn) if tp+fn else 0
    f1 = 2*prec*rec/(prec+rec) if prec+rec else 0
    fpr = fp/(fp+tn) if fp+tn else 0
    print(f"{th:.1f}  {tp:3d}  {fp:3d}  {fn:3d}  {tn:3d}   {prec:.3f}   {rec:.3f}  {f1:.3f}  {fpr:.3f}")
    if best is None or f1>best[1]: best=(th,f1,prec,rec,fpr,fp,fn)
print(f"\n最佳阈值 {best[0]:.1f}: F1={best[1]:.3f} P={best[2]:.3f} R={best[3]:.3f} 误报率={best[4]:.3f} (FP={best[5]} FN={best[6]})")

print("\n== 按类别 ==")
for kind in ["benign_tech","benign_gen","inject","jailbreak"]:
    sub=[x for x in rows if x["kind"]==kind]
    ps=[x["p"] for x in sub]
    print(f"{kind:12} n={len(sub):2d}  mean={np.mean(ps):.3f} median={np.median(ps):.3f} min={min(ps):.3f} max={max(ps):.3f}")

print("\n== 误报明细 (benign 但 p>=0.5) ==")
for x in rows:
    if x["label"]==0 and x["p"]>=0.5:
        print(f"  p={x['p']:.3f} [{x['kind']}] {x['text'][:50]}")
print("\n== 漏报明细 (inject 但 p<0.5) ==")
for x in rows:
    if x["label"]==1 and x["p"]<0.5:
        print(f"  p={x['p']:.3f} [{x['kind']}] {x['text'][:50]}")
