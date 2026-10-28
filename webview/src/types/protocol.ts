/**
 * protocol.ts
 *
 * Webview 强类型 RPC 通信协议定义。
 */

export const BridgeMessageType = {
  // 对话
  SEND_MESSAGE: 'send_message',
  SEND_MESSAGE_WITH_ATTACHMENTS: 'send_message_with_attachments',
  INTERRUPT_SESSION: 'interrupt_session',
  RESTART_SESSION: 'restart_session',

  // 历史
  LOAD_HISTORY_DATA: 'load_history_data',
  LOAD_SESSION: 'load_session',
  DELETE_SESSION: 'delete_session',
  DELETE_SESSIONS: 'delete_sessions',
  TOGGLE_FAVORITE: 'toggle_favorite',
  UPDATE_TITLE: 'update_title',

  // 模型与配置
  GET_CLI_MODELS: 'get_cli_models',
  GET_MODELS: 'get_models',
  SET_MODEL: 'set_model',
  GET_SETTINGS: 'get_settings',
  SAVE_SETTINGS: 'save_settings',

  // 文件与 IDE 原生操作
  OPEN_FILE: 'open_file',
  RESOLVE_FILE_PATH: 'resolve_file_path',
  OPEN_BROWSER: 'open_browser',
  SHOW_DIFF: 'show_diff',
  SHOW_EDITABLE_DIFF: 'show_editable_diff',
  UNDO_FILE_CHANGES: 'undo_file_changes',

  // 调试日志
  CARD_DEBUG: 'cardDebug',
} as const;

export type BridgeMessageType = typeof BridgeMessageType[keyof typeof BridgeMessageType];

