import { afterEach, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { describeChanges } from './audit-details';

describe('describeChanges (audit details)', () => {
  afterEach(() => void i18n.changeLanguage('vi'));

  it('shows readable fields instead of JSON and leaves out internal ids', async () => {
    await i18n.changeLanguage('vi');
    const t = i18n.t.bind(i18n);
    expect(describeChanges({ name: 'Bán hàng', visibility: 'PRIVATE' }, t)).toBe(
      'Tên: Bán hàng · Phạm vi: Riêng tư',
    );
    expect(describeChanges({ from: 'PRIVATE', to: 'ORG' }, t)).toBe('Riêng tư → Cả tổ chức');
    expect(
      describeChanges(
        {
          rows: 1262,
          versionNo: 2,
          versionId: '01a1cae4-9fa9-7b23-ac36-4f3461e3ad47',
          operations: ['deduplicate', 'drop_rows'],
          sourceVersionId: '01a1cadc-f54d-7d84-83b3-93e4d0c14e00',
        },
        t,
      ),
    ).toBe('Số dòng: 1262 · Phiên bản: 2 · Các bước: deduplicate, drop_rows');
    expect(describeChanges({ op: 'created', measure: 'order.revenue' }, t)).toBe(
      'Thao tác: Tạo · Measure: order.revenue',
    );
    expect(describeChanges({ definition: { type: 'not_null', column: 'amount' } }, t)).toBe(
      'Định nghĩa: (Loại: not_null · Cột: amount)',
    );
  });

  it('keeps unknown fields as they are and translates known ones in English', async () => {
    await i18n.changeLanguage('en');
    const t = i18n.t.bind(i18n);
    expect(describeChanges({ phrase: 'doanh số', somethingNew: true }, t)).toBe(
      'Phrase: doanh số · somethingNew: true',
    );
  });
});
