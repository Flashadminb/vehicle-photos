import { describe, expect, it } from 'vitest';
import { stepGuide } from '../../src/shared/types';

describe('step aiming frame', () => {
  it('derives from OCR when not set, and an explicit choice wins', () => {
    expect(stepGuide({ ocr: false })).toBeNull();
    expect(stepGuide({ ocr: true, ocrKind: 'plate' })).toBe('plate');
    expect(stepGuide({ ocr: true, ocrKind: 'document' })).toBe('slip');
    expect(stepGuide({ ocr: true, ocrKind: 'document', guide: 'slip_line' })).toBe('slip_line');
    expect(stepGuide({ ocr: true, ocrKind: 'plate', guide: 'none' })).toBeNull();
    expect(stepGuide({ ocr: false, guide: 'slip' })).toBe('slip');
  });
});

describe('per-step photo size', () => {
  it('uses the chosen edge, maps the old "small" to 960, ignores unknown sizes', async () => {
    const { stepImageEdge } = await import('../../src/shared/types');
    expect(stepImageEdge({})).toBeUndefined();
    expect(stepImageEdge({ imageEdge: 800 })).toBe(800);
    expect(stepImageEdge({ imageSize: 'small' })).toBe(960);
    expect(stepImageEdge({ imageEdge: 1234 })).toBeUndefined();
  });
});
