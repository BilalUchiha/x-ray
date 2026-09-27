import type { AnalysisSession, NodeKind } from '../types';
import type { AiProviderConfig } from '../settings/aiSettings';
import { sendChat, type ChatMessage, type ChatUsage } from './client';
import { buildContext, detectReferencedNodes, type AiContext, type BuildContextOptions } from './context';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  context?: AiContext;
  referenced?: Array<{ id: string; name: string; kind: NodeKind }>;
  usage?: ChatUsage;
  error?: boolean;
}

export interface AskOptions {
  session: AnalysisSession;
  provider: AiProviderConfig;
  question: string;
  selectedNodeId?: string | null;
  history?: ChatTurn[];
  contextOptions?: BuildContextOptions;
  signal?: AbortSignal;
  onToken?: (chunk: string) => void;
  onContext?: (context: AiContext) => void;
}

export interface AskResult {
  answer: string;
  context: AiContext;
  referenced: Array<{ id: string; name: string; kind: NodeKind }>;
  usage: ChatUsage;
}

export function buildSystemPrompt(session: AnalysisSession, context: AiContext): string {
  const { analysis } = session;
  // Layers are scoped per project, so the label always names its project: a
  // "Services" layer in the backend is not the same as one in the frontend.
  const groups = analysis.groups
    .map((group) => `- ${group.appId ? `${group.appLabel} · ${group.label}` : `${analysis.name} · ${group.label}`} (${group.memberIds.length} types): ${group.memberIds
      .map((id) => session.index.nodeById.get(id)?.name)
      .filter(Boolean)
      .slice(0, 12)
      .join(', ')}`)
    .join('\n');

  const projects = (analysis.apps ?? [])
    .filter((app) => app.path)
    .map((app) => `- ${app.path} (${app.kind}, from ${app.marker})`)
    .join('\n');

  const languages = analysis.languages
    .slice(0, 5)
    .map((lang) => `${lang.label} ${lang.percent}%`)
    .join(', ');

  return [
    `You are the analysis assistant inside X-Ray, a local codebase explorer.`,
    `The developer has loaded the folder "${analysis.name}" and X-Ray has already parsed it structurally.`,
    ``,
    `Project: ${analysis.name}`,
    `Files: ${analysis.stats.totalFiles} (${analysis.stats.sourceFiles} parsed source files)`,
    `Types: ${analysis.stats.classes} classes, ${analysis.stats.interfaces} interfaces, ${analysis.stats.enums} enums`,
    `Members: ${analysis.stats.methods} methods, ${analysis.stats.properties + analysis.stats.fields} properties/fields`,
    `Relationships detected: ${analysis.stats.relationships}`,
    languages ? `Languages: ${languages}` : '',
    projects ? `Projects detected:\n${projects}` : '',
    ``,
    `Architectural layers X-Ray inferred:`,
    groups || '- (no groups)',
    ``,
    `Rules:`,
    `1. Answer using ONLY the code excerpts and structure provided. If the excerpts are insufficient, say so and name what you would need to look at.`,
    `2. Refer to components by their exact names (classes, interfaces, methods) so X-Ray can highlight them on the map.`,
    `3. Be concrete about the call/dependency path, e.g. "A calls B, which depends on C".`,
    `4. Never invent files, classes or behaviour you cannot see.`,
    `5. Keep answers focused and technical. Prefer short paragraphs or a short list over long prose.`,
    `6. You are explaining code, not editing it. Never propose patch output or write code changes.`,
    context.selectedNodeId
      ? `7. The developer has selected "${session.index.nodeById.get(context.selectedNodeId)?.name ?? 'a component'}" — focus your answer on it unless asked otherwise.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildContextMessage(context: AiContext): string {
  const blocks = context.files.map((file) => {
    const header = `### File: ${file.path} (lines ${file.startLine}-${file.endLine}${file.truncated ? ', excerpted' : ''}) — ${file.reason}`;
    return `${header}\n\`\`\`\n${file.excerpt}\n\`\`\``;
  });

  const structure = context.nodes.length
    ? `### Components identified as relevant\n${context.nodes.map((node) => `- ${node.name} (${node.kind}) — ${node.reason}`).join('\n')}`
    : '';

  return [
    `X-Ray retrieved the following context from the codebase for this question.`,
    ``,
    structure,
    ``,
    blocks.length ? blocks.join('\n\n') : '### No source files were retrieved.',
    ``,
    context.notes.length ? `Notes: ${context.notes.join(' ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function askCodebase(options: AskOptions): Promise<AskResult> {
  const { session, provider, question, selectedNodeId, history = [] } = options;
  const context = buildContext(session, question, { selectedNodeId, ...options.contextOptions });
  options.onContext?.(context);

  const messages: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt(session, context) }];

  // Keep a short tail of the conversation for continuity, without resending context.
  for (const turn of history.slice(-4)) {
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: 'user', content: `${buildContextMessage(context)}\n\n### Question\n${question}` });

  const result = await sendChat({ provider, messages, signal: options.signal, onToken: options.onToken });
  const referenced = detectReferencedNodes(session, result.text);

  return { answer: result.text, context, referenced, usage: result.usage };
}
