import type { AttachmentStore, ObjectStoragePort } from '@smes/application';
import type { TenantId } from '@smes/business-core';
import { DrawingNotFoundError } from '@smes/drawing';

export interface DrawingPdfContentReader {
  read(tenant: TenantId, drawingId: string, fileRef: string): Promise<Uint8Array>;
}

/** Resolve only tenant-local attachments associated with this drawing; never fetch a fileRef URL. */
export function drawingPdfContentReader(
  store: AttachmentStore,
  objects: ObjectStoragePort,
): DrawingPdfContentReader {
  return {
    async read(tenant, drawingId, fileRef) {
      const unavailable = () => new DrawingNotFoundError('此修订未关联可读取的 PDF 文件');
      if (!fileRef.startsWith('attachment:')) throw unavailable();
      const id = fileRef.slice('attachment:'.length);
      const record = await store.findById(tenant, id);
      if (record === null || record.deletedAt !== null || record.bizId !== drawingId ||
          record.bizType !== 'drawing-pdf' || record.contentType !== 'application/pdf') throw unavailable();
      const reference = await objects.issueReadReference(tenant, {
        storageKind: record.storageKind, target: record.target, objectKey: record.objectKey,
      }, { ttlSeconds: 60 });
      const token = reference.url.split('/').at(-1)!;
      const content = await objects.resolveReadReference(tenant, token);
      if (content === null) throw unavailable();
      if (Buffer.from(content.bytes.subarray(0, 5)).toString('ascii') !== '%PDF-') throw unavailable();
      return content.bytes;
    },
  };
}
