import { Body, Controller, Get, Inject, Post, Req, Injectable, HttpException, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { ManufacturingService, ManufacturingQualityService, ManufacturingCommandGuard, ManufacturingRejected, ManufacturingAccessError, REQUEST_USER_KEY, RequirePermission, TenantContext, type AuthenticatedRequest, type Data } from '@smes/application';
export const MANUFACTURING = Symbol('manufacturing.controls');
export interface ManufacturingRuntime { control: ManufacturingService; quality: ManufacturingQualityService; guard: ManufacturingCommandGuard }
function data(value: unknown): Data { if(!value||typeof value!=='object'||Array.isArray(value))throw new ManufacturingRejected('请求须为对象');return value as Data; }
function fail(error: unknown): never { if(error instanceof ManufacturingAccessError)throw new HttpException({status:'rejected',message:error.message},403);if(error instanceof ManufacturingRejected)throw new HttpException({status:'rejected',message:error.message,reason:error.message},409);throw error; }
@Controller('manufacturing')
export class ManufacturingController {
  constructor(private readonly tenant: TenantContext,@Inject(MANUFACTURING)private readonly runtime: ManufacturingRuntime) {}
  @Get('board') @RequirePermission('manufacturing:read')
  async board(@Req() req: AuthenticatedRequest) { try{return await this.runtime.control.store.transaction(this.tenant.current(),()=>this.runtime.control.board(this.tenant.current(),String(req[REQUEST_USER_KEY])));}catch(error){fail(error);} }
  @Post('commands') @RequirePermission('manufacturing:read')
  async command(@Req() req: AuthenticatedRequest,@Body() body: unknown) {
    try {const p=data(body),command=data(p['command']);const op=p['operationId'];if(typeof op!=='string'||!op.trim()||op.length>128)throw new ManufacturingRejected('操作标识无效');const payload=data(command['payload']);const kind=String(command['kind']);const t=this.tenant.current(),actor=String(req[REQUEST_USER_KEY]);return await this.runtime.control.store.transaction(t,()=>kind==='mfg.quality.reconcile.v1'?this.runtime.quality.reconcile(t,actor,op,payload):this.runtime.control.execute(t,actor,op,p['expectedRevision'],kind,payload));}catch(error){fail(error);}
  }
}
@Controller('stock/quality')
export class StockQualityController {
  constructor(private readonly tenant: TenantContext,@Inject(MANUFACTURING)private readonly runtime: ManufacturingRuntime) {}
  @Get() @RequirePermission('stock:read')
  async list(){try{return await this.runtime.control.store.transaction(this.tenant.current(),async()=>({levels:await this.runtime.quality.levels(this.tenant.current()),lots:await this.runtime.control.store.lots(this.tenant.current())}));}catch(error){fail(error);}}
}
function rejected(value: unknown): string | null {
  if(!value||typeof value!=='object')return null;
  if(Array.isArray(value)){for(const item of value){const why=rejected(item);if(why)return why;}return null;}
  const p=value as Data;if(p['status']==='rejected'||p['status']==='indeterminate')return String(p['reason']??'源命令拒绝；本次全部回滚');
  for(const key of ['results','outcomes']){const why=rejected(p[key]);if(why)return why;}return null;
}
@Injectable()
export class ManufacturingTransactionInterceptor implements NestInterceptor {
  constructor(private readonly tenant: TenantContext,@Inject(MANUFACTURING)private readonly runtime: ManufacturingRuntime) {}
  intercept(context: ExecutionContext,next: CallHandler): Observable<unknown> {
    const req=context.switchToHttp().getRequest<{method:string;url:string;params?:{id?:string};body?:unknown;smesUser?:unknown}>();
    const raw=req.body&&typeof req.body==='object'?req.body as Data:{};const command=raw['command']&&typeof raw['command']==='object'?raw['command'] as Data:{};
    let kind=typeof command['kind']==='string'?command['kind']:'';let payload=command['payload']&&typeof command['payload']==='object'?command['payload'] as Data:{};
    if(req.url.split('?')[0]?.endsWith('/dispatch/orders/batch-assign')){kind='dispatch.batch-assign.v1';payload=raw;}
    if(req.method!=='POST'||!this.runtime.guard.applies(kind))return next.handle();
    const t=this.tenant.current(),u=String(req.smesUser??''),op=String(raw['operationId']??'');
    return from(this.runtime.control.store.transaction(t,async()=>{const checkpoint=await this.runtime.guard.before(t,kind,payload,req.params?.id??'');const result=await lastValueFrom(next.handle());const why=rejected(result);if(why)throw new ManufacturingRejected(why);await this.runtime.guard.after(t,u,op,kind,checkpoint);return result;}).catch(fail));
  }
}
