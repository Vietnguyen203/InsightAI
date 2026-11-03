import { describe, expect, it } from 'vitest';
import { slugify } from './organization.service';

describe('slugify', () => {
  it('strips Vietnamese diacritics and adds a random suffix', () => {
    expect(slugify('Công ty TNHH Đại Phát')).toMatch(/^cong-ty-tnhh-dai-phat-[a-z0-9]{4}$/);
  });

  it('falls back to "org" for names without latin characters', () => {
    expect(slugify('!!!')).toMatch(/^org-[a-z0-9]{4}$/);
  });

  it('limits length', () => {
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(45);
  });
});
