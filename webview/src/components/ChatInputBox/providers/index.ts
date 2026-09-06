export {
  fileReferenceProvider,
  fileToDropdownItem,
  resetFileReferenceState,
} from './fileReferenceProvider';

export {
  slashCommandProvider,
  commandToDropdownItem,
  setupSlashCommandsCallback,
  resetSlashCommandsState,
  preloadSlashCommands,
} from './slashCommandProvider';

export {
  agentProvider,
  agentToDropdownItem,
  setupAgentsCallback,
  resetAgentsState,
  getSubagentsSync,
  getPrimaryAgentsSync,
  subscribeAgents,
  unsubscribeAgents,
  ensureAgentsLoaded,
  subagentMentionProvider,
  subagentMentionToDropdownItem,
} from './agentProvider';

export type { AgentItem, SubagentMentionItem } from './agentProvider';

export {
  dollarCommandProvider,
  dollarCommandToDropdownItem,
  setupDollarCommandsCallback,
  resetDollarCommandsState,
} from './dollarCommandProvider';

export {
  mentionProvider,
  mentionToDropdownItem,
} from './mentionProvider';

export type { MentionItem } from './mentionProvider';
