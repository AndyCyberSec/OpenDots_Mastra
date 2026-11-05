# Dot-to-Dot delegation

Specialist Dots can be allowed to delegate a bounded request to another Dot.
Nothing about the feature depends on names such as “PM” or “Developer”: grants are
explicit edges between **stable Dot IDs**, managed by the owner.

This is an OpenDots extension beyond the upstream template (which has no
inter-agent delegation). It reuses the durable runner and the same permission
model as normal turns.

## Model

```sql
dot_delegations(callerDotId, targetDotId, createdAt)
dots.delegationApprovalRequired  -- per caller, default 1 (ask me)
```

- Create/rename/delete Dots freely: renaming does not affect grants; deleting a
  Dot removes every edge and pending approval that references it.
- A new Dot starts with no outgoing or incoming grants.
- Grants are configured in the Dot dialog under **Delegation**: choose target Dots
  and decide whether **Ask me before delegating** stays enabled (default on).

## Tool flow

The caller only receives `delegate_to_dot` when it has at least one target:

```
delegate_to_dot({ targetDotId, request }) ->
  { status: "completed", target, threadId, text }
  { status: "approval_required", approvalId, summary, instruction }
  { status: "busy" | "unavailable" | "failed", message }
```

- `approval_required` is returned when the caller has **Ask me before delegating**
  enabled and the owner is in the web chat. The model then calls the client tool
  `review_delegation`, which renders a card with the exact request and both Dot
  names (resolved live, so renames are reflected). Nothing runs before Approve.
- In voice, scheduled tasks, or Slack there is no card: a request that needs
  approval returns `unavailable` with a message asking the owner to continue in
  the web app.

## Execution semantics

- Delegated work runs in a dedicated **inbox conversation** per caller→target
  pair: `delegation:<callerId>:<targetId>`. The transcript is durable and appears
  in the target Dot’s chat list as “Delegated work”.
- The target runs a **normal turn with its own permissions, tools, and approval
  gates**. A sensitive MCP action still needs the owner in the web app.
- **Depth is one:** the target runs with delegation tools disabled, so delegated
  work cannot chain or loop.
- One run per conversation: if the inbox is busy, the tool returns `busy` and the
  owner can retry shortly.
- Approvals are claimed atomically before execution. A double click or retry
  returns the saved result (or reports that the approval was already used) instead
  of running the target twice.
- Requests expire after 1 hour. Approving an expired request, or one whose grant
  or Dot was removed, is refused and nothing runs.
- The caller’s turn is aborted if the owner changes its grants, delivery, or
  permissions mid-run (the same check as other permissions).

## Privacy and safety

- Delegation never bypasses Dot permissions, approvals, space access, Learning
  delivery rules, or computer permissions.
- The prompt tells the target the request comes from another specialist and must
  be treated as owner work, not higher-priority instructions.
- The caller receives only the target’s final text, not its internal events.
- Every delegation is auditable: tool call/result in the caller transcript,
  metadata (`opendotsSource: "delegation"`, `fromDotId`, `request`) on the target
  message, and the `delegation_approvals` row with status/result/error.

## Tests

`tests/delegation.test.ts` covers grants and validation, execution without
approval, depth-one tool isolation, busy targets, approval/decline, single
execution on retry, expiry, revoked grants, and the caller→target HTTP flow.
`tests/delegation-card.test.tsx` covers the approval card. `tests/dot-delete.test.ts`
covers Dot deletion and edge cleanup.
