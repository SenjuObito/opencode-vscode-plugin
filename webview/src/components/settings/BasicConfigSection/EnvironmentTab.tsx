import styles from './style.module.less';
import { useTranslation } from 'react-i18next';

export interface EnvironmentTabProps {
  claudeCliPath?: string;
  onClaudeCliPathChange?: (path: string) => void;
  onSaveClaudeCliPath?: () => void;
  savingClaudeCliPath?: boolean;
  workingDirectory?: string;
  onWorkingDirectoryChange?: (dir: string) => void;
  onSaveWorkingDirectory?: () => void;
  savingWorkingDirectory?: boolean;
}

const EnvironmentTab = ({
  claudeCliPath = '',
  onClaudeCliPathChange = () => {},
  onSaveClaudeCliPath = () => {},
  savingClaudeCliPath = false,
  workingDirectory = '',
  onWorkingDirectoryChange = () => {},
  onSaveWorkingDirectory = () => {},
  savingWorkingDirectory = false,
}: EnvironmentTabProps) => {
  const { t } = useTranslation();

  return (
    <div className={styles.tabContent}>
      {/* Custom Claude CLI path */}
      <div className={styles.nodePathSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-rocket" />
          <span className={styles.fieldLabel}>{t('settings.basic.claudeCliPath.label')}</span>
        </div>
        <div className={styles.nodePathInputWrapper}>
          <input
            type="text"
            className={styles.nodePathInput}
            placeholder={t('settings.basic.claudeCliPath.placeholder')}
            value={claudeCliPath}
            onChange={(e) => onClaudeCliPathChange(e.target.value)}
          />
          <button
            className={styles.saveBtn}
            onClick={onSaveClaudeCliPath}
            disabled={savingClaudeCliPath}
          >
            {savingClaudeCliPath && (
              <span
                className="codicon codicon-loading codicon-modifier-spin"
              />
            )}
            {t('common.save')}
          </button>
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.basic.claudeCliPath.hint')}</span>
        </small>
      </div>

      {/* Working directory configuration */}
      <div className={styles.workingDirSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-folder" />
          <span className={styles.fieldLabel}>{t('settings.basic.workingDirectory.label')}</span>
        </div>
        <div className={styles.nodePathInputWrapper}>
          <input
            type="text"
            className={styles.nodePathInput}
            placeholder={t('settings.basic.workingDirectory.placeholder')}
            value={workingDirectory}
            onChange={(e) => onWorkingDirectoryChange(e.target.value)}
          />
          <button
            className={styles.saveBtn}
            onClick={onSaveWorkingDirectory}
            disabled={savingWorkingDirectory}
          >
            {savingWorkingDirectory && (
              <span
                className="codicon codicon-loading codicon-modifier-spin"
              />
            )}
            {t('common.save')}
          </button>
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>
            {t('settings.basic.workingDirectory.hint')}
          </span>
        </small>
      </div>
    </div>
  );
};

export default EnvironmentTab;
