// SettingsDialogs.tsx
// opencode-only: the Claude/Codex provider dialogs and their delete-confirm
// dialogs have been removed together with their management hooks. Only the
// alert and agent dialogs remain.
import { useTranslation } from 'react-i18next';
import type { AgentConfig } from '../../types/agent';
import AlertDialog from '../AlertDialog';
import type { AlertType } from '../AlertDialog';
import ConfirmDialog from '../ConfirmDialog';
import AgentDialog from '../AgentDialog';
import AgentExportDialog from './AgentSection/AgentExportDialog';
import AgentImportConfirmDialog from './AgentSection/AgentImportConfirmDialog';
import type { AgentDialogState, DeleteAgentConfirmState, ExportDialogState as AgentExportDialogState, ImportPreviewDialogState as AgentImportPreviewDialogState } from './hooks/useAgentManagement';
import type { ConflictStrategy } from '../../types/import';

interface SettingsDialogsProps {
  // Alert dialog
  alertDialog: { isOpen: boolean; type: AlertType; title: string; message: string };
  onCloseAlert: () => void;

  // Agent dialog
  agentDialog: AgentDialogState;
  deleteAgentConfirm: DeleteAgentConfirmState;
  onCloseAgentDialog: () => void;
  onSaveAgent: (data: { name: string; prompt: string }) => void;
  onConfirmDeleteAgent: () => void;
  onCancelDeleteAgent: () => void;

  // Agent import/export
  agentExportDialog: AgentExportDialogState;
  agentImportPreviewDialog: AgentImportPreviewDialogState;
  agents: AgentConfig[];
  onCloseAgentExportDialog: () => void;
  onConfirmAgentExport: (selectedIds: string[]) => void;
  onCloseAgentImportPreview: () => void;
  onSaveImportedAgents: (selectedIds: string[], strategy: ConflictStrategy) => void;

  // Note: Prompt dialogs are now handled in PromptSection component
}

const SettingsDialogs = ({
  alertDialog,
  onCloseAlert,
  agentDialog,
  deleteAgentConfirm,
  onCloseAgentDialog,
  onSaveAgent,
  onConfirmDeleteAgent,
  onCancelDeleteAgent,
  agentExportDialog,
  agentImportPreviewDialog,
  agents,
  onCloseAgentExportDialog,
  onConfirmAgentExport,
  onCloseAgentImportPreview,
  onSaveImportedAgents,
}: SettingsDialogsProps) => {
  const { t } = useTranslation();

  return (
    <>
      {/* In-page alert dialog */}
      <AlertDialog
        isOpen={alertDialog.isOpen}
        type={alertDialog.type}
        title={alertDialog.title}
        message={alertDialog.message}
        onClose={onCloseAlert}
      />

      {/* Agent add/edit dialog */}
      <AgentDialog
        isOpen={agentDialog.isOpen}
        agent={agentDialog.agent}
        onClose={onCloseAgentDialog}
        onSave={onSaveAgent}
      />

      {/* Agent delete confirmation dialog */}
      <ConfirmDialog
        isOpen={deleteAgentConfirm.isOpen}
        title={t('settings.agent.deleteConfirmTitle')}
        message={t('settings.agent.deleteConfirmMessage', { name: deleteAgentConfirm.agent?.name || '' })}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        onConfirm={onConfirmDeleteAgent}
        onCancel={onCancelDeleteAgent}
      />

      {/* Note: Prompt dialogs are now rendered in PromptSection component */}

      {/* Agent export dialog */}
      {agentExportDialog.isOpen && (
        <AgentExportDialog
          agents={agents}
          onConfirm={onConfirmAgentExport}
          onCancel={onCloseAgentExportDialog}
        />
      )}

      {/* Agent import preview dialog */}
      {agentImportPreviewDialog.isOpen && agentImportPreviewDialog.previewData && (
        <AgentImportConfirmDialog
          previewData={agentImportPreviewDialog.previewData}
          onConfirm={onSaveImportedAgents}
          onCancel={onCloseAgentImportPreview}
        />
      )}

      {/* Note: Prompt import/export dialogs are now rendered in PromptSection component */}
    </>
  );
};

export default SettingsDialogs;
