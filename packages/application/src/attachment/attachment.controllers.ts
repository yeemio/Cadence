/**
 * 附件中心路由（U3 A13）。控制器零逻辑：身份一律取 AuthGuard 写入的
 * REQUEST_USER_KEY，租户取 TenantContext（ALS）——身份与租户都不从请求体/
 * 查询串进（ADR-0005）。命令体解析在用例层（service），查询串解析在输入层
 * （attachment-input，同 issue 控制器分工）。
 *
 * 权限码（ADR-0010 通用词；文档二 接口面映射）：
 *   POST /attachment/upload             attachment:write（字节经端口 put——Cadence 增量）
 *   POST /attachment/save               attachment:write（文档二.2）
 *   POST /attachment/save-batch         attachment:write（文档二.3）
 *   GET  /attachment/list-by-biz-id     attachment:read （文档二.1 ?bizId=）
 *   POST /attachment/remove             attachment:write（文档二.4 {ids:"a,b"}）
 *   GET  /attachment/download-reference attachment:read （文档二.5 ?id=&bizId=&downloadName=）
 *   GET  /attachment/storage/:token     无权限码——短时签名 token 即能力凭证
 *                                       （零基建适配器的开门面，等价文档「预签名
 *                                       URL 由对象存储侧直接服务」；登录门在网关/
 *                                       AuthGuard 层，对象级授权即令牌本身）
 *
 * 上传传输取舍（写明）：本波上传体 = JSON { contentBase64 }（零新依赖——
 * multipart/原始 octet-stream 需组合根装 body 解析器，接线归合流；base64 约
 * +33% 传输开销，32 MiB 护栏防打爆内存）。文件本体经端口 put 后由开门面以
 * 字节流回给客户端（StreamableFile），Content-Disposition 按 downloadName。
 */
import { Body, Controller, Get, Param, Post, Query, Req, StreamableFile } from '@nestjs/common';
import { REQUEST_USER_KEY, type AuthenticatedRequest } from '../core/auth/request-user.js';
import { RequirePermission } from '../core/auth/require-permission.decorator.js';
import { TenantContext } from '../core/tenant-context.js';
import {
  parseAttachmentIdParam,
  parseBizIdQuery,
  parseDownloadReferenceQuery,
} from './attachment-input.js';
import type { AttachmentService } from './attachment.service.js';

@Controller('attachment')
export class AttachmentController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly attachments: AttachmentService,
  ) {}

  @Post('upload')
  @RequirePermission('attachment:write')
  async upload(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<AttachmentService['upload']>>> {
    return this.attachments.upload(this.tenantContext.current(), request[REQUEST_USER_KEY], body);
  }

  @Post('save')
  @RequirePermission('attachment:write')
  async save(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<AttachmentService['save']>>> {
    return this.attachments.save(this.tenantContext.current(), request[REQUEST_USER_KEY], body);
  }

  @Post('save-batch')
  @RequirePermission('attachment:write')
  async saveBatch(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ attachments: Awaited<ReturnType<AttachmentService['saveBatch']>> }> {
    return {
      attachments: await this.attachments.saveBatch(
        this.tenantContext.current(),
        request[REQUEST_USER_KEY],
        body,
      ),
    };
  }

  @Get('list-by-biz-id')
  @RequirePermission('attachment:read')
  async listByBizId(
    @Query('bizId') bizId?: string,
  ): Promise<{ attachments: Awaited<ReturnType<AttachmentService['listByBizId']>> }> {
    return {
      attachments: await this.attachments.listByBizId(
        this.tenantContext.current(),
        parseBizIdQuery(bizId),
      ),
    };
  }

  @Post('remove')
  @RequirePermission('attachment:write')
  async remove(
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<AttachmentService['remove']>>> {
    return this.attachments.remove(this.tenantContext.current(), body);
  }

  @Get('download-reference')
  @RequirePermission('attachment:read')
  async downloadReference(
    @Query('id') id?: string,
    @Query('bizId') bizId?: string,
    @Query('downloadName') downloadName?: string,
  ): Promise<Awaited<ReturnType<AttachmentService['issueDownloadReference']>>> {
    return this.attachments.issueDownloadReference(
      this.tenantContext.current(),
      parseDownloadReferenceQuery({ id, bizId, downloadName }),
    );
  }

  /** 开门面：短时只读引用换字节流（token 即凭证，无权限码——见文件头注）。 */
  @Get('storage/:token')
  async openStorage(@Param('token') token: string): Promise<StreamableFile> {
    const resolved = await this.attachments.resolveReadReference(
      this.tenantContext.current(),
      parseAttachmentIdParam(token),
    );
    return new StreamableFile(Buffer.from(resolved.bytes), {
      type: resolved.contentType ?? 'application/octet-stream',
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(resolved.downloadName || 'file')}`,
    });
  }
}
