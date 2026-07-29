#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""연구용 HTML에 픽셀 랜드마크(24점 히트맵) 층을 붙인다.

## 무엇을 바꾸는가
`runAutoEngine`은 그대로 둔다(규칙엔진 → KRR 잔차보정). 그 **뒤에** 픽셀 모델이
치아폭 24점을 다시 잡는 층을 붙인다. 즉 파이프라인은
    규칙엔진 → KRR 잔차보정 → **픽셀 랜드마크(폭만 교체)**
이고, EZ 12점은 여전히 규칙+KRR이 정한다. 픽셀 모델은 EZ를 예측하지 않기 때문이다.

## 왜 폭만 교체하는가 (실측 근거)
좌표 OOF 315건 짝지어 비교:
    위치(중점이동) 규칙 3.808 → KRR 2.164 → 픽셀 **0.311** mm
    어금니          5.277 → 2.724 → **0.409** mm
KRR 대비 위치 +85.7%(CI [+1.739,+1.971], 312/3 개선). 반면 앱이 표시하는 EZL은
EZ 곡선 길이라 픽셀 모델이 손댈 수 없다 — 실측 EZL 개선 0.00%.

## 왜 WIDTH_BIAS를 씌우지 않는가
KRR 경로의 1.013은 KRR 예측의 길이 축소 편향을 상쇄하는 값이다. 픽셀 예측에는
그 편향이 없다: 배율 1.000에서 부호편향 −0.36%, 최적 배율은 **1.003**이고 이득은
0.46%뿐이다. 1.013을 그대로 씌우면 길이오차 0.2396 → 0.2494mm(**−4.1% 악화**)다.
그래서 픽셀 경로는 배율 없이 쓴다.

## 폴백 규칙 (신뢰도 게이트는 두지 않는다)
임계 스윕 결과 폴백은 **항상 손해**였다(임계 0.10에서 이미 0.3105 → 0.3233mm).
픽셀이 KRR보다 나쁜 케이스는 315건 중 3건(0.95%)뿐이고, 그것을 걸러내려 임계를
올리면 잘 맞은 케이스까지 함께 되돌려 평균이 나빠진다. 따라서 게이트는 **형식
검증만** 한다: 12선분, 좌표가 이미지 안, 선분 길이 >2px. 하나라도 깨지면 KRR 유지.

## file:// 지원 — 두 번의 정정을 거친 결론
1차 초안: "file://에서는 .onnx를 수동 지정하면 된다" → **거짓**(`_pixel_file_protocol_check.mjs`).
2차 결론: "file://에서는 우회 불가, HTTP로 열어야 한다" → **이것도 거짓**이었다.

`_file_probe/`의 프로브 4종으로 로더를 뜯어 재측정한 결과:

    fetch / XMLHttpRequest      : 차단
    import('상대.mjs')           : 차단 (bare module specifier)
    import('file:///절대.mjs')   : 차단 (dynamically imported module)
    import(blob URL)            : **통과**
    classic <script src>        : **통과**

즉 막히는 것은 **네트워크성 로드뿐**이다. 그래서 file://에서는:
  ① 글루 소스를 classic script(`ort_glue_src.js`)로 실어와 **blob URL로 import**
     — 이때 글루의 `import.meta.url`(5곳)을 미리 치환해야 한다. blob URL 모듈에서는
       `blob:file:///…`가 opaque origin이라 `new URL(...)`이 던진다(실측).
  ② `.wasm`은 `ort.env.wasm.wasmBinary`로 **바이트 직접 주입** → fetch 불필요
  ③ `.onnx` 49MB도 base64 classic script(`model_b64.js`)로 주입
실측(probe4, file://): 로드~첫 추론 3,127ms, 출력 [1,24,128,128]/[1,48,128,128] 정상.

HTTP로 열 때는 65MB base64를 낭비할 이유가 없으므로 **file:일 때만** 이 3개를
동적으로 붙인다. HTTP는 기존 fetch 경로를 그대로 쓴다.

⚠️ HTTP에서 wasmPaths는 절대 URL이어야 한다. 상대 경로('pixel_runtime/')를 주면
   bare module specifier로 해석돼 층이 조용히 폴백한다(실측 3/3 실패).
"""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
HTML = HERE.parent / "EZ Curve - TZ Length - 보정 후 알고리즘 적용.html"

RUNTIME_TAGS = """<script src="pixel_runtime/ort.wasm.min.js"></script>
<script src="pixel_runtime/pixel_inference.js"></script>
<script>
// === 픽셀 랜드마크 런타임 설정 ===
// numThreads=1: 멀티스레드 WASM은 SharedArrayBuffer를 요구해 COOP/COEP 헤더가 필요하다.
// 로컬에서 헤더 없이 열리므로 단일 스레드로 고정한다(추론 1~3초).
//
// ⚠️ HTTP에서 wasmPaths는 **절대 URL**이어야 한다. 'pixel_runtime/' 처럼 상대 경로를
//    주면 ORT가 .mjs 글루를 dynamic import할 때 "bare module specifier"로 해석해
//    `Failed to resolve module specifier 'pixel_runtime/ort-wasm-simd-threaded.mjs'`로
//    죽고, 픽셀 층이 조용히 폴백한다(실측: 3/3 케이스 pixelApplied=false).
//    .wasm은 상대 경로로도 받아지므로 fetch 200만 보고 통과로 착각하기 쉽다.
//
// file:// 은 fetch·XHR·모듈 import가 모두 막히지만 **classic script와 blob URL
// import는 통과한다**(_file_probe 실측). 그래서 file:일 때는 글루/wasm/모델을
// 스크립트로 실어와 주입한다 — 아래 EzPixelFileMode가 그 일을 한다.
window.EzPixelFileMode=(function(){
  var isFile=location.protocol==='file:';
  var readyPromise=null;
  /** 스크립트 1개를 classic script로 붙인다(file://에서 통과하는 유일한 경로). */
  function addScript(src){
    return new Promise(function(resolve,reject){
      var s=document.createElement('script');
      s.src=src; s.async=false;
      s.onload=function(){resolve(src);};
      s.onerror=function(){reject(new Error('스크립트 로드 실패: '+src));};
      document.head.appendChild(s);
    });
  }
  /** file:// 전용 준비. 글루·wasm·모델을 순서대로 주입하고 ort.env를 설정한다. */
  function prepare(onProgress){
    if(!isFile) return Promise.resolve({mode:'http'});
    if(readyPromise) return readyPromise;
    readyPromise=(function(){
      var steps=[
        {src:'pixel_runtime/ort_glue_src.js', label:'WASM 글루', check:function(){return typeof window.__EZ_ORT_GLUE_SRC==='string';}},
        {src:'pixel_runtime/ort_wasm_b64.js', label:'WASM 바이너리(11MB)', check:function(){return !!window.__EZ_ORT_WASM_BYTES;}},
        {src:'pixel_runtime/model_b64.js',    label:'모델(49MB)',        check:function(){return !!window.__EZ_MODEL_BYTES;}}
      ];
      var chain=Promise.resolve();
      steps.forEach(function(step,idx){
        chain=chain.then(function(){
          if(step.check()) return null;          // 이미 로드됨(중복 방지)
          if(onProgress) onProgress(step.label, idx, steps.length);
          return addScript(step.src).then(function(){
            if(!step.check()) throw new Error(step.label+' 주입 실패');
          });
        });
      });
      return chain.then(function(){
        // 글루를 blob URL로 import시키기 위해 wasmPaths.mjs에 blob을 준다.
        // ⚠️ ort_glue_src.js가 import.meta.url을 이미 치환해 뒀다. 치환하지 않으면
        //    blob 모듈에서 new URL(...)이 opaque origin 때문에 던진다(실측).
        var glueUrl=URL.createObjectURL(new Blob([window.__EZ_ORT_GLUE_SRC],{type:'text/javascript'}));
        ort.env.wasm.wasmPaths={mjs:glueUrl, wasm:'ort-wasm-simd-threaded.wasm'};
        // wasmBinary를 주면 글루가 .wasm을 fetch하지 않는다(file://에서 필수).
        ort.env.wasm.wasmBinary=window.__EZ_ORT_WASM_BYTES;
        return {mode:'file', modelBytes:window.__EZ_MODEL_BYTES,
                modelShaPrefix:window.__EZ_MODEL_SHA256_PREFIX||null};
      });
    })().catch(function(err){
      readyPromise=null;    // 재시도 가능하게 되돌린다
      throw err;
    });
    return readyPromise;
  }
  return {isFile:isFile, prepare:prepare};
})();
(function(){
  if(typeof ort==='undefined') return;
  // HTTP 기본 설정. file:// 일 때는 prepare()가 wasmPaths를 덮어쓴다.
  if(location.protocol!=='file:'){
    ort.env.wasm.wasmPaths=new URL('pixel_runtime/', document.baseURI).href;
  }
  ort.env.wasm.numThreads=1;
  ort.env.wasm.proxy=false;
  ort.env.logLevel='error';
})();
</script>
"""

PIXEL_LAYER = r"""
  // ===== 픽셀 랜드마크 층 (치아폭 24점 히트맵 검출) =====
  //
  // 파이프라인: 규칙엔진 → KRR 잔차보정 → **여기서 폭 24점만 교체**.
  // EZ 12점은 건드리지 않는다 — 픽셀 모델은 EZ를 예측하지 않는다.
  //
  // 실측(OOF 315건, 짝지어진 부트스트랩 5,000회):
  //   위치(중점이동) 규칙 3.808 → KRR 2.164 → 픽셀 0.311 mm  (KRR 대비 +85.7%)
  //   어금니 위치     5.277 → 2.724 → 0.409 mm               (+85.0%)
  //   길이오차       1.108 → 0.783 → 0.235 mm               (+69.9%)
  // 앱 표시 기준(60건): TZL 5.49 → 4.72mm(+14.0%, 유의 아님), EZL 3.44mm 그대로.
  //   → 화면 숫자의 남은 여력은 폭이 아니라 **EZ 곡선**에 있다.
  //
  // ⚠️ WIDTH_BIAS를 씌우지 않는다. 1.013은 KRR 예측의 축소 편향을 상쇄하는 값이고
  //    픽셀 예측에는 그 편향이 없다(최적 배율 1.003, 1.013 적용 시 −4.1% 악화).
  const USE_PIXEL_LANDMARKS = true;
  const PIXEL_MODEL_URL = 'pixel_runtime/arch_landmarks.onnx';
  const PIXEL_ENGINE_VERSION = 'rule+krr-residual+pixel-landmark/v1';
  let pixelSessionPromise = null;
  let pixelModelBytes = null;
  let pixelLoadError = null;

  function pixelAvailable(){
    return USE_PIXEL_LANDMARKS && typeof ort !== 'undefined' && !!window.EzPixelLandmarks;
  }

  function getPixelSession(){
    if(!pixelAvailable()) return Promise.resolve(null);
    if(pixelSessionPromise) return pixelSessionPromise;
    // file:// 이면 글루·wasm·모델을 classic script로 먼저 주입한다(fetch가 막히므로).
    // HTTP면 prepare()가 즉시 {mode:'http'}로 통과하고 기존 fetch 경로를 쓴다.
    const fileMode = window.EzPixelFileMode;
    const prep = (fileMode && fileMode.isFile && !pixelModelBytes)
      ? fileMode.prepare((label, idx, total) => {
          setAutoProgress(40 + Math.round(idx / total * 25),
            '픽셀 모델 준비 중 — ' + label + ' 불러오는 중… (' + (idx + 1) + '/' + total + ')');
        })
      : Promise.resolve(null);
    pixelSessionPromise = prep.then(prepared => {
      // 우선순위: 사용자가 직접 지정한 파일 > file:// 주입 바이트 > HTTP fetch URL
      const source = pixelModelBytes
        || (prepared && prepared.modelBytes)
        || PIXEL_MODEL_URL;
      return window.EzPixelLandmarks.createSession(source, {executionProviders:['wasm']});
    }).catch(err => {
      // 실패해도 조용히 넘기지 않는다. 이유를 UI와 dataset에 남긴다.
      pixelLoadError = err;
      pixelSessionPromise = null;
      updatePixelModelUi();
      throw err;
    });
    return pixelSessionPromise;
  }

  function updatePixelModelUi(){
    const row = document.getElementById('pixelModelRow');
    const badge = document.getElementById('pixelModelStatus');
    if(!row || !badge) return;
    if(!pixelAvailable()){ badge.textContent='런타임 없음'; row.style.display='flex'; return; }
    if(pixelModelBytes){ badge.textContent='모델 준비됨(수동 지정)'; row.style.display='none'; return; }
    if(pixelLoadError){
      badge.textContent='자동 로드 실패 — .onnx 파일을 지정하세요';
      row.style.display='flex';
      return;
    }
    // file:// 도 지원한다. 다만 첫 분석에서 60MB를 스크립트로 읽어 3초쯤 걸리므로
    // 미리 알려 준다(HTTP는 브라우저 캐시를 타서 더 빠르다).
    if(location.protocol==='file:'){
      badge.textContent='file:// 자동 준비 (첫 분석에 약 3초 소요)';
      row.style.display='none';
      return;
    }
    badge.textContent='자동 로드';
    row.style.display='none';
  }

  /** 픽셀 층의 실제 동작을 DOM에 남긴다(검증 스크립트가 읽는다).
   *
   * 앱 스크립트는 IIFE라 내부 변수를 page.evaluate로 읽을 수 없다. 그래서 실구동
   * 검증(_pixel_html_verify.mjs)이 볼 수 있는 유일한 창구가 이 dataset 신호다.
   * ⚠️ 미적용 경로에서도 **반드시** 호출해야 한다 — 안 하면 직전 분석의 'true'가
   *    남아 층이 돌았다고 잘못 읽힌다.
   */
  function stampPixelState(applied, reason, confidence){
    const root = document.documentElement;
    root.dataset.ezPixelApplied = applied ? 'true' : 'false';
    if(reason) root.dataset.ezPixelFallbackReason = reason;
    else delete root.dataset.ezPixelFallbackReason;
    // 미적용이면 신뢰도도 지운다. 남겨 두면 직전 분석 값이 이번 결과로 오독된다.
    if(confidence) root.dataset.ezPixelConfidenceMin = String(Math.round(confidence.min*1000)/1000);
    else delete root.dataset.ezPixelConfidenceMin;
  }

  /**
   * KRR 보정 초안의 **치아폭만** 픽셀 모델 결과로 교체한다.
   * 실패·형식 위반 시 입력 초안을 그대로 돌려준다(조용한 열화 금지: analysisMeta에 이유를 남김).
   */
  async function applyPixelLandmarks(draft, img){
    // 런타임이 없으면 즉시 반환하되 DOM 신호는 **반드시 갱신**한다. 갱신하지 않으면
    // 직전 분석의 'true'가 남아 "픽셀 층이 돌았다"고 잘못 읽힌다(실측: A/B 대조군
    // 4/5건이 이전 값을 물고 있었다).
    if(!pixelAvailable() || !draft){
      stampPixelState(false, pixelAvailable() ? '초안 없음' : '픽셀 런타임 없음', null);
      return draft;
    }
    let reason = null;
    try{
      const session = await getPixelSession();
      if(!session) return draft;
      const result = await window.EzPixelLandmarks.detect(session, img, {});
      const teeth = result.toothWidths;
      const inRange = p => p && Number.isFinite(p.x) && Number.isFinite(p.y)
        && p.x >= 0 && p.y >= 0 && p.x < img.width && p.y < img.height;
      const formOk = Array.isArray(teeth) && teeth.length === draft.toothWidths.length
        && teeth.every(w => inRange(w.p1) && inRange(w.p2)
          && Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y) > 2);
      if(!formOk){
        reason = '픽셀 모델 좌표가 형식 검증을 통과하지 못했습니다(개수·범위·길이).';
      }else{
        const widths = teeth.map(w => ({
          p1:{x:Math.round(w.p1.x), y:Math.round(w.p1.y)},
          p2:{x:Math.round(w.p2.x), y:Math.round(w.p2.y)},
        }));
        const out = {
          toothCenters: widths.map(w => ({x:Math.round((w.p1.x+w.p2.x)/2), y:Math.round((w.p1.y+w.p2.y)/2)})),
          ezPoints: draft.ezPoints.map(p => ({x:p.x, y:p.y})),
          toothWidths: widths,
        };
        out.analysisMeta = Object.assign({}, draft.analysisMeta, {
          engineVersion: PIXEL_ENGINE_VERSION,
          source: 'rule-based-auto-draft+krr-residual+pixel-landmark',
          pixelApplied: true,
          pixelWidthBias: 1.0,
          pixelConfidence: {min:result.confidence.min, mean:result.confidence.mean},
          pixelModelSource: pixelModelBytes ? 'manual-file' : 'fetch',
          // 보고 가능한 수치는 5-fold OOF뿐이다(배포 가중치는 384건 전수 학습 = 홀드아웃 없음).
          pixelReportableOofPositionMm: 0.3113,
          warnings: (draft.analysisMeta.warnings || []).concat(
            result.confidence.min < 0.2
              ? ['픽셀 모델 신뢰도가 낮은 치아가 있습니다. 폭선을 눈으로 확인하세요.'] : []),
        });
        out.metrics = calculateMetricsFor(out.ezPoints, out.toothWidths);
        stampPixelState(true, null, result.confidence);
        return out;
      }
    }catch(err){
      console.warn('픽셀 랜드마크 적용 실패:', err);
      reason = '픽셀 모델을 불러오지 못했습니다: ' + (err && err.message ? err.message : err);
    }
    // 폴백. 무엇이 왜 안 됐는지 산출물에 남긴다.
    draft.analysisMeta = Object.assign({}, draft.analysisMeta, {
      pixelApplied: false,
      pixelFallbackReason: reason,
      warnings: (draft.analysisMeta.warnings || []).concat(
        reason ? ['픽셀 랜드마크 미적용(KRR 결과 유지): ' + reason] : []),
    });
    stampPixelState(false, reason, null);
    return draft;
  }
"""

PANEL_ROW = """    <div class="confidence-row" id="pixelModelRow" style="display:none;">
      <span>픽셀 랜드마크 모델</span>
      <span class="confidence-badge" id="pixelModelStatus">확인 중</span>
      <input type="file" id="pixelModelFile" accept=".onnx" style="display:none;">
      <button class="btn" id="pixelModelBtn" type="button" style="padding:4px 8px; font-size:11px;" data-tip="자동 로드가 실패했을 때 pixel_runtime/arch_landmarks.onnx 를 직접 지정합니다. file:// 로 열어도 픽셀 모델은 자동으로 준비되므로 보통 필요하지 않습니다.">모델 파일 지정</button>
    </div>
"""

WIRING = r"""
  // 픽셀 모델 수동 지정 (자동 로드 실패 시 구제 수단)
  (function(){
    const btn = document.getElementById('pixelModelBtn');
    const input = document.getElementById('pixelModelFile');
    if(!btn || !input) return;
    btn.onclick = () => input.click();
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if(!file) return;
      const buffer = await file.arrayBuffer();
      pixelModelBytes = new Uint8Array(buffer);
      pixelSessionPromise = null;
      pixelLoadError = null;
      updatePixelModelUi();
      updateGuide('픽셀 랜드마크 모델을 불러왔습니다(' + Math.round(file.size/1048576) + 'MB). 자동 분석을 다시 실행하세요.');
    };
    updatePixelModelUi();
  })();
"""


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    text = HTML.read_text(encoding="utf-8")
    before = hashlib.sha256(text.encode("utf-8")).hexdigest()
    if "USE_PIXEL_LANDMARKS" in text:
        raise SystemExit("이미 패치됨 — 중복 적용 금지")

    # 1) 런타임 스크립트 태그
    anchor = "<script>\n// === KRR 잔차 보정 모델 데이터 (초안 모드) ==="
    if anchor not in text:
        raise SystemExit("런타임 삽입 지점(KRR 모델 데이터 스크립트)을 찾지 못했다")
    text = text.replace(anchor, RUNTIME_TAGS + anchor, 1)

    # 2) 픽셀 층 함수 — applyKrrCorrection 정의 앞에 넣는다
    anchor2 = "  const USE_KRR = true;"
    if text.count(anchor2) != 1:
        raise SystemExit(f"USE_KRR 앵커 {text.count(anchor2)}회 — 1회여야 한다")
    text = text.replace(anchor2, PIXEL_LAYER + "\n" + anchor2, 1)

    # 3) runAutoAnalysis에서 픽셀 층 호출 (async 문맥이라 await 가능)
    anchor3 = ("      const result=runAutoEngine(image);\n"
               "      if(runId!==analysisRunId||revision!==imageRevision)return;")
    if text.count(anchor3) != 1:
        raise SystemExit(f"runAutoEngine 호출부 앵커 {text.count(anchor3)}회")
    text = text.replace(anchor3, (
        "      const ruleResult=runAutoEngine(image);\n"
        "      if(runId!==analysisRunId||revision!==imageRevision)return;\n"
        "      // 정답 룩업으로 나온 결과는 픽셀 모델로 덮지 않는다(전문가 정답이 상위).\n"
        "      const isTruth=ruleResult.analysisMeta&&ruleResult.analysisMeta.truthMatch;\n"
        "      if(isTruth) stampPixelState(false,'전문가 정답 표시(픽셀 모델 미적용)',null);\n"
        "      else setAutoProgress(70,'픽셀 랜드마크 모델로 치아폭을 다시 잡고 있습니다…');\n"
        "      const result=isTruth?ruleResult:await applyPixelLandmarks(ruleResult,image);\n"
        "      if(runId!==analysisRunId||revision!==imageRevision)return;\n"
        "      validateAutoDraft(result,image);"
    ), 1)

    # 4) 패널 UI 행
    anchor4 = '    <div class="auto-actions">'
    if text.count(anchor4) != 1:
        raise SystemExit(f"auto-actions 앵커 {text.count(anchor4)}회")
    text = text.replace(anchor4, PANEL_ROW + anchor4, 1)

    # 5) 파일 선택 배선 — 자기검사 블록 앞
    anchor5 = "  // 빌드 식별 배지."
    if text.count(anchor5) != 1:
        raise SystemExit(f"빌드 배지 앵커 {text.count(anchor5)}회")
    text = text.replace(anchor5, WIRING + "\n" + anchor5, 1)

    HTML.write_text(text, encoding="utf-8")
    after = hashlib.sha256(text.encode("utf-8")).hexdigest()
    print(f"SHA {before[:16]} -> {after[:16]}")
    for token in ("USE_PIXEL_LANDMARKS", "applyPixelLandmarks", "pixelModelBtn",
                  "pixel_runtime/ort.wasm.min.js", "pixel-landmark/v1"):
        print(f"  {token}: {text.count(token)}회")


if __name__ == "__main__":
    main()
