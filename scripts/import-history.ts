/**
 * CopilotKit Historical Conversation Import Helper
 *
 * This script documents and provides ready-to-run helpers for importing historical
 * agent conversations from LangGraph, Google ADK, or Mastra into CopilotKit Intelligence Project 9133.
 *
 * Usage:
 *   npx copilotkit@latest import --source <adk|langgraph|mastra> --dry-run
 *   npx copilotkit@latest import --source <adk|langgraph|mastra>
 */

export interface ImportOptions {
  source: 'adk' | 'langgraph' | 'mastra';
  dryRun?: boolean;
}

export function getImportCommand(opts: ImportOptions): string {
  const flags = ['--source', opts.source];
  if (opts.dryRun) flags.push('--dry-run');
  return `npx copilotkit@latest import ${flags.join(' ')}`;
}
