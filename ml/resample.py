"""Windowed-sinc resampler: exact mirror of app/src/guardian/audio/resampler.js.

Output sample n sits at input position p = n * in_rate / out_rate.
  y[n] = sum_k x[k] * h(p - k),  k in [ceil(p - L), floor(p + L)],  x[k] = 0 for k < 0
  h(t) = fc * sinc(fc * t) * hann(t / L),  fc = 0.9 * min(1, out/in),  L = ZEROS / fc
Outputs are produced only while floor(p + L) < len(x) (same as the streaming JS version).
Keep the two in sync!
"""
import math

import numpy as np

TARGET_RATE = 16000
ZEROS = 8


def resample(x: np.ndarray, in_rate: int, out_rate: int = TARGET_RATE, chunk: int = 16000) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    if in_rate == out_rate:
        return x.astype(np.float32)
    fc = 0.9 * min(1.0, out_rate / in_rate)
    L = ZEROS / fc
    total = len(x)
    # largest n with floor(n*in/out + L) < total
    n_out = 0
    while math.floor((n_out * in_rate) / out_rate + L) < total:  # cheap upper-bound search below
        n_out = max(n_out * 2, 1)
    lo, hi = n_out // 2, n_out
    while lo < hi:
        mid = (lo + hi) // 2
        if math.floor((mid * in_rate) / out_rate + L) < total:
            lo = mid + 1
        else:
            hi = mid
    n_out = lo
    width = int(math.floor(2 * L)) + 2
    out = np.empty(n_out, dtype=np.float64)
    for start in range(0, n_out, chunk):
        n = np.arange(start, min(start + chunk, n_out), dtype=np.float64)
        p = (n * in_rate) / out_rate
        k0 = np.ceil(p - L)
        k = k0[:, None] + np.arange(width)[None, :]
        t = p[:, None] - k
        valid = (k >= 0) & (k < total) & (np.abs(t) < L) & (k <= np.floor(p + L)[:, None])
        xt = fc * t
        with np.errstate(invalid="ignore", divide="ignore"):
            sinc = np.where(xt == 0, 1.0, np.sin(np.pi * xt) / (np.pi * xt))
        h = fc * sinc * 0.5 * (1 + np.cos(np.pi * t / L))
        xk = x[np.clip(k, 0, total - 1).astype(np.int64)]
        out[start : start + len(n)] = np.sum(np.where(valid, xk * h, 0.0), axis=1)
    return out.astype(np.float32)
