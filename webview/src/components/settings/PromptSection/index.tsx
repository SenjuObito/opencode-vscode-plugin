import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sendBridgeEvent } from '../../../utils/bridge';
import styles from './style.module.less';

/**
 * Opencode-native command ("prompt") management.
 *
 * Commands are markdown files in the official opencode layout:
 *   global:  ~/.config/opencode/command/<name>.md
 *   project: <projectRoot>/.opencode/command/<name>.md
 * Frontmatter carries description / agent / model / subtask; $ARGUMENTS is
 * substituted by opencode at run time. The Java CommandsHandler owns the
 * filesystem; this component only talks bridge messages.
 */


declare global {
  interface Window {
    onCommandsList?: (json: string) => void;
    onCommandsRead?: (json: string) => void;
    onCommandsSaved?: (json: string) => void;
    onCommandsDeleted?: (json: string) => void;
    __onCommandsList?: (json: string) => void;
    __onCommandsRead?: (json: string) => void;
    __onCommandsSaved?: (json: string) => void;
    __onCommandsDeleted?: (json: string) => void;
  }
}

type Scope = 'global' | 'project';

interface CommandEntry {
  name: string;
  fileName: string;
  description?: string;
  agent?: string;
  model?: string;
  lastModified?: number;
}

interface CommandTemplate {
  id: string;
  descriptionKey: string;
  content: string;
}

const COMMAND_TEMPLATES: CommandTemplate[] = [
  {
    id: 'review',
    descriptionKey: 'settings.commands.templates.review',
    content: `---
description: Review the current changes for bugs and style issues
agent: build
---

Review the current git diff. Focus on:
1. Correctness and edge cases
2. Security issues
3. Readability and naming

Report findings as a numbered list with file references. $ARGUMENTS`,
  },
  {
    id: 'explain',
    descriptionKey: 'settings.commands.templates.explain',
    content: `---
description: Explain a file or symbol in plain language
agent: build
---

Explain the following code in plain language, including its responsibility,
inputs/outputs and edge cases. $ARGUMENTS`,
  },
  {
    id: 'tests',
    descriptionKey: 'settings.commands.templates.tests',
    content: `---
description: Generate unit tests for the target code
agent: build
---

Write thorough unit tests for $ARGUMENTS. Cover happy paths, boundary values
and error handling. Follow the existing test style of this project.`,
  },
  {
    id: 'refactor',
    descriptionKey: 'settings.commands.templates.refactor',
    content: `---
description: Refactor the target code without changing behaviour
agent: build
---

Refactor $ARGUMENTS to improve readability and structure while keeping
behaviour identical. Explain the motivation for each change.`,
  },
  {
    id: 'commit',
    descriptionKey: 'settings.commands.templates.commit',
    content: `---
description: Generate a conventional commit message for staged changes
agent: build
---

Look at the staged diff and write a single conventional-commit message
(type(scope): subject) followed by an optional body. Output the message only.`,
  },
];

const ListRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
  borderBottom: '1px solid var(--border-color, rgba(128,128,128,0.2))',
};
const NameStyle: React.CSSProperties = { fontWeight: 600, minWidth: 140 };
const DescStyle: React.CSSProperties = { flex: 1, opacity: 0.75, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const TagStyle: React.CSSProperties = {
  fontSize: 11, padding: '1px 6px', borderRadius: 8,
  background: 'rgba(128,128,128,0.15)',
};
const LinkButtonStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--link-color, #4c8dff)',
  cursor: 'pointer', padding: '2px 6px', fontSize: 12,
};
const AreaStyle: React.CSSProperties = {
  width: '100%', minHeight: 320, fontFamily: 'monospace', fontSize: 12,
  padding: 8, resize: 'vertical',
};

const PromptSection = () => {
  const { t } = useTranslation();
  const [scope, setScope] = useState<Scope>('global');
  const [commands, setCommands] = useState<CommandEntry[]>([]);
  const [dir, setDir] = useState('');
  const [editor, setEditor] = useState<{ open: boolean; name: string; original: string; content: string }>({
    open: false, name: '', original: '', content: '',
  });
  const [showLibrary, setShowLibrary] = useState(false);

  const refresh = useCallback((targetScope: Scope) => {
    sendBridgeEvent('commands_list', JSON.stringify({ scope: targetScope }));
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      try {
        const data = JSON.parse(detail);
        if (data.scope && data.scope !== scope) {
          return;
        }
        if (Array.isArray(data.commands)) {
          setCommands(data.commands);
          setDir(data.dir || '');
        }
      } catch { /* ignore */ }
    };
    window.addEventListener('on-commands-list', handler as EventListener);
    const onList = (json: string) => {
      window.dispatchEvent(new CustomEvent('on-commands-list', { detail: json }));
    };
    const onSaved = (json: string) => {
      try {
        const data = JSON.parse(json);
        sendBridgeEvent('commands_list', JSON.stringify({ scope: data.scope || scope }));
      } catch {
        sendBridgeEvent('commands_list', JSON.stringify({ scope }));
      }
    };
    const onDeleted = (json: string) => {
      try {
        const data = JSON.parse(json);
        sendBridgeEvent('commands_list', JSON.stringify({ scope: data.scope || scope }));
      } catch {
        sendBridgeEvent('commands_list', JSON.stringify({ scope }));
      }
    };

    window.onCommandsList = onList;
    window.__onCommandsList = onList;
    window.onCommandsSaved = onSaved;
    window.__onCommandsSaved = onSaved;
    window.onCommandsDeleted = onDeleted;
    window.__onCommandsDeleted = onDeleted;

    return () => {
      window.removeEventListener('on-commands-list', handler as EventListener);
      window.onCommandsList = undefined;
      window.__onCommandsList = undefined;
      window.onCommandsSaved = undefined;
      window.__onCommandsSaved = undefined;
      window.onCommandsDeleted = undefined;
      window.__onCommandsDeleted = undefined;
    };
  }, [scope]);

  useEffect(() => {
    refresh(scope);
  }, [scope, refresh]);

  const openEditor = (name: string) => {
    const handler = (event: Event) => {
      window.removeEventListener('on-commands-read', handler as EventListener);
      const data = JSON.parse((event as CustomEvent<string>).detail);
      setEditor({ open: true, name, original: data.exists ? name : '', content: data.content || '' });
    };
    window.addEventListener('on-commands-read', handler as EventListener);
    const onRead = (json: string) => {
      window.dispatchEvent(new CustomEvent('on-commands-read', { detail: json }));
    };
    window.onCommandsRead = onRead;
    window.__onCommandsRead = onRead;
    sendBridgeEvent('commands_read', JSON.stringify({ scope, name }));
  };

  const save = () => {
    sendBridgeEvent('commands_save', JSON.stringify({
      scope, name: editor.name, originalName: editor.original, content: editor.content,
    }));
    setEditor({ open: false, name: '', original: '', content: '' });
  };

  const remove = (name: string) => {
    if (!window.confirm(t('settings.commands.confirmDelete', { name }))) {
      return;
    }
    sendBridgeEvent('commands_delete', JSON.stringify({ scope, name }));
  };

  const importTemplate = (tpl: CommandTemplate) => {
    setEditor({ open: true, name: tpl.id, original: '', content: tpl.content });
    setShowLibrary(false);
  };

  return (
    <div className={styles.promptSection}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <h3 style={{ margin: 0, flex: 1 }}>{t('settings.commands.title')}</h3>
        <button style={LinkButtonStyle} onClick={() => setShowLibrary((v) => !v)}>
          {t('settings.commands.library')}
        </button>
        <button style={LinkButtonStyle} onClick={() => openEditor(t('settings.commands.newName'))}>
          + {t('settings.commands.new')}
        </button>
      </div>

      <p style={{ marginTop: 0, opacity: 0.7, fontSize: 12 }}>
        {t('settings.commands.description')}
      </p>

      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {(['global', 'project'] as Scope[]).map((s) => (
          <button
            key={s}
            style={{
              ...TagStyle,
              cursor: 'pointer',
              outline: s === scope ? '1px solid var(--link-color, #4c8dff)' : 'none',
            }}
            onClick={() => setScope(s)}
          >
            {t(`settings.commands.scope.${s}`)}
            {s === 'project' ? ' (.opencode/command)' : ' (~/.config/opencode/command)'}
          </button>
        ))}
      </div>

      {showLibrary && (
        <div style={{ border: '1px solid rgba(128,128,128,0.3)', borderRadius: 6, padding: 10, marginBottom: 12 }}>
          <strong>{t('settings.commands.libraryTitle')}</strong>
          {COMMAND_TEMPLATES.map((tpl) => (
            <div key={tpl.id} style={ListRowStyle}>
              <span style={NameStyle}>{tpl.id}</span>
              <span style={DescStyle}>{t(tpl.descriptionKey)}</span>
              <button style={LinkButtonStyle} onClick={() => importTemplate(tpl)}>
                {t('settings.commands.import')}
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ border: '1px solid rgba(128,128,128,0.3)', borderRadius: 6 }}>
        {commands.length === 0 && (
          <div style={{ padding: 16, opacity: 0.6 }}>{t('settings.commands.empty')}</div>
        )}
        {commands.map((cmd) => (
          <div key={cmd.name} style={ListRowStyle}>
            <span style={NameStyle}>{cmd.name}</span>
            {cmd.agent && <span style={TagStyle}>{cmd.agent}</span>}
            <span style={DescStyle}>{cmd.description}</span>
            <button style={LinkButtonStyle} onClick={() => openEditor(cmd.name)}>
              {t('settings.commands.edit')}
            </button>
            <button style={LinkButtonStyle} onClick={() => remove(cmd.name)}>
              {t('settings.commands.delete')}
            </button>
          </div>
        ))}
      </div>

      {dir && (
        <p style={{ fontSize: 11, opacity: 0.5 }}>{dir}</p>
      )}

      {editor.open && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20000,
        }}>
          <div style={{
            background: 'var(--bg-color, #1e1e1e)', color: 'inherit', borderRadius: 8,
            padding: 16, width: 'min(760px, 90vw)', maxHeight: '85vh', overflow: 'auto',
          }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <strong>{t('settings.commands.editorTitle')}</strong>
              <input
                value={editor.name}
                onChange={(e) => setEditor((s) => ({ ...s, name: e.target.value }))}
                placeholder={t('settings.commands.namePlaceholder')}
                style={{ flex: 1, padding: '4px 8px' }}
              />
            </div>
            <textarea
              style={AreaStyle}
              value={editor.content}
              onChange={(e) => setEditor((s) => ({ ...s, content: e.target.value }))}
              spellCheck={false}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
              <button onClick={() => setEditor({ open: false, name: '', original: '', content: '' })}>
                {t('common.cancel')}
              </button>
              <button
                style={{ background: '#4c8dff', color: '#fff', border: 'none', padding: '4px 14px', borderRadius: 4 }}
                onClick={save}
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PromptSection;
