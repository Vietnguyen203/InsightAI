import { describe, expect, it } from 'vitest';
import { isValidTimeZone, updateOrganizationRequestSchema } from './organization.js';

describe('time zone validation', () => {
  it('accepts current IANA names that ICU lists under a legacy id', () => {
    expect(isValidTimeZone('Asia/Ho_Chi_Minh')).toBe(true);
    expect(
      updateOrganizationRequestSchema.safeParse({ timezone: 'Asia/Ho_Chi_Minh' }).success,
    ).toBe(true);
  });

  it('rejects unknown zones', () => {
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(
      updateOrganizationRequestSchema.safeParse({ timezone: 'Mars/Olympus_Mons' }).success,
    ).toBe(false);
  });
});
