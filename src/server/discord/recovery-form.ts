import { ApiError, type Ctx } from '../context';

/** Server-rendered forms: validate the exact public origin and session CSRF. */
export async function readRecoveryForm(ctx:Ctx,request:Request):Promise<URLSearchParams>{
  const origin=request.headers.get('origin');
  if(!origin || origin!==new URL(ctx.config.publicOrigin).origin)
    throw new ApiError(403,'csrf_failed','Refresh the page and try again.');
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/x-www-form-urlencoded'))
    throw new ApiError(415,'form_invalid','Refresh the page and try again.');
  if(!request.body)throw new ApiError(400,'form_invalid','Refresh the page and try again.');
  const reader=request.body.getReader();let size=0;const parts:Uint8Array[]=[];
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();throw new ApiError(413,'form_invalid','Refresh the page and try again.');}parts.push(value);}
  const bytes=new Uint8Array(size);let pos=0;for(const part of parts){bytes.set(part,pos);pos+=part.byteLength;}
  const form=new URLSearchParams(new TextDecoder().decode(bytes));
  if(form.getAll('csrf').length!==1 || !ctx.user || !ctx.sessionId || !ctx.csrfToken || form.get('csrf')!==ctx.csrfToken)
    throw new ApiError(403,'csrf_failed','Refresh the page and try again.');
  return form;
}
