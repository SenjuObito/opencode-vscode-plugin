import styles from './style.module.less';
import { useTranslation } from 'react-i18next';

export type SettingsTab = 'basic' | 'providers' | 'usage' | 'mcp' | 'agents' | 'skills' | 'other' | 'community';

interface SidebarItem {
  key: SettingsTab;
  icon: string;
  labelKey: string; // Changed to i18n translation key
}

const sidebarItems: SidebarItem[] = [
  { key: 'basic', icon: 'codicon-settings-gear', labelKey: 'settings.basic.title' },
  { key: 'providers', icon: 'codicon-vm-connect', labelKey: 'settings.providers' },
  { key: 'usage', icon: 'codicon-graph', labelKey: 'settings.usage' },
  { key: 'mcp', icon: 'codicon-server', labelKey: 'settings.mcp' },
  // { key: 'agents', icon: 'codicon-robot', labelKey: 'settings.agents' },
  { key: 'skills', icon: 'codicon-book', labelKey: 'settings.skills' },
  { key: 'other', icon: 'codicon-ellipsis', labelKey: 'settings.other.title' },
  { key: 'community', icon: 'codicon-feedback', labelKey: 'settings.community' },
];

interface SettingsSidebarProps {
  currentTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

const SettingsSidebar = ({
  currentTab,
  onTabChange,
  isCollapsed,
  onToggleCollapse,
}: SettingsSidebarProps) => {
  const { t } = useTranslation();

  return (
    <div className={`${styles.sidebar} ${isCollapsed ? styles.collapsed : ''}`}>
      <div className={styles.sidebarItems}>
        {sidebarItems.map((item) => {
          const label = t(item.labelKey);
          return (
            <div
              key={item.key}
              className={`${styles.sidebarItem} ${currentTab === item.key ? styles.active : ''}`}
              onClick={() => onTabChange(item.key)}
              title={isCollapsed ? label : ''}
            >
              <span className={`codicon ${item.icon}`} />
              <span className={styles.sidebarItemText}>{label}</span>
            </div>
          );
        })}
      </div>

      {/* Collapse toggle button */}
      <div
        className={styles.sidebarToggle}
        onClick={onToggleCollapse}
        title={isCollapsed ? t('settings.sidebar.expand') : t('settings.sidebar.collapse')}
      >
        <span className={`codicon ${isCollapsed ? 'codicon-chevron-right' : 'codicon-chevron-left'}`} />
      </div>
    </div>
  );
};

export default SettingsSidebar;
