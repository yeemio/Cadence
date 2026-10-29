/** Explicit isolated/demo identities; no admin role, no permission changes to existing role packs. */
import {PrismaClient} from '@prisma/client';
const prisma=new PrismaClient();
const names={'e01':'总经理','e02':'运营','e05':'工程','e07':'计划','e08':'采购','e10':'品质','e13':'财务'};
const permissions={e01:[],e02:['dispatch:read','workorder:read'],e05:['process:read','equipment:read','routing:read','listing:read','drawing:read'],e07:['dispatch:read','dispatch:write','workorder:read'],e08:['purchase:read','purchase:order','purchase:request'],e10:['inspection:read','inspection:judge','stock:read'],e13:['purchase:read']};
try {
 const tenant=process.env['SMES_MANUFACTURING_SEED_TENANT']??'default';
 const credentialSource=await prisma.userRecord.findFirst({where:{tenantId:tenant,username:'demo-admin'}});
 if(!credentialSource?.passwordHash)throw new Error('Demo credential source missing; this script never creates a plaintext password.');
 await prisma.$transaction(async tx=>{
 for(const [code,name] of Object.entries(names)){
 const role='mfg-'+code,id='user-mfg-demo-'+code;
 await tx.roleRecord.upsert({where:{tenantId_name:{tenantId:tenant,name:role}},create:{tenantId:tenant,name:role,displayName:'MFG01 '+name},update:{}});
 const user=await tx.userRecord.upsert({where:{tenantId_username:{tenantId:tenant,username:'mfg-'+code}},create:{id,tenantId:tenant,username:'mfg-'+code,displayName:'MFG01 '+name,active:true,passwordHash:credentialSource.passwordHash},update:{}});
 if(user.id!==id)throw new Error('Existing identity collision; no role assignment applied.');
 const rows=[{ruleKey:`grant-role|${tenant}|${id}|${role}`,tenantId:tenant,kind:'grant-role',userId:id,role},...['manufacturing:read','workbench:read',...permissions[code]].map(code=>{const[resource,action]=code.split(':');return {ruleKey:`grant-permission|${tenant}|${role}|${resource}|${action}`,tenantId:tenant,kind:'grant-permission',role,resource,action};})];
 await tx.policyRecord.createMany({data:rows,skipDuplicates:true});
 }
 });
 console.log(JSON.stringify({tenant,users:Object.keys(names).map(code=>'mfg-'+code),credentialSource:'same isolated demo credential source; no secret emitted'}));
}finally{await prisma.$disconnect();}
