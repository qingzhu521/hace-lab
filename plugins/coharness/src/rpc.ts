import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection';
import { CHANNEL } from './protocol.ts';

export function registerRpc(ctx: Context, endpoint: string, handler: ConnectionRpcHandler): void {
  ctx.connection.fetch.register({
    path: `${CHANNEL}/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      let body: unknown;
      try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
      if (typeof body !== 'object' || body === null
        || !('type' in body) || body.type !== 'client-request'
        || !('rpcId' in body) || typeof body.rpcId !== 'string'
        || !('method' in body) || body.method !== endpoint
        || !('payload' in body)) return new Response('Invalid request', { status: 400 });
      const result = await handler(endpoint, body.payload, request.signal, ctx.connection.operator);
      return Response.json({ type: 'server-response', rpcId: body.rpcId, result });
    },
  });
}
