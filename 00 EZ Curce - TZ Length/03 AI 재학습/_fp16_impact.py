#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fp16 ONNX가 실제 mm 지표를 얼마나 흔드는지 실측 + JS 디코딩 동등성 덤프.

## 왜 필요한가
_export_onnx.py는 final.pt fp16에서 "좌표 최대 차 0.967px(원본 11.4px)"을 냈고
자기 임계(0.05px)를 통과하지 못했다. 그런데 그 값은 8장 × 24점의 **최대**이고
단위가 입력 512px이다. 배포 판단에 필요한 것은 **mm 단위 분포**다 —
모델 자체의 OOF 오차가 0.311mm인데 fp16이 0.01mm를 흔든다면 무해하고,
0.3mm를 흔든다면 fp32를 써야 한다.

여기서는 60장 실사진에 대해 fp32 ONNX와 fp16 ONNX의 디코딩 좌표 차이를
정답 스케일(24점 최대 쌍거리=54mm)로 환산해 평균·p95·최대를 낸다.
동시에 JS 디코더 검증용으로 히트맵/오프셋 원시 텐서와 파이썬 디코딩 결과를
덤프한다(3장).

출력에 PHI·좌표 없음(덤프 파일은 검증 후 삭제 대상, 좌표 포함 → 임시).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

from train_pixel_landmarks import build_cache, decode, truth_scale_mm_per_px

HERE = Path(__file__).resolve().parent
DATASET = HERE / "pixel_dataset"
MODEL_DIR = HERE / "pixel_model"
INPUT_SIZE = 512
STRIDE = 4
COUNT = 60
DUMP = 3
MEAN = np.asarray((0.485, 0.456, 0.406), dtype=np.float32)
STD = np.asarray((0.229, 0.224, 0.225), dtype=np.float32)


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    coco = json.loads((DATASET / "annotations_coco.json").read_text(encoding="utf-8"))
    ann = {a["image_id"]: a for a in coco["annotations"]}
    images = coco["images"][:COUNT]
    records = [{"file_name": im["file_name"]} for im in images]
    cache = build_cache(DATASET, records, INPUT_SIZE)

    s32 = ort.InferenceSession(str(MODEL_DIR / "arch_landmarks_final.onnx"),
                               providers=["CPUExecutionProvider"])
    s16 = ort.InferenceSession(str(MODEL_DIR / "arch_landmarks_final_fp16.onnx"),
                               providers=["CPUExecutionProvider"])

    per_point_mm, per_case_mean_mm, per_case_max_mm = [], [], []
    dump_dir = HERE / "_jsdecode_dump"
    dump_dir.mkdir(exist_ok=True)
    dumped = []

    for k, im in enumerate(images):
        array = cache[im["file_name"]]["canvas"].astype(np.float32) / 255.0
        x = ((array - MEAN) / STD).transpose(2, 0, 1)[None].astype(np.float32)
        h32, o32 = s32.run(None, {"image": x})
        h16, o16 = s16.run(None, {"image": x})
        p32, _ = decode(torch.from_numpy(h32), torch.from_numpy(o32), STRIDE)
        p16, _ = decode(torch.from_numpy(h16), torch.from_numpy(o16), STRIDE)
        p32 = p32[0].numpy()
        p16 = p16[0].numpy()

        # 입력512 좌표 -> 원본 좌표 -> mm. 정답 스케일로 환산한다.
        scale_in = INPUT_SIZE / max(im["width"], im["height"])       # 파생본 -> 512
        truth = (np.asarray(ann[im["id"]]["keypointsUnclipped"], dtype=np.float64)
                 .reshape(24, 2) / im["scaleFromSource"])
        mm_per_src_px = truth_scale_mm_per_px(truth)
        # 512 1px = 파생본 1/scale_in px = 원본 1/(scale_in*scaleFromSource) px
        px512_to_src = 1.0 / (scale_in * im["scaleFromSource"])
        d = np.linalg.norm(p32 - p16, axis=1) * px512_to_src * mm_per_src_px
        per_point_mm.extend(d.tolist())
        per_case_mean_mm.append(float(d.mean()))
        per_case_max_mm.append(float(d.max()))

        if k < DUMP:
            (dump_dir / f"case{k}_heatmap.f32").write_bytes(h32.astype(np.float32).tobytes())
            (dump_dir / f"case{k}_offset.f32").write_bytes(o32.astype(np.float32).tobytes())
            dumped.append({
                "index": k,
                "heatmapDims": list(h32.shape),
                "offsetDims": list(o32.shape),
                "stride": STRIDE,
                "pythonPoints": p32.tolist(),
            })

    (dump_dir / "expected.json").write_text(
        json.dumps({"cases": dumped}, ensure_ascii=False), encoding="utf-8")

    pp = np.asarray(per_point_mm)
    report = {
        "schemaVersion": "fp16-impact-v1",
        "privacy": {"containsPhi": False, "containsImageCoordinates": False},
        "purpose": ("fp16 ONNX의 좌표 열화를 **mm 단위**로 환산. _export_onnx.py의 "
                    "0.967px는 입력512 좌표계의 8장 최대값이라 배포 판단에 쓸 수 없다."),
        "cases": len(per_case_mean_mm),
        "pointsMeasured": int(pp.size),
        "perPointMm": {
            "mean": round(float(pp.mean()), 5),
            "p95": round(float(np.quantile(pp, 0.95)), 5),
            "p99": round(float(np.quantile(pp, 0.99)), 5),
            "max": round(float(pp.max()), 5),
        },
        "perCaseMm": {
            "meanOfMeans": round(float(np.mean(per_case_mean_mm)), 5),
            "worstCaseMax": round(float(np.max(per_case_max_mm)), 5),
        },
        "modelOofPositionMm": 0.3113,
        "verdict": None,
    }
    ratio = report["perPointMm"]["mean"] / report["modelOofPositionMm"]
    report["fp16NoiseVsModelErrorPct"] = round(float(ratio * 100), 3)
    report["verdict"] = {
        "fp16UsableForDeployment": bool(ratio < 0.05),
        "reason": (f"fp16 좌표 잡음 평균 {report['perPointMm']['mean']}mm = 모델 OOF 오차 "
                   f"0.3113mm의 {report['fp16NoiseVsModelErrorPct']}%. "
                   "5% 미만이면 배포에 무해하다고 본다."),
    }
    (MODEL_DIR / "fp16_impact.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
