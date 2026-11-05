import { useCallback, useEffect, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import type { Conversation, ConversationPage, Dot } from '../shared/types';
import { api } from './api';

/**
 * Conversation list with owner management.
 *
 * The list comes from the application-owned `/api/conversations` endpoint, which
 * supports keyset pagination, title/message search, and archived filtering.
 * Rename, archive/replace, and delete use the same endpoint family; the + button
 * keeps the original new-conversation flow.
 */
export function ThreadList({
  dots,
  selected,
  onSelect,
  onNew,
  onChanged,
  onConversationHidden,
  revision,
}: {
  dots: Dot[];
  selected?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onChanged: () => void;
  onConversationHidden: (id: string) => void;
  revision: number;
}) {
  const [items, setItems] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState<string>();

  const load = useCallback(
    async (reset: boolean, searchValue = search, archivedValue = archived) => {
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams({
          limit: '20',
          archived: String(archivedValue),
        });
        if (searchValue.trim()) params.set('q', searchValue.trim());
        if (!reset && cursor) params.set('cursor', cursor);
        const page = await api<ConversationPage>(
          `/conversations?${params.toString()}`,
          'GET',
        );
        setItems((current) =>
          reset ? page.conversations : [...current, ...page.conversations],
        );
        setCursor(page.nextCursor);
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : 'Conversations could not load. Check the server and retry.',
        );
      } finally {
        setLoading(false);
      }
    },
    [archived, cursor, search],
  );

  useEffect(() => {
    void load(true, search, archived);
    // `revision` changes when the workspace refreshes (new conversation, rename,
    // delete) so the sidebar reflects the owner API without a second store.
  }, [archived, revision]);

  const rename = async (conversation: Conversation) => {
    const title = window.prompt('Conversation title', conversation.title);
    if (!title?.trim() || title.trim() === conversation.title) return;
    try {
      await api(`/conversations/${conversation.id}`, 'PATCH', {
        title: title.trim(),
      });
      setMenu(undefined);
      onChanged();
      await load(true);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Conversation could not be renamed.',
      );
    }
  };

  const archive = async (conversation: Conversation) => {
    const next = !conversation.archived;
    try {
      await api(
        `/conversations/${conversation.id}/${next ? 'archive' : 'unarchive'}`,
        'POST',
        {},
      );
      setMenu(undefined);
      if (next) onConversationHidden(conversation.id);
      onChanged();
      await load(true);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Conversation could not be archived.',
      );
    }
  };

  const remove = async (conversation: Conversation) => {
    if (
      !window.confirm(
        'Delete this conversation and its full history? This cannot be undone.',
      )
    )
      return;
    try {
      await api(`/conversations/${conversation.id}`, 'DELETE');
      setMenu(undefined);
      onConversationHidden(conversation.id);
      onChanged();
      await load(true);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Conversation could not be deleted.',
      );
    }
  };

  return (
    <section className="thread-list">
      <div className="nav-label">
        {archived ? 'ARCHIVED CHATS' : 'RECENT CHATS'}
        <button
          className="icon-button"
          onClick={onNew}
          aria-label="New conversation"
        >
          <Plus size={14} />
        </button>
      </div>
      <form
        className="thread-search"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(query);
          void load(true, query, archived);
        }}
      >
        <input
          aria-label="Search conversations"
          placeholder="Search conversations"
          value={query}
          maxLength={200}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button className="icon-button" aria-label="Search">
          <Search size={13} />
        </button>
      </form>
      <button
        type="button"
        className="text-button thread-filter"
        onClick={() => {
          setArchived(!archived);
          setItems([]);
          setCursor(null);
        }}
      >
        {archived ? 'Back to recent chats' : 'Show archived'}
      </button>
      {error && (
        <p className="sidebar-error" role="alert">
          {error}
        </p>
      )}
      {items.map((thread) => (
        <div key={thread.id} className="thread-row">
          <button
            className={`nav-item ${selected === thread.id ? 'active' : ''}`}
            onClick={() => onSelect(thread.id)}
          >
            <MessageCircle size={15} />
            <span className="thread-summary">
              <span>{thread.title}</span>
              <small>{dots.find((dot) => dot.id === thread.dotId)?.name}</small>
            </span>
          </button>
          <button
            type="button"
            className="icon-button thread-menu-button"
            aria-label={`Manage ${thread.title}`}
            aria-expanded={menu === thread.id}
            onClick={() => setMenu(menu === thread.id ? undefined : thread.id)}
          >
            <MoreHorizontal size={14} />
          </button>
          {menu === thread.id && (
            <div className="thread-actions">
              <button
                type="button"
                className="text-button"
                onClick={() => void rename(thread)}
              >
                <Pencil size={12} /> Rename
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => void archive(thread)}
              >
                {thread.archived ? (
                  <>
                    <ArchiveRestore size={12} /> Restore
                  </>
                ) : (
                  <>
                    <Archive size={12} /> Archive
                  </>
                )}
              </button>
              <button
                type="button"
                className="text-button danger"
                onClick={() => void remove(thread)}
              >
                <Trash2 size={12} /> Delete
              </button>
            </div>
          )}
        </div>
      ))}
      {!items.length && !loading && (
        <p className="sidebar-empty">
          {search
            ? 'No conversations match that search.'
            : archived
              ? 'No archived conversations.'
              : 'Your first conversation will live here.'}
        </p>
      )}
      {loading && <p className="sidebar-empty">Loading conversations…</p>}
      {cursor && !loading && (
        <button
          type="button"
          className="text-button"
          onClick={() => void load(false)}
        >
          Load more conversations
        </button>
      )}
    </section>
  );
}
