import styles from './style.module.less';
import { useTranslation } from 'react-i18next';

export interface EnvironmentTabProps {
  opencodeCliPath?: string;
  onOpencodeCliPathChange?: (path: string) => void;
  onSaveOpencodeCliPath?: () => void;
  savingOpencodeCliPath?: boolean;
  workingDirectory?: string;
  onWorkingDirectoryChange?: (dir: string) => void;
  onSaveWorkingDirectory?: () => void;
  savingWorkingDirectory?: boolean;
}

const EnvironmentTab = ({
  opencodeCliPath = '',
  onOpencodeCliPathChange = () => {},
  onSaveOpencodeCliPath = () => {},
  savingOpencodeCliPath = false,
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
          <span className={styles.fieldLabel}>{t('settings.basic.opencodeCliPath.label')}</span>
        </div>
        <div className={styles.nodePathInputWrapper}>
          <input
            type="text"
            className={styles.nodePathInput}
            placeholder={t('settings.basic.opencodeCliPath.placeholder')}
            value={opencodeCliPath}
            onChange={(e) => onOpencodeCliPathChange(e.target.value)}
          />
          <button
            className={styles.saveBtn}
            onClick={onSaveOpencodeCliPath}
            disabled={savingOpencodeCliPath}
          >
            {savingOpencodeCliPath && (
              <span
                className="codicon codicon-loading codicon-modifier-spin"
              />
            )}
            {t('common.save')}
          </button>
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.basic.opencodeCliPath.hint')}</span>
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
