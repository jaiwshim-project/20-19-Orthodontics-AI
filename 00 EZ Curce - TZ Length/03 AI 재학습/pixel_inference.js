/*!
 * 하악 교합면 치아폭 24 키포인트 — 브라우저 추론 (ONNX Runtime Web)
 *
 * ## 왜 브라우저 추론인가
 * 서버 추론이 더 빠르지만 구강 사진을 업로드해야 한다. 브라우저에서 돌리면 환자
 * 사진이 기기를 떠나지 않는다. 모델은 fp16 ONNX 49MB로, 최초 1회만 내려받고
 * 이후 브라우저 캐시를 탄다.
 *
 * ## 전처리는 학습과 바이트 단위로 같아야 한다
 * 어긋나면 좌표가 조용히 틀린다. 학습 쪽(train_pixel_landmarks.py)과 맞춰야 하는 것:
 *   1. 긴 변을 512로 맞추는 **종횡비 유지** 리사이즈 (종횡비를 깨면 치아폭 비율 왜곡)
 *   2. 남는 영역은 **검은색**(0,0,0), 중앙 정렬. 패딩 오프셋은 floor((512-변)/2)
 *   3. RGB, [0,1]로 나눈 뒤 ImageNet mean/std 정규화
 *   4. NCHW 순서
 * 리사이즈 보간은 학습이 PIL BILINEAR, 여기는 canvas drawImage다. 완전히 같지
 * 않지만 512px로 줄이는 단계에서의 차이는 히트맵 격자(4px)보다 훨씬 작다.
 *
 * ## 디코딩은 그래프 밖
 * argmax·soft-argmax는 프레임워크별 동점 처리가 달라 ONNX 그래프에 넣지 않았다.
 * 여기서 파이썬 decode()와 같은 순서로 구현한다:
 *   채널별 argmax -> 3x3 확률 가중 중심 -> 오프셋 채널 보정 -> 둘의 평균 -> x stride
 *
 * ## 반환 좌표계
 * 원본 사진 픽셀 좌표. 패딩·리사이즈를 모두 되돌린 값이므로 그대로 캔버스에 그릴 수 있다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EzPixelLandmarks = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NUM_KEYPOINTS = 24;
  var INPUT_SIZE = 512;
  var STRIDE = 4;
  var MEAN = [0.485, 0.456, 0.406];
  var STD = [0.229, 0.224, 0.225];

  function assertOrt() {
    if (typeof ort === 'undefined' || !ort.InferenceSession) {
      throw new Error('ONNX Runtime Web(ort)이 로드되지 않았습니다');
    }
  }

  /** 이미지를 512x512 정규화 텐서로. 되돌리기용 스케일·패딩을 함께 반환. */
  function preprocess(source, inputSize) {
    var size = inputSize || INPUT_SIZE;
    var width = source.naturalWidth || source.videoWidth || source.width;
    var height = source.naturalHeight || source.videoHeight || source.height;
    if (!width || !height) throw new Error('이미지 크기를 읽을 수 없습니다');

    var scale = size / Math.max(width, height);
    var drawW = Math.round(width * scale);
    var drawH = Math.round(height * scale);
    var padX = Math.floor((size - drawW) / 2);
    var padY = Math.floor((size - drawH) / 2);

    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#000';
    context.fillRect(0, 0, size, size);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, width, height, padX, padY, drawW, drawH);

    var pixels = context.getImageData(0, 0, size, size).data;
    var plane = size * size;
    var tensor = new Float32Array(3 * plane);
    for (var i = 0; i < plane; i += 1) {
      var base = i * 4;
      tensor[i] = (pixels[base] / 255 - MEAN[0]) / STD[0];
      tensor[plane + i] = (pixels[base + 1] / 255 - MEAN[1]) / STD[1];
      tensor[2 * plane + i] = (pixels[base + 2] / 255 - MEAN[2]) / STD[2];
    }
    return {
      tensor: tensor,
      inputSize: size,
      scale: scale,
      padX: padX,
      padY: padY,
      sourceWidth: width,
      sourceHeight: height,
    };
  }

  function sigmoid(value) { return 1 / (1 + Math.exp(-value)); }

  /**
   * 히트맵/오프셋 -> 입력 좌표계 24점. train_pixel_landmarks.decode()와 동일 순서.
   * @returns {{points: number[][], scores: number[]}}
   */
  function decodeHeatmaps(heatmap, offset, dims, stride) {
    var channels = dims[1];
    var height = dims[2];
    var width = dims[3];
    var step = stride || STRIDE;
    var plane = height * width;
    var points = [];
    var scores = [];

    for (var c = 0; c < channels; c += 1) {
      var base = c * plane;
      var bestIndex = 0;
      var bestValue = -Infinity;
      for (var i = 0; i < plane; i += 1) {
        var value = heatmap[base + i];
        if (value > bestValue) { bestValue = value; bestIndex = i; }
      }
      var peakY = Math.floor(bestIndex / width);
      var peakX = bestIndex % width;

      // 3x3 확률 가중 중심 (격자 양자화 완화)
      var sumX = 0;
      var sumY = 0;
      var total = 0;
      for (var dy = -1; dy <= 1; dy += 1) {
        for (var dx = -1; dx <= 1; dx += 1) {
          var gy = Math.min(Math.max(peakY + dy, 0), height - 1);
          var gx = Math.min(Math.max(peakX + dx, 0), width - 1);
          var probability = sigmoid(heatmap[base + gy * width + gx]);
          sumX += probability * (peakX + dx);
          sumY += probability * (peakY + dy);
          total += probability;
        }
      }
      total = total > 1e-6 ? total : 1e-6;
      var softX = sumX / total;
      var softY = sumY / total;

      // 오프셋 보정 (피크 셀의 값)
      var offsetBase = c * 2 * plane + peakY * width + peakX;
      var offX = offset[offsetBase];
      var offY = offset[offsetBase + plane];

      points.push([
        ((softX + (peakX + offX)) * 0.5) * step,
        ((softY + (peakY + offY)) * 0.5) * step,
      ]);
      scores.push(sigmoid(bestValue));
    }
    return { points: points, scores: scores };
  }

  /** 입력 512 좌표 -> 원본 사진 좌표 */
  function toSourceCoords(points, meta) {
    return points.map(function (point) {
      return {
        x: (point[0] - meta.padX) / meta.scale,
        y: (point[1] - meta.padY) / meta.scale,
      };
    });
  }

  /** 24점 -> 치아 12개의 {p1, p2}. 채널 순서가 T01_p1, T01_p2, ... 로 고정돼 있다. */
  function toToothWidths(sourcePoints, scores) {
    var teeth = [];
    for (var t = 0; t < 12; t += 1) {
      teeth.push({
        toothNo: t + 1,
        p1: sourcePoints[2 * t],
        p2: sourcePoints[2 * t + 1],
        // 두 끝점 신뢰도의 최솟값 — 한쪽만 확실해도 선분은 못 믿는다
        confidence: Math.min(scores[2 * t], scores[2 * t + 1]),
      });
    }
    return teeth;
  }

  function createSession(modelUrl, options) {
    assertOrt();
    var settings = options || {};
    return ort.InferenceSession.create(modelUrl, {
      executionProviders: settings.executionProviders || ['wasm'],
      graphOptimizationLevel: 'all',
    });
  }

  /**
   * 사진 1장 -> 치아폭 12선분.
   * @param session ort.InferenceSession
   * @param source  HTMLImageElement | HTMLCanvasElement | ImageBitmap
   */
  function detect(session, source, options) {
    assertOrt();
    var settings = options || {};
    var meta = preprocess(source, settings.inputSize);
    var size = meta.inputSize;
    var feeds = {
      image: new ort.Tensor('float32', meta.tensor, [1, 3, size, size]),
    };
    return session.run(feeds).then(function (results) {
      var heat = results.heatmap;
      var offset = results.offset;
      if (!heat || !offset) throw new Error('모델 출력에 heatmap/offset이 없습니다');
      var decoded = decodeHeatmaps(heat.data, offset.data, heat.dims,
                                   settings.stride || STRIDE);
      var sourcePoints = toSourceCoords(decoded.points, meta);
      var teeth = toToothWidths(sourcePoints, decoded.scores);
      var minScore = decoded.scores.reduce(function (a, b) { return Math.min(a, b); }, 1);
      var meanScore = decoded.scores.reduce(function (a, b) { return a + b; }, 0)
        / decoded.scores.length;
      return {
        toothWidths: teeth,
        keypoints: sourcePoints,
        scores: decoded.scores,
        confidence: { min: minScore, mean: meanScore },
        imageWidth: meta.sourceWidth,
        imageHeight: meta.sourceHeight,
        meta: {
          engineVersion: 'pixel-landmark-heatmap/v1',
          inputSize: size,
          stride: settings.stride || STRIDE,
          numKeypoints: NUM_KEYPOINTS,
        },
      };
    });
  }

  return Object.freeze({
    NUM_KEYPOINTS: NUM_KEYPOINTS,
    INPUT_SIZE: INPUT_SIZE,
    STRIDE: STRIDE,
    createSession: createSession,
    preprocess: preprocess,
    decodeHeatmaps: decodeHeatmaps,
    toSourceCoords: toSourceCoords,
    toToothWidths: toToothWidths,
    detect: detect,
  });
}));
