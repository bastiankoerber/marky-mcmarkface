import {
  forwardRef,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type TextareaHTMLAttributes,
} from 'react';
import { completeMention, mentionQueryAt } from './mentionAutocomplete.js';

const MENTIONS = [{ login: 'copilot', label: 'GitHub Copilot', detail: 'AI coding agent' }] as const;

interface MentionTextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  value: string;
  onValueChange: (value: string) => void;
}

/** A normal controlled textarea with a lightweight GitHub-mention completion menu. */
export const MentionTextarea = forwardRef<HTMLTextAreaElement, MentionTextareaProps>(function MentionTextarea(
  { value, onValueChange, onKeyDown, onBlur, onSelect, ...props },
  forwardedRef,
) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);
  const listId = useId();

  const query = caret === null ? null : mentionQueryAt(value, caret);
  const suggestions = useMemo(
    () => (query ? MENTIONS.filter((mention) => mention.login.startsWith(query.query.toLowerCase())) : []),
    [query?.query],
  );
  const open = suggestions.length > 0;

  useLayoutEffect(() => {
    if (pendingCaret === null) return;
    const input = localRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(pendingCaret, pendingCaret);
    setCaret(pendingCaret);
    setPendingCaret(null);
  }, [pendingCaret, value]);

  const setRef = (input: HTMLTextAreaElement | null) => {
    localRef.current = input;
    if (typeof forwardedRef === 'function') forwardedRef(input);
    else if (forwardedRef) forwardedRef.current = input;
  };

  const choose = (login: string) => {
    if (!query) return;
    const completed = completeMention(value, query, login);
    setPendingCaret(completed.caret);
    onValueChange(completed.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && (event.key === 'Enter' || event.key === 'Tab')) {
      event.preventDefault();
      choose(suggestions[0]!.login);
      return;
    }
    if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      return;
    }
    if (open && event.key === 'Escape') {
      event.preventDefault();
      setCaret(null);
      return;
    }
    onKeyDown?.(event);
  };

  return (
    <div className="mention-composer">
      <textarea
        {...props}
        ref={setRef}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        aria-activedescendant={open ? `${listId}-copilot` : undefined}
        value={value}
        onChange={(event) => {
          setCaret(event.target.selectionStart);
          onValueChange(event.target.value);
        }}
        onSelect={(event) => {
          setCaret(event.currentTarget.selectionStart);
          onSelect?.(event);
        }}
        onBlur={(event) => {
          setCaret(null);
          onBlur?.(event);
        }}
        onKeyDown={handleKeyDown}
      />
      {open && (
        <div className="mention-menu" id={listId} role="listbox" aria-label="Mention someone">
          {suggestions.map((mention) => (
            <button
              className="mention-option"
              id={`${listId}-${mention.login}`}
              key={mention.login}
              type="button"
              role="option"
              aria-selected="true"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(mention.login)}
            >
              <span className="mention-avatar" aria-hidden="true">⌁</span>
              <span>
                <strong>@{mention.login}</strong>
                <small>{mention.label} · {mention.detail}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
