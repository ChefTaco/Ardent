import type { RequestHandler } from 'express';
import { z } from 'zod';

const aliases: Record<string, string> = {
  'message/send': 'SendMessage',
  'message/stream': 'SendStreamingMessage',
  'tasks/get': 'GetTask',
  'tasks/list': 'ListTasks',
  'tasks/cancel': 'CancelTask',
  'tasks/subscribe': 'SubscribeToTask',
  'tasks/pushNotificationConfig/create': 'CreateTaskPushNotificationConfig',
  'tasks/pushNotificationConfig/set': 'CreateTaskPushNotificationConfig',
  'tasks/pushNotification/set': 'CreateTaskPushNotificationConfig',
  'tasks/pushNotificationConfig/get': 'GetTaskPushNotificationConfig',
  'tasks/pushNotificationConfig/list': 'ListTaskPushNotificationConfigs',
  'tasks/pushNotificationConfig/delete': 'DeleteTaskPushNotificationConfig'
};
const Rpc = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]), method: z.string(), params: z.unknown().optional() }).passthrough();
const RecordValue = z.record(z.string(), z.unknown());

/** Accepted Hermes slash aliases are translated at the wire edge only. */
export const hermesAlias: RequestHandler = (req, res, next) => {
  if (req.header('A2A-Version') !== '1.0') { next(); return; }
  const parsed = Rpc.safeParse(req.body as unknown);
  if (!parsed.success) { next(); return; }
  const method = aliases[parsed.data.method];
  if (!method) { next(); return; }
  let params = parsed.data.params;
  if (method === 'CreateTaskPushNotificationConfig') {
    const outer = RecordValue.safeParse(params);
    const inner = outer.success ? RecordValue.safeParse(outer.data.pushNotificationConfig ?? outer.data.config) : undefined;
    if (outer?.success && inner?.success) params = { ...inner.data, taskId: outer.data.taskId, tenant: outer.data.tenant ?? '' };
  }
  req.body = { ...parsed.data, method, params };
  if (parsed.data.method === 'message/send' || parsed.data.method === 'tasks/pushNotificationConfig/delete') {
    const originalJson = res.json.bind(res);
    res.json = ((value: unknown) => {
      const response = RecordValue.safeParse(value);
      if (!response.success || !('result' in response.data)) return originalJson(value);
      if (parsed.data.method === 'tasks/pushNotificationConfig/delete') return originalJson({ ...response.data, result: { deleted: true } });
      const result = RecordValue.safeParse(response.data.result);
      if (!result.success) return originalJson(value);
      return originalJson({ ...response.data, result: result.data.task ?? result.data.message ?? response.data.result });
    }) as typeof res.json;
  }
  next();
};
