#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""픽셀 모델 A/B 결과의 타당성 검증 3종.

## 왜 필요한가
픽셀 모델이 규칙엔진 대비 위치 +91.8%, KRR 대비 +85.7%로 나왔다(pixel_ab.json).
개선폭이 이 정도면 "이겼다"보다 "잰 방식이 틀렸다"를 먼저 의심해야 한다. 특히
0.311mm는 라벨 노이즈 하한(정답-합의 0.239mm)에 거의 붙은 값이다. 다음 3개를 잰다:

  1. **정답 동일성** — A/B 두 축(픽셀 파이프라인, KRR 파이프라인)이 같은 케이스에서
     같은 정답을 쓰는가. 픽셀 쪽은 `_export_keypoints.full12_widths`(주석 평균,
     아치 방향 재정렬), KRR 쪽은 `train_residual.truth_consensus`다. 코드가 다르므로
     정답 자체가 다를 수 있고, 그러면 "누가 더 정확한가"가 성립하지 않는다.
     같은 정답의 mm 오차로 잰다.

  2. **원본 도메인 이동** — 학습·평가는 1280px 파생본이었지만 배포는 원본 사진
     (최대 6016px)을 먹는다. 파생본은 LANCZOS로 줄여 노이즈·JPEG 블록이 눌린 상태다.
     원본을 그대로 넣으면 성능이 유지되는지 실측한다. 유지되지 않으면 배포에서
     조용히 나빠진다.
     ⚠️ 이 검사는 **각 케이스를 자기 fold의 모델로만** 추론해야 한다(OOF 유지).

  3. **정답 이미지 각인** — 모델이 사진에 그려진 선을 읽는 것이 아님을 확인한다.
     정답 좌표 근방(반경 r)을 회색으로 덮고 성능이 붕괴하는지 본다. 붕괴하면
     "정답이 픽셀에 새겨져 있다"는 뜻이고, 붕괴하지 않고 완만히 나빠지면
     치아 형태를 보고 있다는 뜻이다.

출력에 PHI·좌표 없음.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Mapping
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw

import train_residual as tr
from train_pixel_landmarks import (
    ArchLandmarkNet, NUM_KEYPOINTS, arch_metrics_mm, decode, truth_scale_mm_per_px,
)

HERE = Path(__file__).resolve().parent
IMAGENET_MEAN = np.asarray((0.485, 0.456, 0.406), dtype=np.float32)
IMAGENET_STD = np.asarray((0.229, 0.224, 0.225), dtype=np.float32)
METRIC_KEYS = ("position", "molar", "endpoint", "lengthAbs", "molarLengthAbs", "tzl")


def load_pixel_truth(dataset: Path) -> dict[str, dict]:
    """caseId -> 픽셀 파이프라인의 정답(원본 좌표계) + 이미지 메타."""
    coco = json.loads((dataset / "annotations_coco.json").read_text(encoding="utf-8"))
    ann = {a["image_id"]: a for a in coco["annotations"]}
    out = {}
    for image in coco["images"]:
        keypoints = np.asarray(ann[image["id"]]["keypoints"], dtype=np.float64).reshape(24, 3)
        # 클립 전 좌표를 쓴다: 프레임 밖 정답 5점의 mm 환산이 틀어지지 않게
        unclipped = np.asarray(ann[image["id"]]["keypointsUnclipped"],
                               dtype=np.float64).reshape(24, 2)
        scale = image["scaleFromSource"]
        out[image["caseId"]] = {
            "fold": image["fold"],
            "fileName": image["file_name"],
            "visibility": keypoints[:, 2],
            "truthSrc": unclipped / scale,          # 원본 사진 좌표계
            "truthDerived": keypoints[:, :2],       # 1280px 파생본 좌표계
            "derivedSize": (image["width"], image["height"]),
            "sourceSize": (image["sourceWidth"], image["sourceHeight"]),
            "scaleFromSource": scale,
            "imageSha256": image["file_name"].rsplit("_", 1)[-1].removesuffix(".jpg"),
        }
    return out


def load_krr_truth(index_path: Path) -> dict[str, np.ndarray]:
    """caseId -> KRR 파이프라인의 정답(원본 픽셀 좌표계).

    train_residual은 정규화 좌표를 쓴다. 종횡비만큼 길이가 왜곡되므로 원본 픽셀로
    되돌린다(project_segment_position_bottleneck).
    """
    index = tr.read_json(index_path)
    out = {}
    from collections import Counter
    quality: Counter[str] = Counter()
    for case in tr.dataset_cases(index):
        dims = tr.dimensions(case)
        if dims is None:
            continue
        truth = tr.truth_consensus(case, "width", dims, index_path.parent, quality)
        if truth is None or truth.shape != (24, 2):
            continue
        width, height = float(dims[0]), float(dims[1])
        out[str(tr.get_case_id(case))] = truth * np.asarray((width, height))
    return out


def preprocess(picture: Image.Image, input_size: int) -> tuple[torch.Tensor, dict]:
    """학습과 동일: 종횡비 유지 리사이즈 + 중앙 검은 패딩 + ImageNet 정규화."""
    width, height = picture.size
    scale = input_size / max(width, height)
    new_w, new_h = round(width * scale), round(height * scale)
    resized = picture.resize((new_w, new_h), Image.BILINEAR)
    canvas = Image.new("RGB", (input_size, input_size), (0, 0, 0))
    pad_x, pad_y = (input_size - new_w) // 2, (input_size - new_h) // 2
    canvas.paste(resized, (pad_x, pad_y))
    array = np.asarray(canvas, dtype=np.float32) / 255.0
    array = (array - IMAGENET_MEAN) / IMAGENET_STD
    tensor = torch.from_numpy(array).permute(2, 0, 1)[None]
    return tensor, {"scale": scale, "padX": float(pad_x), "padY": float(pad_y)}


def to_image_px(points: np.ndarray, meta: dict) -> np.ndarray:
    """입력 512 좌표 -> 넣어준 이미지의 좌표계."""
    return (points - np.asarray((meta["padX"], meta["padY"]))) / meta["scale"]


def occlude(picture: Image.Image, points: np.ndarray, radius: float) -> Image.Image:
    """정답점 근방을 회색 원으로 덮는다. points는 이 이미지의 좌표계."""
    out = picture.copy()
    draw = ImageDraw.Draw(out)
    for x, y in points:
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(128, 128, 128))
    return out


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=HERE / "pixel_dataset")
    parser.add_argument("--weights-dir", type=Path, default=HERE / "pixel_model")
    parser.add_argument("--index", type=Path, default=HERE / "dataset-index.patientgrouped.json")
    parser.add_argument("--out", type=Path, default=HERE / "pixel_sanity.json")
    parser.add_argument("--input-size", type=int, default=512)
    parser.add_argument("--stride", type=int, default=4)
    parser.add_argument("--source-cases", type=int, default=120,
                        help="원본 도메인 검사에 쓸 케이스 수(0=전체)")
    parser.add_argument("--occlude-cases", type=int, default=60)
    parser.add_argument("--occlude-radius-frac", type=float, default=0.012,
                        help="가림 반경 / 긴 변. 0.012 x 1280 = 15px (치아폭의 약 20%)")
    args = parser.parse_args()

    pixel_truth = load_pixel_truth(args.dataset)
    print(f"픽셀 정답 {len(pixel_truth)}건", flush=True)

    # ---- 1. 두 파이프라인의 정답 동일성 ----
    krr_truth = load_krr_truth(args.index)
    print(f"KRR 정답 {len(krr_truth)}건", flush=True)
    shared = sorted(set(pixel_truth) & set(krr_truth))
    gaps = []
    for case_id in shared:
        a = pixel_truth[case_id]["truthSrc"]
        b = krr_truth[case_id]
        mm = truth_scale_mm_per_px(a)
        gaps.append(float(np.linalg.norm(a - b, axis=1).mean() * mm))
    gaps_arr = np.asarray(gaps)
    truth_block = {
        "sharedCases": len(shared),
        "meanEndpointGapMm": round(float(gaps_arr.mean()), 4),
        "medianMm": round(float(np.median(gaps_arr)), 4),
        "p95Mm": round(float(np.quantile(gaps_arr, 0.95)), 4),
        "maxMm": round(float(gaps_arr.max()), 4),
        "casesAbove0_5mm": int((gaps_arr > 0.5).sum()),
        "identicalWithin0_01mm": int((gaps_arr <= 0.01).sum()),
    }
    print(f"[1] 정답 동일성: 평균 {truth_block['meanEndpointGapMm']}mm, "
          f"중위 {truth_block['medianMm']}mm, 최대 {truth_block['maxMm']}mm", flush=True)

    # ---- 모델 로드 (fold별) ----
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    models = {}
    for fold in sorted({v["fold"] for v in pixel_truth.values()}):
        path = args.weights_dir / f"fold{fold}.pt"
        if not path.exists():
            continue
        model = ArchLandmarkNet(pretrained=False)
        model.load_state_dict(torch.load(path, map_location="cpu"))
        models[fold] = model.eval().to(device)
    print(f"모델 {len(models)} fold 로드 (device={device.type})", flush=True)

    # ---- 2. 원본 해상도 도메인 이동 ----
    # 원본 사진은 md 파일에 base64로 박혀 있다. 추출은 비싸므로 필요한 만큼만.
    from _export_keypoints import extract_images
    print("원본 JPEG 추출 중...", flush=True)
    embedded = extract_images()
    print(f"  원본 {len(embedded)}개", flush=True)

    order = sorted(pixel_truth)
    if args.source_cases:
        order = order[: args.source_cases]

    rows_derived, rows_source, missing = [], [], 0
    for case_id in order:
        info = pixel_truth[case_id]
        fold = info["fold"]
        if fold not in models:
            continue
        model = models[fold]
        truth_src = info["truthSrc"]

        # (a) 파생본 1280px
        derived = Image.open(args.dataset / "images" / info["fileName"]).convert("RGB")
        tensor, meta = preprocess(derived, args.input_size)
        with torch.no_grad():
            heat, off = model(tensor.to(device))
            points, _ = decode(heat.cpu(), off.cpu(), args.stride)
        pred_derived = to_image_px(points[0].numpy(), meta) / info["scaleFromSource"]
        rows_derived.append(arch_metrics_mm(pred_derived, truth_src))

        # (b) 원본 해상도
        blob = None
        for sha, item in embedded.items():
            if sha.startswith(info["imageSha256"]):
                blob = item
                break
        if blob is None:
            # 짝을 유지해야 두 조건의 평균이 같은 케이스 집합에서 나온다
            rows_derived.pop()
            missing += 1
            continue
        import io
        source = Image.open(io.BytesIO(blob["bytes"])).convert("RGB")
        tensor, meta = preprocess(source, args.input_size)
        with torch.no_grad():
            heat, off = model(tensor.to(device))
            points, _ = decode(heat.cpu(), off.cpu(), args.stride)
        pred_source = to_image_px(points[0].numpy(), meta)
        rows_source.append(arch_metrics_mm(pred_source, truth_src))

    def mean_block(rows: list[dict]) -> dict:
        return {k: round(float(np.mean([r[k] for r in rows])), 4) for k in METRIC_KEYS}

    domain_block = {
        "casesEvaluated": len(rows_source),
        "sourceImagesMissing": missing,
        "derived1280": mean_block(rows_derived),
        "sourceFullRes": mean_block(rows_source),
        "note": ("같은 fold 모델로만 추론(OOF 유지). derived는 학습에 쓴 1280px 파생본, "
                 "source는 최대 6016px 원본. 배포는 source 조건이다."),
    }
    delta = ((domain_block["sourceFullRes"]["position"]
              - domain_block["derived1280"]["position"])
             / max(domain_block["derived1280"]["position"], 1e-9) * 100.0)
    domain_block["positionDegradationPct"] = round(float(delta), 2)
    print(f"[2] 도메인 이동: 파생 {domain_block['derived1280']['position']}mm -> "
          f"원본 {domain_block['sourceFullRes']['position']}mm "
          f"({domain_block['positionDegradationPct']:+.1f}%)", flush=True)

    # ---- 3. 정답 각인 검사 (정답 근방 가림) ----
    occ_order = order[: args.occlude_cases] if args.occlude_cases else order
    rows_clean, rows_occluded = [], []
    for case_id in occ_order:
        info = pixel_truth[case_id]
        fold = info["fold"]
        if fold not in models:
            continue
        model = models[fold]
        derived = Image.open(args.dataset / "images" / info["fileName"]).convert("RGB")
        radius = args.occlude_radius_frac * max(derived.size)
        blocked = occlude(derived, info["truthDerived"], radius)
        for picture, sink in ((derived, rows_clean), (blocked, rows_occluded)):
            tensor, meta = preprocess(picture, args.input_size)
            with torch.no_grad():
                heat, off = model(tensor.to(device))
                points, _ = decode(heat.cpu(), off.cpu(), args.stride)
            pred = to_image_px(points[0].numpy(), meta) / info["scaleFromSource"]
            sink.append(arch_metrics_mm(pred, info["truthSrc"]))

    occlusion_block = {
        "casesEvaluated": len(rows_occluded),
        "radiusPxAt1280": round(args.occlude_radius_frac * 1280, 1),
        "clean": mean_block(rows_clean),
        "occluded": mean_block(rows_occluded),
        "note": ("정답점 근방을 회색으로 덮었다. 성능이 붕괴하면 정답이 픽셀에 새겨져 "
                 "있다는 뜻이고, 완만히 나빠지면 주변 치아 형태를 보고 있다는 뜻이다. "
                 "⚠️ 가림 자체가 치아 경계를 지우므로 어느 정도의 악화는 정상이다."),
    }
    occlusion_block["positionDegradationPct"] = round(float(
        (occlusion_block["occluded"]["position"] - occlusion_block["clean"]["position"])
        / max(occlusion_block["clean"]["position"], 1e-9) * 100.0), 2)
    print(f"[3] 정답 각인: 원본 {occlusion_block['clean']['position']}mm -> "
          f"가림 {occlusion_block['occluded']['position']}mm "
          f"({occlusion_block['positionDegradationPct']:+.1f}%)", flush=True)

    report = {
        "schemaVersion": "pixel-sanity-v1",
        "privacy": {"containsPhi": False, "containsPatientNames": False,
                    "containsFilePaths": False, "containsImageCoordinates": False},
        "purpose": ("픽셀 모델의 큰 개선폭(규칙 대비 +91.8%)이 측정 오류가 아님을 "
                    "확인하는 3종 검사."),
        "truthAgreementBetweenPipelines": truth_block,
        "sourceResolutionDomainShift": domain_block,
        "truthImprintCheck": occlusion_block,
        "verdict": {
            "truthPipelinesAgree": bool(truth_block["medianMm"] <= 0.05),
            "survivesFullResolution": bool(domain_block["positionDegradationPct"] <= 25.0),
            "notReadingDrawnLabels": bool(occlusion_block["positionDegradationPct"] < 200.0),
        },
    }
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8")
    print("\nverdict:", json.dumps(report["verdict"], ensure_ascii=False, indent=2))
    print(f"-> {args.out}")


if __name__ == "__main__":
    main()
