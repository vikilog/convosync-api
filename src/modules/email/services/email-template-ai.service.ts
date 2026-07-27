import { generateAgentReply } from '../../../services/ai.service.js';

export type AiEmailBlockSuggestion = {
  type: string;
  props: Record<string, unknown>;
};

export async function generateEmailTemplateContent(prompt: string): Promise<{
  subject: string;
  blocks: AiEmailBlockSuggestion[];
  html?: string;
}> {
  const system = `You are an email marketing copywriter. Return ONLY valid JSON (no markdown) in ONE of these shapes:

1) Structured blocks (preferred):
{"subject":"string with optional {{variables}}","blocks":[{"type":"header|text|button|image|divider|spacer|columns|footer|html","props":{...}}]}

2) Full HTML body (when the user asks for custom HTML/code):
{"subject":"string","html":"<div>...email body HTML...</div>"}

Use {{first_name}}, {{company_name}}, {{cta_url}} style variables where helpful.
Block props: header{text,level,align}; text{content,align}; button{label,url,align}; image{src,alt,width,align}; divider{}; spacer{height}; columns{left,right}; footer{text}; html{rawHtml}.
Keep blocks concise and professional. Prefer 4–8 blocks for a complete email.`;

  const raw = await generateAgentReply(system, prompt);
  try {
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(cleaned) as {
      subject?: string;
      blocks?: AiEmailBlockSuggestion[];
      html?: string;
    };
    return {
      subject: parsed.subject ?? 'Your update from {{company_name}}',
      blocks: Array.isArray(parsed.blocks) ? parsed.blocks : [],
      ...(typeof parsed.html === 'string' && parsed.html.trim()
        ? { html: parsed.html.trim() }
        : {}),
    };
  } catch {
    return {
      subject: 'Message from {{company_name}}',
      blocks: [
        { type: 'header', props: { text: 'Hello {{first_name}}', level: 'h1', align: 'left' } },
        { type: 'text', props: { content: raw.slice(0, 800), align: 'left' } },
        {
          type: 'button',
          props: { label: 'Learn more', url: '{{cta_url}}', align: 'center' },
        },
      ],
    };
  }
}
