import { useCallback, useEffect, useState } from 'react';
import {
  RefreshCw,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from 'lucide-react';
import type {
  LearningContainerSummary,
  LearningRun,
  LearningSkill,
} from '../shared/learning';
import { api } from './api';

interface Detail {
  container: LearningContainerSummary;
  skills: LearningSkill[];
  runs: LearningRun[];
}

/**
 * Owner review for local Automatic Learning.
 *
 * Mirrors the hosted workflow without CopilotKit Intelligence: inspect how much
 * evidence a container has, ask the configured model for skill proposals, then
 * publish or reject each draft. Nothing is published automatically.
 */
export function LearningPanel({
  containerId,
  onError,
}: {
  containerId: string;
  onError: (message: string) => void;
}) {
  const [detail, setDetail] = useState<Detail>();
  const [evidence, setEvidence] = useState<
    { threadId: string; role: string; text: string }[]
  >([]);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [showEvidence, setShowEvidence] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api<Detail>(
        `/learning/containers/${containerId}`,
        'GET',
      );
      setDetail(next);
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : 'Learning container could not load.',
      );
    }
  }, [containerId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const analyze = async () => {
    setBusy('analyze');
    setNotice('');
    try {
      const result = await api<{ proposed: number; analyzed: number }>(
        `/learning/containers/${containerId}/analyze`,
        'POST',
        {},
      );
      setNotice(
        result.proposed
          ? `${result.proposed} draft ${result.proposed === 1 ? 'skill' : 'skills'} proposed from ${result.analyzed} evidence messages. Review before publishing.`
          : 'The model did not find a reusable skill. Add more evidence or try again later.',
      );
      await load();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : 'Learning analysis could not complete.',
      );
    } finally {
      setBusy('');
    }
  };

  const act = async (skill: LearningSkill, action: 'publish' | 'reject') => {
    setBusy(skill.id);
    try {
      await api(`/learning/skills/${skill.id}/actions`, 'POST', { action });
      await load();
    } catch (error) {
      onError(
        error instanceof Error ? error.message : 'Skill could not be updated.',
      );
    } finally {
      setBusy('');
    }
  };

  const remove = async (skill: LearningSkill) => {
    setBusy(skill.id);
    try {
      await api(`/learning/skills/${skill.id}`, 'DELETE');
      await load();
    } catch (error) {
      onError(
        error instanceof Error ? error.message : 'Skill could not be deleted.',
      );
    } finally {
      setBusy('');
    }
  };

  const toggleEvidence = async () => {
    if (!showEvidence && !evidence.length) {
      try {
        const next = await api<{
          evidence: { threadId: string; role: string; text: string }[];
        }>(`/learning/containers/${containerId}/evidence`, 'GET');
        setEvidence(next.evidence);
      } catch (error) {
        onError(
          error instanceof Error
            ? error.message
            : 'Conversation evidence could not load.',
        );
      }
    }
    setShowEvidence(!showEvidence);
  };

  if (!detail) return <p className="muted">Loading Learning container…</p>;

  const { container, skills, runs } = detail;
  const drafts = skills.filter((skill) => skill.status === 'draft');
  const published = skills.filter((skill) => skill.status === 'published');
  const latestRun = runs[0];

  return (
    <div className="learning-panel">
      <p className="muted">
        <strong>{container.name}</strong> collects evidence only from
        conversations created while a Dot used this container. Analysis uses
        your configured model; nothing is published without your approval.
      </p>
      <p className="muted">
        {container.threadCount} conversation
        {container.threadCount === 1 ? '' : 's'} · {container.evidenceCount}{' '}
        evidence message{container.evidenceCount === 1 ? '' : 's'} ·{' '}
        {container.ready
          ? 'readiness threshold reached'
          : `${Math.max(0, container.threshold - container.threadCount)} more conversation(s) to reach the default threshold`}
      </p>
      {container.paused && (
        <p className="muted">Learning is paused for this container.</p>
      )}
      {latestRun?.status === 'failed' && latestRun.error && (
        <p className="chat-error" role="alert">
          {latestRun.error}
        </p>
      )}
      {notice && <p className="muted">{notice}</p>}
      <div className="learning-actions">
        <button
          type="button"
          className="text-button"
          disabled={!!busy || container.paused}
          onClick={() => void analyze()}
        >
          <Sparkles size={14} />
          {busy === 'analyze' ? 'Analyzing…' : 'Analyze evidence'}
        </button>
        <button
          type="button"
          className="text-button"
          disabled={!!busy}
          onClick={() => void load()}
        >
          <RefreshCw size={14} /> Refresh
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => void toggleEvidence()}
        >
          {showEvidence ? 'Hide evidence' : 'View evidence'}
        </button>
      </div>
      {showEvidence && (
        <div className="learning-evidence">
          {evidence.length ? (
            evidence.map((row, index) => (
              <p key={`${row.threadId}-${index}`} className="muted">
                <strong>{row.role === 'user' ? 'Owner' : 'Dot'}:</strong>{' '}
                {row.text.slice(0, 280)}
                {row.text.length > 280 ? '…' : ''}
              </p>
            ))
          ) : (
            <p className="muted">No evidence recorded yet.</p>
          )}
        </div>
      )}
      <h3>Proposed skills</h3>
      {drafts.length ? (
        drafts.map((skill) => (
          <div key={skill.id} className="learning-skill">
            <strong>{skill.name}</strong>
            <p className="muted">{skill.description}</p>
            <details>
              <summary>Preview instructions</summary>
              <pre>{skill.content}</pre>
            </details>
            <div className="learning-actions">
              <button
                type="button"
                className="text-button"
                disabled={!!busy}
                onClick={() => void act(skill, 'publish')}
              >
                <ThumbsUp size={14} /> Publish
              </button>
              <button
                type="button"
                className="text-button"
                disabled={!!busy}
                onClick={() => void act(skill, 'reject')}
              >
                <ThumbsDown size={14} /> Reject
              </button>
            </div>
          </div>
        ))
      ) : (
        <p className="muted">No drafts. Analyze evidence to propose skills.</p>
      )}
      <h3>Published skills</h3>
      {published.length ? (
        published.map((skill) => (
          <div key={skill.id} className="learning-skill">
            <strong>{skill.name}</strong>
            <p className="muted">{skill.description}</p>
            <div className="learning-actions">
              <button
                type="button"
                className="text-button"
                disabled={!!busy}
                onClick={() => void act(skill, 'reject')}
              >
                <ThumbsDown size={14} /> Unpublish
              </button>
              <button
                type="button"
                className="text-button"
                disabled={!!busy}
                onClick={() => void remove(skill)}
              >
                <Trash2 size={14} /> Delete
              </button>
            </div>
          </div>
        ))
      ) : (
        <p className="muted">
          Published skills are offered to Dots with delivery enabled.
        </p>
      )}
    </div>
  );
}
