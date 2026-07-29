#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""픽셀 랜드마크 모델을 ONNX로 내보내고 수치 동등성을 검증한다.

## 왜 ONNX인가
현재 배포 경로는 "모델을 HTML에 임베드해 순수 JS로 추론"이다(residual-model.json
5.6MB). 픽셀 모델은 ResNet-34 = 21M 파라미터라 같은 방식이 불가능하다. 선택지는
둘인데 ONNX Runtime Web이 낫다:
  - ONNX Runtime Web: 브라우저에서 WASM/WebGL 추론. 사진이 서버로 나가지 않는다
    = 환자 사진 전송 없음(개인정보 측면에서 결정적).
  - 서버 추론 API: 정확·빠르지만 구강 사진을 업로드해야 한다.

## 검증
내보낸 뒤 반드시 PyTorch 출력과 비교한다. 히트맵 argmax가 한 칸 밀리면 좌표가
stride×배율만큼(원본 47px) 튀는데, 모델 정확도 0.5mm 수준에서는 치명적이다.
디코딩까지 그래프에 넣지 않고 히트맵/오프셋만 내보낸다 — 디코딩은 JS에서 하는 편이
검증 가능하고, argmax·soft-argmax는 프레임워크별 tie-break가 달라 위험하다.

⚠️ **검증 입력은 실제 사진이어야 한다.** 무작위 노이즈를 넣으면 히트맵이 평평해져
argmax가 사실상 동점 상태에서 임의로 튄다. 실측: 노이즈 입력에서 fp16의 좌표 차이가
387px(원본 4,554px)로 나와 fp16이 못 쓸 것처럼 보였지만, 같은 모델을 실제 사진으로
재면 0.005px(원본 0.059px ≈ 0.0008mm)였다. 즉 그 387px은 모델 열화가 아니라
"봉우리 없는 히트맵에서 argmax를 물은" 측정 인공물이다.

## fp16 양자화
파일이 fp32 97.9MB → fp16 49.0MB로 줄고 실제 사진에서의 좌표 차이는 무해하다.
브라우저 배포에는 fp16을 쓴다.

출력에 PHI·좌표 없음.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch

from train_pixel_landmarks import ArchLandmarkNet, NUM_KEYPOINTS, build_cache, decode

HERE = Path(__file__).resolve().parent
IMAGENET_MEAN = np.asarray((0.485, 0.456, 0.406), dtype=np.float32)
IMAGENET_STD = np.asarray((0.229, 0.224, 0.225), dtype=np.float32)


def real_inputs(dataset: Path, count: int, input_size: int) -> list[torch.Tensor]:
    """검증용 실제 사진 텐서. 학습과 동일한 전처리를 거친다."""
    coco = json.loads((dataset / "annotations_coco.json").read_text(encoding="utf-8"))
    records = [{"file_name": image["file_name"]} for image in coco["images"][:count]]
    cache = build_cache(dataset, records, input_size)
    out = []
    for record in records:
        array = cache[record["file_name"]]["canvas"].astype(np.float32) / 255.0
        array = (array - IMAGENET_MEAN) / IMAGENET_STD
        out.append(torch.from_numpy(array).permute(2, 0, 1)[None])
    return out


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", type=Path, default=HERE / "pixel_model" / "fold0.pt")
    parser.add_argument("--out", type=Path, default=HERE / "pixel_model" / "arch_landmarks.onnx")
    parser.add_argument("--dataset", type=Path, default=HERE / "pixel_dataset")
    parser.add_argument("--input-size", type=int, default=512)
    parser.add_argument("--stride", type=int, default=4)
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--samples", type=int, default=8, help="동등성 검증용 실제 사진 수")
    parser.add_argument("--no-fp16", action="store_true", help="fp16 사본을 만들지 않는다")
    args = parser.parse_args()

    model = ArchLandmarkNet(pretrained=False)
    model.load_state_dict(torch.load(args.weights, map_location="cpu"))
    model.eval()

    dummy = torch.zeros(1, 3, args.input_size, args.input_size)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model, dummy, str(args.out),
        input_names=["image"], output_names=["heatmap", "offset"],
        dynamic_axes={"image": {0: "batch"}, "heatmap": {0: "batch"}, "offset": {0: "batch"}},
        opset_version=args.opset, do_constant_folding=True,
    )

    fp16_path = args.out.with_name(args.out.stem + "_fp16.onnx")
    if not args.no_fp16:
        try:
            import onnx
            from onnxconverter_common import float16 as float16_converter
        except ImportError:
            fp16_path = None
            print("onnx/onnxconverter-common 없음 — fp16 사본 생략", flush=True)
        else:
            # keep_io_types: 입출력은 fp32로 유지해 JS 쪽 배열 타입 변환을 없앤다
            converted = float16_converter.convert_float_to_float16(
                onnx.load(str(args.out)), keep_io_types=True)
            onnx.save(converted, str(fp16_path))

    try:
        import onnxruntime as ort
    except ImportError:
        print("onnxruntime 없음 — 내보내기만 하고 동등성 검증은 생략", flush=True)
        report = {"exported": True, "verified": False, "reason": "onnxruntime_missing"}
    else:
        inputs = real_inputs(args.dataset, args.samples, args.input_size)
        session = ort.InferenceSession(str(args.out), providers=["CPUExecutionProvider"])
        session16 = (ort.InferenceSession(str(fp16_path), providers=["CPUExecutionProvider"])
                     if fp16_path else None)
        heat_diff, off_diff, coord_diff, fp16_coord_diff, fp16_heat_diff = [], [], [], [], []
        for x in inputs:
            with torch.no_grad():
                heat_t, off_t = model(x)
                pt_pts, _ = decode(heat_t, off_t, args.stride)
            heat_o, off_o = session.run(None, {"image": x.numpy()})
            heat_diff.append(float(np.abs(heat_t.numpy() - heat_o).max()))
            off_diff.append(float(np.abs(off_t.numpy() - off_o).max()))
            ox_pts, _ = decode(torch.from_numpy(heat_o), torch.from_numpy(off_o), args.stride)
            coord_diff.append(float((pt_pts - ox_pts).abs().max()))
            if session16 is not None:
                heat_h, off_h = session16.run(None, {"image": x.numpy()})
                fp16_heat_diff.append(float(np.abs(heat_o - heat_h).max()))
                h_pts, _ = decode(torch.from_numpy(heat_h), torch.from_numpy(off_h), args.stride)
                fp16_coord_diff.append(float((ox_pts - h_pts).abs().max()))
        report = {
            "exported": True,
            "verified": True,
            "samples": len(inputs),
            "verificationInputs": "실제 데이터셋 사진 (노이즈 금지 — 위 문서 주의사항 참조)",
            "maxAbsDiff": {
                "heatmapLogits": round(max(heat_diff), 8),
                "offset": round(max(off_diff), 8),
                "decodedCoordPx": round(max(coord_diff), 8),
            },
            # 입력 512 좌표 1px = 원본 6016 기준 약 11.75px = 약 0.15mm.
            # 0.01px 이하면 무해하다.
            "coordTolerancePx": 0.01,
            "coordWithinTolerance": bool(max(coord_diff) <= 0.01),
        }
        if fp16_coord_diff:
            report["fp16"] = {
                "path": fp16_path.name,
                "fileSizeBytes": fp16_path.stat().st_size,
                "maxHeatmapLogitDiffVsFp32": round(max(fp16_heat_diff), 8),
                "maxDecodedCoordDiffPx": round(max(fp16_coord_diff), 8),
                "sourcePxEquivalent": round(max(fp16_coord_diff) * 6016 / args.input_size, 4),
                "withinTolerance": bool(max(fp16_coord_diff) <= 0.05),
                "note": "입력 512px 기준 좌표 차이. 원본 6016px 환산값도 함께 본다.",
            }

    report.update({
        "schemaVersion": "onnx-export-v1",
        "privacy": {"containsPhi": False, "containsImageCoordinates": False},
        "graph": {
            "inputs": {"image": [1, 3, args.input_size, args.input_size],
                       "normalization": "ImageNet mean/std, RGB, 종횡비 유지 + 검은 패딩"},
            "outputs": {
                "heatmap": [1, NUM_KEYPOINTS, args.input_size // args.stride,
                            args.input_size // args.stride],
                "offset": [1, NUM_KEYPOINTS * 2, args.input_size // args.stride,
                           args.input_size // args.stride],
            },
            "decodingNotInGraph": ("argmax -> 3x3 soft-argmax -> 오프셋 보정 -> x stride. "
                                   "프레임워크별 tie-break 차이를 피하려고 JS에서 처리한다."),
            "opset": args.opset,
        },
        "fileSizeBytes": args.out.stat().st_size,
    })
    (args.out.parent / "onnx_export.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
