import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/data/commandClient', () => ({
  fetchObject: vi.fn(), fetchRawObject: vi.fn(), fetchRows: vi.fn(), queryString: vi.fn(), revisionOf: vi.fn(),
  postCommand: vi.fn(async () => ({ committed: true })),
}));
import { postCommand } from '../src/data/commandClient';
import { addListingLine } from '../src/data/listingApi';

beforeEach(() => vi.clearAllMocks());
describe('外购清单可选设备的HTTP载荷', () => {
  it.each(['', '   ', undefined])('空选择归一为null（%s），不产生非法空串ID', async (equipmentRef) => {
    await addListingLine({ workOrderId: 'wo', kind: 'equipment', equipmentRef, name: '泵', requiredQty: 1 });
    expect(postCommand).toHaveBeenCalledWith('/listing/imports', 'listing.import.v1', expect.objectContaining({ equipmentRef: null, kind: 'equipment' }));
  });
  it('有效自制设备ID保留，必填规则仍交给服务端与表单', async () => {
    await addListingLine({ workOrderId: 'wo', kind: 'part', equipmentRef: 'eq-real', name: '件', requiredQty: 1 });
    expect(postCommand).toHaveBeenCalledWith('/listing/imports', 'listing.import.v1', expect.objectContaining({ equipmentRef: 'eq-real', kind: 'part' }));
  });
});
