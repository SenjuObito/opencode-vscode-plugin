import { useTranslation } from 'react-i18next';
import ConfirmDialog from './ConfirmDialog';
import PlanApprovalDialog from './PlanApprovalDialog';
import CustomModelDialog from './settings/CustomModelDialog';
import { usePluginModels } from './settings/hooks/usePluginModels';
import { STORAGE_KEYS } from '../types/provider';
import { useDialogs } from '../contexts/DialogContext';
import { useUIState } from '../contexts/UIStateContext';
import ContextUsageDialog from './ContextUsageDialog';
import PermissionDialog from './PermissionDialog';
import AskUserQuestionDialog from './AskUserQuestionDialog';
import { DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS } from '../utils/permissionDialogTimeout';

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
  showInterruptConfirm: boolean;
  onConfirmInterrupt: () => void;
  onCancelInterrupt: () => void;
  /** Permission dialog timeout in seconds (from backend config). */
  permissionDialogTimeoutSeconds?: number;
}

/**
 * Renders all top-level dialogs.
 * Permission / ask-user / plan / add-model state is read
 * from DialogContext and UIStateContext directly to avoid prop drilling 25+
 * fields from App.tsx (stage 4-5 of TASK-P1-01).
 */
export const AppDialogs = ({
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
    handlePermissionApprove, handlePermissionApproveAlways, handlePermissionSkip, handlePermissionTimeout,
    askUserQuestionDialogOpen, currentAskUserQuestionRequest,
    handleAskUserQuestionSubmit, handleAskUserQuestionSkip, handleAskUserQuestionTimeout,
  } = useDialogs();
  const {
    addModelDialogOpen, setAddModelDialogOpen,
  } = useUIState();

  return (
    <>
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
        onTimeout={handlePermissionTimeout}
        timeoutSeconds={permissionDialogTimeoutSeconds}
      />
      <AskUserQuestionDialog
        isOpen={askUserQuestionDialogOpen}
        request={currentAskUserQuestionRequest}
        onSubmit={handleAskUserQuestionSubmit}
        onCancel={handleAskUserQuestionSkip}
        onTimeout={handleAskUserQuestionTimeout}
        timeoutSeconds={permissionDialogTimeoutSeconds}
      />
      <PlanApprovalDialog
        isOpen={planApprovalDialogOpen}
        request={currentPlanApprovalRequest}
        onApprove={handlePlanApprovalApprove}
        onReject={handlePlanApprovalReject}
        timeoutSeconds={permissionDialogTimeoutSeconds}
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
