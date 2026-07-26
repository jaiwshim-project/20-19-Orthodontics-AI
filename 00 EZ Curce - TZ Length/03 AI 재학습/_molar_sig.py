# 어금니 개선 +2.4%가 통계적으로 유의한지: 케이스 단위 짝지은 부트스트랩 + 부호검정.
# 난수는 고정 시드로 재현 가능하게 한다.
import json, math, numpy as np
d = json.load(open("_molar_paired.json", encoding="utf-8"))
a, b = np.array(d["old"]), np.array(d["new"])
diff = a - b                        # +면 신모델이 더 정확
n = len(diff)
rng = np.random.default_rng(20260726)
boot = np.array([diff[rng.integers(0, n, n)].mean() for _ in range(20000)])
lo, hi = np.quantile(boot, [0.025, 0.975])
wins = int((diff > 0).sum())
# 부호검정 p (양측, 정규근사)
p_sign = 2 * (1 - 0.5 * (1 + math.erf(abs(wins - n / 2) / (np.sqrt(n) / 2) / np.sqrt(2))))
print(f"케이스 {n} | 신모델 승 {wins} / 패 {n-wins}  (부호검정 p={p_sign:.3f})")
print(f"평균차 {diff.mean():+.5f}  95%CI [{lo:+.5f}, {hi:+.5f}]  -> {'유의' if lo>0 else '유의하지 않음(0 포함)'}")
print(f"상대개선 {diff.mean()/a.mean()*100:+.1f}%  CI [{lo/a.mean()*100:+.1f}%, {hi/a.mean()*100:+.1f}%]")
