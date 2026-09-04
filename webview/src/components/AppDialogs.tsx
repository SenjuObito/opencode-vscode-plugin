import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from './ConfirmDialog';
import PlanApprovalDialog from './PlanApprovalDialog';
import ChangelogDialog from './ChangelogDialog';
import CustomModelDialog from './settings/CustomModelDialog';
import { usePluginModels } from './settings/hooks/usePluginModels';
import { STORAGE_KEYS } from '../types/provider';
import { fetchGithubReleases, clearReleasesCache } from '../version/githubReleases';
import { CHANGELOG_DATA, type ChangelogEntry } from '../version/changelog';
import { useDialogs } from '../contexts/DialogContext';
import { useUIState } from '../contexts/UIStateContext';
import ContextUsageDialog from './ContextUsageDialog';
import PermissionDialog from './PermissionDialog';
import AskUserQuestionDialog from './AskUserQuestionDialog';
import { DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS } from '../utils/permissionDialogTimeout';
import { setSkipNewSessionConfirm } from '../utils/skipNewSessionConfirm';

/**
 * Wrapper that manages plugin-level custom models for the add-model dialog.
 * Uses the shared usePluginModels hook for localStorage persistence.
 */
const AddModelDialogWrapper = ({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) => {
  // opencode-only: custom models always live under a single storage key. The
  // previous Codex branch (CODEX_CUSTOM_MODELS + context window toggle) is gone.
  const { models, updateModels } = usePluginModels(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS);
  return (
    <CustomModelDialog
      isOpen={isOpen}
      models={models}
      onModelsChange={updateModels}
      onClose={onClose}
      contextWindowEnabled={false}
      initialAddMode
    />
  );
};

export interface AppDialogsProps {
  /** Session-management dialogs come from useSessionManagement, still passed as props. */
  showNewSessionConfirm: boolean;
  onConfirmNewSession: () => void;
  onCancelNewSession: () => void;
  showInterruptConfirm: boolean;
  onConfirmInterrupt: () => void;
  onCancelInterrupt: () => void;
  /** Permission dialog timeout in seconds (from backend config). */
  permissionDialogTimeoutSeconds?: number;
}

/**
 * Renders all top-level dialogs.
 * Permission / ask-user / plan / changelog / add-model state is read
 * from DialogContext and UIStateContext directly to avoid prop drilling 25+
 * fields from App.tsx (stage 4-5 of TASK-P1-01).
 */
export const AppDialogs = ({
  showNewSessionConfirm,
  onConfirmNewSession,
  onCancelNewSession,
  showInterruptConfirm,
  onConfirmInterrupt,
  onCancelInterrupt,
  permissionDialogTimeoutSeconds = DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS,
}: AppDialogsProps) => {
  const { t } = useTranslation();
  const {
    planApprovalDialogOpen, currentPlanApprovalRequest,
    handlePlanApprovalApprove, handlePlanApprovalReject,
    contextUsageDialogOpen, contextUsageIsLoading, contextUsageData, closeContextUsageDialog,
    permissionDialogOpen, currentPermissionRequest,
    handlePermissionApprove, handlePermissionApproveAlways, handlePermissionSkip,
    askUserQuestionDialogOpen, currentAskUserQuestionRequest,
    handleAskUserQuestionSubmit, handleAskUserQuestionSkip,
  } = useDialogs();
  const {
    showChangelogDialog, closeChangelogDialog,
    addModelDialogOpen, setAddModelDialogOpen,
  } = useUIState();

  // "Don't ask again" checkbox state for the new-session confirm dialog.
  // Resets to unchecked every time the dialog re-opens so the user re-affirms
  // intent each time they want to silence it.
  const [skipNewSessionAgain, setSkipNewSessionAgain] = useState(false);
  useEffect(() => {
    if (showNewSessionConfirm) {
      setSkipNewSessionAgain(false);
    }
  }, [showNewSessionConfirm]);

  // First-start / version-update changelog: fetch the latest releases from the
  // configured GitHub repository, then fall back to the bundled CHANGELOG_DATA
  // when the network is unavailable or the repo has no releases yet. The user
  // always sees content — never a red error banner.
  // Start empty: the repo may legitimately have no releases, and the dialog
  // must never index into a list we have not loaded yet.
  const [changelogEntries, setChangelogEntries] = useState<ChangelogEntry[]>([]);
  // Seed loading from the dialog's initial visibility so the first paint shows
  // the spinner rather than a flash of the empty state.
  const [changelogLoading, setChangelogLoading] = useState(() => showChangelogDialog);
  const [changelogError, setChangelogError] = useState<string | null>(null);
  useEffect(() => {
    if (!showChangelogDialog) return;
    // The cached list may be stale after an update; clear it once per dialog
    // open so the user sees the latest releases.
    clearReleasesCache();
    setChangelogLoading(true);
    setChangelogError(null);
    fetchGithubReleases()
      .then((result) => {
        // Prefer the freshly-fetched GitHub releases. If the request failed or
        // the repo has no releases yet, fall back to the bundled local
        // CHANGELOG_DATA so the user always sees content instead of an error.
        if (result.entries.length > 0) {
          setChangelogEntries(result.entries);
        } else {
          if (result.error && !result.empty) {
            // eslint-disable-next-line no-console -- network diagnostics
            console.warn('Falling back to bundled changelog:', result.error);
          }
          setChangelogEntries(CHANGELOG_DATA);
        }
        // No error banner — the fallback covers the failure path.
        setChangelogError(null);
      })
      .catch((err) => {
        // Same fallback for unexpected exceptions (e.g. localStorage quota,
        // pre-abort errors). The dialog still renders local content.
        // eslint-disable-next-line no-console -- network diagnostics
        console.warn('Falling back to bundled changelog:', err);
        setChangelogEntries(CHANGELOG_DATA);
        setChangelogError(null);
      })
      .finally(() => {
        setChangelogLoading(false);
      });
  }, [showChangelogDialog]);

  const handleConfirmNewSessionWithSkip = () => {
    if (skipNewSessionAgain) {
      // Persist before navigating away — listeners (settings page) sync automatically.
      setSkipNewSessionConfirm(true);
    }
    onConfirmNewSession();
  };
  // Note: We deliberately do NOT persist the "don't ask again" checkbox when the
  // user cancels the dialog. A cancelled dialog means they did not intend the
  // destructive action AND did not intend to change the preference. The state is
  // discarded via the useEffect above on next open.

  return (
    <>
      <ConfirmDialog
        isOpen={showNewSessionConfirm}
        title={t('chat.createNewSession')}
        message={t('chat.confirmNewSession')}
        confirmText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onConfirm={handleConfirmNewSessionWithSkip}
        onCancel={onCancelNewSession}
      >
        <label className="confirm-dialog-dont-ask-again">
          <input
            type="checkbox"
            checked={skipNewSessionAgain}
            onChange={(e) => setSkipNewSessionAgain(e.target.checked)}
          />
          <span>{t('common.dontAskAgain')}</span>
        </label>
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={showInterruptConfirm}
        title={t('chat.createNewSession')}
        message={t('chat.confirmInterrupt')}
        confirmText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onConfirm={onConfirmInterrupt}
        onCancel={onCancelInterrupt}
      />
      {/* Permission + AskUserQuestion now render as top-level popups (mirrors cc-gui). */}
      <PermissionDialog
        isOpen={permissionDialogOpen}
        request={currentPermissionRequest}
        onApprove={handlePermissionApprove}
        onApproveAlways={handlePermissionApproveAlways}
        onSkip={handlePermissionSkip}
        timeoutSeconds={permissionDialogTimeoutSeconds}
      />
      <AskUserQuestionDialog
        isOpen={askUserQuestionDialogOpen}
        request={currentAskUserQuestionRequest}
        onSubmit={handleAskUserQuestionSubmit}
        onCancel={handleAskUserQuestionSkip}
        timeoutSeconds={permissionDialogTimeoutSeconds}
      />
      <PlanApprovalDialog
        isOpen={planApprovalDialogOpen}
        request={currentPlanApprovalRequest}
        onApprove={handlePlanApprovalApprove}
        onReject={handlePlanApprovalReject}
        timeoutSeconds={permissionDialogTimeoutSeconds}
      />
      <ChangelogDialog
        isOpen={showChangelogDialog}
        onClose={closeChangelogDialog}
        entries={changelogEntries}
        loading={changelogLoading}
        error={changelogError ?? undefined}
      />
      <AddModelDialogWrapper
        isOpen={addModelDialogOpen}
        onClose={() => setAddModelDialogOpen(false)}
      />
      {contextUsageDialogOpen ? (
        <ContextUsageDialog
          isOpen={contextUsageDialogOpen}
          isLoading={contextUsageIsLoading}
          data={contextUsageData}
          onClose={closeContextUsageDialog}
        />
      ) : null}
    </>
  );
};
