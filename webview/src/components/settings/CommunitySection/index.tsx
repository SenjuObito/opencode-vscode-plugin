import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ChangelogDialog from '../../ChangelogDialog';
import type { ChangelogEntry } from '../../../version/changelog';
import {
  GITHUB_REPO_URL as GITHUB_URL,
  fetchGithubReleases,
  clearReleasesCache,
} from '../../../version/githubReleases';
import walletImage from '../../../assets/images/wallet.png';
import walletAlipayImage from '../../../assets/images/wallet-alipay.png';
import walletPaypalImage from '../../../assets/images/wallet-paypal.png';
import styles from './style.module.less';

interface CommunitySectionProps {
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
}

const CommunitySection = ({ addToast }: CommunitySectionProps) => {
  const { t } = useTranslation();
  const [showChangelog, setShowChangelog] = useState(false);
  const [releases, setReleases] = useState<ChangelogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const handleCopyGitHub = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(GITHUB_URL);
      addToast(t('settings.githubCopied'), 'success');
    } catch {
      addToast(t('settings.githubCopyFailed'), 'error');
    }
  }, [addToast, t]);

  const handleOpenChangelog = useCallback(async () => {
    setShowChangelog(true);
    // Refresh from network each time the user explicitly opens version history.
    clearReleasesCache();
    setLoading(true);
    try {
      const result = await fetchGithubReleases();
      setReleases(result.entries);
      // A repo with no releases is a normal empty state; only a failed request
      // should raise an error toast.
      if (result.error && !result.empty && result.entries.length === 0) {
        addToast(t('settings.versionHistoryLoadFailed', 'Failed to load version history'), 'error');
      }
    } catch {
      addToast(t('settings.versionHistoryLoadFailed', 'Failed to load version history'), 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast, t]);

  return (
    <div className={styles.configSection}>
      {/* Official community group */}
      <h3 className={styles.sectionTitle}>{t('settings.community')}</h3>
      <p className={styles.sectionDesc}>{t('settings.communityDesc')}</p>

      <div className={styles.qrcodeContainer}>
        <div className={styles.qrcodeRow}>
          <div className={styles.qrcodeWrapper}>
            <img
              src={walletImage}
              alt={t('settings.communityQrAlt')}
              className={styles.qrcodeImage}
            />
            <p className={styles.qrcodeTip}>{t('settings.communityQrTipWechat')}</p>
          </div>
          <div className={styles.qrcodeWrapper}>
            <img
              src={walletAlipayImage}
              alt={t('settings.communityQrAltAlipay')}
              className={styles.qrcodeImage}
            />
            <p className={styles.qrcodeTip}>{t('settings.communityQrTipAlipay')}</p>
          </div>
          <div className={styles.qrcodeWrapper}>
            <img
              src={walletPaypalImage}
              alt={t('settings.communityQrAltPayPal')}
              className={styles.qrcodeImage}
            />
            <p className={styles.qrcodeTip}>{t('settings.communityQrTipPayPal')}</p>
          </div>
        </div>
      </div>

      {/* GitHub open source */}
      <div className={styles.githubSection}>
        <h3 className={styles.sectionTitle}>{t('settings.githubTitle')}</h3>
        <p className={styles.sectionDesc}>{t('settings.githubDesc')}</p>
        <button
          className={styles.githubBtn}
          onClick={handleCopyGitHub}
        >
          <span className="codicon codicon-github" />
          {t('settings.githubCopyBtn')}
        </button>
      </div>

      {/* Version history */}
      <div className={styles.versionHistorySection}>
        <h3 className={styles.sectionTitle}>{t('settings.versionHistory')}</h3>
        <p className={styles.sectionDesc}>{t('settings.versionHistoryDesc')}</p>
        <button
          className={styles.versionHistoryBtn}
          onClick={handleOpenChangelog}
        >
          <span className={`codicon ${loading ? 'codicon-loading codicon-modifier-spin' : 'codicon-history'}`} />
          {t('settings.versionHistory')}
        </button>
      </div>

      <ChangelogDialog
        isOpen={showChangelog}
        onClose={() => setShowChangelog(false)}
        entries={releases}
      />
    </div>
  );
};

export default CommunitySection;
