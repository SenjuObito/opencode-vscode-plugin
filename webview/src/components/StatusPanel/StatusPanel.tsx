import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileChangeSummary } from '../../types';
import { undoFileChanges, sendToJava, cardDebugLog } from '../../utils/bridge';
import { getFileName } from '../../utils/helpers';
import TodoList from './TodoList';
import SubagentList from './SubagentList';
import FileChangesList from './FileChangesList';
import UndoConfirmDialog from './UndoConfirmDialog';
import DiscardAllDialog from './DiscardAllDialog';
import type { TabType, StatusPanelProps } from './types';
import './StatusPanel.less';

const StatusPanel = ({ todos, fileChanges, subagents, subagentHistories, currentSessionId, currentProvider, sessionLoading = false, expanded = true, isStreaming = false, onUndoFile, onDiscardAll, onKeepAll }: StatusPanelProps) => {
  cardDebugLog('[StatusPanel] render, sessionLoading:', sessionLoading, 'expanded:', expanded);
  const { t } = useTranslation();
  const [openPopover, setOpenPopover] = useState<TabType | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Undo related state
  const [undoingFile, setUndoingFile] = useState<string | null>(null);
  const [confirmUndoFile, setConfirmUndoFile] = useState<FileChangeSummary | null>(null);

  // Discard All confirmation state
  const [confirmDiscardAll, setConfirmDiscardAll] = useState(false);
  const [isDiscardingAll, setIsDiscardingAll] = useState(false);

  const hasTodos = todos.length > 0;
  const hasFileChanges = fileChanges.length > 0;
  const hasSubagents = subagents.length > 0;

  // Calculate todo stats
  const { completedCount, totalCount, hasInProgressTodo } = useMemo(() => {
    const completed = todos.filter((todo) => todo.status === 'completed').length;
    const inProgress = todos.some((todo) => todo.status === 'in_progress');
    return { completedCount: completed, totalCount: todos.length, hasInProgressTodo: inProgress };
  }, [todos]);

  // Calculate subagent stats
  const { subagentCompletedCount, subagentTotalCount, hasRunningSubagent } = useMemo(() => {
    const completed = subagents.filter((s) => s.status === 'completed').length;
    const running = subagents.some((s) => s.status === 'running');
    return { subagentCompletedCount: completed, subagentTotalCount: subagents.length, hasRunningSubagent: running };
  }, [subagents]);

  // Calculate total file changes stats
  const { totalAdditions, totalDeletions } = useMemo(() => {
    return fileChanges.reduce(
      (acc, file) => ({
        totalAdditions: acc.totalAdditions + file.additions,
        totalDeletions: acc.totalDeletions + file.deletions,
      }),
      { totalAdditions: 0, totalDeletions: 0 }
    );
  }, [fileChanges]);

  // Close popover when collapsed
  useEffect(() => {
    if (!expanded) {
      setOpenPopover(null);
    }
  }, [expanded]);

  // Close popover when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setOpenPopover(null);
      }
    };

    if (openPopover) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [openPopover]);

  const handleTabClick = useCallback((tab: TabType) => {
    setOpenPopover((prev) => (prev === tab ? null : tab));
  }, []);

  // Undo handlers
  const handleUndoClick = useCallback((fileChange: FileChangeSummary) => {
    setConfirmUndoFile(fileChange);
  }, []);

  const handleConfirmUndo = useCallback(() => {
    if (!confirmUndoFile) return;

    const { filePath, operations } = confirmUndoFile;
    const safeStatus = confirmUndoFile.status === 'A' || confirmUndoFile.status === 'D'
      ? confirmUndoFile.status
      : 'M';

    setUndoingFile(filePath);
    setConfirmUndoFile(null);

    const ops = operations.map((op) => ({
      oldString: op.oldString,
      newString: op.newString,
      replaceAll: op.replaceAll,
    }));

    undoFileChanges(filePath, safeStatus, ops);
  }, [confirmUndoFile]);

  const handleCancelUndo = useCallback(() => {
    setConfirmUndoFile(null);
  }, []);

  // Discard All handlers
  const handleDiscardAllClick = useCallback(() => {
    setConfirmDiscardAll(true);
  }, []);

  const handleConfirmDiscardAll = useCallback(() => {
    // 仅撤销已完成的编辑；仍在进行中的（pending）编辑尚无确定内容，跳过。
    // 若所有编辑都还在进行中，则不发送空批次。
    const files = fileChanges
      .filter((fc) => !fc.pending)
      .map((fc) => ({
        filePath: fc.filePath,
        status: fc.status === 'A' || fc.status === 'D' ? fc.status : 'M',
        operations: fc.operations.map((op) => ({
          oldString: op.oldString,
          newString: op.newString,
          replaceAll: op.replaceAll,
        })),
      }));

    if (files.length === 0) return;

    setIsDiscardingAll(true);
    setConfirmDiscardAll(false);

    sendToJava('undo_all_file_changes', { files });
  }, [fileChanges]);

  const handleCancelDiscardAll = useCallback(() => {
    setConfirmDiscardAll(false);
  }, []);

  // Keep All handler
  const handleKeepAllClick = useCallback(() => {
    onKeepAll?.();
    window.addToast?.(t('statusPanel.keepAllSuccess'), 'success');
  }, [onKeepAll, t]);

  // Register undo result callback
  useEffect(() => {
    const handleUndoResult = (resultJson: string) => {
      try {
        const result = JSON.parse(resultJson);
        setUndoingFile(null);

        if (result.success) {
          onUndoFile?.(result.filePath);
          window.addToast?.(
            t('statusPanel.undoSuccess', { fileName: getFileName(result.filePath) }),
            'success'
          );
        } else {
          window.addToast?.(
            t('statusPanel.undoFailed', { error: result.error || 'Unknown error' }),
            'error'
          );
        }
      } catch {
        // JSON parse failed, reset state silently
        setUndoingFile(null);
      }
    };

    window.onUndoFileResult = handleUndoResult;
    return () => {
      delete window.onUndoFileResult;
    };
  }, [onUndoFile, t]);

  // Register batch undo result callback
  useEffect(() => {
    const handleUndoAllResult = (resultJson: string) => {
      try {
        const result = JSON.parse(resultJson) as {
          success?: boolean;
          undone?: string[];
          failed?: Array<{ filePath?: string; error?: string }>;
          error?: string;
        };
        setIsDiscardingAll(false);

        if (result.success) {
          onDiscardAll?.();
          window.addToast?.(t('statusPanel.discardAllSuccess'), 'success');
          return;
        }

        // 部分成功：已撤销的文件从面板移除，失败的如实提示并保留在列表中
        const failed = Array.isArray(result.failed) ? result.failed : [];
        if (failed.length > 0 && Array.isArray(result.undone)) {
          for (const filePath of result.undone) {
            onUndoFile?.(filePath);
          }
          window.addToast?.(
            t('statusPanel.discardAllPartial', {
              undone: result.undone.length,
              failed: failed.length,
              first: getFileName(failed[0]?.filePath ?? '') || (failed[0]?.error ?? ''),
            }),
            'warning'
          );
          return;
        }

        window.addToast?.(
          t('statusPanel.discardAllFailed', { error: result.error || 'Unknown error' }),
          'error'
        );
      } catch {
        // JSON parse failed, reset state silently
        setIsDiscardingAll(false);
      }
    };

    window.onUndoAllFileResult = handleUndoAllResult;
    return () => {
      delete window.onUndoAllFileResult;
    };
  }, [onDiscardAll, onUndoFile, t]);

  if (!expanded) {
    cardDebugLog('[StatusPanel] expanded is false, returning null (sessionLoading:', sessionLoading, ')');
    return null;
  }

  const renderPopoverContent = () => {
    switch (openPopover) {
      case 'todo':
        return <TodoList todos={todos} />;
      case 'subagent':
        return <SubagentList subagents={subagents} histories={subagentHistories} currentSessionId={currentSessionId} currentProvider={currentProvider} isStreaming={isStreaming} />;
      case 'files':
        return (
          <FileChangesList
            fileChanges={fileChanges}
            undoingFile={undoingFile}
            isDiscardingAll={isDiscardingAll}
            onUndoClick={handleUndoClick}
            onDiscardAllClick={handleDiscardAllClick}
            onKeepAllClick={handleKeepAllClick}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="status-panel" ref={popoverRef}>
      {/* Tab Header */}
      <div className="status-panel-tabs">
        {/* Todo Tab */}
        <div
          className={`status-panel-tab ${openPopover === 'todo' ? 'active' : ''}`}
          onClick={() => handleTabClick('todo')}
        >
          <span className="codicon codicon-checklist" />
          <span className="tab-label">{t('statusPanel.tasksTab')}</span>
          {hasTodos && (
            <span className="tab-progress">
              {completedCount}/{totalCount}
            </span>
          )}
          {isStreaming && hasInProgressTodo && (
            <span className="codicon codicon-loading status-panel-tab-loading" />
          )}
        </div>

        {/* Subagent Tab */}
        <div
          className={`status-panel-tab ${openPopover === 'subagent' ? 'active' : ''}`}
          onClick={() => handleTabClick('subagent')}
        >
          <span className="codicon codicon-hubot" />
          <span className="tab-label">{t('statusPanel.subagentTab')}</span>
          {hasSubagents && (
            <span className="tab-progress">
              {subagentCompletedCount}/{subagentTotalCount}
            </span>
          )}
          {isStreaming && hasRunningSubagent && (
            <span className="codicon codicon-loading status-panel-tab-loading" />
          )}
        </div>

        {/* File Changes Tab */}
        <div
          className={`status-panel-tab ${openPopover === 'files' ? 'active' : ''}`}
          onClick={() => handleTabClick('files')}
        >
          <span className="codicon codicon-edit" />
          <span className="tab-label">{t('statusPanel.editsTab')}</span>
          {hasFileChanges && (
            <span className="tab-stats">
              <span className="stat-additions">+{totalAdditions}</span>
              <span className="stat-deletions">-{totalDeletions}</span>
            </span>
          )}
        </div>
      </div>

      {/* Popover Content */}
      {openPopover && (
        <div className="status-panel-popover">
          {renderPopoverContent()}
        </div>
      )}

      {/* Dialogs */}
      <UndoConfirmDialog
        fileChange={confirmUndoFile}
        onConfirm={handleConfirmUndo}
        onCancel={handleCancelUndo}
      />
      <DiscardAllDialog
        visible={confirmDiscardAll}
        onConfirm={handleConfirmDiscardAll}
        onCancel={handleCancelDiscardAll}
      />
    </div>
  );
};

export default StatusPanel;
