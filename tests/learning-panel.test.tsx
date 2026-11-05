import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api }));
import { LearningPanel } from '../src/client/LearningPanel';

const detail = {
  container: {
    id: 'research',
    name: 'Research',
    paused: false,
    threshold: 15,
    createdAt: 0,
    lastAnalyzedAt: null,
    evidenceCount: 3,
    threadCount: 1,
    draftCount: 1,
    publishedCount: 0,
    ready: false,
  },
  skills: [
    {
      id: 'skill-1',
      containerId: 'research',
      name: 'weekly-review',
      description: 'Prepare a weekly review page.',
      content: 'Read last week.',
      status: 'draft',
      source: 'model',
      evidenceCount: 3,
      createdAt: 0,
      reviewedAt: null,
      publishedAt: null,
    },
  ],
  runs: [],
};

const labels = (tree: ReactTestRenderer) =>
  tree.root
    .findAllByType('button')
    .map((node) => node.children.map((child) => String(child)).join(''));

beforeEach(() => {
  api.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

it('shows readiness, drafts, and publishes after review', async () => {
  api.mockImplementation((path: string, method: string) => {
    if (method === 'GET' && path.startsWith('/learning/containers/'))
      return Promise.resolve(detail);
    if (path.endsWith('/actions')) return Promise.resolve({ ok: true });
    return Promise.resolve({});
  });
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      createElement(LearningPanel, {
        containerId: 'research',
        onError: () => {},
      }),
    );
  });
  const buttons = labels(tree);
  expect(buttons.some((label) => label.includes('Analyze evidence'))).toBe(
    true,
  );
  expect(buttons.some((label) => label.includes('Publish'))).toBe(true);
  expect(JSON.stringify(tree.toJSON())).toContain('evidence message');

  const publish = tree.root
    .findAllByType('button')
    .find((node) => node.children.join('').includes('Publish'))!;
  await act(async () => {
    publish.props.onClick();
  });
  expect(api).toHaveBeenCalledWith('/learning/skills/skill-1/actions', 'POST', {
    action: 'publish',
  });
});

it('disables analysis while the container is paused', async () => {
  api.mockResolvedValueOnce({
    ...detail,
    container: { ...detail.container, paused: true },
    skills: [],
  });
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      createElement(LearningPanel, {
        containerId: 'research',
        onError: () => {},
      }),
    );
  });
  const analyze = tree.root
    .findAllByType('button')
    .find((node) => node.children.join('').includes('Analyze evidence'))!;
  expect(analyze.props.disabled).toBe(true);
  expect(JSON.stringify(tree.toJSON())).toContain('paused');
});
