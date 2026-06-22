import { generateAgentReply } from '../../../services/ai.service.js';

export type AiEmailBlockSuggestion = {
  type: string;
  props: Record<string, unknown>;
};

export async function generateEmailTemplateContent(prompt: string): Promise<{
  subject: string;
  blocks: AiEmailBlockSuggestion[];
}> {
  const system = `You are an email marketing copywriter. Return ONLY valid JSON (no markdown) with this shape:
{"subject":"string with optional {{variables}}","blocks":[{"type":"header|text|button|image|divider|spacer|columns|footer","props":{...}}]}
Use {{first_name}}, {{company_name}} style variables where helpful.
Block props: header{text,level,align}; text{content,align}; button{label,url,align}; image{src,alt,width,align}; divider{}; spacer{height}; columns{left,right}; footer{text}.
Keep blocks concise and professional.`;

  const raw = await generateAgentReply(system, prompt);
  try {
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(cleaned) as {
      subject?: string;
      blocks?: AiEmailBlockSuggestion[];
    };
    return {
      subject: parsed.subject ?? 'Your update from {{company_name}}',
      blocks: Array.isArray(parsed.blocks) ? parsed.blocks : [],
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
