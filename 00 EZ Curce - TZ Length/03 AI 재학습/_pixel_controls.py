#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""픽셀 모델 성능을 해석하기 위한 무학습 대조군.

## 왜 필요한가
픽셀 모델이 2 에폭에 위치오차 0.53mm를 냈다. 이는 주석자 간 일치(0.674mm)보다
낮은 값이라 그대로 믿기 어렵다. 두 가지 중 하나다:

  (a) 모델이 정말 그만큼 정확하다 — 합의 평균을 타깃으로 배우면 개별 주석자보다
      합의에 가까워질 수 있다(정답-합의 거리는 0.239mm이므로 원리적으로 가능).
  (b) **과제가 원래 쉽다** — 구강 사진의 촬영 규약이 일정해서, 이미지를 전혀 보지
      않고 "훈련 세트의 평균 배치"만 찍어도 비슷한 점수가 나온다.

(b)를 배제하지 않으면 "픽셀 모델이 규칙엔진을 6배 이겼다"는 결론이 무의미하다.
그래서 이미지를 보지 않는 대조군 3종을 같은 fold·같은 지표로 잰다:

  1. globalMean   : 훈련 fold의 평균 키포인트 배치(패딩 좌표계) 그대로
  2. meanScaled   : 평균 배치를 각 사진의 유효 영역 크기에 맞춰 스케일
  3. oracleAffine : 평균 배치에 케이스별 **최적 유사변환**(회전·등방배율·평행이동)을
                    끼워맞춘 값 = 정답을 본 오라클. "배치만 맞추면 어디까지 되는가"의
                    상한이며, 실제 달성 가능한 값이 아니다.

3번이 낮게 나오면 남은 오차는 형태(치아별 폭·회전)에 있고, 높게 나오면 오차의
대부분이 아치 배치 정합이라는 뜻이다 — 후자는 registration_learn.json이 규칙엔진에
대해 이미 보여준 구조다.

출력에 PHI·좌표 없음.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
SCALE_MM = 54.0
MOLAR_IDX = [0, 1, 10, 11]


def truth_scale(truth: np.ndarray) -> np.ndarray:
    """(cases,24,2) -> 케이스별 mm/px. 정답 24점 최대 쌍거리 = 54mm."""
    out = np.zeros(len(truth))
    for k in range(len(truth)):
        span = max(float(np.linalg.norm(truth[k][i + 1:] - truth[k][i], axis=1).max())
                   for i in range(23))
        out[k] = SCALE_MM / span if span > 0 else 0.0
    return out


def metrics(pred: np.ndarray, truth: np.ndarray, scale: np.ndarray) -> dict:
    s = scale[:, None]
    pm = (pred[:, 0::2, :] + pred[:, 1::2, :]) / 2.0
    tm = (truth[:, 0::2, :] + truth[:, 1::2, :]) / 2.0
    position = np.linalg.norm(pm - tm, axis=2) * s
    endpoint = np.linalg.norm(pred - truth, axis=2) * scale[:, None]
    pl = np.linalg.norm(pred[:, 1::2, :] - pred[:, 0::2, :], axis=2)
    tl = np.linalg.norm(truth[:, 1::2, :] - truth[:, 0::2, :], axis=2)
    signed = (pl - tl) * s
    return {
        "position": round(float(position.mean()), 4),
        "molar": round(float(position[:, MOLAR_IDX].mean()), 4),
        "endpoint": round(float(endpoint.mean()), 4),
        "lengthAbs": round(float(np.abs(signed).mean()), 4),
        "tzl": round(float(np.abs(signed.sum(axis=1)).mean()), 4),
        "positionP95": round(float(np.quantile(position.mean(axis=1), 0.95)), 4),
    }


def best_similarity(source: np.ndarray, target: np.ndarray) -> np.ndarray:
    """source(24,2)를 target(24,2)에 맞추는 최적 유사변환 적용 결과.

    회전 + 등방 배율 + 평행이동만 허용한다(전단·비등방 배율 금지). 닫힌형 해는
    Umeyama 정렬. 반사는 허용하지 않는다 — 좌우가 뒤집힌 배치는 해부학적으로 무의미.
    """
    mu_s, mu_t = source.mean(axis=0), target.mean(axis=0)
    a, b = source - mu_s, target - mu_t
    u, sv, vt = np.linalg.svd(a.T @ b)
    d = np.sign(np.linalg.det(u @ vt))
    correction = np.diag([1.0, d])
    rotation = (u @ correction @ vt)
    variance = (a**2).sum()
    scale = float((sv[:-1].sum() + d * sv[-1]) / variance) if variance > 0 else 1.0
    return (a @ rotation) * scale + mu_t


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=HERE / "pixel_dataset")
    parser.add_argument("--out", type=Path, default=HERE / "pixel_controls.json")
    parser.add_argument("--input-size", type=int, default=512)
    args = parser.parse_args()

    coco = json.loads((args.dataset / "annotations_coco.json").read_text(encoding="utf-8"))
    ann = {a["image_id"]: a for a in coco["annotations"]}

    size = args.input_size
    rows = []
    for image in coco["images"]:
        kp = np.asarray(ann[image["id"]]["keypoints"], dtype=np.float64).reshape(24, 3)
        # train_pixel_landmarks와 동일한 전처리: 종횡비 유지 리사이즈 + 중앙 패딩
        w, h = image["width"], image["height"]
        s = size / max(w, h)
        pad = np.asarray(((size - round(w * s)) // 2, (size - round(h * s)) // 2))
        rows.append({
            "caseId": image["caseId"],
            "fold": image["fold"],
            "padded": kp[:, :2] * s + pad,
            "sourceScale": s * image["scaleFromSource"],
            "effective": np.asarray((round(w * s), round(h * s)), dtype=np.float64),
        })

    folds = sorted({r["fold"] for r in rows})
    results: dict[str, list[dict]] = {"globalMean": [], "meanScaled": [], "oracleAffine": []}
    per_fold: dict[str, list[dict]] = {k: [] for k in results}

    for fold in folds:
        train = [r for r in rows if r["fold"] != fold]
        valid = [r for r in rows if r["fold"] == fold]
        template = np.mean([r["padded"] for r in train], axis=0)
        template_area = np.mean([r["effective"] for r in train], axis=0)

        truth = np.stack([r["padded"] for r in valid])
        scale = truth_scale(truth) * 0.0
        # mm 환산은 **원본 좌표계** 기준이어야 한다. 패딩 좌표에서 재도 스팬 비율이
        # 같으므로 값은 동일하다(등방 리사이즈이기 때문). 그래서 패딩 좌표로 잰다.
        scale = truth_scale(truth)

        preds = {
            "globalMean": np.repeat(template[None, :, :], len(valid), axis=0),
            "meanScaled": np.stack([
                (template - size / 2.0) * float(np.mean(r["effective"] / template_area))
                + size / 2.0 for r in valid
            ]),
            "oracleAffine": np.stack([
                best_similarity(template, r["padded"]) for r in valid
            ]),
        }
        for name, pred in preds.items():
            block = metrics(pred, truth, scale)
            block["fold"] = fold
            block["cases"] = len(valid)
            per_fold[name].append(block)
            results[name].append(block)

    keys = ("position", "molar", "endpoint", "lengthAbs", "tzl", "positionP95")
    overall = {
        name: {k: round(float(np.mean([b[k] for b in blocks])), 4) for k in keys}
        for name, blocks in results.items()
    }

    report = {
        "schemaVersion": "pixel-controls-v1",
        "privacy": {"containsPhi": False, "containsPatientNames": False,
                    "containsFilePaths": False, "containsImageCoordinates": False},
        "note": ("이미지를 보지 않는 무학습 대조군. 픽셀 모델과 동일한 환자 단위 5-fold, "
                 "동일 mm 정의(정답 24점 최대 쌍거리=54mm), 동일 전처리 좌표계."),
        "cases": len(rows),
        "folds": len(folds),
        "controls": {
            "globalMean": "훈련 fold 평균 키포인트 배치. 학습·이미지 모두 없음.",
            "meanScaled": "평균 배치를 사진 유효 영역 크기로 등방 스케일.",
            "oracleAffine": ("평균 배치 + 케이스별 최적 유사변환. **정답을 본 오라클**이라 "
                             "달성 가능한 값이 아니다 — 형태(치아별 폭·회전)에 남는 오차의 하한."),
        },
        "overall": overall,
        "perFold": per_fold,
        "referencePoints": {
            "ruleEngineDraftPosition": 3.6874,
            "krrStage3OofPosition": 2.1723,
            "annotatorAgreementEndpoint": 0.674,
            "annotationToConsensusPosition": 0.2394,
            "source": "accuracy_ceiling.json / truth_agreement.json / label_noise_floor.json",
        },
    }
    report["interpretation"] = {
        "taskIsTriviallyEasy": bool(overall["globalMean"]["position"] < 1.5),
        "meanShapePositionMm": overall["globalMean"]["position"],
        "conclusion": (
            f"이미지를 보지 않는 평균 배치만으로 위치 {overall['globalMean']['position']}mm. "
            f"규칙엔진 3.687mm보다 "
            + ("낮다 — 규칙엔진이 평균 배치보다도 못하다는 뜻이므로, 픽셀 모델의 우위를 "
               "'딥러닝의 힘'으로 해석하면 안 된다. 촬영 규약이 일정해서 과제가 쉽다."
               if overall["globalMean"]["position"] < 3.6874 else
               "높다 — 규칙엔진은 최소한 평균 배치보다는 낫다.")
            + f" 정답 배치를 본 오라클 유사변환은 {overall['oracleAffine']['position']}mm로, "
              "배치만 완벽히 맞춰도 이만큼은 남는다(= 형태 성분)."
        ),
    }
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    header = f"{'대조군':14s} " + " ".join(f"{k:>12s}" for k in keys)
    print(header)
    print("-" * len(header))
    for name in ("globalMean", "meanScaled", "oracleAffine"):
        print(f"{name:14s} " + " ".join(f"{overall[name][k]:12.4f}" for k in keys))
    print()
    print("참조: 규칙엔진 3.6874 / KRR 3단 2.1723 / 주석자간 0.674 / 정답-합의 0.2394 (mm)")
    print("\n해석:", report["interpretation"]["conclusion"])
    print(f"-> {args.out}")


if __name__ == "__main__":
    main()
