import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api }));
import { DelegationCard } from '../src/client/DelegationCard';

const args = {
  approvalId: 'approval-1',
  summary: 'Delegate the release notes.',
};
const view = {
  id: 'approval-1',
  caller: { id: 'pm', name: 'Project manager' },
  target: { id: 'dev', name: 'Developer' },
  request: 'Write the release notes for v1.',
  status: 'pending',
  expiresAt: Date.now() + 60_000,
  result: null,
  error: null,
};

beforeEach(() => {
  api.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

async function render(respond = vi.fn(async () => {})) {
  api.mockImplementation((path: string, method: string) => {
    if (
      (method ?? 'GET') === 'GET' &&
      path.startsWith('/delegations/approvals/')
    )
      return Promise.resolve(view);
    if (path.endsWith('/actions'))
      return Promise.resolve({
        status: 'completed',
        text: 'Notes written.',
        target: { id: 'dev', name: 'Developer' },
        threadId: 'delegation:pm:dev',
      });
    return Promise.resolve({});
  });
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      createElement(DelegationCard, { args, status: 'inProgress', respond }),
    );
  });
  return { tree, respond };
}

const button = (tree: ReactTestRenderer, label: string) =>
  tree.root
    .findAllByType('button')
    .find((node) => node.children.join('').includes(label))!;

it('shows the exact request with both Dot names and approves once', async () => {
  const { tree, respond } = await render();
  expect(JSON.stringify(tree.toJSON())).toContain('Project manager');
  expect(JSON.stringify(tree.toJSON())).toContain(
    'Write the release notes for v1.',
  );
  await act(async () => {
    button(tree, 'Approve & delegate').props.onClick();
  });
  expect(api).toHaveBeenCalledWith(
    '/delegations/approvals/approval-1/actions',
    'POST',
    { action: 'approve' },
  );
  expect(respond).toHaveBeenCalledWith(
    expect.objectContaining({
      approved: true,
      status: 'completed',
      text: 'Notes written.',
    }),
  );
  expect(JSON.stringify(tree.toJSON())).toContain('Notes written.');
});

it('declines without running the target', async () => {
  const { tree, respond } = await render();
  api.mockImplementation((path: string, method: string) => {
    if (
      (method ?? 'GET') === 'GET' &&
      path.startsWith('/delegations/approvals/')
    )
      return Promise.resolve(view);
    if (path.endsWith('/actions'))
      return Promise.resolve({ status: 'declined' });
    return Promise.resolve({});
  });
  await act(async () => {
    button(tree, 'Decline').props.onClick();
  });
  expect(respond).toHaveBeenCalledWith(
    expect.objectContaining({ approved: false, status: 'declined' }),
  );
});
