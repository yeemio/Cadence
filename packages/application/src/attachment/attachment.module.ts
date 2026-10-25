/**
 * AttachmentModule —— 附件中心模块（U3 A13 文件管理，core 基础层定位）。
 *
 * 存储端口注入点与 NotificationsModule 同一模式：组合根注入 PG 元数据实现
 * （business-store `./attachment`，子路径导出登记归合流），缺省回落内存实现
 * （零 DB boot 语义完整）。ObjectStoragePort 同为注入点：缺省 = 内存适配器
 * （重启即失）；本地文件适配器（LocalFileSystemObjectStorage）由组合根显式
 * 注入——部署期换装 MinIO/S3 适配器不动业务面（合同硬边界：本波零对象存储
 * 运行时依赖）。TenantContext 由 CoreModule（global）导出注入。消费方接线
 * （工作令/采购合同/送货单/报工挂附件）归后续波。
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { InMemoryAttachmentStore } from './in-memory-attachment-stores.js';
import { InMemoryObjectStorage } from './in-memory-object-storage.js';
import { AttachmentController } from './attachment.controllers.js';
import { AttachmentService, type AttachmentServiceOptions } from './attachment.service.js';
import type { AttachmentStore } from './attachment-stores.js';
import type { ObjectStoragePort } from './attachment-ports.js';

export const ATTACHMENT_STORE = Symbol('smes.attachment.store');
export const OBJECT_STORAGE = Symbol('smes.attachment.objectStorage');

export interface AttachmentModuleOptions {
  /** 附件元数据存储；缺省 = 内存实现（重启即失）。显式 undefined 同缺省。 */
  readonly attachmentStore?: AttachmentStore | undefined;
  /** 对象存储端口；缺省 = 内存适配器（字节重启即失）。 */
  readonly objectStorage?: ObjectStoragePort | undefined;
  /** 服务选项（下载引用 TTL、时钟注入）。 */
  readonly serviceOptions?: AttachmentServiceOptions | undefined;
}

@Module({})
export class AttachmentModule {
  static register(options: AttachmentModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      {
        provide: ATTACHMENT_STORE,
        useValue: options.attachmentStore ?? new InMemoryAttachmentStore(),
      },
      {
        provide: OBJECT_STORAGE,
        useValue: options.objectStorage ?? new InMemoryObjectStorage(),
      },
      {
        provide: AttachmentService,
        useFactory: (
          store: AttachmentStore,
          objectStorage: ObjectStoragePort,
        ) => new AttachmentService(store, objectStorage, options.serviceOptions ?? {}),
        inject: [ATTACHMENT_STORE, OBJECT_STORAGE],
      },
    ];

    return {
      module: AttachmentModule,
      controllers: [AttachmentController],
      providers,
      exports: [AttachmentService],
    };
  }
}
