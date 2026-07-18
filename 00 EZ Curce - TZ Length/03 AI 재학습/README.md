# EZ rule-engine baseline runner

This scratch harness batch-runs the **unchanged** `runAutoEngine()` function from
`EZ Curve - TZ Length.html` against the numbered root images. It does not edit
the production HTML.

## Quick verification (one image)

```powershell
node .\ez_training_scratch\run_rule_baseline.js --limit=1
```

## Full 119-image baseline

```powershell
node .\ez_training_scratch\run_rule_baseline.js
```

## EZ annotation images not present in the numbered root set

This mode matches by exact embedded-image SHA-256, deduplicates identical
embedded images, and emits dataset-index-compatible hash-derived
`embedded-xxxxxxxxxxxxxxxx` IDs plus hashes (no patient names or
annotation filenames):

```powershell
node .\ez_training_scratch\run_rule_baseline.js --source=ez-embedded-only `
  --output=.\ez_training_scratch\baseline_ez_embedded_predictions.json `
  --csv=.\ez_training_scratch\baseline_ez_embedded_predictions.csv
```

Outputs:

- `baseline_predictions.json`: complete point/line predictions, confidence,
  warnings, and TZL/EZL metrics for each case.
- `baseline_predictions.csv`: one-row-per-case summary for sorting and QA.

After generating both root and embedded-only baselines, merge them into one
174-case trainer input:

```powershell
node .\ez_training_scratch\merge_baselines.js
```

This creates `baseline_predictions_all.json` and
`baseline_predictions_all.csv`.

Useful options:

```text
--from=21
--limit=10
--source=root
--source=ez-embedded-only
--output=C:\path\predictions.json
--csv=C:\path\predictions.csv
--headed
```

Chrome or Edge must be installed. The runner starts a loopback-only HTTP server,
opens a temporary browser profile, and stops both after the result is received.

## Learned residual inference

The first trainable hybrid model is emitted as `residual-model.json` by
`train_residual.py`. Browser/Node inference and its Python parity harness are:

- `residual_inference.js`
- `generate_residual_parity_fixture.py`
- `residual-parity-fixture.json`
- `test_residual_inference.js`
- `RESIDUAL_INFERENCE_AUDIT.md`

Run the parity check:

```powershell
python .\ez_training_scratch\generate_residual_parity_fixture.py --cases 12
node .\ez_training_scratch\test_residual_inference.js
```

The JavaScript inference default is `legacy-axis-normalized`, which exactly
matches `train_residual.py`. The separately tested `pixel-diagonal` policy is the
aspect-aware policy intended for a future versioned production integration.
See the audit before changing the production policy.

The Round-2 `residual-deployment-policy.json` is finalized as
`candidate_rejected_nested_validation` after the authoritative nested gate
failed. `residual_inference.js` refuses it unless a research caller explicitly
sets `allowResearchPolicy: true`; it is not authorized for production HTML.
