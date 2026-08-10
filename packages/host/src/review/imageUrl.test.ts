import { describe, expect, it } from 'vitest';
import { resolveReviewImageUrl } from './imageUrl.js';

describe('review image URLs', () => {
  it('routes repository-relative images through the PR capability', () => {
    const resolved = resolveReviewImageUrl(' ../assets/diagram.png ', 'docs/guide/readme.md', '/_marky/image/cap');
    expect(resolved).toBe(
      '/_marky/image/cap?document=docs%2Fguide%2Freadme.md&source=..%2Fassets%2Fdiagram.png',
    );
  });

  it('keeps data and approved GitHub image hosts direct', () => {
    expect(resolveReviewImageUrl('data:image/png;base64,AA==', 'README.md')).toBe('data:image/png;base64,AA==');
    expect(
      resolveReviewImageUrl('https://raw.githubusercontent.com/octo/docs/main/image.png', 'README.md'),
    ).toBe('https://raw.githubusercontent.com/octo/docs/main/image.png');
    expect(
      resolveReviewImageUrl('https://github.com/user-attachments/assets/abc-123', 'README.md'),
    ).toBe('https://github.com/user-attachments/assets/abc-123');
  });

  it.each([
    'https://tracker.example/read-receipt.png',
    '//tracker.example/read-receipt.png',
    'javascript:alert(1)',
    'https://github.com/octo/docs/blob/main/private.png',
  ])('blocks arbitrary external source %s', (source) => {
    expect(resolveReviewImageUrl(source, 'README.md', '/_marky/image/cap')).toBeNull();
  });

  it('blocks a relative image when no capability was issued', () => {
    expect(resolveReviewImageUrl('private.png', 'README.md')).toBeNull();
  });
});
