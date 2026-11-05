import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Dot, Memory, State, WorkspaceState } from '../shared/types';
import { ConnectionsSection } from './ConnectionsSection';
import { LearningPanel } from './LearningPanel';
import {
  setThemePreference,
  themePreference,
  type ThemePreference,
} from './theme';
export type Dialog =
  | { type: 'space' }
  | { type: 'dot'; dot?: Dot; spaceId: string }
  | { type: 'settings' }
  | { type: 'memory'; memory?: Memory }
  | { type: 'schedule'; threadId: string }
  | { type: 'learning'; containerId: string };
export function WorkspaceDialog({
  dialog,
  state,
  workspace,
  onClose,
  mutate,
  onReviewLearning,
}: {
  dialog: Dialog;
  state: State;
  workspace: WorkspaceState;
  onClose: () => void;
  mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
  onReviewLearning: (containerId: string) => void;
}) {
  const [name, setName] = useState(
    dialog.type === 'dot' ? (dialog.dot?.name ?? '') : '',
  );
  const [text, setText] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.instructions ?? '')
      : dialog.type === 'memory'
        ? (dialog.memory?.text ?? '')
        : '',
  );
  const [research, setResearch] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.researchAllowed ?? true)
      : state.settings.researchAllowed,
  );
  const [memory, setMemory] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.memoryAllowed ?? true)
      : state.settings.memoryAllowed,
  );
  const [apps, setApps] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.appsAllowed ?? false)
      : state.settings.appsAllowed,
  );
  const [learningAuto, setLearningAuto] = useState(
    state.settings.learningAutoAnalyze,
  );
  const [learningInterval, setLearningInterval] = useState(
    String(state.settings.learningIntervalMinutes),
  );
  const [composioToolkits, setComposioToolkits] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.composioToolkits ?? []).join(', ')
      : '',
  );
  const [spaceIds, setSpaceIds] = useState(
    dialog.type === 'dot' ? (dialog.dot?.spaceIds ?? [dialog.spaceId]) : [],
  );
  const [defaultSpace, setDefaultSpace] = useState(
    dialog.type === 'dot' ? (dialog.dot?.spaceId ?? dialog.spaceId) : '',
  );
  const [interval, setInterval] = useState('86400');
  const [learningContainer, setLearningContainer] = useState(
    dialog.type === 'dot' ? (dialog.dot?.learningContainerId ?? '') : '',
  );
  const [model, setModel] = useState(
    dialog.type === 'dot' ? (dialog.dot?.model ?? '') : '',
  );
  const [delegatesTo, setDelegatesTo] = useState<string[]>(
    dialog.type === 'dot' ? (dialog.dot?.delegatesTo ?? []) : [],
  );
  const [delegationApproval, setDelegationApproval] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.delegationApprovalRequired ?? true)
      : true,
  );
  const [skillDelivery, setSkillDelivery] = useState(
    dialog.type === 'dot' ? (dialog.dot?.skillDeliveryEnabled ?? false) : false,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [theme, setTheme] = useState(themePreference);
  const container = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    container.current
      ?.querySelector<HTMLElement>('input,textarea,select')
      ?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const items = [
          ...(container.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]),input,textarea,select,a[href]',
          ) ?? []),
        ];
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
          event.preventDefault();
          items[0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);
  const title =
    dialog.type === 'space'
      ? 'A space for something.'
      : dialog.type === 'dot'
        ? dialog.dot
          ? 'Make this Dot yours.'
          : 'Meet your next specialist.'
        : dialog.type === 'settings'
          ? 'Your workspace, your rules.'
          : dialog.type === 'memory'
            ? 'Something to remember.'
            : dialog.type === 'learning'
              ? 'Review what your Dots learn.'
              : 'Let your Dot keep time.';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        ref={container}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <span className="eyebrow">OPENDOTS TEMPLATE</span>
        <h2 id="dialog-title">{title}</h2>
        {dialog.type === 'learning' ? (
          <LearningPanel containerId={dialog.containerId} onError={setError} />
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              let path = '',
                method = 'POST',
                body: unknown;
              if (dialog.type === 'space') {
                path = '/spaces';
                body = { name, description: text };
              }
              if (dialog.type === 'dot') {
                path = dialog.dot ? `/dots/${dialog.dot.id}` : '/dots';
                method = dialog.dot ? 'PUT' : 'POST';
                body = {
                  spaceId: defaultSpace,
                  spaceIds,
                  name,
                  instructions: text,
                  researchAllowed: research,
                  memoryAllowed: memory,
                  appsAllowed: apps,
                  composioToolkits: composioToolkits
                    .split(',')
                    .map((slug) => slug.trim())
                    .filter(Boolean),
                  learningContainerId: learningContainer.trim() || null,
                  skillDeliveryEnabled: skillDelivery,
                  model,
                  delegatesTo,
                  delegationApprovalRequired: delegationApproval,
                };
              }
              if (dialog.type === 'settings') {
                path = '/settings';
                method = 'PATCH';
                body = {
                  researchAllowed: research,
                  memoryAllowed: memory,
                  appsAllowed: apps,
                  learningAutoAnalyze: learningAuto,
                  learningIntervalMinutes: Number(learningInterval),
                };
              }
              if (dialog.type === 'memory') {
                path = dialog.memory
                  ? `/memories/${dialog.memory.id}`
                  : '/memories';
                method = dialog.memory ? 'PUT' : 'POST';
                body = { text };
              }
              if (dialog.type === 'schedule') {
                path = '/tasks';
                body = {
                  prompt: text,
                  threadId: dialog.threadId,
                  intervalSeconds: Number(interval),
                };
              }
              if (await mutate(path, method, body)) onClose();
              else
                setError(
                  'Could not save. Review the workspace error and retry.',
                );
              setBusy(false);
            }}
          >
            {(dialog.type === 'space' || dialog.type === 'dot') && (
              <>
                <label className="field-label" htmlFor="entity-name">
                  Name
                </label>
                <input
                  id="entity-name"
                  value={name}
                  maxLength={40}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </>
            )}
            {dialog.type !== 'settings' && (
              <>
                <label className="field-label" htmlFor="entity-text">
                  {dialog.type === 'dot'
                    ? 'Role instructions'
                    : dialog.type === 'space'
                      ? 'What belongs here?'
                      : dialog.type === 'memory'
                        ? 'Preference or context'
                        : 'Task to revisit'}
                </label>
                <textarea
                  id="entity-text"
                  rows={4}
                  maxLength={dialog.type === 'schedule' ? 4000 : 2000}
                  required={dialog.type !== 'space'}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={
                    dialog.type === 'dot'
                      ? 'You are a thoughtful research partner. Compare evidence and be clear about uncertainty.'
                      : ''
                  }
                />
              </>
            )}
            {dialog.type === 'dot' && (
              <fieldset className="space-access-fields">
                <legend>Space access</legend>
                <p className="muted">
                  Choose where this Dot can read and edit pages.
                </p>
                {workspace.spaces.map((space) => (
                  <label className="permission-row" key={space.id}>
                    <input
                      type="checkbox"
                      checked={spaceIds.includes(space.id)}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? [...spaceIds, space.id]
                          : spaceIds.filter((id) => id !== space.id);
                        setSpaceIds(next);
                        if (!next.includes(defaultSpace))
                          setDefaultSpace(next[0] ?? '');
                      }}
                    />
                    <span>{space.name}</span>
                  </label>
                ))}
                <label className="field-label" htmlFor="default-space">
                  Default destination for saved pages
                </label>
                <select
                  id="default-space"
                  value={defaultSpace}
                  required
                  onChange={(event) => setDefaultSpace(event.target.value)}
                >
                  <option value="" disabled>
                    Choose a Space
                  </option>
                  {workspace.spaces
                    .filter((space) => spaceIds.includes(space.id))
                    .map((space) => (
                      <option key={space.id} value={space.id}>
                        {space.name}
                      </option>
                    ))}
                </select>
              </fieldset>
            )}
            {(dialog.type === 'dot' || dialog.type === 'settings') && (
              <>
                <label className="permission-row">
                  <input
                    type="checkbox"
                    checked={research}
                    onChange={(e) => setResearch(e.target.checked)}
                  />
                  <span>
                    <strong>Public-page research</strong>
                    <small>
                      Allow the server-side read-only browser tool. Global
                      settings always take precedence.
                    </small>
                  </span>
                </label>
                <label className="permission-row">
                  <input
                    type="checkbox"
                    checked={memory}
                    onChange={(e) => setMemory(e.target.checked)}
                  />
                  <span>
                    <strong>Use saved memories</strong>
                    <small>
                      Include your preferences in new turns. Changing permission
                      stops active work.
                    </small>
                  </span>
                </label>
                {workspace.setup.composio && (
                  <label className="permission-row">
                    <input
                      type="checkbox"
                      checked={apps}
                      onChange={(event) => setApps(event.target.checked)}
                    />
                    <span>
                      <strong>Connected apps</strong>
                      <small>
                        Allow access to the owner’s apps through Composio.
                        Global settings always take precedence.
                      </small>
                    </span>
                  </label>
                )}
              </>
            )}
            {dialog.type === 'dot' && workspace.setup.composio && (
              <fieldset className="space-access-fields">
                <legend>Connected apps</legend>
                <label className="field-label" htmlFor="composio-toolkits">
                  Toolkit slugs
                </label>
                <input
                  id="composio-toolkits"
                  value={composioToolkits}
                  pattern="[a-z0-9_]+(, *[a-z0-9_]+)*"
                  placeholder="gmail, google_calendar"
                  aria-describedby="composio-toolkits-help"
                  onChange={(event) => setComposioToolkits(event.target.value)}
                />
                <p className="muted" id="composio-toolkits-help">
                  Optional comma-separated Composio toolkit slugs. Leave blank
                  to let the Dot search all available toolkits.
                </p>
              </fieldset>
            )}
            {dialog.type === 'dot' && (
              <fieldset className="space-access-fields">
                <legend>Automatic Learning</legend>
                <label className="field-label" htmlFor="learning-container">
                  Learning container ID
                </label>
                <input
                  id="learning-container"
                  value={learningContainer}
                  maxLength={64}
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  placeholder="research-workflow"
                  list="learning-containers"
                  aria-describedby="learning-help"
                  onChange={(event) => {
                    setLearningContainer(event.target.value);
                    if (!event.target.value.trim()) setSkillDelivery(false);
                  }}
                />
                <datalist id="learning-containers">
                  {(workspace.learning ?? []).map((container) => (
                    <option key={container.id} value={container.id}>
                      {container.name}
                    </option>
                  ))}
                </datalist>
                <p className="muted" id="learning-help">
                  Evidence is stored locally. New conversations join this
                  container; existing conversations keep the container they were
                  created with. Leave blank to keep new conversations out of
                  Learning.
                </p>
                <label className="permission-row">
                  <input
                    type="checkbox"
                    checked={skillDelivery}
                    disabled={!learningContainer.trim()}
                    onChange={(event) => setSkillDelivery(event.target.checked)}
                  />
                  <span>
                    <strong>Use published skills</strong>
                    <small>
                      Load published skills from each conversation’s assigned
                      container. Turning this off stops skill loading; it does
                      not stop evidence collection.
                    </small>
                  </span>
                </label>
                <button
                  type="button"
                  className="text-button"
                  disabled={!learningContainer.trim()}
                  onClick={() => onReviewLearning(learningContainer.trim())}
                >
                  Review evidence and skills ↗
                </button>
              </fieldset>
            )}
            {dialog.type === 'dot' && (
              <fieldset className="space-access-fields">
                <legend>Model</legend>
                <label className="field-label" htmlFor="dot-model">
                  Model override
                </label>
                <input
                  id="dot-model"
                  value={model}
                  maxLength={200}
                  placeholder="Workspace default"
                  aria-describedby="dot-model-help"
                  onChange={(event) => setModel(event.target.value)}
                />
                <p className="muted" id="dot-model-help">
                  Leave blank to use AI_MODEL. Enter the provider&apos;s exact
                  model id, for example deepseek-chat or llama3.1. OpenDots
                  never switches provider or model on its own.
                </p>
              </fieldset>
            )}
            {dialog.type === 'dot' && (
              <fieldset className="space-access-fields">
                <legend>Delegation</legend>
                {workspace.dots.filter(
                  (candidate) => candidate.id !== dialog.dot?.id,
                ).length ? (
                  workspace.dots
                    .filter((candidate) => candidate.id !== dialog.dot?.id)
                    .map((candidate) => (
                      <label className="permission-row" key={candidate.id}>
                        <input
                          type="checkbox"
                          checked={delegatesTo.includes(candidate.id)}
                          onChange={(event) =>
                            setDelegatesTo((current) =>
                              event.target.checked
                                ? [...new Set([...current, candidate.id])]
                                : current.filter((id) => id !== candidate.id),
                            )
                          }
                        />
                        <span>
                          <strong>{candidate.name}</strong>
                          <small>
                            Allow this Dot to delegate work to {candidate.name}.
                          </small>
                        </span>
                      </label>
                    ))
                ) : (
                  <p className="muted">
                    Create another specialist to enable delegation.
                  </p>
                )}
                <label className="permission-row">
                  <input
                    type="checkbox"
                    checked={delegationApproval}
                    disabled={!delegatesTo.length}
                    onChange={(event) =>
                      setDelegationApproval(event.target.checked)
                    }
                  />
                  <span>
                    <strong>Ask me before delegating</strong>
                    <small>
                      A card shows the exact request and both specialists;
                      nothing runs until you approve. Targets still apply their
                      own permissions and approval gates.
                    </small>
                  </span>
                </label>
              </fieldset>
            )}
            {dialog.type === 'dot' && dialog.dot && (
              <ConnectionsSection dotId={dialog.dot.id} />
            )}
            {dialog.type === 'schedule' && (
              <>
                <label className="field-label" htmlFor="schedule-interval">
                  Repeat after each successful run
                </label>
                <select
                  id="schedule-interval"
                  value={interval}
                  onChange={(e) => setInterval(e.target.value)}
                >
                  <option value="60">Every minute (testing)</option>
                  <option value="3600">Every hour</option>
                  <option value="86400">Every day</option>
                  <option value="604800">Every week</option>
                </select>
                <p className="muted">
                  Runs on the server in this same conversation, even with the
                  tab closed. Failed or interrupted runs wait for manual retry.
                  Review completed work before retrying an interrupted run.
                </p>
              </>
            )}
            {dialog.type === 'settings' && (
              <fieldset className="appearance-fields">
                <legend>Appearance</legend>
                <div className="segmented" role="radiogroup">
                  {(['system', 'light', 'dark'] as ThemePreference[]).map(
                    (option) => (
                      <label key={option}>
                        <input
                          type="radio"
                          name="theme"
                          value={option}
                          checked={theme === option}
                          onChange={() => {
                            setTheme(option);
                            setThemePreference(option);
                          }}
                        />
                        <span>{option[0].toUpperCase() + option.slice(1)}</span>
                      </label>
                    ),
                  )}
                </div>
                <p className="muted">
                  Saved in this browser. System follows your device.
                </p>
              </fieldset>
            )}
            {dialog.type === 'settings' && (
              <fieldset className="appearance-fields">
                <legend>Automatic Learning</legend>
                <label className="permission-row">
                  <input
                    type="checkbox"
                    checked={learningAuto}
                    onChange={(event) => setLearningAuto(event.target.checked)}
                  />
                  <span>
                    <strong>Analyze Learning evidence automatically</strong>
                    <small>
                      Uses the configured model on ready containers, at most
                      once per interval. Proposed skills stay drafts until you
                      publish them.
                    </small>
                  </span>
                </label>
                <label className="field-label" htmlFor="learning-interval">
                  Minimum minutes between analyses
                </label>
                <input
                  id="learning-interval"
                  type="number"
                  min={5}
                  max={10080}
                  value={learningInterval}
                  disabled={!learningAuto}
                  onChange={(event) => setLearningInterval(event.target.value)}
                />
                <p className="muted">
                  Disabled by default (5 minutes to one week). Pausing the
                  workspace or a container stops automatic analysis; manual
                  analysis remains available. Learning never publishes a skill
                  without your approval.
                </p>
              </fieldset>
            )}
            {dialog.type === 'settings' && (
              <div className="config-note">
                <strong>Service setup</strong>
                <p>
                  {workspace.setup.missing.length ? (
                    <>
                      Add{' '}
                      {workspace.setup.missing.map((name, index) => (
                        <span key={name}>
                          {index > 0 && ', '}
                          <code>{name}</code>
                        </span>
                      ))}{' '}
                      to the server environment, then restart.
                    </>
                  ) : (
                    'Text configuration is present. A successful conversation confirms connectivity.'
                  )}
                </p>
                <p>
                  Slack: {workspace.setup.slack.replaceAll('_', ' ')}. Voice:{' '}
                  {workspace.setup.voice
                    ? 'configuration present'
                    : 'needs VOICE_API_KEY and VOICE_MODEL'}
                  . Conversations, approvals, and Learning state are stored in
                  the local SQLite database.
                </p>
                <p>
                  OpenDots sends no setup or usage telemetry, and no CopilotKit
                  Intelligence credentials are required.
                </p>
                <a href="/docs/SETUP.md" target="_blank" rel="noreferrer">
                  Setup guide ↗
                </a>
              </div>
            )}
            {dialog.type === 'memory' && (
              <p className="muted">
                Memories are explicit preferences, not automatic learning. Avoid
                secrets; enabled memories go to your model provider.
              </p>
            )}
            {error && (
              <p className="chat-error" role="alert">
                {error}
              </p>
            )}
            <button className="primary full" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            {dialog.type === 'dot' && dialog.dot && (
              <button
                type="button"
                className="text-button danger delete-dot"
                disabled={busy || workspace.dots.length <= 1}
                onClick={async () => {
                  const conversations = workspace.conversations.filter(
                    (conversation) => conversation.dotId === dialog.dot?.id,
                  ).length;
                  if (
                    !window.confirm(
                      `Delete ${dialog.dot?.name} and ${conversations} conversation${conversations === 1 ? '' : 's'}? This cannot be undone. Pages it saved stay in their Spaces.`,
                    )
                  )
                    return;
                  setBusy(true);
                  setError('');
                  const ok = await mutate(
                    `/dots/${dialog.dot?.id}`,
                    'DELETE',
                  ).catch(() => false);
                  setBusy(false);
                  if (ok) onClose();
                }}
              >
                Delete specialist
              </button>
            )}
          </form>
        )}
      </section>
    </div>
  );
}
