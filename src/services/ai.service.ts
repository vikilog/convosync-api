import axios from 'axios';
import { config } from '../config.js';

export async function generateAgentReply(systemPrompt: string, userMessage: string) {
  if (!config.geminiApiKey) {
    return 'AI agent is not configured. Set GEMINI_API_KEY in backend .env.';
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`;
  const res = await axios.post(url, {
    contents: [
      { role: 'user', parts: [{ text: `${systemPrompt}\n\nUser: ${userMessage}` }] },
    ],
  });
  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return text || 'No response from AI.';
}
