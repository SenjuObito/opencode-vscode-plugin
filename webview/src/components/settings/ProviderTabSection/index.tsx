import { useTranslation } from 'react-i18next';
import CliSection from '../CliSection';
import styles from './style.module.less';

interface ProviderTabSectionProps {
  addToast: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
}

/**
 * opencode-only: cc-gui 的「供应商管理」原有多页签（Claude / Codex / CLI）。
 * 本插件只保留 opencode，因此这里直接渲染 CLI 工具管理（CliSection），
 * 删除 Claude/Codex 页签与 ProviderManageSection / CodexProviderSection。
 */
const ProviderTabSection = ({ addToast }: ProviderTabSectionProps) => {
  const { t } = useTranslation();

  return (
    <div className={styles.providerTabSection}>
      <h3 className={styles.sectionTitle}>{t('settings.providers')}</h3>
      <p className={styles.sectionDesc}>{t('settings.providersDesc')}</p>
      <CliSection addToast={addToast} />
    </div>
  );
};

export default ProviderTabSection;
