import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useSettingsBasicActions } from './useSettingsBasicActions';
import type { CodeFontConfig } from '../../../types/uiFontConfig';

vi.mock('../../../utils/notificationSound', () => ({
  playNotificationSound: vi.fn(),
}));

// eslint-disable-next-line import/first
import { playNotificationSound } from '../../../utils/notificationSound';

describe('useSettingsBasicActions', () => {
  beforeEach(() => {
    window.sendToJava = vi.fn();
  });

  it('sends independent code font updates without mutating ui font state', () => {
    const { result } = renderHook(() => useSettingsBasicActions({}));

    act(() => {
      result.current.handleCodeFontSelectionChange('followEditor');
    });

    expect(window.sendToJava).not.toHaveBeenCalledWith(
      'set_ui_font_config:{"mode":"customFile"}'
    );
    expect(window.sendToJava).toHaveBeenCalledWith(
      'set_code_font_config:{"mode":"followEditor"}'
    );
  });

  it('sends a code font customFile update when a saved path exists', () => {
    const { result } = renderHook(() => useSettingsBasicActions({}));

    const customCodeFontConfig: CodeFontConfig = {
      mode: 'customFile',
      effectiveMode: 'customFile',
      customFontPath: '/tmp/my-code-font.ttf',
      fontFamily: 'CC GUI Code Custom',
      fontSize: 13,
      lineSpacing: 1,
    };

    act(() => {
      result.current.setCodeFontConfig(customCodeFontConfig);
    });

    act(() => {
      result.current.handleCodeFontSelectionChange('customFile');
    });

    expect(window.sendToJava).toHaveBeenCalledWith(
      'set_code_font_config:{"mode":"customFile","customFontPath":"/tmp/my-code-font.ttf"}'
    );
  });

  it('does not send anything when switching to customFile without a saved path (silent no-op)', () => {
    const { result } = renderHook(() => useSettingsBasicActions({}));

    (window.sendToJava as any).mockClear();

    act(() => {
      result.current.handleCodeFontSelectionChange('customFile');
    });

    expect(window.sendToJava).not.toHaveBeenCalledWith(
      expect.stringMatching(/^set_code_font_config:/)
    );
  });

  it('sends named font configuration updates for ui and code font selections', () => {
    const { result } = renderHook(() => useSettingsBasicActions({}));

    act(() => {
      result.current.handleUiFontSelectionChange('named:JetBrains Mono');
      result.current.handleCodeFontSelectionChange('named:Fira Code');
    });

    expect(window.sendToJava).toHaveBeenCalledWith(
      'set_ui_font_config:{"mode":"named","fontFamily":"JetBrains Mono"}'
    );
    expect(window.sendToJava).toHaveBeenCalledWith(
      'set_code_font_config:{"mode":"named","fontFamily":"Fira Code"}'
    );
  });

  it('previews a built-in sound through the shared notification player', () => {
    const { result } = renderHook(() => useSettingsBasicActions({}));

    act(() => {
      result.current.handleSelectedSoundChange('chime');
    });
    (playNotificationSound as any).mockClear();

    act(() => {
      result.current.handleTestSound();
    });

    expect(playNotificationSound).toHaveBeenCalledWith({ soundId: 'chime' });
  });

  it('asks the host to preview a custom sound file', () => {
    const { result } = renderHook(() => useSettingsBasicActions({}));

    act(() => {
      result.current.handleCustomSoundPathChange('/tmp/my-sound.wav');
      result.current.handleSelectedSoundChange('custom');
    });
    (window.sendToJava as any).mockClear();

    act(() => {
      result.current.handleTestSound();
    });

    expect(window.sendToJava).toHaveBeenCalledWith(
      'test_sound:{"soundId":"custom","path":"/tmp/my-sound.wav"}'
    );
  });
});
