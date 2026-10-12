import type { RgbaImage } from './png.js';

/**
 * Pluggable image similarity metric. The default is SSIM; perceptual metrics
 * such as CLIP embedding cosine similarity can be supplied by callers that are
 * willing to take on a model dependency.
 */
export interface ImageSimilarityMetric {
  readonly name: string;
  /**
   * Returns a similarity in [0, 1] where 1 means identical. Both images are
   * guaranteed to share the same dimensions when this is called.
   */
  compare(candidate: RgbaImage, reference: RgbaImage): number | Promise<number>;
}

/**
 * Converts RGBA pixels to Rec. 601 luma, compositing transparent pixels over
 * white so that an empty render never matches a dark reference by accident.
 */
export function toLuma(image: RgbaImage): Float64Array {
  const { width, height, data } = image;
  const luma = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const alpha = data[o + 3]! / 255;
    const r = data[o]! * alpha + 255 * (1 - alpha);
    const g = data[o + 1]! * alpha + 255 * (1 - alpha);
    const b = data[o + 2]! * alpha + 255 * (1 - alpha);
    luma[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return luma;
}

/**
 * Bilinearly resamples an RGBA image to the requested dimensions.
 *
 * @throws Error when either target dimension is not a positive integer.
 */
export function resizeRgba(image: RgbaImage, width: number, height: number): RgbaImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`resizeRgba: target size must be positive integers (got ${width}x${height}).`);
  }
  if (image.width === width && image.height === height) {
    return image;
  }
  const out = new Uint8Array(width * height * 4);
  const xRatio = image.width / width;
  const yRatio = image.height / height;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, Math.max(0, (y + 0.5) * yRatio - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.max(0, (x + 0.5) * xRatio - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const fx = sx - x0;
      for (let c = 0; c < 4; c++) {
        const p00 = image.data[(y0 * image.width + x0) * 4 + c]!;
        const p10 = image.data[(y0 * image.width + x1) * 4 + c]!;
        const p01 = image.data[(y1 * image.width + x0) * 4 + c]!;
        const p11 = image.data[(y1 * image.width + x1) * 4 + c]!;
        const top = p00 + (p10 - p00) * fx;
        const bottom = p01 + (p11 - p01) * fx;
        out[(y * width + x) * 4 + c] = Math.round(top + (bottom - top) * fy);
      }
    }
  }
  return { width, height, data: out };
}

/**
 * Options for the SSIM computation.
 */
export interface SsimOptions {
  /** Side length of the square comparison window in pixels (default 8). */
  windowSize?: number;
  /** Step between window origins in pixels (default windowSize / 2). */
  stride?: number;
}

/**
 * Mean Structural Similarity Index (Wang et al., 2004) over luma, computed on
 * a sliding square window with the standard stabilising constants
 * C1 = (0.01 * 255)^2 and C2 = (0.03 * 255)^2.
 *
 * @returns similarity in [-1, 1]; 1 for identical images.
 * @throws Error when the images differ in size.
 */
export function computeSsim(a: RgbaImage, b: RgbaImage, options: SsimOptions = {}): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `computeSsim: images must share dimensions (got ${a.width}x${a.height} and ${b.width}x${b.height}).`
    );
  }
  const { width, height } = a;
  const windowSize = Math.max(1, Math.min(options.windowSize ?? 8, width, height));
  const stride = Math.max(1, options.stride ?? Math.floor(windowSize / 2));
  const la = toLuma(a);
  const lb = toLuma(b);
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const n = windowSize * windowSize;

  let total = 0;
  let windows = 0;
  for (let y = 0; y + windowSize <= height; y += stride) {
    for (let x = 0; x + windowSize <= width; x += stride) {
      let sumA = 0;
      let sumB = 0;
      let sumAA = 0;
      let sumBB = 0;
      let sumAB = 0;
      for (let wy = 0; wy < windowSize; wy++) {
        const row = (y + wy) * width + x;
        for (let wx = 0; wx < windowSize; wx++) {
          const va = la[row + wx]!;
          const vb = lb[row + wx]!;
          sumA += va;
          sumB += vb;
          sumAA += va * va;
          sumBB += vb * vb;
          sumAB += va * vb;
        }
      }
      const meanA = sumA / n;
      const meanB = sumB / n;
      const varA = sumAA / n - meanA * meanA;
      const varB = sumBB / n - meanB * meanB;
      const cov = sumAB / n - meanA * meanB;
      total +=
        ((2 * meanA * meanB + c1) * (2 * cov + c2)) /
        ((meanA * meanA + meanB * meanB + c1) * (varA + varB + c2));
      windows++;
    }
  }
  return windows === 0 ? 1 : total / windows;
}

/**
 * Default metric: SSIM clamped to [0, 1].
 */
export const ssimMetric: ImageSimilarityMetric = {
  name: 'ssim',
  compare(candidate, reference) {
    return Math.max(0, Math.min(1, computeSsim(candidate, reference)));
  },
};
