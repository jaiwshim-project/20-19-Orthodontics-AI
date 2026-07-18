# Current rule-engine batch audit

## Decision

Use a same-origin headless-browser harness that executes the unchanged
`runAutoEngine(image)` from the production HTML. The production script is inside
an IIFE, so the harness adds a one-line function hook only to the in-memory copy
served to the temporary browser. The production file is never edited.

This is preferable to the alternatives for the first benchmark:

1. **Extract to Node:** feasible later, but exact image decoding and Canvas pixel
   behavior require `canvas`/`sharp` plus a refactor of DOM-dependent scale access.
   It creates an avoidable implementation-drift validation burden.
2. **Port to Python:** least suitable for the baseline. The feature-map, template
   search, boundary search, and curve functions are roughly 250 lines and a port
   would no longer prove the behavior of the deployed HTML engine.
3. **Browser fixture loop:** exact deployed calculations, no network or model
   dependency, and fast enough to run the whole dataset repeatedly.

## Verified run

- Numbered root images: 119/119 successful.
- Unique EZ embedded-only images: 55/55 successful.
- Combined: 174/174 successful, zero engine exceptions.
- Every successful draft contains 12 tooth centers, 12 EZ points, and 12 width
  lines.
- Mean engine time: 211.5 ms/image; median 204.9 ms; P95 352.3 ms.
- Confidence range: 0.315–0.711; median 0.626.
- Combined raw JSON size: about 0.98 MB.

The embedded-only records use dataset-index-compatible hash-derived opaque IDs
(`embedded-<16 hex>`) and SHA-256 image refs.
Patient names, source MD names, source paths, and embedded `imageName` values are
not written to baseline outputs.

## Raw output contract

Each result contains:

```text
caseId, sourceType, imageFile/imageRef, status, runtimeMs,
imageWidth, imageHeight, prediction, error
```

`prediction` is the exact engine draft:

```text
toothCenters[12] = {x,y}
ezPoints[12] = {x,y}
toothWidths[12] = {p1:{x,y},p2:{x,y}}
analysisMeta = engineVersion + confidence fields + warnings
metrics = pxPerMm + ezl + tzl + difference
```

Coordinates are original-image pixels, not browser/canvas coordinates.

## Expert-comparison metrics

Comparison must use structured expert coordinates from the MD JSON, not rendered
overlay-pixel differences.

### Tooth width, per labeled tooth number

- Endpoint error after choosing the lower-cost direct/swapped endpoint pairing.
- Line-center Euclidean error.
- Absolute orientation error modulo 180 degrees.
- Width-length signed error, absolute error, and percentage error.
- TZL signed error and absolute error only when a verified shared scale exists.

### EZ curve

- Reverse expert point order when that minimizes the two endpoint correspondence
  costs.
- If expert point count is exactly 12 and semantics match: per-index point error.
- For all usable counts: resample expert and predicted curves to 200 equidistant
  arc-length samples, then report symmetric mean curve distance, symmetric P95
  distance, HD95, and endpoint error.
- EZL signed/absolute error using one expert-derived scale for both curves.

### Aggregation

- MAE, RMSE, median, P90, P95, maximum, and signed bias.
- Per-tooth-number metrics as well as macro and micro totals.
- Detection/validation failure rate and incomplete-label count.
- Confidence-to-error calibration (rank correlation and error by confidence
  quartile), because current confidence should not be assumed calibrated.
- Overlay PNG for each case and an error-sorted HTML report.

## Scale and matching safeguards

- Direct coordinate comparison is allowed only for exact image SHA-256 and equal
  dimensions, or for an explicitly verified coordinate transform.
- For fair EZL/TZL comparison, use the expert reference scale for both prediction
  and expert geometry. Letting each curve derive its own endpoint scale can hide
  endpoint-location error.
- Width-only cases without a matching verified EZ/reference scale should report
  pixels and image-diagonal-normalized error, not claim millimeters.
- Partial expert labels remain usable tooth-by-tooth but must not be treated as a
  complete 12-tooth TZL reference.
- Train/validation/test splits must be grouped by source-image SHA-256 (and patient
  group where known) so duplicate or derivative images cannot cross splits.

## Files

- `run_rule_baseline.js`: repeatable baseline runner.
- `merge_baselines.js`: combines root and embedded-only outputs.
- `baseline_predictions.json/.csv`: 119 numbered-root predictions.
- `baseline_ez_embedded_predictions.json/.csv`: 55 embedded-only predictions.
- `baseline_predictions_all.json/.csv`: combined 174-case trainer input.
