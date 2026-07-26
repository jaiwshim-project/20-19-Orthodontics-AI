#!/usr/bin/env python3
"""보정 후(연구용) HTML의 잔차모델 + 추론엔진을 최신 산출물로 교체.

원본 운영 HTML(보정 전)은 절대 건드리지 않는다. 교체 전 .bak 백업.

교체 대상 2곳:
  1) window.EZ_RESIDUAL_MODEL={...}  ← 03 AI 재학습/residual-model.json
  2) UMD 추론엔진 블록               ← 03 AI 재학습/residual_inference.js
HTML에 박힌 추론엔진이 파일 쪽과 어긋나면 다단(스테이지) 보정이 조용히 1단계로
동작하므로, 모델만 갈아끼우지 않고 엔진도 같은 시점의 것으로 함께 교체한다.

경계 판정:
  모델   = 'window.EZ_RESIDUAL_MODEL={' 시작 ~ 그 뒤 최초 '\n}\n;\n</script>'
  추론   = '(function universalModule(' 시작 ~ 그 뒤 최초 '\n}));'
"""
import argparse
import json
import re
import shutil
from pathlib import Path

PROJ = Path(r"C:\01 클로드코드\20-19 Orthodontics AI\00 EZ Curce - TZ Length")
HTML = PROJ / "EZ Curve - TZ Length - 보정 후 알고리즘 적용.html"
HERE = PROJ / "03 AI 재학습"
MODEL = HERE / "residual-model.json"
INFERENCE = HERE / "residual_inference.js"


def replace_model(text: str, model: dict) -> tuple[str, int, int]:
    start = text.find("window.EZ_RESIDUAL_MODEL=")
    if start < 0:
        raise SystemExit("model start marker not found")
    brace = text.find("{", start)
    end_anchor = re.search(r"\n\}\n;\n</script>", text[brace:])
    if not end_anchor:
        raise SystemExit("model end anchor not found")
    json_end = brace + end_anchor.start() + len("\n}")
    old_json = text[brace:json_end]
    try:
        json.loads(old_json)
    except Exception as error:  # noqa: BLE001 - 중단 목적
        raise SystemExit(f"existing model block is not valid JSON, aborting: {error}")
    new_json = json.dumps(model, ensure_ascii=False, indent=2)
    return text[:brace] + new_json + text[json_end:], len(old_json), len(new_json)


def replace_inference(text: str, source: str) -> tuple[str, int, int]:
    start = text.find("(function universalModule(")
    if start < 0:
        raise SystemExit("inference module start marker not found")
    end_anchor = re.search(r"\n\}\)\);", text[start:])
    if not end_anchor:
        raise SystemExit("inference module end anchor not found")
    end = start + end_anchor.start() + len("\n}));")
    old_block = text[start:end]
    # 교체본은 UMD 래퍼 전체(주석 헤더 제외)만 취한다.
    new_start = source.find("(function universalModule(")
    if new_start < 0:
        raise SystemExit("residual_inference.js has no UMD wrapper")
    new_block = source[new_start:].rstrip()
    if not new_block.endswith("}));"):
        raise SystemExit("residual_inference.js does not end with the UMD wrapper")
    return text[:start] + new_block + text[end:], len(old_block), len(new_block)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--backup-suffix",
        default=".bak-before-stage2-embed",
        help="백업 파일 접미어(교체마다 새 이름을 주어 이전 백업을 덮어쓰지 않는다)",
    )
    args = parser.parse_args()

    text = HTML.read_text(encoding="utf-8")
    model = json.loads(MODEL.read_text(encoding="utf-8"))
    inference_source = INFERENCE.read_text(encoding="utf-8")

    text, old_model_bytes, new_model_bytes = replace_model(text, model)
    text, old_engine_bytes, new_engine_bytes = replace_inference(text, inference_source)

    # sanity: 모델 블록이 다시 파싱되고, 엔진/모델이 각각 정확히 하나만 남았는지.
    brace = text.find("{", text.find("window.EZ_RESIDUAL_MODEL="))
    anchor = re.search(r"\n\}\n;\n</script>", text[brace:])
    json.loads(text[brace:brace + anchor.start() + len("\n}")])
    if text.count("window.EZ_RESIDUAL_MODEL=") != 1:
        raise SystemExit("model marker is not unique after embedding")
    if text.count("(function universalModule(") != 1:
        raise SystemExit("inference module marker is not unique after embedding")

    backup = str(HTML) + args.backup_suffix
    if Path(backup).exists():
        raise SystemExit(f"backup already exists, choose another suffix: {backup}")
    shutil.copy2(HTML, backup)
    HTML.write_text(text, encoding="utf-8")

    policy = model["correctionPolicy"]
    print(json.dumps({
        "backup": Path(backup).name,
        "modelBytes": {"old": old_model_bytes, "new": new_model_bytes},
        "engineBytes": {"old": old_engine_bytes, "new": new_engine_bytes},
        "widthSamples": model["tasks"]["width"]["trainingSamples"],
        "ezSamples": model["tasks"]["ez"]["trainingSamples"],
        "stageCount": policy.get("stageCount"),
        "perStageCap": policy["maximumPerLandmarkCorrectionDiagonalFraction"],
        "cumulativeCap": policy.get("maximumCumulativeCorrectionDiagonalFraction"),
        "promotionGate": model["promotionGate"]["pass"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
