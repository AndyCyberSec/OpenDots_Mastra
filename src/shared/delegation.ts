import { z } from 'zod';

/**
 * Owner approval for Dot-to-Dot delegation.
 *
 * The model gets `delegate_to_dot` (server tool). When the caller Dot requires
 * approval, the tool returns `approval_required`; the model then calls this
 * client tool, which renders a card and lets the owner approve or decline the
 * exact request. Nothing runs until the owner decides.
 */
export const delegationActionSchema = z
  .object({
    approvalId: z.string().min(1).max(80),
    summary: z.string().trim().min(1).max(500),
  })
  .strict();
export type DelegationAction = z.infer<typeof delegationActionSchema>;
export const delegationActionTool = {
  name: 'review_delegation',
  description:
    'Ask the owner to approve delegating work to another specialist Dot. Use only when delegate_to_dot returned approval_required. Pass its approvalId and a one-sentence summary of the request. Call once, then wait: the result contains the target Dot’s answer if approved.',
  parameters: z.toJSONSchema(delegationActionSchema),
};

export interface DelegationApprovalView {
  id: string;
  caller: { id: string; name: string };
  target: { id: string; name: string };
  request: string;
  status: string;
  expiresAt: number;
  result: string | null;
  error: string | null;
}
