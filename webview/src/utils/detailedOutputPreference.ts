/**
 * detailedOutputPreference.ts
 *
 * 统一委托给 uiPreferences.ts 进行权威管理，彻底消除私有 localStorage 分裂。
 */
import {
  getUiPreferences,
  updateUiPreferences,
} from './uiPreferences';

export const DETAILED_OUTPUT_ENABLED_KEY = 'detailedOutputEnabled';
export const DETAILED_OUTPUT_ENABLED_EVENT = 'detailed-output-enabled-changed';

export interface DetailedOutputEnabledChangedDetail {
  enabled: boolean;
}

export function getDetailedOutputEnabled(): boolean {
  return getUiPreferences().detailedOutputEnabled;
}

export function setDetailedOutputEnabled(enabled: boolean): void {
  updateUiPreferences({ detailedOutputEnabled: enabled });
  window.dispatchEvent(
    new CustomEvent<DetailedOutputEnabledChangedDetail>(DETAILED_OUTPUT_ENABLED_EVENT, {
      detail: { enabled },
    }),
  );
}
