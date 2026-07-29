#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""배포용 최종 픽셀 랜드마크 모델 — 전체 384건 학습.

## 왜 별도 스크립트인가
train_pixel_landmarks.py는 검증된 5-fold 평가기다. A/B 숫자(pixel_ab.json)가 그
코드에서 나왔으므로 손대지 않는다. 여기서는 같은 구성 요소를 import해서
"홀드아웃 없이 전부 학습"만 다르게 한다.

## 왜 앙상블이 아닌가
5개 fold 가중치를 앙상블하면 정확도가 조금 오르겠지만 fp16 ONNX 5개 = 245MB다.
브라우저에서 최초 1회 다운로드로는 과하다. 대신 전체 384건 단일 모델을 쓴다 —
각 fold 모델이 307건으로 배운 것보다 25% 많은 데이터를 본다.

## ⚠️ 이 모델의 성능은 측정할 수 없다
홀드아웃이 없으므로 이 가중치로 낸 어떤 숫자도 in-sample이다. 보고 가능한 수치는
5-fold OOF(위치 0.3113mm)뿐이며, 그것이 이 모델 성능의 **보수적 추정**이다
(데이터가 더 많으니 실제로는 같거나 조금 낫다). in-sample 지표는 참고용으로만
남기고 개선 근거로 인용하지 않는다.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader

from train_pixel_landmarks import (
    ArchKeypointDataset, ArchLandmarkNet, SCALE_MM, aggregate, build_cache, evaluate,
    focal_heatmap_loss, offset_loss,
)

HERE = Path(__file__).resolve().parent


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=HERE / "pixel_dataset")
    parser.add_argument("--out", type=Path, default=HERE / "pixel_model")
    parser.add_argument("--epochs", type=int, default=80)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--input-size", type=int, default=512)
    parser.add_argument("--stride", type=int, default=4)
    parser.add_argument("--sigma", type=float, default=2.0)
    parser.add_argument("--offset-weight", type=float, default=1.0)
    parser.add_argument("--workers", type=int, default=5)
    parser.add_argument("--seed", type=int, default=20260729)
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    random.seed(args.seed)
    torch.backends.cudnn.benchmark = True

    coco = json.loads((args.dataset / "annotations_coco.json").read_text(encoding="utf-8"))
    ann_by_image = {a["image_id"]: a for a in coco["annotations"]}
    records = [
        {
            "caseId": image["caseId"],
            "file_name": image["file_name"],
            "patientGroupId": image["patientGroupId"],
            "fold": image["fold"],
            "scaleFromSource": image["scaleFromSource"],
            "imageSha256": image["file_name"].rsplit("_", 1)[-1].removesuffix(".jpg"),
            "keypoints": ann_by_image[image["id"]]["keypoints"],
        }
        for image in coco["images"]
    ]
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    patients = len({r["patientGroupId"] for r in records})
    print(f"device={device} cases={len(records)} patients={patients} (홀드아웃 없음)",
          flush=True)

    cache = build_cache(args.dataset, records, args.input_size)
    train_set = ArchKeypointDataset(args.dataset, records, args.input_size, args.stride,
                                    args.sigma, augment=True, cache=cache)
    # in-sample 지표용. 증강 없이 같은 데이터를 다시 본다 — 성능 근거가 아니라
    # "학습이 수렴했는지"만 확인하는 용도다.
    probe_set = ArchKeypointDataset(args.dataset, records, args.input_size, args.stride,
                                    args.sigma, augment=False, cache=cache)
    loader_extra = ({"persistent_workers": True, "prefetch_factor": 4}
                    if args.workers > 0 else {})
    train_loader = DataLoader(train_set, batch_size=args.batch_size, shuffle=True,
                              num_workers=args.workers, pin_memory=True, drop_last=True,
                              **loader_extra)
    probe_loader = DataLoader(probe_set, batch_size=args.batch_size, shuffle=False,
                              num_workers=args.workers, pin_memory=True, **loader_extra)

    model = ArchLandmarkNet(pretrained=True).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    steps = max(1, len(train_loader)) * args.epochs
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer, max_lr=args.lr, total_steps=steps, pct_start=0.25)
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")

    for epoch in range(1, args.epochs + 1):
        model.train()
        started = time.time()
        losses = []
        for batch in train_loader:
            images = batch["image"].to(device, non_blocking=True)
            heat_t = batch["heatmap"].to(device, non_blocking=True)
            off_t = batch["offset"].to(device, non_blocking=True)
            off_m = batch["offsetMask"].to(device, non_blocking=True)
            weight = batch["weight"].to(device, non_blocking=True)
            optimizer.zero_grad(set_to_none=True)
            with torch.amp.autocast("cuda", enabled=device.type == "cuda"):
                heat_p, off_p = model(images)
                loss = (focal_heatmap_loss(heat_p, heat_t, weight)
                        + args.offset_weight * offset_loss(off_p, off_t, off_m))
            scaler.scale(loss).backward()
            scaler.unscale_(optimizer)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            scaler.step(optimizer)
            scaler.update()
            scheduler.step()
            losses.append(float(loss.detach()))
        if epoch % 20 == 0 or epoch == args.epochs:
            print(f"  ep{epoch:3d} loss={np.mean(losses):.5f} "
                  f"({time.time() - started:.0f}s)", flush=True)

    args.out.mkdir(parents=True, exist_ok=True)
    weights_path = args.out / "final.pt"
    torch.save(model.state_dict(), weights_path)

    rows, _ = evaluate(model, probe_loader, probe_set, records, device, args.stride)
    in_sample = aggregate(rows)

    oof = None
    metrics_path = args.out / "metrics.json"
    if metrics_path.exists():
        oof = json.loads(metrics_path.read_text(encoding="utf-8"))["overallOutOfFold"]

    report = {
        "schemaVersion": "pixel-final-model-v1",
        "privacy": {"containsPhi": False, "containsPatientNames": False,
                    "containsFilePaths": False, "containsImageCoordinates": False},
        "weights": weights_path.name,
        "trainedOn": {"cases": len(records), "patients": patients, "holdout": None},
        "config": {
            "epochs": args.epochs, "batchSize": args.batch_size, "lr": args.lr,
            "inputSize": args.input_size, "stride": args.stride, "sigma": args.sigma,
            "seed": args.seed, "backbone": "resnet34", "head": "heatmap+offset",
            "scaleMm": SCALE_MM,
        },
        "inSampleMetrics": in_sample,
        "reportableEstimate": oof,
        "note": ("inSampleMetrics는 학습에 쓴 데이터로 잰 값이라 **성능 근거가 아니다** — "
                 "수렴 확인용이다. 보고 가능한 수치는 reportableEstimate(5-fold OOF)이며, "
                 "이 모델은 각 fold 모델보다 25% 많은 데이터를 봤으므로 OOF는 보수적 추정이다."),
    }
    (args.out / "final_model.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"inSample": in_sample, "reportableOof": oof},
                     ensure_ascii=False, indent=2))
    print(f"-> {weights_path}")


if __name__ == "__main__":
    main()
