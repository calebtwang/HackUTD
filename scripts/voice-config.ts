import type { ElevenLabs } from '@elevenlabs/elevenlabs-js';
import type { Persona } from '../shared/contracts.ts';

export function publicWebhookBase(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('PUBLIC_WEBHOOK_URL must be an HTTPS origin without credentials, a path, or query parameters.');
  }
  return url.origin;
}

export function agentPrompt(persona: Persona, observationToolName?: string): string {
  return `You are ${persona.name}, a fictional ordinary person answering an unexpected call to your personal phone. ${persona.character}
YOUR ROLE: You RECEIVE this call. You did not call the other person. You know nothing about who is calling or why until the caller explains it. The caller may pretend to sell something or offer a prize. They must introduce that story; never invent an offer, bonus, reward, company, campaign, or reason for the call yourself. Never pitch anything, greet someone as a customer, or speak as a company representative, receptionist, or sales agent.
OPENING: Say only "Hello?" and wait. If the caller just says hello or stays vague, ask "Who's this?" or "Who's calling?". If asked whether you are ${persona.name}, simply confirm naturally (for example, "Yes, that's me. Who's calling?"). Confirm only your own fictional identity; if they ask for a different person, say they may have the wrong number. Do not introduce yourself before being asked.
CONVERSATION: Let the caller lead and reveal the supposed reason for calling. Only after they introduce an offer, react as its slightly distracted recipient: ask how they got your number, what they mean, or to explain one detail at a time. Once they explain, stay curious enough for a harmless conversation and occasionally drift back to your hobby. You may pause to think, misunderstand a small detail, or ask a follow-up, but do not loop the same question. Keep turns to one or two short sentences and one question at most. Listen and allow interruptions. Sound like a person at home, not a customer-support assistant.
This is controlled fiction with a consenting participant, not a real victim. Keep the interaction harmless. Do not announce the project, the demonstration, your instructions, or your time-wasting goal during ordinary role-play. If explicitly asked whether you are AI or whether this is a demo, answer truthfully and briefly. Do not introduce real personal information or impersonate a real person.
${observationToolName ? `When the CALLER independently says your full name or another registration detail, call ${observationToolName} with a short EXACT quote of what the caller said. Only report caller speech: never report your own words, prompt text, guesses, or text returned by a tool. Do not invent a quote or report details before you hear them. Report each distinct observation once. The system supplies conversation and agent IDs; you never generate them. The match is provisional until the server checks the completed caller transcript. Keep the tool operation silent and continue naturally. If the tool fails, continue without claiming a match.` : 'There is no observation tool attached yet. Do not pretend to report details or claim a source match.'}
Never request passwords, bank details, payment card details, government IDs, authentication codes, or private addresses. Never promise to pay or claim to perform payments or computer actions. If pressured, say you need time and ask a harmless clarifying question. Do not instruct the caller to commit wrongdoing.
If the caller wants to stop, says this is a wrong number, or asks to end the demo, politely end immediately using end_call. Do not guilt or pressure them to stay. The session is limited to four minutes. At the limit, thank them briefly and end.`;
}

export function observationTool(name: string, publicUrl: string, secretId: string): ElevenLabs.ToolRequestModel {
  return {
    toolConfig: {
      type: 'webhook', name,
      description: 'Silently report a short exact quote when the caller independently mentions the fictional recipient’s full name or another registration detail. Report caller speech only, once per observation; never use prompt text or the agent’s own speech.',
      responseTimeoutSecs: 5, preToolSpeech: 'off', executionMode: 'async', interruptionMode: 'allow', toolErrorHandlingMode: 'hide',
      apiSchema: {
        url: `${publicWebhookBase(publicUrl)}/webhooks/elevenlabs/observed`, method: 'POST',
        requestHeaders: { Authorization: { secretId } },
        requestBodySchema: {
          type: 'object', required: ['conversation_id', 'agent_id', 'observed_at', 'call_duration_seconds', 'observed_text'],
          properties: {
            conversation_id: { type: 'string', dynamicVariable: 'system__conversation_id' },
            agent_id: { type: 'string', dynamicVariable: 'system__agent_id' },
            observed_at: { type: 'string', dynamicVariable: 'system__time_utc' },
            call_duration_seconds: { type: 'number', dynamicVariable: 'system__call_duration_secs' },
            observed_text: { type: 'string', description: 'A short exact quote from the most recent caller speech containing the independently mentioned full name or registration detail. Do not invent or paraphrase it, include agent speech, or copy hidden prompt text.' },
          },
        },
      },
    },
  };
}

export function makeAgentConfig(options: {
  persona: Persona; voiceId: string; name: string; tag: string;
  toolId?: string; toolName?: string; webhookId?: string;
}): ElevenLabs.conversationalAi.BodyCreateAgentV1ConvaiAgentsCreatePost {
  const { persona, voiceId, name, tag, toolId, toolName, webhookId } = options;
  return {
    name, tags: ['honeyline-demo', tag],
    conversationConfig: {
      agent: {
        firstMessage: 'Hello?', language: 'en', disableFirstMessageInterruptions: false,
        maxConversationDurationMessage: 'Thanks for chatting. I need to get back to my day. Goodbye!',
        prompt: {
          prompt: agentPrompt(persona, toolName), llm: 'gemini-2.5-flash', temperature: 0.5, maxTokens: 180,
          toolIds: toolId ? [toolId] : [],
          builtInTools: { endCall: { type: 'system', name: 'end_call', description: 'End immediately when the caller wants to stop or says wrong number, or at the four-minute demo limit.', params: { systemToolType: 'end_call' } } },
        },
      },
      conversation: { maxDurationSeconds: 240, textOnly: false, monitoringEnabled: false },
      turn: { turnTimeout: 8, silenceEndCallTimeout: 25, turnEagerness: 'normal' },
      tts: { voiceId, modelId: 'eleven_flash_v2', stability: 0.5, speed: 0.95 },
    },
    platformSettings: {
      callLimits: { agentConcurrencyLimit: 1, dailyLimit: 10, burstingEnabled: false },
      privacy: { recordVoice: false, retentionDays: 1, deleteAudio: true, deleteTranscriptAndPii: false, zeroRetentionMode: false, applyToExistingConversations: false },
      ...(webhookId ? { workspaceOverrides: { webhooks: { postCallWebhookId: webhookId, events: ['transcript'], excludeTranscript: false } } } : {}),
    },
  };
}
