#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""file:// 로 열어도 픽셀 모델이 돌게 하는 심(shim) 파일을 만든다.

## 왜 필요한가 — 이전 결론의 정정
`_patch_pixel_landmarks.py` 초안과 그 뒤 실측 보고서는 "file://에서는 픽셀 층이
돌지 않는다, HTTP로 열어야 한다"고 확정했다. 그 결론은 **틀렸다**.
`_file_probe/`의 프로브 3종으로 재측정한 사실:

    fetch(로컬)                 : 차단 (Failed to fetch)
    XMLHttpRequest(로컬)        : 차단 (status=0)
    import('상대경로.mjs')       : 차단 (bare module specifier)
    import('file:///절대.mjs')   : 차단 (Failed to fetch dynamically imported module)
    import(blob URL)            : **통과**
    import(data URL)            : **통과**
    classic <script src>        : **통과** (원래부터)

즉 막히는 것은 **네트워크성 로드**뿐이고, 글루 소스를 classic script로 실어와
blob URL로 import하면 살아난다. `.wasm`은 `ort.env.wasm.wasmBinary`로 바이트를
직접 주면 fetch가 아예 필요 없다. 실제 ORT API로 세션을 열어 Identity 추론까지
확인했다(입력 [1.5,-2.5] → 출력 [1.5,-2.5], `probe2_result.json`).

## import.meta.url 을 왜 치환하는가
Emscripten 글루는 `new URL("ort-wasm-simd-threaded.wasm", import.meta.url)`을
계산한다. blob URL로 import된 모듈에서 `import.meta.url`은 `blob:file:///…`이고
이는 opaque origin이라 URL 생성자가 던진다(실측: "Failed to construct 'URL':
Invalid URL"). 그래서 소스의 `import.meta.url`(5곳)을 안전한 절대 URL 문자열로
바꾼다. wasmBinary를 주므로 이 URL이 실제로 fetch되지는 않는다.

## 왜 HTML에 base64를 박지 않고 별도 파일로 두는가
`.wasm` 11MB → base64 15MB다. HTML에 넣으면 6.4MB → 21MB가 되어 HTTP로 여는
경우에도 매번 그 비용을 낸다. classic script는 file://에서도 통과하므로
`pixel_runtime/` 옆에 두고 **file:// 일 때만** 동적으로 불러온다.

## 49MB 모델도 같은 방법으로 넣는다 — 비용을 재고 판단했다
`.onnx` 49MB → base64 65MB. classic script로 실어오는 비용을 실측했다
(`probe4_result.json`, file:// 환경):

    런타임 3종 스크립트 파싱   304ms
    모델 base64 스크립트 파싱  ~676ms (누적 980ms)
    atob + Uint8Array 복사     177ms
    ORT 세션 생성              362ms
    추론 1회(512x512)         1,608ms
    ------------------------------------
    최초 로드~첫 추론 완료     3,127ms,  JS 힙 368MB

3초대이고 출력 shape도 [1,24,128,128]/[1,48,128,128]로 정상이다. 수용 가능하므로
**file:// 자동 로드**를 지원한다. 단 HTTP로 열 때는 이 65MB를 낭비할 이유가 없으므로
`file:`일 때만 동적으로 주입한다(HTTP는 기존 fetch 경로 유지).

산출물(모두 pixel_runtime/):
  ort_glue_src.js   — 글루 소스 문자열(import.meta.url 치환) → window.__EZ_ORT_GLUE_SRC
  ort_wasm_b64.js   — .wasm base64 → window.__EZ_ORT_WASM_BYTES (Uint8Array)
  model_b64.js      — .onnx base64 → window.__EZ_MODEL_BYTES (Uint8Array)
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNTIME = HERE.parent / "pixel_runtime"


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    glue_path = RUNTIME / "ort-wasm-simd-threaded.mjs"
    wasm_path = RUNTIME / "ort-wasm-simd-threaded.wasm"
    for p in (glue_path, wasm_path):
        if not p.exists():
            raise SystemExit(f"런타임 파일 없음: {p.name}")

    glue = glue_path.read_text(encoding="utf-8")
    hits = len(re.findall(r"import\.meta\.url", glue))
    if hits == 0:
        raise SystemExit("import.meta.url 을 찾지 못했다 — 글루 형식이 바뀐 듯하다")

    # 치환 대상 URL은 fetch되지 않는다(wasmBinary 주입). 단지 URL 생성자가 던지지
    # 않을 유효한 절대 URL이어야 한다. 실행 시점 document.baseURI 기준으로 만든다.
    patched = glue.replace("import.meta.url", "__EZ_ORT_GLUE_BASE__")

    glue_js = (
        "/* 자동 생성: _gen_file_shim.py — 직접 수정하지 말 것.\n"
        " * file:// 에서 ORT WASM 글루를 살리기 위한 소스 반출(classic script).\n"
        " * import.meta.url 은 blob URL import 시 opaque origin이라 URL 생성자를\n"
        " * 터뜨린다. 실행 시점에 안전한 절대 URL로 바꿔 넣는다. */\n"
        "(function(){\n"
        "  var base = new URL('pixel_runtime/ort-wasm-simd-threaded.mjs',\n"
        "    document.baseURI).href;\n"
        "  window.__EZ_ORT_GLUE_SRC = " + json.dumps(patched) + "\n"
        "    .split('__EZ_ORT_GLUE_BASE__').join(JSON.stringify(base));\n"
        "  window.__EZ_ORT_GLUE_PATCH_COUNT = " + str(hits) + ";\n"
        "})();\n"
    )
    out_glue = RUNTIME / "ort_glue_src.js"
    out_glue.write_text(glue_js, encoding="utf-8")

    wasm = wasm_path.read_bytes()
    b64 = base64.b64encode(wasm).decode("ascii")
    wasm_js = (
        "/* 자동 생성: _gen_file_shim.py — 직접 수정하지 말 것.\n"
        " * file:// 에서는 fetch/XHR이 모두 차단된다(실측). .wasm 바이트를 classic\n"
        " * script로 실어와 ort.env.wasm.wasmBinary 로 주입한다. */\n"
        'window.__EZ_ORT_WASM_B64 = "' + b64 + '";\n'
        "(function(){\n"
        "  var raw = atob(window.__EZ_ORT_WASM_B64);\n"
        "  var bytes = new Uint8Array(raw.length);\n"
        "  for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);\n"
        "  window.__EZ_ORT_WASM_BYTES = bytes;\n"
        "  window.__EZ_ORT_WASM_SHA256_PREFIX = "
        + json.dumps(hashlib.sha256(wasm).hexdigest()[:16]) + ";\n"
        "  delete window.__EZ_ORT_WASM_B64;   // 15MB 문자열을 남겨 두지 않는다\n"
        "})();\n"
    )
    out_wasm = RUNTIME / "ort_wasm_b64.js"
    out_wasm.write_text(wasm_js, encoding="utf-8")

    # 모델 base64 — file:// 자동 로드용. SHA를 함께 실어 무결성을 확인한다.
    model_path = RUNTIME / "arch_landmarks.onnx"
    if not model_path.exists():
        raise SystemExit("arch_landmarks.onnx 없음")
    model = model_path.read_bytes()
    model_sha = hashlib.sha256(model).hexdigest()
    model_js = (
        "/* 자동 생성: _gen_file_shim.py — 직접 수정하지 말 것.\n"
        " * file:// 에서는 .onnx fetch가 차단된다(실측). 49MB 모델을 base64로 실어와\n"
        " * Uint8Array로 복원한다. 실측 비용: 파싱 ~0.7s + 복원 0.18s (probe4). */\n"
        'window.__EZ_MODEL_B64 = "' + base64.b64encode(model).decode("ascii") + '";\n'
        "(function(){\n"
        "  var raw = atob(window.__EZ_MODEL_B64);\n"
        "  var bytes = new Uint8Array(raw.length);\n"
        "  for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);\n"
        "  window.__EZ_MODEL_BYTES = bytes;\n"
        "  window.__EZ_MODEL_SHA256_PREFIX = " + json.dumps(model_sha[:16]) + ";\n"
        "  delete window.__EZ_MODEL_B64;   // 65MB 문자열을 남겨 두지 않는다\n"
        "})();\n"
    )
    out_model = RUNTIME / "model_b64.js"
    out_model.write_text(model_js, encoding="utf-8")

    print(f"import.meta.url 치환: {hits}곳")
    print(f"ort_glue_src.js  {out_glue.stat().st_size:,} bytes")
    print(f"ort_wasm_b64.js  {out_wasm.stat().st_size:,} bytes "
          f"(원본 .wasm {len(wasm):,})")
    print(f"model_b64.js     {out_model.stat().st_size:,} bytes "
          f"(원본 .onnx {len(model):,})")
    print(f".wasm  SHA256 {hashlib.sha256(wasm).hexdigest()[:16]}")
    print(f".onnx  SHA256 {model_sha[:16]}")


if __name__ == "__main__":
    main()
