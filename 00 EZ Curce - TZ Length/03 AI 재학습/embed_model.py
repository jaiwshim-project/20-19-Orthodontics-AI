#!/usr/bin/env python3
"""보정 후 HTML의 window.EZ_RESIDUAL_MODEL 블록을 최신 residual-model.json으로 교체.

원본 운영 HTML(보정 전)은 건드리지 않는다. 교체 전 .bak 백업.
경계는 'window.EZ_RESIDUAL_MODEL={' 시작과, 그 뒤 최초의 '\n}\n;\n</script>' 종료 앵커로 판정.
"""
import json
import re
import shutil
from pathlib import Path

PROJ = Path(r"C:\01 클로드코드\20-19 Orthodontics AI\00 EZ Curce - TZ Length")
HTML = PROJ / "EZ Curve - TZ Length - 보정 후 알고리즘 적용.html"
MODEL = PROJ / "03 AI 재학습" / "residual-model.json"

text = HTML.read_text(encoding="utf-8")
model = json.loads(MODEL.read_text(encoding="utf-8"))

start_marker = "window.EZ_RESIDUAL_MODEL="
start = text.find(start_marker)
if start < 0:
    raise SystemExit("start marker not found")
brace = text.find("{", start)

# 종료 앵커: 모델 JSON 끝의 '}' 다음에 오는 '\n;\n</script>' 패턴.
end_anchor = re.search(r"\n\}\n;\n</script>", text[brace:])
if not end_anchor:
    raise SystemExit("end anchor not found")
json_end = brace + end_anchor.start() + len("\n}")  # 닫는 중괄호 포함 위치

old_json = text[brace:json_end]
# 안전성 검증: 기존 블록이 유효한 JSON인지
try:
    json.loads(old_json)
except Exception as e:
    raise SystemExit(f"existing block is not valid JSON, aborting: {e}")

new_json = json.dumps(model, ensure_ascii=False, indent=2)
new_text = text[:brace] + new_json + text[json_end:]

# sanity: 정확히 하나의 EZ_RESIDUAL_MODEL, 새 텍스트도 파싱 가능
b2 = new_text.find("{", new_text.find(start_marker))
ea2 = re.search(r"\n\}\n;\n</script>", new_text[b2:])
json.loads(new_text[b2:b2 + ea2.start() + len("\n}")])

shutil.copy2(HTML, str(HTML) + ".bak-before-class2-embed")
HTML.write_text(new_text, encoding="utf-8")

print("OK embedded.")
print("  old model bytes:", len(old_json))
print("  new model bytes:", len(new_json))
print("  width samples:", model["tasks"]["width"]["trainingSamples"])
print("  ez samples:", model["tasks"]["ez"]["trainingSamples"])
print("  promotionGate:", model["promotionGate"]["pass"])
