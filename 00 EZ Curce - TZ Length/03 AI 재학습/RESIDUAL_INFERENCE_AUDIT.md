# Residual KRR inference audit

## Result

`residual_inference.js` is a dependency-free UMD module that runs in Node and a
browser global. It reproduces the Python trainer's preprocessing and inference:

- 12 tooth-width lines → 24 endpoints (48 coordinates)
- EZ curve orientation and arc-length resampling → 12 points (24 coordinates)
- 12 tooth centers, or the 12 width-line midpoints when centers are absent
- `x/imageWidth`, `y/imageHeight` axis normalization
- the exact 169-feature block order in `train_residual.py`
- feature standardization, RBF KRR, unfamiliar-input distance gate
- per-landmark correction clipping, rejected-input baseline fallback, and
  final `[0,1]` coordinate clamp
- conversion of both corrected tasks back to original pixel coordinates

The returned metadata contains the task's `accepted` decision,
`nearestDistance`, fallback flag, model schema version, training-data digest,
gate threshold, and selected cap policy. The production HTML was not modified.

## Cross-language parity

`generate_residual_parity_fixture.py` imports the existing trainer rather than
copying its feature or legacy prediction code. It creates 12 independent
numeric-geometry cases plus one synthetic out-of-distribution gate case. No
case identifiers, paths, patient names, or pixels are written to the fixture.

The Node test covers both width and EZ tasks under both cap policies:

```powershell
python .\ez_training_scratch\generate_residual_parity_fixture.py --cases 12
node --check .\ez_training_scratch\residual_inference.js
node --check .\ez_training_scratch\test_residual_inference.js
node .\ez_training_scratch\test_residual_inference.js
```

Verified result on 2026-07-11:

- 13 inputs: 12 independent geometries + 1 synthetic unfamiliar input
- 78 task evaluations: 13 × 2 tasks × 3 policies
- 12,974 numeric comparisons
- maximum absolute JS–Python difference: `7.048583938740194e-12`
- required tolerance: `1e-9`
- legacy/pixel modes: 23 accepted and 3 fallback decisions each
- deployment policy: 17 accepted and 9 fallback decisions
- both sides of the tightened width and EZ gate boundaries are covered
- CommonJS and browser-global loading both passed

Self-prototype rows are intentionally excluded from the 12 independent cases.
For an exactly identical vector, NumPy's norm-identity matrix calculation can
leave a tiny positive squared distance through cancellation while scalar JS can
produce exact zero. The extra synthetic case verifies the clinically important
gate/fallback behavior without depending on that BLAS representation artifact.

## Correction-cap audit

The current Python code does **not** cap actual pixel movement at 5% of the
image diagonal. It first axis-normalizes coordinates and applies:

```text
sqrt(dx_norm² + dy_norm²) <= 0.05 * sqrt(2)
```

Therefore, the current model field
`maximumPerLandmarkCorrectionDiagonalFraction: 0.05` and the trainer check named
`correctionCapIs5PctDiagonal` overstate what the implementation guarantees.
That check only verifies that the scalar configuration equals `0.05`.

For aspect ratio `a = imageWidth/imageHeight`, an actual pixel-diagonal cap is:

```text
sqrt((dx_norm * a)² + dy_norm²) <= 0.05 * sqrt(a² + 1)
```

The two formulas are equal only for square images. For a `5514 × 3681` image
(`a = 1.4979625`), a correction that reaches the legacy limit corresponds to:

- horizontal movement: 5.8810% of the actual pixel diagonal
- vertical movement: 3.9260% of the actual pixel diagonal

Across the 174 current baseline images (`a = 1.3628…1.6705`), the legacy cap's
directional extremes are:

- horizontal: 5.7009%…6.0671%
- vertical: 3.6319%…4.1833%

The JavaScript module consequently exposes two explicit policies:

- `legacy-axis-normalized` (default): exact parity with the trained Python v1
- `pixel-diagonal`: correct aspect-aware 5% pixel-diagonal clipping

In the parity fixture, the policy choice changed 80 of 468 returned landmarks;
the largest difference was 77.63 pixels. This is a fixture observation, not an
accuracy benchmark. Production should select `pixel-diagonal` explicitly only
after recording the policy change and rerunning held-out clinical metrics.

## Round-2 deployment policy

`residual-deployment-policy.json` applies this exact order:

```text
raw KRR residual → actual pixel-diagonal 5% cap → task blend → baseline addition → [0,1] clamp
```

Width uses blend `0.32` and gate multiplier `0.90`; EZ uses blend `0.42` and
gate multiplier `0.73`. The effective gate is the original model gate multiplied
by the task value. Rejected inputs return the rule-engine baseline.

The policy is bound to the model by schema, training-data digest, and model-file
SHA-256. It is also bound to `nested-policy-metrics.json` by that file's SHA-256.
The authoritative nested validation failed, so the final status is
`candidate_rejected_nested_validation`, its pass value is false, and its
decision is `do_not_promote_research_only`.

The inference module rejects this policy by default. It can only be replayed
for research with `allowResearchPolicy: true`; `allowPendingPolicy` does not
open it. Unknown statuses, schema/digest mismatches, inconsistent nested
metadata, and supplied file-hash mismatches all fail closed.

## API example

Node:

```javascript
const residual = require('./residual_inference.js');
const result = residual.applyResidualModel(modelDocument, ruleEngineDraft, {
  correctionCapPolicy: residual.CAP_POLICIES.PIXEL_DIAGONAL,
});

console.log(result.draft.toothWidths); // original-image pixel coordinates
console.log(result.draft.ezPoints);    // original-image pixel coordinates
console.log(result.metadata.width.accepted, result.metadata.ez.accepted);
```

Rejected Round-2 policy research replay only:

```javascript
const result = residual.applyResidualModel(modelDocument, ruleEngineDraft, {
  deploymentPolicy,
  allowResearchPolicy: true,
  modelFileSha256: '4505ef7c472fa7a9121dd8aec68cda7461e8d56a2d71d60a811e82dbe3896cf9',
  nestedMetricsFileSha256: '121ca28a1ad164590725d63321f7ee00cae80f9b39b0708c9792d32fa3931efd',
});
```

Browser:

```html
<script src="residual_inference.js"></script>
<script>
  const result = EzResidualInference.applyResidualModel(modelDocument, ruleEngineDraft, {
    correctionCapPolicy: EzResidualInference.CAP_POLICIES.PIXEL_DIAGONAL,
  });
</script>
```

## Model audit summary

The reviewed artifact is `ez-tzl-residual-krr/v1`, has 169 features, and contains
58 width-training groups and 113 EZ-training groups. Its earlier same-OOF gate
is true for both tasks, but the later authoritative nested gate is false. The
latter controls: this candidate remains research-only and must not be integrated
into the production HTML.
