#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""하악 교합면 사진에서 치아폭 24 키포인트를 직접 검출하는 픽셀 모델.

## 왜 픽셀 모델인가
기존 KRR 잔차모델은 규칙엔진 좌표 169차원만 입력으로 받고 이미지를 보지 않는다.
그래서 규칙엔진이 아치 경로를 잘못 잡으면 회수할 방법이 원리적으로 없다:
아치 정합 오라클은 위치 오차를 45% 줄일 수 있는데(2.26 -> 1.25mm) 기존 특징으로는
회수율이 0%였다(4 DOF 전부 R^2 음수, registration_learn.json). 픽셀을 봐야 한다.

## 구조 — 단일 스테이지 히트맵
치아별 크롭 + 2단계 파이프라인을 쓰지 않는다. 인접 치아의 끝점이 정확히 공유되는
비율이 5.5%뿐이고 평균 간격이 55px(약 0.7mm)라, 이 라벨은 독립된 치아폭이 아니라
거의 연속된 체인이다. 크롭하면 "끝점이 인접 치아 경계 어디인가"라는 문맥을 잃는다.
아치 전체를 한 번에 보고 24개 히트맵을 내면 치아 순서 정렬 문제도 사라진다.

  입력 512x512 RGB
    -> ImageNet 사전학습 ResNet-34 백본 (stride 32까지)
    -> 디코더 3단 업샘플 + skip (stride 4, 128x128)
    -> 24채널 히트맵 + 24x2 오프셋 채널
  디코딩: 채널별 argmax -> soft-argmax(3x3 이웃) -> 오프셋 보정 -> 원본 좌표

오프셋 채널을 두는 이유: stride 4 히트맵의 격자 해상도는 512px 기준 4px이고 원본
6016px 기준으로는 47px이다. 격자만으로는 전문가 재현오차(0.674mm ~ 원본 60px)보다
큰 양자화 오차가 생긴다.

## 평가
환자 단위 5-fold. pixel_dataset/annotations_coco.json의 fold 필드를 그대로 쓴다
(환자 겹침 0으로 사전 검증). 지표는 기존 파이프라인과 비교 가능하도록 mm로 낸다:
어금니 간 거리 = 54mm 기준으로 픽셀->mm 환산.

프레임 밖으로 잘린 정답점(visibility=1, 5개)은 손실에서 제외한다. 히트맵은 프레임
밖 좌표를 표현할 수 없으므로 학습시키면 경계로 끌어당기는 편향만 생긴다.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import sys
import time
from pathlib import Path

import numpy as np

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    from torch.utils.data import DataLoader, Dataset
    import torchvision
except ImportError as exc:  # pragma: no cover
    raise SystemExit(f"PyTorch가 필요하다: {exc}")

from PIL import Image

HERE = Path(__file__).resolve().parent
NUM_KEYPOINTS = 24
SCALE_MM = 54.0  # 어금니 간 거리 기준, 기존 파이프라인과 동일


# ---------------------------------------------------------------- 데이터셋


def build_cache(root: Path, records: list[dict], input_size: int) -> dict[str, dict]:
    """리사이즈+패딩된 512px 캔버스를 미리 만들어 메모리에 둔다.

    원본은 최대 6016x4016이라 JPEG 디코딩만 17ms, 리사이즈까지 23ms/장이다. 매 에폭
    384장을 다시 디코딩하면 GPU가 굶는다(실측 GPU 점유 4%, 순수 GPU 계산은
    86ms/step = 3.1s/에폭인데 에폭이 훨씬 오래 걸렸다). 384장 x 512x512x3 = 300MB
    이므로 전량 상주가 가능하다. 워커도 persistent_workers로 상주시켜 Windows의
    spawn 비용(에폭마다 인터프리터 + 부모 메모리 복사)을 없앤다.
    """
    cache: dict[str, dict] = {}
    for record in records:
        name = record["file_name"]
        if name in cache:
            continue
        picture = Image.open(root / "images" / name).convert("RGB")
        width, height = picture.size
        scale = input_size / max(width, height)
        new_w, new_h = round(width * scale), round(height * scale)
        picture = picture.resize((new_w, new_h), Image.BILINEAR)
        canvas = Image.new("RGB", (input_size, input_size), (0, 0, 0))
        pad_x = (input_size - new_w) // 2
        pad_y = (input_size - new_h) // 2
        canvas.paste(picture, (pad_x, pad_y))
        cache[name] = {
            "canvas": np.asarray(canvas, dtype=np.uint8),
            "scale": float(scale),
            "padX": float(pad_x),
            "padY": float(pad_y),
        }
    return cache


class ArchKeypointDataset(Dataset):
    """COCO keypoints -> 512x512 이미지 + 128x128 히트맵 타깃."""

    def __init__(
        self,
        root: Path,
        records: list[dict],
        input_size: int = 512,
        stride: int = 4,
        sigma: float = 2.0,
        augment: bool = False,
        cache: dict[str, dict] | None = None,
    ) -> None:
        self.root = root
        self.records = records
        self.input_size = input_size
        self.stride = stride
        self.output_size = input_size // stride
        self.sigma = sigma
        self.augment = augment
        self.cache = cache if cache is not None else build_cache(root, records, input_size)

    def __len__(self) -> int:
        return len(self.records)

    def __getitem__(self, index: int):
        record = self.records[index]
        entry = self.cache[record["file_name"]]
        canvas = Image.fromarray(entry["canvas"])
        kp = np.asarray(record["keypoints"], dtype=np.float32).reshape(NUM_KEYPOINTS, 3)
        visibility = kp[:, 2]
        scale, pad_x, pad_y = entry["scale"], entry["padX"], entry["padY"]
        points = kp[:, :2] * scale + np.asarray((pad_x, pad_y), dtype=np.float32)

        if self.augment:
            canvas, points = self._augment(canvas, points)

        array = np.asarray(canvas, dtype=np.float32) / 255.0
        array = (array - np.asarray((0.485, 0.456, 0.406), dtype=np.float32)) / np.asarray(
            (0.229, 0.224, 0.225), dtype=np.float32
        )
        tensor = torch.from_numpy(array).permute(2, 0, 1)

        heatmap = np.zeros((NUM_KEYPOINTS, self.output_size, self.output_size), dtype=np.float32)
        offset = np.zeros((NUM_KEYPOINTS * 2, self.output_size, self.output_size), dtype=np.float32)
        offset_mask = np.zeros((NUM_KEYPOINTS, self.output_size, self.output_size), dtype=np.float32)
        weight = np.zeros(NUM_KEYPOINTS, dtype=np.float32)

        radius = int(3 * self.sigma)
        for j in range(NUM_KEYPOINTS):
            if visibility[j] < 2:  # 프레임 밖으로 잘린 정답은 학습 제외
                continue
            gx, gy = points[j] / self.stride
            if not (0 <= gx < self.output_size and 0 <= gy < self.output_size):
                continue
            weight[j] = 1.0
            cx, cy = int(round(gx)), int(round(gy))
            x0, x1 = max(cx - radius, 0), min(cx + radius + 1, self.output_size)
            y0, y1 = max(cy - radius, 0), min(cy + radius + 1, self.output_size)
            if x0 >= x1 or y0 >= y1:
                continue
            ys = np.arange(y0, y1, dtype=np.float32)[:, None]
            xs = np.arange(x0, x1, dtype=np.float32)[None, :]
            heatmap[j, y0:y1, x0:x1] = np.exp(
                -((xs - gx) ** 2 + (ys - gy) ** 2) / (2.0 * self.sigma**2)
            )
            # 오프셋은 피크 근방에서만 회귀 (그 밖은 의미 없음)
            near = (np.abs(xs - gx) <= 1.5) & (np.abs(ys - gy) <= 1.5)
            offset[2 * j, y0:y1, x0:x1] = np.where(near, gx - xs, 0.0)
            offset[2 * j + 1, y0:y1, x0:x1] = np.where(near, gy - ys, 0.0)
            offset_mask[j, y0:y1, x0:x1] = near.astype(np.float32)

        return {
            "image": tensor,
            "heatmap": torch.from_numpy(heatmap),
            "offset": torch.from_numpy(offset),
            "offsetMask": torch.from_numpy(offset_mask),
            "weight": torch.from_numpy(weight),
            "points": torch.from_numpy(points),
            "meta": {"index": index, "scale": scale, "padX": pad_x, "padY": pad_y},
        }

    def _augment(self, picture: Image.Image, points: np.ndarray):
        """구강 사진에 안전한 증강만 쓴다.

        좌우 반전은 쓰지 않는다 — 치아 1..12 번호가 좌우 순서로 정의돼 있어 반전하면
        슬롯 의미가 뒤집힌다(라벨 순서를 함께 뒤집어도 근심/원심 규약이 어긋난다).
        회전은 촬영 각도 변동 범위인 +-12도로 제한한다.
        """
        size = self.input_size
        angle = random.uniform(-12.0, 12.0)
        zoom = random.uniform(0.9, 1.12)
        shift_x = random.uniform(-0.04, 0.04) * size
        shift_y = random.uniform(-0.04, 0.04) * size

        theta = math.radians(angle)
        cos_t, sin_t = math.cos(theta) * zoom, math.sin(theta) * zoom
        center = size / 2.0
        # 순변환: p' = R*(p-c) + c + shift
        matrix_inv = None
        det = cos_t * cos_t + sin_t * sin_t
        if det > 1e-9:
            # PIL은 역변환 행렬을 요구한다
            a, b = cos_t / det, sin_t / det
            tx = center - a * (center + shift_x) - b * (center + shift_y)
            ty = center + b * (center + shift_x) - a * (center + shift_y)
            matrix_inv = (a, b, tx, -b, a, ty)
        if matrix_inv:
            picture = picture.transform((size, size), Image.AFFINE, matrix_inv, Image.BILINEAR)
            shifted = points - center
            points = np.stack(
                (
                    cos_t * shifted[:, 0] - sin_t * shifted[:, 1] + center + shift_x,
                    sin_t * shifted[:, 0] + cos_t * shifted[:, 1] + center + shift_y,
                ),
                axis=1,
            ).astype(np.float32)

        # 색·밝기: 구강 사진은 조명·타액 반사 변동이 크다
        array = np.asarray(picture, dtype=np.float32)
        array *= random.uniform(0.82, 1.18)
        array += random.uniform(-18.0, 18.0)
        gray = array.mean(axis=2, keepdims=True)
        array = gray + (array - gray) * random.uniform(0.85, 1.15)
        picture = Image.fromarray(np.clip(array, 0, 255).astype(np.uint8))
        return picture, points


# ---------------------------------------------------------------- 모델


class UpBlock(nn.Module):
    def __init__(self, in_ch: int, skip_ch: int, out_ch: int) -> None:
        super().__init__()
        self.reduce = nn.Conv2d(skip_ch, out_ch, 1, bias=False) if skip_ch else None
        self.block = nn.Sequential(
            nn.Conv2d(in_ch + (out_ch if skip_ch else 0), out_ch, 3, padding=1, bias=False),
            nn.BatchNorm2d(out_ch),
            nn.ReLU(inplace=True),
            nn.Conv2d(out_ch, out_ch, 3, padding=1, bias=False),
            nn.BatchNorm2d(out_ch),
            nn.ReLU(inplace=True),
        )

    def forward(self, x, skip=None):
        x = F.interpolate(x, scale_factor=2, mode="bilinear", align_corners=False)
        if skip is not None and self.reduce is not None:
            x = torch.cat((x, self.reduce(skip)), dim=1)
        return self.block(x)


class ArchLandmarkNet(nn.Module):
    """ResNet-34 인코더 + 3단 디코더 -> stride 4 히트맵/오프셋."""

    def __init__(self, num_keypoints: int = NUM_KEYPOINTS, pretrained: bool = True) -> None:
        super().__init__()
        weights = torchvision.models.ResNet34_Weights.IMAGENET1K_V1 if pretrained else None
        backbone = torchvision.models.resnet34(weights=weights)
        self.stem = nn.Sequential(backbone.conv1, backbone.bn1, backbone.relu)  # /2
        self.pool = backbone.maxpool  # /4
        self.layer1 = backbone.layer1  # /4,   64
        self.layer2 = backbone.layer2  # /8,  128
        self.layer3 = backbone.layer3  # /16, 256
        self.layer4 = backbone.layer4  # /32, 512
        self.up3 = UpBlock(512, 256, 256)
        self.up2 = UpBlock(256, 128, 128)
        self.up1 = UpBlock(128, 64, 64)
        self.heat = nn.Conv2d(64, num_keypoints, 1)
        self.offset = nn.Conv2d(64, num_keypoints * 2, 1)
        nn.init.constant_(self.heat.bias, -2.19)  # sigmoid(-2.19) ~ 0.1, 희소 타깃 대응

    def forward(self, x):
        s2 = self.stem(x)
        c1 = self.layer1(self.pool(s2))
        c2 = self.layer2(c1)
        c3 = self.layer3(c2)
        c4 = self.layer4(c3)
        d3 = self.up3(c4, c3)
        d2 = self.up2(d3, c2)
        d1 = self.up1(d2, c1)
        return self.heat(d1), self.offset(d1)


# ---------------------------------------------------------------- 손실·디코딩


def focal_heatmap_loss(logits, target, weight):
    """CornerNet 변형 focal loss. 히트맵은 대부분 0이라 BCE만 쓰면 배경에 묻힌다."""
    prob = torch.sigmoid(logits).clamp(1e-4, 1.0 - 1e-4)
    positive = target.ge(0.9).float()
    negative = 1.0 - positive
    pos_loss = -torch.log(prob) * (1.0 - prob) ** 2 * positive
    neg_loss = -torch.log(1.0 - prob) * prob**2 * (1.0 - target) ** 4 * negative
    mask = weight[:, :, None, None]
    total = ((pos_loss + neg_loss) * mask).sum()
    count = (positive * mask).sum().clamp(min=1.0)
    return total / count


def offset_loss(pred, target, mask):
    mask2 = mask.repeat_interleave(2, dim=1)
    diff = F.smooth_l1_loss(pred * mask2, target * mask2, reduction="sum")
    return diff / mask2.sum().clamp(min=1.0)


def decode(heat_logits, offset_pred, stride: int):
    """채널별 argmax -> soft-argmax(3x3) -> 오프셋 보정 -> 입력 해상도 좌표."""
    prob = torch.sigmoid(heat_logits)
    batch, channels, height, width = prob.shape
    flat = prob.reshape(batch, channels, -1)
    scores, indices = flat.max(dim=2)
    ys = (indices // width).float()
    xs = (indices % width).float()

    # 3x3 이웃 확률 가중 중심 (격자 양자화 완화)
    pad = F.pad(prob, (1, 1, 1, 1))
    refined_x = torch.zeros_like(xs)
    refined_y = torch.zeros_like(ys)
    total = torch.zeros_like(xs)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            gy = (ys + dy).clamp(0, height - 1).long()
            gx = (xs + dx).clamp(0, width - 1).long()
            value = pad[
                torch.arange(batch)[:, None], torch.arange(channels)[None, :], gy + 1, gx + 1
            ]
            refined_x += value * (xs + dx)
            refined_y += value * (ys + dy)
            total += value
    total = total.clamp(min=1e-6)
    refined_x = refined_x / total
    refined_y = refined_y / total

    off = offset_pred.reshape(batch, channels, 2, height, width)
    gy = ys.long().clamp(0, height - 1)
    gx = xs.long().clamp(0, width - 1)
    bi = torch.arange(batch)[:, None]
    ci = torch.arange(channels)[None, :]
    off_x = off[bi, ci, 0, gy, gx]
    off_y = off[bi, ci, 1, gy, gx]

    # soft-argmax와 오프셋 보정을 평균 (둘은 서로 독립적인 서브픽셀 추정)
    px = ((refined_x + (xs + off_x)) * 0.5) * stride
    py = ((refined_y + (ys + off_y)) * 0.5) * stride
    return torch.stack((px, py), dim=2), scores


# ---------------------------------------------------------------- 평가


def to_source_px(points: np.ndarray, meta: dict, record: dict) -> np.ndarray:
    """입력 512 좌표 -> 데이터셋 이미지 좌표 -> 원본 사진 좌표."""
    local = (points - np.asarray((meta["padX"], meta["padY"]))) / meta["scale"]
    return local / record["scaleFromSource"]


MOLAR_TEETH = [0, 1, 10, 11]  # 치아 1,2,11,12


def truth_scale_mm_per_px(truth_src: np.ndarray) -> float:
    """정답 24점 중 최대 쌍거리 = 54mm. `_px_decompose.truth_scale_px`와 동일 정의.

    치아1 p1 ~ 치아12 p2를 쓰지 않는 이유: 말단 치아가 회전해 있으면 최외곽 쌍이
    그 조합이 아니다. 기존 지표와 숫자를 나란히 놓으려면 정의가 같아야 한다.
    """
    span = max(
        float(np.linalg.norm(truth_src[i + 1:] - truth_src[i], axis=1).max())
        for i in range(23)
    )
    return SCALE_MM / span if span > 0 else 0.0


def arch_metrics_mm(pred_src: np.ndarray, truth_src: np.ndarray) -> dict:
    """`_px_decompose.py` / `_px_stage_check.py`와 동일한 정의의 mm 오차.

    - position: 치아별 **중점 이동** 크기 (기존 파이프라인의 주 지표)
    - endpoint: 끝점 24개의 평균 오차 (픽셀 모델 고유 지표, 참고용)
    - lengthAbs: 치아폭 길이 절대오차
    - tzl: 12개 선분 길이 합의 절대오차
    """
    mm = truth_scale_mm_per_px(truth_src)
    if mm <= 0:
        return {}
    pred_mid = (pred_src[0::2] + pred_src[1::2]) / 2.0
    truth_mid = (truth_src[0::2] + truth_src[1::2]) / 2.0
    position = np.linalg.norm(pred_mid - truth_mid, axis=1) * mm
    endpoint = np.linalg.norm(pred_src - truth_src, axis=1) * mm

    pred_vec = pred_src[1::2] - pred_src[0::2]
    truth_vec = truth_src[1::2] - truth_src[0::2]
    pred_len = np.linalg.norm(pred_vec, axis=1)
    truth_len = np.linalg.norm(truth_vec, axis=1)
    cos = np.clip(
        (pred_vec * (truth_vec / np.maximum(truth_len[:, None], 1e-12))).sum(axis=1)
        / np.maximum(pred_len, 1e-12), -1.0, 1.0)
    length_signed = (pred_len - truth_len) * mm
    truth_len_mm = truth_len * mm
    return {
        "position": float(position.mean()),
        "molar": float(position[MOLAR_TEETH].mean()),
        "endpoint": float(endpoint.mean()),
        "terminal": float(position[[0, 11]].mean()),
        "lengthAbs": float(np.abs(length_signed).mean()),
        "molarLengthAbs": float(np.abs(length_signed[MOLAR_TEETH]).mean()),
        "lengthSignedPct": float(
            (length_signed / np.maximum(truth_len_mm, 1e-12)).mean() * 100.0),
        "angleDeg": float(np.degrees(np.arccos(np.abs(cos))).mean()),
        "tzl": float(abs(length_signed.sum())),
        "positionP95": float(np.quantile(position, 0.95)),
    }


@torch.no_grad()
def evaluate(model, loader, dataset, records, device, stride: int) -> tuple[list[dict], list[dict]]:
    model.eval()
    per_case: list[dict] = []
    raw: list[dict] = []
    for batch in loader:
        images = batch["image"].to(device, non_blocking=True)
        heat, offset = model(images)
        points, scores = decode(heat, offset, stride)
        points = points.cpu().numpy()
        scores = scores.cpu().numpy()
        truth = batch["points"].numpy()
        for b in range(points.shape[0]):
            index = int(batch["meta"]["index"][b])
            record = records[index]
            meta = {k: float(batch["meta"][k][b]) for k in ("scale", "padX", "padY")}
            pred_src = to_source_px(points[b], meta, record)
            truth_src = to_source_px(truth[b], meta, record)
            metrics = arch_metrics_mm(pred_src, truth_src)
            if not metrics:
                continue
            metrics["caseId"] = record["caseId"]
            metrics["patientGroupId"] = record["patientGroupId"]
            metrics["imageSha256"] = record["imageSha256"]
            metrics["minScore"] = round(float(scores[b].min()), 4)
            metrics["meanScore"] = round(float(scores[b].mean()), 4)
            per_case.append(metrics)
            raw.append({
                "caseId": record["caseId"],
                "predSourcePx": np.round(pred_src, 2).tolist(),
                "scores": np.round(scores[b], 4).tolist(),
            })
    return per_case, raw


METRIC_KEYS = ("position", "molar", "endpoint", "terminal", "lengthAbs", "molarLengthAbs",
               "lengthSignedPct", "angleDeg", "tzl", "positionP95")


def aggregate(rows: list[dict]) -> dict:
    keys = METRIC_KEYS
    if not rows:
        return {}
    out = {k: round(float(np.mean([r[k] for r in rows])), 4) for k in keys}
    out["cases"] = len(rows)
    out["positionP95Overall"] = round(float(np.quantile([r["position"] for r in rows], 0.95)), 4)
    return out


# ---------------------------------------------------------------- 학습 루프


def run_fold(args, records: list[dict], fold: int, device, cache: dict[str, dict]) -> dict:
    train_records = [r for r in records if r["fold"] != fold]
    valid_records = [r for r in records if r["fold"] == fold]
    train_patients = {r["patientGroupId"] for r in train_records}
    valid_patients = {r["patientGroupId"] for r in valid_records}
    overlap = train_patients & valid_patients
    if overlap:
        raise SystemExit(f"환자 누출 발견 fold {fold}: {sorted(overlap)[:5]}")

    root = args.dataset
    train_set = ArchKeypointDataset(root, train_records, args.input_size, args.stride,
                                    args.sigma, augment=True, cache=cache)
    valid_set = ArchKeypointDataset(root, valid_records, args.input_size, args.stride,
                                    args.sigma, augment=False, cache=cache)
    # persistent_workers: Windows는 fork가 없어 워커를 매 에폭 spawn하면 인터프리터
    # 시작 + 부모 메모리 복사가 반복된다(실측 CPU 시간이 실제 계산의 15배).
    loader_extra = ({"persistent_workers": True, "prefetch_factor": 4}
                    if args.workers > 0 else {})
    train_loader = DataLoader(train_set, batch_size=args.batch_size, shuffle=True,
                              num_workers=args.workers, pin_memory=True, drop_last=True,
                              **loader_extra)
    valid_loader = DataLoader(valid_set, batch_size=args.batch_size, shuffle=False,
                              num_workers=args.workers, pin_memory=True, **loader_extra)

    model = ArchLandmarkNet(pretrained=not args.no_pretrained).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    steps = max(1, len(train_loader)) * args.epochs
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer, max_lr=args.lr, total_steps=steps, pct_start=0.25
    )
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")

    best = None
    history = []
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
                loss = focal_heatmap_loss(heat_p, heat_t, weight) + args.offset_weight * offset_loss(
                    off_p, off_t, off_m
                )
            scaler.scale(loss).backward()
            scaler.unscale_(optimizer)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            scaler.step(optimizer)
            scaler.update()
            scheduler.step()
            losses.append(float(loss.detach()))

        if epoch % args.eval_every == 0 or epoch == args.epochs:
            rows, _ = evaluate(model, valid_loader, valid_set, valid_records, device, args.stride)
            summary = aggregate(rows)
            history.append({"epoch": epoch, "loss": round(float(np.mean(losses)), 5), **summary})
            print(f"  fold{fold} ep{epoch:3d} loss={np.mean(losses):.4f} "
                  f"pos={summary.get('position', float('nan')):.3f}mm "
                  f"molar={summary.get('molar', float('nan')):.3f}mm "
                  f"tzl={summary.get('tzl', float('nan')):.3f}mm "
                  f"({time.time() - started:.0f}s)", flush=True)
            if best is None or summary["position"] < best["position"]:
                best = summary
                if args.save_weights:
                    args.out.mkdir(parents=True, exist_ok=True)
                    torch.save(model.state_dict(), args.out / f"fold{fold}.pt")
        else:
            print(f"  fold{fold} ep{epoch:3d} loss={np.mean(losses):.4f} "
                  f"({time.time() - started:.0f}s)", flush=True)

    rows, raw = evaluate(model, valid_loader, valid_set, valid_records, device, args.stride)
    return {
        "fold": fold,
        "trainCases": len(train_records),
        "validCases": len(valid_records),
        "trainPatients": len(train_patients),
        "validPatients": len(valid_patients),
        "patientOverlap": 0,
        "best": best,
        "final": aggregate(rows),
        "history": history,
        "perCase": rows,
        "predictions": raw if args.save_predictions else None,
    }


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=HERE / "pixel_dataset")
    parser.add_argument("--out", type=Path, default=HERE / "pixel_model")
    parser.add_argument("--folds", type=int, nargs="*", default=None,
                        help="평가할 fold 목록. 생략하면 전체")
    parser.add_argument("--epochs", type=int, default=60)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--input-size", type=int, default=512)
    parser.add_argument("--stride", type=int, default=4)
    parser.add_argument("--sigma", type=float, default=2.0)
    parser.add_argument("--offset-weight", type=float, default=1.0)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--eval-every", type=int, default=5)
    parser.add_argument("--seed", type=int, default=20260729)
    parser.add_argument("--no-pretrained", action="store_true")
    parser.add_argument("--save-weights", action="store_true")
    parser.add_argument("--save-predictions", action="store_true")
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
    print(f"device={device} cases={len(records)} "
          f"patients={len({r['patientGroupId'] for r in records})}", flush=True)

    started = time.time()
    cache = build_cache(args.dataset, records, args.input_size)
    print(f"이미지 캐시 {len(cache)}장 "
          f"({sum(e['canvas'].nbytes for e in cache.values()) / 1e6:.0f}MB, "
          f"{time.time() - started:.0f}s)", flush=True)

    folds = args.folds if args.folds else sorted({r["fold"] for r in records})
    results = []
    for fold in folds:
        print(f"[fold {fold}]", flush=True)
        results.append(run_fold(args, records, fold, device, cache))

    all_rows = [row for r in results for row in r["perCase"]]
    report = {
        "schemaVersion": "pixel-landmark-metrics-v1",
        "privacy": {"containsPhi": False, "containsPatientNames": False,
                    "containsFilePaths": False, "containsImagePixels": False,
                    "containsImageCoordinates": False,
                    "containsCaseIdentifiers": True,
                    "note": "perCase는 caseId·이미지해시와 mm 오차만 담는다. 좌표는 "
                            "--save-predictions 시 predictions.json에만 들어간다."},
        "config": {
            "epochs": args.epochs, "batchSize": args.batch_size, "lr": args.lr,
            "inputSize": args.input_size, "stride": args.stride, "sigma": args.sigma,
            "offsetWeight": args.offset_weight, "seed": args.seed,
            "pretrained": not args.no_pretrained,
            "backbone": "resnet34", "head": "heatmap+offset",
            "splitPolicy": "patient_grouped_5fold",
            "scaleMm": SCALE_MM,
        },
        "foldsEvaluated": folds,
        "overallOutOfFold": aggregate(all_rows),
        "folds": [{k: v for k, v in r.items() if k not in ("perCase", "predictions")}
                  for r in results],
        # 케이스별 값은 규칙엔진·KRR과 짝지어 비교(_pixel_ab.py)하기 위해 남긴다.
        # 좌표는 포함하지 않는다.
        "perCase": [{k: (round(v, 4) if isinstance(v, float) else v)
                     for k, v in row.items() if k != "patientGroupId"}
                    for r in results for row in r["perCase"]],
        "metricDefinitions": {
            "position": "치아별 중점 이동 크기의 평균 (mm). _px_decompose.py와 동일 정의",
            "molar": "구치부 치아 1,2,11,12의 중점 이동 (mm)",
            "endpoint": "끝점 24개 평균 유클리드 오차 (mm). 픽셀 모델 고유 지표",
            "lengthAbs": "치아폭 길이 절대오차 (mm)",
            "tzl": "12개 선분 길이 합의 절대오차 (mm)",
            "scaleNote": "mm 환산은 정답 24점 최대 쌍거리 = 54mm (항상 정답 기준)",
        },
    }
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "metrics.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.save_predictions:
        (args.out / "predictions.json").write_text(
            json.dumps({r["fold"]: r["predictions"] for r in results},
                       ensure_ascii=False) + "\n", encoding="utf-8")

    print(json.dumps({"overallOutOfFold": report["overallOutOfFold"],
                      "folds": [{"fold": r["fold"], **(r["final"] or {})} for r in results]},
                     ensure_ascii=False, indent=2))
    print(f"-> {args.out / 'metrics.json'}")


if __name__ == "__main__":
    main()
