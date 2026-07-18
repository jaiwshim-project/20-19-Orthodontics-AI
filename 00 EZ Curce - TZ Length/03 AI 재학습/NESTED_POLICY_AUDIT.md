# 배포정책 Nested 검증 독립 감사

## 결론

현재 residual 보정 모델과 배포정책은 운영 승격 조건을 통과하지 못했다. 연구·shadow 모드로만 유지해야 하며 production HTML에는 연결하지 않는다.

## 발견된 선택 편향

`train_residual.py`의 KRR hyperparameter 평가는 각 outer fold의 학습부에서 inner CV로 선택하므로 KRR 좌표 보정 자체의 OOF 평가는 nested 구조다. 그러나 후속 `tune_residual_blend.py`와 `tune_residual_gate.py`는 다음 작업을 동일한 전체 OOF 예측에서 수행한다.

1. blend와 distance-gate 후보를 비교한다.
2. 가장 좋은 후보를 선택한다.
3. 같은 전체 OOF에서 선택된 후보의 성능을 배포정책 성능으로 보고한다.

각 샘플의 KRR 예측은 OOF여도, 정책이 그 OOF 정답 전체를 보고 선택되므로 보고된 정책 성능에는 post-selection optimism이 남는다. 따라서 기존 전체 OOF tuning 결과는 후보 생성용이며 독립 승격 근거가 아니다.

## 누출 없는 평가 설계

`validate_deployment_policy_nested.py`는 다음 프로토콜을 구현한다.

- width와 EZ에 공통인 이미지/환자 그룹 outer 5-fold를 한 번만 만든다.
- 각 outer fold의 학습 그룹 안에서 공통 inner 4-fold를 새로 만든다.
- KRR gamma/lambda를 outer-train 내부에서만 선택한다.
- 사전에 정한 coarse blend/gate grid 750개를 outer-train 내부 OOF에서만 비교한다.
- 엄격한 inner 후보가 없으면 해당 outer fold는 rule-engine baseline으로 폴백한다.
- 선택된 KRR와 정책을 한 번만 outer-test에 적용한다.
- 모든 landmark correction은 blend 전에 실제 픽셀 대각선의 5% 이내로 제한한다.
- width/EZ 좌표와 paired EZL·TZL·차이값을 reference scale과 application scale로 집계한다.
- case 단위 paired bootstrap 5,000회로 MAE 개선량의 95% 구간을 함께 보고한다.
- 출력에는 환자명, case ID, 해시, 경로, 좌표 또는 이미지 픽셀이 포함되지 않는다.

fine grid는 전체 OOF coarse 결과를 본 뒤 중심 범위를 정했으므로 이 독립 감사에는 사용하지 않았다.

## 실제 외부 fold 결과

- 엄격 inner 정책 선택: 5개 fold 중 3개
- 안전 baseline 폴백: 5개 fold 중 2개
- paired clinical cases: 52
- width coordinate MAE: `0.038074 → 0.034852`, 8.46% 개선, 3/5 fold 개선
- EZ coordinate MAE: `0.042688 → 0.037875`, 11.27% 개선, 3/5 fold 개선
- 두 좌표 p95는 개선됐지만, 사전 기준인 10% 이상 및 4/5 fold 개선을 두 task가 모두 만족하지 못했다.
- application-scale EZL MAE: `4.753 → 4.660 mm`, 1.97% 개선; p95는 `+0.691 mm` 악화
- application-scale TZL MAE: `4.599 → 4.743 mm`, 3.13% 악화
- application-scale EZL−TZL MAE: `4.642 → 4.482 mm`, 3.45% 개선; p95는 `+1.101 mm` 악화
- app-scale 세 MAE 개선량의 bootstrap 95% 구간은 모두 0을 포함했다.

최종 판정은 `do_not_promote_research_only`다.

## 검증 상태

- Python syntax/bytecode compile 통과
- 동일 seed 전체 재실행 결과 SHA-256 완전 일치
- 결과 JSON 개인정보/경로/해시/좌표 패턴 검사 통과
- production HTML 수정 없음

