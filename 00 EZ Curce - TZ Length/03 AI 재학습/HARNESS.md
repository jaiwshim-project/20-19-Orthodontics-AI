# EZ/TZL 의료 ML 6단계 Harness

이 Harness는 전문가 정답과 현재 규칙 엔진의 차이를 재현 가능하게 측정하고, 첫 학습형 잔차 보정 모델을 연구 후보로 검증합니다. 운영 HTML은 읽기만 하며 어떤 단계에서도 수정하지 않습니다.

## 안전 원칙

- 환자 원본 이미지, 환자명, 원본 이미지명, 원본 경로, 개별 좌표는 `harness-run.json`에 기록하지 않습니다.
- 데이터 분할의 최소 단위는 동일 이미지 SHA-256 그룹입니다. 비공개 환자 그룹 ID가 향후 제공되면 그것을 우선해야 합니다.
- 수치 게이트가 모두 통과해도 자동 운영 승격은 허용하지 않습니다. 치과의사 또는 책임자의 명시적 승인과 별도 배포 절차가 필요합니다.
- 게이트 튜너·배포 정책·nested outer-fold 검증 산출물이 없거나, 정책이 불완전하거나, 임상·안전 게이트가 하나라도 실패하면 상태는 `BLOCKED`, 모드는 `research_only`입니다.
- 모든 자동 게이트가 통과한 경우에도 상태는 `AWAITING_HUMAN_APPROVAL`, 모드는 `shadow`입니다.
- 실행 전후 운영 HTML의 SHA-256을 비교하여 변경이 없음을 검증합니다.

## 6단계

1. **Curator** — `build_dataset_index.mjs`로 번호·내장 이미지 해시를 정합하고, 중복·불완전 라벨·매핑 검토 건수와 PHI 배제 상태를 검사합니다.
2. **Miner** — 현재 규칙 엔진 기준선을 재사용하거나 `--refresh-baseline`으로 root 119건과 embedded-only 55건을 다시 분석·병합한 뒤 `evaluate_baseline.mjs`로 오차를 집계합니다.
3. **Architect** — 설정 스키마, 5-fold 그룹 분할 정책, seed, 승격 정책을 검사하고 데이터·기준선·split 입력의 의미론적 digest를 생성합니다.
4. **Trainer** — NumPy RBF Kernel Ridge 잔차 모델을 학습하고, out-of-fold 임상 길이 평가, width/EZ blend·distance gate·실제 pixel-diagonal cap 튜닝, nested outer-fold 검증을 실행합니다.
5. **Critic** — canonical dataset/baseline join 검증, Python↔JavaScript 추론 parity, 정책에 기록된 모델 schema·학습 데이터 digest·모델 파일 SHA-256의 현재 모델 일치 여부, nested 통계·임상 tail·fallback을 종합 판정합니다.
6. **Promoter** — PHI-free 집계 보고서와 실행 manifest를 생성합니다. 이 단계의 “promotion”은 연구 후보 상태 결정일 뿐 운영 HTML 배포가 아닙니다.

각 하위 프로세스는 종료 코드가 0이 아니면 즉시 중단됩니다. `harness-run.json`에는 단계별 실행시간, 하위 단계 이름, 종료 상태와 집계 수치만 남습니다. 원시 stdout, 경로, 사례 ID 또는 좌표는 저장하지 않습니다.

## 실행 방법

현재 산출물을 재사용해 전체 구조·parity·게이트를 빠르게 확인합니다.

```powershell
node .\run_harness.mjs --round 1 --skip-training
```

`--dry-run`은 `--skip-training`과 같은 의미입니다.

```powershell
node .\run_harness.mjs --round 1 --dry-run
```

현재 기준선을 재사용하고 모델을 다시 학습·평가합니다.

```powershell
node .\run_harness.mjs --round 1
```

규칙 엔진 기준선까지 174건 모두 새로 생성한 뒤 학습합니다. 이 옵션은 headless Chrome/Edge를 실행하므로 시간이 더 걸립니다.

```powershell
node .\run_harness.mjs --round 1 --refresh-baseline
```

Python이 PATH에 없으면 Codex 번들 Python을 자동 탐지합니다. 다른 런타임을 사용하려면 명시합니다.

```powershell
node .\run_harness.mjs --round 1 --python "C:\path\to\python.exe"
```

`--round`는 1~5만 허용합니다. 이는 실행·검증 이력을 구분하는 통제 번호입니다. 동일 데이터와 동일 코드로 round 번호만 바꾸어 반복해도 새로운 정보가 생기지 않으므로 정확도가 자동으로 향상되지는 않습니다. 다음 round는 전문가 라벨 정비, 검증된 신규 증례, 모델 또는 안전 정책 변경이 있을 때 실행해야 합니다.

## 산출물과 판정 우선순위

- `harness-run.json` — 최종 승격 판정의 기준 manifest. 집계 전용이며 PHI를 포함하지 않습니다.
- `benchmark.html` — 데이터·기준선·잔차 모델 수치 시각화. 모델의 통계 게이트와 사람 승인 필요성을 보여줍니다.
- `baseline_metrics.json` — 현재 규칙 엔진 기준 오차.
- `residual-metrics.json` — 좌표 단위 5-fold out-of-fold 평가.
- `residual-clinical-metrics.json` — EZL/TZL/차이의 mm 단위 평가.
- `residual-gate-fine-tuning.json` — blend·distance gate·실제 pixel-diagonal cap 미세 튜닝 결과.
- `residual-deployment-policy.json` — 연구 후보의 최종 승인/거부 상태와 결합된 모델 schema·학습 데이터 digest·모델 파일 SHA-256, nested metrics schema·파일 SHA-256.
- `nested-policy-metrics.json` — 각 outer test fold를 정책 선택에서 완전히 제외한 authoritative 검증 결과.

`benchmark.html`의 “수치 게이트 통과”는 잔차 모델 자체의 좌표 통계만 의미할 수 있습니다. 운영 후보의 최종 상태는 임상 길이, parity, correction-cap 안전성 및 정책을 함께 보는 `harness-run.json`의 `promotionStatus`와 `blockedReasons`를 우선합니다.

## 현재 안전 차단 조건

현재 nested outer-fold 검증이 실패하거나, 임상 P95 tail이 악화되거나, 동일 환자의 중복 촬영을 묶을 비공개 patient-level group 정보가 없으면 연구 후보로만 유지됩니다. 정책 파일의 모델 schema·학습 digest·모델 파일 SHA 또는 연결된 nested metrics schema·파일 SHA가 실제 파일과 하나라도 다를 때도 fail-closed로 차단합니다. 이런 상태에서는 기존 운영 HTML의 규칙 엔진을 대체하거나 자동 분석 결과를 치료 결정에 직접 사용해서는 안 됩니다.

현재 Round 1 nested 결과는 엄격한 inner 정책 선택 3/5 fold, width 좌표 MAE 개선 8.46%, EZ 좌표 MAE 개선 11.27%입니다. 앱 스케일 TZL MAE는 3.13% 악화되었고, EZL P95는 0.69 mm, EZL−TZL 차이 P95는 1.10 mm 악화되었습니다. 따라서 좌표 평균 일부 개선만으로는 임상 tail 안전성을 입증하지 못했으며 정책 상태는 `candidate_rejected_nested_validation`, 최종 Harness 상태는 `BLOCKED / research_only`입니다.
