# EZ Curve · TZL 재학습 시스템

## 현재 판정

**운영 승격 보류 · 연구 전용**

이 폴더에는 전문가 정답 자료와 현재 자동 분석 엔진을 반복 비교하고,
학습 모델을 훈련·검증하는 파이프라인이 들어 있습니다. 최종 중첩
5-fold 검증에서 임상 길이 지표의 안정성이 확인되지 않았으므로
`EZ Curve - TZ Length.html`에는 학습 모델을 연결하지 않았습니다.

- 운영 HTML 수정: **없음**
- 기존 규칙 엔진 전체 실행: 174/174 성공
- 학습 후보: 좌표 평균오차는 감소했으나 최종 임상 승격 기준 실패
- 배포 정책: `do_not_promote_research_only`

## 데이터 감사 결과

- 번호 원본 이미지: 119건 (`001~119`, 누락 없음)
- 치아 폭 전문가 MD: 70건
- EZ 전문가 MD: 114건
- 확정 root-backed EZ 이미지: 58건
- root에 없는 고유 EZ 내장 이미지: 55건
- canonical 사례: 174건
- 완전한 12치아 폭 정답: 58건
- 사용 가능한 고유 EZ 정답 사례: 113건
- 완전 폭+EZ 임상 길이 비교: 52건

번호와 내장 이미지 SHA-256가 일치한 자료만 결합했습니다. root와 해시가
일치하지 않는 EZ 55건은 억지로 번호 매칭하지 않고 독립 사례로
보존했습니다. `3278.md` 계열 두 자료는 같은 이미지의 서로 다른 전문가
EZ 버전으로 보존하고 consensus 처리했습니다.

생성 데이터와 보고서에는 MD의 `imageName`, 환자명, 원본 MD 파일명·경로,
저장 시각을 넣지 않습니다. 학습 분할의 최소 그룹은 정확한 이미지
SHA-256입니다. 실제 환자 단위 식별자가 없으므로 동일 환자의 다른 촬영이
서로 다른 fold에 들어갈 가능성은 남아 있습니다.

## 기준 엔진 성능

전문가 좌표와 현재 규칙 엔진을 구조화된 좌표로 직접 비교했습니다.

| 항목 | 현재 기준선 |
|---|---:|
| 치아 폭 끝점 평균오차 | 이미지 대각선의 4.388% |
| EZ 대칭 평균 곡선오차 | 이미지 대각선의 1.808% |
| 앱 EZL MAE | 4.67 mm |
| 앱 TZL MAE | 4.60 mm |
| 앱 `EZL - TZL` MAE | 4.66 mm |

기존 confidence와 실제 오차의 상관은 거의 없었습니다(폭 Spearman
`+0.058`, EZ `-0.043`). 따라서 현재 confidence 숫자만으로 결과 정확도를
판단하면 안 됩니다.

## 학습 라운드 결과

### Round 1 · 좌표 잔차 학습

NumPy 기반 RBF Kernel Ridge 모델이 현재 규칙 엔진 좌표에서 전문가 정답
좌표로의 잔차를 학습합니다. KRR hyperparameter는 outer test를 제외한
inner fold에서 선택했습니다.

- 폭 좌표 MAE: 22.15% 개선
- EZ 좌표 MAE: 37.77% 개선
- 양쪽 모두 5/5 fold 좌표 개선

그러나 임상 길이에서 TZL 개선이 작고 일부 P95가 악화되어 이 결과만으로
승격하지 않았습니다.

### Round 2 · 실제 대각선 cap + 보수적 fallback

실제 픽셀 대각선의 5%로 보정량을 제한하고, 학습 사례와 거리가 먼 입력은
기존 규칙 엔진으로 되돌리는 정책을 탐색했습니다. 전체 OOF를 본 뒤 고른
fine-grid 후보는 모든 연구 지표를 통과했지만, 이는 같은 OOF에서 정책을
선택하고 평가한 post-hoc 결과이므로 운영 근거로 사용하지 않습니다.

### 최종 독립 중첩 검증

공통 outer 5-fold의 정답을 숨기고, 각 outer-train 내부에서 KRR와 정책을
다시 선택한 뒤 outer-test에 한 번만 적용했습니다.

| 지표 | 기준선 → 후보 | 판정 |
|---|---:|---|
| 폭 coordinate MAE | 0.038074 → 0.034852 (8.46% 개선) | 10% 기준 실패 |
| EZ coordinate MAE | 0.042688 → 0.037875 (11.27% 개선) | fold 3/5로 실패 |
| 앱 EZL MAE | 4.753 → 4.660 mm | 소폭 개선, P95 악화 |
| 앱 TZL MAE | 4.599 → 4.743 mm | 3.13% 악화 |
| 앱 차이값 MAE | 4.642 → 4.482 mm | 소폭 개선, P95 악화 |

최종 판정은 `do_not_promote_research_only`입니다.

## 주요 실행 순서

PowerShell에서 이 폴더로 이동한 뒤 실행합니다. Python 경로는 환경에 맞게
지정할 수 있습니다.

```powershell
node .\build_dataset_index.mjs --output .\dataset-index.json
node .\run_rule_baseline.js
node .\run_rule_baseline.js --source=ez-embedded-only --output=.\baseline_ez_embedded_predictions.json --csv=.\baseline_ez_embedded_predictions.csv
node .\merge_baselines.js
node .\evaluate_baseline.mjs
python .\train_residual.py --dataset-index .\dataset-index.json --baseline-predictions .\baseline_predictions_all.json --output-dir .
python .\validate_deployment_policy_nested.py --dataset-index .\dataset-index.json --baseline-predictions .\baseline_predictions_all.json --output .\nested-policy-metrics.json
node .\verify_pipeline.mjs
node .\test_residual_inference.js
node .\generate_benchmark_report.mjs
```

전체 6단계 harness는 다음처럼 실행합니다.

```powershell
node .\run_harness.mjs --round=1
```

원본 이미지부터 기준 엔진을 다시 실행하려면 `--refresh-baseline`을
추가합니다. 사람 승인과 모든 승격 게이트가 충족되지 않으면 harness는
항상 연구 모드로 종료하며 운영 HTML을 수정하지 않습니다.

## 핵심 파일

- `dataset-index.json`: PHI를 제외한 canonical 전문가 좌표 데이터
- `baseline_predictions_all.json`: 현 규칙 엔진 174건 결과
- `baseline_metrics.json`: 기준선 상세 오차
- `residual-model.json`: 연구용 학습 모델 파라미터
- `residual-deployment-policy.json`: post-hoc 연구 후보 정책
- `nested-policy-metrics.json`: 최종 authoritative 승격 판정
- `benchmark.html`: 사람이 읽는 종합 보고서
- `run_harness.mjs`: 6단계 반복 파이프라인
- `verify_pipeline.mjs`: 데이터·좌표·PHI·조인·모델 구조 검사
- `residual_inference.js`: 브라우저/Node 공용 추론 구현

## 다음 학습에서 필요한 것

같은 52건을 더 세밀하게 반복 튜닝하는 것은 과적합 위험만 높입니다.
다음 라운드는 아래 조건으로 진행해야 합니다.

1. 현재 52건을 정책 선택용과 **완전히 잠근 외부 환자 테스트셋**으로 분리
2. 9~11개만 찍힌 폭 정답 12건을 전문가가 완성하거나 결측 치아 번호를 명시
3. root에 없는 EZ 55건과 짝이 되는 폭 정답을 추가 확보
4. 서로 다른 환자의 완전한 폭+EZ 정답을 우선 30~50건 이상 추가
5. 좌표뿐 아니라 `EZL`, `TZL`, `EZL-TZL`을 직접 최적화하는 다중 목적 모델 적용
6. 동일 이미지 반복 라벨로 전문가 자체 변동 범위를 측정

정답 폴더와의 자동 비교는 올바른 기본 방법입니다. 다만 정답 자체의 누락,
잘못된 치아 번호, 스케일 불일치까지 자동으로 진실로 받아들이면 오류를
학습하므로, 품질 플래그가 붙은 자료만 전문가가 선별 검토해야 합니다.

## 의료 안전

이 시스템은 교정 진단 보조 연구 도구입니다. EZL·TZL 또는 두 값의 차이만으로
발치나 치간삭제를 결정해서는 안 됩니다. 의료진이 모든 치아 폭선, EZ점,
스케일과 임상 소견을 확인해야 하며, 독립 환자군 검증과 명시적 사람 승인
전에는 학습 후보를 운영 분석에 사용하지 마십시오.
