import type { ServerState } from '../stores/contracts.ts';

/** REST and sockets share process-local budgets, charged per addressed invitee. */
export async function checkGroupAdmissionRate(state: ServerState, userId: string, create: boolean, inviteeCount: number) {
  if (create) {
    const result = await state.groupCreateRateLimiter.check(userId);
    if (!result.allowed) return result;
  }
  for (let index = 0; index < Math.max(create ? 0 : 1, inviteeCount); index++) {
    const result = await state.groupInviteRateLimiter.check(userId);
    if (!result.allowed) return result;
  }
  return null;
}
