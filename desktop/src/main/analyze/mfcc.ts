// MFCC matching python_speech_features.mfcc(sig, 16000, numcep=13,
// winlen=0.025, winstep=0.010) with library defaults - the exact audio
// feature Light-ASD was trained on. Hand-rolled to match: rectangular
// window, preemph 0.97, 26 mel filters, NFFT 512, DCT-II ('ortho'),
// ceplifter 22, appendEnergy (c0 replaced by log frame energy).

const SR = 16000;
const FRAME_LEN = 400; // round(0.025 * 16000)
const FRAME_STEP = 160; // round(0.010 * 16000)
const NFFT = 512;
const NBINS = NFFT / 2 + 1; // 257
const NFILT = 26;
const NUMCEP = 13;
const PREEMPH = 0.97;
const CEPLIFTER = 22;
const EPS = 2.220446049250313e-16; // numpy finfo(float).eps

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}
function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1);
}

// 26 triangular mel filters over the 257 FFT power bins.
function buildFilterbank(): Float64Array[] {
  const lowMel = hzToMel(0);
  const highMel = hzToMel(SR / 2);
  const bin: number[] = [];
  for (let i = 0; i < NFILT + 2; i++) {
    const mel = lowMel + ((highMel - lowMel) * i) / (NFILT + 1);
    bin.push(Math.floor(((NFFT + 1) * melToHz(mel)) / SR));
  }
  const fb: Float64Array[] = [];
  for (let j = 0; j < NFILT; j++) {
    const f = new Float64Array(NBINS);
    for (let k = bin[j]; k < bin[j + 1]; k++) {
      f[k] = (k - bin[j]) / (bin[j + 1] - bin[j]);
    }
    for (let k = bin[j + 1]; k < bin[j + 2]; k++) {
      f[k] = (bin[j + 2] - k) / (bin[j + 2] - bin[j + 1]);
    }
    fb.push(f);
  }
  return fb;
}
const FILTERBANK = buildFilterbank();

// In-place iterative radix-2 FFT (length must be a power of 2).
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + half] * curRe - im[i + k + half] * curIm;
        const bIm = re[i + k + half] * curIm + im[i + k + half] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + half] = aRe - bRe;
        im[i + k + half] = aIm - bIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

// DCT-II with norm='ortho' (scipy.fftpack.dct convention).
function dctOrtho(x: Float64Array): Float64Array {
  const N = x.length;
  const out = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    let sum = 0;
    for (let n = 0; n < N; n++) {
      sum += x[n] * Math.cos((Math.PI * (2 * n + 1) * k) / (2 * N));
    }
    out[k] = (k === 0 ? Math.sqrt(1 / N) : Math.sqrt(2 / N)) * sum;
  }
  return out;
}

/**
 * Compute MFCC features from a 16 kHz mono signal.
 * Returns one 13-d coefficient vector per ~10 ms frame (100 fps), as a
 * flat Float32Array of shape [numFrames, 13] - the layout Light-ASD's
 * audio input expects.
 */
export function mfcc(signal: Float32Array): {
  data: Float32Array;
  frames: number;
} {
  // Pre-emphasis.
  const sl = signal.length;
  const pre = new Float64Array(sl);
  if (sl > 0) pre[0] = signal[0];
  for (let i = 1; i < sl; i++) {
    pre[i] = signal[i] - PREEMPH * signal[i - 1];
  }

  const numframes =
    sl <= FRAME_LEN ? 1 : 1 + Math.ceil((sl - FRAME_LEN) / FRAME_STEP);
  const data = new Float32Array(numframes * NUMCEP);
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const pow = new Float64Array(NBINS);

  for (let fi = 0; fi < numframes; fi++) {
    re.fill(0);
    im.fill(0);
    const start = fi * FRAME_STEP;
    for (let k = 0; k < FRAME_LEN; k++) {
      const idx = start + k;
      re[k] = idx < sl ? pre[idx] : 0; // rectangular window + zero pad
    }
    fft(re, im);

    let energy = 0;
    for (let k = 0; k < NBINS; k++) {
      pow[k] = (re[k] * re[k] + im[k] * im[k]) / NFFT;
      energy += pow[k];
    }
    if (energy === 0) energy = EPS;

    const logMel = new Float64Array(NFILT);
    for (let j = 0; j < NFILT; j++) {
      const fb = FILTERBANK[j];
      let s = 0;
      for (let k = 0; k < NBINS; k++) s += pow[k] * fb[k];
      logMel[j] = Math.log(s === 0 ? EPS : s);
    }

    const dct = dctOrtho(logMel);
    for (let n = 0; n < NUMCEP; n++) {
      const lift = 1 + (CEPLIFTER / 2) * Math.sin((Math.PI * n) / CEPLIFTER);
      data[fi * NUMCEP + n] = dct[n] * lift;
    }
    // appendEnergy: c0 := log(frame energy).
    data[fi * NUMCEP] = Math.log(energy);
  }

  return { data, frames: numframes };
}
