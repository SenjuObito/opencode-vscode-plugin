import React, {useCallback, useEffect, useMemo, useState} from 'react';
import MarkdownBlock from './MarkdownBlock';
import {useDialogResize} from '../hooks/useDialogResize';
import {isEditableEventTarget} from '../utils/isEditableEventTarget';
import {formatCountdown} from '../utils/helpers';
import {useDialogCountdownTimeout} from '../hooks/useDialogCountdownTimeout';
import {useTranslation} from 'react-i18next';
import {DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS} from '../utils/permissionDialogTimeout';
import './PermissionDialog.css';

export interface PermissionRequest {
  channelId: string;
  toolName: string;
  inputs: Record<string, unknown>;
  suggestions?: string[];
}

interface PermissionDialogProps {
  isOpen: boolean;
  request: PermissionRequest | null;
  onApprove: (channelId: string) => void;
  onSkip: (channelId: string) => void;
  onApproveAlways?: (channelId: string) => void;
  timeoutSeconds?: number;
}

const formatInputValue = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => formatInputValue(item)).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
    return JSON.stringify(value, null, 2);
  }
  return String(value);
};

const getCommandContent = (inputs: Record<string, unknown>): string => {
  if ('command' in inputs && inputs.command !== undefined) {
    return formatInputValue(inputs.command);
  }
  if ('content' in inputs && inputs.content !== undefined) {
    return formatInputValue(inputs.content);
  }
  if ('text' in inputs && inputs.text !== undefined) {
    return formatInputValue(inputs.text);
  }
  return Object.entries(inputs)
    .filter(([key]) => !key.startsWith('_'))
    .map(([key, value]) => `${key}: ${formatInputValue(value)}`)
    .join('\n');
};

const getWorkingDirectory = (inputs: Record<string, unknown>): string => {
  if (typeof inputs.cwd === 'string' && inputs.cwd) return inputs.cwd;
  if (typeof inputs.file_path === 'string' && inputs.file_path) return inputs.file_path;
  if (typeof inputs.path === 'string' && inputs.path) return inputs.path;
  return '~';
};

const PermissionDialog: React.FC<PermissionDialogProps> = ({
  isOpen,
  request,
  onApprove,
  onSkip,
  onApproveAlways,
  timeoutSeconds = DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS,
}) => {
  const [showCommand, setShowCommand] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const {t} = useTranslation();
  const {dialogRef, dialogHeight, setDialogHeight, handleResizeStart} = useDialogResize({minHeight: 150});

  const submittedRef = React.useRef(false);

  const handleTimeout = useCallback(() => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    if (request) onSkip(request.channelId);
  }, [request, onSkip]);

  const {remainingSeconds, isTimeWarning, markSubmitted} = useDialogCountdownTimeout({
    isOpen,
    requestKey: request?.channelId,
    timeoutSeconds,
    onTimeout: handleTimeout,
  });

  const handleApprove = useCallback(() => {
    if (!request || !markSubmitted()) return;
    onApprove(request.channelId);
  }, [request, markSubmitted, onApprove]);

  const handleApproveAlways = useCallback(() => {
    if (!request || !markSubmitted()) return;
    if (onApproveAlways) {
      onApproveAlways(request.channelId);
    } else {
      onApprove(request.channelId);
    }
  }, [request, markSubmitted, onApproveAlways, onApprove]);

  const handleSkip = useCallback(() => {
    if (!request || submittedRef.current) return;
    submittedRef.current = true;
    onSkip(request.channelId);
  }, [request, onSkip]);

  useEffect(() => {
    if (isOpen && request) {
      submittedRef.current = false;
      setShowCommand(true);
      setSelectedIndex(0);
      setDialogHeight(null);
    }
  }, [isOpen, request?.channelId, setDialogHeight]);

  useEffect(() => {
    if (!isOpen || !request) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEditableEventTarget(e.target)) return;
      if (e.key === '1') {
        handleApprove();
      } else if (e.key === '2') {
        handleApproveAlways();
      } else if (e.key === '3') {
        handleSkip();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(2, prev + 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedIndex === 0) handleApprove();
        else if (selectedIndex === 1) handleApproveAlways();
        else if (selectedIndex === 2) handleSkip();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, request, handleApprove, handleApproveAlways, handleSkip, selectedIndex]);

  const commandContent = useMemo(
    () => (request ? getCommandContent(request.inputs) : ''),
    [request],
  );
  const workingDirectory = useMemo(
    () => (request ? getWorkingDirectory(request.inputs) : '~'),
    [request],
  );

  if (!isOpen || !request) return null;

  const getToolTitle = (toolName: string): string => {
    const key = `permission.tools.${toolName}`;
    const translated = t(key);
    if (translated === key) {
      return t('permission.tools.execute', {toolName});
    }
    return translated;
  };

  return (
    <div
      className={`permission-dialog-overlay ${isTimeWarning ? 'warning-mode' : ''}`}
    >
      <div
        ref={dialogRef}
        className="permission-dialog-v3"
        style={dialogHeight ? {height: dialogHeight, maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' as const} : undefined}
      >
        <div className="permission-dialog-v3-resize-handle" onPointerDown={handleResizeStart} />
        <div className="permission-dialog-v3-header-row">
          <h3 className="permission-dialog-v3-title">{getToolTitle(request.toolName)}</h3>
          <span className={`countdown-timer ${isTimeWarning ? 'warning' : ''}`}>
            <span className="codicon codicon-clock" />
            <span className="countdown-time">{formatCountdown(remainingSeconds)}</span>
          </span>
        </div>
        <p className="permission-dialog-v3-subtitle">{t('permission.fromExternalProcess', '来自外部进程的请求')}</p>

        <div className="permission-dialog-v3-command-box">
          <div className="permission-dialog-v3-command-header">
            <span className="command-path">
              <span className="command-arrow">→</span> ~ {workingDirectory}
            </span>
            <button
              className="command-toggle"
              onClick={() => setShowCommand(!showCommand)}
              title={showCommand ? t('chat.collapse', '收起') : t('chat.expand', '展开')}
            >
              <span className={`codicon codicon-chevron-${showCommand ? 'up' : 'down'}`} />
            </button>
          </div>
          {showCommand && (
            <div
              className="permission-dialog-v3-command-content"
              style={dialogHeight ? {maxHeight: 'none'} : undefined}
            >
              <MarkdownBlock content={commandContent} isStreaming={false} />
            </div>
          )}
        </div>

        <div className="permission-dialog-v3-options">
          <button
            className={`permission-dialog-v3-option ${selectedIndex === 0 ? 'selected' : ''}`}
            onClick={handleApprove}
            onMouseEnter={() => setSelectedIndex(0)}
          >
            <span className="option-text">{t('permission.allow', '允许一次')}</span>
            <span className="option-key">1</span>
          </button>
          {onApproveAlways && (
            <button
              className={`permission-dialog-v3-option ${selectedIndex === 1 ? 'selected' : ''}`}
              onClick={handleApproveAlways}
              onMouseEnter={() => setSelectedIndex(1)}
            >
              <span className="option-text">{t('permission.allowAlways', '总是允许')}</span>
              <span className="option-key">2</span>
            </button>
          )}
          <button
            className={`permission-dialog-v3-option ${selectedIndex === (onApproveAlways ? 2 : 1) ? 'selected' : ''}`}
            onClick={handleSkip}
            onMouseEnter={() => setSelectedIndex(onApproveAlways ? 2 : 1)}
          >
            <span className="option-text">{t('permission.deny', '拒绝')}</span>
            <span className="option-key">{onApproveAlways ? '3' : '2'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default PermissionDialog;
